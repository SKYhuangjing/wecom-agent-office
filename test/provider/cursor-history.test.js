// Unit grid: plugins/provider-cursor/history.js — tolerance contract
// (missing/corrupt/oversized = warning, never a throw) over the working-
// hypothesis layout <cursorHome>/projects/**/<sessionId>.jsonl (claude-
// shaped lines; recalibrate against the live probe when it lands).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readHistory, cursorHomeOf, findSessionFiles } from '../../plugins/provider-cursor/history.js';

const jsonlOf = (entries) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

const sessionEntries = (nTurns) => {
  const out = [{ type: 'queue-operation', operation: 'enqueue', sessionId: 's', content: 'noise' }];
  for (let i = 0; i < nTurns; i++) {
    const ts = new Date(100 + i).toISOString();
    out.push({ type: 'user', isSidechain: false, message: { role: 'user', content: `问题 ${i}` }, timestamp: ts });
    out.push({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: `回答 ${i}` }] }, timestamp: ts });
  }
  return out;
};

const writeSession = (home, slug, sessionId, entries) => {
  const dir = join(home, 'projects', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), jsonlOf(entries));
};

test('history: two-round session parses into turns (string user content tolerated)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wao-cu-hist-'));
  try {
    const home = join(root, 'cursor-home');
    writeSession(home, 'slug-a', 'sid-1', sessionEntries(3));
    const r = readHistory({ cursorHome: home }, 'sid-1');
    assert.equal(r.truncated, false);
    assert.equal(r.warnings.length, 0);
    assert.equal(r.turns.length, 3);
    assert.equal(r.turns[0].user, '问题 0');
    assert.equal(r.turns[0].assistant, '回答 0');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('history: walker finds the session at ANY projects/ depth (slug rule not load-bearing)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wao-cu-walk-'));
  try {
    const home = join(root, 'cursor-home');
    writeSession(home, join('deep', 'nested', 'slug'), 'sid-2', sessionEntries(1));
    const r = readHistory({ cursorHome: home }, 'sid-2');
    assert.equal(r.turns.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('history: missing session → turns=[] + warning; corrupt → warning; never throws', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wao-cu-hmiss-'));
  try {
    const home = join(root, 'cursor-home');
    mkdirSync(join(home, 'projects'), { recursive: true });
    const miss = readHistory({ cursorHome: home }, 'no-such');
    assert.deepEqual(miss.turns, []);
    assert.ok(miss.warnings[0].includes('not found'));

    writeFileSync(join(home, 'projects', `${'corrupt'}.jsonl`), Buffer.concat([
      Buffer.from([0xff, 0xfe]), Buffer.from('not json'),
    ]));
    const cor = readHistory({ cursorHome: home }, 'corrupt');
    assert.deepEqual(cor.turns, []);
    assert.ok(cor.warnings.some((w) => w.includes('not JSON')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('history: oversized → newest TURN_LIMIT kept, truncated=true', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wao-cu-hhuge-'));
  try {
    const home = join(root, 'cursor-home');
    writeSession(home, 'slug-b', 'big', sessionEntries(2100));
    const r = readHistory({ cursorHome: home }, 'big');
    assert.equal(r.truncated, true);
    assert.equal(r.turns.length, 2000);
    assert.equal(r.turns[0].user, '问题 100', 'oldest tail dropped, newest kept');
    assert.equal(r.turns.at(-1).assistant, '回答 2099');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('history: cursorHomeOf precedence — pc → $CURSOR_CONFIG_DIR → ~/.cursor', () => {
  const saved = process.env.CURSOR_CONFIG_DIR;
  try {
    delete process.env.CURSOR_CONFIG_DIR;
    assert.equal(cursorHomeOf({}), join(homedir(), '.cursor'));
    process.env.CURSOR_CONFIG_DIR = '/env/dir';
    assert.equal(cursorHomeOf({}), '/env/dir');
    assert.equal(cursorHomeOf({ cursorHome: '/pc/dir' }), '/pc/dir', 'providerConfig wins over env');
  } finally {
    if (saved === undefined) delete process.env.CURSOR_CONFIG_DIR;
    else process.env.CURSOR_CONFIG_DIR = saved;
  }
});

test('history: session id sanitized — traversal attempts never escape projects/', () => {
  const root = mkdtempSync(join(tmpdir(), 'wao-cu-hsafe-'));
  try {
    const home = join(root, 'cursor-home');
    mkdirSync(join(home, 'projects'), { recursive: true });
    const evil = readHistory({ cursorHome: home }, '../../etc/passwd');
    assert.deepEqual(evil.turns, []);
    assert.ok(evil.warnings[0].includes('not found'));
    assert.deepEqual(findSessionFiles({ cursorHome: home }, '../..'), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
