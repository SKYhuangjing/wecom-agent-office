// M2 Task 2 unit grid: plugins/provider-claude/history.js — reads claude's
// REAL on-disk session format into the §5 readHistory tolerance shape
// {turns, truncated, warnings}. The fixtures replicate the format discovered
// by running a real `claude -p` (T1-style probe, claude 2.1.318) and
// inspecting the file it wrote — see the format documentation block at the
// top of history.js. Tolerance is the contract: missing / corrupt /
// oversized history is a warning, never a throw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { readHistory, historyCandidates, projectDirName } from '../../plugins/provider-claude/history.js';
import { PROFILES } from '../contract/profiles.js';

const jsonlOf = (events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

// One claude session file: user prompt (string content), noise lines, an
// assistant reply split as thinking-line + text-line (real shape), tool
// round-trip (tool_use in assistant, tool_result coming back on a USER line),
// isMeta harness line — mirroring the inspected real files.
const sessionEvents = (nTurns, { withTool = false } = {}) => {
  const out = [{ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-11-06T00:00:00.000Z', sessionId: 's', content: 'noise' }];
  for (let i = 0; i < nTurns; i++) {
    const ts = new Date(100 + i).toISOString();
    out.push({ parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: `问题 ${i}` }, uuid: `u${i}`, timestamp: ts, cwd: '/w', sessionId: 's' });
    if (i === 0) {
      // harness-injected meta user line must not count as a user turn
      out.push({ type: 'user', isMeta: true, isSidechain: false, message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>内部提示</system-reminder>' }] }, timestamp: ts });
    }
    if (withTool && i === 0) {
      out.push({ isSidechain: false, type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `call_${i}`, name: 'Bash', input: { command: 'ls' } }] }, timestamp: ts });
      // tool results return as USER lines with tool_result blocks — not turns
      out.push({ isSidechain: false, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `call_${i}`, content: 'file1\nfile2' }] }, timestamp: ts });
    }
    if (withTool && i === 1) {
      // sidechain (subagent) lines must not count either
      out.push({ isSidechain: true, type: 'user', message: { role: 'user', content: '子代理的输入' }, timestamp: ts });
      out.push({ isSidechain: true, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '子代理的回答' }] }, timestamp: ts });
    }
    out.push({ isSidechain: false, type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: `思考 ${i}`, signature: 'x' }] }, timestamp: ts });
    out.push({ isSidechain: false, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `回答 ${i}` }] }, timestamp: ts });
  }
  out.push({ type: 'cost-state', sessionId: 's', totalCostUSD: 0 });
  return out;
};

const writeSession = (configDir, cwd, sessionId, events) => {
  const f = join(configDir, 'projects', projectDirName(cwd), `${sessionId}.jsonl`);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, jsonlOf(events));
  return f;
};

test('history: projectDirName — non-alphanumerics collapse to dashes (real claude slugging)', () => {
  assert.equal(projectDirName('/Users/sky/dev/workbuddy_workspace/wecom-agent-office'), '-Users-sky-dev-workbuddy-workspace-wecom-agent-office');
  assert.equal(projectDirName('/tmp/wao.x_y'), '-tmp-wao-x-y');
});

test('history: missing session → turns=[], ≥1 warning naming the path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-ch-miss-'));
  const configDir = join(dir, 'claude-home');
  try {
    const r = await readHistory({ cwd: dir, claudeConfigDir: configDir }, 'no-such-session');
    assert.deepEqual(r.turns, []);
    assert.equal(r.truncated, false);
    assert.ok(r.warnings.length >= 1, 'missing file warns');
    assert.match(r.warnings[0], /session file not found: .*no-such-session/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('history: corrupt file → warning, distinct from missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-ch-cor-'));
  const configDir = join(dir, 'claude-home');
  try {
    const f = join(configDir, 'projects', projectDirName(dir), 'corrupt-session.jsonl');
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, Buffer.concat([Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0x00, 0x01]), Buffer.from('definitely not a session file')]));
    const r = await readHistory({ cwd: dir, claudeConfigDir: configDir }, 'corrupt-session');
    assert.deepEqual(r.turns, []);
    assert.equal(r.truncated, false);
    assert.ok(r.warnings.length >= 1);
    assert.match(r.warnings.join('\n'), /is not JSON/, 'corrupt bytes are a parse warning, not a throw');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('history: real layout — turns from user/assistant lines, noise/meta/tool_result/sidechain skipped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-ch-real-'));
  const configDir = join(dir, 'claude-home');
  try {
    writeSession(configDir, dir, '16cc03ca-bc7f-4aa7-aad4-b37e1b0d4e3a', sessionEvents(3, { withTool: true }));
    const r = await readHistory({ cwd: dir, claudeConfigDir: configDir }, '16cc03ca-bc7f-4aa7-aad4-b37e1b0d4e3a');
    assert.deepEqual(r.warnings, []);
    assert.equal(r.turns.length, 3);
    assert.deepEqual(r.turns[0], { user: '问题 0', assistant: '回答 0', at: 100 });
    assert.deepEqual(r.turns[2], { user: '问题 2', assistant: '回答 2', at: 102 });
    assert.ok(!JSON.stringify(r.turns).includes('子代理'), 'sidechain lines excluded');
    assert.ok(!JSON.stringify(r.turns).includes('system-reminder'), 'meta lines excluded');
    assert.ok(!JSON.stringify(r.turns).includes('file1'), 'tool_result lines excluded');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('history: realpath spelling probed — /tmp cwd found via -private-tmp (macOS real-claude behavior)', async () => {
  const tmpReal = realpathSync('/tmp');
  if (tmpReal === '/tmp') return; // linux: raw spelling IS the realpath — nothing extra to probe
  const name = `wao-ch-${process.pid}`;
  mkdirSync(`${tmpReal}/${name}`, { recursive: true });
  const configDir = mkdtempSync(join(tmpdir(), 'wao-ch-rl-'));
  try {
    // real claude writes under the REALPATH escape; the bot config carries
    // the raw /tmp spelling (verified against a real run in this workspace).
    writeSession(configDir, `${tmpReal}/${name}`, 'rp-probe', sessionEvents(1));
    const r = await readHistory({ cwd: `/tmp/${name}`, claudeConfigDir: configDir }, 'rp-probe');
    assert.deepEqual(r.warnings, []);
    assert.equal(r.turns.length, 1, 'session found through the realpath escape');
  } finally {
    rmSync(configDir, { recursive: true, force: true });
    rmSync(`${tmpReal}/${name}`, { recursive: true, force: true });
  }
});

test('history: garbage sessionId cannot traverse out of projects/ (untrusted-input guard)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-ch-trav-'));
  const configDir = join(dir, 'claude-home');
  try {
    // '../../escape' sanitizes to 'escape' — a plain basename inside the
    // project dir, never a path leaving projects/.
    const candidates = historyCandidates({ cwd: dir, claudeConfigDir: configDir }, '../../escape');
    assert.ok(candidates.length >= 1);
    assert.ok(candidates.every((f) => !f.includes('..')), `no traversal segments survive (${candidates.join(',')})`);
    assert.ok(candidates.every((f) => f.startsWith(join(configDir, 'projects'))), `candidates stay under projects/ (${candidates.join(',')})`);
    const r = await readHistory({ cwd: dir, claudeConfigDir: configDir }, '../../escape');
    assert.deepEqual(r.turns, []);
    assert.ok(r.warnings.length >= 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('history: corrupt JSONL line inside an otherwise valid file → warning, other turns still parsed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-ch-line-'));
  const configDir = join(dir, 'claude-home');
  try {
    const good = sessionEvents(2);
    const text = `${JSON.stringify(good[0])}\nNOT JSON AT ALL\n${jsonlOf(good.slice(1))}`;
    const f = join(configDir, 'projects', projectDirName(dir), 's-lines.jsonl');
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, text);
    const r = await readHistory({ cwd: dir, claudeConfigDir: configDir }, 's-lines');
    assert.equal(r.turns.length, 2, 'good lines survive a corrupt neighbor');
    assert.ok(r.warnings.some((w) => /is not JSON/.test(w)), 'corrupt line warns');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('history: huge session (contract fixture writer) → truncated=true, newest 2000 kept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-ch-huge-'));
  const configDir = join(dir, 'claude-home');
  try {
    assert.equal(typeof PROFILES.claude.hugeHistory, 'function', 'contract profile provides the fixture writer');
    const f = join(configDir, 'projects', projectDirName(dir), 'huge-session.jsonl');
    mkdirSync(dirname(f), { recursive: true });
    await PROFILES.claude.hugeHistory(f);
    const r = await readHistory({ cwd: dir, claudeConfigDir: configDir }, 'huge-session');
    assert.deepEqual(r.warnings, []);
    assert.equal(r.truncated, true);
    assert.equal(r.turns.length, 2000);
    // newest-first truncation: the OLDEST 500 turns are the ones dropped
    assert.equal(r.turns[0].assistant, '回答 500');
    assert.equal(r.turns[1999].assistant, '回答 2499');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
