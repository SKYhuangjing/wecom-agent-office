import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { createLogger } from '../../src/kernel/log.js';
import { mkdtempSync, readdirSync, readFileSync, chmodSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('rotates by size; healthy file mode writes the file only (no stderr mirror)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-log-'));
  const file = join(dir, 'wao.log');
  const log = createLogger({ file, level: 'debug', maxBytes: 200, keep: 3 });
  // launchd log governance: while the file is healthy, stderr (and thus
  // launchd.err.log) must stay silent — the file is the single sink.
  const quiet = captureStderr(() => { log.info('quiet-0-padpadpadpadpadpad'); });
  assert.equal(quiet.length, 0, `healthy file logging mirrors nothing to stderr (got ${JSON.stringify(quiet)})`);
  for (let i = 0; i < 30; i++) log.info(`line-${i}-padpadpadpadpadpadpad`);
  const names = readdirSync(dir).sort();
  assert.ok(names.includes('wao.log'), `current exists: ${names}`);
  assert.ok(names.some((n) => n.startsWith('wao.log.')), `rotated exists: ${names}`);
  const cur = readFileSync(file, 'utf8');
  assert.match(cur, /line-\d+/);
});

test('pure stderr mode (no file) keeps mirroring to stderr', () => {
  const log = createLogger({ level: 'info' });
  const lines = captureStderr(() => { log.info('stderr only line'); });
  assert.ok(lines.some((l) => l.includes('stderr only line')), 'no-file logger still writes stderr');
});

// ENOSPC hardening (M1 minor #3, done in M3-T9): file-side failures must
// degrade to stderr-only (one warn) instead of throwing into callers. We
// provoke REAL syscall failures (EACCES via a read-only parent dir) rather
// than an fs mock — log.js binds writeSync/openSync as ESM named imports,
// which mock.method on the CJS exports cannot intercept.
const captureStderr = (fn) => {
  const lines = [];
  const m = mock.method(process.stderr, 'write', (s) => { lines.push(String(s)); return true; });
  try { fn(); } finally { m.mock.restore(); }
  return lines;
};

test('file open failure at creation degrades to stderr-only (no throw, one warn)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-log-eno-'));
  try {
    chmodSync(dir, 0o500); // openSync(file,'a') inside → EACCES
    const file = join(dir, 'wao.log');
    let log;
    const lines = captureStderr(() => {
      log = createLogger({ file, level: 'debug' });
      log.info('after creation failure');   // must not throw
      log.warn('still alive');              // must not throw
    });
    assert.equal(lines.filter((l) => l.includes('degraded to stderr-only')).length, 1, 'exactly one degrade warn');
    assert.ok(lines.some((l) => l.includes('after creation failure')), 'stderr mirror keeps working');
    assert.ok(!existsSync(file), 'no file was created');
  } finally {
    chmodSync(dir, 0o700);
  }
});

test('mid-stream file failure degrades to stderr-only (no throw, one warn)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-log-mid-'));
  const file = join(dir, 'wao.log');
  const log = createLogger({ file, level: 'debug' });
  log.info('first line');   // file created, fd open
  unlinkSync(file);         // next write: writeSync appends to the unlinked
                            // inode, then statSync(file) throws ENOENT inside
                            // the write path — the class of failure the
                            // try-wrap must swallow (a read-only dir does NOT
                            // work here: append-open on an existing file
                            // needs no directory write permission)
  const lines = captureStderr(() => {
    log.info('second line hits the failing stat'); // must not throw
    log.info('third line after degrade');          // must not throw
  });
  assert.equal(lines.filter((l) => l.includes('degraded to stderr-only')).length, 1, 'exactly one degrade warn');
  assert.ok(lines.some((l) => l.includes('third line after degrade')), 'stderr mirror keeps working');
  assert.ok(!existsSync(file), 'degraded logger never recreates the file');
});
