// P1-B 纯函数面：seedBuiltinToolAssets 判重语义 + wizard 的 tokenSaverIds
// + defaultAssetIdsForBot / isAssetDefaultForBot（默认配置资产给新 Bot，2026-11-11）
// + memoryUpgradeHint（B 产品化装备包推荐，2026-11-10）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedBuiltinToolAssets, memoryUpgradeHint, isAssetDefaultForBot, validateAsset } from '../../plugins/core-engine/assets.js';
import { tokenSaverIds, defaultAssetIdsForBot } from '../../plugins/ui-workbench/ui/wizard.js';

test('seedBuiltinToolAssets: empty registry seeds all three tool assets (scope-recall NOT in tokenSaverIds)', () => {
  const doc = { assets: [] };
  const r = seedBuiltinToolAssets(doc);
  assert.deepEqual(r.seeded.sort(), ['ripgrep', 'rtk', 'scope-recall']);
  assert.deepEqual(r.skipped, []);
  assert.equal(doc.assets.length, 3);
  for (const a of doc.assets) {
    assert.equal(a.type, 'tool');
    assert.equal(a.origin, 'plugin');
    assert.ok(a.id.startsWith('ast-tool-'));
    assert.equal(a.content.kind, a.name);
  }
  // scope-recall 不进向导默认装备包（记忆规模驱动的升级项，手绑——不自动勾选）
  const ids = tokenSaverIds(doc.assets, 'claude');
  assert.equal(ids.filter((id) => doc.assets.find((a) => a.id === id)?.content?.kind === 'scope-recall').length, 0);
});

test('seedBuiltinToolAssets: operator assets of the same KIND win — no duplicate, no rename', () => {
  // PC1's real shape (2026-11-09): operator-created rtk/ripgrep tools migrated in.
  const doc = { assets: [
    { id: 'ast-isda63', type: 'tool', name: 'rtk', content: { kind: 'rtk' }, origin: 'operator' },
    { id: 'ast-ck1667', type: 'tool', name: 'ripgrep', content: { kind: 'ripgrep' }, origin: 'operator' },
  ] };
  const r = seedBuiltinToolAssets(doc);
  assert.deepEqual(r.seeded, ['scope-recall'], 'only the third builtin still seeds');
  assert.deepEqual(r.skipped, []);
  assert.equal(doc.assets.length, 3);
});

test('seedBuiltinToolAssets: same NAME different kind → skip with a warning (uniqueness red line)', () => {
  const doc = { assets: [{ id: 'x', type: 'tool', name: 'rtk', content: { kind: 'ripgrep' } }] };
  const r = seedBuiltinToolAssets(doc);
  assert.deepEqual(r.seeded, ['scope-recall'], 'rtk skipped (name taken), ripgrep seeds (kind absent), scope-recall seeds');
  assert.equal(r.skipped.length, 1, 'rtk skipped, name taken');
  assert.equal(doc.assets.filter((a) => a.name === 'rtk').length, 1);
});

test('seedBuiltinToolAssets: idempotent on double run', () => {
  const doc = { assets: [] };
  seedBuiltinToolAssets(doc);
  const again = seedBuiltinToolAssets(doc);
  assert.deepEqual(again.seeded, []);
  assert.equal(doc.assets.length, 3);
});

test('tokenSaverIds: rtk pre-checked only where its dedicated-dir requirement is sound (盲评 P1-4)', () => {
  const assets = [
    { id: 'a1', type: 'tool', content: { kind: 'rtk' } },
    { id: 'a2', type: 'tool', content: { kind: 'ripgrep' } },
    { id: 'a3', type: 'skill', content: { name: 'x' } },
    { id: 'a4', type: 'tool', content: { kind: 'cost-tracker' } },
  ];
  assert.deepEqual(tokenSaverIds(assets, 'claude'), ['a1', 'a2'], 'claude: auto claudeConfigDir → both');
  assert.deepEqual(tokenSaverIds(assets, 'pi'), ['a1', 'a2'], 'pi: WAO-namespaced default dir → both');
  assert.deepEqual(tokenSaverIds(assets, 'dsh'), ['a2'], 'dsh: rtk unsupported by bind face');
  assert.deepEqual(tokenSaverIds(assets, 'codex'), ['a2'], 'codex: no codexHome default — pre-checking rtk guarantees a bind failure');
  assert.deepEqual(tokenSaverIds(null, 'claude'), []);
  assert.deepEqual(tokenSaverIds([], 'claude'), []);
});

test('memoryUpgradeHint (B 产品化): fires at ≥35 notes, names the heaviest asset, silenced by a scope-recall asset', () => {
  const notes = (n) => Array.from({ length: n }, (_, i) => `note-${i}`);
  // 远低于阈值 → null；恰好 35 → 提示
  assert.equal(memoryUpgradeHint([{ type: 'memory', name: 'm1', content: { notes: notes(34) } }]), null);
  const hint = memoryUpgradeHint([{ type: 'memory', name: 'm1', content: { notes: notes(35) } }]);
  assert.match(hint, /m1.*35\/50 条/);
  assert.match(hint, /scope-recall/);
  // 多个 memory 资产取最重的那个说
  const heaviest = memoryUpgradeHint([
    { type: 'memory', name: 'light', content: { notes: notes(35) } },
    { type: 'memory', name: 'heavy', content: { notes: notes(41) } },
  ]);
  assert.match(heaviest, /heavy.*41\/50 条/);
  // 已有 scope-recall 工具资产 → 不再提示
  assert.equal(memoryUpgradeHint([
    { type: 'memory', name: 'm1', content: { notes: notes(49) } },
    { type: 'tool', name: 'sr', content: { kind: 'scope-recall' } },
  ]), null);
  // 边界：非 memory / 空 notes / 空清单都不炸
  assert.equal(memoryUpgradeHint(null), null);
  assert.equal(memoryUpgradeHint([]), null);
  assert.equal(memoryUpgradeHint([{ type: 'memory', name: 'm', content: {} }]), null);
});

test('defaultAssetIdsForBot & isAssetDefaultForBot: 除了 scope-recall 应该都是默认的（用户裁定 2026-11-11）', () => {
  const assets = [
    { id: 'a-rtk', type: 'tool', name: 'rtk', content: { kind: 'rtk' } },
    { id: 'a-rg', type: 'tool', name: 'ripgrep', content: { kind: 'ripgrep' } },
    { id: 'a-sr', type: 'tool', name: 'scope-recall', content: { kind: 'scope-recall' } },
    { id: 'a-cost', type: 'tool', name: 'cost-tracker', content: { kind: 'cost-tracker' } },
    { id: 'a-mcp', type: 'mcp', name: 'oneaix-sls', content: { servers: {} } },
    { id: 'a-skill', type: 'skill', name: 'sls-usage', content: { name: 'sls-usage', body: '# doc' } },
    { id: 'a-mem', type: 'memory', name: 'biz-memory', content: { notes: ['note'] } },
    // 显式配置覆盖
    { id: 'a-sr-forced', type: 'tool', name: 'scope-recall-custom', content: { kind: 'scope-recall' }, defaultForNewBots: true },
    { id: 'a-rg-disabled', type: 'tool', name: 'ripgrep-optout', content: { kind: 'ripgrep' }, defaultForNewBots: false },
  ];

  // claude 引擎下：
  // 1. scope-recall 缺省时必须为 false（排除）
  // 2. 其余普通资产缺省时全部为 true（包含 rtk, ripgrep, cost-tracker, mcp, skill, memory）
  // 3. 显式覆盖：a-sr-forced 强制为 true；a-rg-disabled 强制为 false
  const claudeDefs = defaultAssetIdsForBot(assets, 'claude');
  assert.ok(claudeDefs.includes('a-rtk'), 'rtk is default for claude');
  assert.ok(claudeDefs.includes('a-rg'), 'ripgrep is default');
  assert.ok(!claudeDefs.includes('a-sr'), 'scope-recall is NOT default by default');
  assert.ok(claudeDefs.includes('a-cost'), 'cost-tracker is default');
  assert.ok(claudeDefs.includes('a-mcp'), 'mcp is default');
  assert.ok(claudeDefs.includes('a-skill'), 'skill is default');
  assert.ok(claudeDefs.includes('a-mem'), 'memory is default');
  assert.ok(claudeDefs.includes('a-sr-forced'), 'scope-recall with defaultForNewBots=true is included');
  assert.ok(!claudeDefs.includes('a-rg-disabled'), 'asset with defaultForNewBots=false is excluded');

  // 引擎兼容性硬边界保护：
  // dsh 和 codex 不支持 rtk 自动预选（避免向导后绑定报错）
  const dshDefs = defaultAssetIdsForBot(assets, 'dsh');
  assert.ok(!dshDefs.includes('a-rtk'), 'rtk unsupported on dsh');
  assert.ok(dshDefs.includes('a-rg'), 'ripgrep supported on dsh');
  assert.ok(dshDefs.includes('a-mcp'), 'mcp supported on dsh');

  const codexDefs = defaultAssetIdsForBot(assets, 'codex');
  assert.ok(!codexDefs.includes('a-rtk'), 'rtk unsupported for default on codex');
  assert.ok(codexDefs.includes('a-rg'), 'ripgrep supported on codex');

  // 空值/脏值防护
  assert.deepEqual(defaultAssetIdsForBot(null, 'claude'), []);
  assert.deepEqual(defaultAssetIdsForBot([], 'claude'), []);
  assert.equal(isAssetDefaultForBot(null, 'claude'), false);
  assert.equal(isAssetDefaultForBot({}, 'claude'), true);
});

test('validateAsset: defaultForNewBots must be boolean if present', () => {
  const valid = { type: 'skill', name: 'test-skill', content: { name: 'test-skill', body: '# test' }, defaultForNewBots: true };
  assert.deepEqual(validateAsset(valid), []);

  const invalid = { type: 'skill', name: 'test-skill', content: { name: 'test-skill', body: '# test' }, defaultForNewBots: 'yes' };
  const errs = validateAsset(invalid);
  assert.ok(errs.some((e) => e.includes('defaultForNewBots must be a boolean')));
});
