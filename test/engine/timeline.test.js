// Timeline ring buffer (DESIGN §3 data source for SSE + GET /api/timeline):
// an in-memory, per-instance event log with a fixed capacity and a sliding
// time window. These tests lock the three eviction/filtering promises the
// UI depends on: bot-scoped reads, window expiry, oldest-first cap eviction,
// and chronological output regardless of injected timestamp order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Timeline } from '../../plugins/core-engine/timeline.js';

const NOW = Date.now();
const MIN = 60_000;
// Injected timestamps keep every case deterministic — no real-clock flakiness.
const at = (msAgo) => NOW - msAgo;
const row = (o) => ({ chatKey: 'wecom:group:g1', text: 't', ...o });

test('get() without botId returns every row, chronological', () => {
  const tl = new Timeline({ windowMs: 30 * MIN });
  tl.push(row({ botId: 'a', kind: 'run_start', at: at(3000) }));
  tl.push(row({ botId: 'b', kind: 'step', at: at(2000) }));
  tl.push(row({ botId: 'a', kind: 'run_end', at: at(1000) }));
  const rows = tl.get();
  assert.deepEqual(rows.map(r => [r.botId, r.kind]),
    [['a', 'run_start'], ['b', 'step'], ['a', 'run_end']]);
});

test('two bots: get({botId}) filters to that bot only, still chronological', () => {
  const tl = new Timeline({ windowMs: 30 * MIN });
  tl.push(row({ botId: 'a', kind: 'run_start', at: at(5000) }));
  tl.push(row({ botId: 'b', kind: 'run_start', at: at(4000) }));
  tl.push(row({ botId: 'a', kind: 'tool', at: at(3000) }));
  tl.push(row({ botId: 'b', kind: 'thinking', at: at(2000) }));
  tl.push(row({ botId: 'a', kind: 'run_end', at: at(1000) }));
  const a = tl.get({ botId: 'a' });
  assert.deepEqual(a.map(r => r.kind), ['run_start', 'tool', 'run_end']);
  const b = tl.get({ botId: 'b' });
  assert.deepEqual(b.map(r => r.kind), ['run_start', 'thinking']);
});

test('window expiry: rows older than the window are dropped, fresh kept', () => {
  const tl = new Timeline({ windowMs: 30 * MIN });
  tl.push(row({ botId: 'a', kind: 'run_start', at: at(31 * MIN) })); // too old
  tl.push(row({ botId: 'a', kind: 'step', at: at(29 * MIN) })); // inside
  tl.push(row({ botId: 'a', kind: 'run_end', at: at(1000) }));
  assert.deepEqual(tl.get().map(r => r.kind), ['step', 'run_end']);
});

test('per-call windowMs override narrows/widens without touching the default', () => {
  const tl = new Timeline({ windowMs: 30 * MIN });
  tl.push(row({ botId: 'a', kind: 'run_start', at: at(10 * MIN) }));
  tl.push(row({ botId: 'a', kind: 'step', at: at(30_000) }));
  // narrower: 10min-old row falls out, 30s-old stays
  assert.deepEqual(tl.get({ windowMs: MIN }).map(r => r.kind), ['step']);
  // default still keeps both (the override must not mutate instance state)
  assert.deepEqual(tl.get().map(r => r.kind), ['run_start', 'step']);
});

test('cap eviction is oldest-first and keeps insertion tail', () => {
  const tl = new Timeline({ cap: 3 });
  tl.push(row({ botId: 'a', kind: 'run_start', at: at(5000) }));
  tl.push(row({ botId: 'a', kind: 'step', at: at(4000) }));
  tl.push(row({ botId: 'a', kind: 'tool', at: at(3000) }));
  tl.push(row({ botId: 'a', kind: 'thinking', at: at(2000) }));
  tl.push(row({ botId: 'a', kind: 'run_end', at: at(1000) }));
  assert.deepEqual(tl.get().map(r => r.kind), ['tool', 'thinking', 'run_end']);
  // eviction + bot filter combine: the oldest of the OTHER bot is gone too
  tl.push(row({ botId: 'b', kind: 'run_start', at: at(500) }));
  assert.deepEqual(tl.get({ botId: 'a' }).map(r => r.kind), ['thinking', 'run_end']);
  assert.equal(tl.get({ botId: 'b' }).length, 1);
});

test('cap eviction wraps many times over (ring, not one-shot trim)', () => {
  const tl = new Timeline({ cap: 5 });
  for (let i = 0; i < 23; i++) {
    tl.push(row({ botId: 'a', kind: 'step', text: `t${i}`, at: at(10_000 - i) }));
  }
  const rows = tl.get();
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map(r => r.text), ['t18', 't19', 't20', 't21', 't22']);
});

test('out-of-order injected timestamps come back chronological', () => {
  const tl = new Timeline({ windowMs: 30 * MIN });
  tl.push(row({ botId: 'a', kind: 'run_end', at: at(1000) }));
  tl.push(row({ botId: 'a', kind: 'run_start', at: at(3000) }));
  tl.push(row({ botId: 'a', kind: 'step', at: at(2000) }));
  assert.deepEqual(tl.get().map(r => r.kind), ['run_start', 'step', 'run_end']);
});

test('at defaults to now: a pushed row survives the default 30min window', () => {
  const tl = new Timeline({ windowMs: 30 * MIN });
  const before = Date.now();
  tl.push(row({ botId: 'a', kind: 'turn' }));
  const [r] = tl.get();
  assert.ok(r.at >= before && r.at <= Date.now(), 'at must be Date.now()-fresh');
});

test('rows are copies: mutating get() results cannot corrupt the ring', () => {
  const tl = new Timeline({ cap: 2 });
  tl.push(row({ botId: 'a', kind: 'run_start', at: at(1000) }));
  tl.get()[0].kind = 'hacked';
  assert.equal(tl.get()[0].kind, 'run_start');
});

test('push rejects unknown kind and missing botId/chatKey (loud, not silent)', () => {
  const tl = new Timeline();
  assert.throws(() => tl.push(row({ botId: 'a', kind: 'bogus', at: at(1) })), /kind/);
  assert.throws(() => tl.push(row({ kind: 'step', at: at(1) })), /botId/);
  assert.throws(() => tl.push({ botId: 'a', kind: 'step', at: at(1) }), /chatKey/); // no chatKey
  assert.throws(() => tl.push(row({ botId: 'a', kind: 'step', at: 'yesterday' })), /at/);
  assert.deepEqual(tl.get(), []); // nothing was stored by the rejected pushes
});

test('constructor rejects non-positive cap/window (misconfiguration is a bug)', () => {
  assert.throws(() => new Timeline({ cap: 0 }), /cap/);
  assert.throws(() => new Timeline({ cap: 1.5 }), /cap/);
  assert.throws(() => new Timeline({ windowMs: -1 }), /windowMs/);
});

test('empty timeline returns [] (SSE first poll / fresh boot)', () => {
  assert.deepEqual(new Timeline().get(), []);
  assert.deepEqual(new Timeline().get({ botId: 'nobody' }), []);
});
