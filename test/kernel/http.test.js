// Kernel service container + HTTP shell tests (spec §2.1/§8).
// Real sockets throughout: the contract under test is real HTTP behavior
// (500 isolation, SSE framing over the wire, socket teardown), so integration
// tests boot an ephemeral node:http server wrapping shell.handle — exactly the
// wiring the real entrypoint will use, proving handle works standalone.
// The dead-client/heartbeat internals are driven directly with a fake res,
// the only deterministic way to reach those windows without races.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { createServices } from '../../src/kernel/services.js';
import { createHttpShell } from '../../src/kernel/http.js';

// Collecting fake logger: tests assert error attribution without touching stderr.
const fakeLog = () => { const errors = []; return { errors, log: { info(){}, warn(){}, error: (...a) => errors.push(a) } }; };

// Boots shell + real server on an ephemeral port. Teardown uses
// closeAllConnections: undici's fetch agent parks sockets that cancelled a
// stream mid-response as non-idle, and only the sledgehammer reaps them
// before its 4s keep-alive timeout (a test concern, not kernel behavior).
async function boot() {
  const { errors, log } = fakeLog();
  const shell = createHttpShell({ log });
  const server = createServer(shell.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { shell, base, errors, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

const getJson = async (base, path, init) => {
  const res = await fetch(base + path, init);
  return { status: res.status, headers: res.headers, body: await res.json() };
};

const jsonHandler = (obj) => (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};

const waitUntil = async (pred, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const connectSse = async (base) => {
  const res = await fetch(base + '/api/events');
  return { res, reader: res.body.getReader(), dec: new TextDecoder() };
};

// Accumulates decoded chunks until pred(buf) holds; fails the test on stall or early end.
const readUntil = async (conn, pred, timeoutMs = 2000) => {
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  while (!pred(buf)) {
    const remaining = deadline - Date.now();
    assert.ok(remaining > 0, `timed out waiting for SSE data, got ${JSON.stringify(buf)}`);
    const { done, value } = await Promise.race([
      conn.reader.read(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('SSE read timeout')), remaining)),
    ]);
    if (done) throw new Error(`SSE stream ended early, got ${JSON.stringify(buf)}`);
    buf += conn.dec.decode(value, { stream: true });
  }
  return buf;
};

// Minimal SSE response double for the no-server unit tests below.
const fakeSseRes = () => {
  const res = new EventEmitter();
  res.written = [];
  res.writeHead = () => {};
  res.flushHeaders = () => {};
  res.write = (c) => { if (res.failWrites) throw new Error('write after end'); res.written.push(String(c)); return true; };
  res.end = () => {};
  res.destroy = () => {};
  return res;
};

test('services: get on unknown name → undefined; re-register overwrites silently', () => {
  const svc = createServices();
  const a = { tag: 'a' }, b = { tag: 'b' };
  assert.equal(svc.get('missing'), undefined);
  svc.register('db', a);
  assert.equal(svc.get('db'), a);
  svc.register('db', b); // overwrite is the contract: callers own replacement semantics
  assert.equal(svc.get('db'), b);
});

test('routes by prefix; handler sees raw req/res (method passthrough)', async () => {
  const t = await boot();
  try {
    t.shell.register({ prefix: '/api/x', owner: 'p1', handler: (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: 'x', method: req.method }));
    }});
    assert.deepEqual((await getJson(t.base, '/api/x')).body, { path: 'x', method: 'GET' });
    const post = await getJson(t.base, '/api/x', { method: 'POST' });
    assert.deepEqual(post.body, { path: 'x', method: 'POST' });
  } finally { await t.close(); }
});

test('throwing handler → 500 {error}, owner attributed in log, other routes unaffected', async () => {
  const t = await boot();
  try {
    t.shell.register({ prefix: '/api/boom', owner: 'plugin-boom', handler: () => { throw new Error('boom'); } });
    t.shell.register({ prefix: '/api/ok', owner: 'plugin-ok', handler: jsonHandler({ ok: 1 }) });
    const r = await getJson(t.base, '/api/boom');
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { error: 'boom' });
    assert.equal(t.errors.length, 1);
    assert.match(String(t.errors[0]), /plugin-boom/);
    assert.match(String(t.errors[0]), /boom/);
    const ok = await getJson(t.base, '/api/ok'); // failure stayed inside its own route
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { ok: 1 });
  } finally { await t.close(); }
});

test('throw after headers sent → socket destroyed, no double-respond, still attributed', async () => {
  const t = await boot();
  try {
    t.shell.register({ prefix: '/api/stream', owner: 'late-boomer', handler: (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('partial'); // flips headersSent: the wrapper must take the destroy branch, not the 500 one
      throw new Error('late boom');
    }});
    t.shell.register({ prefix: '/api/ok', owner: 'plugin-ok', handler: jsonHandler({ ok: 1 }) });
    // destroy() runs before the socket flushes, so the client never sees a response
    // at all — a killed connection, and crucially never a 500 stacked on a 200.
    await assert.rejects(fetch(t.base + '/api/stream'));
    assert.equal(t.errors.length, 1);
    assert.match(String(t.errors[0]), /late-boomer/);
    assert.match(String(t.errors[0]), /late boom/);
    const ok = await getJson(t.base, '/api/ok'); // the killed socket poisoned nothing
    assert.equal(ok.status, 200);
  } finally { await t.close(); }
});

test('async handler rejecting before headers → 500 {error}, owner attributed, no crash', { timeout: 5000 }, async () => {
  const t = await boot();
  try {
    t.shell.register({ prefix: '/api/async', owner: 'plugin-async', handler: async () => {
      await new Promise((r) => setTimeout(r, 10));
      throw new Error('async boom');
    }});
    const r = await getJson(t.base, '/api/async');
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { error: 'async boom' });
    assert.equal(t.errors.length, 1);
    assert.match(String(t.errors[0]), /plugin-async/);
    assert.match(String(t.errors[0]), /async boom/);
  } finally { await t.close(); }
});

test('async handler rejecting after a full response → response intact, log-only, no double-write', { timeout: 5000 }, async () => {
  const t = await boot();
  try {
    t.shell.register({ prefix: '/api/done-then-fail', owner: 'plugin-late', handler: async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ done: true }));
      await new Promise((r) => setTimeout(r, 10));
      throw new Error('post-response boom');
    }});
    const r = await getJson(t.base, '/api/done-then-fail'); // client still got the real 200 body
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { done: true });
    await waitUntil(() => t.errors.length === 1); // rejection lands on a later tick: wait for the log
    assert.match(String(t.errors[0]), /plugin-late/);
    assert.match(String(t.errors[0]), /post-response boom/);
  } finally { await t.close(); }
});

test('register: duplicate prefix throws; prefix must start with "/"; kernel routes reserved', () => {
  const { log } = fakeLog();
  const shell = createHttpShell({ log });
  shell.register({ prefix: '/api', handler: jsonHandler({}), owner: 'p1' });
  assert.throws(() => shell.register({ prefix: '/api', handler: jsonHandler({}), owner: 'p2' }), /already registered/);
  assert.throws(() => shell.register({ prefix: 'api', handler: jsonHandler({}), owner: 'p2' }), /must start with/);
  assert.throws(() => shell.register({ prefix: '/healthz', handler: jsonHandler({}), owner: 'p2' }), /reserved/);
  assert.throws(() => shell.register({ prefix: '/api/events', handler: jsonHandler({}), owner: 'p2' }), /reserved/);
});

test('unregister(prefix): route 404s afterwards, other routes unaffected, unknown prefix is a no-op', async () => {
  const t = await boot();
  try {
    t.shell.register({ prefix: '/api/gone', owner: 'p1', handler: jsonHandler({ gone: 1 }) });
    t.shell.register({ prefix: '/api/keep', owner: 'p2', handler: jsonHandler({ keep: 1 }) });
    assert.equal((await getJson(t.base, '/api/gone')).status, 200);
    t.shell.unregister('/api/gone'); // lifecycle deactivation revokes the plugin's route
    assert.deepEqual((await getJson(t.base, '/api/gone')).body, { error: 'not found' });
    assert.equal((await getJson(t.base, '/api/keep')).status, 200); // neighbors untouched
    assert.doesNotThrow(() => t.shell.unregister('/never-registered')); // teardown must be idempotent
    // the prefix is free again: a re-activated plugin may reclaim it
    t.shell.register({ prefix: '/api/gone', owner: 'p3', handler: jsonHandler({ back: 1 }) });
    assert.deepEqual((await getJson(t.base, '/api/gone')).body, { back: 1 });
  } finally { await t.close(); }
});

test('longest registered prefix wins at dispatch', async () => {
  const t = await boot();
  try {
    t.shell.register({ prefix: '/api', owner: 'general', handler: jsonHandler({ who: 'api' }) });
    t.shell.register({ prefix: '/api/dsh', owner: 'dsh', handler: jsonHandler({ who: 'dsh' }) });
    assert.equal((await getJson(t.base, '/api/dsh')).body.who, 'dsh');
    assert.equal((await getJson(t.base, '/api/other')).body.who, 'api');
  } finally { await t.close(); }
});

test('GET /healthz → 200 {ok,pid,uptimeSec}', async () => {
  const t = await boot();
  try {
    const r = await getJson(t.base, '/healthz');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.pid, process.pid);
    assert.ok(Number.isFinite(r.body.uptimeSec) && r.body.uptimeSec >= 0);
  } finally { await t.close(); }
});

test('unmatched path → 404 {error:"not found"}', async () => {
  const t = await boot();
  try {
    const r = await getJson(t.base, '/nowhere');
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: 'not found' });
  } finally { await t.close(); }
});

test('non-GET on /api/events → 405', async () => {
  const t = await boot();
  try {
    const r = await getJson(t.base, '/api/events', { method: 'POST' });
    assert.equal(r.status, 405);
  } finally { await t.close(); }
});

test('SSE: two connected clients both receive the sseSend frame over the wire', async () => {
  const t = await boot();
  try {
    const c1 = await connectSse(t.base);
    assert.equal(c1.res.headers.get('content-type'), 'text/event-stream');
    assert.equal(c1.res.headers.get('cache-control'), 'no-cache');
    const c2 = await connectSse(t.base);
    await waitUntil(() => t.shell.sseClients() === 2);
    t.shell.sseSend('agent/progress', { step: 1, text: 'thinking' });
    const expect = 'event: agent/progress\ndata: {"step":1,"text":"thinking"}\n\n';
    assert.equal(await readUntil(c1, (b) => b.includes('\n\n')), expect);
    assert.equal(await readUntil(c2, (b) => b.includes('\n\n')), expect);
    await c1.reader.cancel();
    await c2.reader.cancel();
    await waitUntil(() => t.shell.sseClients() === 0);
  } finally { await t.close(); }
});

test('SSE: disconnected client is dropped; survivors keep receiving', async () => {
  const t = await boot();
  try {
    const c1 = await connectSse(t.base);
    const c2 = await connectSse(t.base);
    await waitUntil(() => t.shell.sseClients() === 2);
    await c1.reader.cancel(); // client 1 goes away without a goodbye
    await waitUntil(() => t.shell.sseClients() === 1);
    t.shell.sseSend('agent/done', { ok: true });
    assert.ok((await readUntil(c2, (b) => b.includes('event: agent/done'))).includes('data: {"ok":true}'));
    await c2.reader.cancel();
  } finally { await t.close(); }
});

test('SSE: sseSend tolerates a client whose write throws and drops it (write-after-finish)', () => {
  const { log } = fakeLog();
  const shell = createHttpShell({ log });
  const res = fakeSseRes();
  shell.handle({ method: 'GET', url: '/api/events' }, res);
  assert.equal(shell.sseClients(), 1);
  shell.sseSend('t/1', { n: 1 });
  assert.ok(res.written.includes('event: t/1\ndata: {"n":1}\n\n'));
  res.failWrites = true; // the socket dies under us from here on
  assert.doesNotThrow(() => shell.sseSend('t/2', { n: 2 }));
  assert.equal(shell.sseClients(), 0); // dropped, not remembered as a live client
  res.emit('close'); // release the heartbeat interval
});

test('SSE: heartbeat writes ": ka" comment every 15s', (t) => {
  const { log } = fakeLog();
  const shell = createHttpShell({ log });
  const res = fakeSseRes();
  t.mock.timers.enable({ apis: ['setInterval'] }); // 15s of wall time is not a test budget
  shell.handle({ method: 'GET', url: '/api/events' }, res);
  t.mock.timers.tick(15_000);
  assert.deepEqual(res.written, [': ka\n\n']);
  t.mock.timers.tick(15_000);
  assert.deepEqual(res.written, [': ka\n\n', ': ka\n\n']);
  res.emit('close'); // clears the interval
});

test('listen(0) binds an ephemeral port; close() ends SSE and shuts down', async () => {
  const { log } = fakeLog();
  const shell = createHttpShell({ log });
  await shell.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${shell.port}`;
  assert.ok(Number.isInteger(shell.port) && shell.port > 0);
  assert.equal((await getJson(base, '/healthz')).status, 200);
  const c = await connectSse(base);
  await waitUntil(() => shell.sseClients() === 1);
  await shell.close(); // must not hang on the open SSE stream
  const next = await Promise.race([
    c.reader.read(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('SSE stream not closed')), 2000)),
  ]);
  assert.equal(next.done, true);
  await assert.rejects(fetch(base + '/healthz')); // port is really gone
});
