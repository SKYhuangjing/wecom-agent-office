// Engine serial-chain semantics (DESIGN §6 串行链, review-pinned). These
// tests lock the concurrency core Task 13 builds on:
//   - per-chatKey serialization with settle-before-spawn,
//   - queue merge (a queued message is REPLACED, never batch-run),
//   - inFlight compare-and-delete (predecessor bug regression),
//   - the global concurrency gate (FIFO across bots),
//   - drain (abort + refuse + bounded settle),
//   - allowedUsers enforcement (DESIGN §6 step 1) and per-bot drain
//     (drainBot: one bot's chains settle without touching other bots),
//   - attach/detach offline handling.
// The turn body is an injected runTurnImpl (the Task 13 hook) driving a fake
// runner whose run() settles only when the test resolves its gate — so every
// assertion below is about ENGINE ordering, not test scaffolding luck.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../../plugins/core-engine/engine.js';

const KEY = 'wecom:group:g1';
const KEY2 = 'wecom:group:g2';
const bot = { id: 'bot1', provider: 'codex' };
const bot2 = { id: 'bot2', provider: 'claude' };

const msg = (text, chatKey = KEY) =>
  ({ chatKey, chatKind: 'group', userid: 'u1', text, reqId: `req-${text}` });

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

// setImmediate runs after the microtask queue fully drains, so one tick
// guarantees every engine continuation (no timers involved) has run.
const tick = () => new Promise((r) => setImmediate(r));

function fakeLog() {
  const lines = { debug: [], info: [], warn: [], error: [] };
  return {
    lines,
    debug: (m) => lines.debug.push(m),
    info: (m) => lines.info.push(m),
    warn: (m) => lines.warn.push(m),
    error: (m) => lines.error.push(m),
  };
}

// In-memory provider runner. Each run() parks on a per-prompt deferred gate;
// with abortSettles, an abort resolves the gate — mirroring a real provider
// whose subprocess death settles the run promise (what drain relies on).
function fakeRunner({ abortSettles = false } = {}) {
  const runner = {
    spawns: [],
    gates: new Map(),
    run({ prompt, signal }) {
      const gate = deferred();
      runner.spawns.push({ prompt, signal, seq: runner.spawns.length });
      runner.gates.set(prompt, gate);
      if (abortSettles) signal.addEventListener('abort', () => gate.resolve('aborted'));
      return gate.promise;
    },
  };
  return runner;
}

function makeHarness({ limits, abortSettles = false, attach = [bot] } = {}) {
  const events = []; // ordered log: '<text>-start' / '<text>-run-settled'
  const acs = new Map(); // text → the AbortController the engine passed in
  const runner = fakeRunner({ abortSettles });
  const adapter = { sent: [], reply: async (reqId, text) => { adapter.sent.push({ reqId, text }); } };
  const log = fakeLog();
  const engine = new Engine({
    log,
    getRunner: () => runner,
    getAdapter: () => adapter,
    ledgerFactory: () => ({}),
    timeline: null,
    progressor: null,
    middleware: null,
    limits,
    runTurnImpl: async function (b, m, ac) {
      acs.set(m.text, ac);
      events.push(`${m.text}-start`);
      await runner.run({ prompt: m.text, signal: ac.signal });
      events.push(`${m.text}-run-settled`);
    },
  });
  for (const b of attach) engine.attachBot(b, { adapter, runner });
  return { engine, events, acs, runner, adapter, log };
}

test('constructor: defaults, no deps required, default runTurnImpl settles cleanly', async () => {
  const engine = new Engine({ log: fakeLog() });
  assert.equal(engine.limits.concurrency, 4);
  assert.equal(engine.limits.minIntervalMs, 2200);
  engine.attachBot(bot, {});
  engine.onMessage(bot, msg('m1'));
  await tick(); await tick();
  assert.equal(engine.inFlight.size, 0, 'run retired after settle');
  assert.equal(engine.chains.size, 0, 'idle chain tail removed from the map');
  assert.equal(engine.status(bot.id).status, 'idle');
});

test('constructor rejects invalid concurrency and non-function deps', () => {
  assert.throws(() => new Engine({ limits: { concurrency: 0 } }), /concurrency/);
  assert.throws(() => new Engine({ limits: { concurrency: 1.5 } }), /concurrency/);
  assert.throws(() => new Engine({ getRunner: 'nope' }), /getRunner/);
  assert.throws(() => new Engine({ ledgerFactory: 'nope' }), /ledgerFactory/);
  assert.throws(() => new Engine({ runTurnImpl: 42 }), /runTurnImpl/);
  new Engine(); // bare constructor is legal: tests/T14 fill deps later
});

test('latest-wins: preempt aborts the running turn; replacement spawns only after full settle', async () => {
  const h = makeHarness();
  h.engine.onMessage(bot, msg('m1'));
  await tick();
  assert.deepEqual(h.runner.spawns.map((s) => s.prompt), ['m1']);

  h.engine.onMessage(bot, msg('m2')); // preempt: abort m1, queue m2
  assert.equal(h.engine.inFlight.get(KEY).signal.aborted, true, 'm1 aborted synchronously');
  await tick();
  assert.equal(h.runner.spawns.length, 1, 'm2 must NOT spawn while m1 unsettled');
  assert.equal(h.acs.get('m1').signal.aborted, true, 'abort reached m1\'s controller');

  h.runner.gates.get('m1').resolve();
  await tick();
  assert.deepEqual(h.runner.spawns.map((s) => s.prompt), ['m1', 'm2'], 'exactly two spawns: m1 then m2');
  assert.ok(h.events.indexOf('m1-run-settled') < h.events.indexOf('m2-start'),
    'm2 spawn order is after m1 run promise resolution');

  h.runner.gates.get('m2').resolve();
  await h.engine.chains.get(KEY);
  assert.deepEqual(h.events, ['m1-start', 'm1-run-settled', 'm2-start', 'm2-run-settled']);
  assert.equal(h.engine.inFlight.has(KEY), false, 'own controller retired at settle');
});

test('queue merge: a message queued while another is pending replaces it (never executed)', async () => {
  const h = makeHarness();
  h.engine.onMessage(bot, msg('m1'));
  await tick();
  h.engine.onMessage(bot, msg('m2')); // abort m1, pending = m2
  await tick();
  h.engine.onMessage(bot, msg('m3')); // m1 still unsettled → m2 still pending → REPLACED
  await tick();
  assert.equal(h.engine.pending.get(KEY).msg.text, 'm3');

  h.runner.gates.get('m1').resolve();
  await tick();
  assert.ok(!h.events.some((e) => e.startsWith('m2-')), 'm2 must never execute');
  assert.deepEqual(h.runner.spawns.map((s) => s.prompt), ['m1', 'm3']);

  h.runner.gates.get('m3').resolve();
  await h.engine.chains.get(KEY);
});

test('settle before spawn: strict order m1-start < m1-run-settled < m3-start', async () => {
  const h = makeHarness();
  h.engine.onMessage(bot, msg('m1'));
  await tick();
  h.engine.onMessage(bot, msg('m2'));
  await tick();
  h.engine.onMessage(bot, msg('m3')); // replaces m2 in the queue
  await tick();
  h.runner.gates.get('m1').resolve();
  await tick(); // m1 settles → chain tail picks up m3
  assert.deepEqual(h.events, ['m1-start', 'm1-run-settled', 'm3-start'],
    'the new run must observe the old one fully settled');
  h.runner.gates.get('m3').resolve();
  await h.engine.chains.get(KEY);
});

test('compare-and-delete: a stale cleanup cannot remove the newer run\'s controller', async () => {
  const h = makeHarness();
  h.engine.onMessage(bot, msg('m1'));
  await tick();
  h.engine.onMessage(bot, msg('m2')); // abort m1, queue m2
  h.runner.gates.get('m1').resolve();
  await tick(); // m1 settled+retired; m2 now registered and in flight
  assert.equal(h.engine.inFlight.get(KEY), h.acs.get('m2'));

  // Predecessor-bug regression: m1's finally fires LATE — after m2 already
  // registered its controller. It must be a no-op, not a blind delete.
  h.engine._retireInFlight(KEY, h.acs.get('m1'));
  assert.equal(h.engine.inFlight.get(KEY), h.acs.get('m2'), 'stale retire must keep m2\'s controller');

  h.runner.gates.get('m2').resolve();
  await h.engine.chains.get(KEY);
  assert.equal(h.engine.inFlight.has(KEY), false, 'the real cleanup still removes its own controller');
});

test('global concurrency cap: 5th turn waits for a slot; FIFO across bots', async () => {
  const h = makeHarness({ attach: [bot, bot2] });
  const keys = ['wecom:group:k1', 'wecom:group:k2', 'wecom:group:k3', 'wecom:group:k4', 'wecom:group:k5'];
  keys.slice(0, 4).forEach((k, i) => h.engine.onMessage(bot, msg(`m${i + 1}`, k)));
  h.engine.onMessage(bot2, msg('m5', keys[4])); // different bot, same gate
  await tick();

  assert.equal(h.runner.spawns.length, 4, 'cap filled by the first four');
  assert.equal(h.runner.gates.has('m5'), false, '5th never spawned');
  assert.equal(h.engine.inFlight.has(keys[4]), true, '5th registered while waiting');

  // status.running counts turns registered (occupying a slot or waiting for one)
  const agg = h.engine.status();
  assert.equal(agg.status, 'working');
  assert.equal(agg.running, 5);
  assert.equal(agg.bots.length, 2);
  assert.equal(h.engine.status(bot.id).running, 4);
  assert.equal(h.engine.status(bot2.id).running, 1);

  h.runner.gates.get('m1').resolve(); // free one slot
  await tick();
  assert.deepEqual(h.runner.spawns.map((s) => s.prompt).slice(-1), ['m5'], '5th starts after one finishes');

  for (const p of ['m2', 'm3', 'm4', 'm5']) h.runner.gates.get(p).resolve();
  await Promise.all(keys.map((k) => h.engine.chains.get(k)));
  assert.equal(h.engine.status().status, 'idle');
  assert.equal(h.engine.status().running, 0);
});

test('preempt before start: a gate-waiting turn is merged out without ever spawning', async () => {
  const h = makeHarness({ limits: { concurrency: 1 } });
  h.engine.onMessage(bot, msg('first', 'wecom:group:k0'));
  await tick();
  h.engine.onMessage(bot, msg('m1', KEY)); // registered, waits for the only slot
  await tick();
  assert.equal(h.runner.spawns.length, 1);
  assert.equal(h.engine.inFlight.has(KEY), true);

  h.engine.onMessage(bot, msg('m2', KEY)); // abort m1 BEFORE it ever starts
  assert.equal(h.engine.inFlight.get(KEY).signal.aborted, true);

  h.runner.gates.get('first').resolve();
  await tick();
  assert.deepEqual(h.runner.spawns.map((s) => s.prompt), ['first', 'm2']);
  assert.ok(!h.events.some((e) => e.startsWith('m1-')), 'doomed turn never spawns a run');

  h.runner.gates.get('m2').resolve();
  await h.engine.chains.get(KEY);
});

test('a throwing runTurnImpl cannot wedge the chain', async () => {
  const h = makeHarness();
  let calls = 0;
  h.engine._runTurnImpl = async () => { calls++; if (calls === 1) throw new Error('boom'); };
  h.engine.onMessage(bot, msg('bad'));
  await h.engine.chains.get(KEY);
  assert.equal(h.engine.inFlight.has(KEY), false, 'controller retired despite the throw');
  assert.equal(h.engine.chains.size, 0, 'chain settled and was cleaned up');
  assert.ok(h.log.lines.error.some((l) => String(l).includes('boom')));

  h.engine.onMessage(bot, msg('good')); // chain still alive for the next message
  await h.engine.chains.get(KEY);
  assert.equal(calls, 2);
});

test('drain: aborts in-flight, refuses pending and new messages, settles chains in time', async () => {
  const h = makeHarness({ abortSettles: true }); // abort settles runs like a killed subprocess
  h.engine.onMessage(bot, msg('m1', KEY));
  h.engine.onMessage(bot, msg('m3', KEY2));
  await tick();
  assert.equal(h.runner.spawns.length, 2); // m1 and m3 running, nothing queued

  // m2's preempt auto-settles m1 on the next microtask (abort kills the
  // run), so the queue-then-drain sequence must stay in ONE synchronous
  // block: m2 merges into pending, drain refuses it before the chain wakes.
  h.engine.onMessage(bot, msg('m2', KEY)); // abort m1, pending = m2
  const drainP = h.engine.drain(2000);
  h.engine.onMessage(bot, msg('late', KEY)); // arrives while draining
  assert.equal(await drainP, true, 'all chains settled within the timeout');

  assert.equal(h.engine.inFlight.size, 0);
  assert.equal(h.engine.pending.size, 0);
  assert.equal(h.engine.chains.size, 0);
  assert.deepEqual(h.engine.drainRefusals.map((r) => r.msg.text).sort(), ['late', 'm2']);
  assert.equal(h.acs.get('m1').signal.aborted, true);
  assert.equal(h.acs.get('m3').signal.aborted, true);
  assert.ok(!h.events.some((e) => e.startsWith('m2-')), 'queued m2 refused, never run');

  h.engine.onMessage(bot, msg('after', KEY)); // engine accepts again after drain
  await tick();
  assert.deepEqual(h.runner.spawns.map((s) => s.prompt), ['m1', 'm3', 'after']);
  h.runner.gates.get('after').resolve();
  await h.engine.chains.get(KEY);
});

test('drain timeout: returns false when a run refuses to settle; engine reopens afterwards', async () => {
  const h = makeHarness(); // abortSettles=false: run stays parked on its gate
  assert.throws(() => h.engine.drain(-1), /timeoutMs/);
  assert.throws(() => h.engine.drain(Infinity), /timeoutMs/);
  h.engine.onMessage(bot, msg('stuck', KEY));
  await tick();
  const drainP = h.engine.drain(50);
  h.engine.onMessage(bot, msg('during', KEY));
  assert.equal(await drainP, false, 'bounded by timeoutMs');
  assert.deepEqual(h.engine.drainRefusals.map((r) => r.msg.text), ['during']);
  assert.equal(h.engine.draining, false, 'timeout still reopens the engine');

  h.runner.gates.get('stuck').resolve();
  await h.engine.chains.get(KEY);
  assert.equal(h.engine.inFlight.size, 0);
});

test('drain() default timeout is bounded (5s): a hung run cannot brick the engine', async () => {
  const h = makeHarness(); // abortSettles=false: run ignores abort, stays parked
  h.engine.onMessage(bot, msg('stuck', KEY));
  await tick();
  const t0 = Date.now();
  assert.equal(await h.engine.drain(), false, 'no-arg drain still settles the wait');
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 6000, `default drain must be finite (took ${elapsed}ms)`);
  assert.equal(h.engine.draining, false, 'engine reopens after the default timeout');

  h.runner.gates.get('stuck').resolve();
  await h.engine.chains.get(KEY);
});

test('onMessage validation precedes draining: junk never enters drainRefusals', async () => {
  const h = makeHarness();
  h.engine.onMessage(bot, msg('stuck', KEY));
  await tick();
  const drainP = h.engine.drain(30);
  h.engine.onMessage(bot, {});                   // no chatKey → normal drop
  h.engine.onMessage({ id: 'ghost' }, msg('x')); // never attached → normal drop
  assert.equal(await drainP, false);
  assert.deepEqual(h.engine.drainRefusals, [], 'only runnable messages are refused');
  assert.ok(h.log.lines.warn.some((l) => /chatKey/.test(String(l))));
  assert.ok(h.log.lines.warn.some((l) => /offline/.test(String(l))));

  h.runner.gates.get('stuck').resolve();
  await h.engine.chains.get(KEY);
});

test('gate FIFO: multiple waiters start in arrival order as slots free', async () => {
  const h = makeHarness({ limits: { concurrency: 4 } });
  const keys = Array.from({ length: 6 }, (_, i) => `wecom:group:f${i + 1}`);
  keys.forEach((k, i) => h.engine.onMessage(bot, msg(`m${i + 1}`, k)));
  await tick();
  assert.equal(h.runner.spawns.length, 4);

  h.runner.gates.get('m1').resolve(); // first slot frees → first waiter (m5)
  await tick();
  assert.deepEqual(h.runner.spawns.map((s) => s.prompt), ['m1', 'm2', 'm3', 'm4', 'm5']);

  h.runner.gates.get('m2').resolve(); // second slot frees → next waiter (m6)
  await tick();
  assert.deepEqual(h.runner.spawns.map((s) => s.prompt), ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'],
    'waiters start strictly in arrival order');

  for (const p of ['m3', 'm4', 'm5', 'm6']) h.runner.gates.get(p).resolve();
  await Promise.all(keys.map((k) => h.engine.chains.get(k)));
});

test('drain reentry: overlapping drains serialize — both resolve, refusals survive', async () => {
  const h = makeHarness({ abortSettles: true });
  h.engine.onMessage(bot, msg('m1', KEY));
  await tick();
  const d1 = h.engine.drain(1000);
  const d2 = h.engine.drain(1000); // called while d1 is in flight
  h.engine.onMessage(bot, msg('during', KEY)); // refused inside the shared window
  assert.equal(await d1, true);
  assert.equal(await d2, true);
  assert.deepEqual(h.engine.drainRefusals.map((r) => r.msg.text), ['during'],
    'queued drain must not clobber the window\'s refusals');
  assert.equal(h.engine.inFlight.size, 0);
  assert.equal(h.engine.pending.size, 0);
  assert.equal(h.engine.chains.size, 0);
});

test('attach/detach: detached bot drops messages with warn; status reflects offline', async () => {
  const h = makeHarness();
  h.engine.onMessage(bot, msg('m1'));
  await tick();
  assert.equal(h.engine.status(bot.id).status, 'working');
  h.engine.setProgress(bot.id, '💭 分析中', 'thinking');
  assert.equal(h.engine.status(bot.id).progress.line, '💭 分析中');

  h.runner.gates.get('m1').resolve();
  await h.engine.chains.get(KEY);
  assert.equal(h.engine.status(bot.id).status, 'idle');
  assert.equal(h.engine.status(bot.id).progress, null, 'progress cleared when the last run settles');

  h.engine.detachBot(bot.id, 'plugin disabled');
  assert.equal(h.engine.status(bot.id).status, 'offline');
  h.engine.onMessage(bot, msg('m2')); // dropped
  await tick();
  assert.equal(h.runner.spawns.length, 1);
  assert.ok(h.log.lines.warn.some((l) => String(l).includes('offline')));

  h.engine.attachBot(bot, { adapter: h.adapter, runner: h.runner }); // reattach unmarks offline
  assert.equal(h.engine.status(bot.id).status, 'idle');
  h.engine.onMessage(bot, msg('m3'));
  await tick();
  assert.deepEqual(h.runner.spawns.map((s) => s.prompt), ['m1', 'm3']);
  h.runner.gates.get('m3').resolve();
  await h.engine.chains.get(KEY);

  const agg = h.engine.status();
  assert.ok(Array.isArray(agg.bots) && agg.bots.length === 1 && agg.bots[0].status === 'idle');
});

test('onMessage validates input: missing chatKey / unknown bot dropped with warn', async () => {
  const h = makeHarness();
  h.engine.onMessage(bot, {}); // no chatKey
  h.engine.onMessage(bot, null); // no message at all
  h.engine.onMessage({ id: 'ghost' }, msg('x')); // never attached
  await tick();
  assert.equal(h.runner.spawns.length, 0);
  assert.equal(h.engine.chains.size, 0);
  assert.equal(h.log.lines.warn.length, 3);
});

// --- allowedUsers (DESIGN §6 step 1, M3 gate) ----------------------------------

test('allowedUsers: non-empty list admits members, silently drops strangers (warn, no spawn)', async () => {
  const allowBot = { id: 'ab1', provider: 'codex', allowedUsers: ['u1', 'u2'] };
  const h = makeHarness({ attach: [allowBot] });
  h.engine.onMessage(allowBot, msg('hi', KEY)); // msg() userid = 'u1' → member
  await tick();
  assert.deepEqual(h.runner.spawns.map((s) => s.prompt), ['hi']);
  h.runner.gates.get('hi').resolve();
  await h.engine.chains.get(KEY);

  h.engine.onMessage(allowBot, { ...msg('nope', 'wecom:group:k9'), userid: 'stranger' });
  await tick();
  assert.equal(h.runner.spawns.length, 1, 'a non-allowed user never spawns a run');
  assert.equal(h.engine.chains.size, 0, 'no chain left behind');
  assert.equal(h.engine.pending.size, 0);
  const line = h.log.lines.warn.find((l) => String(l).includes('reject message from non-allowed user'));
  assert.ok(line && String(line).includes('stranger'), `warn names the user: ${JSON.stringify(h.log.lines.warn)}`);
});

test('allowedUsers: empty or missing list allows everyone', async () => {
  for (const record of [{ ...bot }, { ...bot, allowedUsers: [] }]) {
    const h = makeHarness({ attach: [record] });
    h.engine.onMessage(record, { ...msg('m1', KEY), userid: 'stranger' });
    await tick();
    assert.equal(h.runner.spawns.length, 1, 'allow-all accepts any userid');
    h.runner.gates.get(h.runner.spawns[0].prompt).resolve();
    await h.engine.chains.get(KEY);
    assert.deepEqual(h.log.lines.warn.filter((l) => /non-allowed/.test(String(l))), []);
  }
});

// --- per-bot drain (DESIGN §8: bot CRUD settles the bot's chains first) --------

test('drainBot: aborts only that bot, sweeps its pending, settles its chains; other bots untouched', async () => {
  const h = makeHarness({ abortSettles: true, attach: [bot, bot2] });
  h.engine.onMessage(bot, msg('mine', KEY));
  h.engine.onMessage(bot2, msg('theirs', KEY2));
  await tick();
  assert.equal(h.runner.spawns.length, 2);

  // One synchronous block (the queue-then-drain race discipline of the drain
  // tests above): 'queued' merges into pending, drainBot sweeps it before the
  // chain wakes, 'late' hits the per-bot latch and is refused.
  h.engine.onMessage(bot, msg('queued', KEY)); // abort mine, pending = queued
  const drained = h.engine.drainBot('bot1', 2000);
  h.engine.onMessage(bot, msg('late', KEY)); // arrives mid-swap for THIS bot
  assert.equal(await drained, true, 'the bot\'s chains settled in time');

  assert.deepEqual(h.engine.drainRefusals.map((r) => r.msg.text).sort(), ['late', 'queued'],
    'swept pending + mid-swap arrivals are recorded as refusals');
  assert.equal(h.acs.get('mine').signal.aborted, true, 'the bot\'s in-flight run was aborted');
  assert.equal(h.acs.get('theirs').signal.aborted, false, 'the OTHER bot\'s run is untouched');
  assert.equal(h.engine._botDrains.size, 0, 'latch released after the drain');

  h.runner.gates.get('theirs').resolve();
  await h.engine.chains.get(KEY2);
  assert.deepEqual(h.runner.spawns.map((s) => s.prompt), ['mine', 'theirs'],
    'neither the swept pending nor the refused message ever spawns');

  h.engine.onMessage(bot, msg('after', 'wecom:group:k5')); // latch released: accepted again
  await tick();
  assert.deepEqual(h.runner.spawns.map((s) => s.prompt).slice(-1), ['after']);
  h.runner.gates.get('after').resolve();
  await h.engine.chains.get('wecom:group:k5');
});

test('drainBot: bounded — a run ignoring its abort returns false; bad args throw', async () => {
  const h = makeHarness(); // abortSettles=false: the run parks on its gate
  assert.throws(() => h.engine.drainBot('bot1', -1), /timeoutMs/);
  assert.throws(() => h.engine.drainBot('', 10), /bot id/);
  h.engine.onMessage(bot, msg('stuck', KEY));
  await tick();
  assert.equal(await h.engine.drainBot('bot1', 40), false, 'bounded by timeoutMs');
  assert.equal(h.engine._botDrains.size, 0, 'timeout still releases the latch');
  assert.equal(h.acs.get('stuck').signal.aborted, true, 'the abort was still delivered');

  h.runner.gates.get('stuck').resolve();
  await h.engine.chains.get(KEY);
  assert.equal(h.engine.inFlight.size, 0);
});
