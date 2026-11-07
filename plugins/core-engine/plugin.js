// core-engine plugin assembly (DESIGN §2/§6/§8): wires the Task 9-13 modules
// (Ledger, SessionCache, Timeline, progressor, middleware, Engine) into the
// kernel and owns the bots.json runtime. Three lifecycle surfaces:
//   - activate: shared facilities + default port impls + the 'engine' service
//     + this /api route; attachment itself waits for afterAllActivated so
//     channel/provider ports from OTHER plugins are already registered.
//   - afterAllActivated (boot + reload phase 4): load bots.json, recompute the
//     session caches against the ledger (§7 rule 3 boot obligation), attach
//     every enabled bot whose channel/provider resolves.
//   - 'plugin/lifecycle' (§2.5 re-enable reconcile): when the port registry
//     changes, bots follow — vanished channel/provider → detach with the
//     reason; restored → re-attach.
import { join } from 'node:path';
import process from 'node:process';
import { Engine } from './engine.js';
import { Ledger } from './ledger.js';
import { SessionCache } from './sessionCache.js';
import { Timeline } from './timeline.js';
import { createProgressor } from './progressor.js';
import { maskOutbound } from './middleware.js';
import { loadBots, revalidateAll, validateBot } from './bots.js';
import { loadAssets, buildPlan } from './assets.js';
import { createMaterializer } from './materializer.js';
import { companyOps, createApi } from './api.js';

const isBotRecord = (bot) => bot != null && typeof bot === 'object' && typeof bot.id === 'string' && bot.id !== '';

export default {
  manifest: {
    id: 'core-engine',
    name: 'Core Engine',
    type: 'core',
    version: '0.1.0',
    requires: { kernel: '^1' },
    order: 0,
  },

  activate(ctx) {
    const log = ctx.log;
    const services = ctx.services;
    // Kernel-assembly services (src/index.js): the shared port registry and
    // the data dir. Both degrade (empty registry → bots stay offline with
    // reasons) when the plugin runs under a bare lifecycle in tests.
    const ports = services.get('ports') ?? null;
    const dataDir = services.get('paths')?.dataDir
      ?? ctx.config?.dataDir
      ?? process.env.WAO_HOME
      ?? join(process.cwd(), 'data');
    const botsFile = join(dataDir, 'bots.json');
    const assetsFile = join(dataDir, 'assets.json');

    // Shared facilities + default port implementations (T11). The engine
    // consumes these same objects directly; the port registration publishes
    // the default impls for registry visibility/other consumers.
    const timeline = new Timeline();
    const progressor = createProgressor();
    ctx.registerProgressor(progressor);
    ctx.registerMiddleware({ maskOutbound });

    // Live middleware chain over the port registry (PLUGIN-DEV §5.5): the
    // lifecycle splices the registry list IN PLACE, so both views below walk
    // it at CALL time — a middleware plugin (cost-tracker & co) that
    // activates after core-engine is still seen, and its teardown drops it
    // again. The builtin maskOutbound rides the same list (registered above),
    // so masking semantics are unchanged; onOutbound runs only on the final
    // reply (engine.js) with per-impl error isolation so one broken plugin
    // can never eat a live reply. Bare-lifecycle tests (no ports service)
    // keep the plain builtin object, exactly the pre-chain shape.
    const middleware = ports != null ? {
      maskOutbound: (text) => ports.middleware.reduce(
        (t, { impl }) => (typeof impl?.maskOutbound === 'function' ? impl.maskOutbound(t) : t), text),
      onOutbound: async (text, outCtx) => {
        let out = text;
        for (const { impl } of ports.middleware) {
          if (typeof impl?.onOutbound !== 'function') continue;
          try {
            const next = await impl.onOutbound(out, outCtx);
            if (typeof next === 'string') out = next;
          } catch (e) {
            log.warn?.(`core-engine: onOutbound middleware failed: ${e?.message ?? e}`);
          }
        }
        return out;
      },
    } : { maskOutbound };

    // Per-bot runtime resolution: the engine's getRunner/getAdapter read
    // these maps, so a bot's runtime is created at attach and dies at detach.
    const adapters = new Map();       // botId → channel adapter
    const runners = new Map();        // botId → provider runner
    const ledgers = new Map();        // botId → { ledger, cache } (cached: seq counters must stay monotonic)
    const offlineReasons = new Map(); // botId → why the bot is offline (API shows it)
    let doc = { bots: [] };
    let assetsDoc = { assets: [] }; // data/assets.json registry (DESIGN-ASSETS §2.1)

    // 资产物化管线 (DESIGN-ASSETS §3, W3 T2): the REAL materializer —
    // providers plan (materializeAssets), THIS executor owns every disk
    // mutation (jail guard/atomicity/manifest/精确卸载/回验). All bind/unbind/
    // patch/delete/rematerialize paths fan out through the same seam T1
    // established; the noop survives only in unit tests as the seam contract.
    // rtkBin (§7.1 W3 T3): the rtk CLI the executor drives — plugin config
    // `rtkBin` / $WAO_RTK_BIN overrides the PATH default (tests point it at
    // fakes; ops can pin an absolute binary).
    const materializer = createMaterializer({
      ports,
      dataDir,
      log,
      rtkBin: ctx.config?.rtkBin || process.env.WAO_RTK_BIN || 'rtk',
    });

    const ledgerFor = (botId) => {
      let pair = ledgers.get(botId);
      if (pair == null) {
        const ledger = new Ledger({ file: join(dataDir, 'ledger', `${botId}.jsonl`), log });
        pair = {
          ledger,
          cache: new SessionCache({ file: join(dataDir, 'sessions', `${botId}.json`), log, ledger }),
        };
        ledgers.set(botId, pair);
      }
      return pair;
    };

    const engine = new Engine({
      log,
      // Kernel bus bridge (M3 UI): progress/status changes ride agent/* to
      // the kernel's SSE bridge (ctx.events → http.sseSend).
      emit: (topic, payload) => ctx.events.emit(topic, payload),
      getRunner: (bot) => {
        const runner = runners.get(bot?.id);
        if (runner == null) throw new Error(`engine: bot ${JSON.stringify(bot?.id)} has no runner (offline?)`);
        return runner;
      },
      getAdapter: (bot) => {
        const adapter = adapters.get(bot?.id);
        if (adapter == null) throw new Error(`engine: bot ${JSON.stringify(bot?.id)} has no adapter (offline?)`);
        return adapter;
      },
      ledgerFactory: ledgerFor,
      timeline,
      progressor,
      middleware,
    });

    // The service channels call for inbound (T17: engine.onMessage(bot, msg)).
    // drain includes sendDrainRefusals — the T13 M3 wiring obligation: every
    // message a drain refused must be answered, not dropped.
    const engineFacade = {
      onMessage: (bot, msg) => engine.onMessage(bot, msg),
      onChannelEvent: (bot, ev) => engine.onChannelEvent(bot, ev),
      drain: async (timeoutMs) => {
        await engine.drain(timeoutMs);
        await engine.sendDrainRefusals();
      },
      status: (botId) => engine.status(botId),
      // A4 seam: an engine-side channel-event handler returning true means
      // "the engine handled it" — the channel then skips its default behavior
      // (e.g. the default enter_chat welcome).
      setChannelEventHandler: (fn) => { engine.channelEventHandler = fn; },
    };
    services.register('engine', engineFacade);

    // The facade a CHANNEL ADAPTER receives (DESIGN §4): inbound is
    // single-object — onMessage({botId, chatKey, ...}) / onChannelEvent(ev) —
    // and every call closes over THIS bot, so the adapter never has to know
    // the kernel-internal (bot, msg) shape the engine service speaks.
    const channelFacadeFor = (botRecord) => ({
      onMessage: (msg) => engine.onMessage(botRecord, msg),
      onChannelEvent: (ev) => engine.onChannelEvent(botRecord, ev),
    });

    // The effective asset plan for one bot (§2.2/§2.3): bindings in 生效顺序,
    // shadowed shared entries and dangling bindings dropped.
    const planFor = (bot) => buildPlan(assetsDoc.assets, bot).plan;

    const makeRunner = (bot) => {
      const port = ports?.getProvider?.(bot.provider);
      if (port == null) throw new Error(`provider ${bot.provider} 不可用`);
      // §3.1 createRunner({..., assets}): the effective plan enriched with
      // file targets from the last-good manifest (--mcp-config/--skill/
      // --append-system-prompt values). SYNC by design — attach/refresh stay
      // sync; entries are COPIES (可变引用纪律 §3.1), a missing manifest
      // degrades to the bare plan (the bind receipt already said failed).
      const barePlan = planFor(bot);
      const assets = barePlan.length > 0 ? materializer.targetsFor(bot, barePlan) : barePlan;
      const runner = port.createRunner({ bot, providerConfig: bot.providerConfig, assets, log });
      // engine.js resolves describeError via the RUNNER first (defaultRunTurn:
      // `runner.describeError ?? bot.describeError ?? …`) — bind the provider
      // port's copy onto the runner we hand over (T13 review pin).
      if (typeof port.describeError === 'function') {
        runner.describeError = (r) => port.describeError(r);
      }
      return runner;
    };

    // 轻量重 attach (DESIGN-ASSETS §3.2): binding/asset changes replace the
    // RUNNER table entry only — no drain, no adapter rebuild; an in-flight run
    // keeps the old runner and finishes on it, the next run picks up the new
    // one. Bots that are offline/disabled (no runner) re-runner at attach.
    const refreshRunner = (bot) => {
      if (!runners.has(bot.id)) return false;
      try {
        runners.set(bot.id, makeRunner(bot));
        return true;
      } catch (err) {
        log.warn?.(`core-engine: runner refresh failed for ${bot.id}: ${err?.message ?? err}（旧 runner 保留，下轮仍可用）`);
        return false;
      }
    };

    const detach = (botId, reason = 'offline') => {
      const adapter = adapters.get(botId);
      if (adapter != null && typeof adapter.stop === 'function') {
        try { adapter.stop(); } catch (err) { log.warn?.(`core-engine: adapter stop failed for ${botId}: ${err?.message ?? err}`); }
      }
      adapters.delete(botId);
      runners.delete(botId);
      engine.detachBot(botId, reason);
      offlineReasons.set(botId, reason);
    };

    const attach = (bot) => {
      if (!isBotRecord(bot)) return { ok: false, reason: 'not a bot record' };
      const errors = validateBot(bot, { channels: ports?.channel, providers: ports?.provider });
      if (errors.length > 0) {
        const reason = errors.join('; ');
        detach(bot.id, reason);
        return { ok: false, reason };
      }
      try {
        const channelPort = ports.getChannel(bot.channel);
        const adapter = channelPort.createAdapter({ account: bot.account, bot, log, engine: channelFacadeFor(bot) });
        const runner = makeRunner(bot);
        adapters.set(bot.id, adapter);
        runners.set(bot.id, runner);
        engine.attachBot(bot, { adapter, runner });
        offlineReasons.delete(bot.id);
        // Empty/absent allowedUsers = allow-all: say it once per attach so an
        // operator who opens a bot to everyone does so deliberately (the
        // engine enforces the non-empty case; this is the visibility half).
        if (!(Array.isArray(bot.allowedUsers) && bot.allowedUsers.length > 0)) {
          log.warn?.(`core-engine: bot ${bot.id} accepts messages from ANY user (allowedUsers is empty)`);
        }
        if (typeof adapter.start === 'function') adapter.start(); // inbound opens only after registration
        return { ok: true };
      } catch (err) {
        const reason = `attach failed: ${err?.message ?? err}`;
        detach(bot.id, reason);
        return { ok: false, reason };
      }
    };

    // §2.5 re-enable reconcile: the port registry changed under us — bots
    // whose channel/provider vanished go offline WITH the reason; bots whose
    // dependency came back re-attach. Symmetric by design.
    const reconcile = () => {
      for (const bot of doc.bots) {
        if (!isBotRecord(bot) || bot.enabled === false) continue;
        const hasChannel = ports?.getChannel?.(bot.channel) != null;
        const hasProvider = ports?.getProvider?.(bot.provider) != null;
        if (adapters.has(bot.id) && (!hasChannel || !hasProvider)) {
          detach(bot.id, !hasChannel ? `channel ${bot.channel} 已禁用` : `provider ${bot.provider} 已禁用`);
        } else if (!adapters.has(bot.id) && hasChannel && hasProvider) {
          attach(bot);
        }
      }
    };
    ctx.events.on('plugin/lifecycle', () => {
      try { reconcile(); } catch (err) { log.warn?.(`core-engine: reconcile failed: ${err?.message ?? err}`); }
    });

    // Boot + reload phase 4 (§1/§2.5): every other plugin's ports are live.
    ctx.afterAllActivated(async () => {
      doc = loadBots(botsFile);
      assetsDoc = loadAssets(assetsFile);
      const { bad } = revalidateAll(doc.bots, ports);
      for (const { bot, errors } of bad) {
        log.warn?.(`core-engine: bot ${JSON.stringify(bot?.id)} validation drift: ${errors.join('; ')}`);
      }
      for (const bot of doc.bots) {
        if (!isBotRecord(bot)) continue;
        const { ledger, cache } = ledgerFor(bot.id);
        try { cache.recompute(ledger); } catch (err) {
          log.warn?.(`core-engine: session recompute failed for ${bot.id}: ${err?.message ?? err}`);
        }
      }
      for (const bot of doc.bots) {
        if (!isBotRecord(bot) || bot.enabled === false) continue;
        const r = attach(bot);
        if (!r.ok) log.warn?.(`core-engine: bot ${bot.id} offline: ${r.reason}`);
      }
      // §3.2 服务启动 row + T1 扫尾: pre-T2 bindings carry no manifest —
      // rematerialize them ONCE (log says so); afterwards read-only 回验 —
      // drift is logged for doctor/rematerialize, never auto-rewritten.
      try {
        const swept = await materializer.startupSweep(doc.bots, planFor);
        // W3 T2 review Critical 3: attach ran BEFORE the sweep, so a migrated
        // bot's live runner was minted from the BARE plan (missing manifest →
        // targetsFor degrades). Re-mint every attached migrated bot so the
        // file targets enrich the runner on the FIRST process cycle; offline
        // bots re-runner at their own attach (refreshRunner no-ops there).
        for (const botId of swept.migrated) {
          const bot = doc.bots.find((b) => isBotRecord(b) && b.id === botId);
          if (bot != null) refreshRunner(bot);
        }
      } catch (err) {
        log.warn?.(`core-engine: asset startup sweep failed: ${err?.message ?? err}`);
      }
    });

    // Teardown (§2.5): drain first (refusals included), then stop adapters in
    // reverse attach order, then neutralize the engine service — the services
    // container has no unregister, so an inert stub marks the slot dead.
    ctx.effect(async () => {
      try {
        await engine.drain(5000);
        await engine.sendDrainRefusals();
      } catch (err) {
        log.warn?.(`core-engine: final drain failed: ${err?.message ?? err}`);
      }
      for (const botId of [...adapters.keys()].reverse()) detach(botId, 'shutdown');
      services.register('engine', {
        onMessage: () => {},
        drain: async () => {},
        status: () => ({ status: 'offline', running: 0, progress: null }),
      });
    });

    // Business API (§8). getState is read per request — after a reload this
    // whole closure is a new world and api.js must never see the old one.
    const state = {
      botsFile,
      assetsFile,
      engine,
      timeline,
      ports,
      log,
      materializer,
      refreshRunner,
      ledgerFor,
      attach,
      detach,
      adapterFor: (botId) => adapters.get(botId) ?? null,
      runnerFor: (botId) => runners.get(botId) ?? null,
      offlineReason: (botId) => offlineReasons.get(botId) ?? null,
      get doc() { return doc; },
      get assetsDoc() { return assetsDoc; },
    };
    ctx.http.register({ prefix: '/api', handler: createApi({ getState: () => state }) });
    // Company operations for the mcp-gateway plugin (W1 T2): the same api.js
    // functions the /api routes call, brokered through the service container
    // (no plugin-to-plugin imports, no HTTP self-calls). Null at teardown —
    // the container has no unregister, same pattern as the 'engine' stub.
    services.register('companyOps', companyOps(state));
    ctx.effect(() => { services.register('companyOps', null); });
  },
};
