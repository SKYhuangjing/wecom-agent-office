// Kernel plugin lifecycle: PluginContext factory, activate/deactivate and the
// four-phase reload orchestration (spec §2.1/§2.5). Every capability a plugin
// touches is brokered through the context so deactivation can fully revoke it:
// effects run LIFO, tracked timers are cleared, and event subscriptions, port
// registrations, http routes and pending afterAllActivated callbacks owned by
// the plugin are removed. Deactivate must never throw — teardown of one plugin
// is never allowed to block teardown of the rest or wedge a reload.
import { WebSocket } from 'ws';

// Port registry: the kernel-owned marketplace where plugins publish and the
// engine consumes capabilities (spec §2.2). Map ports are keyed by port id and
// hold { impl, owner }; chain ports (middleware/progressor) are ordered lists
// and are spliced in place — consumers keep the reference they were handed.
export function createPortRegistry() {
  const channel = new Map();
  const provider = new Map();
  const page = new Map();
  const middleware = [];
  const progressor = [];
  return {
    channel, provider, page, middleware, progressor,
    getChannel: (id) => channel.get(id)?.impl,
    getProvider: (id) => provider.get(id)?.impl,
  };
}

export function createLifecycle({ events, services, log, http, portRegistry = createPortRegistry() }) {
  const records = new Map(); // plugin id → { plugin, effects[], timers:Set, offs[], httpPrefixes[] }
  const active = []; // activation order; deactivateAll walks it backwards
  let afterAllQueue = []; // { fn, owner } — consumed (drained) by runAfterAllActivated

  const idOf = (plugin) => plugin?.manifest?.id;

  const recordFor = (plugin) => {
    const id = idOf(plugin);
    let rec = records.get(id);
    if (!rec) {
      rec = { plugin, effects: [], timers: new Set(), offs: [], httpPrefixes: [] };
      records.set(id, rec);
    }
    return rec;
  };

  // Map ports: last write wins (a re-scanned plugin legitimately replaces an
  // older registration), but the shadowing is never silent — it is the loudest
  // misconfiguration in a plugin system, so it earns a warn.
  const registerPort = (type, portId, impl, rec) => {
    if (typeof portId !== 'string' || portId === '') throw new Error(`port ${type} registration requires a string id`);
    if (impl == null) throw new Error(`port ${type} ${portId} registration requires an implementation`);
    const owner = idOf(rec.plugin);
    const map = portRegistry[type];
    if (map.has(portId)) log.warn(`port ${type} ${portId} re-registered by ${owner}`);
    map.set(portId, { impl, owner });
  };

  const pushPort = (type, impl, rec) => {
    if (impl == null) throw new Error(`port ${type} registration requires an implementation`);
    portRegistry[type].push({ impl, owner: idOf(rec.plugin) });
  };

  const removeOwnedPorts = (owner) => {
    for (const map of [portRegistry.channel, portRegistry.provider, portRegistry.page]) {
      for (const [key, entry] of map) if (entry.owner === owner) map.delete(key);
    }
    for (const list of [portRegistry.middleware, portRegistry.progressor]) {
      for (let i = list.length - 1; i >= 0; i--) if (list[i].owner === owner) list.splice(i, 1);
    }
  };

  const makeContext = (plugin) => {
    const id = idOf(plugin);
    if (!id) throw new Error('lifecycle: makeContext requires plugin.manifest.id (ownership keying would be corrupt)');
    const rec = recordFor(plugin);
    const childLog = log.child(id);
    const pluginConfig = plugin.config ?? {};

    // Timer callbacks are a kernel-mediated failure boundary (spec §2.5): a
    // throwing callback is attributed and skipped; the timer keeps firing —
    // a broken callback must not silently disarm a heartbeat-ish interval.
    const guarded = (fn) => (...args) => {
      try { fn(...args); } catch (err) { childLog.error('timer callback failed', err); }
    };
    const track = (timer) => { rec.timers.add(timer); return timer; };
    const untrack = (timer) => { rec.timers.delete(timer); };

    const ctx = {
      id,
      log: childLog,
      config: pluginConfig,
      events: {
        on: (topic, fn) => {
          const off = events.on(topic, fn, id); // bus attributes this subscriber to the plugin
          const wrappedOff = () => {
            off();
            const i = rec.offs.indexOf(wrappedOff); // manual off also empties the teardown list
            if (i !== -1) rec.offs.splice(i, 1);
          };
          rec.offs.push(wrappedOff);
          return wrappedOff;
        },
        emit: (topic, payload) => events.emit(topic, payload),
      },
      http: {
        register: ({ prefix, handler }) => {
          http.register({ prefix, handler, owner: id }); // duplicate prefix throws → propagates out of activate; the loader (T6) marks the error
          rec.httpPrefixes.push(prefix);
        },
      },
      services, // container pass-through: core-engine registers engine/ledger/timeline here
      registerChannel: (portId, impl) => registerPort('channel', portId, impl, rec),
      registerProvider: (portId, impl) => registerPort('provider', portId, impl, rec),
      registerPage: (desc) => registerPort('page', desc?.id, desc, rec),
      registerMiddleware: (impl) => pushPort('middleware', impl, rec),
      registerProgressor: (impl) => pushPort('progressor', impl, rec),
      setTimeout: (fn, ms) => track(setTimeout(guarded(fn), ms)),
      setInterval: (fn, ms) => track(setInterval(guarded(fn), ms)),
      clearTimeout: (timer) => { untrack(timer); clearTimeout(timer); },
      clearInterval: (timer) => { untrack(timer); clearInterval(timer); },
      ws: { WebSocket }, // kernel-provided client infra (spec §2.1) so plugins need zero npm deps
      effect: (fn) => {
        if (typeof fn !== 'function') throw new Error(`lifecycle: effect requires a function, got ${typeof fn}`);
        rec.effects.push(fn); // stack: deactivated LIFO
      },
      afterAllActivated: (fn) => {
        if (typeof fn !== 'function') throw new Error('lifecycle: afterAllActivated requires a function');
        afterAllQueue.push({ fn, owner: id }); // for core-engine to rebuild bot runtimes once everyone is up
      },
    };
    return ctx;
  };

  const activate = async (plugin) => {
    // The loader (T6) owns validation and error states; lifecycle only refuses
    // records it cannot key or invoke — activating them would corrupt the
    // ownership bookkeeping that teardown below relies on.
    if (!idOf(plugin) || typeof plugin.mod?.activate !== 'function') return;
    const ctx = makeContext(plugin);
    // Pushed before activate: a throwing activate leaves the half-registered
    // plugin in the teardown set, so a later deactivateAll still cleans it up.
    active.push(plugin);
    await plugin.mod.activate(ctx, plugin.config ?? {});
  };

  const deactivate = async (plugin) => {
    const id = idOf(plugin);
    if (!id) return;
    const rec = records.get(id);
    if (rec) {
      // Effects LIFO, each awaited and guarded: one plugin's failing (or
      // rejecting) cleanup is logged, never thrown, never blocks the rest.
      while (rec.effects.length > 0) {
        const fn = rec.effects.pop();
        try { await fn(); } catch (err) { log.error(`lifecycle: ${id} effect failed`, err); }
      }
      for (const timer of rec.timers) {
        // Both clear flavors on every handle: we do not record which kind was
        // created, and clearing both ways is idempotent in Node.
        try { clearInterval(timer); } catch {}
        try { clearTimeout(timer); } catch {}
      }
      rec.timers.clear();
      for (const off of rec.offs.splice(0)) { try { off(); } catch {} } // revoke bus subscriptions
      removeOwnedPorts(id);
      for (const prefix of rec.httpPrefixes.splice(0)) { try { http.unregister(prefix); } catch {} }
      afterAllQueue = afterAllQueue.filter((e) => e.owner !== id); // stale callbacks must not fire after reload
      records.delete(id);
    }
    let i = active.indexOf(plugin);
    if (i === -1) i = active.findIndex((p) => idOf(p) === id); // tolerate a re-made record object for the same id
    if (i !== -1) active.splice(i, 1);
    plugin.status = 'disabled';
  };

  const deactivateAll = async () => {
    // Reverse activation order: dependents (loaded later, e.g. channels on top
    // of core) come down before what they depend on — the §2.5 ordering fix.
    for (const plugin of [...active].reverse()) await deactivate(plugin);
  };

  const runAfterAllActivated = async () => {
    const batch = afterAllQueue;
    afterAllQueue = []; // consume: a reload re-registers fresh callbacks from the new instances
    for (const { fn, owner } of batch) {
      try { await fn(); } catch (err) { log.error(`lifecycle: ${owner} afterAllActivated failed`, err); }
    }
  };

  // Phase 0 (also the front half of SIGINT shutdown, which stops after this
  // plus deactivateAll): drain runs while channels are still alive, but a hung
  // drain must never wedge reload — race it against a timeout and proceed.
  const drainEngine = async (timeoutMs = 5000) => {
    const engine = services.get('engine');
    if (!engine || typeof engine.drain !== 'function') return;
    let drainPromise;
    try {
      drainPromise = engine.drain(timeoutMs);
    } catch (err) {
      log.error('lifecycle: engine drain failed', err);
      return;
    }
    let timedOut = false;
    let timer = null;
    try {
      await Promise.race([
        Promise.resolve(drainPromise).catch((err) => log.error('lifecycle: engine drain failed', err)),
        new Promise((resolve) => { timer = setTimeout(() => { timedOut = true; resolve(); }, timeoutMs); }),
      ]);
    } finally {
      clearTimeout(timer); // the losing branch's timer must not linger
    }
    if (timedOut) log.warn(`lifecycle: engine drain did not settle within ${timeoutMs}ms, proceeding`);
  };

  const fourPhase = async ({ reloadFn, drainTimeoutMs = 5000 }) => {
    await drainEngine(drainTimeoutMs); // ① drain (bounded)
    await deactivateAll(); // ② reverse teardown
    await reloadFn(); // ③ caller rescans + activates; its errors are the caller's to handle
    await runAfterAllActivated(); // ④ rebuild bot runtimes on the fresh port set
  };

  const debugState = () => ({
    active: active.map(idOf),
    timers: Object.fromEntries([...records].map(([id, rec]) => [id, rec.timers.size])),
  });

  return { portRegistry, makeContext, activate, deactivate, deactivateAll, runAfterAllActivated, drainEngine, fourPhase, debugState };
}
