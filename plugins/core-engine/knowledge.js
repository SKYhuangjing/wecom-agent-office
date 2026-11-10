// 知识资产模块（DESIGN-KNOWLEDGE，2026-11-11）：bot 的记忆/文档/提示词从黑盒
// 变成平台一等公民资产——看得见（knowledgeBundleOp 聚合呈现面）、理得动
// （curateBotOp 整理轮：bot 用自己的引擎重整自己的知识，人只给引导文本）、
// 可回滚（rollbackAssetOp 版本历史，registry 资产面 + exclusive 快照面）。
//
// 依赖方向注记：本文件 import api.js 的 updateAssetOp/createAssetOp（函数声明，
// 提升可用），api.js 反向 import 本文件的三个 Op——ESM 循环在「双方仅运行期
// 调用、无顶层求值依赖」下安全，与仓库既有同插件协作风格一致。
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BOT_ID_RE, saveBots } from './bots.js';
import {
  bindAsset, buildPlan, rematerializeBots, resolveBinding, saveAssets,
} from './assets.js';
import { updateAssetOp, createAssetOp, cwdExistsError } from './api.js';
import { createUsageAccumulator } from './engine.js';

// 整理轮预算（DESIGN-KNOWLEDGE §4.1/§7）：整理是重负载轮（要读全量记忆+技能），
// 超时远大于岗前测试的 120s；prompt 上限独立（内联知识可达数十 KB，512KB 防御）。
export const CURATION_TIMEOUT_MS = 300_000;
export const CURATION_PROMPT_MAX_BYTES = 512 * 1024;
export const CURATION_GUIDANCE_MAX_CHARS = 2000;
export const CURATION_MAX_SKILLS = 3;
// exclusive 快照的版本环（registry 资产历史 cap 12 在 assets.js）。
export const SNAPSHOT_HISTORY_CAP = 6;
// 呈现面文件读取预算：单文件 80KB、全部文件合计 200KB——预览要全但不要撑爆
// 浏览器；被截断的文件如实标 truncated。
const FILE_READ_CAP = 80 * 1024;
const FILE_BUDGET_CAP = 200 * 1024;
// 技能正文内联上限（bundle 呈现与整理提示词共用同一口径）。
const SKILL_INLINE_CAP = 16 * 1024;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const httpError = (status, message) => {
  const err = new Error(message);
  err.status = status;
  return err;
};
const findBot = (state, botId) => state.doc.bots.find((b) => isObject(b) && b.id === botId) ?? null;
const findAsset = (state, assetId) => state.assetsDoc.assets.find((a) => isObject(a) && a.id === assetId) ?? null;

// —— 生效记忆目标（shared/exclusive 统一解析）——————————————————————————
// 首个生效 memory 绑定（bot.assets 顺序，同既有「首个 memory 资产」语义）：
// shared → registry 活资产；exclusive → bot 记录里的快照（源删除仍活）。这条
// 解析同时服务蒸馏写回、整理轮写回与知识呈现——修掉了「exclusive 记忆收不到
// 蒸馏写回」的既有缺口（updateAssetOp 只扇出 shared，快照此前永不更新）。
export function memoryTargetOf(state, bot) {
  for (const binding of Array.isArray(bot?.assets) ? bot.assets : []) {
    if (!isObject(binding)) continue;
    const asset = findAsset(state, binding.assetId);
    if (binding.mode === 'exclusive') {
      const type = binding.snapshotType ?? asset?.type ?? null;
      if (type !== 'memory' || !isObject(binding.snapshot)) continue;
      return {
        mode: 'exclusive', assetId: binding.assetId, binding, asset: asset ?? null,
        notes: Array.isArray(binding.snapshot.notes) ? binding.snapshot.notes : [],
        name: binding.snapshotName ?? asset?.name ?? binding.assetId,
      };
    }
    if (asset?.type === 'memory') {
      return {
        mode: 'shared', assetId: asset.id, binding, asset,
        notes: Array.isArray(asset.content?.notes) ? asset.content.notes : [],
        name: asset.name,
      };
    }
  }
  return null;
}

// exclusive 快照版本环：覆写前归档「变更前」状态（cap 6，满丢最旧）。
function pushSnapshotHistory(binding, via) {
  const hist = Array.isArray(binding.snapshotHistory) ? binding.snapshotHistory : [];
  hist.push({
    version: typeof binding.snapshotVersion === 'number' ? binding.snapshotVersion : 1,
    at: typeof binding.snapshotAt === 'number' ? binding.snapshotAt : Date.now(),
    via: via ?? 'operator',
    content: structuredClone(binding.snapshot ?? {}),
  });
  while (hist.length > SNAPSHOT_HISTORY_CAP) hist.shift();
  binding.snapshotHistory = hist;
}

// 把整理后的全量 notes 写回生效记忆目标（蒸馏写回与整理轮共用）：
// shared → updateAssetOp（version bump + history + shared 扇出重物化）；
// exclusive → 快照覆写（snapshotHistory 归档）+ 本 bot 重物化。
export async function applyMemoryNotes(state, bot, notes, via = 'distill') {
  const target = memoryTargetOf(state, bot);
  if (target == null) return { ok: false, reason: '该 bot 未绑定 memory 资产' };
  if (!Array.isArray(notes)) return { ok: false, reason: 'notes must be a list' };
  if (target.mode === 'shared') {
    const before = target.notes.length;
    await updateAssetOp(state, target.assetId, { content: { notes } }, { via });
    return { ok: true, mode: 'shared', assetId: target.assetId, before, after: notes.length };
  }
  const binding = target.binding;
  const before = target.notes.length;
  pushSnapshotHistory(binding, via);
  binding.snapshot = { notes: [...notes] };
  binding.snapshotVersion = (typeof binding.snapshotVersion === 'number' ? binding.snapshotVersion : 0) + 1;
  binding.snapshotAt = Date.now();
  saveBots(state.botsFile, state.doc);
  const receipt = await rematerializeBots(state, [bot]);
  if (receipt.failed.length > 0) {
    return { ok: false, assetId: target.assetId, reason: `重物化失败：${receipt.failed[0].error}` };
  }
  return {
    ok: true, mode: 'exclusive', assetId: target.assetId, before, after: notes.length,
    version: binding.snapshotVersion,
  };
}

// curation 更新技能后同步本 bot 的 exclusive 快照（updateAssetOp 刻意不动快照
// ——§6 语义；但整理轮的目的就是让本 bot 立即用上新知识，显式同步）。
async function syncExclusiveSnapshot(state, bot, assetId, via) {
  const binding = (Array.isArray(bot.assets) ? bot.assets : []).find((b) => isObject(b) && b.assetId === assetId && b.mode === 'exclusive');
  if (binding == null) return false;
  const asset = findAsset(state, assetId);
  if (asset == null) return false;
  pushSnapshotHistory(binding, via);
  binding.snapshot = structuredClone(asset.content);
  binding.snapshotVersion = asset.version;
  binding.snapshotAt = Date.now();
  saveBots(state.botsFile, state.doc);
  await rematerializeBots(state, [bot]);
  return true;
}

// —— 整理史（观测面，DESIGN-KNOWLEDGE §4.4）————————————————————————————
// data/curation/<botId>.jsonl append-only：每轮整理（含失败轮）一条，含
// before/after 变更明细、逐项 skipped 原因与整理轮 usage。效果报表是 v2；
// 数据现在就留全。
// botId 防御性二检（同 ledgerFor 先例）：手改/漂移的 bots.json 条目绝不能把
// 整理史写出 data 目录——不合 BOT_ID_RE 的 id 就地清洗为下划线。
const curationFileOf = (state, botId) => {
  const safe = typeof botId === 'string' && BOT_ID_RE.test(botId)
    ? botId : String(botId ?? 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(dirname(state.botsFile), 'curation', `${safe}.jsonl`);
};

export function appendCurationRecord(state, botId, record) {
  const file = curationFileOf(state, botId);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`);
}

// 最近 limit 条，新在前（UI 呈现序）；坏行如实降级不吞（unparsable-record）。
export function readCurationHistory(state, botId, limit = 10) {
  const file = curationFileOf(state, botId);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
  return lines.slice(-limit).map((l) => {
    try { return JSON.parse(l); } catch { return { at: null, ok: false, reason: 'unparsable-record' }; }
  }).reverse();
}

// —— 呈现面聚合（GET /api/bots/:id/knowledge）——————————————————————————
const readCapped = (path, cap) => {
  if (typeof path !== 'string' || path === '' || !existsSync(path)) {
    return { path, exists: false, text: '', bytes: 0, truncated: false };
  }
  if (cap <= 0) return { path, exists: true, text: '', bytes: 0, truncated: true };
  try {
    const text = readFileSync(path, 'utf8');
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes <= cap) return { path, exists: true, text, bytes, truncated: false };
    return { path, exists: true, text: text.slice(0, cap), bytes, truncated: true };
  } catch (err) {
    return { path, exists: true, text: `（读取失败：${err?.message ?? err}）`, bytes: 0, truncated: false };
  }
};

// 通用回落面（provider 未提供 knowledgeFace 钩子时）：人设 + 绑定资产文本 +
// manifest 盘面文件清单——不求送达面精确，但内容如实。
function genericKnowledgeFace(bot, { plan, manifest }) {
  const pc = bot.providerConfig ?? {};
  const sections = [];
  const argvTexts = [];
  if (typeof pc.prompt === 'string' && pc.prompt.trim() !== '') argvTexts.push(pc.prompt);
  for (const entry of plan ?? []) {
    if (entry.type === 'prompt') argvTexts.push(String(entry.content?.text ?? ''));
    if (entry.type === 'memory') {
      sections.push({
        kind: 'inline', title: `跨会话记忆（${entry.name}）`,
        text: (entry.content?.notes ?? []).join('\n') || '（暂无条目）',
      });
    }
  }
  sections.unshift({ kind: 'argv', title: '系统提示词（人设 + 提示词资产）', text: argvTexts.join('\n\n') || '（空）' });
  const files = (manifest?.entries ?? []).map((e) => e?.file).filter((f) => typeof f === 'string' && f !== '');
  if (files.length > 0) sections.push({ kind: 'file', title: '物化盘面文件（manifest）', paths: files });
  sections.push({
    kind: 'stdin', title: '任务信封（每轮用户消息）',
    text: '[会话自愈 handoff 前缀] + 用户消息 + [附件段] + [失败注记段]，以 \n\n---\n\n 连接。',
  });
  return { delivery: `${bot.provider}：该引擎未提供送达面钩子，以下为通用口径（argv/盘面可能不精确）。`, sections };
}

const ORIGIN_LABEL = { operator: '人写', plugin: '系统', mcp: 'Agent 建', curation: 'AI 整理' };

export function knowledgeBundleOp(state, botId) {
  const bot = findBot(state, botId);
  if (bot == null) throw httpError(404, 'bot not found');
  const port = state.ports?.getProvider?.(bot.provider) ?? null;
  const { plan, suppressed } = buildPlan(state.assetsDoc.assets, bot);
  const manifest = typeof state.materializer?.getManifest === 'function'
    ? state.materializer.getManifest(botId) : null;
  const assetsRoot = join(dirname(state.assetsFile), 'assets');

  // 提示词送达面：provider 钩子优先（它最清楚自己的 argv/盘面/信封），钩子
  // 失败回落通用面——呈现面永远可用，绝不因钩子抛错而 500。
  let face = null;
  if (port != null && typeof port.knowledgeFace === 'function') {
    try {
      face = port.knowledgeFace(bot, { plan, manifest, assetsRoot });
    } catch (err) {
      state.log?.warn?.(`knowledge: knowledgeFace(${bot.provider}) failed: ${err?.message ?? err}`);
      face = null;
    }
  }
  if (face == null || !Array.isArray(face.sections)) face = genericKnowledgeFace(bot, { plan, manifest });

  // 文件段落实读（预算内截断、secret 段不读内容只列路径）。
  let budget = FILE_BUDGET_CAP;
  const sections = [];
  for (const s of face.sections) {
    if (!isObject(s)) continue;
    const section = { kind: s.kind ?? 'inline', title: s.title ?? '', ...(s.note != null ? { note: s.note } : {}) };
    if (Array.isArray(s.paths) && s.paths.length > 0) {
      section.paths = s.paths;
      if (s.secret === true) {
        section.secret = true;
      } else {
        section.files = s.paths.map((p) => {
          const cap = Math.max(0, Math.min(FILE_READ_CAP, budget));
          const loaded = readCapped(p, cap);
          budget -= loaded.bytes;
          return loaded;
        });
      }
    } else if (typeof s.text === 'string') {
      section.text = s.text;
    }
    sections.push(section);
  }

  // 记忆（生效条目全文 + 条数/上限）与技能（正文内联 ≤16KB，超限如实标注）。
  const metaOf = (assetId) => {
    const binding = (Array.isArray(bot.assets) ? bot.assets : []).find((b) => isObject(b) && b.assetId === assetId);
    const resolved = binding != null ? resolveBinding(state.assetsDoc.assets, binding) : null;
    return resolved ?? null;
  };
  const memories = [];
  const skills = [];
  for (const entry of plan) {
    if (entry.type === 'memory') {
      const meta = metaOf(entry.assetId);
      const notes = (entry.content?.notes ?? []).map(String);
      memories.push({
        assetId: entry.assetId, name: entry.name, mode: entry.mode,
        origin: meta?.origin ?? 'operator', originLabel: ORIGIN_LABEL[meta?.origin ?? 'operator'] ?? meta?.origin,
        notes, count: notes.length, cap: 50,
      });
    } else if (entry.type === 'skill') {
      const meta = metaOf(entry.assetId);
      const body = String(entry.content?.body ?? '');
      skills.push({
        assetId: entry.assetId, name: entry.content?.name ?? entry.name, displayName: entry.name,
        description: entry.content?.description ?? '',
        mode: entry.mode, origin: meta?.origin ?? 'operator', originLabel: ORIGIN_LABEL[meta?.origin ?? 'operator'] ?? meta?.origin,
        version: meta?.version ?? null,
        body: body.slice(0, SKILL_INLINE_CAP), bodyChars: body.length, truncated: body.length > SKILL_INLINE_CAP,
      });
    }
  }

  // 版本面（回滚 UI 的数据源）：bound 的 memory/skill 资产，registry 历史与
  // exclusive 快照历史都给元数据（content 留服务端，回滚按版本号取）。
  const histMeta = (h) => ({ version: h?.version, at: h?.at, via: h?.via });
  const versions = [];
  for (const binding of Array.isArray(bot.assets) ? bot.assets : []) {
    if (!isObject(binding)) continue;
    const resolved = resolveBinding(state.assetsDoc.assets, binding);
    if (resolved == null || (resolved.type !== 'memory' && resolved.type !== 'skill')) continue;
    const registryAsset = findAsset(state, binding.assetId);
    versions.push({
      assetId: binding.assetId, name: resolved.name, type: resolved.type, mode: resolved.mode,
      origin: resolved.origin ?? 'operator', originLabel: ORIGIN_LABEL[resolved.origin ?? 'operator'] ?? resolved.origin,
      effectiveVersion: resolved.version,
      registry: registryAsset != null ? {
        version: registryAsset.version,
        history: (Array.isArray(registryAsset.history) ? registryAsset.history : []).map(histMeta),
      } : null,
      snapshot: binding.mode === 'exclusive' ? {
        version: binding.snapshotVersion ?? null,
        history: (Array.isArray(binding.snapshotHistory) ? binding.snapshotHistory : []).map(histMeta),
      } : null,
    });
  }

  return {
    botId, botName: typeof bot.name === 'string' && bot.name !== '' ? bot.name : botId,
    provider: bot.provider,
    delivery: face.delivery ?? '',
    prompt: { sections },
    memories,
    skills,
    versions,
    curation: readCurationHistory(state, botId, 10),
    ...(suppressed.length > 0 ? { suppressed } : {}),
  };
}

// —— 整理轮（POST /api/bots/:id/curate）————————————————————————————————
// 同 bot 互斥（内存锁）；跨请求进程重启锁自然消失（锁不落盘，最坏情况是两轮
// 整理串行应用，apply 逐项原子，可回滚）。
const curationLocks = new Map();

export function buildCurationPrompt(bot, { memories, skills, guidance, proposalPath }) {
  const lines = [];
  lines.push('【WAO 知识整理轮】');
  lines.push(`你是机器人 ${bot.id}（引擎 ${bot.provider}）。平台请求你整理自己的长期知识，让它更精炼、更专业、下次更高效。`);
  lines.push('');
  lines.push('## 你的当前知识');
  if (memories.length === 0 && skills.length === 0) {
    lines.push('（当前没有绑定任何记忆/技能资产——如无值得沉淀的内容，输出空技能列表即可）');
  }
  for (const m of memories) {
    lines.push(`### 记忆（${m.count}/${m.cap} 条，资产 ${m.name}，${m.mode === 'shared' ? '共享' : '独立副本'}）`);
    if (m.notes.length === 0) lines.push('（暂无条目）');
    m.notes.forEach((n, i) => lines.push(`${i + 1}. ${n}`));
  }
  for (const s of skills) {
    lines.push(`### 技能：${s.name}（${s.originLabel}${s.mode === 'shared' ? '·共享' : '·独立副本'}）`);
    if (s.description !== '') lines.push(`描述：${s.description}`);
    if (s.truncated) {
      lines.push(`正文超长（${s.bodyChars} 字），此前 ${SKILL_INLINE_CAP} 字内联如下；整理时保持正文主体不变，只做必要修订：`);
    }
    lines.push(s.body);
  }
  lines.push('');
  lines.push('## 整理规则');
  lines.push('1. 记忆：合并重复、剔除已过时、压缩冗长；优先保留「操作路径」类知识（用什么工具/命令/参数做成某事）。绝不为整理而整理——没有改进空间就原样保留（原样输出 notes）。');
  lines.push('2. 文档：把高频操作模式升级为技能文档（新建 action=create，或修订你之前创建的技能 action=update）；「人写」「系统」「Agent 建」来源的技能只读，不得修改。');
  lines.push('3. 人的引导（优先满足）：' + (guidance !== '' ? guidance : '（无）'));
  lines.push('');
  lines.push('## 输出协议（严格执行）');
  lines.push(`用 Write 工具把提案写到 ${proposalPath}（无写文件能力则把同构 JSON 放进最终回复的 \`\`\`json 围栏）。提案形状（缩进示意——实际输出必须是合法 JSON，不要照抄占位文字）：`);
  lines.push('    {');
  lines.push('      "memory": { "notes": ["整理后的全量记忆条目（整组替换；没有改进空间则原样输出）"] },');
  lines.push('      "skills": [ { "action": "create 或 update", "name": "小写连字符slug", "description": "≤200字", "body": "# markdown 全文（≤60KB）" } ],  // ≤3 项，可省略');
  lines.push('      "summary": "一句话：本次整理做了什么、为什么"');
  lines.push('    }');
  lines.push('说明：memory 与 skills 都可省略（无改动就不写该键）；skills 的 update 只允许改「AI 整理」来源的技能。写完后回复一句简短总结。');
  return lines.join('\n');
}

// 最终回复围栏解析（文件提案缺失时的回退通道，dsh 等无写文件面的引擎）：
// 收集全部 ```json 围栏 + 整段文本兜底，返回首个形似提案（含 memory/skills
// 键）的对象；都不形似 → null（拒绝优于静默猜测）。
export function parseCurationProposal(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  const candidates = [];
  for (const m of text.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)```/g)) candidates.push(m[1]);
  candidates.push(text);
  for (const raw of candidates) {
    const t = String(raw).trim();
    if (!t.startsWith('{')) continue;
    // 模板占位痕迹（提示词示例被原样回显）不是提案——跳过试下一个
    if (/create\|update|整理后的全量记忆条目/.test(t)) continue;
    try {
      const v = JSON.parse(t);
      if (isObject(v) && (v.memory != null || Array.isArray(v.skills))) return v;
    } catch { /* try next */ }
  }
  return null;
}

// 提案校验（纯函数，拒绝优于静默纠正）：合法项通过，非法项进 skipped 带原因。
// ctx = { registrySkills: [{assetId, assetName, contentName, origin, bound}],
//         currentNotes: string[] }
export function validateCurationProposal(proposal, ctx = {}) {
  const out = { memory: null, memoryUnchanged: false, skills: [], skipped: [], summary: '' };
  if (!isObject(proposal)) {
    out.skipped.push({ part: 'proposal', reason: '提案不是 JSON 对象' });
    return out;
  }
  if (typeof proposal.summary === 'string' && proposal.summary.trim() !== '') {
    out.summary = proposal.summary.trim().slice(0, 500);
  }
  const registrySkills = Array.isArray(ctx.registrySkills) ? ctx.registrySkills : [];
  const currentNotes = Array.isArray(ctx.currentNotes) ? ctx.currentNotes.map(String) : [];

  if (proposal.memory != null) {
    const m = proposal.memory;
    if (!isObject(m) || !Array.isArray(m.notes)) {
      out.skipped.push({ part: 'memory', reason: 'memory 必须是 {notes: [...]}' });
    } else if (m.notes.length > 50) {
      out.skipped.push({ part: 'memory', reason: `notes 条数超限（≤50，实际 ${m.notes.length}）` });
    } else if (m.notes.some((n) => typeof n !== 'string' || n.trim() === '' || n.trim().length > 2 * 1024)) {
      out.skipped.push({ part: 'memory', reason: '每条 note 必须是非空字符串且 trim 后 ≤2KB' });
    } else {
      const notes = m.notes.map((n) => n.trim());
      if (JSON.stringify(notes) === JSON.stringify(currentNotes)) {
        out.memoryUnchanged = true; // 没有改进空间——合法，只是无事可做
      } else {
        out.memory = { notes };
      }
    }
  }

  if (proposal.skills != null) {
    if (!Array.isArray(proposal.skills)) {
      out.skipped.push({ part: 'skills', reason: 'skills 必须是数组' });
    } else {
      if (proposal.skills.length > CURATION_MAX_SKILLS) {
        out.skipped.push({ part: 'skills', reason: `单轮最多 ${CURATION_MAX_SKILLS} 项技能（提案 ${proposal.skills.length} 项）` });
      }
      for (const item of proposal.skills.slice(0, CURATION_MAX_SKILLS)) {
        if (!isObject(item)) { out.skipped.push({ name: '?', reason: '技能项不是对象' }); continue; }
        const name = item.name;
        if (item.action !== 'create' && item.action !== 'update') {
          out.skipped.push({ name: String(name ?? '?'), reason: 'action 必须是 create 或 update' });
          continue;
        }
        if (typeof name !== 'string' || !SLUG_RE.test(name)) {
          out.skipped.push({ name: String(name ?? '?'), reason: 'name 必须匹配 ^[a-z0-9][a-z0-9-]{0,63}$' });
          continue;
        }
        const description = typeof item.description === 'string' ? item.description.trim().slice(0, 200) : '';
        if (typeof item.body !== 'string' || item.body.trim() === '' || item.body.length > 60 * 1024) {
          out.skipped.push({ name, reason: 'body 必须是非空字符串且 ≤60KB' });
          continue;
        }
        const clash = registrySkills.find((s) => s.contentName === name || s.assetName === name);
        if (item.action === 'create') {
          if (clash != null) {
            out.skipped.push({ name, reason: `已存在同名技能（${clash.assetId}）——create 不得重名，改进它请用 update` });
            continue;
          }
          out.skills.push({ action: 'create', name, description, body: item.body });
        } else {
          if (clash == null) {
            out.skipped.push({ name, reason: 'update 目标不存在（按 content.name 匹配注册表技能）' });
            continue;
          }
          if (clash.origin !== 'curation') {
            out.skipped.push({ name, reason: `update 仅允许改「AI 整理」来源的技能（目标 origin=${clash.origin ?? 'operator'} 只读）` });
            continue;
          }
          if (clash.bound !== true) {
            out.skipped.push({ name, reason: 'update 目标未绑定到本 bot' });
            continue;
          }
          out.skills.push({ action: 'update', name, description, body: item.body, assetId: clash.assetId });
        }
      }
    }
  }
  return out;
}

// curation 上下文：注册表全部技能（create 撞名检查）+ 本 bot 绑定标记。
function curationContext(state, bot) {
  const bound = new Set((Array.isArray(bot.assets) ? bot.assets : []).map((b) => b?.assetId));
  const registrySkills = state.assetsDoc.assets
    .filter((a) => isObject(a) && a.type === 'skill')
    .map((a) => ({
      assetId: a.id, assetName: a.name, contentName: a.content?.name ?? a.name,
      origin: a.origin ?? 'operator', bound: bound.has(a.id),
    }));
  const target = memoryTargetOf(state, bot);
  return { registrySkills, currentNotes: target?.notes ?? [], memoryTarget: target };
}

async function applyCuration(state, bot, validated) {
  const changes = {
    memory: null, memoryUnchanged: validated.memoryUnchanged,
    skillsCreated: [], skillsUpdated: [], skipped: [...validated.skipped],
  };
  if (validated.memory != null) {
    try {
      const r = await applyMemoryNotes(state, bot, validated.memory.notes, 'curation');
      if (r.ok) changes.memory = { before: r.before, after: r.after, mode: r.mode };
      else changes.skipped.push({ part: 'memory', reason: r.reason });
    } catch (err) {
      changes.skipped.push({ part: 'memory', reason: err?.message ?? String(err) });
    }
  }
  for (const item of validated.skills) {
    try {
      if (item.action === 'create') {
        const { asset } = await createAssetOp(state, {
          type: 'skill', name: item.name, description: item.description,
          content: { name: item.name, description: item.description, body: item.body },
        }, { origin: 'curation' });
        // curation 产物自动 exclusive 绑定本 bot（AI 产物不自动跨 bot 共享；
        // 运营可在工具库改绑 shared 扩散）。
        try {
          await bindAsset(state, bot.id, { assetId: asset.id, mode: 'exclusive' });
        } catch (bindErr) {
          // P1-2（盲审）：create 成功但 bind 失败（外来技能文件/跨 bot 冲突等）
          // 会留下 0 绑定的孤儿资产，且下轮同名 create 撞「不得重名」——补偿
          // 回收刚建的注册表条目（此刻它没有任何绑定/物化产物，直删即净）。
          // createAssetOp 回显是克隆（publicAsset）——按 id 定位注册表本体
          const idx = state.assetsDoc.assets.findIndex((a) => a?.id === asset.id);
          if (idx >= 0) state.assetsDoc.assets.splice(idx, 1);
          saveAssets(state.assetsFile, state.assetsDoc);
          throw new Error(`技能已生成但绑定失败（${bindErr?.message ?? bindErr}）——资产已回收未留孤儿：${item.name}`);
        }
        changes.skillsCreated.push({ assetId: asset.id, name: item.name });
      } else {
        const { asset } = await updateAssetOp(state, item.assetId, {
          ...(item.description !== '' ? { description: item.description } : {}),
          content: { name: item.name, description: item.description, body: item.body },
        }, { via: 'curation' });
        await syncExclusiveSnapshot(state, bot, item.assetId, 'curation');
        changes.skillsUpdated.push({ assetId: asset.id, name: item.name });
      }
    } catch (err) {
      changes.skipped.push({ name: item.name, reason: err?.message ?? String(err) });
    }
  }
  return changes;
}

async function runCurationTurn(state, bot, port, guidance) {
  const bundle = knowledgeBundleOp(state, bot.id); // reuse: effective memories/skills
  const startedAt = Date.now();
  // P2-7（盲审）：提案文件按轮次 nonce 命名——看门狗强结算后超时轮的 CLI 仍
  // 可能晚到写盘，固定名会让下一轮把僵尸提案当新鲜货应用；nonce 文件留在
  // 盘上兼作审计轨迹。
  const proposalPath = join(bot.providerConfig.cwd, '.wao', 'curation', `proposal-${startedAt}.json`);
  // P1-1（盲审）：整理轮起跑时记下生效记忆的版本基线。整理可跑数分钟，窗口
  // 期内普通轮的蒸馏写回/人工 PATCH/另一台 shared bot 的整理都可能推进版本——
  // 基线漂移时整组替换会静默吞掉这些写入，改为跳过 memory 项并如实记因。
  const memoryBaseline = (() => {
    const t = memoryTargetOf(state, bot);
    if (t == null) return null;
    if (t.mode === 'shared') return { assetId: t.assetId, version: t.asset?.version ?? null };
    return { assetId: t.assetId, version: t.binding?.snapshotVersion ?? null };
  })();
  const prompt = buildCurationPrompt(bot, {
    memories: bundle.memories, skills: bundle.skills, guidance, proposalPath,
  });
  const promptBytes = Buffer.byteLength(prompt, 'utf8');
  if (promptBytes > CURATION_PROMPT_MAX_BYTES) {
    throw httpError(400, `整理提示词超限（${Math.round(promptBytes / 1024)}KB > ${CURATION_PROMPT_MAX_BYTES / 1024}KB）——绑定知识过多，先人工精简`);
  }

  // 以装备态直跑（同 testBotOp §3.1：bare plan + manifest file targets enrich）。
  const barePlan = buildPlan(state.assetsDoc.assets, bot).plan;
  const assets = barePlan.length > 0 && typeof state.materializer?.targetsFor === 'function'
    ? state.materializer.targetsFor(bot, barePlan)
    : barePlan;
  const runner = port.createRunner({ bot, providerConfig: bot.providerConfig, assets, log: state.log });

  const usageAcc = createUsageAccumulator();
  // settle 看门狗（同 testBotOp：孤儿孙进程持有 pipe 时路由必答）。
  const ac = new AbortController();
  const guardTimer = setTimeout(() => ac.abort(), CURATION_TIMEOUT_MS);
  let bail = null;
  const guard = new Promise((resolve) => {
    bail = setTimeout(() => {
      state.log?.warn?.(`knowledge: curation settle-watchdog fired for ${bot.id} — force-settling`);
      resolve({
        ok: false, code: 'timeout', finalText: '', aborted: true, sessionId: null,
        reason: 'settle-watchdog', detail: { exitCode: null, stderrTail: '' },
      });
    }, CURATION_TIMEOUT_MS + 30_000);
  });
  let events = 0;
  let result;
  try {
    result = await Promise.race([
      runner.run({
        prompt, sessionId: null, attachments: [],
        signal: ac.signal, timeoutMs: CURATION_TIMEOUT_MS,
        onEvent: (ev) => { events++; usageAcc.observe(ev); },
      }),
      guard,
    ]);
  } finally {
    clearTimeout(guardTimer);
    clearTimeout(bail);
  }
  usageAcc.observeResult(result);

  const record = {
    at: Date.now(), guidance, ok: false, summary: '', changes: null,
    run: { code: result?.code ?? 'error', events, sessionId: result?.sessionId ?? null },
    usage: usageAcc.summary(),
    proposalPath,
  };

  if (result?.code !== 'completed') {
    // reason 可能是对象（各家 runner 的 reason 形状不一）——整理史要可读
    const rawReason = result?.reason;
    record.reason = typeof rawReason === 'string' ? rawReason
      : (rawReason?.kind ?? result?.code ?? 'run-failed');
    try {
      record.errorText = typeof port.describeError === 'function' ? String(port.describeError(result)) : String(result?.error ?? 'run failed');
    } catch { record.errorText = String(result?.error ?? 'run failed'); }
    return record;
  }

  // 提案解析：文件优先，围栏回退。
  let proposal = null;
  let source = null;
  const fromFile = readCapped(proposalPath, 1024 * 1024);
  if (fromFile.exists && !fromFile.truncated && fromFile.text.trim().startsWith('{')) {
    try {
      const v = JSON.parse(fromFile.text);
      if (isObject(v)) { proposal = v; source = 'file'; }
    } catch { /* fall through to fence */ }
  }
  if (proposal == null) {
    proposal = parseCurationProposal(result.finalText ?? '');
    if (proposal != null) source = 'fence';
  }
  if (proposal == null) {
    record.reason = 'proposal-missing（模型未写出提案文件，最终回复也无合法 JSON 围栏）';
    record.summary = String(result.finalText ?? '').slice(0, 500);
    return record;
  }

  const ctx = curationContext(state, bot);
  const validated = validateCurationProposal(proposal, ctx);
  // P1-1 续：应用前重读基线，漂移（蒸馏/人工/他台整理在窗口期写过）→ memory
  // 项不替换，进 skipped 带原因；被吞风险归零，改动仍在 history 可人工比对。
  const drifted = (() => {
    if (memoryBaseline == null || validated.memory == null) return null;
    const now = memoryTargetOf(state, bot);
    if (now == null || now.assetId !== memoryBaseline.assetId) return '记忆绑定在整理期间变化';
    const v = now.mode === 'shared' ? (now.asset?.version ?? null) : (now.binding?.snapshotVersion ?? null);
    return v !== memoryBaseline.version ? `记忆在整理期间被更新（v${memoryBaseline.version}→v${v}，蒸馏/人工或他台整理写入），本轮不替换——再跑一轮整理即可把新条目并入` : null;
  })();
  if (drifted != null) {
    validated.skipped.push({ part: 'memory', reason: drifted });
    validated.memory = null;
  }
  const changes = await applyCuration(state, bot, validated);
  record.source = source;
  record.summary = validated.summary
    ?? (changes.memory != null ? `记忆 ${changes.memory.before}→${changes.memory.after} 条` : '记忆未变');
  record.changes = changes;
  const appliedSomething = changes.memory != null || changes.skillsCreated.length > 0 || changes.skillsUpdated.length > 0;
  record.ok = appliedSomething || (validated.memoryUnchanged && changes.skipped.length === 0);
  if (!appliedSomething) {
    record.reason = changes.skipped.length > 0
      ? 'proposal-rejected（全部提案项未通过校验，见 changes.skipped）'
      : 'proposal-empty（提案既无记忆改动也无技能条目——没有改进空间时应原样输出 notes）';
  }
  return record;
}

export async function curateBotOp(state, botId, body = {}) {
  const bot = findBot(state, botId);
  if (bot == null) throw httpError(404, 'bot not found');
  const port = state.ports?.getProvider?.(bot.provider);
  if (port == null || typeof port.createRunner !== 'function') {
    throw httpError(400, `provider ${bot.provider} unavailable`);
  }
  if (!isObject(body)) throw httpError(400, 'curate body must be a JSON object');
  let guidance = '';
  if (body.guidance !== undefined && body.guidance !== null && body.guidance !== '') {
    if (typeof body.guidance !== 'string') throw httpError(400, 'guidance must be a string when present');
    if (body.guidance.length > CURATION_GUIDANCE_MAX_CHARS) {
      throw httpError(400, `guidance 最长 ${CURATION_GUIDANCE_MAX_CHARS} 字（当前 ${body.guidance.length}）——精简后再发起`);
    }
    guidance = body.guidance.trim().slice(0, CURATION_GUIDANCE_MAX_CHARS);
  }
  const cwdErr = cwdExistsError(bot);
  if (cwdErr != null) throw httpError(400, cwdErr);
  // P2-9（盲审）：cwd 缺失/非串的漂移记录会让 join() 抛 TypeError → 500——
  // 显式 400 指名（cwdExistsError 只管「存在性」不管 schema 面）。
  if (typeof bot.providerConfig?.cwd !== 'string' || bot.providerConfig.cwd === '') {
    throw httpError(400, '该 bot 缺少工作目录（providerConfig.cwd），无法整理——先在设置里补齐');
  }
  // P1-3（盲审）：多份生效记忆绑定时，提案协议（单 memory.notes）没法对位
  // 写回目标——v1 明确拒绝并给指引，不静默错位替换。
  if (buildPlan(state.assetsDoc.assets, bot).plan.filter((e) => e.type === 'memory').length > 1) {
    throw httpError(400, '该 bot 绑定了多份记忆资产，整理轮 v1 仅支持单份——先在工具库解绑或合并记忆资产');
  }
  if (curationLocks.has(botId)) {
    throw httpError(409, '该机器人已有整理轮在进行中，请稍候再试');
  }
  curationLocks.set(botId, true);
  let record;
  try {
    record = await runCurationTurn(state, bot, port, guidance);
  } finally {
    curationLocks.delete(botId);
  }
  appendCurationRecord(state, botId, record);
  state.log?.info?.(`knowledge: curation ${botId} → ${record.ok ? 'ok' : `failed(${record.reason ?? '?'})`} ${record.summary}`);
  return record;
}

// —— 版本回滚（POST /api/assets/:id/rollback）——————————————————————————
// 两个作用域：registry（默认，走 updateAssetOp 保持校验+扇出语义）与本 bot 的
// exclusive 快照（botId 给定时——快照历史在 binding 上，与 registry 独立）。
export async function rollbackAssetOp(state, assetId, body = {}) {
  if (!isObject(body)) throw httpError(400, 'rollback body must be a JSON object');
  const version = body.version;
  if (!Number.isInteger(version) || version <= 0) throw httpError(400, 'version 必须是正整数');
  if (body.botId !== undefined) {
    if (typeof body.botId !== 'string' || body.botId === '') {
      throw httpError(400, 'botId must be a non-empty string when present');
    }
    const bot = findBot(state, body.botId);
    if (bot == null) throw httpError(404, 'bot not found');
    const binding = (Array.isArray(bot.assets) ? bot.assets : [])
      .find((b) => isObject(b) && b.assetId === assetId && b.mode === 'exclusive');
    if (binding == null) throw httpError(404, `bot ${body.botId} 没有该工具的独立（exclusive）副本`);
    const hist = Array.isArray(binding.snapshotHistory) ? binding.snapshotHistory : [];
    const entry = hist.find((h) => isObject(h) && h.version === version);
    if (entry == null) {
      throw httpError(404, `快照历史无版本 ${version}（现有：${hist.map((h) => h.version).join(', ') || '无'}）`);
    }
    pushSnapshotHistory(binding, 'rollback');
    binding.snapshot = structuredClone(entry.content);
    binding.snapshotVersion = (typeof binding.snapshotVersion === 'number' ? binding.snapshotVersion : 0) + 1;
    binding.snapshotAt = Date.now();
    saveBots(state.botsFile, state.doc);
    const receipt = await rematerializeBots(state, [bot]);
    return { ok: true, scope: 'exclusive', assetId, botId: body.botId, restoredVersion: version, ...receipt };
  }
  const asset = findAsset(state, assetId);
  if (asset == null) throw httpError(404, 'asset not found');
  const hist = Array.isArray(asset.history) ? asset.history : [];
  const entry = hist.find((h) => isObject(h) && h.version === version && isObject(h.content));
  if (entry == null) {
    throw httpError(404, `资产历史无版本 ${version}（现有：${hist.map((h) => h.version).join(', ') || '无'}）`);
  }
  const { asset: updated, ...receipt } = await updateAssetOp(
    state, assetId, { content: structuredClone(entry.content) }, { via: 'rollback' },
  );
  return { ok: true, scope: 'registry', assetId, restoredVersion: version, version: updated.version, ...receipt };
}
