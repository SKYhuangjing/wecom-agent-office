// Regression lock for the consumedSeq protocol (DESIGN §3/§7) — the correctness
// backbone of provider switching. The two review counterexamples live here:
//   A: switch provider -> first turn preempted -> switch via a third provider
//      -> switch back must replay ONLY the turns the prefix does not contain.
//   B: crash window (ledger row appended, cache persist lost) -> recompute
//      takes the ledger as authoritative and warns about the drift.
// Plus the four rules' units: init-atomicity, advance-includes-failed-rows,
// ledger-authoritative recovery, chatKey-filtered replay windowing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../../plugins/core-engine/ledger.js';
import { SessionCache } from '../../plugins/core-engine/sessionCache.js';

const K = 'wecom:group:g1';
const K2 = 'wecom:group:g2';
const INTRO = '以下是本对话此前的记录（供上下文参考）：';
const OMIT = '…(更早记录已省略)';

const mkLog = () => {
  const calls = { debug: [], info: [], warn: [], error: [] };
  return {
    calls,
    debug: (...a) => calls.debug.push(a), info: (...a) => calls.info.push(a),
    warn: (...a) => calls.warn.push(a), error: (...a) => calls.error.push(a),
  };
};

// One full §3 ledger row with overridable fields; seq/at are deliberately left
// to recordTurn so every test exercises the real ownership rule.
const turn = (o = {}) => ({
  chatKey: K, channel: 'wecom', chatKind: 'group', chatid: 'g1', userid: 'u1',
  user: 'hi', assistant: 'ok', provider: 'dsh', sessionId: 's-dsh',
  ok: true, reason: 'completed', tokens: null, cost: null, ...o,
});

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-ledger-'));
  const log = mkLog();
  const ledger = new Ledger({ file: join(dir, 'ledger.jsonl'), log });
  const cache = new SessionCache({ file: join(dir, 'sessions.json'), log, ledger });
  return { dir, log, ledger, cache };
};

// --- counterexamples (DESIGN §7) --------------------------------------------

test('counterexample A: no double replay after interrupted first turn on new provider', () => {
  const { log, ledger: L, cache: C } = fresh();
  for (let i = 1; i <= 10; i++) L.recordTurn(turn({ seq: L.nextSeq(), provider: 'dsh', assistant: `a${i}` }));
  // switch to claude: prefix built from rows 1..10, consumedSeq=10 persisted in
  // the SAME upsert (rule 1 — the prefix physically entered the session here).
  C.upsert(K, 'claude', { sessionId: 's-claude', bornCwd: '/ws' }, 10);
  assert.equal(C.get(K).cache.claude.consumedSeq, 10);
  assert.equal(C.get(K).cache.claude.consumedAtBuild, 10);
  // first claude turn preempted (no claude row recorded) -> switch to codex, record seq 11
  L.recordTurn(turn({ seq: L.nextSeq(), provider: 'codex' }));
  // switch back to claude: incremental replay must contain ONLY seq 11 (never 1..10)
  const { rows, consumedUpTo } = C.handoffReplay(K, 'claude');
  assert.deepEqual(rows.map(r => r.seq), [11]);
  assert.equal(consumedUpTo, 11);
});

test('counterexample B: recompute from ledger overrides stale cache', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-ledger-b-'));
  const log = mkLog();
  const L = new Ledger({ file: join(dir, 'ledger.jsonl'), log });
  const C = new SessionCache({ file: join(dir, 'sessions.json'), log, ledger: L });
  for (let i = 1; i <= 20; i++) L.recordTurn(turn({ seq: L.nextSeq() }));
  C.upsert(K, 'dsh', { sessionId: 's-dsh', bornCwd: '/ws' }, 20);
  // crash window: ledger seq21 appended, the cache persist never happened.
  L.recordTurn(turn({ seq: L.nextSeq() }));
  // restart: a fresh cache instance reads the stale 20 from disk.
  const C2 = new SessionCache({ file: join(dir, 'sessions.json'), log, ledger: L });
  assert.equal(C2.get(K).cache.dsh.consumedSeq, 20);
  assert.equal(C2.recompute(L), true);
  assert.equal(C2.get(K).cache.dsh.consumedSeq, 21);
  const warns = log.calls.warn.map(a => a.join(' '));
  assert.ok(warns.some(w => w.includes('drift') && w.includes('21')), `expected drift warn, got: ${warns}`);
  // the override is durable
  assert.equal(new SessionCache({ file: join(dir, 'sessions.json'), log, ledger: L }).get(K).cache.dsh.consumedSeq, 21);
});

test('replay filters by chatKey: same bot, two groups, no cross-chat leakage', () => {
  const { ledger: L, cache: C } = fresh();
  L.recordTurn(turn({ seq: L.nextSeq(), chatKey: K }));                 // seq 1 -> g1
  L.recordTurn(turn({ seq: L.nextSeq(), chatKey: K2, chatid: 'g2' }));  // seq 2 -> g2
  L.recordTurn(turn({ seq: L.nextSeq(), chatKey: K }));                 // seq 3 -> g1
  L.recordTurn(turn({ seq: L.nextSeq(), chatKey: K2, chatid: 'g2' }));  // seq 4 -> g2
  C.upsert(K, 'dsh', { sessionId: 's', bornCwd: '/ws' }, 0);
  const { rows } = C.handoffReplay(K, 'dsh');
  // seq is a per-bot global counter: without the chatKey filter g2's rows leak in.
  assert.deepEqual(rows.map(r => r.seq), [1, 3]);
});

// --- rule 2: failed rows still advance ---------------------------------------

test('maxSeq counts interrupted/timeout/error rows (rule 2)', () => {
  const { ledger: L } = fresh();
  L.recordTurn(turn({ seq: L.nextSeq(), reason: 'completed' }));
  L.recordTurn(turn({ seq: L.nextSeq(), reason: 'interrupted', ok: false, assistant: '' }));
  L.recordTurn(turn({ seq: L.nextSeq(), reason: 'timeout', ok: false, assistant: '' }));
  L.recordTurn(turn({ seq: L.nextSeq(), reason: 'error', ok: false, assistant: '' }));
  assert.equal(L.maxSeq({ chatKey: K, provider: 'dsh' }), 4);
  assert.equal(L.maxSeq({ chatKey: K, provider: 'claude' }), 0); // none recorded
});

// --- buildHandoffPrefix -------------------------------------------------------

test('buildHandoffPrefix drops oldest blocks over the char budget and notes the omission', () => {
  const { ledger: L } = fresh();
  const A = 'A'.repeat(3000), B = 'B'.repeat(3000), Cc = 'C'.repeat(3000);
  L.recordTurn(turn({ seq: L.nextSeq(), user: A }));
  L.recordTurn(turn({ seq: L.nextSeq(), user: B }));
  L.recordTurn(turn({ seq: L.nextSeq(), user: Cc }));
  const p = L.buildHandoffPrefix({ chatKey: K });
  assert.ok(p.length <= 8000, `prefix over budget: ${p.length}`);
  assert.ok(p.includes(B) && p.includes(Cc), 'must keep the two newest blocks');
  assert.ok(!p.includes(A), 'must drop the oldest block');
  assert.ok(p.includes(OMIT), 'must note the omission');
  assert.ok(p.startsWith(INTRO));
});

test('buildHandoffPrefix keeps only the last maxTurns turns (no omission note)', () => {
  const { ledger: L } = fresh();
  const pad = (i) => String(i).padStart(2, '0');
  for (let i = 1; i <= 12; i++) L.recordTurn(turn({ seq: L.nextSeq(), user: `u${pad(i)}`, assistant: `a${pad(i)}` }));
  const p = L.buildHandoffPrefix({ chatKey: K });
  assert.ok(!p.includes('u01') && !p.includes('u02'), 'must drop turns beyond the window');
  assert.ok(p.includes('u03') && p.includes('u12'));
  // the omission note is tied to char truncation, not the turn window
  assert.ok(!p.includes(OMIT));
});

test('buildHandoffPrefix: any provider, unfinished marker, empty history', () => {
  const { ledger: L } = fresh();
  L.recordTurn(turn({ seq: L.nextSeq(), user: 'q1', assistant: 'a1', provider: 'dsh' }));
  L.recordTurn(turn({ seq: L.nextSeq(), user: 'q2', assistant: '', ok: false, reason: 'interrupted', provider: 'claude' }));
  const p = L.buildHandoffPrefix({ chatKey: K });
  assert.ok(p.indexOf('q1') < p.indexOf('q2'), 'blocks are oldest -> newest');
  assert.ok(p.includes('助手: (未完成)'));
  // no history at all -> no misleading "here is the history" header
  assert.equal(L.buildHandoffPrefix({ chatKey: 'wecom:group:none' }), '');
});

// --- ledger counter recovery --------------------------------------------------

test('Ledger recovers the counter by scanning max(seq), not the last line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-ledger-scan-'));
  const file = join(dir, 'ledger.jsonl');
  // hand-written, deliberately out of order, with a torn trailing line
  writeFileSync(file, '{"seq":3}\n{"seq":1}\n{"seq":7}\n{"seq":\n');
  const L = new Ledger({ file, log: mkLog() });
  const next = L.nextSeq(); // one allocation, asserted twice below
  assert.equal(next, 8);
  assert.equal(L.recordTurn(turn({ seq: next })), 8); // appends right after the recovered max
  assert.deepEqual(L.turns().map(r => r.seq), [3, 1, 7, 8]); // torn line skipped
});

// --- session cache persistence ------------------------------------------------

test('upsert persists atomically: no tmp residue, full roundtrip, rule-1 fields', () => {
  const { dir, cache: C } = fresh();
  C.upsert(K, 'dsh', { sessionId: 's1', bornCwd: '/ws' }, 5);
  C.upsert(K, 'claude', { sessionId: 's2', bornCwd: '/ws' }, 5);
  assert.deepEqual(readdirSync(dir).filter(f => f.includes('.tmp')), []);
  const rec = new SessionCache({ file: join(dir, 'sessions.json'), log: mkLog() }).get(K);
  assert.equal(rec.current, 'claude', 'upsert switches current');
  assert.equal(rec.dirty, false);
  assert.deepEqual(rec.cache.dsh, { sessionId: 's1', bornCwd: '/ws', consumedSeq: 5, consumedAtBuild: 5, dirty: false });
  assert.equal(rec.cache.claude.sessionId, 's2');
});

test('setConsumed advances only, never regresses, and persists', () => {
  const { dir, cache: C } = fresh();
  C.upsert(K, 'dsh', { sessionId: 's1', bornCwd: '/ws' }, 0);
  C.setConsumed(K, 'dsh', 10);
  C.setConsumed(K, 'dsh', 5); // stale/lower seq must not erase progress
  assert.equal(C.get(K).cache.dsh.consumedSeq, 10);
  assert.equal(new SessionCache({ file: join(dir, 'sessions.json'), log: mkLog() }).get(K).cache.dsh.consumedSeq, 10);
  // unknown provider entry: no-op, not a crash
  C.setConsumed(K, 'claude', 7);
  assert.equal(C.get(K).cache.claude, undefined);
});

test('markDirty and setCurrent persist and survive reload', () => {
  const { dir, cache: C } = fresh();
  C.upsert(K, 'dsh', { sessionId: 's1', bornCwd: '/ws' }, 0);
  C.markDirty(K, 'dsh');
  assert.equal(C.get(K).dirty, true);
  assert.equal(C.get(K).cache.dsh.dirty, true);
  C.setCurrent(K, 'claude'); // claude has no entry yet: switch is still recorded
  const rec = new SessionCache({ file: join(dir, 'sessions.json'), log: mkLog() }).get(K);
  assert.equal(rec.current, 'claude');
  assert.equal(rec.dirty, false, 'dirty mirrors the CURRENT provider entry');
  assert.equal(rec.cache.dsh.dirty, true, 'per-provider dirty survives');
});

// --- handoffReplay windowing ---------------------------------------------------

test('handoffReplay: null for uncached provider, empty replay when nothing new', () => {
  const { ledger: L, cache: C } = fresh();
  L.recordTurn(turn({ seq: L.nextSeq() }));
  L.recordTurn(turn({ seq: L.nextSeq() }));
  C.upsert(K, 'dsh', { sessionId: 's1', bornCwd: '/ws' }, 0);
  assert.equal(C.handoffReplay(K, 'claude'), null);
  C.setConsumed(K, 'dsh', 2);
  assert.deepEqual(C.handoffReplay(K, 'dsh'), { rows: [], consumedUpTo: 0 });
});

test('handoffReplay window: newest-first pick, chronological result, consumedUpTo = last delivered', () => {
  const { ledger: L, cache: C } = fresh();
  for (let i = 1; i <= 15; i++) L.recordTurn(turn({ seq: L.nextSeq(), user: 'hi', assistant: 'ok' }));
  C.upsert(K, 'dsh', { sessionId: 's1', bornCwd: '/ws' }, 0);
  // default window: last 10 turns, chronological
  assert.deepEqual(C.handoffReplay(K, 'dsh').rows.map(r => r.seq), [6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  assert.equal(C.handoffReplay(K, 'dsh').consumedUpTo, 15);
  // tighter turn window
  assert.deepEqual(C.handoffReplay(K, 'dsh', { maxTurns: 3 }).rows.map(r => r.seq), [13, 14, 15]);
  // char budget (block = 13 chars + 2 sep: 2 blocks = 28 <= 30 < 3 blocks = 43)
  // drops the OLDEST candidate rows first
  assert.deepEqual(C.handoffReplay(K, 'dsh', { maxChars: 30 }).rows.map(r => r.seq), [14, 15]);
  // consumedUpTo is the last row ACTUALLY delivered, not the ledger max
  assert.equal(C.handoffReplay(K, 'dsh', { maxChars: 30 }).consumedUpTo, 15);
});

// --- recordTurn validation + ownership of seq/at --------------------------------

test('recordTurn validates §3 fields and the reason enum', () => {
  const { ledger: L } = fresh();
  assert.throws(() => L.recordTurn({ ...turn(), user: undefined }), /user/);
  assert.throws(() => L.recordTurn(turn({ chatid: undefined })), /chatid/);
  assert.throws(() => L.recordTurn(turn({ reason: 'aborted' })), /reason/); // engine maps aborted -> interrupted
  assert.throws(() => L.recordTurn(turn({ ok: 1 })), /ok/);
});

test('recordTurn fills seq/at and keeps the counter monotonic', () => {
  const { dir, ledger: L } = fresh();
  const t0 = Date.now();
  assert.equal(L.recordTurn(turn()), 1);
  const row = JSON.parse(readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').pop());
  assert.equal(row.seq, 1);
  assert.ok(row.at >= t0, 'at is filled with the record time');
  // caller-supplied values are honored (at preserved), counter catches up
  assert.equal(L.recordTurn(turn({ seq: 5, at: 123 })), 5);
  const row5 = L.turns().find(r => r.seq === 5);
  assert.equal(row5.at, 123);
  assert.equal(L.nextSeq(), 6);
});

// --- turns() filters ------------------------------------------------------------

test('turns filters by chatKey/provider, exclusive since, and limit', () => {
  const { ledger: L } = fresh();
  L.recordTurn(turn({ seq: L.nextSeq() }));                                        // 1 K dsh
  L.recordTurn(turn({ seq: L.nextSeq(), provider: 'claude' }));                    // 2 K claude
  L.recordTurn(turn({ seq: L.nextSeq(), chatKey: K2, chatid: 'g2' }));             // 3 K2 dsh
  L.recordTurn(turn({ seq: L.nextSeq() }));                                        // 4 K dsh
  assert.deepEqual(L.turns({ chatKey: K }).map(r => r.seq), [1, 2, 4]);
  assert.deepEqual(L.turns({ provider: 'dsh' }).map(r => r.seq), [1, 3, 4]);
  assert.deepEqual(L.turns({ chatKey: K, provider: 'dsh' }).map(r => r.seq), [1, 4]);
  assert.deepEqual(L.turns({ since: 1 }).map(r => r.seq), [2, 3, 4], 'since is exclusive');
  assert.deepEqual(L.turns({ since: 1, limit: 2 }).map(r => r.seq), [2, 3]);
});

// --- recompute without drift is quiet --------------------------------------------

test('recompute with no drift changes nothing and stays quiet', () => {
  const { log, ledger: L, cache: C } = fresh();
  for (let i = 1; i <= 3; i++) L.recordTurn(turn({ seq: L.nextSeq() }));
  C.upsert(K, 'dsh', { sessionId: 's1', bornCwd: '/ws' }, 3);
  assert.equal(C.recompute(L), false);
  assert.equal(C.get(K).cache.dsh.consumedSeq, 3);
  assert.deepEqual(log.calls.warn, []);
});
