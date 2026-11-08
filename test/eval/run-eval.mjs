#!/usr/bin/env node
// Bot 效果回归评估：读取 questions.json，对指定 bot 逐题发送
// POST /api/bots/:id/test（探针端点，不走通道、不写 ledger、不碰生产数据），
// 按 expect 规则自动判定并输出 JSON 报告 + 控制台摘要。
//
// 用法：
//   node test/eval/run-eval.mjs --bot main --api http://127.0.0.1:8792
//   node test/eval/run-eval.mjs --bot main --api http://127.0.0.1:8792 --compare   # 对比上次结果
//   可选：--questions <path>  自定义问题集（默认脚本旁 questions.json）
//        --timeout <ms>      单题 HTTP 超时（默认 150000；服务端探针上限 120s）
//
// 退出码：0 = 全部通过；1 = 存在未通过（或对比发现回归）；2 = 用法/连接/协议错误。
// 零依赖（Node >= 22 原生 fetch），结果写入 test/eval/results/<botId>/<timestamp>.json。
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, 'results');

// ── 参数 ─────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--compare') out.compare = true;
    else if (a === '--bot' || a === '--api' || a === '--questions' || a === '--timeout') {
      const v = argv[++i];
      if (v === undefined) fail(2, `${a} 需要一个值`);
      out[a.slice(2)] = v;
    } else out._.push(a);
  }
  if (!out.bot) fail(2, '缺少 --bot <botId>，例如 --bot main');
  if (!out.api) fail(2, '缺少 --api <baseUrl>，例如 --api http://127.0.0.1:8792');
  out.api = out.api.replace(/\/+$/, '');
  const t = out.timeout === undefined ? 150000 : Number(out.timeout);
  if (!Number.isFinite(t) || t <= 0) fail(2, `--timeout 非法: ${out.timeout}`);
  out.timeout = t;
  return out;
}
function fail(code, msg) { console.error(`错误: ${msg}`); process.exit(code); }

// ── 问题集加载与校验 ──────────────────────────────────────────────────
function loadQuestions(path) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    fail(2, `问题集无法读取/解析: ${path}\n  ${e.message}`);
  }
  if (!doc || !Array.isArray(doc.categories) || doc.categories.length === 0) {
    fail(2, `问题集缺少 categories 数组: ${path}`);
  }
  const flat = [];
  for (const c of doc.categories) {
    if (!c || typeof c.id !== 'string' || !c.id) fail(2, '类别缺少 id');
    if (!Array.isArray(c.questions)) fail(2, `类别 ${c.id} 缺少 questions 数组`);
    for (const q of c.questions) {
      if (!q || typeof q.id !== 'string' || !q.id) fail(2, `类别 ${c.id} 有问题缺少 id`);
      if (typeof q.prompt !== 'string') fail(2, `问题 ${q.id} prompt 必须是字符串`);
      if (!q.expect || typeof q.expect.type !== 'string') fail(2, `问题 ${q.id} 缺少 expect.type`);
      if (q.prompt.length > 2000) fail(2, `问题 ${q.id} prompt 超过 2000 字符（探针端点上限）`);
      flat.push({ ...q, category: c.id, categoryName: c.name ?? c.id });
    }
  }
  if (flat.length < 10) fail(2, `问题集仅 ${flat.length} 题（要求 >= 10）`);
  const ids = new Set(flat.map((q) => q.id));
  if (ids.size !== flat.length) fail(2, '问题 id 存在重复');
  for (const q of flat) {
    const dep = q.expect?.requires;
    if (dep !== undefined && !ids.has(dep)) fail(2, `问题 ${q.id} requires 不存在的问题 ${dep}`);
  }
  return { doc, flat };
}

// ── HTTP ─────────────────────────────────────────────────────────────
async function api(opts, method, path, body) {
  let res;
  try {
    res = await fetch(`${opts.api}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeout),
    });
  } catch (e) {
    fail(2, `请求失败 ${method} ${path}: ${e.cause?.code ?? e.message}（服务在跑吗？）`);
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    fail(2, `${method} ${path} 返回非 JSON（HTTP ${res.status}）: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    fail(2, `${method} ${path} HTTP ${res.status}: ${json.error ?? text.slice(0, 200)}`);
  }
  return json;
}

// ── 判定器 ───────────────────────────────────────────────────────────
const TS_PATTERNS = [
  /\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}(:\d{2})?/,          // ISO / 2026-11-08 06:00:00
  /\d{4}年\d{1,2}月\d{1,2}日\s*\d{1,2}:\d{2}(:\d{2})?/,  // 中文日期
  /\b1[6-9]\d{8}\b/,                                       // epoch 秒（2020-2033）
  /\b1[6-9]\d{11}\b/,                                      // epoch 毫秒
  /\b\d{2}:\d{2}(:\d{2})\b/,                               // 纯时刻 06:00:33
];
const ERROR_MARKERS = [
  'traceback', 'unhandled', 'econnrefused', 'enoent', 'exit code', 'segmentation fault',
  'panic', 'internal error', 'exception:', '未捕获', '内部错误', '堆栈',
];
function extractNumbers(text) {
  const out = [];
  for (const m of text.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) out.push(Number(m[0].replace(/,/g, '')));
  return out.filter((n) => Number.isFinite(n));
}
// 返回 { pass, detail }。res: { code, finalText, reason, errorText }
function judge(expect, res) {
  const answer = res.finalText ?? '';
  if (res.code !== 'completed') {
    return { pass: false, detail: `code=${res.code}${res.errorText ? `: ${res.errorText}` : ''}` };
  }
  const lower = answer.toLowerCase();
  switch (expect.type) {
    case 'numeric': {
      const nums = extractNumbers(answer);
      const min = expect.minValue ?? 0;
      const hit = nums.find((n) => n >= min);
      return hit !== undefined
        ? { pass: true, detail: `数字 ${hit} >= ${min}` }
        : { pass: false, detail: `未找到 >= ${min} 的数字（提取到 [${nums.slice(0, 5).join(', ')}]）` };
    }
    case 'identity': {
      const miss = (expect.mustContain ?? []).filter((s) => !answer.includes(s));
      const leak = (expect.mustNotContain ?? []).filter((s) => lower.includes(String(s).toLowerCase()));
      if (miss.length) return { pass: false, detail: `缺少必须包含的: ${miss.join(', ')}` };
      if (leak.length) return { pass: false, detail: `出现禁用词: ${leak.join(', ')}` };
      return { pass: true, detail: '身份表述合规' };
    }
    case 'contains-timestamps': {
      const hit = TS_PATTERNS.some((re) => re.test(answer));
      return hit
        ? { pass: true, detail: '包含时间戳' }
        : { pass: false, detail: '未匹配到任何时间戳模式' };
    }
    case 'contains': {
      const miss = (expect.mustContain ?? []).filter((s) => !answer.includes(s));
      return miss.length
        ? { pass: false, detail: `缺少: ${miss.join(', ')}` }
        : { pass: true, detail: '包含全部关键词' };
    }
    case 'ack':
    case 'graceful':
      return { pass: true, detail: 'code=completed' };
    case 'boundary': {
      const bad = ERROR_MARKERS.filter((m) => lower.includes(m));
      return bad.length
        ? { pass: false, detail: `含错误标记: ${bad.join(', ')}` }
        : { pass: true, detail: '礼貌处理，无错误标记' };
    }
    case 'tool-list': {
      const hit = /\bsls\b|oneaix/i.test(answer);
      return hit
        ? { pass: true, detail: '提及 SLS 相关工具' }
        : { pass: false, detail: '未提及 sls/oneaix 相关工具名' };
    }
    default:
      return { pass: false, detail: `未知 expect.type: ${expect.type}` };
  }
}

// ── 主流程 ───────────────────────────────────────────────────────────
const opts = parseArgs(process.argv.slice(2));
const questionsPath = resolve(opts.questions ?? join(HERE, 'questions.json'));
const { flat } = loadQuestions(questionsPath);

// bot 元信息（provider/model 进报告；顺带校验 bot 存在）
const listRes = await api(opts, 'GET', '/api/bots');
const bot = (listRes.bots ?? []).find((b) => b.id === opts.bot);
if (bot == null) {
  fail(2, `bot '${opts.bot}' 不存在。可用: ${(listRes.bots ?? []).map((b) => b.id).join(', ') || '(无)'}`);
}
console.log(`评估 bot=${bot.id}（${bot.name ?? ''}）provider=${bot.provider} model=${bot.providerConfig?.model?.model ?? '?'}  共 ${flat.length} 题`);

const sessionIds = new Map(); // questionId -> sessionId（供 requires 链路复用）
const results = [];
let idx = 0;
for (const q of flat) {
  idx++;
  const dep = q.expect?.requires;
  const sessionId = dep ? sessionIds.get(dep) : undefined;
  const body = { prompt: q.prompt };
  if (sessionId) body.sessionId = sessionId;
  else if (dep) console.log(`  警告: ${q.id} 依赖 ${dep} 但其未返回 sessionId，将新开会话`);
  const t0 = Date.now();
  let res;
  try {
    res = await api(opts, 'POST', `/api/bots/${encodeURIComponent(opts.bot)}/test`, body);
  } catch (e) {
    fail(2, `题 ${q.id} 请求失败: ${e.message}`);
  }
  const duration = (Date.now() - t0) / 1000;
  if (res.sessionId) sessionIds.set(q.id, res.sessionId);
  const verdict = judge(q.expect, res);
  results.push({
    id: q.id,
    category: q.category,
    pass: verdict.pass,
    duration,
    code: res.code ?? null,
    answer: String(res.finalText ?? '').slice(0, 2000),
    detail: verdict.detail,
    sessionId: res.sessionId ?? null,
    tokens: null, // 探针端点不返回 token 用量（无 ledger 行），预留字段
  });
  const mark = verdict.pass ? 'PASS' : 'FAIL';
  const ans = results.at(-1).answer.replace(/\s+/g, ' ').slice(0, 80);
  console.log(`  [${idx}/${flat.length}] ${mark} ${q.id} (${duration.toFixed(1)}s) ${verdict.pass ? ans : `${verdict.detail} | 回复: ${ans}`}`);
}

// ── 汇总与落盘 ───────────────────────────────────────────────────────
const summary = {};
for (const c of new Set(results.map((r) => r.category))) {
  const rs = results.filter((r) => r.category === c);
  summary[c] = { pass: rs.filter((r) => r.pass).length, total: rs.length };
}
const totalPass = results.filter((r) => r.pass).length;
summary.overall = { pass: totalPass, total: results.length, score: Math.round((totalPass / results.length) * 100) };

const timestamp = new Date();
const stamp = timestamp.toISOString();
const report = {
  botId: bot.id,
  timestamp: stamp,
  provider: bot.provider ?? null,
  model: bot.providerConfig?.model?.model ?? null,
  api: opts.api,
  questionsVersion: 1,
  results,
  summary,
};

const botDir = join(RESULTS_DIR, bot.id);
mkdirSync(botDir, { recursive: true });
const file = join(botDir, `${stamp.replace(/[:.]/g, '-')}.json`);

// ── 对比模式 ─────────────────────────────────────────────────────────
let prevFile = null;
if (opts.compare) {
  const files = readdirSync(botDir).filter((f) => f.endsWith('.json')).sort();
  prevFile = files.length > 0 ? join(botDir, files[files.length - 1]) : null;
  // 注意：此刻当前报告尚未写入，最新即上次结果
  if (prevFile) {
    let prev;
    try { prev = JSON.parse(readFileSync(prevFile, 'utf8')); }
    catch { prev = null; }
    const prevMap = new Map((prev?.results ?? []).map((r) => [r.id, r.pass]));
    const regressions = [];
    const improvements = [];
    for (const r of results) {
      const p = prevMap.get(r.id);
      if (p === true && !r.pass) regressions.push(r.id);
      if (p === false && r.pass) improvements.push(r.id);
    }
    const prevScore = prev?.summary?.overall?.score;
    report.compare = {
      against: prev.timestamp,
      file: prevFile,
      regressions,
      improvements,
      scoreDelta: typeof prevScore === 'number' ? summary.overall.score - prevScore : null,
    };
    console.log(`\n对比上次（${prev.timestamp}，score ${prevScore ?? '?'} → ${summary.overall.score}）:`);
    console.log(regressions.length ? `  回归（新失败）: ${regressions.join(', ')}` : '  无新失败');
    console.log(improvements.length ? `  改善（新通过）: ${improvements.join(', ')}` : '  无新通过');
  } else {
    console.log('\n对比模式：无历史结果可对比（本次将作为基线）');
  }
}

writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);

console.log(`\n==== 摘要（${bot.id} @ ${stamp}）====`);
for (const [cat, s] of Object.entries(summary)) {
  if (cat === 'overall') continue;
  console.log(`  ${cat.padEnd(12)} ${s.pass}/${s.total}`);
}
console.log(`  总分         ${summary.overall.pass}/${summary.overall.total}  score=${summary.overall.score}`);
console.log(`报告已写入: ${file}`);

const hasFailure = summary.overall.score !== 100;
const hasRegression = Array.isArray(report.compare?.regressions) && report.compare.regressions.length > 0;
process.exit(hasFailure || hasRegression ? 1 : 0);
