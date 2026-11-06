// M3 Task 1 web infrastructure tests: kernel static serving (web/dist at
// GET / + /assets/*), page-plugin ui/ hosting (/api/ui/<id>/*), the
// uiPlugins manifest in /api/state, the SSE bus bridge (agent/* frames over
// /api/events), and a full fake-chain run proving core-engine's new
// agent/progress emissions reach a real SSE client. Built assets are
// committed (web/dist), so npm test needs no build step.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKernel } from '../../src/index.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const templateRoot = join(repoRoot, 'plugins', '_template');

// File-wide safety net (boot.test.js convention): stop every kernel before
// any tmpdir is removed, even when an assertion fails mid-test.
const kernels = [];
const dirs = [];
after(async () => {
  for (const k of kernels.reverse()) await k.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const start = async (pluginsDirs) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wao-web-data-'));
  dirs.push(dataDir);
  const k = await createKernel({ port: 0, dataDir, pluginsDirs: pluginsDirs ?? [templateRoot] });
  kernels.push(k);
  return k;
};

const get = async (kernel, path) => {
  const res = await fetch(`http://127.0.0.1:${kernel.http.port}${path}`);
  return { status: res.status, type: res.headers.get('content-type'), body: await res.text() };
};

// SSE client double: accumulate raw frames until pred(buffer) holds.
const connectSse = async (kernel) => {
  const res = await fetch(`http://127.0.0.1:${kernel.http.port}/api/events`);
  assert.equal(res.status, 200, 'SSE endpoint answers');
  const conn = { res, reader: res.body.getReader(), dec: new TextDecoder(), buf: '' };
  conn.readUntil = async (pred, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    while (!pred(conn.buf)) {
      const remaining = deadline - Date.now();
      assert.ok(remaining > 0, `timed out waiting for SSE data, got ${JSON.stringify(conn.buf)}`);
      const { done, value } = await Promise.race([
        conn.reader.read(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('SSE read timeout')), remaining)),
      ]);
      if (done) throw new Error(`SSE stream ended early, got ${JSON.stringify(conn.buf)}`);
      conn.buf += conn.dec.decode(value, { stream: true });
    }
    return conn.buf;
  };
  conn.close = () => conn.reader.cancel().catch(() => {});
  return conn;
};

// —— fake chain plugin (real core-engine, one tmp plugin providing both a
// provider runner that streams two progress events and a channel adapter
// whose inbound is triggered deterministically over POST /api/fake/fire) ———
const writeFakeChain = (root) => {
  const dir = join(root, 'fake-chain'); // a plugins ROOT holds plugin SUBDIRS
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.js'), `
export default {
  manifest: { id: 'fake-chain', name: 'Fake Chain', type: 'channel', version: '0.1.0', requires: { kernel: '^1' } },
  activate(ctx) {
    let currentBot = null;
    let currentEngine = null;
    ctx.registerProvider('fakep', {
      createRunner: () => ({
        async run({ onEvent }) {
          onEvent?.({ type: 'step', text: '🔧 step-1' });
          onEvent?.({ type: 'text', text: '中途文本' });
          return { ok: true, code: 'completed', finalText: 'final-text', aborted: false, sessionId: 'sess-1', reason: null, detail: null };
        },
      }),
    });
    ctx.registerChannel('fakec', {
      capabilities: { stream: true, push: false, group: false, welcome: false },
      createAdapter: ({ bot, engine }) => ({
        start() { currentBot = bot; currentEngine = engine; },
        stop() {},
        status: () => ({ state: 'online', lastError: null }),
        ack() {}, progress() {}, reply() {}, welcome() {}, push() {},
      }),
    });
    ctx.http.register({ prefix: '/api/fake/fire', handler: (req, res) => {
      // currentEngine is core-engine's per-bot channel facade: onMessage(msg)
      // already closes over the bot record.
      currentEngine.onMessage({ chatKey: 'chat-1', chatKind: 'single', userid: 'u1', text: 'hi', reqId: 'req-1', raw: 'chat-1' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    } });
  },
};`);
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
};

test('GET / serves the built shell (web/dist/index.html)', async () => {
  const k = await start();
  const r = await get(k, '/');
  assert.equal(r.status, 200);
  assert.match(r.type, /^text\/html/);
  assert.match(r.body, /id="root"/);
  assert.match(r.body, /\/vendor\/react(-dom)?\.umd\.js/);
  assert.match(r.body, /\/assets\/app\.js/);
});

test('GET /assets/app.js serves the bundled shell+sdk (text/javascript)', async () => {
  const k = await start();
  const r = await get(k, '/assets/app.js');
  assert.equal(r.status, 200);
  assert.match(r.type, /^text\/javascript/);
  assert.ok(r.body.includes('window.WAO'), 'bundle installs the window.WAO contract');
});

test('GET /vendor/* serves the committed React UMD files', async () => {
  const k = await start();
  for (const f of ['react.umd.js', 'react-dom.umd.js']) {
    const r = await get(k, `/vendor/${f}`);
    assert.equal(r.status, 200, f);
    assert.match(r.type, /^text\/javascript/);
  }
});

test('traversal out of /assets is rejected (404, never file bytes)', async () => {
  const k = await start();
  const secret = readFileSync(join(repoRoot, 'package.json'), 'utf8');
  for (const p of ['/assets/%2e%2e/%2e%2e/package.json', '/assets/..%2f..%2fpackage.json', '/assets/%2e%2e%2fsrc%2findex.js']) {
    const r = await get(k, p);
    assert.equal(r.status, 404, p);
    assert.ok(!r.body.includes(secret), `traversal leaked file content via ${p}`);
  }
});

test('/api/state lists uiPlugins with entries for manifest-declared ui dirs', async () => {
  const k = await start();
  const state = await (await fetch(`http://127.0.0.1:${k.http.port}/api/state`)).json();
  assert.deepEqual(state.uiPlugins, [
    { id: 'template-page', entry: '/api/ui/template-page/index.js' },
  ]);
});

test('/api/ui/<id>/* hosts the plugin ui/ dir; unknown ids and traversal 404', async () => {
  const k = await start();
  const page = await get(k, '/api/ui/template-page/index.js');
  assert.equal(page.status, 200);
  assert.match(page.type, /^text\/javascript/);
  assert.ok(page.body.includes('template-page'), 'serves the real page module');
  const harness = await get(k, '/api/ui/template-page/harness.html');
  assert.equal(harness.status, 200);
  assert.match(harness.type, /^text\/html/);
  assert.ok(harness.body.includes('wao-stub'), 'harness drives the page via the WAO stub');

  assert.equal((await get(k, '/api/ui/unknown-page/index.js')).status, 404);
  assert.equal((await get(k, '/api/ui/template-page/missing.js')).status, 404);
  // Encoded traversal: fetch would normalize literal ../ away client-side,
  // so the probes arrive percent-encoded and must be rejected server-side.
  for (const p of [
    '/api/ui/template-page/%2e%2e/plugin.js',
    '/api/ui/template-page/..%2fplugin.js',
    '/api/ui/template-page/%2e%2e%2f%2e%2e%2fpackage.json',
  ]) {
    const r = await get(k, p);
    assert.equal(r.status, 404, p);
    assert.ok(!r.body.includes('"type":"module"'), `traversal leaked plugin source via ${p}`);
  }
});

test('SSE bridge: whitelisted bus topics reach /api/events, others do not', async () => {
  const k = await start();
  const conn = await connectSse(k);
  try {
    k.events.emit('agent/progress', { botId: 'b1', line: '🔧 working', source: 'step' });
    await conn.readUntil((b) => b.includes('event: agent/progress'));
    assert.ok(conn.buf.includes('🔧 working'), 'payload rides the frame verbatim');
    const before = conn.buf;
    k.events.emit('bot/internal', { secret: 'x' });
    k.events.emit('agent/status', { botId: 'b1', status: 'idle' });
    await conn.readUntil((b) => b.includes('event: agent/status'));
    assert.ok(!conn.buf.slice(before.length).includes('bot/internal'), 'non-whitelisted topics stay off the wire');
  } finally { await conn.close(); }
});

test('full chain: fake provider run emits agent/progress that reaches the SSE client', async () => {
  const fakeDir = mkdtempSync(join(tmpdir(), 'wao-web-fake-'));
  dirs.push(fakeDir);
  writeFakeChain(fakeDir);
  const k = await start([fakeDir, templateRoot, join(repoRoot, 'plugins')]);
  const conn = await connectSse(k);
  try {
    const created = await fetch(`http://127.0.0.1:${k.http.port}/api/bots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'b1', name: 'B1', channel: 'fakec', provider: 'fakep', account: {}, providerConfig: { cwd: '/tmp' } }),
    });
    assert.equal(created.status, 200, await created.text());
    const fired = await fetch(`http://127.0.0.1:${k.http.port}/api/fake/fire`, { method: 'POST' });
    assert.equal(fired.status, 200);
    // agent/progress frames: setProgress emits on every line change — the
    // fake runner streams a step then a text event, and the progressor
    // composes the text one into a progress line (✍️ 已生成：…).
    await conn.readUntil((b) => b.includes('event: agent/progress') && b.includes('中途文本'));
    // Turn settles: working→idle status frame lands too.
    await conn.readUntil((b) => b.includes('event: agent/status') && b.includes('"idle"'), 5000);
    const agents = await (await fetch(`http://127.0.0.1:${k.http.port}/api/agents`)).json();
    assert.equal(agents.agents[0].status, 'idle');
    assert.equal(agents.agents[0].todayTurns, 1);
  } finally { await conn.close(); }
});
