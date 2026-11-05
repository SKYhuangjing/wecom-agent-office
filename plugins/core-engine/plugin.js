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
import { createApi } from './api.js';

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

    // Shared facilities + default port implementations (T11). The engine
    // consumes these same objects directly; the port registration publishes
    // the default impls for registry visibility/other consumers.
    const timeline = new Timeline();
    const progressor = createProgressor();
    ctx.registerProgressor(progressor);
    ctx.registerMiddleware({ maskOutbound });

    // Per-bot runtime resolution: the engine's getRunner/getAdapter read
    // these maps, so a bot's runtime is created at attach and dies at detach.
    const adapters = new Map();       // botId → channel adapter
    const runners = new Map();        // botId → provider runner
    const ledgers = new Map();        // botId → { ledger, cache } (cached: seq counters must stay monotonic)
    const offlineReasons = new Map(); // botId → why the bot is offline (API shows it)
    let doc = { bots: [] };

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
      middleware: { maskOutbound },
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

    const makeRunner = (bot) => {
      const port = ports?.getProvider?.(bot.provider);
      if (port == null) throw new Error(`provider ${bot.provider} 不可用`);
      const runner = port.createRunner({ bot, providerConfig: bot.providerConfig, log });
      // engine.js resolves describeError via the RUNNER first (defaultRunTurn:
      // `runner.describeError ?? bot.describeError ?? …`) — bind the provider
      // port's copy onto the runner we hand over (T13 review pin).
      if (typeof port.describeError === 'function') {
        runner.describeError = (r) => port.describeError(r);
      }
      return runner;
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
    ctx.afterAllActivated(() => {
      doc = loadBots(botsFile);
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
      engine,
      timeline,
      ports,
      log,
      ledgerFor,
      attach,
      detach,
      adapterFor: (botId) => adapters.get(botId) ?? null,
      runnerFor: (botId) => runners.get(botId) ?? null,
      offlineReason: (botId) => offlineReasons.get(botId) ?? null,
      get doc() { return doc; },
    };
    ctx.http.register({ prefix: '/api', handler: createApi({ getState: () => state }) });
  },
};
