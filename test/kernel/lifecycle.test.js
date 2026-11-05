// Kernel lifecycle tests (spec §2.1/§2.5): PluginContext brokering, teardown
// completeness (effects LIFO / timers / event subscriptions / port entries /
// http routes), afterAllActivated isolation, and four-phase reload order.
// Mock timers drive interval semantics deterministically — "fired after
// deactivate or not" is the whole contract under test, and wall-clock waiting
// cannot prove a negative. HTTP routing outcomes (200 vs 404) are driven
// through shell.handle with fake req/res: real-socket behavior is http.test.js
// territory; here a route only needs to answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createEventBus } from '../../src/kernel/events.js';
import { createServices } from '../../src/kernel/services.js';
import { createHttpShell } from '../../src/kernel/http.js';
import { createLifecycle, createPortRegistry } from '../../src/kernel/lifecycle.js';

// Collecting fake logger with child() mirroring the real one: child calls carry
// a "[prefix]" first arg, so attribution is assertable without touching stderr.
const fakeLog = () => {
  const errors = []; const warns = [];
  const make = (prefix) => ({
    debug() {}, info() {},
    warn: (...a) => warns.push(prefix ? [`[${prefix}]`, ...a] : a),
    error: (...a) => errors.push(prefix ? [`[${prefix}]`, ...a] : a),
    child: make,
  });
  return { errors, warns, log: make(null) };
};

const setup = () => {
  const { errors, warns, log } = fakeLog();
  const events = createEventBus({ log });
  const services = createServices();
  const http = createHttpShell({ log });
  const portRegistry = createPortRegistry();
  const lifecycle = createLifecycle({ events, services, log, http, portRegistry });
  return { errors, warns, log, events, services, http, portRegistry, lifecycle };
};

// Minimal plugin double shaped like a loader record: { dir, manifest, mod, status }.
const plugin = (id, activate, config = {}) => ({
  dir: `/plugins/${id}`, manifest: { id, type: 'core' }, status: 'enabled', config,
  mod: { activate },
});

const fakeRes = () => {
  const res = { status: 0, body: '' };
  res.writeHead = (code) => { res.status = code; };
  res.end = (b) => { res.body = String(b ?? ''); };
  return res;
};
const dispatch = (http, path) => {
  const res = fakeRes();
  http.handle({ method: 'GET', url: path }, res);
  return res;
};

test('ctx surface: id, child log attribution, config (defaults to {}), services pass-through, ws re-export', async () => {
  const s = setup();
  let ctx = null;
  await s.lifecycle.activate(plugin('p1', async (c) => { ctx = c; }, { k: 1 }));
  assert.equal(ctx.id, 'p1');
  assert.deepEqual(ctx.config, { k: 1 });
  assert.equal(ctx.services, s.services);
  assert.equal(ctx.ws.WebSocket, WebSocket); // kernel-provided infra, not a plugin dependency
  ctx.log.error('marker');
  assert.match(String(s.errors.at(-1)), /\[p1\]/);
  let bare = null;
  await s.lifecycle.activate({ dir: '/plugins/p2', manifest: { id: 'p2' }, status: 'enabled', mod: { activate: (c) => { bare = c; } } });
  assert.deepEqual(bare.config, {});
});

test('ctx.events delegates to the bus; manual off works; deactivate removes the subscription', async () => {
  const s = setup();
  const got = [];
  let ctx = null; let manualOff = null;
  const p1 = plugin('p1', (c) => {
    ctx = c;
    c.events.on('t', (p) => got.push(`p1:${p}`));
    manualOff = c.events.on('t', () => got.push('never'));
  });
  await s.lifecycle.activate(p1);
  manualOff(); // manual unsubscribe before any emit
  s.events.emit('t', 1); // ctx.on landed on the shared bus, owned by p1
  ctx.events.emit('t', 2); // ctx.emit delegates to the same bus
  assert.deepEqual(got, ['p1:1', 'p1:2']); // the manually-removed handler never fired
  await s.lifecycle.deactivate(p1);
  s.events.emit('t', 3);
  assert.deepEqual(got, ['p1:1', 'p1:2']); // deactivate revoked the subscription
});

test('ctx.http.register mounts with owner=id; deactivate unmounts; duplicate prefix propagates out of activate', async () => {
  const s = setup();
  const handler = (req, res) => { res.writeHead(200); res.end('{"who":"p1"}'); };
  const p1 = plugin('p1', (c) => c.http.register({ prefix: '/api/p1', handler }));
  await s.lifecycle.activate(p1);
  const hit = dispatch(s.http, '/api/p1/x');
  assert.equal(hit.status, 200);
  assert.equal(hit.body, '{"who":"p1"}');
  await s.lifecycle.deactivate(p1);
  assert.equal(dispatch(s.http, '/api/p1/x').status, 404); // route revoked, not merely forgotten by the plugin
  assert.equal(p1.status, 'disabled');
  // The shell's duplicate-prefix throw must surface through activate: the
  // loader (T6) catches it and marks the plugin error — lifecycle does not swallow it.
  const a = plugin('a', (c) => c.http.register({ prefix: '/api/dup', handler }));
  const b = plugin('b', (c) => c.http.register({ prefix: '/api/dup', handler }));
  await s.lifecycle.activate(a);
  await assert.rejects(() => s.lifecycle.activate(b), /already registered/);
  await s.lifecycle.deactivateAll(); // partially-activated b is still teardown-able
  assert.deepEqual(s.lifecycle.debugState().active, []);
  assert.equal(dispatch(s.http, '/api/dup').status, 404); // a's route went with it
});

test('deactivate clears tracked timers (interval really stops) and runs effects LIFO', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] }); // clears are mocked with their setters
  const s = setup();
  const seq = [];
  const p1 = plugin('p1', (c) => {
    c.effect(() => seq.push('e1'));
    c.effect(() => seq.push('e2'));
    c.setInterval(() => seq.push('tick'), 1000);
  });
  await s.lifecycle.activate(p1);
  assert.deepEqual(s.lifecycle.debugState(), { active: ['p1'], timers: { p1: 1 } });
  t.mock.timers.tick(1000);
  assert.deepEqual(seq, ['tick']); // effects have not run yet; the interval fires
  await s.lifecycle.deactivate(p1);
  t.mock.timers.tick(5000); // proves the interval was cleared, not just untracked
  assert.deepEqual(seq, ['tick', 'e2', 'e1']); // LIFO effects, zero further ticks
  assert.deepEqual(s.lifecycle.debugState(), { active: [], timers: {} });
});

test('ctx.setTimeout is tracked; ctx.clearTimeout untracks; debugState counts live timers', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] }); // clears are mocked with their setters
  const s = setup();
  const fired = [];
  const p1 = plugin('p1', (c) => {
    c.setTimeout(() => fired.push('a'), 500);
    const h = c.setTimeout(() => fired.push('b'), 500);
    c.clearTimeout(h); // manual clear must also drop it from the tracked set
  });
  await s.lifecycle.activate(p1);
  assert.deepEqual(s.lifecycle.debugState().timers, { p1: 1 });
  t.mock.timers.tick(1000);
  assert.deepEqual(fired, ['a']);
});

test('ctx.setInterval callback throw → attributed error, interval keeps firing', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] }); // clears are mocked with their setters
  const s = setup();
  let ticks = 0;
  const p1 = plugin('p1', (c) => c.setInterval(() => { ticks += 1; throw new Error('tick boom'); }, 100));
  await s.lifecycle.activate(p1);
  t.mock.timers.tick(100);
  t.mock.timers.tick(100);
  assert.equal(ticks, 2); // the throw must not silently kill the timer
  assert.equal(s.errors.length, 2);
  assert.match(String(s.errors[0]), /\[p1\]/);
  assert.match(String(s.errors[0]), /tick boom/);
  await s.lifecycle.deactivate(p1);
  assert.deepEqual(s.lifecycle.debugState().timers, {});
});

test('ctx.setInterval async rejecting callback → attributed error, no unhandled rejection, interval continues', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] }); // clears are mocked with their setters
  const s = setup();
  let ticks = 0;
  const p1 = plugin('p1', (c) => c.setInterval(async () => { ticks += 1; throw new Error('async tick boom'); }, 100));
  await s.lifecycle.activate(p1);
  t.mock.timers.tick(100); // the rejection lands on a later tick, outside the sync guard
  await new Promise((r) => setImmediate(r)); // drain microtasks: setImmediate is not mocked
  assert.equal(ticks, 1);
  assert.equal(s.errors.length, 1); // caught+attributed, not an unhandled rejection (which would fail this test process)
  assert.match(String(s.errors[0]), /\[p1\]/);
  assert.match(String(s.errors[0]), /async tick boom/);
  t.mock.timers.tick(100); // the interval must keep firing after the rejection
  await new Promise((r) => setImmediate(r));
  assert.equal(ticks, 2);
  assert.equal(s.errors.length, 2);
  await s.lifecycle.deactivate(p1);
  assert.deepEqual(s.lifecycle.debugState().timers, {});
});

test('port registration: visible with owner; re-register overwrites + warns; deactivate removes owned entries', async () => {
  const s = setup();
  const implA = { tag: 'a' }; const implB = { tag: 'b' };
  const p1 = plugin('p1', (c) => {
    c.registerProvider('x', implA);
    c.registerProvider('y', implA); // stays p1-owned throughout
    c.registerChannel('ch', { capabilities: { media: true } });
    c.registerPage({ id: 'pg1', title: 'Pg', order: 1 });
    c.registerMiddleware({ onInbound: null });
    c.registerProgressor({ compose: null });
  });
  const p2 = plugin('p2', (c) => {
    c.registerProvider('x', implB); // same port id, different owner
    c.registerMiddleware({ onInbound: null });
  });
  await s.lifecycle.activate(p1);
  await s.lifecycle.activate(p2);
  assert.equal(s.portRegistry.getProvider('x'), implB); // last write wins
  assert.deepEqual(s.portRegistry.provider.get('x'), { impl: implB, owner: 'p2' });
  assert.match(String(s.warns[0]), /port provider x re-registered by p2/);
  assert.equal(s.portRegistry.middleware.length, 2);
  await s.lifecycle.deactivate(p2); // only p2's entries go
  // 'x' is gone entirely: overwrite is last-write-wins, teardown removes the
  // live entry — it does not resurrect the registration p2 had shadowed.
  assert.equal(s.portRegistry.getProvider('x'), undefined);
  assert.equal(s.portRegistry.provider.size, 1);
  assert.equal(s.portRegistry.getProvider('y'), implA); // untouched neighbor survives
  assert.equal(s.portRegistry.middleware.length, 1);
  assert.equal(s.portRegistry.getChannel('ch').capabilities.media, true);
  assert.equal(s.portRegistry.page.size, 1);
  await s.lifecycle.deactivate(p1);
  assert.equal(s.portRegistry.provider.size, 0);
  assert.equal(s.portRegistry.channel.size, 0);
  assert.equal(s.portRegistry.page.size, 0);
  assert.equal(s.portRegistry.middleware.length, 0);
  assert.equal(s.portRegistry.progressor.length, 0);
  // Garbage ids fail at registration — activate rejects, loader marks error.
  await assert.rejects(() => s.lifecycle.activate(plugin('bad', (c) => c.registerProvider('', {}))), /requires a string id/);
  await assert.rejects(() => s.lifecycle.activate(plugin('bad2', (c) => c.registerPage({ title: 'no id' }))), /requires a string id/);
});

test('activate skips records without manifest.id or mod.activate; deactivate of unknown plugin is a no-op', async () => {
  const s = setup();
  await s.lifecycle.activate({ dir: '/x', manifest: {}, mod: { activate() {} }, status: 'enabled' }); // no id
  await s.lifecycle.activate({ dir: '/x', manifest: { id: 'y' }, mod: {}, status: 'enabled' }); // no activate fn
  await s.lifecycle.activate(null);
  assert.deepEqual(s.lifecycle.debugState().active, []);
  await s.lifecycle.deactivate({ manifest: { id: 'ghost' } }); // never activated: still a safe no-op
});

test('makeContext on a record without manifest.id throws (ownership keying would be corrupt)', () => {
  const s = setup();
  assert.throws(() => s.lifecycle.makeContext({ manifest: {} }), /manifest\.id/);
});

test('deactivateAll runs in reverse activation order', async () => {
  const s = setup();
  const seq = [];
  await s.lifecycle.activate(plugin('a', (c) => c.effect(() => seq.push('deact:a'))));
  await s.lifecycle.activate(plugin('b', (c) => c.effect(() => seq.push('deact:b'))));
  await s.lifecycle.deactivateAll();
  assert.deepEqual(seq, ['deact:b', 'deact:a']);
  assert.deepEqual(s.lifecycle.debugState(), { active: [], timers: {} });
});

test('deactivate never throws: failing effects are attributed; teardown still completes', async () => {
  const s = setup();
  const seq = [];
  const p1 = plugin('p1', (c) => {
    c.effect(() => seq.push('first'));
    c.effect(() => { throw new Error('sync boom'); });
    c.effect(async () => { throw new Error('async boom'); });
    c.setInterval(() => {}, 1000);
  });
  await s.lifecycle.activate(p1);
  await assert.doesNotReject(() => s.lifecycle.deactivate(p1));
  assert.deepEqual(seq, ['first']); // LIFO: registered first, runs last — after both failures
  assert.equal(s.errors.length, 2);
  assert.match(String(s.errors[0]), /async boom/);
  assert.match(String(s.errors[1]), /sync boom/);
  assert.deepEqual(s.lifecycle.debugState().timers, {}); // timer cleared despite failing effects
  assert.equal(p1.status, 'disabled');
});

test('fourPhase: drain → deactivate (reverse) → reload → afterAllActivated; stale afterAll callbacks are purged', async () => {
  const s = setup();
  const seq = [];
  s.services.register('engine', { drain: async (ms) => { seq.push(`drain:${ms}`); } });
  await s.lifecycle.activate(plugin('a', (c) => {
    c.effect(() => seq.push('deact:a'));
    c.afterAllActivated(() => seq.push('after-a')); // must NOT run: a is deactivated in phase 1
  }));
  await s.lifecycle.activate(plugin('b', (c) => c.effect(() => seq.push('deact:b'))));
  const reloadFn = async () => {
    seq.push('reload');
    await s.lifecycle.activate(plugin('c', (c) => c.afterAllActivated(() => seq.push('after-c'))));
  };
  await s.lifecycle.fourPhase({ reloadFn, drainTimeoutMs: 40 });
  assert.deepEqual(seq, ['drain:40', 'deact:b', 'deact:a', 'reload', 'after-c']);
});

test('fourPhase: a drain that never settles cannot wedge reload — timeout proceeds with warn', async () => {
  const s = setup();
  s.services.register('engine', { drain: () => new Promise(() => {}) });
  const seq = [];
  await s.lifecycle.activate(plugin('a', (c) => c.effect(() => seq.push('deact:a'))));
  const started = Date.now();
  await s.lifecycle.fourPhase({ reloadFn: async () => seq.push('reload'), drainTimeoutMs: 30 });
  assert.ok(Date.now() - started < 2000, 'fourPhase must complete despite the hung drain');
  assert.deepEqual(seq, ['deact:a', 'reload']);
  assert.equal(s.warns.length, 1);
  assert.match(String(s.warns[0]), /drain/);
});

test('fourPhase without an engine service skips phase 0; a throwing drain is logged and proceeds', async () => {
  const s = setup();
  await s.lifecycle.activate(plugin('a', (c) => c.effect(() => {})));
  await s.lifecycle.fourPhase({ reloadFn: async () => {}, drainTimeoutMs: 10 }); // no engine registered
  assert.equal(s.errors.length, 0);
  const s2 = setup();
  s2.services.register('engine', { drain: () => { throw new Error('drain boom'); } });
  await s2.lifecycle.activate(plugin('a', (c) => {}));
  await s2.lifecycle.fourPhase({ reloadFn: async () => {}, drainTimeoutMs: 10 });
  assert.equal(s2.errors.length, 1);
  assert.match(String(s2.errors[0]), /drain boom/);
});

test('runAfterAllActivated: async throw is attributed and does not block later callbacks; queue consumed once', async () => {
  const s = setup();
  const ran = [];
  await s.lifecycle.activate(plugin('a', (c) => {
    c.afterAllActivated(async () => { throw new Error('cb boom'); });
    c.afterAllActivated(() => ran.push('second'));
  }));
  await s.lifecycle.runAfterAllActivated();
  assert.deepEqual(ran, ['second']);
  assert.equal(s.errors.length, 1);
  assert.match(String(s.errors[0]), /a/);
  assert.match(String(s.errors[0]), /cb boom/);
  await s.lifecycle.runAfterAllActivated(); // consumed: nothing runs a second time
  assert.deepEqual(ran, ['second']);
  assert.equal(s.errors.length, 1);
});

test('createLifecycle defaults its own portRegistry when none is supplied', async () => {
  const { log } = fakeLog();
  const lifecycle = createLifecycle({
    events: createEventBus({ log }), services: createServices(), log, http: createHttpShell({ log }),
  });
  assert.ok(lifecycle.portRegistry.channel instanceof Map);
  await lifecycle.activate(plugin('p', (c) => c.registerChannel('ch', { capabilities: { media: true } })));
  assert.deepEqual(lifecycle.portRegistry.getChannel('ch'), { capabilities: { media: true } });
});
