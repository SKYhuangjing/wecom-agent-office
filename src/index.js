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
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from './kernel/log.js';
import { lockDataDir, readJson, writeJson } from './kernel/config.js';
import { createEventBus } from './kernel/events.js';
import { createServices } from './kernel/services.js';
import { createHttpShell, sendFile, fileUnder } from './kernel/http.js';
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
  // data/ is owner-only (DESIGN §3/§13): bots.json/ledger/sessions carry
  // secrets and conversation content. Create the dir 0700, and tighten an
  // existing dir whose perms are looser — best-effort, a chmod failure (odd
  // mount, read-only FS) must not fail boot over a permission ambition.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    if ((statSync(dir).mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
  } catch { /* best-effort by design */ }
  const lock = lockDataDir(dir); // throws "data dir locked by pid N" for a live second instance
  const logger = log ?? createLogger({
    file: join(dir, 'logs', 'wao.log'),
    level: process.env.WAO_LOG_LEVEL || 'info',
  });
  const roots = pluginsDirs ?? defaultPluginsDirs();

  const services = createServices();
  const events = createEventBus({ log: logger });
  // web/dist is a committed build artifact (M3): the console exists even on a
  // fresh clone with no build step. A missing dir just means GET / 404s —
  // boot never depends on the console being present.
  const webDir = join(repoRoot, 'web', 'dist');
  const http = createHttpShell({ log: logger, webDir });
  // SSE bridge (DESIGN §8 /api/events): the bus topics the UI may see are
  // forwarded verbatim to every live SSE client. The whitelist IS the list —
  // the bus has no wildcards, so a plugin cannot smuggle a new topic onto the
  // wire by emitting it. Kernel-lifetime subscription (never unsubscribed).
  for (const topic of ['agent/progress', 'agent/status', 'run/start', 'run/end',
    'ledger/turn', 'service/state', 'plugin/lifecycle']) {
    events.on(topic, (payload) => http.sseSend(topic, payload));
  }
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
  let lastFound = []; // discover() snapshot: {dir,id,manifest} — ui hosting input
  // Page-plugin ui roots (M3, DESIGN §9): plugins whose manifest declares
  // `ui: '<dir>'` AND ship <dir>/index.js get that dir hosted at
  // /api/ui/<id>/*. Rebuilt on every load pass, so reload/deactivate drops a
  // vanished plugin's hosting with it (same lifetime as its ports).
  const uiRoots = () => {
    const activeIds = new Set(lastLoad.active.map((a) => a.id));
    const out = [];
    for (const { id, dir, manifest } of lastFound) {
      if (id == null || !activeIds.has(id)) continue;
      const rel = manifest?.ui;
      if (typeof rel !== 'string' || rel === '') continue;
      const uiDir = resolve(dir, rel);
      if (!existsSync(join(uiDir, 'index.js'))) continue;
      out.push({ id, dir: uiDir });
    }
    return out;
  };
  const uiPlugins = () => uiRoots().map(({ id }) => ({ id, entry: `/api/ui/${id}/index.js` }));

  // Snapshot view of the last activateAll batch: /api/state, /api/plugins and
  // status() answer from a copy, never from loader state a concurrent reload
  // could be mid-mutating. Disabled plugins are LISTED (status 'disabled')
  // rather than omitted — the UI must be able to show what to re-enable.
  const pluginList = () => [
    ...lastLoad.active.map(({ id, name, type, version }) => ({ id, name, type, version, status: 'active' })),
    // The loader's error copy attributes with an id prefix; the entry carries
    // `id` right beside it, so the prefix is stripped here — "stray: failed —
    // stray: import failed" reads the id twice; once is enough. A failed
    // import may leave no readable manifest: name stays null then.
    ...lastLoad.failed.map(({ id, error }) => ({
      id, status: 'failed',
      error: typeof error === 'string' && error.startsWith(`${id}: `) ? error.slice(id.length + 2) : error,
    })),
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
    lastFound = found;
    knownPluginIds = new Set(found.filter(({ id }) => id != null).map(({ id }) => id));
    lastDisabled = found
      .filter(({ id }) => id != null && !enabled(id))
      .map(({ id, manifest }) => ({ id, name: manifest?.name ?? null, type: manifest?.type, version: manifest?.version }));
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
      json(res, 200, { ok: true, uptimeSec: uptimeSec(), pid: process.pid, plugins: pluginList(), uiPlugins: uiPlugins() });
    },
  });
  // Page-plugin static hosting (DESIGN §9): /api/ui/<id>/<file> serves the
  // ui/ dir a plugin's manifest declared, kernel-native so it exists even
  // mid-reload quirks and wins dispatch over core-engine's shorter '/api'.
  // Every path goes through fileUnder — traversal attempts are plain 404s.
  http.register({
    prefix: '/api/ui/', owner: 'kernel', handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
      let pathname;
      try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch {
        return json(res, 404, { error: 'not found' });
      }
      const m = /^\/api\/ui\/([^/]+)\/(.*)$/.exec(pathname);
      if (m == null) return json(res, 404, { error: 'not found' });
      const root = uiRoots().find(({ id }) => id === m[1])?.dir;
      if (root == null) return json(res, 404, { error: 'not found' });
      const file = fileUnder(root, m[2]);
      if (file == null) return json(res, 404, { error: 'not found' });
      return sendFile(res, file);
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
    // failure must not skip the others. Success is narrated into the log so
    // ops can tell a graceful stop from a wedged one from the log tail alone.
    logger.info('wao: stopping (four-phase)');
    try { await lifecycle.drainEngine(5000); } catch (err) { logger.error('stop: engine drain failed', err); }
    logger.info('wao: drain done');
    try { await lifecycle.deactivateAll(); } catch (err) { logger.error('stop: deactivate failed', err); }
    logger.info('wao: plugins deactivated');
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
    logger.info('wao: stopped (lock released)');
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
    events, services, http, lifecycle, loader, portRegistry, status, reload, stop, log: logger,
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
  // Through the logger (timestamped, level info, file+stderr): the boot banner
  // belongs in data/logs/wao.log like every other lifecycle fact, not on bare
  // stdout where the log tail would miss it.
  kernel.log.info(`wao v${pkgVersion()} listening on http://${flags.host ?? '127.0.0.1'}:${st.port} (pid ${process.pid}, data ${st.dataDir})`);
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

// PATH scan without executing anything: the first executable entry named
// `bin` wins (a `command -v` in pure node). null = not on PATH.
const whichBin = (bin) => {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir === '') continue;
    try {
      accessSync(join(dir, bin), constants.X_OK);
      return join(dir, bin);
    } catch { /* keep scanning */ }
  }
  return null;
};

const cmdDoctor = async (flags) => {
  let bad = 0;
  const mark = (sym, item, detail) => {
    console.log(`${sym} ${item}: ${detail}`);
    if (sym === '✗') bad++;
  };

  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > 20 || (major === 20 && minor >= 10)) mark('✓', 'node', `v${process.versions.node} (floor 20.10)`);
  else mark('!', 'node', `v${process.versions.node} is below the 20.10 floor (engines >=20.10) — warn only`);

  try {
    await import('ws');
    mark('✓', 'ws', "module 'ws' resolvable");
  } catch (err) {
    mark('✗', 'ws', `'ws' not resolvable — run npm install (${err.code ?? err.message})`);
  }

  for (const root of defaultPluginsDirs()) {
    let count = 0;
    const nonEsm = [];
    try {
      for (const ent of readdirSync(root, { withFileTypes: true })) {
        if (ent.isDirectory() && !ent.name.startsWith('.') && !ent.name.startsWith('_')
          && existsSync(join(root, ent.name, 'plugin.js'))) {
          count++;
          // Node <22.7 parses a .js plugin without package.json
          // {"type":"module"} as CommonJS — the loader records a load
          // failure for it. Doctor names the dir so the fix is obvious.
          let type = null;
          try { type = JSON.parse(readFileSync(join(root, ent.name, 'package.json'), 'utf8')).type; } catch { /* missing/broken package.json */ }
          if (type !== 'module') nonEsm.push(ent.name);
        }
      }
      mark('✓', 'plugins', `${count} plugin dir${count === 1 ? '' : 's'} (${root})`);
      for (const name of nonEsm) {
        mark('!', 'plugins', `${name}: plugin.js present but package.json lacks {"type":"module"} — it will fail to load`);
      }
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

  // Agent CLI presence is INFORMATIONAL (`!`, never ✗): a missing CLI only
  // fails that provider's runs at runtime — the /api/bots/:id/test endpoint
  // and probe.sh report it precisely; doctor just tells the operator which
  // agent CLIs this machine currently has.
  for (const cli of ['dsh', 'claude', 'codex']) {
    const found = whichBin(cli);
    if (found != null) mark('✓', `cli ${cli}`, `present (${found})`);
    else mark('!', `cli ${cli}`, 'not found in PATH (informational — provider runs needing it will fail)');
  }

  // Claim+release probe with the REAL lock: a live holder (second instance)
  // means start would refuse — that is a failure, not a warning.
  try {
    const lock = lockDataDir(dataDir);
    lock.release();
    mark('✓', 'lock', `${dataDir} lockable (claim+release probe)`);
  } catch (err) {
    mark('✗', 'lock', `${dataDir} not lockable (${err.message})`);
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
