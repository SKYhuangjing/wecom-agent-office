// skillMarkdown frontmatter tests (2026-11-12 PC1 实锤:pi 的技能加载器
// 丢弃无 description 的 SKILL.md——文件在盘上却静默不进上下文)。description
// 必须永远在场：资产显式给 → 原样；缺失/空 → 兜底 name。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skillMarkdown } from '../../plugins/provider-pi/plugin.js';

test('skillMarkdown: explicit description rides verbatim (JSON-quoted)', () => {
  const md = skillMarkdown({
    assetId: 'ast-1', name: 'outer', content: { name: 'inner', description: '查台账用', body: '# 正文' },
  });
  assert.match(md, /^name: inner$/m);
  assert.match(md, /^description: "查台账用"$/m);
  assert.match(md, /^x-wao-asset: ast-1$/m);
});

test('skillMarkdown: missing/empty description falls back to the name — never absent', () => {
  for (const content of [
    { name: 'ai-service-sop', body: 'x' },
    { name: 'ai-service-sop', description: '', body: 'x' },
    { name: 'ai-service-sop', description: undefined, body: 'x' },
  ]) {
    const md = skillMarkdown({ assetId: 'ast-2', name: 'outer', content });
    assert.match(md, /^description: "ai-service-sop"$/m, `fallback present for ${JSON.stringify(content.description)}`);
  }
});
