// MCP gateway protocol tests (W1 T1): the /mcp subset exercised against a
// REAL kernel boot — createKernel on an ephemeral port with a plugins root
// holding only mcp-gateway (template.test.js pattern: copy the plugin dir
// into a fresh tmp root so the boot scan sees exactly this plugin). Every
// case goes through real fetch/HTTP, because the contract under test IS the
// wire behavior: JSON-RPC errors over HTTP 200, session header round-trips,
// notification 202s, transport-level status codes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKernel } from '../../src/index.js';

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'mcp-gateway');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let kernel = null;
let base = null;
let tmpOuter = null;
let tmpRoot = null;
let dataDir = null;

before(async () => {
  // Nested layout: <outer>/plugins/mcp-gateway (the boot scan root) plus
  // <outer>/docs/skills/wao-company.md — the /api/mcp/skill route resolves
  // ../../docs/skills relative to the plugin dir, so the outer docs tree makes
  // its 200 path testable without touching the real repo checkout.
  tmpOuter = mkdtempSync(join(tmpdir(), 'wao-mcp-'));
  tmpRoot = join(tmpOuter, 'plugins');
  mkdirSync(tmpRoot);
  cpSync(pluginDir, join(tmpRoot, 'mcp-gateway'), { recursive: true });
  mkdirSync(join(tmpOuter, 'docs', 'skills'), { recursive: true });
  writeFileSync(join(tmpOuter, 'docs', 'skills', 'wao-company.md'), '# wao-company (protocol-test fixture)\n');
  dataDir = mkdtempSync(join(tmpdir(), 'wao-mcp-data-'));
  kernel = await createKernel({ port: 0, dataDir, pluginsDirs: [tmpRoot] });
  base = `http://127.0.0.1:${kernel.http.port}`;
});

after(async () => {
  await kernel.stop();
  rmSync(tmpOuter, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

// POST /mcp helper — fetch defaults to text/plain for string bodies, so the
// content type is always set explicitly (the endpoint 415s anything else).
const post = (body, headers = {}) => fetch(`${base}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

// A JSON-RPC request expected to answer with a parsable body.
const rpc = async (msg, headers) => {
  const res = await post(msg, headers);
  return { status: res.status, headers: res.headers, body: await res.json() };
};

// One initialize round-trip → { sessionId, body }.
const initialize = async (protocolVersion = '2025-06-18') => {
  const r = await rpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion, capabilities: {}, clientInfo: { name: 'protocol-test', version: '0.0.0' } },
  });
  return { status: r.status, sessionId: r.headers.get('mcp-session-id'), body: r.body };
};

test('plugin boots active through createKernel as a middleware plugin', async () => {
  const body = await (await fetch(`${base}/api/plugins`)).json();
  assert.deepEqual(body.plugins, [
    { id: 'mcp-gateway', name: 'MCP 网关', type: 'middleware', version: '0.1.0', status: 'active' },
  ]);
});

test('initialize handshake: result shape over HTTP 200, session header is a fresh uuid', async () => {
  const { status, sessionId, body } = await initialize();
  assert.equal(status, 200);
  assert.equal(body.jsonrpc, '2.0');
  assert.equal(body.id, 1);
  assert.deepEqual(body.result, {
    protocolVersion: '2025-06-18',
    capabilities: { tools: {} },
    serverInfo: { name: 'wao-company', version: '0.1.0' },
  });
  assert.match(sessionId, UUID_RE);
});

test('initialize version negotiation: unknown client version gets the server value back', async () => {
  const { body } = await initialize('2024-11-05');
  assert.equal(body.result.protocolVersion, '2025-06-18');
});

test('tools/list with session: full 19-tool roster shape + session header echoed', async () => {
  const { sessionId } = await initialize();
  const r = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-session-id': sessionId });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('mcp-session-id'), sessionId);
  const tools = r.body.result.tools;
  assert.ok(Array.isArray(tools) && tools.length === 19, `19 tools shipped (T2 13 + W3 asset 6), got ${tools?.length}`);
  for (const t of tools) {
    assert.equal(typeof t.name, 'string', 'tool name');
    assert.equal(typeof t.description, 'string', 'tool description');
    assert.equal(t.inputSchema.type, 'object', 'inputSchema is a JSON Schema object');
  }
});

test('session gating: request without session → -32002; unknown session id → -32002', async () => {
  const noSession = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.equal(noSession.status, 200); // protocol error, not a transport one
  assert.equal(noSession.body.id, 3);
  assert.equal(noSession.body.error.code, -32002);

  const unknown = await rpc(
    { jsonrpc: '2.0', id: 4, method: 'tools/list' },
    { 'mcp-session-id': '11111111-2222-4333-8444-555555555555' },
  );
  assert.equal(unknown.body.error.code, -32002);
});

test('unknown method → -32601; tools/call unknown tool → -32602 (T2 surface)', async () => {
  const { sessionId } = await initialize();
  const unknown = await rpc({ jsonrpc: '2.0', id: 5, method: 'resources/list' }, { 'mcp-session-id': sessionId });
  assert.equal(unknown.body.error.code, -32601);
  assert.equal(unknown.body.id, 5);

  // Unknown tool name is a PARAMS-level protocol error: -32602, not -32601.
  const badTool = await rpc(
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } },
    { 'mcp-session-id': sessionId },
  );
  assert.equal(badTool.body.error.code, -32602);
  assert.equal(badTool.body.id, 6);

  // A KNOWN tool still answers as a result even when the engine behind it is
  // absent (this boot loads only mcp-gateway): isError result, HTTP 200.
  const noEngine = await rpc(
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'list_employees', arguments: {} } },
    { 'mcp-session-id': sessionId },
  );
  assert.equal(noEngine.body.error, undefined, 'business failure stays inside the result');
  assert.equal(noEngine.body.result.isError, true);
  assert.match(noEngine.body.result.content[0].text, /不可用/);
});

test('protocol errors ride HTTP 200: bad JSON -32700, shape violations -32600', async () => {
  const { sessionId } = await initialize();
  const h = { 'mcp-session-id': sessionId };

  const badJson = await rpc('{oops', h);
  assert.equal(badJson.status, 200);
  assert.equal(badJson.body.id, null);
  assert.equal(badJson.body.error.code, -32700);

  const notAnObject = await rpc('"hello"', h);
  assert.equal(notAnObject.body.error.code, -32600);

  const wrongVersion = await rpc({ jsonrpc: '1.0', id: 7, method: 'tools/list' }, h);
  assert.equal(wrongVersion.body.error.code, -32600);

  const emptyBatch = await rpc([], h);
  assert.equal(emptyBatch.body.error.code, -32600);

  // Batching was removed from MCP: an array carrying a REQUEST (id present)
  // is refused even though a pure notification batch is accepted below.
  const batchedRequest = await rpc([
    { jsonrpc: '2.0', id: 8, method: 'tools/list' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
  ], h);
  assert.equal(batchedRequest.body.error.code, -32600);

  // Dirty-input battery: empty body is not valid JSON (-32700, not an empty
  // object); params must be structured; id must be a scalar.
  const emptyBody = await post('', h);
  assert.equal(emptyBody.status, 200);
  assert.equal((await emptyBody.json()).error.code, -32700);

  const badParams = await rpc({ jsonrpc: '2.0', id: 12, method: 'tools/list', params: 'just-a-string' }, h);
  assert.equal(badParams.body.error.code, -32600);

  const badId = await rpc({ jsonrpc: '2.0', id: { nested: true }, method: 'tools/list' }, h);
  assert.equal(badId.body.error.code, -32600);

  // Oversized body is a TRANSPORT error: HTTP 413, not a JSON-RPC object.
  const huge = await post(`{"jsonrpc":"2.0","id":13,"method":"tools/list","pad":"${'x'.repeat(256 * 1024)}"}`, h);
  assert.equal(huge.status, 413);
});

test('notifications: single, batched and session-less all answer 202 with an empty body', async () => {
  const { sessionId } = await initialize();
  const h = { 'mcp-session-id': sessionId };

  const single = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, h);
  assert.equal(single.status, 202);
  assert.equal(await single.text(), '');

  const batch = await post([
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } },
  ], h);
  assert.equal(batch.status, 202);
  assert.equal(await batch.text(), '');

  // A notification can never receive a JSON-RPC error, so session gating
  // does not apply to it — 202 is the whole contract.
  const noSession = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(noSession.status, 202);
});

test('GET /mcp → 405 explanation + Allow; DELETE /mcp → 202 idempotent, session then terminated', async () => {
  const get = await fetch(`${base}/mcp`);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST, DELETE');
  const getBody = await get.json();
  assert.equal(getBody.error, 'method not allowed');
  assert.ok(getBody.message.includes('POST /mcp'), 'explanation points clients at POST');

  const { sessionId } = await initialize();
  const del1 = await fetch(`${base}/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': sessionId } });
  assert.equal(del1.status, 202);
  const del2 = await fetch(`${base}/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': sessionId } });
  assert.equal(del2.status, 202); // idempotent: unknown id stays 202
  const delNoHeader = await fetch(`${base}/mcp`, { method: 'DELETE' });
  assert.equal(delNoHeader.status, 202);

  // The terminated id no longer gates requests through.
  const after = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/list' }, { 'mcp-session-id': sessionId });
  assert.equal(after.body.error.code, -32002);
});

test('transport guards: non-JSON content type → 415; prefix bleed /mcpfoo → 404', async () => {
  const wrongType = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: '{"jsonrpc":"2.0"}',
  });
  assert.equal(wrongType.status, 415);
  assert.equal((await wrongType.json()).error.includes('application/json'), true);

  // The shell matches prefixes by startsWith, so /mcpfoo routes INTO this
  // plugin — the handler must answer the kernel 404 shape, not 405/415.
  const bleed = await fetch(`${base}/mcpfoo`);
  assert.equal(bleed.status, 404);
  const sub = await fetch(`${base}/mcp/extra`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(sub.status, 404);
});

test('two concurrent sessions stay isolated: distinct ids, each echoes its own', async () => {
  const a = await initialize();
  const b = await initialize();
  assert.notEqual(a.sessionId, b.sessionId);
  assert.match(a.sessionId, UUID_RE);
  assert.match(b.sessionId, UUID_RE);

  const viaA = await rpc({ jsonrpc: '2.0', id: 10, method: 'tools/list' }, { 'mcp-session-id': a.sessionId });
  assert.equal(viaA.headers.get('mcp-session-id'), a.sessionId);
  assert.equal(viaA.body.result.tools.length, 19);

  const viaB = await rpc({ jsonrpc: '2.0', id: 11, method: 'tools/list' }, { 'mcp-session-id': b.sessionId });
  assert.equal(viaB.headers.get('mcp-session-id'), b.sessionId);
  assert.equal(viaB.body.id, 11);
});

// —— v2 AI-access discovery：/api/mcp 控制台状态面 ——————————————————————————

test('GET /api/mcp: tool roster with dangerous flags, session count tracks live sessions', async () => {
  // Earlier tests in this file minted sessions they never DELETE, so the
  // count is only asserted RELATIVELY (before → +2 → −1).
  const before = (await (await fetch(`${base}/api/mcp`)).json()).sessions;
  const boot = await (await fetch(`${base}/api/mcp`)).json();
  assert.equal(boot.ok, true);
  assert.equal(boot.endpoint, '/mcp');
  assert.equal(typeof before, 'number');
  assert.equal(boot.tools.length, 19);
  const byName = new Map(boot.tools.map((t) => [t.name, t]));
  assert.equal(byName.get('list_employees').dangerous, false);
  assert.equal(byName.get('set_duty').dangerous, false);
  assert.equal(byName.get('offboard').dangerous, true);
  assert.equal(byName.get('broadcast').dangerous, true);
  assert.equal(byName.get('rematerialize').dangerous, true);
  assert.ok(byName.get('hire').description.length > 0, 'description carried for the UI list');

  const a = await initialize();
  const b = await initialize();
  const two = await (await fetch(`${base}/api/mcp`)).json();
  assert.equal(two.sessions, before + 2, 'initialize mints sessions the status face can count');

  await fetch(`${base}/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': a.sessionId } });
  const one = await (await fetch(`${base}/api/mcp`)).json();
  assert.equal(one.sessions, before + 1, 'DELETE decrements the count');
  await fetch(`${base}/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': b.sessionId } });
});

test('GET /api/mcp/skill: serves the repo skill doc as JSON {filename, content}', async () => {
  const res = await fetch(`${base}/api/mcp/skill`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.filename, 'wao-company.md');
  assert.ok(body.content.includes('wao-company'), 'content is the docs/skills markdown');
});

test('/api/mcp surface guards: wrong method 405, unknown subpath 404', async () => {
  const post = await fetch(`${base}/api/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET');
  const bleed = await fetch(`${base}/api/mcpfoo`);
  assert.equal(bleed.status, 404, 'prefix bleed stays a plain 404');
  const sub = await fetch(`${base}/api/mcp/nope`);
  assert.equal(sub.status, 404);
});
