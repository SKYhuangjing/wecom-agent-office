// Supplementary imports for the extra tests below; the brief's test code is kept verbatim.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { writeJson } from '../../src/kernel/config.js';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atomicWrite, lockDataDir, readJson } from '../../src/kernel/config.js';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';

test('atomicWrite leaves no tmp file and content intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cfg-')); const f = join(dir, 'a.json');
  atomicWrite(f, '{"x":1}');
  assert.equal(readFileSync(f, 'utf8'), '{"x":1}');
  assert.equal(existsSync(join(dir, 'a.json.tmp.' + process.pid)), false);
});
test('lockDataDir rejects second holder, adopts dead pid', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-lock-'));
  const l1 = lockDataDir(dir); assert.throws(() => lockDataDir(dir), /locked by pid/);
  l1.release(); const l2 = lockDataDir(dir); l2.release();
});
test('readJson tolerates missing/corrupt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-rj-'));
  assert.equal(readJson(join(dir, 'nope.json')), null);
  atomicWrite(join(dir, 'bad.json'), '{oops'); assert.equal(readJson(join(dir, 'bad.json')), null);
});

// The interface contract also specifies: dead holder = adopt/cleanup, and writeJson.
// The brief's tests only cover release-then-relock, so exercise the real stale-lock paths.
test('lockDataDir adopts a stale lock whose holder exited', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-stale-'));
  mkdirSync(join(dir, '.lock'));
  const dead = spawnSync(process.execPath, ['-e', '0']); // real pid, already reaped on return
  writeFileSync(join(dir, '.lock', 'pid'), String(dead.pid));
  const l = lockDataDir(dir); // ESRCH -> adopt, must not throw
  l.release();
});
test('lockDataDir adopts a lock with unparsable pid file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-badpid-'));
  mkdirSync(join(dir, '.lock'));
  writeFileSync(join(dir, '.lock', 'pid'), 'not-a-pid');
  const l = lockDataDir(dir);
  l.release();
});
test('writeJson/readJson roundtrip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-wj-'));
  writeJson(join(dir, 's.json'), { a: 1 });
  assert.deepEqual(readJson(join(dir, 's.json')), { a: 1 });
});
