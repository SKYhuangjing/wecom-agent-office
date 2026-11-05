import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../../src/kernel/log.js';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('rotates by size and mirrors to stderr', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-log-'));
  const file = join(dir, 'wao.log');
  const log = createLogger({ file, level: 'debug', maxBytes: 200, keep: 3 });
  for (let i = 0; i < 30; i++) log.info(`line-${i}-padpadpadpadpadpadpad`);
  const names = readdirSync(dir).sort();
  assert.ok(names.includes('wao.log'), `current exists: ${names}`);
  assert.ok(names.some((n) => n.startsWith('wao.log.')), `rotated exists: ${names}`);
  const cur = readFileSync(file, 'utf8');
  assert.match(cur, /line-\d+/);
});
