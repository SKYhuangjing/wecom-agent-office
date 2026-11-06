// Unit grid: plugins/provider-pi/history.js — reads pi's REAL on-disk session
// format into the §5 readHistory tolerance shape {turns, truncated, warnings}.
// Fixtures replicate the format captured by the live probe (2026-11-07,
// @earendil-works/pi-coding-agent 1.5.0 via magpie; see history.js header and
// test/probe-baselines/pi-history-roundtrip.ndjson). Tolerance is the
// contract: missing / corrupt / oversized history is a warning, never a throw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHistory, piSessionSlug, piAgentDirOf, cwdSlugs, findSessionFiles } from '../../plugins/provider-pi/history.js';
import { PROFILES } from '../contract/profiles.js';

const jsonlOf = (entries) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

// One pi session file: header noise entries (session/model_change/
// thinking_level_change), the system-message replay, then user/assistant
// turns — assistant messages may carry thinking blocks (skipped) and the
// shape real pi writes (verified against the probe session file).
const sessionEntries = (nTurns) => {
  const out = [
    { type: 'session', version: 3, id: 's', timestamp: '2026-11-06T16:26:11.297Z', cwd: '/w' },
    { type: 'model_change', model: { id: 'auto/glm-5.3-flash' } },
    { type: 'thinking_level_change', thinkingLevel: 'off' },
    { type: 'message', message: { role: 'system', content: '', sections: { preamble: 'You are a coding assistant.' } } },
  ];
  for (let i = 0; i < nTurns; i++) {
    out.push({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: `问题 ${i}` }] } });
    out.push({
      type: 'message',
      message: {
        role: 'assistant',
        content: i === 0
          ? [{ type: 'thinking', thinking: '想一想', thinkingSignature: 'sig' }, { type: 'text', text: `回答 ${i}` }]
          : [{ type: 'text', text: `回答 ${i}` }],
        stopReason: 'stop',
      },
    });
  }
  return out;
};

const writeSession = (agentDir, cwd, sessionId, entries) => {
  const dir = join(agentDir, 'sessions', piSessionSlug(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `2026-11-06T16-26-11-297Z_${sessionId}.jsonl`), jsonlOf(entries));
};

test('history: pi cwd slug matches the live-probe value', () => {
  // captured 2026-11-07: cwd /private/tmp/wao-pi-probe/work → --private-tmp-wao-pi-probe-work--
  assert.equal(piSessionSlug('/private/tmp/wao-pi-probe/work'), '--private-tmp-wao-pi-probe-work--');
  // only ONE leading slash is stripped; / \ : are the only replaced characters
  assert.equal(piSessionSlug('/a/b:c'), '--a-b-c--');
  assert.equal(piSessionSlug(''), '----');
  // parity with the suite's profile slugger (same formula, duplicated by design)
  assert.ok(PROFILES.pi.historyPath('/w', 'x').includes(piSessionSlug('/w')),
    'profile historyPath and the reader agree on the slug');
});

test('history: two-round session parses into turns; thinking blocks and noise skipped', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wao-pi-hist-'));
  try {
    const agentDir = join(root, 'pi-agent');
    const cwd = join(root, 'work');
    mkdirSync(cwd, { recursive: true });
    writeSession(agentDir, cwd, 'sid-1', sessionEntries(3));
    const r = readHistory({ cwd, piAgentDir: agentDir }, 'sid-1');
    assert.equal(r.truncated, false);
    assert.equal(r.warnings.length, 0);
    assert.equal(r.turns.length, 3);
    assert.equal(r.turns[0].user, '问题 0');
    assert.equal(r.turns[0].assistant, '回答 0', 'thinking block not leaked into the text');
    assert.equal(r.turns[2].assistant, '回答 2');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('history: missing session → turns=[] + warning; never throws', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wao-pi-hmiss-'));
  try {
    const r = readHistory({ cwd: join(root, 'work'), piAgentDir: join(root, 'pi-agent') }, 'no-such');
    assert.deepEqual(r.turns, []);
    assert.equal(r.truncated, false);
    assert.ok(r.warnings.length >= 1 && r.warnings[0].includes('not found'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('history: corrupt file → warning, never throws', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wao-pi-hcor-'));
  try {
    const agentDir = join(root, 'pi-agent');
    const cwd = join(root, 'work');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(agentDir, 'sessions', piSessionSlug(cwd)), { recursive: true });
    writeFileSync(
      join(agentDir, 'sessions', piSessionSlug(cwd), '2026-11-06T00-00-00-000Z_corrupt.jsonl'),
      Buffer.concat([Buffer.from([0xff, 0xfe, 0xfd]), Buffer.from('not json')]),
    );
    const r = readHistory({ cwd, piAgentDir: agentDir }, 'corrupt');
    assert.deepEqual(r.turns, []);
    assert.ok(r.warnings.some((w) => w.includes('not JSON')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('history: oversized → newest TURN_LIMIT kept, truncated=true', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wao-pi-hhuge-'));
  try {
    const agentDir = join(root, 'pi-agent');
    const cwd = join(root, 'work');
    mkdirSync(cwd, { recursive: true });
    writeSession(agentDir, cwd, 'big', sessionEntries(2100));
    const r = readHistory({ cwd, piAgentDir: agentDir }, 'big');
    assert.equal(r.truncated, true);
    assert.equal(r.turns.length, 2000);
    assert.equal(r.turns[0].user, '问题 100', 'oldest tail dropped, newest kept');
    assert.equal(r.turns.at(-1).assistant, '回答 2099');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('history: realpath slug probed first (macOS /tmp), raw resolve slug as belt', () => {
  const root = mkdtempSync(join(tmpdir(), 'wao-pi-hslug-'));
  try {
    const cwd = join(root, 'work');
    mkdirSync(cwd, { recursive: true });
    const slugs = cwdSlugs(cwd);
    // mkdtemp under tmpdir(): the raw and realpath slugs may be identical
    // (case-insensitive /var ↔ /private/var only differs through the symlink)
    assert.ok(slugs.length >= 1 && slugs.every((s) => s.startsWith('--') && s.endsWith('--')));
    // the profile's historyPath fixture lands in the RAW slug — the reader
    // must find it via the second candidate when realpath differs
    const fixtureDir = join(root, 'pi-agent', 'sessions', slugs.at(-1));
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(join(fixtureDir, '2026-11-06T00-00-00-000Z_finds.jsonl'), jsonlOf(sessionEntries(1)));
    const r = readHistory({ cwd, piAgentDir: join(root, 'pi-agent') }, 'finds');
    assert.equal(r.turns.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('history: piAgentDirOf precedence — pc → $PI_CODING_AGENT_DIR → per-bot default', () => {
  const saved = process.env.PI_CODING_AGENT_DIR;
  try {
    delete process.env.PI_CODING_AGENT_DIR;
    assert.equal(piAgentDirOf({}, 'bot9'), join(homedir(), '.pi', 'agent-wao-bot9'));
    process.env.PI_CODING_AGENT_DIR = '/env/dir';
    assert.equal(piAgentDirOf({}), '/env/dir');
    assert.equal(piAgentDirOf({ piAgentDir: '/pc/dir' }), '/pc/dir', 'providerConfig wins over env');
  } finally {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
  }
});

test('history: session id sanitized — traversal attempts never escape sessions/', () => {
  const root = mkdtempSync(join(tmpdir(), 'wao-pi-hsafe-'));
  try {
    const agentDir = join(root, 'pi-agent');
    mkdirSync(join(agentDir, 'sessions'), { recursive: true });
    const evil = readHistory({ cwd: '/w', piAgentDir: agentDir }, '../../etc/passwd');
    assert.deepEqual(evil.turns, []);
    assert.ok(evil.warnings[0].includes('not found'));
    // findSessionFiles with a hostile id finds nothing and touches nothing
    assert.deepEqual(findSessionFiles({ cwd: '/w', piAgentDir: agentDir }, '../..'), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
