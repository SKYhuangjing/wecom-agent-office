// M2 Task 4 unit grid: plugins/provider-codex/history.js — reads codex's
// REAL on-disk rollout format into the §5 readHistory tolerance shape
// {turns, truncated, warnings}. The fixtures replicate the format discovered
// by inspecting the rollout files real codex-cli 0.166.0 sessions wrote (M1
// probe threads + a fresh command-run probe, 2026-11-06) — see the format
// documentation block at the top of history.js. Tolerance is the contract:
// missing / corrupt / oversized history is a warning, never a throw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readHistory, findRolloutFiles, codexHomeOf } from '../../plugins/provider-codex/history.js';
import { PROFILES } from '../contract/profiles.js';

const jsonlOf = (events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

// One codex rollout file: session_meta + harness-injected first user message
// (AGENTS.md + environment_context blocks) + per turn a turn_context noise
// line, the user response_item, a reasoning response_item, an event_msg
// mirror, the assistant response_item and a token_usage_record — mirroring
// the inspected real files (including the 3-leg resume probe rollout).
const rolloutEvents = (nTurns) => {
  const ts = (o) => new Date(100 + o).toISOString();
  const out = [
    { timestamp: ts(0), ordinal: 0, type: 'session_meta', payload: { session_id: '01a1ae2d-0000-7000-8000-00000000000a', id: '01a1ae2d-0000-7000-8000-00000000000a', cwd: '/w' } },
    { timestamp: ts(0), ordinal: 1, type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are Codex, based on GPT-5.' }] } },
    { timestamp: ts(0), ordinal: 2, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions <INSTRUCTIONS>内部规约</INSTRUCTIONS>' }, { type: 'input_text', text: '<environment_context>\n<cwd>/w</cwd>\n</environment_context>' }] } },
  ];
  let ordinal = 3;
  for (let i = 0; i < nTurns; i++) {
    out.push({ timestamp: ts(ordinal), ordinal: ordinal++, type: 'turn_context', payload: { cwd: '/w', sandbox: 'read-only' } });
    out.push({ timestamp: ts(ordinal), ordinal: ordinal++, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `问题 ${i}` }] } });
    out.push({ timestamp: ts(ordinal), ordinal: ordinal++, type: 'response_item', payload: { type: 'reasoning', summary: [], encrypted_content: 'gTM-opaque' } });
    out.push({ timestamp: ts(ordinal), ordinal: ordinal++, type: 'event_msg', payload: { type: 'item_completed', item: { id: `item_${i}`, type: 'agent_message', text: `回答 ${i}` } } });
    out.push({ timestamp: ts(ordinal), ordinal: ordinal++, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `回答 ${i}` }] } });
    out.push({ timestamp: ts(ordinal), ordinal: ordinal++, type: 'token_usage_record', payload: { info: { total_token_usage: { input_tokens: 1, output_tokens: 1 } } } });
  }
  out.push({ timestamp: ts(999), ordinal, type: 'world_state', payload: {} });
  return out;
};

const writeRollout = (codexHome, sessionId, events) => {
  const f = join(codexHome, 'sessions', '2026', '11', '06', `rollout-2026-11-06T08-06-48-${sessionId}.jsonl`);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, jsonlOf(events));
  return f;
};

test('history: codexHomeOf — providerConfig.codexHome > $CODEX_HOME > ~/.codex', () => {
  const home = mkdtempSync(join(tmpdir(), 'wao-xh-home-'));
  try {
    assert.equal(codexHomeOf({ codexHome: '/w/custom' }), '/w/custom');
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = '/w/env-home';
    try {
      assert.equal(codexHomeOf({}), '/w/env-home');
      assert.equal(codexHomeOf({ codexHome: '/w/custom' }), '/w/custom', 'explicit config wins over env');
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('history: missing session → turns=[], ≥1 warning naming the sessions tree', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-xh-miss-'));
  const codexHome = join(dir, 'codex-home');
  try {
    const r = await readHistory({ cwd: dir, codexHome }, 'no-such-session');
    assert.deepEqual(r.turns, []);
    assert.equal(r.truncated, false);
    assert.ok(r.warnings.length >= 1, 'missing file warns');
    assert.match(r.warnings[0], /session file not found: .*sessions.*no-such-session/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('history: corrupt file → warning, distinct from missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-xh-cor-'));
  const codexHome = join(dir, 'codex-home');
  try {
    const f = join(codexHome, 'sessions', '2026', '11', '06', 'rollout-2026-11-06T00-00-00-corrupt-session.jsonl');
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, Buffer.concat([Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0x00, 0x01]), Buffer.from('definitely not a rollout file')]));
    const r = await readHistory({ cwd: dir, codexHome }, 'corrupt-session');
    assert.deepEqual(r.turns, []);
    assert.equal(r.truncated, false);
    assert.ok(r.warnings.length >= 1);
    assert.match(r.warnings.join('\n'), /is not JSON/, 'corrupt bytes are a parse warning, not a throw');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('history: real rollout layout — user/assistant response_item pairs → turns, harness/noise lines skipped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-xh-real-'));
  const codexHome = join(dir, 'codex-home');
  try {
    writeRollout(codexHome, '01a1ae2d-aaaa-7bbb-8ccc-000000000001', rolloutEvents(3));
    const r = await readHistory({ cwd: dir, codexHome }, '01a1ae2d-aaaa-7bbb-8ccc-000000000001');
    assert.deepEqual(r.warnings, []);
    assert.equal(r.turns.length, 3);
    assert.deepEqual(r.turns[0], { user: '问题 0', assistant: '回答 0', at: 107 });
    assert.deepEqual(r.turns[2], { user: '问题 2', assistant: '回答 2', at: 119 });
    const json = JSON.stringify(r.turns);
    assert.ok(!json.includes('AGENTS.md'), 'harness AGENTS block excluded');
    assert.ok(!json.includes('environment_context'), 'harness environment block excluded');
    assert.ok(!json.includes('You are Codex'), 'developer instructions excluded');
    assert.ok(!json.includes('gTM-opaque'), 'reasoning ciphertext excluded');
    // a user turn answered on a later LEG still pairs (resume probe shape:
    // each leg is one user+assistant pair in the same rollout file)
    assert.ok(r.turns.every((t) => t.user && t.assistant), 'every turn pairs user with assistant');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('history: corrupt JSONL line inside an otherwise valid rollout → warning, other turns still parsed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-xh-line-'));
  const codexHome = join(dir, 'codex-home');
  try {
    const good = rolloutEvents(2);
    const f = writeRollout(codexHome, '01a1ae2d-bbbb-7ccc-8ddd-000000000002', []);
    writeFileSync(f, `${JSON.stringify(good[0])}\nNOT JSON AT ALL\n${jsonlOf(good.slice(1))}`);
    const r = await readHistory({ cwd: dir, codexHome }, '01a1ae2d-bbbb-7ccc-8ddd-000000000002');
    assert.equal(r.turns.length, 2, 'good lines survive a corrupt neighbor');
    assert.ok(r.warnings.some((w) => /is not JSON/.test(w)), 'corrupt line warns');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('history: garbage sessionId cannot traverse out of sessions/ (untrusted-input guard)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-xh-trav-'));
  const codexHome = join(dir, 'codex-home');
  try {
    // '../../escape' sanitizes to a charset-hobbled token that matches files
    // by SUFFIX inside the walked tree only — no path assembly from the id.
    const files = findRolloutFiles({ codexHome }, '../../escape');
    assert.deepEqual(files, [], 'no traversal candidates');
    assert.ok(!String(files).includes('..'));
    const r = await readHistory({ cwd: dir, codexHome }, '../../escape');
    assert.deepEqual(r.turns, []);
    assert.ok(r.warnings.length >= 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('history: huge rollout (contract fixture writer) → truncated=true, newest 2000 kept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-xh-huge-'));
  const codexHome = join(dir, 'codex-home');
  try {
    assert.equal(typeof PROFILES.codex.hugeHistory, 'function', 'contract profile provides the fixture writer');
    const f = join(codexHome, 'sessions', '2026', '11', '06', 'rollout-2026-11-06T00-00-00-huge-session.jsonl');
    mkdirSync(dirname(f), { recursive: true });
    await PROFILES.codex.hugeHistory(f);
    const r = await readHistory({ cwd: dir, codexHome }, 'huge-session');
    assert.deepEqual(r.warnings, []);
    assert.equal(r.truncated, true);
    assert.equal(r.turns.length, 2000);
    // newest-first truncation: the OLDEST 500 turns are the ones dropped
    assert.equal(r.turns[0].assistant, '回答 500');
    assert.equal(r.turns[0].user, '问题 500');
    assert.equal(r.turns[1999].assistant, '回答 2499');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
