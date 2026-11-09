// P1-B 纯函数面：seedBuiltinToolAssets 判重语义 + wizard 的 tokenSaverIds。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedBuiltinToolAssets } from '../../plugins/core-engine/assets.js';
import { tokenSaverIds } from '../../plugins/ui-workbench/ui/wizard.js';

test('seedBuiltinToolAssets: empty registry seeds both tool assets', () => {
  const doc = { assets: [] };
  const r = seedBuiltinToolAssets(doc);
  assert.deepEqual(r.seeded.sort(), ['ripgrep', 'rtk']);
  assert.deepEqual(r.skipped, []);
  assert.equal(doc.assets.length, 2);
  for (const a of doc.assets) {
    assert.equal(a.type, 'tool');
    assert.equal(a.origin, 'plugin');
    assert.ok(a.id.startsWith('ast-tool-'));
    assert.equal(a.content.kind, a.name);
  }
});

test('seedBuiltinToolAssets: operator assets of the same KIND win — no duplicate, no rename', () => {
  // PC1's real shape (2026-11-09): operator-created rtk/ripgrep tools migrated in.
  const doc = { assets: [
    { id: 'ast-isda63', type: 'tool', name: 'rtk', content: { kind: 'rtk' }, origin: 'operator' },
    { id: 'ast-ck1667', type: 'tool', name: 'ripgrep', content: { kind: 'ripgrep' }, origin: 'operator' },
  ] };
  const r = seedBuiltinToolAssets(doc);
  assert.deepEqual(r.seeded, []);
  assert.deepEqual(r.skipped, []);
  assert.equal(doc.assets.length, 2, 'nothing appended');
});

test('seedBuiltinToolAssets: same NAME different kind → skip with a warning (uniqueness red line)', () => {
  const doc = { assets: [{ id: 'x', type: 'tool', name: 'rtk', content: { kind: 'ripgrep' } }] };
  const r = seedBuiltinToolAssets(doc);
  assert.deepEqual(r.seeded, []);
  assert.equal(r.skipped.length, 1, 'rtk skipped, name taken');
  // kind-dedupe fires first for ripgrep? no — ripgrep kind absent AND name free → seeds
  assert.deepEqual(r.seeded, []);
  assert.equal(doc.assets.filter((a) => a.name === 'rtk').length, 1);
});

test('seedBuiltinToolAssets: idempotent on double run', () => {
  const doc = { assets: [] };
  seedBuiltinToolAssets(doc);
  const again = seedBuiltinToolAssets(doc);
  assert.deepEqual(again.seeded, []);
  assert.equal(doc.assets.length, 2);
});

test('tokenSaverIds: rtk + ripgrep for claude-like providers; dsh gets ripgrep only', () => {
  const assets = [
    { id: 'a1', type: 'tool', content: { kind: 'rtk' } },
    { id: 'a2', type: 'tool', content: { kind: 'ripgrep' } },
    { id: 'a3', type: 'skill', content: { name: 'x' } },
    { id: 'a4', type: 'tool', content: { kind: 'cost-tracker' } },
  ];
  assert.deepEqual(tokenSaverIds(assets, 'claude'), ['a1', 'a2']);
  assert.deepEqual(tokenSaverIds(assets, 'dsh'), ['a2'], 'dsh bind face refuses rtk');
  assert.deepEqual(tokenSaverIds(null, 'claude'), []);
  assert.deepEqual(tokenSaverIds([], 'claude'), []);
});
