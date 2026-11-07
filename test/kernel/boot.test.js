// Kernel boot tests (spec §1 startup sequence, §2.5 stop, §8 kernel-native
// API): createKernel wires every kernel module behind the exclusive data-dir
// lock, activates the enabled plugin dirs, serves /healthz + /api/state +
// /api/plugins + /api/service/reload on the http shell, reloads through the
// four-phase orchestration, and stops without ever throwing. Everything runs
// against real tmpdirs and real plugin dirs — the data-dir lock and the ESM
// loader only tell the truth against the real filesystem, not object doubles.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createKernel } from '../../src/index.js';
import { writeJson } from '../../src/kernel/config.js';

// T6 convention (DESIGN §2.3): a plugin dir carries its own package.json
// {"type":"module"} so it parses as ESM on the Node 20 engines floor too.
const writePlugin = (dir, manifestSrc, activateSrc = '') => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.js'), `export default { manifest: ${manifestSrc}, activate: async (ctx) => { ${activateSrc} } };`);
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
};

// File-wide safety net: every kernel is stopped before any tmpdir is removed,
// even when an assertion fails mid-test (a held data-dir lock on a deleted
// tmpdir would poison nothing, but an open server would fail the test runner).
const kernels = [];
const dirs = [];
after(async () => {
  for (const k of kernels.reverse()) await k.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const dataDirWith = (pluginsJson) => {
  const d = mkdtempSync(join(tmpdir(), 'wao-boot-data-'));
  dirs.push(d);
  if (pluginsJson != null) writeFileSync(join(d, 'plugins.json'), JSON.stringify(pluginsJson));
  return d;
};
const emptyPluginsDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'wao-boot-plugins-'));
  dirs.push(d);
  return d;
};
const start = async (dataDir, pluginsDirs) => {
  const k = await createKernel({ port: 0, dataDir, pluginsDirs });
  kernels.push(k);
  return k;
};
// Collecting logger double (createKernel accepts `log`): phase narration is
// assertable without touching stderr — same shape discipline as lifecycle's.
const captureLog = () => {
  const lines = [];
  const make = (prefix) => ({
    debug() {},
    info: (...a) => lines.push((prefix ? `[${prefix}] ` : '') + a.join(' ')),
    warn: (...a) => lines.push((prefix ? `[${prefix}] ` : '') + a.join(' ')),
    error: (...a) => lines.push((prefix ? `[${prefix}] ` : '') + a.join(' ')),
    child: make,
  });
  return { lines, log: make(null) };
};
const hasLine = (lines, expected) => lines.some((l) => l.includes(expected));
const base = (k) => (path) => `http://127.0.0.1:${k.http.port}${path}`;

test('boot: healthz 200, /api/state ok:true with empty plugin list', async () => {
  const k = await start(dataDirWith(null), [emptyPluginsDir()]);
  const url = base(k);
  assert.ok(Number.isInteger(k.http.port) && k.http.port > 0, 'port 0 binds an ephemeral port');
  const hz = await fetch(url('/healthz'));
  assert.equal(hz.status, 200);
  const hzBody = await hz.json();
  assert.equal(hzBody.ok, true);
  // P2 enrichment: package version always; bots omitted without an engine
  // service (healthz never depends on a plugin being live).
  assert.equal(hzBody.version, JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version);
  assert.equal(hzBody.bots, undefined);
  const body = await (await fetch(url('/api/state'))).json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.plugins, []);
  assert.deepEqual(body.uiPlugins, []);
  assert.equal(body.pid, process.pid);
  assert.equal(typeof body.uptimeSec, 'number');
});

test('a second kernel on the same dataDir is rejected: the lock is exclusive', async () => {
  const dataDir = dataDirWith(null);
  await start(dataDir, [emptyPluginsDir()]);
  await assert.rejects(
    createKernel({ port: 0, dataDir, pluginsDirs: [emptyPluginsDir()] }),
    /data dir locked/,
  );
});

test('plugins.json enabled:false filters the dir at boot and on reload; disabled plugins are LISTED; _template dirs are skipped', async () => {
  const dataDir = dataDirWith({ plugins: { 'p-x': { enabled: false } } });
  const pluginsDir = emptyPluginsDir();
  writePlugin(join(pluginsDir, 'p-x'), "{ id: 'p-x', type: 'core', version: '1.0.0' }");
  writePlugin(join(pluginsDir, '_template'), "{ id: 'tpl', type: 'core', version: '1.0.0' }");
  const k = await start(dataDir, [pluginsDir]);
  const url = base(k);
  // Disabled = listed with status 'disabled' (UI must show what to re-enable)
  assert.deepEqual((await (await fetch(url('/api/state'))).json()).plugins, [
    { id: 'p-x', name: null, type: 'core', version: '1.0.0', status: 'disabled' },
  ]);

  // Re-enable through plugins.json → the four-phase reload (driven here via
  // the kernel-native HTTP route, not just the library call) picks it up.
  writeFileSync(join(dataDir, 'plugins.json'), JSON.stringify({ plugins: { 'p-x': { enabled: true } } }));
  assert.deepEqual(await (await fetch(url('/api/service/reload'), { method: 'POST' })).json(), { ok: true });
  const list = (await (await fetch(url('/api/plugins'))).json()).plugins;
  assert.deepEqual(list, [{ id: 'p-x', name: null, type: 'core', version: '1.0.0', status: 'active' }]);

  // Disable again → listed as disabled on the next reload (table is re-read).
  writeFileSync(join(dataDir, 'plugins.json'), JSON.stringify({ plugins: { 'p-x': { enabled: false } } }));
  const r = await k.reload();
  assert.deepEqual(r, { active: [], failed: [] });
  assert.deepEqual((await (await fetch(url('/api/state'))).json()).plugins, [
    { id: 'p-x', name: null, type: 'core', version: '1.0.0', status: 'disabled' },
  ]);
});

test('POST /api/plugins/:id/enable|disable flips the table, reloads, and survives a world without the plugin', async () => {
  const dataDir = dataDirWith(null);
  const pluginsDir = emptyPluginsDir();
  // A core-like plugin (afterAllActivated + route): disabling it reloads a
  // world whose afterAllActivated batch is empty — must not crash, and its
  // route must be gone until re-enabled.
  writePlugin(
    join(pluginsDir, 'p-core-like'),
    "{ id: 'p-core-like', type: 'core', version: '1.0.0' }",
    "ctx.afterAllActivated(() => {}); ctx.http.register({ prefix: '/p-core-like', handler: (q, s) => s.end('hi') });",
  );
  const k = await start(dataDir, [pluginsDir]);
  const url = base(k);
  assert.equal(await (await fetch(url('/p-core-like'))).text(), 'hi');

  // unknown id → 404; wrong method → 405
  assert.equal((await fetch(url('/api/plugins/nope/disable'), { method: 'POST' })).status, 404);
  assert.equal((await fetch(url('/api/plugins/p-core-like/disable'))).status, 405);

  // disable → ok + NEW list, plugin torn down (route 404), kernel healthy
  let resp = await fetch(url('/api/plugins/p-core-like/disable'), { method: 'POST' });
  assert.equal(resp.status, 200);
  let body = await resp.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.plugins, [{ id: 'p-core-like', name: null, type: 'core', version: '1.0.0', status: 'disabled' }]);
  assert.equal((await fetch(url('/p-core-like'))).status, 404);
  assert.equal((await fetch(url('/healthz'))).status, 200);

  // enable → back active, route alive; table entry preserved + persisted
  resp = await fetch(url('/api/plugins/p-core-like/enable'), { method: 'POST' });
  assert.equal(resp.status, 200);
  body = await resp.json();
  assert.deepEqual(body.plugins, [{ id: 'p-core-like', name: null, type: 'core', version: '1.0.0', status: 'active' }]);
  assert.equal(await (await fetch(url('/p-core-like'))).text(), 'hi');
  const table = JSON.parse(readFileSync(join(dataDir, 'plugins.json'), 'utf8'));
  assert.equal(table.plugins['p-core-like'].enabled, true);
});

test('GET /api/service/reload is 405 (POST-only)', async () => {
  const k = await start(dataDirWith(null), [emptyPluginsDir()]);
  const resp = await fetch(base(k)('/api/service/reload'));
  assert.equal(resp.status, 405);
  assert.equal(resp.headers.get('allow'), 'POST');
});

test('reload() returns the batch shape; stop() closes http and releases the lock', async () => {
  const dataDir = dataDirWith(null);
  const k = await start(dataDir, [emptyPluginsDir()]);
  assert.deepEqual(await k.reload(), { active: [], failed: [] });
  const st = k.status();
  assert.equal(st.running, true);
  assert.equal(st.port, k.http.port);
  assert.equal(st.dataDir, dataDir);
  assert.deepEqual(st.plugins, []);
  const port = k.http.port;
  await k.stop();
  assert.equal(k.status().running, false);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`), (err) => err?.cause?.code === 'ECONNREFUSED');
  // Lock released by stop(): the same dataDir boots again in this process.
  const k2 = await start(dataDir, [emptyPluginsDir()]);
  assert.ok(k2.http.port > 0);
});

test('stop() resolves (never throws) with no engine service and is idempotent', async () => {
  const k = await start(dataDirWith(null), [emptyPluginsDir()]);
  await assert.doesNotReject(k.stop());
  await assert.doesNotReject(k.stop()); // CLI may deliver SIGINT then SIGTERM
});

test('stop() narrates its phases into the log (graceful shutdown is observable)', async () => {
  const { lines, log } = captureLog();
  const k = await createKernel({ port: 0, dataDir: dataDirWith(null), pluginsDirs: [emptyPluginsDir()], log });
  kernels.push(k);
  await k.stop();
  const expected = [
    'wao: stopping (four-phase)', 'wao: drain done', 'wao: plugins deactivated', 'wao: stopped (lock released)',
  ];
  for (const line of expected) {
    assert.ok(hasLine(lines, line), `stop log must include '${line}' (got: ${JSON.stringify(lines)})`);
  }
});

test('reload() narrates the four phases into the log', async () => {
  const { lines, log } = captureLog();
  const k = await createKernel({ port: 0, dataDir: dataDirWith(null), pluginsDirs: [emptyPluginsDir()], log });
  kernels.push(k);
  await k.reload();
  const expected = [
    'wao: reload: phase 1 drain', 'wao: reload: phase 2 deactivate',
    'wao: reload: phase 3 load (0 active)', 'wao: reload: phase 4 afterAll',
  ];
  for (const line of expected) {
    assert.ok(hasLine(lines, line), `reload log must include '${line}' (got: ${JSON.stringify(lines)})`);
  }
});

test('failed plugin entries read the id once: /api/plugins error drops the redundant id prefix', async () => {
  const pluginsDir = emptyPluginsDir();
  mkdirSync(join(pluginsDir, 'stray'), { recursive: true }); // no plugin.js → import failure
  const k = await start(dataDirWith(null), [pluginsDir]);
  const list = (await (await fetch(base(k)('/api/plugins'))).json()).plugins;
  const stray = list.find((p) => p.id === 'stray');
  assert.ok(stray, 'stray dir surfaces as a failed entry (loud over silent skip)');
  assert.equal(stray.status, 'failed');
  assert.match(stray.error, /import failed/);
  assert.ok(!stray.error.startsWith('stray:'), `error must not repeat the id prefix (got '${stray.error}')`);
});

test('EADDRINUSE boot rejects with the second-instance message and releases its lock', async () => {
  const k1 = await start(dataDirWith(null), [emptyPluginsDir()]);
  const taken = k1.http.port;
  const dataDir = dataDirWith(null);
  // Two attempts: the second proves the failed boot released the data-dir
  // lock — otherwise the retry would fail with "locked", not "port in use".
  for (let i = 0; i < 2; i++) {
    await assert.rejects(
      createKernel({ port: taken, dataDir, pluginsDirs: [emptyPluginsDir()] }),
      /in use \(second instance\?\)/,
    );
  }
});

test('stop() resolves within the close timeout when a client is wedged mid-request', { timeout: 8000 }, async () => {
  const k = await start(dataDirWith(null), [emptyPluginsDir()]);
  const sock = net.connect({ port: k.http.port, host: '127.0.0.1' });
  // forceClose() destroys the server side mid-request: depending on whether the
  // kernel still had the partial write buffered, the client sees FIN or RST —
  // and events.once(sock, 'close') REJECTS on a preceding 'error' (ECONNRESET).
  // Observe the error and wait for 'close' with plain-listener semantics, which
  // fire in both the FIN and RST paths.
  sock.on('error', () => {});
  await once(sock, 'connect');
  // Incomplete request (no blank line): the server keeps waiting for headers,
  // so the socket stays non-idle and an unbounded server.close() would hang.
  sock.write('GET /healthz HTTP/1.1\r\nHost: localhost\r\n');
  const began = Date.now();
  // Watcher attached BEFORE stop(): stop() ends with bounded async work (the
  // orphan sweep's pgrep execFile), and that event-loop yield can deliver the
  // client-side 'close' BEFORE stop() resolves — a listener attached only
  // afterwards would miss an event that already fired.
  const closedPromise = new Promise((resolve) => {
    sock.once('close', () => resolve(true));
    setTimeout(() => resolve(false), 2000);
  });
  await assert.doesNotReject(k.stop({ closeTimeoutMs: 300 }));
  assert.ok(Date.now() - began < 4000, 'stop resolves via the bounded close, not by hanging');
  assert.equal(await closedPromise, true, 'the wedged connection is destroyed once the timeout fires');
});

test('data/ is owner-only: boot creates 0700 / tightens a looser dir; files are born 0600', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wao-boot-perm-'));
  chmodSync(dataDir, 0o755); // simulate a pre-existing looser data dir
  dirs.push(dataDir);
  const k = await start(dataDir, [emptyPluginsDir()]);
  assert.equal(statSync(dataDir).mode & 0o777, 0o700, 'boot tightens a looser existing dir to 0700');
  assert.equal(statSync(join(dataDir, 'logs', 'wao.log')).mode & 0o777, 0o600, 'the log file is 0600');
  // atomicWrite is the funnel for bots.json/plugins.json/sessions: a file it
  // writes is born 0600 and stays 0600 across rewrites (fresh tmp + rename).
  const f = join(dataDir, 'probe.json');
  writeJson(f, { a: 1 });
  assert.equal(statSync(f).mode & 0o777, 0o600, 'atomicWrite file born 0600');
  writeJson(f, { a: 2 });
  assert.equal(statSync(f).mode & 0o777, 0o600, 'still 0600 after a rewrite');
});

test('boot into a fresh data dir creates it 0700 from the start', async () => {
  const dataDir = join(mkdtempSync(join(tmpdir(), 'wao-boot-perm2-')), 'nested-data');
  dirs.push(dirname(dataDir));
  await start(dataDir, [emptyPluginsDir()]);
  assert.equal(statSync(dataDir).mode & 0o777, 0o700, 'newly created data dir is 0700');
});

test('concurrent reloads serialize: each wave activates every plugin exactly once, none falsely failed', async () => {
  delete globalThis.__waoPcActivations;
  const dataDir = dataDirWith(null);
  const pluginsDir = emptyPluginsDir();
  // The route registration is the collision detector: overlapping four-phase
  // reloads interleave their teardown/activation halves on the shared
  // lifecycle, and the loser's register() throws "prefix already registered"
  // → a false `failed` entry. The counter detects double activation.
  writePlugin(
    join(pluginsDir, 'p-c'),
    "{ id: 'p-c', type: 'core', version: '1.0.0' }",
    "globalThis.__waoPcActivations = (globalThis.__waoPcActivations ?? 0) + 1;"
      + " ctx.http.register({ prefix: '/p-c', handler: (q, s) => s.end('hi') });",
  );
  const k = await start(dataDir, [pluginsDir]);
  const url = base(k);
  assert.equal(globalThis.__waoPcActivations, 1, 'boot activates once');
  const waves = await Promise.all([k.reload(), k.reload(), k.reload(), k.reload(), k.reload()]);
  for (const r of waves) {
    assert.deepEqual(r.failed, [], 'no wave may report the healthy plugin as failed');
    assert.deepEqual(r.active.map((a) => a.id), ['p-c']);
  }
  assert.equal(globalThis.__waoPcActivations, 6, 'boot + 5 waves, exactly one activation each');
  assert.deepEqual(k.lifecycle.debugState().active, ['p-c'], 'no double-activated leftovers');
  assert.equal(await (await fetch(url('/p-c'))).text(), 'hi');
});
