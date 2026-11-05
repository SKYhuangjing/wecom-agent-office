import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventBus } from '../../src/kernel/events.js';

test('subscriber failure is attributed and isolated', () => {
  const errors = []; const log = { info(){}, warn(){}, error: (...a) => errors.push(a) };
  const bus = createEventBus({ log });
  let got = 0;
  bus.on('t', () => { throw new Error('boom'); }, 'plugin-a');
  bus.on('t', () => { got++; }, 'plugin-b');
  assert.doesNotThrow(() => bus.emit('t', { x: 1 }));
  assert.equal(got, 1); assert.equal(errors.length, 1); assert.match(String(errors[0]), /plugin-a/);
});

// Collecting fake logger shared by the supplementary tests below.
const fakeLog = () => { const errors = []; return { errors, log: { info(){}, warn(){}, error: (...a) => errors.push(a) } }; };

test('off() unsubscribes and is idempotent', () => {
  const { errors, log } = fakeLog();
  const bus = createEventBus({ log });
  let got = 0;
  const off = bus.on('t', () => { got++; }, 'p1');
  off();
  off(); // second call must be a safe no-op
  bus.emit('t', null);
  assert.equal(got, 0);
  assert.equal(errors.length, 0);
});

test('emit with no subscribers is a no-op', () => {
  const { errors, log } = fakeLog();
  const bus = createEventBus({ log });
  assert.doesNotThrow(() => bus.emit('nobody-listens', { x: 1 }));
  assert.equal(errors.length, 0);
});

test('subscribers run in registration order and receive the payload', () => {
  const { log } = fakeLog();
  const bus = createEventBus({ log });
  const calls = [];
  bus.on('t', (p) => calls.push(`a:${p.v}`), 'pa');
  bus.on('t', (p) => calls.push(`b:${p.v}`), 'pb');
  bus.on('other', () => calls.push('wrong-topic'), 'pc');
  bus.emit('t', { v: 7 });
  assert.deepEqual(calls, ['a:7', 'b:7']);
});

test('every failing subscriber is attributed and non-failures still run', () => {
  const { errors, log } = fakeLog();
  const bus = createEventBus({ log });
  let got = 0;
  bus.on('t', () => { throw new Error('boom1'); }, 'p1');
  bus.on('t', () => { got++; }, 'ok');
  bus.on('t', () => { throw new Error('boom2'); }, 'p2');
  assert.doesNotThrow(() => bus.emit('t', 'payload'));
  assert.equal(got, 1);
  assert.equal(errors.length, 2);
  assert.match(String(errors[0]), /p1/);
  assert.match(String(errors[1]), /p2/);
});

test('off() during emit does not break dispatch of remaining subscribers', () => {
  const { errors, log } = fakeLog();
  const bus = createEventBus({ log });
  const calls = [];
  const offA = bus.on('t', () => { offA(); calls.push('a'); }, 'pa'); // self-unsubscribe mid-emit
  bus.on('t', () => calls.push('b'), 'pb');
  bus.emit('t', null);
  bus.emit('t', null); // a is gone now; b still receives
  assert.deepEqual(calls, ['a', 'b', 'b']);
  assert.equal(errors.length, 0);
});

test('async subscriber rejection is attributed and isolated (no unhandled rejection)', async () => {
  const { errors, log } = fakeLog();
  const bus = createEventBus({ log });
  let got = 0;
  bus.on('t', async () => { throw new Error('async boom'); }, 'plugin-async');
  bus.on('t', () => { got++; }, 'plugin-b');
  bus.emit('t', null); // sync dispatch: the rejection escapes the loop's sync try/catch on a later tick
  assert.equal(got, 1); // the sync subscriber already ran, unaffected
  await new Promise((r) => setImmediate(r)); // let the rejected promise's catch handlers run
  assert.equal(errors.length, 1); // without the thenable branch this is an unhandled rejection that kills the process
  assert.match(String(errors[0]), /plugin-async/);
  assert.match(String(errors[0]), /async boom/);
});
