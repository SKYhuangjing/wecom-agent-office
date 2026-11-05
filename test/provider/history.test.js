// Task 18 unit grid: plugins/provider-dsh/history.js — the port of
// wecom-bots/lib/history.js (zstd multi-frame decode + turn extraction) into
// the §5 readHistory tolerance shape {turns, truncated, warnings}. Fixtures
// are generated with node:zlib zstdCompressSync (Node 24 ships it), so no
// external zstd is needed; the huge fixture reuses the contract suite's
// PROFILES.dsh.hugeHistory writer to keep one canonical dsh-format builder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { zstdCompressSync } from 'node:zlib';
import { readHistory, historyCandidates, cwdEscape } from '../../plugins/provider-dsh/history.js';
import { PROFILES } from '../contract/profiles.js';

const sessionEvents = (nTurns, { prefix = [] } = {}) => {
  const events = [...prefix, { type: 'session', createdAt: 1 }];
  for (let i = 0; i < nTurns; i++) {
    events.push({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: `问题 ${i}` }] } });
    events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `回答 ${i}` }] } }, time: 100 + i });
  }
  return events;
};
const jsonlOf = (events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';
// multi-frame zstd: real dsh appends frames; N frames exercises the decoder
const zstdFrames = (text, nFrames = 2) => {
  const chunk = Math.ceil(text.length / nFrames);
  const parts = [];
  for (let i = 0; i < nFrames; i++) parts.push(zstdCompressSync(Buffer.from(text.slice(i * chunk, (i + 1) * chunk), 'utf8')));
  return Buffer.concat(parts);
};

test('history: missing session → turns=[], ≥1 warning naming the path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-h-miss-'));
  try {
    const r = await readHistory({ cwd: dir }, 'no-such-session');
    assert.deepEqual(r.turns, []);
    assert.equal(r.truncated, false);
    assert.ok(r.warnings.length >= 1, 'missing file warns');
    assert.match(r.warnings[0], /session file not found: .*no-such-session/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('history: corrupt file (no zstd magic) → warning, distinct from missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-h-cor-'));
  try {
    const f = join(dir, 'sessions', 'corrupt.zst');
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, Buffer.concat([Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0x00, 0x01]), Buffer.from('definitely not a session file')]));
    const r = await readHistory({ cwd: dir }, 'corrupt');
    assert.deepEqual(r.turns, []);
    assert.equal(r.truncated, false);
    assert.ok(r.warnings.length >= 1);
    assert.match(r.warnings.join('\n'), /no zstd frame found/, 'corrupt bytes are a decode warning, not a throw');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('history: office convention layout <cwd>/sessions/<id>.zst — multi-frame decode + turns', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-h-conv-'));
  try {
    const f = join(dir, 'sessions', 's-conv.zst');
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, zstdFrames(jsonlOf(sessionEvents(3)), 3));
    const r = await readHistory({ cwd: dir }, 's-conv');
    assert.deepEqual(r.warnings, []);
    assert.equal(r.turns.length, 3);
    assert.deepEqual(r.turns[0], { user: '问题 0', assistant: '回答 0', at: 100 });
    assert.deepEqual(r.turns[2], { user: '问题 2', assistant: '回答 2', at: 102 });
    assert.equal(r.truncated, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('history: REAL dsh layout ~/.dsh/sessions/<cwdEscape>/session-<id>/session.v4.jsonl.zstd', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-h-real-'));
  const dshHome = mkdtempSync(join(tmpdir(), 'wao-h-home-'));
  try {
    const sid = 'abc123';
    // dsh escapes the REALPATH of its cwd; candidates[0] is the office
    // convention, the rest are the real-layout probes (realpath first).
    const candidates = historyCandidates({ cwd: dir, dshHome }, sid);
    assert.equal(candidates[0], join(dir, 'sessions', `${sid}.zst`));
    assert.ok(candidates.length >= 2, 'real-layout candidate present');
    assert.ok(candidates.every((f) => !f.includes(dir) || f === candidates[0]), 'real-layout candidates live under dshHome');
    const f = candidates[1];
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, zstdFrames(jsonlOf(sessionEvents(2, {
      // non-user sourced messages (harness/system) must not count as turns
      prefix: [{ type: 'user/message', data: { source: { kind: 'system' }, content: [{ type: 'text', text: '内部指令' }] } }],
    }))));
    // cwd has no <cwd>/sessions file → falls through to the real layout
    const r = await readHistory({ cwd: dir, dshHome }, sid);
    assert.deepEqual(r.warnings, []);
    assert.equal(r.turns.length, 2);
    assert.equal(r.turns[0].user, '问题 0', 'system-sourced message skipped');
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(dshHome, { recursive: true, force: true }); }
});

test('history: realpath escape probed when /tmp → /private/tmp (macOS 前身 miss)', async () => {
  const tmpReal = realpathSync('/tmp');
  if (tmpReal === '/tmp') return; // linux: raw escape IS the realpath escape — nothing extra to probe
  // dsh stores /tmp-cwd sessions under --private-tmp-...-- (it realpaths its
  // cwd); a reader that only escapes the raw path misses them (前身 bug).
  const name = `wao-esc-${process.pid}`;
  const dirReal = `${tmpReal}/${name}`;
  const cwdRaw = `/tmp/${name}`; // the spelling a bot config would carry
  mkdirSync(dirReal, { recursive: true });
  const dshHome = mkdtempSync(join(tmpdir(), 'wao-h-rl-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  try {
    const sid = 'rp-probe';
    const cands = historyCandidates({ cwd: cwdRaw }, sid);
    const realPathForm = join(dshHome, 'sessions', cwdEscape(dirReal), `session-${sid}`, 'session.v4.jsonl.zstd');
    const rawForm = join(dshHome, 'sessions', cwdEscape(cwdRaw), `session-${sid}`, 'session.v4.jsonl.zstd');
    assert.ok(cands.includes(realPathForm), 'realpath escape probed');
    assert.ok(cands.includes(rawForm), 'raw escape still probed');
    // and a session written where dsh writes it is actually FOUND via the raw spelling
    mkdirSync(dirname(realPathForm), { recursive: true });
    writeFileSync(realPathForm, zstdFrames(jsonlOf(sessionEvents(1))));
    const r = await readHistory({ cwd: cwdRaw }, sid);
    assert.deepEqual(r.warnings, []);
    assert.equal(r.turns.length, 1);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    rmSync(dshHome, { recursive: true, force: true });
    rmSync(dirReal, { recursive: true, force: true });
  }
});

test('history: corrupt JSONL line inside valid zstd → warning, other turns still parsed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-h-line-'));
  try {
    const f = join(dir, 'sessions', 's-lines.zst');
    mkdirSync(dirname(f), { recursive: true });
    const good = sessionEvents(2);
    const text = `${JSON.stringify(good[0])}\nNOT JSON AT ALL\n${jsonlOf(good.slice(1))}`;
    writeFileSync(f, zstdCompressSync(Buffer.from(text, 'utf8')));
    const r = await readHistory({ cwd: dir }, 's-lines');
    assert.equal(r.turns.length, 2, 'good lines survive a corrupt neighbor');
    assert.ok(r.warnings.some((w) => /is not JSON/.test(w)), 'corrupt line warns');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('history: huge session (contract fixture writer) → truncated=true, 2000 turns', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-h-huge-'));
  try {
    assert.equal(typeof PROFILES.dsh.hugeHistory, 'function', 'contract profile provides the fixture writer');
    const f = join(dir, 'sessions', 'huge-session.zst');
    mkdirSync(dirname(f), { recursive: true });
    await PROFILES.dsh.hugeHistory(f);
    const r = await readHistory({ cwd: dir }, 'huge-session');
    assert.deepEqual(r.warnings, []);
    assert.equal(r.truncated, true);
    assert.equal(r.turns.length, 2000);
    // newest-first truncation (前身 slice(-limit)): the OLDEST 500 turns are
    // the ones dropped; the most recent turn must survive
    assert.equal(r.turns[0].assistant, '回答 500');
    assert.equal(r.turns[1999].assistant, '回答 2499');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
