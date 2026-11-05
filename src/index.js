#!/usr/bin/env node
// wao entry (spec §1 startup sequence, §2.5 stop, §8 kernel-native API):
// a thin CLI (start/doctor/version) over the createKernel library function.
// Boot order is deliberate: the exclusive data-dir lock is claimed before
// anything creates files (a second instance leaves no side effects), then
// logger → services → bus → http shell → lifecycle, plugin activation, the
// afterAllActivated batch, and only then the HTTP listener — a busy port
// fails the boot before anything serves traffic.
import process from 'node:process';
import net from 'node:net';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from './kernel/log.js';
import { lockDataDir, readJson, writeJson } from './kernel/config.js';
import { createEventBus } from './kernel/events.js';
import { createServices } from './kernel/services.js';
import { createHttpShell } from './kernel/http.js';
import { createLifecycle } from './kernel/lifecycle.js';
import * as loader from './kernel/loader.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultDataDir = () => process.env.WAO_HOME || join(process.cwd(), 'data');

// Repo-bundled plugins first, then operator extras from WAO_PLUGINS_PATH
// (colon-separated, empty segments dropped) — the §2.1 scan rule.
const defaultPluginsDirs = () => {
  const dirs = [join(repoRoot, 'plugins')];
  for (const extra of (process.env.WAO_PLUGINS_PATH ?? '').split(':')) if (extra !== '') dirs.push(extra);
  return dirs;
};

const json = (res, code, obj, extra = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json', ...extra });
  res.end(JSON.stringify(obj));
};

// Library entry: wires every kernel module and returns the kernel object.
// stop() is the whole teardown story — library callers own it explicitly;
// only the CLI additionally maps SIGINT/SIGTERM onto it.
export async function createKernel({ port = 8792, host = '127.0.0.1', dataDir, pluginsDirs, log } = {}) {
  const dir = dataDir ?? defaultDataDir();
  const lock = lockDataDir(dir); // throws "data dir locked by pid N" for a live second instance
  const logger = log ?? createLogger({
    file: join(dir, 'logs', 'wao.log'),
    level: process.env.WAO_LOG_LEVEL || 'info',
  });
  const roots = pluginsDirs ?? defaultPluginsDirs();

  const services = createServices();
  const events = createEventBus({ log: logger });
  const http = createHttpShell({ log: logger });
  const lifecycle = createLifecycle({ events, services, log: logger, http });
  const portRegistry = lifecycle.portRegistry;
  // Kernel-assembly facts for plugins (core-engine reads both at activate):
  // the shared port registry and the data dir are kernel-level state — reached
  // through the service container instead of a new ctx surface.
  services.register('ports', portRegistry);
  services.register('paths', { dataDir: dir });

  const startedAt = Date.now();
  const uptimeSec = () => Math.round((Date.now() - startedAt) / 1000);
  let lastLoad = { active: [], failed: [] };
  let lastDisabled = []; // {id,type,version} — plugins the enable table filtered out
  let knownPluginIds = new Set(); // every manifest id ever discovered (incl. disabled/failed)

  // Snapshot view of the last activateAll batch: /api/state, /api/plugins and
  // status() answer from a copy, never from loader state a concurrent reload
  // could be mid-mutating. Disabled plugins are LISTED (status 'disabled')
  // rather than omitted — the UI must be able to show what to re-enable.
  const pluginList = () => [
    ...lastLoad.active.map(({ id, type, version }) => ({ id, type, version, status: 'active' })),
    ...lastLoad.failed.map(({ id, error }) => ({ id, status: 'failed', error })),
    ...lastDisabled.map((d) => ({ ...d, status: 'disabled' })),
  ];

  // Scan the roots for plugin dirs. The manifest id is read through the same
  // cache-busted import the loader uses, so an enabled plugin's module top
  // level evaluates once per mtime (the loader's second import hits the
  // module cache). Honest tradeoff, not a guarantee: this import runs for
  // EVERY candidate dir — including plugins the enable table then filters
  // out, so a disabled plugin's module top level still evaluates, and no
  // timeout guards imports (the loader's 10s bound covers activate, not
  // import): a disabled plugin with a hanging top-level await blocks boot
  // and reload. `_`-prefixed dirs are scaffolding (_template), `.`-prefixed
  // are not plugins; an unimportable dir is kept so activateAll records the
  // failure instead of the plugin vanishing silently from every report.
  const discover = async () => {
    const found = [];
    for (const root of roots) {
      let entries = [];
      try { entries = readdirSync(root, { withFileTypes: true }); } catch { continue; } // missing root = no plugins there (yet)
      for (const ent of entries) {
        if (!ent.isDirectory() || ent.name.startsWith('.') || ent.name.startsWith('_')) continue;
        const pluginDir = join(root, ent.name);
        let manifest = null;
        try { manifest = (await loader.importPlugin(pluginDir)).manifest ?? null; } catch { /* import failure surfaces via activateAll */ }
        found.push({ dir: pluginDir, id: manifest?.id ?? null, manifest });
      }
    }
    return found;
  };

  // Shared by boot and reload: the enable table in plugins.json is data and
  // is re-read every pass (never cached), disabled dirs are filtered out
  // before the loader ever sees them, and each enabled plugin receives its
  // options as ctx.config (DESIGN §2.6: `{enabled, options}` — `enabled` is
  // consumed here, `options` belongs to the plugin).
  const loadPlugins = async () => {
    const table = readJson(join(dir, 'plugins.json'))?.plugins ?? {};
    const enabled = (id) => !(table[id] && table[id].enabled === false);
    const found = await discover();
    knownPluginIds = new Set(found.filter(({ id }) => id != null).map(({ id }) => id));
    lastDisabled = found
      .filter(({ id }) => id != null && !enabled(id))
      .map(({ id, manifest }) => ({ id, type: manifest?.type, version: manifest?.version }));
    const dirs = found.filter(({ id, dir: d }) => enabled(id ?? basename(d))).map((f) => f.dir);
    const pluginConfig = {};
    for (const { id } of found) if (id != null && enabled(id)) pluginConfig[id] = table[id]?.options ?? {};
    lastLoad = await loader.activateAll({ dirs, lifecycle, portRegistry, pluginConfig, log: logger });
    return lastLoad;
  };

  // Kernel-native API (§8), registered directly on the shell — not a plugin,
  // so they survive every reload and exist even with zero plugins loaded.
  http.register({
    prefix: '/api/state', owner: 'kernel', handler: (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
      json(res, 200, { ok: true, uptimeSec: uptimeSec(), pid: process.pid, plugins: pluginList(), uiPlugins: [] });
    },
  });
  http.register({
    prefix: '/api/plugins', owner: 'kernel', handler: (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
      json(res, 200, { plugins: pluginList() });
    },
  });
  http.register({
    prefix: '/api/service/reload', owner: 'kernel', handler: (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
      // Returned promise: the shell's dispatch wrapper turns a rejection into
      // an attributed 500 instead of an unhandled crash.
      return reload().then(() => json(res, 200, { ok: true }));
    },
  });
  // Plugin runtime enable/disable (DESIGN §8 kernel-native): body-less POST
  // flips the enable table in plugins.json (atomic read-modify-write, other
  // options preserved) and drives the four-phase reload — disable of a core
  // plugin goes through the same drain→teardown→rescan path, so the engine
  // drain obligation chain fires. Longer prefix than any plugin's '/api', so
  // it wins dispatch over core-engine's catch-all.
  http.register({
    prefix: '/api/plugins/', owner: 'kernel', handler: (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const m = /^\/api\/plugins\/([^/]+)\/(enable|disable)$/.exec(pathname);
      if (m == null) return json(res, 404, { error: 'not found' });
      let id = m[1];
      try { id = decodeURIComponent(id); } catch { /* keep raw */ }
      if (!knownPluginIds.has(id)) return json(res, 404, { error: `unknown plugin: ${id}` });
      const file = join(dir, 'plugins.json');
      const doc = readJson(file) ?? {};
      const plugins = { ...((doc != null && typeof doc === 'object' && !Array.isArray(doc)) ? doc.plugins : {}) };
      plugins[id] = { ...plugins[id], enabled: m[2] === 'enable' };
      writeJson(file, { ...(doc ?? {}), plugins });
      // Reload chains with any in-flight one; the response carries the NEW list.
      return reload().then(() => json(res, 200, { ok: true, plugins: pluginList() }));
    },
  });

  // Four-phase reload (§2.5): drain → reverse teardown → rescan+activate →
  // afterAllActivated. loadPlugins re-reads plugins.json inside phase ③.
  const doReload = async ({ drainTimeoutMs = 5000 } = {}) => {
    await lifecycle.fourPhase({ drainTimeoutMs, reloadFn: loadPlugins });
    // The port set changed (§2.5): notify subscribers (core-engine reconcile).
    events.emit('plugin/lifecycle', { ids: lastLoad.active.map((a) => a.id) });
    return { active: [...lastLoad.active], failed: [...lastLoad.failed] };
  };
  // Reloads are serialized through a chain: fourPhase is not reentrant, and
  // two overlapping POSTs (or a POST racing a library reload()) would
  // interleave their teardown/activation halves on the shared lifecycle —
  // double activation and "prefix already registered" showing up as a false
  // `failed` entry. Each caller awaits its own link's outcome; the chain
  // itself swallows rejections so one bad reload cannot wedge the queue.
  let reloadChain = Promise.resolve();
  const reload = (opts) => {
    const link = reloadChain.then(() => doReload(opts));
    reloadChain = link.then(() => {}, () => {});
    return link;
  };

  let stopped = false;
  const stop = async ({ closeTimeoutMs = 5000 } = {}) => {
    if (stopped) return; // SIGINT then SIGTERM: the second signal must not re-run teardown
    stopped = true;
    // Phase-1-only stop semantics: drain while channels are still up, then
    // reverse-deactivate, close the listener, release the data-dir lock. Each
    // step is individually guarded — stop must never throw, and one step's
    // failure must not skip the others.
    try { await lifecycle.drainEngine(5000); } catch (err) { logger.error('stop: engine drain failed', err); }
    try { await lifecycle.deactivateAll(); } catch (err) { logger.error('stop: deactivate failed', err); }
    // http.close() waits out non-idle connections: a client wedged mid-request
    // would hold stop() — and with it the lock release — hostage forever.
    // Bounded wait; on timeout destroy the remaining connections by force.
    try {
      let settled = false;
      let timer = null;
      const closing = http.close().then(() => { settled = true; }, () => { settled = true; });
      await Promise.race([closing, new Promise((resolve) => { timer = setTimeout(resolve, closeTimeoutMs); })]);
      clearTimeout(timer); // the losing branch's timer must not linger
      if (!settled) {
        logger.warn(`stop: http close did not settle within ${closeTimeoutMs}ms, forcing connections closed`);
        await http.forceClose();
      }
    } catch (err) { logger.error('stop: http close failed', err); }
    lock.release();
  };

  const status = () => ({
    running: http.port != null,
    uptimeSec: uptimeSec(),
    port: http.port,
    dataDir: dir,
    plugins: pluginList(),
  });

  try {
    await loadPlugins();
    await lifecycle.runAfterAllActivated();
    await http.listen(port, host);
  } catch (err) {
    // A failed boot must not leak: half-activated plugins are torn down and
    // the lock released, so the operator fixes the cause and starts again.
    try { await lifecycle.deactivateAll(); } catch { /* rollback must never mask the boot error */ }
    lock.release();
    if (err?.code === 'EADDRINUSE') throw new Error(`port ${port} in use (second instance?)`, { cause: err });
    throw err;
  }

  logger.info(`wao up: ${lastLoad.active.length} plugins on http://${host}:${http.port} (data: ${dir})`);
  return {
    events, services, http, lifecycle, loader, portRegistry, status, reload, stop,
    // Not part of the library API surface: escape hatch for the CLI's
    // second-signal force exit, so a wedged teardown cannot cost the
    // operator the lock too (a released-then-leaked lock is adoptable on
    // next boot anyway — config.js's stale-holder path).
    releaseLock: lock.release,
  };
}

// --- CLI (thin on purpose: parse, delegate, exit) ---------------------------

const USAGE = 'usage: wao [start [--port N] [--host H] [--data-dir DIR] | doctor [--port N] [--host H] [--data-dir DIR] | version]';
const pkgVersion = () => JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// Strict parsing (reject beats silent correction): an unknown flag or a flag
// without a value is a typo'd command line, not an invitation to guess.
const parseFlags = (raw) => {
  const known = new Set(['port', 'host', 'data-dir']);
  const flags = {};
  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i];
    if (!arg.startsWith('--')) return { error: `unexpected argument: ${arg}` };
    const name = arg.slice(2);
    if (!known.has(name)) return { error: `unknown flag: ${arg}` };
    const value = raw[i + 1];
    if (value === undefined || value.startsWith('--')) return { error: `${arg} requires a value` };
    flags[name] = value;
    i++;
  }
  return { flags };
};

const portOf = (flags, fallback) => {
  if (flags.port === undefined) return fallback;
  const n = Number(flags.port);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`--port must be an integer between 0 and 65535, got '${flags.port}'`);
  }
  return n;
};

const cmdStart = async (flags) => {
  const kernel = await createKernel({
    port: portOf(flags, 8792),
    host: flags.host ?? '127.0.0.1',
    dataDir: flags['data-dir'],
  });
  const st = kernel.status();
  console.log(`wao v${pkgVersion()} listening on http://${flags.host ?? '127.0.0.1'}:${st.port} (pid ${process.pid}, data ${st.dataDir})`);
  // Graceful stop (§1): SIGINT/SIGTERM run the four-phase teardown, then exit.
  let signalled = false;
  const shutdown = () => {
    if (signalled) {
      // Force-exit hatch: a second signal during teardown means the operator
      // wants out now — stop() may be wedged on a hung drain/effect past its
      // own bounds. Best-effort lock release (idempotent, and a leaked lock
      // is adoptable via the stale-holder path), then exit 0 immediately.
      try { kernel.releaseLock(); } catch { /* best effort by definition */ }
      process.exit(0);
    }
    signalled = true;
    kernel.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return 0; // the listener keeps the process alive from here
};

// Someone answering a TCP connect = a listener is already bound; refused or
// silent = free to try (a filtered port cannot be probed — "no answer" is the
// honest report). 2s timeout so a dropping firewall cannot hang doctor.
const checkPortFree = (host, port, timeoutMs = 2000) => new Promise((settled) => {
  const sock = net.connect({ port, host });
  const done = (free) => { sock.destroy(); settled(free); };
  sock.setTimeout(timeoutMs, () => done(true));
  sock.once('connect', () => done(false));
  sock.once('error', () => done(true));
});

const cmdDoctor = async (flags) => {
  let bad = 0;
  const mark = (sym, item, detail) => {
    console.log(`${sym} ${item}: ${detail}`);
    if (sym === '✗') bad++;
  };

  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > 20 || (major === 20 && minor >= 10)) mark('✓', 'node', `v${process.versions.node} (floor 20.10)`);
  else mark('!', 'node', `v${process.versions.node} is below the 20.10 floor (engines >=20.10) — warn only`);

  for (const root of defaultPluginsDirs()) {
    let count = 0;
    try {
      for (const ent of readdirSync(root, { withFileTypes: true })) {
        if (ent.isDirectory() && !ent.name.startsWith('.') && !ent.name.startsWith('_')
          && existsSync(join(root, ent.name, 'plugin.js'))) count++;
      }
      mark('✓', 'plugins', `${count} plugin dir${count === 1 ? '' : 's'} (${root})`);
    } catch (err) {
      mark('✗', 'plugins', `cannot scan ${root} (${err.code ?? err.message})`);
    }
  }

  const dataDir = flags['data-dir'] ?? defaultDataDir();
  try {
    mkdirSync(dataDir, { recursive: true });
    const probe = join(dataDir, `.doctor-probe-${process.pid}`);
    writeFileSync(probe, 'probe');
    rmSync(probe);
    mark('✓', 'data dir', `${dataDir} writable`);
  } catch (err) {
    mark('✗', 'data dir', `${dataDir} not writable (${err.code ?? err.message})`);
  }

  const host = flags.host ?? '127.0.0.1';
  const port = portOf(flags, 8792);
  const free = await checkPortFree(host, port);
  mark(free ? '✓' : '✗', 'port', free ? `${port} free on ${host}` : `port ${port} already in use`);

  try {
    await import('ws');
    mark('✓', 'ws', "module 'ws' resolvable");
  } catch (err) {
    mark('✗', 'ws', `'ws' not resolvable — run npm install (${err.code ?? err.message})`);
  }
  return bad === 0 ? 0 : 1;
};

// invokedAsScript, not import.meta.main (Node <20.11): realpath because an
// npm/link bin entry is a symlink while ESM resolves import.meta.url to the
// real path — a plain string compare would miss every linked invocation.
const invokedAsScript = (() => {
  if (!process.argv[1]) return false;
  try { return realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();

if (invokedAsScript) {
  const raw = process.argv.slice(2);
  const cmd = raw.find((a) => !a.startsWith('-')) ?? 'start';
  const { flags = {}, error } = parseFlags(raw.filter((a) => a !== cmd));
  const run = async () => {
    if (error) return { code: 2, err: error };
    if (cmd === 'version') { console.log(pkgVersion()); return { code: 0 }; }
    if (cmd === 'start') return { code: await cmdStart(flags) };
    if (cmd === 'doctor') return { code: await cmdDoctor(flags) };
    return { code: 2, err: `unknown command: ${cmd}` };
  };
  run().then(
    ({ code, err }) => {
      if (err) { console.error(err); console.error(USAGE); }
      if (code !== 0) process.exit(code); // code 0 for start: the server keeps the process alive
    },
    (err) => { console.error(`wao: ${err?.message ?? err}`); process.exit(1); },
  );
}
