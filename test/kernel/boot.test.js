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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../../src/index.js';

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
const base = (k) => (path) => `http://127.0.0.1:${k.http.port}${path}`;

test('boot: healthz 200, /api/state ok:true with empty plugin list', async () => {
  const k = await start(dataDirWith(null), [emptyPluginsDir()]);
  const url = base(k);
  assert.ok(Number.isInteger(k.http.port) && k.http.port > 0, 'port 0 binds an ephemeral port');
  const hz = await fetch(url('/healthz'));
  assert.equal(hz.status, 200);
  assert.equal((await hz.json()).ok, true);
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

test('plugins.json enabled:false filters the dir at boot and on reload; _template dirs are skipped', async () => {
  const dataDir = dataDirWith({ plugins: { 'p-x': { enabled: false } } });
  const pluginsDir = emptyPluginsDir();
  writePlugin(join(pluginsDir, 'p-x'), "{ id: 'p-x', type: 'core', version: '1.0.0' }");
  writePlugin(join(pluginsDir, '_template'), "{ id: 'tpl', type: 'core', version: '1.0.0' }");
  const k = await start(dataDir, [pluginsDir]);
  const url = base(k);
  assert.deepEqual((await (await fetch(url('/api/state'))).json()).plugins, []);

  // Re-enable through plugins.json → the four-phase reload (driven here via
  // the kernel-native HTTP route, not just the library call) picks it up.
  writeFileSync(join(dataDir, 'plugins.json'), JSON.stringify({ plugins: { 'p-x': { enabled: true } } }));
  assert.deepEqual(await (await fetch(url('/api/service/reload'), { method: 'POST' })).json(), { ok: true });
  const list = (await (await fetch(url('/api/plugins'))).json()).plugins;
  assert.deepEqual(list, [{ id: 'p-x', type: 'core', version: '1.0.0', status: 'active' }]);

  // Disable again → gone on the next reload (the enable table is re-read).
  writeFileSync(join(dataDir, 'plugins.json'), JSON.stringify({ plugins: { 'p-x': { enabled: false } } }));
  const r = await k.reload();
  assert.deepEqual(r, { active: [], failed: [] });
  assert.deepEqual((await (await fetch(url('/api/state'))).json()).plugins, []);
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
  await once(sock, 'connect');
  // Incomplete request (no blank line): the server keeps waiting for headers,
  // so the socket stays non-idle and an unbounded server.close() would hang.
  sock.write('GET /healthz HTTP/1.1\r\nHost: localhost\r\n');
  const began = Date.now();
  await assert.doesNotReject(k.stop({ closeTimeoutMs: 300 }));
  assert.ok(Date.now() - began < 4000, 'stop resolves via the bounded close, not by hanging');
  const closed = await Promise.race([
    once(sock, 'close').then(() => true),
    new Promise((r) => setTimeout(() => r(false), 1000)),
  ]);
  assert.equal(closed, true, 'the wedged connection is destroyed once the timeout fires');
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
