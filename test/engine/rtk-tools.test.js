// W3 T3 unit suite: the §7.1 RTK state machine + §7.2 ripgrep precheck inside
// the REAL core materializer (plugins/core-engine/materializer.js), driven by
// a stub provider port (planning only — the executor is what's under test)
// and the programmable fake rtk (test/fake-bin/fake-rtk.js). Covers:
//   - 三态：unavailable（二进制缺失：绑定保留零产物+注记）/ armed（主路径：
//     dry-run 前缀校验→真跑→回读断言→.bak 清扫；回退路径：dry-run 越界/非零
//     → WAO 自写 hook 条目，条目全文进 manifest）/ failed（真跑非零→throw 带
//     stderr 摘要，manifest lastResult failed）
//   - 卸载：rtk uninstall 主路径（幂等、.bak 清扫）；rtk 缺失→条目精确匹配删
//     兜底；回退装备→精确匹配删；用户手改条目→告警不删（§3.6）
//   - manifest.tools（rtk 态 + ripgrep 预检结论）、toolWarnings（agents 面）
//   - checkBind：claude 共享目录拒、pi 默认目录放行（per-bot 命名空间）
// The REAL-rtk init/uninstall round lives in test/contract/rtk-round.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMaterializer, probeBin, invalidateProbe } from '../../plugins/core-engine/materializer.js';
import { noopMaterializer } from '../../plugins/core-engine/assets.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FAKE_RTK = join(REPO, 'test/fake-bin/fake-rtk.js');

let root;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'wao-rtk-unit-'));
  chmodSync(FAKE_RTK, 0o755);
});
after(() => rmSync(root, { recursive: true, force: true }));

const scenario = (name) => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};

// Stub provider port: plans exactly what a test needs (the planner shapes are
// the real providers' — rtk-init rows + tools rows from materializeAssets).
// The stub maps the PLAN to writes: an rtk entry in the plan → an rtk-init
// write; an empty plan → no writes (unload path).
const stubProvider = (writeOf) => ({
  materializeAssets: async (bot, plan) => ({
    writes: (Array.isArray(plan) ? plan : []).filter((e) => e?.type === 'tool' && e?.content?.kind === 'rtk').flatMap((e) => writeOf(e)),
    notes: [],
    entries: [],
  }),
});
const matOver = (impl, dataDir, rtkBin) => createMaterializer({
  ports: { getProvider: () => impl },
  dataDir,
  rtkBin,
  log: { info() {}, warn() {}, error() {} },
});

const RTK_ENTRY = { assetId: 'ast-rtk1', type: 'tool', name: 'rtk', mode: 'shared', content: { kind: 'rtk' } };
const claudeBotOver = (sc, cfgDir) => ({ id: 'rtk-b1', provider: 'claude', providerConfig: { cwd: join(sc, 'cwd'), claudeConfigDir: cfgDir } });
const rtkWrite = (target, flavor = 'claude') => () => [{ kind: 'rtk-init', target, flavor, for: 'ast-rtk1', owned: false }];
const manifestOf = (mat, bot) => JSON.parse(readFileSync(join(mat.assetsDir, bot.id, 'manifest.json'), 'utf8'));
const setFakeMode = (sc, mode) => {
  process.env.FAKE_RTK_MODE = mode;
  process.env.FAKE_RTK_LOG = join(sc, 'rtk-calls.log');
};
const clearFakeMode = () => {
  delete process.env.FAKE_RTK_MODE;
  delete process.env.FAKE_RTK_LOG;
};

test('state unavailable: rtk binary missing → bind-safe no-op products, note + manifest.tools + toolWarnings', async () => {
  const sc = scenario('unavailable');
  const cfgDir = join(sc, 'claude-cfg');
  const bot = claudeBotOver(sc, cfgDir);
  const mat = matOver(stubProvider(rtkWrite(cfgDir)), join(sc, 'data'), join(sc, 'no-such-rtk'));
  const r = await mat.materialize(bot, [RTK_ENTRY]);
  assert.equal(existsSync(join(cfgDir, 'settings.json')), false, 'zero products in unavailable state');
  assert.ok(r.notes.some((n) => /rtk 未安装（unavailable）/.test(n.detail)), 'note carries install guidance');
  const manifest = manifestOf(mat, bot);
  assert.equal(manifest.tools.find((t) => t.kind === 'rtk').state, 'unavailable');
  assert.deepEqual(mat.toolWarnings(bot, [RTK_ENTRY]), ['rtk 未安装：工具资产未装备（unavailable）——安装 rtk 后 POST rematerialize-assets 装备'], 'agents-face standing warning');
  // noop materializer keeps the same seam (T1 contract): no tool warnings.
  assert.deepEqual(noopMaterializer().toolWarnings(bot, [RTK_ENTRY]), []);
});

// 2026-11-10 PC1 真机回归：升级后首次 rematerialize 把 rtk 判 unavailable（二进制
// 明明在、手动 rematerialize 即 armed）——根因 probeBin 默认 3s，Windows 二进制
// 首执冷启动 >3s 超时。fake --version 睡 4s（>旧 3s，<新 15s）：旧超时必判
// unavailable，新超时须 armed。invalidateProbe 清缓存，否则命中前例 ok 绕过探测。
test('rtk probe survives a 4s cold-start --version (Windows Defender scan) → armed, not unavailable', async () => {
  const sc = scenario('rtk-slow-probe');
  const cfgDir = join(sc, 'claude-cfg');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'CLAUDE.md'), '# 用户段\n');
  const bot = claudeBotOver(sc, cfgDir);
  setFakeMode(sc, 'ok');
  process.env.FAKE_RTK_VERSION_SLEEP_MS = '4000';
  invalidateProbe(FAKE_RTK);
  const mat = matOver(stubProvider(rtkWrite(cfgDir)), join(sc, 'data'), FAKE_RTK);
  try {
    await mat.materialize(bot, [RTK_ENTRY]);
    const t = manifestOf(mat, bot).tools.find((x) => x.kind === 'rtk');
    assert.equal(t.state, 'armed', 'a slow-but-present rtk must not be misread as unavailable');
    assert.match(t.version, /^fake-rtk 9\.9\.9/);
  } finally {
    delete process.env.FAKE_RTK_VERSION_SLEEP_MS;
    invalidateProbe(FAKE_RTK);
    clearFakeMode();
  }
});

test('state armed (main path): dry-run prefix check → real init → readback entry into manifest, .bak swept, idempotent bytes', async () => {
  const sc = scenario('armed');
  const cfgDir = join(sc, 'claude-cfg');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'CLAUDE.md'), '# 用户段\n');
  const bot = claudeBotOver(sc, cfgDir);
  setFakeMode(sc, 'ok');
  const mat = matOver(stubProvider(rtkWrite(cfgDir)), join(sc, 'data'), FAKE_RTK);
  try {
    const r = await mat.materialize(bot, [RTK_ENTRY]);
    assert.ok(r.notes.some((n) => /rtk 已配置（fake-rtk 9\.9\.9，flavor claude，主路径）/.test(n.detail)), 'armed note names version+flavor');
    const settings = JSON.parse(readFileSync(join(cfgDir, 'settings.json'), 'utf8'));
    assert.deepEqual(settings.hooks.PreToolUse, [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] }], 'rtk hook entry present (V5 shape)');
    assert.ok(existsSync(join(cfgDir, 'RTK.md')), 'RTK.md created');
    assert.match(readFileSync(join(cfgDir, 'CLAUDE.md'), 'utf8'), /# 用户段\n@RTK\.md\n$/, 'user text intact + @RTK.md ref appended');
    assert.equal(existsSync(join(cfgDir, 'settings.json.bak')), false, 'rtk .bak residue swept');
    const manifest = manifestOf(mat, bot);
    const t = manifest.tools.find((x) => x.kind === 'rtk');
    assert.equal(t.state, 'armed');
    assert.equal(t.mode, 'rtk-init');
    assert.match(t.version, /^fake-rtk 9\.9\.9/);
    const row = manifest.writes.find((w) => w.kind === 'rtk-init');
    assert.equal(row.flavor, 'claude');
    assert.equal(row.owned, false, 'the config dir is never whole-file deleted');
    assert.deepEqual(manifest.entries, [{
      file: join(cfgDir, 'settings.json'),
      pointer: '/hooks/PreToolUse',
      entry: { matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] },
      via: 'rtk',
    }], 'entry full text recorded for the precise-delete fallback');
    // idempotence: second materialization leaves byte-identical products
    const snap = { settings: readFileSync(join(cfgDir, 'settings.json'), 'utf8'), md: readFileSync(join(cfgDir, 'CLAUDE.md'), 'utf8') };
    await mat.materialize(bot, [RTK_ENTRY]);
    assert.equal(readFileSync(join(cfgDir, 'settings.json'), 'utf8'), snap.settings);
    assert.equal(readFileSync(join(cfgDir, 'CLAUDE.md'), 'utf8'), snap.md);
    // armed ⇒ no standing agents warning
    assert.deepEqual(mat.toolWarnings(bot, [RTK_ENTRY]), []);
  } finally {
    clearFakeMode();
  }
});

test('state failed: rtk init non-zero → materialize throws with stderr summary; manifest lastResult failed (回执 failed[] 上游)', async () => {
  const sc = scenario('failed');
  const cfgDir = join(sc, 'claude-cfg');
  const bot = claudeBotOver(sc, cfgDir);
  setFakeMode(sc, 'initfail');
  const mat = matOver(stubProvider(rtkWrite(cfgDir)), join(sc, 'data'), FAKE_RTK);
  try {
    await assert.rejects(mat.materialize(bot, [RTK_ENTRY]), /rtk init 失败（flavor claude，exit 1）：.*stderr detail/);
    const manifest = manifestOf(mat, bot);
    assert.match(manifest.lastResult, /^failed:rtk init 失败/);
    assert.equal(existsSync(join(cfgDir, 'settings.json')), false, 'failed init leaves no hook file');
  } finally {
    clearFakeMode();
  }
});

test('fallback path (§7.1 dual path): dry-run outside-root / dry-run non-zero → WAO-written hook entry, full text in manifest, no rtk subprocess writes', async () => {
  for (const mode of ['outside', 'dryfail']) {
    const sc = scenario(`fallback-${mode}`);
    const cfgDir = join(sc, 'claude-cfg');
    const bot = claudeBotOver(sc, cfgDir);
    setFakeMode(sc, mode);
    const mat = matOver(stubProvider(rtkWrite(cfgDir)), join(sc, 'data'), FAKE_RTK);
    try {
      const r = await mat.materialize(bot, [RTK_ENTRY]);
      const reason = mode === 'outside' ? /越界路径：\/tmp\/wao-rtk-outside-evil\/filters\.toml/ : /dry-run 非零/;
      assert.ok(r.notes.some((n) => reason.test(n.detail) && /回退路径装备/.test(n.detail)), `fallback note names the reason (${mode})`);
      const settings = JSON.parse(readFileSync(join(cfgDir, 'settings.json'), 'utf8'));
      assert.deepEqual(settings.hooks.PreToolUse, [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] }], 'WAO-written JSON entry (§3.6 条目型)');
      assert.equal(existsSync(join(cfgDir, 'RTK.md')), false, 'no RTK.md in fallback (no rtk product writes)');
      const manifest = manifestOf(mat, bot);
      const t = manifest.tools.find((x) => x.kind === 'rtk');
      assert.equal(t.state, 'armed');
      assert.equal(t.mode, 'wao-hook');
      assert.equal(manifest.writes.find((w) => w.kind === 'rtk-init').mode, 'wao-hook', 'manifest row records the fallback mode');
      assert.deepEqual(manifest.entries.map((e) => e.entry), [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] }], 'entry full text for precise delete');
      assert.ok(!('via' in manifest.entries[0]), 'fallback entries are WAO-owned (no via:rtk)');
    } finally {
      clearFakeMode();
    }
  }
});

test('fallback for pi: no JSON hook face (extensions/rtk.ts is version-coupled) → degraded note, not fabricated, not fatal (2026-11-12: 单优化器缺席不再拖垮整轮物化)', async () => {
  const sc = scenario('pi-fallback');
  const agentDir = join(sc, 'pi-agent');
  const bot = { id: 'rtk-pi1', provider: 'pi', providerConfig: { cwd: join(sc, 'cwd'), model: { model: 'm1' }, piAgentDir: agentDir } };
  setFakeMode(sc, 'outside');
  const mat = matOver(stubProvider(rtkWrite(agentDir, 'pi')), join(sc, 'data'), FAKE_RTK);
  try {
    const r = await mat.materialize(bot, [{ ...RTK_ENTRY, content: { kind: 'rtk' } }]);
    assert.ok(r.notes.some((n) => /pi 无 JSON hook 面（extensions\/rtk\.ts 为版本耦合产物，不由 WAO 伪造）——已跳过装备/.test(n.detail)), 'degrade note carries the refusal reason');
    assert.equal(manifestOf(mat, bot).tools.find((t) => t.kind === 'rtk').state, 'failed', 'tools row records the failed (degraded) state');
    assert.ok(!String(manifestOf(mat, bot).lastResult ?? '').startsWith('failed:'), 'manifest itself is healthy — other assets unaffected');
  } finally {
    clearFakeMode();
  }
});

test('pi main path: --agent pi flavor equips extensions/rtk.ts into the agent dir', async () => {
  const sc = scenario('pi-armed');
  const agentDir = join(sc, 'pi-agent');
  const bot = { id: 'rtk-pi2', provider: 'pi', providerConfig: { cwd: join(sc, 'cwd'), model: { model: 'm1' }, piAgentDir: agentDir } };
  setFakeMode(sc, 'ok');
  const mat = matOver(stubProvider(rtkWrite(agentDir, 'pi')), join(sc, 'data'), FAKE_RTK);
  try {
    const r = await mat.materialize(bot, [RTK_ENTRY]);
    assert.ok(existsSync(join(agentDir, 'extensions', 'rtk.ts')), 'pi extension installed');
    assert.ok(r.notes.some((n) => /flavor pi，主路径/.test(n.detail)));
    assert.equal(manifestOf(mat, bot).tools.find((t) => t.kind === 'rtk').state, 'armed');
  } finally {
    clearFakeMode();
  }
});

test('unload (armed main path): rtk uninstall runs, .bak swept, hook entry gone, products gone', async () => {
  const sc = scenario('unload-main');
  const cfgDir = join(sc, 'claude-cfg');
  const bot = claudeBotOver(sc, cfgDir);
  setFakeMode(sc, 'ok');
  const mat = matOver(stubProvider(rtkWrite(cfgDir)), join(sc, 'data'), FAKE_RTK);
  try {
    await mat.materialize(bot, [RTK_ENTRY]);
    const r = await mat.materialize(bot, []);
    assert.ok(r.notes.some((n) => /rtk 卸载成功/.test(n.detail)), 'rtk uninstall executed');
    const settings = JSON.parse(readFileSync(join(cfgDir, 'settings.json'), 'utf8'));
    assert.deepEqual(settings.hooks?.PreToolUse ?? [], [], 'hook entry removed');
    assert.equal(existsSync(join(cfgDir, 'RTK.md')), false, 'RTK.md removed');
    assert.equal(existsSync(join(cfgDir, 'settings.json.bak')), false, 'uninstall .bak residue swept');
    assert.match(readFileSync(process.env.FAKE_RTK_LOG, 'utf8').trim().split('\n').at(-1), /^claude uninstall ok$/, 'rtk uninstall was the last rtk invocation');
  } finally {
    clearFakeMode();
  }
});

test('unload with rtk MISSING at uninstall time: recorded entry leaves by precise-match delete (fallback of the fallback)', async () => {
  const sc = scenario('unload-nortk');
  const cfgDir = join(sc, 'claude-cfg');
  const bot = claudeBotOver(sc, cfgDir);
  setFakeMode(sc, 'ok');
  const matArmed = matOver(stubProvider(rtkWrite(cfgDir)), join(sc, 'data'), FAKE_RTK);
  await matArmed.materialize(bot, [RTK_ENTRY]);
  clearFakeMode();
  // a materializer whose rtk is GONE (ops removed the binary) shares the manifest via dataDir
  const matNoRtk = matOver(stubProvider(() => []), join(sc, 'data'), join(sc, 'no-such-rtk'));
  const r = await matNoRtk.materialize(bot, []);
  assert.ok(r.notes.some((n) => /rtk 二进制缺失/.test(n.detail)), 'note explains the fallback');
  const settings = JSON.parse(readFileSync(join(cfgDir, 'settings.json'), 'utf8'));
  assert.deepEqual(settings.hooks?.PreToolUse ?? [], [], 'entry precise-deleted from the full-text record');
});

test('unload of fallback equipment: precise-match delete; a user-EDITED entry warns and stays (§3.6 不模糊删)', async () => {
  const sc = scenario('unload-fallback');
  const cfgDir = join(sc, 'claude-cfg');
  const bot = claudeBotOver(sc, cfgDir);
  setFakeMode(sc, 'outside');
  const mat = matOver(stubProvider(rtkWrite(cfgDir)), join(sc, 'data'), FAKE_RTK);
  await mat.materialize(bot, [RTK_ENTRY]);
  clearFakeMode();
  // user edited the entry → no deep-equal twin → warn-not-delete
  const settingsFile = join(cfgDir, 'settings.json');
  const edited = JSON.parse(readFileSync(settingsFile, 'utf8'));
  edited.hooks.PreToolUse[0].hooks[0].command = 'user-rewrote-me';
  writeFileSync(settingsFile, `${JSON.stringify(edited, null, 2)}\n`);
  const r = await mat.materialize(bot, []);
  assert.ok(r.notes.some((n) => /hook 条目已变化，请人工确认后删除/.test(n.detail)), 'warn-not-delete note');
  const after = JSON.parse(readFileSync(settingsFile, 'utf8'));
  assert.equal(after.hooks.PreToolUse[0].hooks[0].command, 'user-rewrote-me', 'edited entry untouched');

  // un-edited twin (fresh fallback equip) deletes cleanly
  const sc2 = scenario('unload-fallback-clean');
  const cfg2 = join(sc2, 'claude-cfg');
  const bot2 = claudeBotOver(sc2, cfg2);
  setFakeMode(sc2, 'outside');
  const mat2 = matOver(stubProvider(rtkWrite(cfg2)), join(sc2, 'data'), FAKE_RTK);
  await mat2.materialize(bot2, [RTK_ENTRY]);
  clearFakeMode();
  await mat2.materialize(bot2, []);
  const after2 = JSON.parse(readFileSync(join(cfg2, 'settings.json'), 'utf8'));
  assert.deepEqual(after2.hooks?.PreToolUse ?? [], [], 'clean fallback unload precise-deletes the entry');
});

test('ripgrep precheck rows ride the manifest tools (provider-recorded); rtk stays bound across a ripgrep-only rematerialize', async () => {
  const sc = scenario('rg-precheck');
  const cfgDir = join(sc, 'claude-cfg');
  const bot = claudeBotOver(sc, cfgDir);
  const impl = {
    async materializeAssets() {
      return {
        writes: [{ kind: 'argv', flags: ['--append-system-prompt', 'rg 指引'], for: 'ast-rg1' }],
        notes: [],
        entries: [],
        tools: [{ assetId: 'ast-rg1', kind: 'ripgrep', state: 'available', version: 'ripgrep 15.2.0' }],
      };
    },
  };
  const mat = matOver(impl, join(sc, 'data'), FAKE_RTK);
  await mat.materialize(bot, [{ assetId: 'ast-rg1', type: 'tool', name: 'rg', mode: 'shared', content: { kind: 'ripgrep' } }]);
  assert.deepEqual(manifestOf(mat, bot).tools, [{ assetId: 'ast-rg1', kind: 'ripgrep', state: 'available', version: 'ripgrep 15.2.0' }], '§7.2 precheck recorded');
});

test('probeBin cache (R2): same bin+mtime → one spawn total; a binary swap (mtime bump) re-probes', () => {
  const sc = scenario('probe-cache');
  const bin = join(sc, 'counter-bin');
  const counterFile = join(sc, 'count.log');
  writeFileSync(bin, [
    '#!/usr/bin/env node',
    `import { appendFileSync } from 'node:fs';`,
    `appendFileSync(${JSON.stringify(counterFile)}, 'x\\n');`,
    `console.log('counter 1.0.0');`,
    '',
  ].join('\n'));
  chmodSync(bin, 0o755);
  const spawnCount = () => readFileSync(counterFile, 'utf8').split('\n').filter(Boolean).length;
  const a = probeBin(bin);
  assert.equal(a.ok, true);
  assert.match(a.version, /^counter 1\.0\.0/);
  const b = probeBin(bin);
  assert.deepEqual(b, a, 'cache hit returns the recorded result');
  assert.equal(spawnCount(), 1, 'the second probe did NOT spawn (cache hit)');
  // mtime is part of the key: a swapped binary (same path) must re-probe.
  utimesSync(bin, new Date(), new Date(Date.now() + 5000));
  const c = probeBin(bin);
  assert.deepEqual(c, a, 'same binary content → same probe result');
  assert.equal(spawnCount(), 2, 'the mtime bump forced a fresh probe');
});

test('rtk execution is ASYNC (R2): a slow rtk never blocks the event loop during materialize', async () => {
  const sc = scenario('async-rtk');
  const cfgDir = join(sc, 'claude-cfg');
  const bot = claudeBotOver(sc, cfgDir);
  setFakeMode(sc, 'ok');
  process.env.FAKE_RTK_SLEEP_MS = '300';
  try {
    const mat = matOver(stubProvider(rtkWrite(cfgDir)), join(sc, 'data'), FAKE_RTK);
    probeBin(FAKE_RTK); // warm the probe cache (the probe itself stays sync+cached)
    const startedAt = Date.now();
    let loopAliveAt = 0;
    const timerFired = new Promise((r) => setTimeout(() => { loopAliveAt = Date.now(); r(); }, 30));
    const matP = mat.materialize(bot, [RTK_ENTRY]);
    await timerFired;
    assert.ok(loopAliveAt - startedAt < 250,
      `event loop stayed responsive while rtk ran (timer fired at +${loopAliveAt - startedAt}ms — spawnSync would block ~300ms)`);
    await matP;
    assert.ok(existsSync(join(cfgDir, 'settings.json')), 'rtk products landed after the async run');
  } finally {
    delete process.env.FAKE_RTK_SLEEP_MS;
    clearFakeMode();
  }
});

test('checkBind: claude shared-dir rtk refused; pi default-dir rtk allowed (per-bot WAO namespace, not shared home)', () => {
  const sc = scenario('bind-guard');
  const mat = matOver(stubProvider(() => []), join(sc, 'data'), FAKE_RTK);
  const rtkAsset = { type: 'tool', name: 'rtk', content: { kind: 'rtk' } };
  assert.ok(mat.checkBind({ id: 'c1', provider: 'claude', providerConfig: { cwd: sc } }, rtkAsset).some((e) => /专属目录/), 'shared-home claude bot refused (§7.1 硬红线)');
  assert.deepEqual(mat.checkBind({ id: 'c2', provider: 'claude', providerConfig: { cwd: sc, claudeConfigDir: join(sc, 'cfg') } }, rtkAsset), [], 'dedicated-dir claude bot ok');
  assert.deepEqual(mat.checkBind({ id: 'p1', provider: 'pi', providerConfig: { cwd: sc, model: { model: 'm' } } }, rtkAsset), [], 'pi DEFAULT agent dir is a per-bot namespace → allowed');
  const noop = noopMaterializer();
  assert.deepEqual(noop.checkBind({ id: 'p2', provider: 'pi', providerConfig: { cwd: sc } }, rtkAsset), [], 'noop seam mirrors the pi-default relaxation');
  assert.ok(noop.checkBind({ id: 'c3', provider: 'claude', providerConfig: { cwd: sc } }, rtkAsset).some((e) => /专属目录/), 'noop seam keeps the shared-home refusal');
});
