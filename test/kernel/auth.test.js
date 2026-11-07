// WAO_TOKEN auth gate (P1, DESIGN §13 预留接口): with a token configured,
// every non-public path on the HTTP shell demands Authorization: Bearer <t>
// or X-WAO-Token: <t>; the health probes and the console's own static bundle
// stay public (launchd/doctor probe without credentials, the page must load
// before the SDK can collect a token). Runs against a REAL kernel boot — the
// contract under test is wire behavior, not handler internals.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKernel } from '../../src/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOKEN = 'wao-test-token-1';
const AUTH_ERROR = 'unauthorized: provide WAO_TOKEN via Authorization Bearer or X-WAO-Token header';

const kernels = [];
const dirs = [];
after(async () => {
  for (const k of kernels.reverse()) await k.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'wao-auth-'));
  dirs.push(d);
  return d;
};

// A page plugin (manifest ui dir) so /api/ui/* hosting exists to probe.
const writeUiPlugin = (root) => {
  const dir = join(root, 'p-page');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.js'),
    "export default { manifest: { id: 'p-page', type: 'ui', version: '1.0.0', ui: 'ui' }, activate() {} };");
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'ui'), { recursive: true });
  writeFileSync(join(dir, 'ui', 'index.js'), 'export default {};\n');
};

const start = async ({ token } = {}) => {
  const pluginsRoot = tmp();
  writeUiPlugin(pluginsRoot);
  const k = await createKernel({ port: 0, dataDir: tmp(), pluginsDirs: [pluginsRoot], token });
  kernels.push(k);
  return k;
};

test('token set: /api/state without a token → 401 with the exact error copy', async () => {
  const k = await start({ token: TOKEN });
  const res = await fetch(`http://127.0.0.1:${k.http.port}/api/state`);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: AUTH_ERROR });
});

test('token set: X-WAO-Token and Authorization Bearer both admit; wrong token 401', async () => {
  const k = await start({ token: TOKEN });
  const base = `http://127.0.0.1:${k.http.port}`;
  const viaHeader = await fetch(`${base}/api/state`, { headers: { 'x-wao-token': TOKEN } });
  assert.equal(viaHeader.status, 200);
  assert.equal((await viaHeader.json()).ok, true);

  const viaBearer = await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(viaBearer.status, 200);
  const lowerBearer = await fetch(`${base}/api/state`, { headers: { authorization: `bearer ${TOKEN}` } });
  assert.equal(lowerBearer.status, 200);

  for (const headers of [{ 'x-wao-token': 'wrong' }, { authorization: 'Bearer wrong' }, { authorization: 'Basic dXNlcjpwYXNz' }]) {
    const res = await fetch(`${base}/api/state`, { headers });
    assert.equal(res.status, 401, `wrong credential must 401: ${JSON.stringify(headers)}`);
    assert.deepEqual(await res.json(), { error: AUTH_ERROR });
  }
});

test('token set: healthz stays public and still answers ok:true', async () => {
  const k = await start({ token: TOKEN });
  const res = await fetch(`http://127.0.0.1:${k.http.port}/healthz`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.version, JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version);
  assert.equal(body.bots, undefined, 'no engine service → bots summary omitted, healthz never fails');
});

test('token set: console static bundle and page-plugin hosting stay public', async () => {
  const k = await start({ token: TOKEN });
  const base = `http://127.0.0.1:${k.http.port}`;
  // web/dist is a committed artifact: the shell serves it without a token.
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type') ?? '', /text\/html/);
  const asset = await fetch(`${base}/assets/app.js`);
  assert.equal(asset.status, 200);
  // /api/ui/<id>/index.js — page-plugin entry, loads before the SDK has a token.
  const uiEntry = await fetch(`${base}/api/ui/p-page/index.js`);
  assert.equal(uiEntry.status, 200);
  assert.equal(await (await fetch(`${base}/api/ui/p-page/nope.js`)).status, 404, 'public ≠ exists: misses still 404');
});

test('token set: SSE /api/events gated — 401 bare, admitted via header or ?wao_token=', async () => {
  const k = await start({ token: TOKEN });
  const base = `http://127.0.0.1:${k.http.port}`;

  const bare = await fetch(`${base}/api/events`);
  assert.equal(bare.status, 401);
  await bare.body?.cancel?.();

  // EventSource cannot set headers — the query fallback is its only road in.
  const viaQuery = await fetch(`${base}/api/events?wao_token=${encodeURIComponent(TOKEN)}`);
  assert.equal(viaQuery.status, 200);
  assert.match(viaQuery.headers.get('content-type') ?? '', /text\/event-stream/);
  await viaQuery.body?.cancel?.();

  const wrongQuery = await fetch(`${base}/api/events?wao_token=wrong`);
  assert.equal(wrongQuery.status, 401);
  await wrongQuery.body?.cancel?.();
});

test('token set: unknown paths answer 401 (not 404) — the gate outranks routing', async () => {
  const k = await start({ token: TOKEN });
  const res = await fetch(`http://127.0.0.1:${k.http.port}/api/definitely-not-a-route`);
  assert.equal(res.status, 401);
});

test('no token configured: everything stays as before (loopback no-auth)', async () => {
  const k = await start({});
  const base = `http://127.0.0.1:${k.http.port}`;
  assert.equal((await fetch(`${base}/api/state`)).status, 200);
  const sse = await fetch(`${base}/api/events`);
  assert.equal(sse.status, 200);
  await sse.body?.cancel?.();
});

test('empty-string token behaves as unset (auth off)', async () => {
  const k = await start({ token: '' });
  assert.equal((await fetch(`http://127.0.0.1:${k.http.port}/api/state`)).status, 200);
});
