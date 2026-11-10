// §7.4 unit suite (B 产品化, 2026-11-10): the scope-recall state machine inside
// the REAL core materializer, driven by a stub provider port (planning only)
// and test/fake-bin/fake-scope-recall.js + fake-uv.js (the actor halves).
// Covers:
//   - 三态：unavailable（CLI 与 uv 都缺：绑定保留零产物+注记）/ armed（主路径：
//     probe→setup --home/--store→回读断言（安装收据+hooks 文件）→manifest.tools；
//     uv 兜底路径：CLI 缺但有 uv → tool install → 候选重探→setup）/ failed
//     （setup 非零→throw 带 stderr 摘要；回读断言失败（收据漂移）同 failed）
//   - 与 rtk 共存（实证 Phase 0 §5-2）：settings.json 的 rtk PreToolUse 条目
//     原样保留——scope-recall hooks 走插件 bundle，不碰 settings.json
//   - 卸载：apply-uninstall 主路径 + WAO 清扫残片（收据/attachment/scope-recall/
//     目录/per-bot store）；CLI 缺失时纯 WAO 清扫兜底
//   - checkBind：仅 claude+claudeConfigDir 可绑（dsh/codex/pi 拒）
// 真实 CLI 的实跑证据在 docs/MEMORY-RESEARCH.md §5（Phase 0，2026-11-10）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMaterializer } from '../../plugins/core-engine/materializer.js';
import { noopMaterializer } from '../../plugins/core-engine/assets.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FAKE_SR = join(REPO, 'test/fake-bin/fake-scope-recall.js');
const FAKE_UV = join(REPO, 'test/fake-bin/fake-uv.js');

let root;
let realHome;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'wao-sr-unit-'));
  // 隔离 homedir：resolveScopeRecall 的候选 #2 是 ~/.local/bin/scope-recall——
  // 不换 HOME 会探到开发机真装的 scope-recall（Phase 0 装的），套件就不封闭了。
  realHome = process.env.HOME;
  process.env.HOME = join(root, 'home');
  mkdirSync(process.env.HOME, { recursive: true });
  chmodSync(FAKE_SR, 0o755);
  chmodSync(FAKE_UV, 0o755);
});
after(() => {
  if (realHome !== undefined) process.env.HOME = realHome; else delete process.env.HOME;
  rmSync(root, { recursive: true, force: true });
});

const scenario = (name) => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};

// Stub provider port: a scope-recall tool entry in the plan → a
// scope-recall-init write（真 provider-claude 的计划形状）.
const stubProvider = () => ({
  materializeAssets: async (bot, plan) => ({
    writes: (Array.isArray(plan) ? plan : [])
      .filter((e) => e?.type === 'tool' && e?.content?.kind === 'scope-recall')
      .map((e) => ({ kind: 'scope-recall-init', target: bot.providerConfig.claudeConfigDir, for: e.assetId, owned: false })),
    notes: [],
    entries: [],
  }),
});
const matOver = (sc, { scopeRecallBin = 'no-such-scope-recall', uvBin = 'no-such-uv' } = {}) => createMaterializer({
  ports: { getProvider: () => stubProvider() },
  dataDir: join(sc, 'data'),
  scopeRecallBin,
  uvBin,
  log: { info() {}, warn() {}, error() {} },
});

const SR_ENTRY = { assetId: 'ast-sr1', type: 'tool', name: 'scope-recall', mode: 'shared', content: { kind: 'scope-recall' } };
const RTK_ENTRY = { assetId: 'ast-rtk1', type: 'tool', name: 'rtk', mode: 'shared', content: { kind: 'rtk' } };
const claudeBotOver = (sc, cfgDir) => ({ id: 'sr-b1', provider: 'claude', providerConfig: { cwd: join(sc, 'cwd'), claudeConfigDir: cfgDir } });
const manifestOf = (mat, bot) => JSON.parse(readFileSync(join(mat.assetsDir, bot.id, 'manifest.json'), 'utf8'));
const setFakeMode = (sc, mode) => {
  process.env.FAKE_SR_MODE = mode;
  process.env.FAKE_SR_LOG = join(sc, 'sr-calls.log');
};
const clearFakeMode = () => {
  delete process.env.FAKE_SR_MODE;
  delete process.env.FAKE_SR_LOG;
  delete process.env.FAKE_UV_LOG;
};
const SR_OWN_PATHS = (cfgDir) => [
  join(cfgDir, '.scope-recall-install-receipt.json'),
  join(cfgDir, 'scope-recall-attachment.lock'),
  join(cfgDir, 'scope-recall'),
  join(cfgDir, 'skills', 'scope-recall'),
  join(cfgDir, 'scope-recall-store'),
];
// 试点期/操作者预装内容（P1-1 盲评场景）：同名 skills/scope-recall/ + 记忆库
// 先于 WAO 存在——unavailable 态的解绑/删 bot 绝不能把它当残片扫掉。
const preseedOperatorContent = (cfgDir) => {
  mkdirSync(join(cfgDir, 'skills', 'scope-recall'), { recursive: true });
  writeFileSync(join(cfgDir, 'skills', 'scope-recall', 'SKILL.md'), '# 操作者手工预装\n');
  mkdirSync(join(cfgDir, 'scope-recall-store'), { recursive: true });
  writeFileSync(join(cfgDir, 'scope-recall-store', 'memory.sqlite3'), 'operator pilot memory\n');
};

test('state unavailable: CLI and uv both missing → bind-safe no-op products, note + manifest.tools + toolWarnings', async () => {
  const sc = scenario('unavailable');
  const cfgDir = join(sc, 'claude-cfg');
  const bot = claudeBotOver(sc, cfgDir);
  const mat = matOver(sc);
  const r = await mat.materialize(bot, [SR_ENTRY]);
  assert.equal(existsSync(cfgDir), false, 'zero products in unavailable state');
  assert.ok(r.notes.some((n) => /scope-recall 未安装且无 uv（unavailable）/.test(n.detail) && /uv tool install hermes-scope-recall/.test(n.detail)), 'note carries the install path out');
  const manifest = manifestOf(mat, bot);
  assert.equal(manifest.tools.find((t) => t.kind === 'scope-recall').state, 'unavailable');
  // P2-2（盲评）：writes 行如实记 state——unavailable 不再被恒标 mode:'scope-recall-setup'
  const row = manifest.writes.find((w) => w.kind === 'scope-recall-init');
  assert.equal(row.state, 'unavailable', 'row state is truthful');
  assert.equal(row.mode, undefined, 'unavailable rows carry no equip-mode');
  assert.deepEqual(mat.toolWarnings(bot, [SR_ENTRY]), ['scope-recall 未安装且无 uv：工具资产未装备（unavailable）——装 uv（brew install uv / 设置页工具装备）后 POST rematerialize-assets，会自动 uv tool install hermes-scope-recall 并装备'], 'agents-face standing warning');
  // noop materializer keeps the same seam: no tool warnings (T1 contract)
  assert.deepEqual(noopMaterializer().toolWarnings(bot, [SR_ENTRY]), []);
});

test('state armed (main path): setup --home/--store → readback receipt+hooks → manifest.tools armed v4.0.3; settings.json (rtk entry) untouched', async () => {
  const sc = scenario('armed');
  const cfgDir = join(sc, 'claude-cfg');
  mkdirSync(cfgDir, { recursive: true });
  // 预置 rtk 已装备的 settings.json（Phase 0 实证共存形状）——scope-recall 不得碰它
  writeFileSync(join(cfgDir, 'settings.json'), `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] }] } }, null, 2)}\n`);
  const bot = claudeBotOver(sc, cfgDir);
  setFakeMode(sc, 'ok');
  const mat = matOver(sc, { scopeRecallBin: FAKE_SR });
  try {
    const r = await mat.materialize(bot, [SR_ENTRY]);
    assert.ok(r.notes.some((n) => /scope-recall 已配置（4\.0\.3，claude-code 插件面/.test(n.detail) && /原文检索模式/.test(n.detail)), 'armed note names version + 原文检索模式');
    // 写盘面：插件 bundle 四件套 + 安装收据 + per-bot store（全在 bot 配置目录内）
    assert.ok(existsSync(join(cfgDir, 'skills', 'scope-recall', 'hooks', 'hooks.json')), 'plugin hooks file');
    assert.ok(existsSync(join(cfgDir, '.scope-recall-install-receipt.json')), 'install receipt');
    assert.ok(existsSync(join(cfgDir, 'scope-recall', 'attachment.json')), 'attachment (memory retained face)');
    assert.ok(existsSync(join(cfgDir, 'scope-recall-store', 'memory.sqlite3')), 'per-bot store inside the config dir');
    // settings.json 原样（rtk PreToolUse 条目保留——与 rtk 零冲突）
    const settings = JSON.parse(readFileSync(join(cfgDir, 'settings.json'), 'utf8'));
    assert.deepEqual(settings.hooks.PreToolUse, [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] }], 'rtk hook entry untouched');
    const manifest = manifestOf(mat, bot);
    const t = manifest.tools.find((x) => x.kind === 'scope-recall');
    assert.equal(t.state, 'armed');
    assert.equal(t.mode, 'scope-recall-setup');
    assert.equal(t.version, '4.0.3');
    const row = manifest.writes.find((w) => w.kind === 'scope-recall-init');
    assert.equal(row.owned, false, 'the config dir is never whole-file deleted');
    assert.equal(row.mode, 'scope-recall-setup');
    // 幂等：重物化无害（setup 对已装备面=repair，回读断言再过一遍）
    await mat.materialize(bot, [SR_ENTRY]);
    assert.equal(manifestOf(mat, bot).tools.find((x) => x.kind === 'scope-recall').state, 'armed', 'idempotent re-materialize stays armed');
    assert.deepEqual(mat.toolWarnings(bot, [SR_ENTRY]), [], 'armed ⇒ no standing agents warning');
  } finally {
    clearFakeMode();
  }
});

test('uv fallback leg: CLI missing but uv present → tool install hermes-scope-recall → candidate #2 (~/.local/bin) → setup armed', async () => {
  const sc = scenario('uv-fallback');
  const cfgDir = join(sc, 'claude-cfg');
  const bot = claudeBotOver(sc, cfgDir);
  process.env.FAKE_UV_LOG = join(sc, 'uv-calls.log');
  setFakeMode(sc, 'ok'); // fake uv copies fake-scope-recall.js — the shim honors the same env
  // 独立 HOME：uv 装出的 shim 只活在本次场景里——否则候选 #2 会漏给后续测试
  // （unavailable/unload-nosr 都依赖「~/.local/bin/scope-recall 不存在」）。
  const fileHome = process.env.HOME;
  process.env.HOME = join(sc, 'home');
  mkdirSync(process.env.HOME, { recursive: true });
  const mat = matOver(sc, { scopeRecallBin: join(sc, 'no-such-scope-recall'), uvBin: FAKE_UV });
  try {
    const r = await mat.materialize(bot, [SR_ENTRY]);
    // P1-2（盲评）：uv 收到的必须是钉版 spec——浮动 latest 被拒
    assert.match(readFileSync(process.env.FAKE_UV_LOG, 'utf8').trim(), /^tool install hermes-scope-recall==4\.0\.3$/, 'uv tool install pinned (==4.0.3)');
    assert.ok(r.notes.some((n) => /经 uv 装备（uv tool install hermes-scope-recall==4\.0\.3/.test(n.detail)), 'note names the pinned spec');
    assert.ok(existsSync(join(cfgDir, '.scope-recall-install-receipt.json')), 'setup ran via the freshly installed shim');
    assert.equal(manifestOf(mat, bot).tools.find((t) => t.kind === 'scope-recall').state, 'armed');
    // shim 落位 = uv 的真实布局（~/.local/bin/scope-recall），候选解析可复现
    assert.ok(existsSync(join(process.env.HOME, '.local', 'bin', 'scope-recall')), 'shim at the uv tool layout');
  } finally {
    process.env.HOME = fileHome;
    clearFakeMode();
  }
});

test('state failed: setup non-zero → throw with stderr summary (真 CLI 的 symlink 拒绝文案随出); manifest lastResult failed', async () => {
  const sc = scenario('failed');
  const cfgDir = join(sc, 'claude-cfg');
  const bot = claudeBotOver(sc, cfgDir);
  setFakeMode(sc, 'fail');
  const mat = matOver(sc, { scopeRecallBin: FAKE_SR });
  try {
    await assert.rejects(mat.materialize(bot, [SR_ENTRY]), /scope-recall setup 失败（exit 1）：.*symlink or reparse paths are not allowed/);
    const manifest = manifestOf(mat, bot);
    assert.match(manifest.lastResult, /^failed:scope-recall setup 失败/);
  } finally {
    clearFakeMode();
  }
});

test('readback drift: setup ok but install receipt missing → failed (回读断言), not silent success', async () => {
  const sc = scenario('drift');
  const cfgDir = join(sc, 'claude-cfg');
  const bot = claudeBotOver(sc, cfgDir);
  setFakeMode(sc, 'drift');
  const mat = matOver(sc, { scopeRecallBin: FAKE_SR });
  try {
    await assert.rejects(mat.materialize(bot, [SR_ENTRY]), /回读断言失败/);
  } finally {
    clearFakeMode();
  }
});

test('unload (armed): apply-uninstall runs + WAO sweeps every own path (receipt/attachment/scope-recall//store)', async () => {
  const sc = scenario('unload');
  const cfgDir = join(sc, 'claude-cfg');
  const bot = claudeBotOver(sc, cfgDir);
  setFakeMode(sc, 'ok');
  const mat = matOver(sc, { scopeRecallBin: FAKE_SR });
  try {
    await mat.materialize(bot, [SR_ENTRY]);
    const r = await mat.materialize(bot, []);
    assert.ok(r.notes.some((n) => /scope-recall 卸载成功/.test(n.detail)), 'apply-uninstall executed');
    for (const p of SR_OWN_PATHS(cfgDir)) {
      assert.equal(existsSync(p), false, `swept: ${p}`);
    }
    assert.match(readFileSync(process.env.FAKE_SR_LOG, 'utf8').trim().split('\n').at(-1), /^apply-uninstall ok$/, 'apply-uninstall was the last scope-recall invocation');
  } finally {
    clearFakeMode();
  }
});

test('unload with CLI MISSING at uninstall time: WAO-known-path sweep still cleans everything', async () => {
  const sc = scenario('unload-nosr');
  const cfgDir = join(sc, 'claude-cfg');
  const bot = claudeBotOver(sc, cfgDir);
  setFakeMode(sc, 'ok');
  const matArmed = matOver(sc, { scopeRecallBin: FAKE_SR });
  await matArmed.materialize(bot, [SR_ENTRY]);
  clearFakeMode();
  // CLI 消失（ops 删了二进制）——清扫兜底不依赖 apply-uninstall
  const matGone = matOver(sc);
  const r = await matGone.materialize(bot, []);
  assert.ok(r.notes.some((n) => /scope-recall CLI 缺失/.test(n.detail)), 'note explains the fallback');
  for (const p of SR_OWN_PATHS(cfgDir)) {
    assert.equal(existsSync(p), false, `swept without the CLI: ${p}`);
  }
});

test('unload with rtk STILL BOUND (same config dir): (path,kind) coverage — scope-recall swept, rtk products intact', async () => {
  // B 产品化实证回归（2026-11-10 真机发现）：rtk-init 与 scope-recall-init 同指
  // 一个配置目录——stale 覆盖判据只按 path 时，解绑 scope-recall 会被仍在绑的
  // rtk 行「覆盖」，卸载静默不跑。断言按 (path,kind) 判覆盖后两个互不干扰。
  const sc = scenario('unload-rtk-bound');
  const cfgDir = join(sc, 'claude-cfg');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'settings.json'), '{}\n'); // hook-entry 宿主文件（条目型只写进既有 JSON）
  const bot = claudeBotOver(sc, cfgDir);
  setFakeMode(sc, 'ok');
  const mat = createMaterializer({
    ports: {
      getProvider: () => ({
        // rtk + scope-recall 双绑的计划形状（rtk 走回退路径的自写条目——真 rtk
        // 不进本测试，只验证卸载互不干扰）
        materializeAssets: async (b, plan) => ({
          writes: (Array.isArray(plan) ? plan : [])
            .filter((e) => e?.type === 'tool')
            .flatMap((e) => (e.content.kind === 'scope-recall'
              ? [{ kind: 'scope-recall-init', target: b.providerConfig.claudeConfigDir, for: e.assetId, owned: false }]
              : [{ kind: 'hook-entry', target: join(b.providerConfig.claudeConfigDir, 'settings.json'), pointer: '/hooks/PreToolUse', content: { matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] }, for: e.assetId }])),
          notes: [],
          entries: [],
        }),
      }),
    },
    dataDir: join(sc, 'data'),
    scopeRecallBin: FAKE_SR,
    rtkBin: join(sc, 'no-such-rtk'),
    log: { info() {}, warn() {}, error() {} },
  });
  try {
    await mat.materialize(bot, [SR_ENTRY, RTK_ENTRY]);
    assert.ok(existsSync(join(cfgDir, '.scope-recall-install-receipt.json')), 'both equipped');
    // 只解绑 scope-recall（rtk 留在计划里）
    await mat.materialize(bot, [RTK_ENTRY]);
    for (const p of SR_OWN_PATHS(cfgDir)) {
      assert.equal(existsSync(p), false, `scope-recall swept while rtk stays bound: ${p}`);
    }
    const settings = JSON.parse(readFileSync(join(cfgDir, 'settings.json'), 'utf8'));
    assert.deepEqual(settings.hooks.PreToolUse, [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] }], 'rtk entry intact');
  } finally {
    clearFakeMode();
  }
});

test('P1-1（盲评）unavailable 态解绑/删 bot：操作者预装的同名内容一概不动（绝不按名盲删）', async () => {
  const sc = scenario('p11-unavailable-preseed');
  const cfgDir = join(sc, 'claude-cfg');
  mkdirSync(cfgDir, { recursive: true });
  preseedOperatorContent(cfgDir);
  const bot = claudeBotOver(sc, cfgDir);
  const mat = matOver(sc);
  await mat.materialize(bot, [SR_ENTRY]); // unavailable（无 CLI 无 uv），manifest 行 state=unavailable
  // 解绑（stale 卸载路径）
  const r = await mat.materialize(bot, []);
  assert.ok(r.notes.some((n) => /unavailable 态，WAO 零产物/.test(n.detail)), 'skip note names the unavailable gate');
  assert.ok(existsSync(join(cfgDir, 'skills', 'scope-recall', 'SKILL.md')), 'operator-preinstalled plugin face survives unbind');
  assert.equal(readFileSync(join(cfgDir, 'scope-recall-store', 'memory.sqlite3'), 'utf8'), 'operator pilot memory\n', 'operator memory store survives unbind');
  // 删 bot（removeAssets 路径）同款不删
  const rm = await mat.removeAssets(bot);
  assert.ok(existsSync(join(cfgDir, 'skills', 'scope-recall', 'SKILL.md')), 'operator content survives bot DELETE');
  assert.equal(readFileSync(join(cfgDir, 'scope-recall-store', 'memory.sqlite3'), 'utf8'), 'operator pilot memory\n', 'memory survives bot DELETE');
  assert.equal(rm.removed, false, 'nothing was WAO-removed');
});

test('P1-1（盲评）armed 后收据被手删：卸载跳过并告警（收据=属主凭证，缺证不删）', async () => {
  const sc = scenario('p11-receipt-gone');
  const cfgDir = join(sc, 'claude-cfg');
  const bot = claudeBotOver(sc, cfgDir);
  setFakeMode(sc, 'ok');
  const mat = matOver(sc, { scopeRecallBin: FAKE_SR });
  try {
    await mat.materialize(bot, [SR_ENTRY]);
    unlinkSync(join(cfgDir, '.scope-recall-install-receipt.json')); // 用户手删收据
    const r = await mat.materialize(bot, []);
    assert.ok(r.notes.some((n) => /无安装收据=非本次 WAO 装备/.test(n.detail)), 'receipt gate note');
    assert.ok(existsSync(join(cfgDir, 'skills', 'scope-recall', 'hooks', 'hooks.json')), 'products stay without the ownership proof');
  } finally {
    clearFakeMode();
  }
});

test('P1-1（盲评）清单行 path 非法（空/相对/越界绝对路径）：清扫拒绝并告警，不猜不删', async () => {
  const sc = scenario('p11-bad-paths');
  const cfgDir = join(sc, 'claude-cfg');
  mkdirSync(join(sc, 'cwd'), { recursive: true });
  const bot = claudeBotOver(sc, cfgDir);
  const mat = matOver(sc);
  // 越界绝对路径：收据在位（过属主门）但目录不在任何允许根 → jail 门拦截
  const outside = join(sc, 'outside-install');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, '.scope-recall-install-receipt.json'), '{}\n');
  writeFileSync(join(outside, 'keep.txt'), 'manual scope-recall install from another life\n');
  const manifestFile = join(mat.assetsDir, bot.id, 'manifest.json');
  mkdirSync(dirname(manifestFile), { recursive: true });
  writeFileSync(manifestFile, `${JSON.stringify({
    botId: bot.id,
    writes: [
      { path: '', action: 'write', owned: false, kind: 'scope-recall-init', state: 'armed' },
      { path: 'relative/scope-recall', action: 'write', owned: false, kind: 'scope-recall-init', state: 'armed' },
      { path: outside, action: 'write', owned: false, kind: 'scope-recall-init', state: 'armed' },
    ],
    entries: [],
    lastMaterializedAt: Date.now(),
    lastResult: 'ok',
  }, null, 2)}\n`);
  const r = await mat.materialize(bot, []);
  assert.ok(r.notes.some((n) => /path 非法（""，须非空绝对路径）/.test(n.detail)), 'empty path refused');
  assert.ok(r.notes.some((n) => /path 非法（"relative\/scope-recall"/.test(n.detail)), 'relative path refused');
  assert.ok(r.notes.some((n) => /清扫目标越界/.test(n.detail)), 'out-of-jail absolute path refused');
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'manual scope-recall install from another life\n', 'nothing deleted outside the jail');
  // 服务进程 CWD 下不存在 relative/scope-recall——若清扫盲跑会以 CWD 为基准
  assert.equal(existsSync(join(process.cwd(), 'relative', 'scope-recall')), false, 'no CWD-relative sweep side effect');
});

test('P2-3（盲评）首次 setup 半装失败：manifest 记 failed 行，解绑时按收据回收残片', async () => {
  const sc = scenario('p23-halffail');
  const cfgDir = join(sc, 'claude-cfg');
  const bot = claudeBotOver(sc, cfgDir);
  setFakeMode(sc, 'halffail'); // 插件面+收据全写盘后 exit 1（真实半装形状）
  const mat = matOver(sc, { scopeRecallBin: FAKE_SR });
  try {
    await assert.rejects(mat.materialize(bot, [SR_ENTRY]), /scope-recall setup 失败（exit 1）/);
    const manifest = manifestOf(mat, bot);
    assert.match(manifest.lastResult, /^failed:scope-recall setup 失败/);
    const row = manifest.writes.find((w) => w.kind === 'scope-recall-init');
    assert.ok(row != null, 'the ATTEMPT is recorded on the failure manifest (首败也有行)');
    assert.equal(row.state, 'failed');
    assert.ok(existsSync(join(cfgDir, '.scope-recall-install-receipt.json')), 'half-install debris on disk');
    // 解绑：行在+收据在 → apply-uninstall + 清扫回收
    const r = await mat.materialize(bot, []);
    assert.ok(r.notes.some((n) => /scope-recall 卸载成功/.test(n.detail)), 'half-install reclaimed on unbind');
    for (const p of SR_OWN_PATHS(cfgDir)) {
      assert.equal(existsSync(p), false, `reclaimed: ${p}`);
    }
  } finally {
    clearFakeMode();
  }
});

test('P2-1（盲评）toolWarnings 文案与装备机同源：CLI 缺但 uv 在位 → 指重物化而非装 uv', () => {
  const sc = scenario('p21-warning-copy');
  const mat = matOver(sc, { scopeRecallBin: join(sc, 'no-such-scope-recall'), uvBin: FAKE_UV });
  const bot = claudeBotOver(sc, join(sc, 'claude-cfg'));
  assert.deepEqual(mat.toolWarnings(bot, [SR_ENTRY]),
    ['scope-recall CLI 未就绪但 uv 在位：POST rematerialize-assets 会自动 uv tool install hermes-scope-recall 并装备'],
    'uv-present copy points at rematerialize (auto-install), not at installing uv again');
});

test('checkBind: v1 support matrix — claude+claudeConfigDir ok; claude shared-dir / codex / pi / dsh refused (both seams)', () => {
  const sc = scenario('bind-guard');
  const mat = matOver(sc, { scopeRecallBin: FAKE_SR });
  const asset = { type: 'tool', name: 'sr', content: { kind: 'scope-recall' } };
  assert.deepEqual(mat.checkBind({ id: 'c1', provider: 'claude', providerConfig: { cwd: sc, claudeConfigDir: join(sc, 'cfg') } }, asset), [], 'claude + dedicated dir ok');
  assert.ok(mat.checkBind({ id: 'c2', provider: 'claude', providerConfig: { cwd: sc } }, asset).some((e) => /要求 bot 配置专属目录（claudeConfigDir）/), 'shared-home claude refused');
  assert.ok(mat.checkBind({ id: 'c3', provider: 'codex', providerConfig: { cwd: sc, codexHome: join(sc, 'codex') } }, asset).some((e) => /v1 仅支持 claude 引擎/), 'codex refused (v1)');
  assert.ok(mat.checkBind({ id: 'c4', provider: 'pi', providerConfig: { cwd: sc, piAgentDir: join(sc, 'pi') } }, asset).some((e) => /v1 仅支持 claude 引擎/), 'pi refused (v1)');
  assert.ok(mat.checkBind({ id: 'c5', provider: 'dsh', providerConfig: { cwd: sc } }, asset).some((e) => /dsh 岗位不支持 scope-recall/), 'dsh refused with its own copy');
  // noop seam mirrors the same matrix (T1 contract, assets.js)
  const noop = noopMaterializer();
  assert.deepEqual(noop.checkBind({ id: 'n1', provider: 'claude', providerConfig: { cwd: sc, claudeConfigDir: join(sc, 'cfg') } }, asset), []);
  assert.ok(noop.checkBind({ id: 'n2', provider: 'codex', providerConfig: { cwd: sc } }, asset).some((e) => /v1 仅支持 claude 引擎/), 'noop seam keeps the provider refusal');
  assert.ok(noop.checkBind({ id: 'n3', provider: 'claude', providerConfig: { cwd: sc } }, asset).some((e) => /专属目录/), 'noop seam keeps the dedicated-dir refusal');
});

test('provider plan face: provider-claude plans scope-recall-init only when redirected (shared-dir note otherwise)', async () => {
  // 真 provider-claude 的 materializeAssets（纯计划面）——claudeConfigDir 在位
  // 才出 scope-recall-init 写（绑定面已拒共享目录 bot，这里验计划面的防御性）。
  const { default: plugin } = await import('../../plugins/provider-claude/plugin.js');
  let port = null;
  plugin.activate({ registerProvider: (id, p) => { port = p; } });
  const { materializeAssets } = port;
  assert.equal(typeof materializeAssets, 'function');
  const bot = { id: 'sr-plan', provider: 'claude', providerConfig: { cwd: '/tmp/wao-sr-plan-cwd', claudeConfigDir: '/tmp/wao-sr-plan-cfg' } };
  const out = await materializeAssets(bot, [SR_ENTRY], { log: { info() {} }, assetsDir: '/tmp/wao-sr-plan-assets' });
  assert.deepEqual(out.writes, [{ kind: 'scope-recall-init', target: '/tmp/wao-sr-plan-cfg', for: 'ast-sr1', owned: false }], 'plans the external-command write against the config dir');
  const shared = await materializeAssets({ ...bot, providerConfig: { cwd: '/tmp/wao-sr-plan-cwd' } }, [SR_ENTRY], { log: { info() {} }, assetsDir: '/tmp/wao-sr-plan-assets' });
  assert.deepEqual(shared.writes, [], 'no write for a shared-dir bot');
  assert.ok(shared.notes.some((n) => /scope-recall 要求 claudeConfigDir/), 'defensive note present');
});
