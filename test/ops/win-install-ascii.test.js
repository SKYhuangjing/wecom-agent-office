// win-install.ps1 编码红线（2026-11-10 PC2 真机复发）：脚本必须 UTF-8 BOM +
// 纯 ASCII——PS 5.1 对无 BOM 的 UTF-8 按 GBK 解码，任何中文注释/全角字符都
// 是下一次装机现场的 ParserError（TerminatorExpectedAtEndOfString）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const file = join(repoRoot, 'scripts', 'win-install.ps1');

test('win-install.ps1: UTF-8 BOM present (PS 5.1 hard requirement)', () => {
  const raw = readFileSync(file);
  assert.deepEqual([...raw.slice(0, 3)], [0xef, 0xbb, 0xbf], 'must start with the UTF-8 BOM');
});

test('win-install.ps1: pure ASCII body — a single CJK char decodes as GBK garbage on PS 5.1', () => {
  const raw = readFileSync(file);
  const body = raw.slice(3); // skip BOM
  for (const b of body) {
    assert.ok(b < 0x80, `non-ASCII byte 0x${b.toString(16)} found — PS 5.1 will GBK-decode it`);
  }
});
