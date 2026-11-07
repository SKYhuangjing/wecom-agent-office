// WAO_TOKEN auth over the MCP gateway (P1): /mcp is a plugin route on the
// same HTTP shell, so the kernel-level gate covers it — an MCP client that
// configures no headers must see the plain 401 (not a JSON-RPC error frame),
// and one with the right header completes the initialize handshake normally.
// Same boot pattern as protocol.test.js: real kernel, mcp-gateway only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKernel } from '../../src/index.js';

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'mcp-gateway');
const TOKEN = 'wao-test-token-1';

let kernel = null;
let base = null;
let tmpRoot = null;
let dataDir = null;

before(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'wao-mcp-auth-plugins-'));
  cpSync(pluginDir, join(tmpRoot, 'mcp-gateway'), { recursive: true });
  dataDir = mkdtempSync(join(tmpdir(), 'wao-mcp-auth-data-'));
  kernel = await createKernel({ port: 0, dataDir, pluginsDirs: [tmpRoot], token: TOKEN });
  base = `http://127.0.0.1:${kernel.http.port}`;
});

after(async () => {
  await kernel.stop();
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

const initialize = (headers = {}) => fetch(`${base}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'auth-test', version: '0' } },
  }),
});

test('initialize without a token → 401 REST shape (the gate fires before JSON-RPC)', async () => {
  const res = await initialize();
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), {
    error: 'unauthorized: provide WAO_TOKEN via Authorization Bearer or X-WAO-Token header',
  });
});

test('initialize with a wrong token → 401; healthz still public', async () => {
  const wrong = await initialize({ 'x-wao-token': 'wrong-token' });
  assert.equal(wrong.status, 401);
  const healthz = await fetch(`${base}/healthz`);
  assert.equal(healthz.status, 200);
});

test('initialize with the right token → 200 handshake, session usable', async () => {
  const res = await initialize({ 'x-wao-token': TOKEN });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.error, undefined);
  assert.equal(body.result.serverInfo.name, 'wao-company');
  const sessionId = res.headers.get('mcp-session-id');
  assert.ok(sessionId, 'session header issued');
  // The admitted session carries on: tools/list with the same token works.
  const list = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wao-token': TOKEN, 'mcp-session-id': sessionId },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  });
  assert.equal(list.status, 200);
  assert.equal((await list.json()).result.tools.length > 0, true);
});
