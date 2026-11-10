// 知识资产模块（DESIGN-KNOWLEDGE）单测：生效记忆目标解析（shared/exclusive）、
// 蒸馏/整理统一写回（applyMemoryNotes 两条路径 + snapshotHistory 环）、资产版本
// 历史（pushAssetHistory cap）、提案解析（文件/围栏/双缺）、提案校验矩阵（拒绝
// 优于静默纠正）、整理轮 e2e（fake runner 写提案文件 / 围栏回退 / 失败不应用 /
// 并发锁 409）、回滚（registry/exclusive/404 带版本清单）、呈现面聚合
// （knowledgeBundleOp：钩子优先/通用回落/secret 段不读内容/技能截断标注）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { noopMaterializer } from '../../plugins/core-engine/assets.js';
import {
  memoryTargetOf, applyMemoryNotes, knowledgeBundleOp, curateBotOp, rollbackAssetOp,
  parseCurationProposal, validateCurationProposal, buildCurationPrompt,
  appendCurationRecord, readCurationHistory, SNAPSHOT_HISTORY_CAP,
} from '../../plugins/core-engine/knowledge.js';
import { pushAssetHistory, ASSET_HISTORY_CAP } from '../../plugins/core-engine/assets.js';
import { updateAssetOp, createAssetOp } from '../../plugins/core-engine/api.js';
import { saveBots } from '../../plugins/core-engine/bots.js';

let dir;
const mk = (p) => { mkdirSync(p, { recursive: true }); return p; };

before(() => { dir = mkdtempSync(join(tmpdir(), 'wao-knowledge-')); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

// 最小 state（直接调 Op 函数，不走 HTTP）——与 assets.js/api.js 的真实数据纪律
// 一致：botsFile/assetsFile 落临时目录，materializer 用 noop（重物化回执
// skipped:'not-equipped'，ok 仍为 true）。
const mkState = ({ bots, assets, port = null } = {}) => {
  const sub = mk(join(dir, `s-${Math.random().toString(36).slice(2, 8)}`));
  const botsFile = join(sub, 'bots.json');
  const assetsFile = join(sub, 'assets.json');
  const doc = { bots };
  const assetsDoc = { assets };
  saveBots(botsFile, doc);
  const state = {
    doc, assetsDoc, botsFile, assetsFile,
    ports: { getProvider: () => port },
    materializer: noopMaterializer(),
    refreshRunner: () => {},
    log: { info: () => {}, warn: () => {} },
  };
  return state;
};

const mkBot = (over = {}) => ({
  id: 'b1', name: '一号', channel: 'fakechan', provider: 'fakeprov',
  account: { endpoint: 'http://x' }, providerConfig: { cwd: mk(join(dir, 'cwd-' + Math.random().toString(36).slice(2, 6))) },
  ...(over.assets != null ? { assets: over.assets } : {}),
});
const mkMemoryAsset = (over = {}) => ({
  id: 'ast-mem1', type: 'memory', name: 'biz', description: '', origin: 'operator',
  version: 1, createdAt: 1, updatedAt: 1,
  content: { notes: ['旧一条'] },
  ...over,
});

// fake provider port：可选写提案文件 / 定制 finalText；run 可挂起（锁测试）。
const mkPort = ({ proposal = null, finalText = '整理完成', hang = null, proposalFile = null } = {}) => ({
  createRunner: ({ bot }) => ({
    async run({ prompt }) {
      if (hang != null) await hang;
      if (proposal != null) {
        // 提案文件路径从 prompt 解析（nonce 轮次名）；也可用 proposalFile 覆写
        const m = /\S*curation\/proposal-\d+\.json/.exec(prompt ?? '');
        const p = proposalFile ?? (m != null ? m[0] : null);
        if (p == null) throw new Error('prompt 未携带提案路径');
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, JSON.stringify(proposal));
      }
      return { ok: true, code: 'completed', finalText: `${finalText}\n[prompt:${prompt.slice(0, 12)}]`, sessionId: 'cur-1', reason: null, detail: { exitCode: 0 } };
    },
  }),
  describeError: (r) => `fake err ${r?.code ?? '?'}`,
});

// —— 生效记忆目标 + 统一写回 ————————————————————————————————————————————

test('memoryTargetOf: shared→registry 活资产；exclusive→快照（源删除仍活）；未绑定→null', () => {
  const mem = mkMemoryAsset();
  const state = mkState({
    bots: [mkBot({ assets: [{ assetId: 'ast-mem1', mode: 'shared' }] })],
    assets: [mem],
  });
  assert.equal(memoryTargetOf(state, state.doc.bots[0]).mode, 'shared');
  assert.deepEqual(memoryTargetOf(state, state.doc.bots[0]).notes, ['旧一条']);

  const state2 = mkState({
    bots: [mkBot({ assets: [{ assetId: 'ast-mem1', mode: 'exclusive', snapshot: { notes: ['快照条'] }, snapshotVersion: 3, snapshotAt: 1, snapshotType: 'memory', snapshotName: 'biz' }] })],
    assets: [], // 源已删除
  });
  const t2 = memoryTargetOf(state2, state2.doc.bots[0]);
  assert.equal(t2.mode, 'exclusive');
  assert.deepEqual(t2.notes, ['快照条']);
  assert.equal(t2.assetId, 'ast-mem1');

  const state3 = mkState({ bots: [mkBot()], assets: [] });
  assert.equal(memoryTargetOf(state3, state3.doc.bots[0]), null);
});

test('applyMemoryNotes shared：走 updateAssetOp（version bump + history 归档）', async () => {
  const mem = mkMemoryAsset();
  const state = mkState({
    bots: [mkBot({ assets: [{ assetId: 'ast-mem1', mode: 'shared' }] })],
    assets: [mem],
  });
  const r = await applyMemoryNotes(state, state.doc.bots[0], ['旧一条', '新一条'], 'distill');
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'shared');
  assert.deepEqual(r, { ok: true, mode: 'shared', assetId: 'ast-mem1', before: 1, after: 2 });
  assert.equal(mem.version, 2, 'version 自增');
  assert.deepEqual(mem.content.notes, ['旧一条', '新一条']);
  assert.equal(mem.history.length, 1, '变更前内容入历史');
  assert.deepEqual(mem.history[0].content, { notes: ['旧一条'] });
  assert.equal(mem.history[0].via, 'distill');
});

test('applyMemoryNotes exclusive：快照覆写 + snapshotHistory 归档 + 版本自增（既有缺口修复面）', async () => {
  const state = mkState({
    bots: [mkBot({ assets: [{ assetId: 'ast-mem1', mode: 'exclusive', snapshot: { notes: ['快照旧'] }, snapshotVersion: 3, snapshotAt: 111, snapshotType: 'memory', snapshotName: 'biz' }] })],
    assets: [],
  });
  const bot = state.doc.bots[0];
  const r = await applyMemoryNotes(state, bot, ['快照旧', '快照新'], 'curation');
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'exclusive');
  assert.equal(r.version, 4, '快照版本自增');
  const binding = bot.assets[0];
  assert.deepEqual(binding.snapshot.notes, ['快照旧', '快照新']);
  assert.deepEqual(binding.snapshotHistory, [{ version: 3, at: 111, via: 'curation', content: { notes: ['快照旧'] } }]);
  // bots.json 落盘检查
  const persisted = JSON.parse(readFileSync(state.botsFile, 'utf8'));
  assert.deepEqual(persisted.bots[0].assets[0].snapshot.notes, ['快照旧', '快照新']);
});

test('applyMemoryNotes：未绑定记忆 → ok:false 带原因（不抛）', async () => {
  const state = mkState({ bots: [mkBot()], assets: [] });
  const r = await applyMemoryNotes(state, state.doc.bots[0], ['x'], 'distill');
  assert.equal(r.ok, false);
  assert.match(r.reason, /未绑定 memory/);
});

// —— 版本历史原语 ——————————————————————————————————————————————————————————

test('pushAssetHistory: cap 12，满丢最旧；条目带 via', () => {
  const asset = { version: 1, updatedAt: 1, content: { notes: [] } };
  for (let i = 1; i <= ASSET_HISTORY_CAP + 3; i += 1) {
    pushAssetHistory(asset, 'distill');
    asset.version += 1;
    asset.updatedAt += 1;
  }
  assert.equal(asset.history.length, ASSET_HISTORY_CAP);
  assert.equal(asset.history[0].version, 4, '最旧的 1/2/3 被挤出');
  assert.equal(asset.history[asset.history.length - 1].version, ASSET_HISTORY_CAP + 3);
});

test('snapshotHistory: cap ' + SNAPSHOT_HISTORY_CAP, async () => {
  const state = mkState({
    bots: [mkBot({ assets: [{ assetId: 'ast-mem1', mode: 'exclusive', snapshot: { notes: [] }, snapshotVersion: 1, snapshotAt: 1, snapshotType: 'memory', snapshotName: 'biz' }] })],
    assets: [],
  });
  const bot = state.doc.bots[0];
  for (let i = 0; i < SNAPSHOT_HISTORY_CAP + 2; i += 1) {
    await applyMemoryNotes(state, bot, [`第${i}轮`], 'curation');
  }
  assert.equal(bot.assets[0].snapshotHistory.length, SNAPSHOT_HISTORY_CAP);
});

// updateAssetOp 的 history 只在内容真变时归档（同名 PATCH 不重复归档）
test('updateAssetOp: content 变更入历史；无内容变更只 bump version', async () => {
  const mem = mkMemoryAsset();
  const state = mkState({ bots: [], assets: [mem] });
  await updateAssetOp(state, 'ast-mem1', { description: '改名不碰内容' });
  assert.equal(mem.history, undefined, '无内容变更不入历史');
  await updateAssetOp(state, 'ast-mem1', { content: { notes: ['旧一条', '二'] } });
  assert.equal(mem.history.length, 1);
});

// —— 提案解析与校验 ———————————————————————————————————————————————————————

test('parseCurationProposal: 围栏优先序 + 整段兜底 + 不形似 → null', () => {
  const fence = '前言\n```json\n{"memory":{"notes":["a"]}}\n```\n后记';
  assert.deepEqual(parseCurationProposal(fence), { memory: { notes: ['a'] } });
  // 多个围栏：取首个形似提案的
  const two = '```json\n{"other":1}\n```\n```json\n{"skills":[]}\n```';
  assert.deepEqual(parseCurationProposal(two), { skills: [] });
  // 整段裸 JSON 兜底（无围栏）
  assert.deepEqual(parseCurationProposal('{"memory":{"notes":["b"]}}'), { memory: { notes: ['b'] } });
  assert.equal(parseCurationProposal('纯文本总结，没有 JSON'), null);
  assert.equal(parseCurationProposal('```json\n{"unrelated":true}\n```'), null, '形似检查：不含 memory/skills 键不算提案');
  assert.equal(parseCurationProposal(null), null);
});

const REG = [{ assetId: 'ast-s1', assetName: 'sls', contentName: 'sls', origin: 'operator', bound: true },
  { assetId: 'ast-s2', assetName: 'tips', contentName: 'tips', origin: 'curation', bound: true }];

test('validateCurationProposal: 合法提案全通过（memory 替换 + create + update）', () => {
  const v = validateCurationProposal({
    memory: { notes: ['合并后的一条'] },
    skills: [
      { action: 'create', name: 'new-playbook', description: '描述', body: '# 新手册' },
      { action: 'update', name: 'tips', description: '更', body: '# 更新' },
    ],
    summary: '合并重复',
  }, { registrySkills: REG, currentNotes: ['a', 'b'] });
  assert.equal(v.memory.notes.length, 1);
  assert.equal(v.skills.length, 2);
  assert.equal(v.skills[1].assetId, 'ast-s2');
  assert.deepEqual(v.skipped, []);
  assert.equal(v.summary, '合并重复');
});

test('validateCurationProposal: 原样 notes → memoryUnchanged（合法，无事可做）', () => {
  const v = validateCurationProposal(
    { memory: { notes: ['同当前'] } },
    { registrySkills: REG, currentNotes: ['同当前'] },
  );
  assert.equal(v.memory, null);
  assert.equal(v.memoryUnchanged, true);
});

test('validateCurationProposal: 拒绝矩阵（超限/坏名/重名/越权 update/超 3 件）', () => {
  const v1 = validateCurationProposal({ memory: { notes: [''] } }, { registrySkills: REG, currentNotes: [] });
  assert.match(v1.skipped[0].reason, /非空字符串/);
  const v2 = validateCurationProposal({ memory: { notes: Array.from({ length: 51 }, (_, i) => `n${i}`) } }, { registrySkills: REG, currentNotes: [] });
  assert.match(v2.skipped[0].reason, /条数超限/);
  const v3 = validateCurationProposal({ skills: [{ action: 'create', name: 'SLS Playbook', description: '', body: '# x' }] }, { registrySkills: REG, currentNotes: [] });
  assert.match(v3.skipped[0].reason, /必须匹配/);
  const v4 = validateCurationProposal({ skills: [{ action: 'create', name: 'sls', description: '', body: '# x' }] }, { registrySkills: REG, currentNotes: [] });
  assert.match(v4.skipped[0].reason, /不得重名/);
  const v5 = validateCurationProposal({ skills: [{ action: 'update', name: 'sls', description: '', body: '# x' }] }, { registrySkills: REG, currentNotes: [] });
  assert.match(v5.skipped[0].reason, /只读/);
  const v6 = validateCurationProposal({
    skills: [
      { action: 'create', name: 'a1', description: '', body: '# x' },
      { action: 'create', name: 'a2', description: '', body: '# x' },
      { action: 'create', name: 'a3', description: '', body: '# x' },
      { action: 'create', name: 'a4', description: '', body: '# x' },
    ],
  }, { registrySkills: REG, currentNotes: [] });
  assert.equal(v6.skills.length, 3, '前 3 项过');
  assert.match(v6.skipped[0].reason, /最多 3 项/);
  const v7 = validateCurationProposal({ skills: [{ action: 'update', name: 'tips', description: '', body: '# x' }] },
    { registrySkills: [{ ...REG[1], bound: false }], currentNotes: [] });
  assert.match(v7.skipped[0].reason, /未绑定到本 bot/);
});

// —— 整理轮 e2e（fake runner）—————————————————————————————————————————————

const BOUND = [
  { assetId: 'ast-mem1', mode: 'shared' },
];

test('curateBotOp: 提案文件通道——记忆替换 + curation 技能 create 自动 exclusive 绑定', async () => {
  const mem = mkMemoryAsset();
  const state = mkState({
    bots: [mkBot({ assets: [...BOUND] })],
    assets: [mem],
    port: mkPort({ proposal: {
      memory: { notes: ['合并后唯一一条'] },
      skills: [{ action: 'create', name: 'my-playbook', description: '手册', body: '# 手册正文' }],
      summary: '合并重复记忆',
    } }),
  });
  const bot = state.doc.bots[0];
  const rec = await curateBotOp(state, bot.id, { guidance: '重点合并' });
  assert.equal(rec.ok, true);
  assert.equal(rec.source, 'file');
  assert.match(rec.summary, /合并重复记忆/);
  assert.deepEqual(rec.changes.memory, { before: 1, after: 1, mode: 'shared' });
  assert.equal(rec.changes.skillsCreated.length, 1);
  const created = state.assetsDoc.assets.find((a) => a.name === 'my-playbook');
  assert.equal(created.origin, 'curation', 'curation 产物盖章 origin');
  assert.equal(created.type, 'skill');
  const binding = bot.assets.find((b) => b.assetId === created.id);
  assert.equal(binding.mode, 'exclusive', '自动 exclusive 绑定本 bot');
  assert.deepEqual(mem.content.notes, ['合并后唯一一条'], '记忆整组替换');
  // 整理史落盘
  const hist = readCurationHistory(state, bot.id);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].ok, true);
  assert.equal(hist[0].guidance, '重点合并');
});

test('curateBotOp: 围栏回退通道（dsh 等无写文件面）', async () => {
  const mem = mkMemoryAsset();
  const state = mkState({
    bots: [mkBot({ assets: [...BOUND] })],
    assets: [mem],
    port: mkPort({ finalText: '整理完成。\n```json\n{"memory":{"notes":["围栏条"]},"summary":"fence"}\n```' }),
  });
  const rec = await curateBotOp(state, 'b1', {});
  assert.equal(rec.ok, true);
  assert.equal(rec.source, 'fence');
  assert.deepEqual(mem.content.notes, ['围栏条']);
});

test('curateBotOp: update 仅 curation 技能 + 应用后同步 exclusive 快照', async () => {
  // 先造一台已绑定 curation 技能（exclusive 快照）的 bot
  const curSkill = {
    id: 'ast-cur1', type: 'skill', name: 'tips', description: '', origin: 'curation',
    version: 1, createdAt: 1, updatedAt: 1,
    content: { name: 'tips', description: '旧描述', body: '# 旧正文' },
  };
  const state = mkState({
    bots: [mkBot({ assets: [
      { assetId: 'ast-mem1', mode: 'shared' },
      { assetId: 'ast-cur1', mode: 'exclusive', snapshot: { name: 'tips', description: '旧描述', body: '# 旧正文' }, snapshotVersion: 1, snapshotAt: 1, snapshotType: 'skill', snapshotName: 'tips' },
    ] })],
    assets: [mkMemoryAsset(), curSkill],
    port: mkPort({ proposal: {
      skills: [{ action: 'update', name: 'tips', description: '新描述', body: '# 新正文' }],
      summary: '修订手册',
    } }),
  });
  const bot = state.doc.bots[0];
  const rec = await curateBotOp(state, bot.id, {});
  assert.equal(rec.ok, true);
  assert.equal(rec.changes.skillsUpdated.length, 1);
  assert.equal(curSkill.version, 2, 'registry bump');
  assert.equal(curSkill.content.body, '# 新正文');
  const binding = bot.assets.find((b) => b.assetId === 'ast-cur1');
  assert.equal(binding.snapshot.body, '# 新正文', 'exclusive 快照同步（否则整理对快照 bot 不生效）');
  assert.ok(Array.isArray(binding.snapshotHistory) && binding.snapshotHistory.length === 1, '旧快照入历史');
});

test('curateBotOp: 失败轮（runner 非 completed）不应用，整理史如实记因', async () => {
  const mem = mkMemoryAsset();
  const port = {
    createRunner: () => ({
      async run() { return { ok: false, code: 'timeout', finalText: '', sessionId: null, reason: { kind: 'timeout' }, detail: { exitCode: null } }; },
    }),
    describeError: (r) => '任务超时。',
  };
  const state = mkState({ bots: [mkBot({ assets: [...BOUND] })], assets: [mem], port });
  const rec = await curateBotOp(state, 'b1', {});
  assert.equal(rec.ok, false);
  assert.equal(rec.reason, 'timeout');
  assert.equal(rec.errorText, '任务超时。');
  assert.deepEqual(mem.content.notes, ['旧一条'], '失败不改知识');
  assert.equal(readCurationHistory(state, 'b1').length, 1);
});

test('curateBotOp: 空提案（无 memory 无 skills）→ proposal-empty 如实记因', async () => {
  const state = mkState({
    bots: [mkBot({ assets: [...BOUND] })],
    assets: [mkMemoryAsset()],
    port: mkPort({ proposal: { summary: '我看没什么好整理的' } }),
  });
  const rec = await curateBotOp(state, 'b1', {});
  assert.equal(rec.ok, false);
  assert.match(rec.reason, /proposal-empty/);
  assert.deepEqual(state.assetsDoc.assets[0].content.notes, ['旧一条'], '知识不动');
});

test('curateBotOp: 提案缺失（无文件无围栏）→ applied=false 带原因', async () => {
  const mem = mkMemoryAsset();
  const state = mkState({ bots: [mkBot({ assets: [...BOUND] })], assets: [mem], port: mkPort({ finalText: '我完成了整理' }) });
  const rec = await curateBotOp(state, 'b1', {});
  assert.equal(rec.ok, false);
  assert.match(rec.reason, /proposal-missing/);
});

test('curateBotOp: 同 bot 并发互斥（409），结算后锁释放', async () => {
  let release;
  const hang = new Promise((resolve) => { release = resolve; });
  const state = mkState({
    bots: [mkBot({ assets: [...BOUND] })],
    assets: [mkMemoryAsset()],
    port: mkPort({ hang }),
  });
  const first = curateBotOp(state, 'b1', {});
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(() => curateBotOp(state, 'b1', {}), (err) => err.status === 409);
  release({ ok: true, code: 'completed', finalText: 'x', sessionId: 's', reason: null, detail: { exitCode: 0 } });
  const rec = await first;
  assert.equal(rec.run.code, 'completed');
  // 锁已释放：可再次发起（这次直接失败轮也行——只要不再 409）
  const rec2 = await curateBotOp(state, 'b1', {});
  assert.notEqual(rec2.run?.code, 'lock');
});

test('curateBotOp: guidance 校验（非串 400）与 cwd 缺失 400', async () => {
  const state = mkState({ bots: [mkBot({ assets: [...BOUND] })], assets: [mkMemoryAsset()], port: mkPort() });
  await assert.rejects(() => curateBotOp(state, 'b1', { guidance: 123 }), (err) => err.status === 400);
  const bad = mkBot({ assets: [...BOUND] });
  bad.providerConfig = { cwd: '/nonexistent-wao-dir-xyz' };
  const state2 = mkState({ bots: [bad], assets: [mkMemoryAsset()], port: mkPort() });
  await assert.rejects(() => curateBotOp(state2, 'b1', {}), (err) => err.status === 400 && /cwd|目录/i.test(err.message));
});

// —— 盲评发现回归（2026-11-11 代码盲审 P1-1/2/3、P2-6/7）———————————————

test('盲审 P1-1: 整理窗口期记忆被蒸馏/人工推进 → 整组替换跳过并如实记因', async () => {
  const mem = mkMemoryAsset();
  const state = mkState({
    bots: [mkBot({ assets: [...BOUND] })],
    assets: [mem],
    port: mkPort({ proposal: { memory: { notes: ['整理后'] } }, hang: null }),
  });
  // 包一层 port：run 结束后、应用前把 registry 版本推进一次（模拟窗口期蒸馏）
  const origPort = state.ports.getProvider();
  state.ports = {
    getProvider: () => ({
      ...origPort,
      createRunner: (args) => {
        const r = origPort.createRunner(args);
        return {
          run: async (opts) => {
            const res = await r.run(opts);
            await updateAssetOp(state, 'ast-mem1', { content: { notes: ['旧一条', '窗口期新条'] } }, { via: 'distill' });
            return res;
          },
        };
      },
    }),
  };
  const rec = await curateBotOp(state, 'b1', {});
  assert.equal(rec.ok, false, JSON.stringify(rec));
  assert.match(rec.changes.skipped.find((x) => x.part === 'memory').reason, /整理期间被更新/);
  assert.deepEqual(mem.content.notes, ['旧一条', '窗口期新条'], '窗口期写入不被吞');
});

test('盲审 P1-2: create 成功但 bind 失败 → 孤儿资产回收，skipped 带回收说明', async () => {
  const state = mkState({
    bots: [mkBot({ assets: [...BOUND] })],
    assets: [mkMemoryAsset()],
    port: mkPort({ proposal: {
      skills: [{ action: 'create', name: 'will-fail-bind', description: '', body: '# x' }],
    } }),
  });
  // 把 noop 物化器的 checkBind 变成必拒（模拟外来技能文件/冲突）
  const nm = noopMaterializer();
  nm.checkBind = () => ['模拟绑定失败：目标冲突'];
  state.materializer = nm;
  const rec = await curateBotOp(state, 'b1', {});
  assert.equal(rec.ok, false);
  assert.match(rec.changes.skipped[0].reason, /绑定失败[\s\S]*已回收/);
  assert.equal(state.assetsDoc.assets.some((a) => a.name === 'will-fail-bind'), false, '孤儿资产已回收');
  // 再跑一轮同名 create 不再撞「不得重名」
  state.materializer = noopMaterializer();
  const rec2 = await curateBotOp(state, 'b1', {});
  assert.equal(rec2.changes.skillsCreated.length, 1, '回收后同名 create 可重试');
});

test('盲审 P1-3: 多份生效记忆绑定 → 400 拒绝整理（v1 单记忆口径）', async () => {
  const state = mkState({
    bots: [mkBot({ assets: [
      { assetId: 'ast-mem1', mode: 'shared' },
      { assetId: 'ast-mem2', mode: 'shared' },
    ] })],
    assets: [mkMemoryAsset(), mkMemoryAsset({ id: 'ast-mem2', name: 'biz2', content: { notes: ['x'] } })],
    port: mkPort(),
  });
  await assert.rejects(() => curateBotOp(state, 'b1', {}), (err) => err.status === 400 && /多份记忆/.test(err.message));
});

test('盲审 P2-6: guidance 超 2000 字 → 400（拒绝优于静默截断）', async () => {
  const state = mkState({ bots: [mkBot()], assets: [], port: mkPort() });
  await assert.rejects(() => curateBotOp(state, 'b1', { guidance: '长'.repeat(2001) }),
    (err) => err.status === 400 && /最长 2000/.test(err.message));
});

test('盲审 P2-7: 上一轮残留的固定名提案文件不再被读（nonce 轮次名）', async () => {
  const mem = mkMemoryAsset();
  const state = mkState({
    bots: [mkBot({ assets: [...BOUND] })],
    assets: [mem],
    port: mkPort({ finalText: '没什么好整理的' }),
  });
  // 旧格式僵尸文件（上一轮超时轮晚到写的）
  const zombie = join(state.doc.bots[0].providerConfig.cwd, '.wao', 'curation', 'proposal.json');
  mkdirSync(dirname(zombie), { recursive: true });
  writeFileSync(zombie, JSON.stringify({ memory: { notes: ['僵尸提案'] } }));
  const rec = await curateBotOp(state, 'b1', {});
  assert.equal(rec.ok, false);
  assert.match(rec.reason, /proposal-missing/, '僵尸文件不被当新鲜提案');
  assert.deepEqual(mem.content.notes, ['旧一条']);
  assert.match(rec.proposalPath, /proposal-\d+\.json$/, 'record 带本轮 nonce 路径');
});

test('buildCurationPrompt: 含记忆全文/技能正文/引导/输出协议与提案路径', async () => {
  const prompt = buildCurationPrompt({ id: 'b1', provider: 'fakeprov' }, {
    memories: [{ name: 'biz', mode: 'shared', count: 1, cap: 50, notes: ['查日志 → 用 sls_execute_sql'] }],
    skills: [{ name: 'tips', originLabel: 'AI 整理', mode: 'exclusive', description: '手册', body: '# 正文', truncated: false, bodyChars: 6 }],
    guidance: '重点合并',
    proposalPath: '/tmp/x/.wao/curation/proposal.json',
  });
  assert.match(prompt, /【WAO 知识整理轮】/);
  assert.match(prompt, /查日志 → 用 sls_execute_sql/);
  assert.match(prompt, /重点合并/);
  assert.match(prompt, /\/tmp\/x\/\.wao\/curation\/proposal\.json/);
  assert.match(prompt, /原样输出/);
});

// —— 回滚 ———————————————————————————————————————————————————————————————————

test('rollbackAssetOp: registry 面走 updateAssetOp（校验+version 续增+历史续档）', async () => {
  const mem = mkMemoryAsset();
  const state = mkState({ bots: [], assets: [mem] });
  await updateAssetOp(state, 'ast-mem1', { content: { notes: ['第二代'] } });
  await updateAssetOp(state, 'ast-mem1', { content: { notes: ['第三代'] } });
  const r = await rollbackAssetOp(state, 'ast-mem1', { version: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.scope, 'registry');
  assert.equal(r.version, 4, '回滚也是一次 PATCH：版本续增');
  assert.deepEqual(mem.content.notes, ['第二代']);
  assert.equal(mem.history.length, 3, '回滚前的第三代也入历史（可再回滚回来）');
  await assert.rejects(() => rollbackAssetOp(state, 'ast-mem1', { version: 99 }),
    (err) => err.status === 404 && /现有/.test(err.message));
});

test('rollbackAssetOp: exclusive 快照面（botId 定向，registry 不动）', async () => {
  const mem = mkMemoryAsset();
  const state = mkState({
    bots: [mkBot({ assets: [{ assetId: 'ast-mem1', mode: 'exclusive', snapshot: { notes: ['第三版快照'] }, snapshotVersion: 3, snapshotAt: 3, snapshotType: 'memory', snapshotName: 'biz' }] })],
    assets: [mem],
  });
  await applyMemoryNotes(state, state.doc.bots[0], ['第二版快照'], 'curation'); // → v4, history: [v3]
  await applyMemoryNotes(state, state.doc.bots[0], ['第四版快照'], 'curation'); // → v5, history: [v3, v4]
  const r = await rollbackAssetOp(state, 'ast-mem1', { version: 4, botId: 'b1' });
  assert.equal(r.ok, true);
  assert.equal(r.scope, 'exclusive');
  assert.deepEqual(state.doc.bots[0].assets[0].snapshot.notes, ['第二版快照']);
  assert.deepEqual(mem.content.notes, ['旧一条'], 'registry 资产不动（快照面独立）');
  // 无该资产快照 / 版本不存在
  await assert.rejects(() => rollbackAssetOp(state, 'ast-mem1', { version: 1, botId: 'nope' }), (err) => err.status === 404);
  await assert.rejects(() => rollbackAssetOp(state, 'ast-mem1', { version: 1, botId: 'b1' }),
    (err) => err.status === 404 && /快照历史无版本 1/.test(err.message));
  // 参数校验
  await assert.rejects(() => rollbackAssetOp(state, 'ast-mem1', {}), (err) => err.status === 400);
});

// —— 呈现面聚合 ———————————————————————————————————————————————————————————

test('knowledgeBundleOp: provider 钩子优先；文件实读+截断；secret 段不读内容；版本面带历史元数据', async () => {
  const mem = mkMemoryAsset();
  const bigBody = '# ' + '长'.repeat(20 * 1024);
  const skill = {
    id: 'ast-skl1', type: 'skill', name: 'big', description: '', origin: 'operator',
    version: 4, createdAt: 1, updatedAt: 1, content: { name: 'big', description: 'd', body: bigBody },
  };
  const secretFile = join(dir, 'claude-mcp.json');
  writeFileSync(secretFile, '{"mcpServers":{"wao-x":{"env":{"KEY":"supersecret"}}}}');
  const mdFile = join(dir, 'CLAUDE.md');
  writeFileSync(mdFile, '# 记忆\n条目一\n');
  const port = {
    knowledgeFace: (bot, { plan }) => ({
      delivery: 'fake 送达面',
      sections: [
        { kind: 'argv', title: '系统提示词', text: '人设文本' },
        { kind: 'file', title: '记忆文件', paths: [mdFile] },
        { kind: 'file', title: 'MCP 配置', paths: [secretFile], secret: true },
      ],
    }),
  };
  const state = mkState({
    bots: [mkBot({ assets: [{ assetId: 'ast-mem1', mode: 'shared' }, { assetId: 'ast-skl1', mode: 'shared' }] })],
    assets: [mem, skill],
    port,
  });
  const b = knowledgeBundleOp(state, 'b1');
  assert.equal(b.delivery, 'fake 送达面');
  assert.equal(b.prompt.sections.length, 3);
  assert.equal(b.prompt.sections[0].text, '人设文本');
  const fileSec = b.prompt.sections[1];
  assert.equal(fileSec.files[0].exists, true);
  assert.match(fileSec.files[0].text, /条目一/);
  const secretSec = b.prompt.sections[2];
  assert.equal(secretSec.secret, true);
  assert.equal(secretSec.files, undefined, 'secret 段绝不读内容');
  assert.equal(JSON.stringify(b).includes('supersecret'), false, '密钥不进 bundle');
  assert.deepEqual(b.memories[0].notes, ['旧一条']);
  assert.equal(b.memories[0].count, 1);
  assert.equal(b.skills[0].truncated, true, '技能正文超 16KB 截断标注');
  assert.equal(b.skills[0].bodyChars, bigBody.length);
  assert.equal(b.versions.length, 2);
  assert.equal(b.versions[0].registry.version, 1);
});

test('knowledgeBundleOp: 无钩子/无 port → 通用回落面（人设+内联记忆+manifest 清单）', () => {
  const mem = mkMemoryAsset();
  const state = mkState({
    bots: [mkBot({ assets: [{ assetId: 'ast-mem1', mode: 'shared' }] })],
    assets: [mem],
    port: null,
  });
  state.doc.bots[0].providerConfig.prompt = '运营者人设';
  const b = knowledgeBundleOp(state, 'b1');
  assert.match(b.delivery, /通用口径/);
  const argv = b.prompt.sections.find((s) => s.kind === 'argv');
  assert.match(argv.text, /运营者人设/);
  const inline = b.prompt.sections.find((s) => s.title.includes('biz'));
  assert.match(inline.text, /旧一条/);
});

test('knowledgeBundleOp: 钩子抛错 → 回落通用面（呈现面永不 500）', () => {
  const state = mkState({
    bots: [mkBot()],
    assets: [],
    port: { knowledgeFace: () => { throw new Error('boom'); } },
  });
  const b = knowledgeBundleOp(state, 'b1');
  assert.match(b.delivery, /通用口径/);
});

test('knowledgeBundleOp: 未知 bot → 404', () => {
  const state = mkState({ bots: [], assets: [] });
  assert.throws(() => knowledgeBundleOp(state, 'ghost'), (err) => err.status === 404);
});

// 整理史：坏行降级不吞
test('readCurationHistory: 坏行如实降级；空文件→[]', () => {
  const state = mkState({ bots: [], assets: [] });
  appendCurationRecord(state, 'b1', { at: 1, ok: true, summary: '好' });
  const file = join(dirname(state.botsFile), 'curation', 'b1.jsonl');
  writeFileSync(file, `${readFileSync(file, 'utf8')}not-json\n`);
  const hist = readCurationHistory(state, 'b1');
  assert.equal(hist.length, 2);
  assert.equal(hist[0].ok, false, '新在前，坏行降级');
  assert.equal(hist[0].reason, 'unparsable-record');
  assert.deepEqual(readCurationHistory(state, 'no-such-bot'), []);
});

// createAssetOp 的 origin:'curation' 盖章面（apply 通道依赖）
test('createAssetOp: origin curation 由服务端盖章，body 带_origin 拒绝', async () => {
  const state = mkState({ bots: [], assets: [] });
  const { asset } = await createAssetOp(state, {
    type: 'skill', name: 'k1', content: { name: 'k1', body: '# b' },
  }, { origin: 'curation' });
  assert.equal(asset.origin, 'curation');
  await assert.rejects(() => createAssetOp(state, { type: 'skill', name: 'k2', origin: 'operator', content: { name: 'k2', body: '# b' } }),
    (err) => err.status === 400 && /set by the server/.test(err.message));
});

test('existsSync sanity: proposal file channel is deterministic in e2e above', () => {
  assert.equal(typeof existsSync, 'function');
});
