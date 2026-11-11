// core-engine business API (DESIGN §8), mounted by plugin.js at prefix /api
// via ctx.http.register. Kernel-native routes (/api/state, /api/plugins,
// /api/service/reload, /api/events) are exact longer prefixes on the same
// shell — longest-prefix wins, so they never land here and everything else
// under /api does. Body parsing is ours (64KB cap; the shell parses nothing),
// and EVERY JSON response is scrubbed by sanitize before serialization:
// §8 — 响应永不回显 secret.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { saveBots, validateBot } from './bots.js';
import {
  bindingSummary, bindAsset, buildPlan, maskAsset, memoryUpgradeHint, newAssetId, pushAssetHistory,
  rematerializeBots, restoreMaskedContent, saveAssets, unbindAsset, validateAsset,
} from './assets.js';
import { curateBotOp, knowledgeBundleOp, rollbackAssetOp } from './knowledge.js';
import { DRAIN_REFUSAL_TEXT, createUsageAccumulator, fileSectionFor } from './engine.js';

const BODY_LIMIT_BYTES = 64 * 1024;
// 试跑面附件上传（DESIGN-MULTIMODAL 收尾 13）：上限必须让 UI 承诺的
// 「4 个 × 20MB」真的可上传——4×20MB 原始字节 base64 后 ≈106.7MB，留 JSON
// 开销余量到 112MB（复测 P2-1：原 28MB 只按 4 张图片算，选两个 15MB PDF 必
// 413 且报错不可读）。端点在 WAO_TOKEN + loopback 下属操作者工具面，112MB
// 内存峰值可接受；UI 侧另有同口径聚合预检（robots.js）先于上传拦截。
const TEST_BODY_LIMIT_BYTES = 112 * 1024 * 1024;
const TEST_PROMPT = '回复：收到';
const TEST_MAX_ATTACHMENTS = 4;
const TEST_MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const TEST_MAX_FILE_BYTES = 20 * 1024 * 1024;
// 60s: the codex probe measured ~25s on the real gateway (M2 T4) — at 30s
// that left only ~5s of margin, so a slow-gateway day tipped the probe into
// timeout. No test pins this value (M2 终审 follow-up).
const TEST_TIMEOUT_MS = 120_000;

const httpError = (status, message) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

// Recursively drop `secret` keys and any *apikey* key. Belt-and-braces: most
// handlers never copy account fields into responses, but one leak through a
// future route is exactly what this guard exists to catch.
export function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (key === 'secret' || /apikey/i.test(key)) continue;
      out[key] = sanitize(v);
    }
    return out;
  }
  return value;
}

// Echo-time masking for object-typed schema fields (known-boundaries wave
// 2026-11-06). `env` / `model` style free-text objects could not be scrubbed
// key-wise the way sanitize drops `secret`/*apikey* — their values are
// arbitrary user text, so a hand-filled secret LITERAL inside them echoed
// verbatim in GET /api/bots and the UI editor. The ECHO now masks instead:
// recursive walk, a key that LOOKS like a credential name masks its STRING
// value to '__MASKED__'. Display-only — the stored record is never touched;
// mergePreserving treats the sentinel as "unmodified", so saving the masked
// echo round-trip keeps the real value while an explicit new one replaces it.
const MASKED_ECHO = '__MASKED__';
const SENSITIVE_KEY = /secret|token|password|apikey|api_key/i;

const maskSensitiveStrings = (value) => {
  if (Array.isArray(value)) return value.map(maskSensitiveStrings);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = typeof v === 'string' && SENSITIVE_KEY.test(k) ? MASKED_ECHO : maskSensitiveStrings(v);
    }
    return out;
  }
  return value;
};

// Mask ONLY inside object-typed schema fields (the free-text surfaces): a key
// like `tokenCount` elsewhere must not be cosmetically blanked.
const maskObjectSchemaFields = (schema, block) => {
  if (!Array.isArray(schema) || !isObject(block)) return;
  for (const item of schema) {
    if (item?.type !== 'object' || typeof item.key !== 'string') continue;
    if (isObject(block[item.key])) block[item.key] = maskSensitiveStrings(block[item.key]);
  }
};

// Clone-and-mask a bot record for echo responses. The clone is mandatory:
// state.doc.bots holds the LIVE objects the attached runtime runs from.
const maskedBotEcho = (state, bot) => {
  const out = structuredClone(bot);
  maskObjectSchemaFields(state.ports?.getChannel?.(bot.channel)?.accountSchema, out.account);
  maskObjectSchemaFields(state.ports?.getProvider?.(bot.provider)?.configSchema, out.providerConfig);
  // §2.2: bindings echo as a SUMMARY (resolved name/type/mode, behind-version,
  // deleted-source) — exclusive snapshots carry full content (possibly mcp
  // secrets) and never leave the registry in a bot echo.
  if (Array.isArray(out.assets)) out.assets = bindingSummary(state.assetsDoc.assets, bot);
  return out;
};

const sendJson = (res, code, obj, extra = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json', ...extra });
  res.end(JSON.stringify(sanitize(obj)));
};

const readBody = (req, limit = BODY_LIMIT_BYTES) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  let over = false;
  req.on('data', (chunk) => {
    if (over) return; // already rejected: drain quietly, never buffer more
    size += chunk.length;
    if (size > limit) {
      over = true;
      chunks.length = 0;
      reject(httpError(413, `request body exceeds ${limit} bytes`));
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (over) return;
    const text = Buffer.concat(chunks).toString('utf8');
    if (text.trim() === '') { resolve({}); return; }
    try { resolve(JSON.parse(text)); }
    catch { reject(httpError(400, 'request body must be valid JSON')); }
  });
  req.on('error', (err) => { if (!over) reject(err); });
});

const idOf = (m) => {
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
};
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const findBot = (state, id) => state.doc.bots.find((b) => isObject(b) && b.id === id) ?? null;
const findAsset = (state, id) => state.assetsDoc.assets.find((a) => isObject(a) && a.id === id) ?? null;

// Bindings pointing at one asset (any bot) — the DELETE/PATCH fan-out set.
const botsBoundTo = (state, assetId, mode) => state.doc.bots.filter((b) => isObject(b)
  && Array.isArray(b.assets) && b.assets.some((x) => isObject(x) && x.assetId === assetId
  && (mode === undefined || x.mode === mode)));

// Public asset row: position-masked echo (mcp env/headers → __MASKED__) plus
// the live binding count (§8.1 清单：绑定数). history rides as METADATA only
// (version/at/via) — the archived content inside includes pre-masking mcp
// secrets and never leaves the registry; rollback reads it server-side.
const publicAsset = (state, asset) => ({
  ...maskAsset(asset),
  ...(Array.isArray(asset.history) && asset.history.length > 0
    ? { history: asset.history.map((h) => ({ version: h.version, at: h.at, via: h.via })) }
    : {}),
  bindings: botsBoundTo(state, asset.id).length,
});

// Write-only PATCH semantics (M3 UI red line: secrets never echo). The editor
// loads a sanitized record, so what a PATCHed block CANNOT see must read as
// "keep the stored value" — otherwise saving unrelated fields silently wipes
// credentials. Two schema-driven rules, same accepted trade-off (replaced yes,
// silently erased no; POST keeps the raw semantics, so creating a bot still
// demands the real secret):
//   password: blank OR absent → keep the stored value (the UI omits untouched
//             fields; a curl sending '' gets the same rule).
//   object:   sanitize strips *secret*/*apikey* keys at ANY depth (collateral:
//             an env NAME like model.apiKeyEnv is stripped too), so the JSON
//             round-trip cannot carry them — preserve-style deep merge:
//             request-absent keys backfill from the stored value, provided
//             keys override; explicit null still clears the whole field.
//             Masked echoes extend the same rule (known-boundaries wave): a
//             sensitive key sent back as MASKED_ECHO was never edited — it
//             backfills too, so saving the masked display cannot overwrite
//             the real secret with the literal sentinel.
const preserveWriteOnly = (schema, patchBlock, oldBlock) => {
  if (!Array.isArray(schema) || !isObject(patchBlock) || !isObject(oldBlock)) return;
  for (const item of schema) {
    if (item == null || typeof item.key !== 'string') continue;
    if (item.type === 'password') {
      if ((patchBlock[item.key] === undefined || patchBlock[item.key] === '')
        && oldBlock[item.key] !== undefined) {
        patchBlock[item.key] = oldBlock[item.key];
      }
    } else if (item.type === 'object') {
      const patch = patchBlock[item.key];
      const old = oldBlock[item.key];
      if (isObject(patch) && isObject(old)) patchBlock[item.key] = mergePreserving(patch, old);
    }
  }
};

const mergePreserving = (patchVal, oldVal) => {
  const out = { ...patchVal };
  for (const [k, v] of Object.entries(oldVal)) {
    if (!(k in out)) out[k] = v; // stripped key the editor never saw: backfill
    else if (out[k] === MASKED_ECHO && SENSITIVE_KEY.test(k)) out[k] = v; // masked echo sent back untouched: keep the stored value
    else if (isObject(out[k]) && isObject(v)) out[k] = mergePreserving(out[k], v);
  }
  return out;
};

// R4 维护者体验: cwd 存在性前置校验。All four providers spawn their CLI with
// `cwd: providerConfig.cwd` — a missing directory makes spawn throw ENOENT,
// which the probe surfaces as a CLI-looking failure (归因误导). Reject up front
// with a message that names the actual problem. Presence/type stay the
// schema's job; only a non-empty string cwd is existence-checked here.
// cwd 探测（R4）：spawn 前检查——缺失目录的 ENOENT 读起来像缺 CLI；这里指名
// 目录（knowledge.js 的整理轮同用）。
export const cwdExistsError = (bot) => {
  const cwd = bot?.providerConfig?.cwd;
  if (typeof cwd !== 'string' || cwd === '') return null;
  return existsSync(cwd) ? null : `工作目录不存在：${cwd}，请先创建或修正路径`;
};

const validateOrThrow = (bot, ports) => {
  const errors = validateBot(bot, { channels: ports?.channel, providers: ports?.provider });
  if (errors.length > 0) {
    // `errors` is the authoritative field-level list; `error` is exactly its
    // joined copy — one source of copy, no secondhand prefixing on top.
    const err = httpError(400, errors.join('; '));
    err.errors = errors;
    throw err;
  }
};

// materialize through the provider port if it implements the hook; a throw
// becomes a 400 with the provider's own message. The §3.1-rev2 extension:
// providers with asset faces receive the effective plan (`assets`) — dsh's
// personaPrefix combiner rebuilds the FULL prefix on providerConfig changes
// (契约用例「dsh 改模型→资产节仍在」), so a config change never drops assets.
async function materialize(state, bot) {
  const port = state.ports?.getProvider?.(bot.provider);
  if (port != null && typeof port.materializeConfig === 'function') {
    const { plan } = buildPlan(state.assetsDoc.assets, bot);
    try {
      await port.materializeConfig(bot, { log: state.log, assets: plan });
    } catch (err) {
      throw httpError(400, `materializeConfig failed: ${err?.message ?? err}`);
    }
  }
}

// DESIGN §8 校验→materialize→串行链 drain→重连: the bot's in-flight turn gets
// its final frame and its ledger row lands BEFORE the adapter is torn down —
// a swap that kills the chain mid-run would strand an unbooked turn.
// The refusal-answer half of the per-bot drain: drainBot RECORDS this bot's
// swept-pending and mid-swap refusals, but nothing on the engine's global
// path ever sends them (a later global drain window even resets the list), so
// answer them here — chains settled, old adapter still alive — per
// DESIGN §2.5 「已入队任务：直接回拒绝终帧」. Entries of OTHER bots are left
// in place for their own owners.
const drainBotOf = async (state, botId) => {
  try {
    await state.engine.drainBot(botId);
  } catch (err) {
    state.log?.warn?.(`core-engine: drainBot(${botId}) before swap failed: ${err?.message ?? err}`);
  }
  const engine = state.engine;
  if (!Array.isArray(engine?.drainRefusals)) return;
  const mine = [];
  const keep = [];
  for (const r of engine.drainRefusals) {
    if (r?.bot?.id === botId) mine.push(r); else keep.push(r);
  }
  if (mine.length === 0) return;
  engine.drainRefusals = keep; // hand off synchronously: later refusals append to the fresh list
  const adapter = state.adapterFor(botId);
  for (const { msg } of mine) {
    try {
      if (adapter?.reply) await adapter.reply(msg.reqId, DRAIN_REFUSAL_TEXT);
      else state.log?.warn?.(`core-engine: no adapter to answer the drain refusal for ${msg.chatKey}`);
    } catch (err) {
      state.log?.error?.(`core-engine: drain refusal reply failed: ${err?.message ?? err}`);
    }
  }
};

// —— route handlers ({ req, res, m, searchParams, state }) ——————————————————

// —— 公司操作层（W1 T2 refactor）—————————————————————————————————————
// Every HTTP handler's business core lives in a *Op function taking plain
// inputs and returning the exact response body (throwing httpError shapes
// for failures). The HTTP handlers below are thin: parse req → call op →
// sendJson. companyOps(state) publishes the SAME operations (plus sanitize
// and the read-only botDetail aggregate) for the mcp-gateway plugin through
// the services container — one source of company logic, two faces (REST and
// MCP tools), zero HTTP self-calls. HTTP behavior is byte-identical: same
// bodies, same error statuses/messages, same ordering.

// Agents-face asset warnings (W3 T1 review, §7.3): a memory-bound bot without
// a dedicated config dir keeps its notes in the shared cwd's project domain —
// visible to every other session opened in that directory (the bind receipt
// carries the long-form advisory; this is the roster's standing flag). The
// DECISION rides state.materializer.memoryWarning — the same hook bindAsset
// consults, so T2's real materializer moves both faces together. Bindings
// count only as the EFFECTIVE plan: a shadowed shared entry or a dangling
// binding never materializes, so it must not warn either.
const MEMORY_SHARED_CWD_WARNING = 'memory 共享 cwd：跨会话记忆可能被同目录其他会话互见';

const assetWarningsOf = (state, bot) => {
  const { plan } = buildPlan(state.assetsDoc.assets, bot);
  const out = [];
  const warn = state.materializer?.memoryWarning;
  if (typeof warn === 'function' && plan.some((e) => e.type === 'memory') && warn(bot)) {
    out.push(MEMORY_SHARED_CWD_WARNING);
  }
  // §7.1/§7.2 (W3 T3): tool-asset equipment warnings — rtk bound but the
  // binary is missing (unavailable), ripgrep bound but rg is missing. The
  // binding itself stands; this is the equipment-face annotation.
  const toolWarn = state.materializer?.toolWarnings;
  if (typeof toolWarn === 'function') out.push(...toolWarn(bot, plan));
  return out;
};

// 连接态口径 (§8, R4 统一数据源): engine runtime state corrected by the
// channel adapter's connection state — a terminal 'stopped' adapter (subscribe
// 鉴权失败, kicked) means the bot cannot receive, so an attached-and-idle bot
// still reports offline. Single extraction point shared by the roster row
// (GET /api/agents / companyOps / get_bot) and the /healthz bots summary
// (rosterSummary below) so the two faces can never drift.
function botStatusOf(state, botId) {
  const st = state.engine.status(botId);
  const adapter = state.adapterFor(botId);
  let chan = null;
  try { chan = typeof adapter?.status === 'function' ? adapter.status() : null; } catch { chan = null; }
  const chanStopped = chan?.state === 'stopped';
  return {
    status: st.status === 'offline' || chanStopped ? 'offline' : st.status,
    running: st.running,
    progress: st.progress,
    chan,
    chanStopped,
  };
}

// /healthz bots 汇总 (P2 observability, R4): roster truth over engine runtime
// state — total counts every REGISTERED bot record; the engine itself only
// knows attached bots, so unattached (disabled/failed-attach/channel-dead)
// bots close the gap as offline. online=待命(idle), working=工作中, three
// disjoint buckets summing to total. SAME status computation as the roster
// row (botStatusOf), so healthz can never call a channel-dead bot online
// while /api/agents calls it offline.
export function rosterSummary(state) {
  const rows = state.doc.bots.filter(isObject);
  let online = 0;
  let working = 0;
  for (const bot of rows) {
    const { status } = botStatusOf(state, bot.id);
    if (status === 'working') working++;
    else if (status === 'idle') online++;
  }
  return { total: rows.length, online, working, offline: rows.length - online - working };
}

// One roster row — shared by GET /api/agents, companyOps.agents and the
// get_bot tool aggregate (single extraction point so the three cannot
// drift).
function botRow(state, bot) {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const view = botStatusOf(state, bot.id);
  const rows = state.ledgerFor(bot.id).ledger.turns();
  const todayTurns = rows.filter((r) => (r.at ?? 0) >= midnight.getTime()).length;
  const users = new Set(rows.map((r) => r.userid).filter(Boolean)).size;
  const chats = new Set(rows.map((r) => r.chatKey).filter(Boolean)).size;
  // P2 观测字段: lastRunAt/totalTokens read the ledger (durable truth — the
  // last row's at and the sum of every row's tokens); lastDurationMs is
  // ENGINE MEMORY (the settled run's wall time, no ledger schema change) and
  // is honestly null before the bot's first run in this process.
  const lastRow = rows.length > 0 ? rows[rows.length - 1] : null;
  const totalTokens = rows.reduce((n, r) => n + (Number.isFinite(r.tokens) ? r.tokens : 0), 0);
  const lastRun = state.engine?.lastRunOf?.(bot.id) ?? null;
  const chan = view.chan;
  // Blind-review P2-4: enabled bots get an offline reason when a port
  // vanishes, but a DISABLED bot was never attached — no reason, no signal.
  // Flag the missing provider/channel port so the list card can hint it
  // beyond the gray 已停用 state (the plugin was likely disabled).
  const providerMissing = state.ports?.getProvider?.(bot.provider) == null
    || state.ports?.getChannel?.(bot.channel) == null;
  // §8.1 P1-14: materialization health echo — the last-good manifest's
  // lastMaterializedAt/lastResult (§3.8 is the design's own data source),
  // null when the bot never materialized. Same seam as the other asset
  // faces (state.materializer), so the noop answers null and the roster
  // shape never drifts between the two.
  const manifest = typeof state.materializer?.getManifest === 'function'
    ? state.materializer.getManifest(bot.id)
    : null;
  // §7.1/§7.2 manifest.tools — the per-tool equipment states (armed/
  // available / unavailable), summarized for the 装备台 badge. Only the
  // display-relevant fields cross the wire (no disk targets); a bot without
  // tool bindings (or a never-materialized one) echoes [].
  const assetTools = (Array.isArray(manifest?.tools) ? manifest.tools : [])
    .filter((t) => isObject(t))
    .map((t) => ({
      assetId: t.assetId ?? null,
      kind: t.kind ?? null,
      state: t.state ?? null,
      ...(t.version != null ? { version: t.version } : {}),
    }));
  return {
    id: bot.id, name: bot.name, enabled: bot.enabled !== false,
    provider: bot.provider, channel: bot.channel,
    status: view.status,
    running: view.running, progress: view.progress,
    todayTurns, users, chats, turns: rows.length,
    lastRunAt: lastRow?.at ?? null,
    lastDurationMs: lastRun?.durationMs ?? null,
    totalTokens,
    reason: state.offlineReason(bot.id) ?? (view.chanStopped ? (chan.lastError ?? 'channel stopped') : null),
    channelState: chan == null ? null : { state: chan.state ?? null, lastError: chan.lastError ?? null },
    providerMissing,
    assetWarnings: assetWarningsOf(state, bot),
    lastMaterializedAt: manifest?.lastMaterializedAt ?? null,
    lastResult: manifest?.lastResult ?? null,
    assetTools,
  };
}

function agentsOp(state) {
  return { agents: state.doc.bots.filter(isObject).map((bot) => botRow(state, bot)) };
}

// Read-only single-bot aggregate for the MCP get_bot tool (no HTTP
// route): the roster row PLUS the masked full record and the createdAt stamp.
// maskedBotEcho keeps object-typed credential-shaped values as '__MASKED__'
// and sendJson-side sanitize semantics are applied by callers that serialize.
function botDetailOp(state, id) {
  const bot = findBot(state, id);
  if (bot == null) throw httpError(404, 'bot not found');
  return { bot: maskedBotEcho(state, bot), ...botRow(state, bot), createdAt: bot.createdAt ?? null };
}

async function agentsHandler({ res, state }) {
  sendJson(res, 200, agentsOp(state));
}

async function createBotOp(state, bot) {
  if (!isObject(bot)) throw httpError(400, 'bot record must be a JSON object');
  // Bindings have a dedicated surface with the §2.3 validation chain — a bot
  // record carrying assets would bypass it (duplicate binds, conflict matrix).
  if (bot.assets !== undefined) throw httpError(400, 'assets 绑定不接受直写：请用 POST /api/bots/:id/assets 绑定（专用校验面）');
  if (typeof bot.id === 'string' && state.doc.bots.some((b) => isObject(b) && b.id === bot.id)) {
    throw httpError(400, `bot id already exists: ${bot.id}`);
  }
  validateOrThrow(bot, state.ports);
  // R4: a submitted cwd must exist on disk (the wizard's 提交时后端校验) — see
  // cwdExistsError for why this 400 beats a spawn-time ENOENT.
  const cwdErr = cwdExistsError(bot);
  if (cwdErr != null) throw httpError(400, cwdErr);
  // 创建日期: stamped at creation, echoed by GET /api/bots for
  // the ID card. Refuse a caller-supplied value — createdAt is registry truth,
  // not editable record data.
  if (bot.createdAt !== undefined) throw httpError(400, 'createdAt is set by the server, not accepted');
  bot.createdAt = Date.now();
  // P1-B（11-09 owner 裁定）：新建 claude bot 默认配专属 claudeConfigDir
  // （data/claude-config/<botId>）——rtk 绑定硬红线 + 记忆/会话树隔离 + 会话
  // 历史不落用户 ~/.claude，开箱即得。显式设置的不改写但同样预建（幂等：
  // 补 settings/.claude.json + mkdir，绝不覆盖既有文件）；预建失败只告警不
  // 阻断创建（缺目录首个轮次前可补）。
  if (bot.provider === 'claude' && isObject(bot.providerConfig)) {
    if (typeof bot.providerConfig.claudeConfigDir !== 'string' || bot.providerConfig.claudeConfigDir === '') {
      bot.providerConfig.claudeConfigDir = join(dirname(state.botsFile), 'claude-config', String(bot.id));
    }
    const port = state.ports?.getProvider?.('claude');
    if (typeof port?.prepareConfigDir === 'function') {
      try {
        const prep = port.prepareConfigDir(bot);
        if (prep?.prepared) state.log?.info?.(`claude config dir 预建（${bot.id}）：${(prep.notes ?? []).join('；')}`);
      } catch (err) {
        state.log?.warn?.(`claude config dir 预建失败（${bot.id}，不阻断创建）：${err?.message ?? err}`);
      }
    }
  }
  await materialize(state, bot);
  state.doc.bots.push(bot);
  saveBots(state.botsFile, state.doc);
  if (bot.enabled !== false) state.attach(bot);
  return { bot: maskedBotEcho(state, bot) };
}

async function createBotHandler({ req, res, state }) {
  sendJson(res, 200, await createBotOp(state, await readBody(req)));
}

async function patchBotOp(state, id, patchBody) {
  const bot = findBot(state, id);
  if (bot == null) throw httpError(404, 'bot not found');
  if (!isObject(patchBody)) throw httpError(400, 'patch body must be a JSON object');
  // createdAt is registry truth (mirrors createBotHandler's refusal): a patch
  // body carrying it is rejected, never silently merged into the ID card.
  if (patchBody.createdAt !== undefined) throw httpError(400, 'createdAt is set by the server, not accepted');
  // Same dedicated-surface rule as createBotOp: binding mutations must run
  // the §2.3 chain, never a blind merge.
  if (patchBody.assets !== undefined) throw httpError(400, 'assets 绑定不接受直写：请用 POST/DELETE /api/bots/:id/assets 绑定与解绑（专用校验面）');
  // Resolve write-only fields BEFORE the merge (the rules read the OLD
  // record's stored values); the schemas are the merged channel/provider's —
  // a patch may retarget either port id in the same request.
  preserveWriteOnly(state.ports?.getChannel?.(patchBody.channel ?? bot.channel)?.accountSchema,
    patchBody.account, bot.account);
  preserveWriteOnly(state.ports?.getProvider?.(patchBody.provider ?? bot.provider)?.configSchema,
    patchBody.providerConfig, bot.providerConfig);
  const merged = { ...bot, ...patchBody, id: bot.id }; // id is immutable
  validateOrThrow(merged, state.ports);
  // R4: only a PATCH that submits providerConfig re-litigates the cwd — an
  // unrelated rename of a legacy bot never fails over a dir that vanished
  // after creation (that surfaces via the probe/test path instead).
  if (patchBody.providerConfig !== undefined) {
    const cwdErr = cwdExistsError(merged);
    if (cwdErr != null) throw httpError(400, cwdErr);
  }
  if (patchBody.provider !== undefined || patchBody.providerConfig !== undefined) {
    try {
      await materialize(state, merged);
    } catch (err) {
      // Last-good semantics: nothing is persisted, the previous config stays
      // on disk, and the bot goes offline carrying the materialize reason.
      await drainBotOf(state, bot.id); // in-flight turns settle before their runtime dies
      state.detach(bot.id, err.message);
      throw err;
    }
  }
  Object.assign(bot, patchBody, { id: bot.id });
  saveBots(state.botsFile, state.doc);
  // Asset products ride the provider dirs (cwd/claudeConfigDir/codexHome/
  // piAgentDir) — a providerConfig move re-materializes them to the new
  // roots (§3.2 asset path: per-bot isolation; a failure logs and stays
  // retryable via rematerialize, it never rolls the bot PATCH back).
  if ((patchBody.provider !== undefined || patchBody.providerConfig !== undefined)
    && Array.isArray(bot.assets) && bot.assets.length > 0) {
    const receipt = await rematerializeBots(state, [bot]);
    for (const f of receipt.failed) {
      state.log?.warn?.(`core-engine: asset rematerialize after PATCH failed for ${f.botId}: ${f.error}（POST /api/bots/${f.botId}/rematerialize-assets 重试）`);
    }
  }
  if (bot.enabled !== false) { // any accepted change reconnects the runtime
    await drainBotOf(state, bot.id); // §8: the bot's serial chain settles (final frames out) before the adapter swap
    state.detach(bot.id, 're-attach after update');
    state.attach(bot);
  }
  return { bot: maskedBotEcho(state, bot) };
}

async function patchBotHandler({ req, res, m, state }) {
  const id = idOf(m);
  if (findBot(state, id) == null) throw httpError(404, 'bot not found'); // 404 wins over body-parse errors, as before
  sendJson(res, 200, await patchBotOp(state, id, await readBody(req)));
}

async function deleteBotOp(state, id) {
  const bot = findBot(state, id);
  if (bot == null) throw httpError(404, 'bot not found');
  await drainBotOf(state, bot.id); // §8: settle the bot's chain before the record (and adapter) go
  state.detach(bot.id, 'deleted');
  // materializeConfig's counterpart: if the provider port implements
  // removeConfig, the bot's materialized files (dsh profile) go with the
  // record. Best-effort — a cleanup failure must not resurrect the deleted
  // bot; it lands in the log for the operator.
  const port = state.ports?.getProvider?.(bot.provider);
  if (port != null && typeof port.removeConfig === 'function') {
    try {
      await port.removeConfig(bot, { log: state.log });
    } catch (err) {
      state.log?.warn?.(`core-engine: removeConfig failed for ${bot.id}: ${err?.message ?? err}`);
    }
  }
  // §3.2 bot DELETE row: the asset pipeline's cleanup hook (T2 implements the
  // real one; the noop materializer answers skipped). Same best-effort
  // contract as removeConfig — a cleanup failure never resurrects the bot.
  if (state.materializer != null && typeof state.materializer.removeAssets === 'function') {
    try {
      await state.materializer.removeAssets(bot, { log: state.log });
    } catch (err) {
      state.log?.warn?.(`core-engine: removeAssets failed for ${bot.id}: ${err?.message ?? err}`);
    }
  }
  state.doc.bots.splice(state.doc.bots.indexOf(bot), 1);
  saveBots(state.botsFile, state.doc);
  return { ok: true };
}

async function deleteBotHandler({ res, m, state }) {
  sendJson(res, 200, await deleteBotOp(state, idOf(m)));
}

async function toggleBotOp(state, id) {
  const bot = findBot(state, id);
  if (bot == null) throw httpError(404, 'bot not found');
  bot.enabled = bot.enabled === false; // absent = true (DESIGN §3 record shape)
  saveBots(state.botsFile, state.doc);
  if (bot.enabled) state.attach(bot);
  else {
    await drainBotOf(state, bot.id); // a disabled runtime waits out its chain first
    state.detach(bot.id, 'bot disabled');
  }
  return { bot: maskedBotEcho(state, bot) };
}

async function toggleBotHandler({ res, m, state }) {
  sendJson(res, 200, await toggleBotOp(state, idOf(m)));
}

// Registry view for the UI's schema-driven forms (M3 T2): which channels and
// providers are live, each with the schema that validates its config block.
// `owner` (the REGISTERING plugin's id, M3 T3) lets the plugin-manager page
// compute which bots a provider/channel plugin disable would take offline —
// port ids need not match their owning plugin's id (fake-shot registers
// channel 'fakec'). Ports registry entries are {impl, owner} wrappers; a
// bare-lifecycle test without ports yields empty lists, not a 500.
function portsOp(state) {
  const channels = [...(state.ports?.channel?.entries() ?? [])].map(([id, { impl, owner } = {}]) => ({
    id,
    owner: owner ?? null,
    accountSchema: Array.isArray(impl?.accountSchema) ? impl.accountSchema : [],
  }));
  const providers = [...(state.ports?.provider?.entries() ?? [])].map(([id, { impl, owner } = {}]) => ({
    id,
    owner: owner ?? null,
    configSchema: Array.isArray(impl?.configSchema) ? impl.configSchema : [],
    // W3: does this provider speak the asset pipeline (materializeAssets)?
    // Same decision source as the materializer's bind-time support check —
    // the wizard's 配发装备 step disables checkboxes for providers without
    // it (「该岗位暂不支持装备」).
    assets: typeof impl?.materializeAssets === 'function',
  }));
  return { channels, providers };
}

async function portsHandler({ res, state }) {
  sendJson(res, 200, portsOp(state));
}

// Full bot records for the CRUD editor (M3 T2). sendJson's sanitize strips
// secret/*apikey* keys, so what the editor receives is write-only — editing
// an unrelated field resubmits the account without the secret, which the
// PATCH keep-blank-password rule turns back into the stored value. Inside
// object-typed fields the echo additionally MASKS sensitive-looking string
// values (maskedBotEcho): a hand-filled secret literal in env/model never
// displays, and the '__MASKED__' round-trip PATCHes back as "unchanged".
function listBotsOp(state) {
  return { bots: state.doc.bots.filter(isObject).map((b) => maskedBotEcho(state, b)) };
}

async function listBotsHandler({ res, state }) {
  sendJson(res, 200, listBotsOp(state));
}

// magic bytes 判定（DESIGN-MULTIMODAL 收尾 13）——与 channel-wecom
// media.js sniffType 同构（复制即契约：core-engine 不跨插件 import，两边
// 改动需同步测试）。上传的文件名/声明的类型一律不作依据（红线）。
function sniffUploadExt(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return { ext: 'png', mediaType: 'image/png' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mediaType: 'image/jpeg' };
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return { ext: 'gif', mediaType: 'image/gif' };
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { ext: 'webp', mediaType: 'image/webp' };
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return { ext: 'pdf', mediaType: 'application/pdf' };
  if (buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) return { ext: 'zip', mediaType: 'application/zip' };
  return null;
}

// base64 上传 → 落盘工作副本（dataDir/media/testbot/<sha256>.<ext>，试跑面
// 工作目录，量小可随手清，不入 bot 配额）→ 附件信封条目。
function materializeTestAttachment(state, entry, index) {
  const bad = (msg) => httpError(400, `attachments[${index}]: ${msg}`);
  if (entry == null || typeof entry !== 'object') throw bad('must be an object');
  if (entry.kind !== 'image' && entry.kind !== 'file') throw bad("kind must be 'image' or 'file'");
  if (typeof entry.data !== 'string' || entry.data === '') throw bad('data (base64) is required');
  const bytes = Buffer.from(entry.data, 'base64');
  if (bytes.length === 0) throw bad('data is not valid base64');
  const max = entry.kind === 'image' ? TEST_MAX_IMAGE_BYTES : TEST_MAX_FILE_BYTES;
  if (bytes.length > max) throw bad(`${entry.kind} exceeds ${Math.round(max / 1024 / 1024)}MB`);
  const sniffed = sniffUploadExt(bytes);
  if (entry.kind === 'image' && sniffed == null) throw bad('not a recognized image (png/jpg/gif/webp)');
  const ext = sniffed?.ext ?? 'bin';
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const dir = join(dirname(state.botsFile), 'media', 'testbot');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sha256}.${ext}`);
  if (!existsSync(path)) writeFileSync(path, bytes);
  return {
    kind: entry.kind, path, sha256, size: bytes.length,
    mediaType: sniffed?.mediaType ?? 'application/octet-stream',
    name: String(entry.name ?? '').replace(/[\r\n\t\0]/g, ' ').replace(/[/\\]/g, '_').trim().slice(0, 120),
  };
}

// Probe run: the provider runner DIRECTLY — no channel, no engine chain, no
// ledger row. Answers "does this bot's provider still work?" in isolation.
// An optional JSON body { sessionId, prompt } shapes the probe: sessionId
// resumes THAT session instead of minting a fresh one (M2 Task 6: the probe
// doubles as the real-CLI resume check — the response's sessionId tells the
// caller what the CLI echoed/kept), prompt asks a custom question instead of
// the fixed '回复：收到' (blind-review P2-1: operators get to interrogate the
// bot, not just watch a sessionId echo). A body is not required; absent/empty
// sessionId keeps the historical fresh-probe contract (accept-m1.sh relies on
// it) and absent/empty prompt keeps the default one.
async function testBotOp(state, id, reqBody) {
  const bot = findBot(state, id);
  if (bot == null) throw httpError(404, 'bot not found');
  const port = state.ports?.getProvider?.(bot.provider);
  if (port == null || typeof port.createRunner !== 'function') {
    throw httpError(400, `provider ${bot.provider} unavailable`);
  }
  if (!isObject(reqBody)) throw httpError(400, 'test body must be a JSON object');
  let sessionId = null;
  if (reqBody.sessionId !== undefined && reqBody.sessionId !== null) {
    if (typeof reqBody.sessionId !== 'string' || reqBody.sessionId === '') {
      throw httpError(400, 'sessionId must be a non-empty string when present');
    }
    sessionId = reqBody.sessionId;
  }
  // sessionId treats '' as junk (400); prompt treats '' as "not given" — an
  // empty question falls back to the default probe instead of failing, so a
  // bare {prompt: ''} from a shell one-liner still probes.
  let prompt = TEST_PROMPT;
  if (reqBody.prompt !== undefined && reqBody.prompt !== null && reqBody.prompt !== '') {
    if (typeof reqBody.prompt !== 'string' || reqBody.prompt.length > 2000) {
      throw httpError(400, 'prompt must be a string of 1..2000 characters when present');
    }
    prompt = reqBody.prompt;
  }
  // R4: spawn 前检查 — a missing cwd spawns ENOENT that reads like a missing
  // CLI; 400 with the directory named instead (same copy as the CRUD path).
  const cwdErr = cwdExistsError(bot);
  if (cwdErr != null) throw httpError(400, cwdErr);
  // 附件（DESIGN-MULTIMODAL 收尾 13）：透传 runner 直跑（不进引擎链，沿用
  // 现有口径）。浏览器拿不到本地路径，UI 以 base64 上传——这里按引擎同红线
  // 落盘工作副本：路径由 sha256 定、ext 由 magic bytes 定（上传的 mediaType/
  // 文件名不作依据，name 仅清洗后作展示）。
  let attachments = [];
  if (reqBody.attachments !== undefined && reqBody.attachments !== null) {
    if (!Array.isArray(reqBody.attachments) || reqBody.attachments.length === 0) {
      throw httpError(400, 'attachments must be a non-empty array when present');
    }
    if (reqBody.attachments.length > TEST_MAX_ATTACHMENTS) {
      throw httpError(400, `at most ${TEST_MAX_ATTACHMENTS} attachments per probe`);
    }
    attachments = reqBody.attachments.map((a, i) => materializeTestAttachment(state, a, i));
  }
  // 盲评 P1-3：file 附件不能只透传 runner——三家 runner 一致只认 image，
  // 文件会被静默丢弃而试跑「成功」，与 UI 按钮的「文件按文本内联/PDF/二进制
  // 分级」承诺相反（拒绝优于静默丢）。复用引擎同款 fileSectionFor 拼 prompt
  //（PDF 的 provider 分流逻辑天然生效），runner 只收 image 条目。
  const imageAttachments = attachments.filter((a) => a.kind === 'image');
  const fileSections = attachments.filter((a) => a.kind !== 'image')
    .map((a) => fileSectionFor(a, { provider: bot.provider, cwd: bot.providerConfig?.cwd }));
  const effectivePrompt = [prompt, ...fileSections]
    .filter((s) => typeof s === 'string' && s.trim() !== '')
    .join('\n\n---\n\n');
  // §3.1 asset faces (W3 T5): the probe must interrogate the bot AS EQUIPPED
  // — the same enrichment the engine's runner gets (bare plan + manifest file
  // targets), so 岗前测试 exercises prompt (--append-system-prompt) and mcp
  // (--mcp-config) assets too, not just the file faces (skills/hooks) that
  // ride the config dir. Degrades to the bare plan under the noop materializer.
  const barePlan = buildPlan(state.assetsDoc.assets, bot).plan;
  const assets = barePlan.length > 0 && typeof state.materializer?.targetsFor === 'function'
    ? state.materializer.targetsFor(bot, barePlan)
    : barePlan;
  const runner = port.createRunner({ bot, providerConfig: bot.providerConfig, assets, log: state.log });
  let events = 0;
  // usage 累计（P2-B）：与引擎轮同一方言归一器——岗前测试直接回 Token 读数，
  // token 优化的前后对比不再等生产流量。
  const usageAcc = createUsageAccumulator();
  // settle 看门狗（2026-11-10 PC1 真机 P1）：探针 claude 被 120s 超时 SIGKILL 后，
  // 若子进程 pipe 被孤儿孙进程（探针里 & 出的后台进程）持有，child 'close' 永不
  // 触发 → runner promise 挂死 → 路由永不应答（实测两次 HTTP 悬挂）。与引擎
  // abortGuard 同款：超时+30s 余量强制兜底结算，路由必答。
  const probeAc = new AbortController();
  const guardTimer = setTimeout(() => probeAc.abort(), TEST_TIMEOUT_MS);
  let guardBail = null; // 兜底定时器句柄：正常结算后必须清，否则每探针漏一个 30s 句柄
  const probeGuard = new Promise((resolve) => {
    guardBail = setTimeout(() => {
      state.log?.warn?.('core-engine: testBot probe settle-watchdog fired — force-settling');
      resolve({
        ok: false, code: 'timeout', finalText: '', aborted: true,
        sessionId: sessionId ?? null, reason: 'settle-watchdog', detail: { exitCode: null, stderrTail: '' },
      });
    }, TEST_TIMEOUT_MS + 30_000);
  });
  let result;
  try {
    result = await Promise.race([
      runner.run({
        prompt: effectivePrompt,
        sessionId,
        attachments: imageAttachments,
        signal: probeAc.signal,
        timeoutMs: TEST_TIMEOUT_MS,
        onEvent: (ev) => { events++; usageAcc.observe(ev); },
      }),
      probeGuard,
    ]);
  } finally {
    clearTimeout(guardTimer);
    clearTimeout(guardBail);
  }
  usageAcc.observeResult(result);
  // 中止/超时的探针不得把引擎中间文本当最终回复外发（盲评 P1：aborted 时
  // finalText 可能是半截推理语，直接返回会误导"这就是 bot 会给用户的话"）。
  // 非 completed 一律换成固定话术；原始文本降级进 detail.probeTail 供运维排查。
  const probeDone = result?.code === 'completed';
  const rawProbeTail = result?.finalText ?? '';
  const body = {
    code: result?.code ?? 'error',
    finalText: probeDone ? rawProbeTail : '本轮处理超时被中止，未能生成完整回复。可携带原问题重试，或用 sessionId 续跑。',
    sessionId: result?.sessionId ?? null,
    events,
    usage: usageAcc.summary(),
  };
  // A failed probe answers "why?" inline (P2 review): machine-readable
  // reason/detail (stderrTail truncated — a full dump belongs in the log, not
  // a JSON response) plus the provider's human sentence via describeError.
  if (body.code !== 'completed') {
    body.reason = result?.reason ?? null;
    const d = result?.detail;
    body.detail = d == null || typeof d !== 'object' ? null : {
      exitCode: d.exitCode ?? null,
      stderrTail: typeof d.stderrTail === 'string' ? d.stderrTail.slice(0, 500) : (d.stderrTail ?? null),
      probeTail: rawProbeTail ? rawProbeTail.slice(0, 500) : null,
    };
    try {
      body.errorText = typeof port.describeError === 'function'
        ? String(port.describeError(result))
        : String(result?.error ?? 'run failed');
    } catch { body.errorText = String(result?.error ?? 'run failed'); }
  }
  return body;
}

async function testBotHandler({ req, res, m, state }) {
  const id = idOf(m);
  const bot = findBot(state, id);
  if (bot == null) throw httpError(404, 'bot not found'); // 404 wins over body errors, as before
  const port = state.ports?.getProvider?.(bot.provider);
  if (port == null || typeof port.createRunner !== 'function') {
    // provider availability also outranks body-parse errors — the pre-refactor order
    throw httpError(400, `provider ${bot.provider} unavailable`);
  }
  sendJson(res, 200, await testBotOp(state, id, await readBody(req, TEST_BODY_LIMIT_BYTES)));
}

function ledgerOp(state, { bot, chat }) {
  if (bot == null || bot === '') throw httpError(400, 'bot is required');
  if (findBot(state, bot) == null) throw httpError(404, 'bot not found');
  return state.ledgerFor(bot).ledger.turns(chat ? { chatKey: chat } : {});
}

async function ledgerHandler({ res, searchParams, state }) {
  sendJson(res, 200, ledgerOp(state, { bot: searchParams.get('bot'), chat: searchParams.get('chat') }));
}

// Native session drill-down: readHistory lives on the RUNNER (provider port
// contract) — prefer the bot's live runner, else spin an ephemeral one.
async function sessionHandler({ res, searchParams, state }) {
  const botId = searchParams.get('bot');
  if (botId == null || botId === '') throw httpError(400, 'bot is required');
  const bot = findBot(state, botId);
  if (bot == null) throw httpError(404, 'bot not found');
  const session = searchParams.get('session');
  if (session == null || session === '') throw httpError(400, 'session is required');
  let runner = state.runnerFor(bot.id);
  if (runner == null) {
    const port = state.ports?.getProvider?.(bot.provider);
    if (port == null || typeof port.createRunner !== 'function') {
      throw httpError(400, `provider ${bot.provider} unavailable`);
    }
    runner = port.createRunner({ bot, providerConfig: bot.providerConfig, log: state.log });
  }
  if (runner == null || typeof runner.readHistory !== 'function') {
    throw httpError(400, `provider ${bot.provider} history unavailable`);
  }
  sendJson(res, 200, await runner.readHistory(bot.providerConfig, session));
}

async function exportHandler({ res, searchParams, state }) {
  const botId = searchParams.get('bot');
  if (botId == null || botId === '') throw httpError(400, 'bot is required');
  if (findBot(state, botId) == null) throw httpError(404, 'bot not found');
  const rows = state.ledgerFor(botId).ledger.turns();
  const fmt = (at) => new Date(at ?? 0).toLocaleString('sv-SE');
  const md = rows.map((r) =>
    `## ${fmt(r.at)}\n\n**用户**: ${r.user ?? ''}\n\n**助手**: ${r.assistant || '(未完成)'}`).join('\n\n');
  res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
  res.end(rows.length > 0 ? `${md}\n` : '');
}

function timelineOp(state, { bot, windowMs }) {
  const botId = bot || undefined;
  if (botId !== undefined && findBot(state, botId) == null) throw httpError(404, 'bot not found');
  return state.timeline.get({ botId, windowMs });
}

async function timelineHandler({ res, searchParams, state }) {
  const bot = searchParams.get('bot') || undefined;
  if (bot !== undefined && findBot(state, bot) == null) throw httpError(404, 'bot not found'); // 404 wins over window errors, as before (mirrors patchBotHandler)
  sendJson(res, 200, timelineOp(state, { bot, windowMs: windowOf(searchParams) }));
}

// window query param parsing (ms) — shared by the HTTP handler; the MCP tool
// passes an already-numeric windowMs.
const windowOf = (searchParams) => {
  const windowParam = searchParams.get('window');
  if (windowParam == null || windowParam === '') return undefined;
  const windowMs = Number(windowParam);
  if (!Number.isFinite(windowMs) || windowMs < 0) throw httpError(400, 'window must be a non-negative number (ms)');
  return windowMs;
};

// Server-initiated push (§8). The chatRef handed to the adapter IS the raw
// chatKey string — adapters parse their OWN addressing (channel port contract,
// §4; T17 implements the wecom 'wecom:group:X' → {chatid,chatType} parse).
// The engine/API never hardcode one channel's addressing scheme.
async function sendOp(state, { botId, chatKey, content }) {
  if (typeof botId !== 'string' || botId === '') throw httpError(400, 'botId is required');
  if (typeof chatKey !== 'string' || chatKey === '') throw httpError(400, 'chatKey is required');
  if (typeof content !== 'string' || content === '') throw httpError(400, 'content is required');
  if (findBot(state, botId) == null) throw httpError(404, 'bot not found');
  const adapter = state.adapterFor(botId);
  if (adapter == null || typeof adapter.push !== 'function') throw httpError(409, 'bot is offline');
  await adapter.push(chatKey, content);
  return { ok: true };
}

async function sendHandler({ req, res, state }) {
  const body = await readBody(req);
  const { botId, chatKey, content } = isObject(body) ? body : {};
  sendJson(res, 200, await sendOp(state, { botId, chatKey, content }));
}

// —— 资产面（W3 T1，DESIGN-ASSETS §2/§8）—————————————————————————————————
// One registry, two write faces: REST (origin:'operator') and the MCP
// companyOps tools (origin:'mcp', §8.1 分级 — create forced exclusive-only at
// BIND time, update/delete refused for operator assets). Both faces call the
// same *Op below; `origin`/`mcpFace` parameters are the only face-dependent
// behavior. Materialization rides the injectable state.materializer (T1:
// noop → {writes:[], skipped:'not-equipped'}; T2: the real provider pipeline).

function listAssetsOp(state) {
  const assets = state.assetsDoc.assets.filter(isObject);
  return {
    assets: assets.map((a) => publicAsset(state, a)),
    // 装备包推荐（B 产品化）：memory 条数逼近上限时提示升级 scope-recall——
    // 纯文案，UI 只展示（判定源同源单点 assets.js）。
    ...(memoryUpgradeHint(assets) != null ? { memoryUpgradeHint: memoryUpgradeHint(assets) } : {}),
  };
}

function getAssetOp(state, id) {
  const asset = findAsset(state, id);
  if (asset == null) throw httpError(404, 'asset not found');
  return { asset: publicAsset(state, asset) };
}

const SERVER_SET_FIELDS = ['id', 'origin', 'version', 'createdAt', 'updatedAt'];

export async function createAssetOp(state, body, { origin = 'operator' } = {}) {
  if (!isObject(body)) throw httpError(400, 'asset must be a JSON object');
  // Registry truth, not editable record data (createdAt precedent).
  for (const k of SERVER_SET_FIELDS) {
    if (body[k] !== undefined) throw httpError(400, `${k} is set by the server, not accepted`);
  }
  const now = Date.now();
  const asset = {
    id: newAssetId(state.assetsDoc.assets.map((a) => a?.id)),
    type: body.type,
    name: body.name,
    ...(body.description !== undefined ? { description: body.description } : {}),
    ...(body.defaultForNewBots !== undefined ? { defaultForNewBots: Boolean(body.defaultForNewBots) } : {}),
    content: body.content,
    origin,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  const errors = validateAsset(asset, { others: state.assetsDoc.assets });
  if (errors.length > 0) {
    const err = httpError(400, errors.join('; '));
    err.errors = errors;
    throw err;
  }
  state.assetsDoc.assets.push(asset);
  saveAssets(state.assetsFile, state.assetsDoc);
  return { asset: publicAsset(state, asset) };
}

// v2 终审 [Important]: the on-disk identity keys an asset materializes under
// — skill content.name (the SKILL.md directory) and mcp serverIds (the
// wao-<serverId> config keys, §3.3). A shared-bound PATCH renaming these fans
// out file-creates that silently overwrite same-root files materialized for
// OTHER bots (the §2.3 bind-time conflict matrix never re-runs on PATCH), so
// they are immutable while any shared binding exists. Exclusive-only assets
// stay patchable — snapshots never fan out (§6).
const structuralKeysOf = (type, content) => {
  if (type === 'skill') return typeof content?.name === 'string' ? [`skill:${content.name}`] : [];
  if (type === 'mcp' && isObject(content?.servers)) return Object.keys(content.servers).sort().map((s) => `mcp:${s}`);
  return [];
};

export async function updateAssetOp(state, id, patchBody, { mcpFace = false, via = 'operator' } = {}) {
  const asset = findAsset(state, id);
  if (asset == null) throw httpError(404, 'asset not found');
  if (!isObject(patchBody)) throw httpError(400, 'patch body must be a JSON object');
  // §8.1 MCP 写面分级: the Agent face is read-only towards 配发 assets —
  // shared-pool changes belong to the console/REST.
  if (mcpFace && asset.origin !== 'mcp') {
    throw httpError(403, '共享（shared）工具的改动请走控制台/REST（本写面仅允许改动 Agent 自建工具）');
  }
  for (const k of SERVER_SET_FIELDS) {
    if (patchBody[k] !== undefined) throw httpError(400, `${k} is set by the server, not accepted`);
  }
  // Type is the binding contract (provider×type support, materialization
  // targets) — retyping a bound asset is refused, not remapped.
  if (patchBody.type !== undefined && patchBody.type !== asset.type) {
    throw httpError(400, '工具类型不可变更（type immutable）');
  }
  if (patchBody.content !== undefined && !isObject(patchBody.content)) {
    throw httpError(400, 'content must be a JSON object');
  }
  const merged = {
    ...asset,
    ...(patchBody.name !== undefined ? { name: patchBody.name } : {}),
    ...(patchBody.description !== undefined ? { description: patchBody.description } : {}),
    ...(patchBody.defaultForNewBots !== undefined ? { defaultForNewBots: Boolean(patchBody.defaultForNewBots) } : {}),
    ...(patchBody.content !== undefined
      ? { content: restoreMaskedContent(patchBody.content, asset.content, asset.type) }
      : {}),
  };
  // Shared-bound structural keys are immutable (see structuralKeysOf): the
  // eager fan-out would write the renamed product without the bind-time
  // cross-bot conflict matrix ever seeing it. Unbind shared first.
  if (botsBoundTo(state, id, 'shared').length > 0
    && structuralKeysOf(asset.type, asset.content).join('\u0000') !== structuralKeysOf(merged.type, merged.content).join('\u0000')) {
    throw httpError(400, '该工具有共享绑定，改名需先解绑（避免跨机器人文件冲突）');
  }
  const errors = validateAsset(merged, { others: state.assetsDoc.assets.filter((a) => a !== asset) });
  if (errors.length > 0) {
    const err = httpError(400, errors.join('; '));
    err.errors = errors;
    throw err;
  }
  // 版本历史（DESIGN-KNOWLEDGE §4.3）：内容真变了才把「变更前」状态归档
  //（restoreMaskedContent 后与现值比较——同名同内容 PATCH 只 bump version
  // 不重复归档），供回滚与知识 tab 版本列表读取。
  if (patchBody.content !== undefined
    && JSON.stringify(merged.content) !== JSON.stringify(asset.content)) {
    pushAssetHistory(asset, via);
  }
  merged.version = asset.version + 1; // §2.1: every PATCH bumps — the exclusive snapshot anchor
  merged.updatedAt = Date.now();
  Object.assign(asset, merged);
  saveAssets(state.assetsFile, state.assetsDoc);
  // §3.2 eager fan-out: every shared-bound bot rematerializes now, per-bot
  // isolated; exclusive snapshots deliberately do not follow (§6).
  const receipt = await rematerializeBots(state, botsBoundTo(state, id, 'shared'));
  return { asset: publicAsset(state, asset), ...receipt };
}

async function deleteAssetOp(state, id, { mcpFace = false } = {}) {
  const asset = findAsset(state, id);
  if (asset == null) throw httpError(404, 'asset not found');
  if (mcpFace && asset.origin !== 'mcp') {
    throw httpError(403, '共享（shared）工具的删除请走控制台/REST（本写面仅允许删除 Agent 自建工具）');
  }
  // §3.2 DELETE row: shared bindings go (and their bots rematerialize the
  // cleanup); exclusive bindings KEEP their snapshots and keep working.
  let removedBindings = 0;
  let keptExclusive = 0;
  const touched = [];
  for (const bot of botsBoundTo(state, id)) {
    const kept = [];
    for (const b of bot.assets) {
      if (!isObject(b) || b.assetId !== id) { kept.push(b); continue; }
      if (b.mode === 'shared') { removedBindings++; touched.push(bot); } else { keptExclusive++; kept.push(b); }
    }
    bot.assets = kept;
  }
  saveBots(state.botsFile, state.doc);
  state.assetsDoc.assets.splice(state.assetsDoc.assets.indexOf(asset), 1);
  saveAssets(state.assetsFile, state.assetsDoc);
  const receipt = await rematerializeBots(state, touched);
  return {
    ok: true,
    id,
    removedBindings,
    keptExclusive,
    ...receipt,
    ...(keptExclusive > 0 ? { note: `源工具已删除，${keptExclusive} 个独立（exclusive）副本仍生效（快照保留在各自 bot 记录中）` } : {}),
  };
}

// POST /api/bots/:id/rematerialize-assets (§8.1): deterministic re-write for
// one bot — the safe auto-repair path for §3.2 fan-out failures and drift.
async function rematerializeOp(state, botId) {
  const bot = findBot(state, botId);
  if (bot == null) throw httpError(404, 'bot not found');
  const receipt = await rematerializeBots(state, [bot]);
  if (receipt.failed.length > 0) {
    throw httpError(400, `资产重物化失败（bot ${botId}）：${receipt.failed[0].error}`);
  }
  return { ok: true, botId, ...receipt };
}

async function listAssetsHandler({ res, state }) {
  sendJson(res, 200, listAssetsOp(state));
}

async function getAssetHandler({ res, m, state }) {
  sendJson(res, 200, getAssetOp(state, idOf(m)));
}

async function createAssetHandler({ req, res, state }) {
  sendJson(res, 200, await createAssetOp(state, await readBody(req)));
}

async function patchAssetHandler({ req, res, m, state }) {
  const id = idOf(m);
  if (findAsset(state, id) == null) throw httpError(404, 'asset not found'); // 404 wins over body errors, as before
  sendJson(res, 200, await updateAssetOp(state, id, await readBody(req)));
}

async function deleteAssetHandler({ res, m, state }) {
  sendJson(res, 200, await deleteAssetOp(state, idOf(m)));
}

async function bindAssetHandler({ req, res, m, state }) {
  const botId = idOf(m);
  if (findBot(state, botId) == null) throw httpError(404, 'bot not found'); // 404 wins over body errors, as before
  sendJson(res, 200, await bindAsset(state, botId, await readBody(req)));
}

async function unbindAssetHandler({ res, m, state }) {
  const botId = idOf(m);
  const assetId = (() => { try { return decodeURIComponent(m[2]); } catch { return m[2]; } })();
  if (findBot(state, botId) == null) throw httpError(404, 'bot not found');
  sendJson(res, 200, await unbindAsset(state, botId, assetId));
}

async function rematerializeHandler({ res, m, state }) {
  sendJson(res, 200, await rematerializeOp(state, idOf(m)));
}

// —— 知识资产面（DESIGN-KNOWLEDGE，2026-11-11）——————————————————————————
// 看得见：GET /bots/:id/knowledge 聚合「提示词送达面 + 生效记忆 + 技能 + 版本
// + 整理史」；理得动：POST /bots/:id/curate 整理轮（AI 自主，人只给引导文本）；
// 可回滚：POST /assets/:id/rollback。三个 Op 同时进 companyOps（REST/MCP 同源）。
async function knowledgeHandler({ res, m, state }) {
  sendJson(res, 200, knowledgeBundleOp(state, idOf(m)));
}

async function curateHandler({ req, res, m, state }) {
  const botId = idOf(m);
  if (findBot(state, botId) == null) throw httpError(404, 'bot not found'); // 404 wins over body errors, as before
  sendJson(res, 200, await curateBotOp(state, botId, await readBody(req)));
}

async function rollbackAssetHandler({ req, res, m, state }) {
  // 无 asset 前置 404（盲审 P2-4）：botId 定向的快照回滚在源资产已删除时依然
  // 合法（快照独立于 registry），Op 内部按作用域各自给出准确的 404/400。
  sendJson(res, 200, await rollbackAssetOp(state, idOf(m), await readBody(req)));
}

const ROUTES = [
  ['GET', /^\/agents$/, agentsHandler],
  ['GET', /^\/ports$/, portsHandler],
  ['GET', /^\/bots$/, listBotsHandler],
  ['POST', /^\/bots$/, createBotHandler],
  ['PATCH', /^\/bots\/([^/]+)$/, patchBotHandler],
  ['DELETE', /^\/bots\/([^/]+)$/, deleteBotHandler],
  ['POST', /^\/bots\/([^/]+)\/toggle$/, toggleBotHandler],
  ['POST', /^\/bots\/([^/]+)\/test$/, testBotHandler],
  ['POST', /^\/bots\/([^/]+)\/assets$/, bindAssetHandler],
  ['DELETE', /^\/bots\/([^/]+)\/assets\/([^/]+)$/, unbindAssetHandler],
  ['POST', /^\/bots\/([^/]+)\/rematerialize-assets$/, rematerializeHandler],
  ['GET', /^\/bots\/([^/]+)\/knowledge$/, knowledgeHandler],
  ['POST', /^\/bots\/([^/]+)\/curate$/, curateHandler],
  ['POST', /^\/assets\/([^/]+)\/rollback$/, rollbackAssetHandler],
  ['GET', /^\/assets$/, listAssetsHandler],
  ['GET', /^\/assets\/([^/]+)$/, getAssetHandler],
  ['POST', /^\/assets$/, createAssetHandler],
  ['PATCH', /^\/assets\/([^/]+)$/, patchAssetHandler],
  ['DELETE', /^\/assets\/([^/]+)$/, deleteAssetHandler],
  ['GET', /^\/ledger$/, ledgerHandler],
  ['GET', /^\/session$/, sessionHandler],
  ['GET', /^\/export$/, exportHandler],
  ['GET', /^\/timeline$/, timelineHandler],
  ['POST', /^\/send$/, sendHandler],
];

// companyOps(state) (W1 T2): the company operations the mcp-gateway plugin
// consumes through the services container — the SAME functions the HTTP
// routes above call, so REST and MCP tools can never drift. `sanitize` rides
// along so the MCP face applies the identical §8 secret scrub sendJson does.
// plugin.js registers the built object as the 'companyOps' service and nulls
// it at teardown (the container has no unregister — same pattern as 'engine').
export function companyOps(state) {
  return {
    sanitize,
    agents: () => agentsOp(state),
    botDetail: (id) => botDetailOp(state, id),
    bots: () => listBotsOp(state),
    ports: () => portsOp(state),
    createBot: (bot) => createBotOp(state, bot),
    patchBot: (id, patchBody) => patchBotOp(state, id, patchBody),
    deleteBot: (id) => deleteBotOp(state, id),
    toggleBot: (id) => toggleBotOp(state, id),
    testBot: (id, body) => testBotOp(state, id, body),
    ledger: ({ bot, chat }) => ledgerOp(state, { bot, chat }),
    timeline: ({ bot, windowMs }) => timelineOp(state, { bot, windowMs }),
    send: ({ botId, chatKey, content }) => sendOp(state, { botId, chatKey, content }),
    // 资产面 (W3 T1, §8.1): the MCP write face. createAsset is stamped
    // origin:'mcp' (Agent-created assets are exclusive-only at bind time);
    // updateAsset/deleteAsset carry the 配发-asset refusal for operator
    // assets; bind/unbind/rematerialize share the REST handlers' exact ops.
    createAsset: (asset) => createAssetOp(state, asset, { origin: 'mcp' }),
    updateAsset: (id, patch) => updateAssetOp(state, id, patch, { mcpFace: true }),
    deleteAsset: (id) => deleteAssetOp(state, id, { mcpFace: true }),
    bindAsset: (botId, body) => bindAsset(state, botId, body),
    unbindAsset: (botId, assetId) => unbindAsset(state, botId, assetId),
    rematerialize: (botId) => rematerializeOp(state, botId),
    // 知识资产面 (DESIGN-KNOWLEDGE)：只读聚合 + 整理轮 + 回滚；listAssets 补上
    // Agent 的盘点盲区（此前只见 create/update/delete/bind，看不到注册表全貌）。
    listAssets: () => listAssetsOp(state),
    getAsset: (id) => getAssetOp(state, id),
    knowledge: (botId) => knowledgeBundleOp(state, botId),
    curateBot: (botId, body) => curateBotOp(state, botId, body ?? {}),
    rollbackAsset: (assetId, body) => rollbackAssetOp(state, assetId, body ?? {}),
  };
}

// createApi({ getState }) → async http handler. getState is re-read on every
// request: after a reload the plugin instance (doc, engine, adapters) is new,
// and stale closure state here would answer from a dead world.
export function createApi({ getState }) {
  if (typeof getState !== 'function') throw new Error('createApi requires a getState function');
  return async function apiHandler(req, res) {
    let knownPath = false;
    const allow = [];
    try {
      const { pathname, searchParams } = new URL(req.url, 'http://localhost');
      const sub = pathname.startsWith('/api') ? pathname.slice('/api'.length) : pathname;
      for (const [method, pattern, handler] of ROUTES) {
        const m = pattern.exec(sub);
        if (m == null) continue;
        knownPath = true;
        allow.push(method);
        if (method !== req.method) continue;
        await handler({ req, res, m, searchParams, state: getState() });
        return;
      }
      if (knownPath) throw httpError(405, 'method not allowed');
      throw httpError(404, 'not found');
    } catch (err) {
      if (res.writableEnded) return;
      if (res.headersSent) { res.destroy(); return; }
      const status = Number.isInteger(err?.status) ? err.status : 500;
      const body = { error: err?.message ?? String(err) };
      if (Array.isArray(err?.errors)) body.errors = err.errors;
      sendJson(res, status, body, status === 405 ? { Allow: allow.join(', ') } : {});
    }
  };
}
