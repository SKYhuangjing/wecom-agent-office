// core-engine business API (DESIGN §8), mounted by plugin.js at prefix /api
// via ctx.http.register. Kernel-native routes (/api/state, /api/plugins,
// /api/service/reload, /api/events) are exact longer prefixes on the same
// shell — longest-prefix wins, so they never land here and everything else
// under /api does. Body parsing is ours (64KB cap; the shell parses nothing),
// and EVERY JSON response is scrubbed by sanitize before serialization:
// §8 — 响应永不回显 secret.
import { saveBots, validateBot } from './bots.js';
import { DRAIN_REFUSAL_TEXT } from './engine.js';

const BODY_LIMIT_BYTES = 64 * 1024;
const TEST_PROMPT = '回复：收到';
// 60s: the codex probe measured ~25s on the real gateway (M2 T4) — at 30s
// that left only ~5s of margin, so a slow-gateway day tipped the probe into
// timeout. No test pins this value (M2 终审 follow-up).
const TEST_TIMEOUT_MS = 60_000;

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
// becomes a 400 with the provider's own message.
async function materialize(state, bot) {
  const port = state.ports?.getProvider?.(bot.provider);
  if (port != null && typeof port.materializeConfig === 'function') {
    try {
      await port.materializeConfig(bot, { log: state.log });
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

async function agentsHandler({ res, state }) {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const agents = state.doc.bots.filter(isObject).map((bot) => {
    const st = state.engine.status(bot.id);
    const rows = state.ledgerFor(bot.id).ledger.turns();
    const todayTurns = rows.filter((r) => (r.at ?? 0) >= midnight.getTime()).length;
    const users = new Set(rows.map((r) => r.userid).filter(Boolean)).size;
    const chats = new Set(rows.map((r) => r.chatKey).filter(Boolean)).size;
    // 连接态 (§8): a terminal 'stopped' adapter (subscribe 鉴权失败, kicked)
    // means the bot cannot receive — report offline with the adapter's
    // lastError as the reason (DESIGN §4 凭证错误快速失败: bot 标 error).
    const adapter = state.adapterFor(bot.id);
    let chan = null;
    try { chan = typeof adapter?.status === 'function' ? adapter.status() : null; } catch { chan = null; }
    const chanStopped = chan?.state === 'stopped';
    // Blind-review P2-4: enabled bots get an offline reason when a port
    // vanishes, but a DISABLED bot was never attached — no reason, no signal.
    // Flag the missing provider/channel port so the list card can hint it
    // beyond the gray 已停用 state (the plugin was likely disabled).
    const providerMissing = state.ports?.getProvider?.(bot.provider) == null
      || state.ports?.getChannel?.(bot.channel) == null;
    return {
      id: bot.id, name: bot.name, enabled: bot.enabled !== false,
      provider: bot.provider, channel: bot.channel,
      status: st.status === 'offline' || chanStopped ? 'offline' : st.status,
      running: st.running, progress: st.progress,
      todayTurns, users, chats, turns: rows.length,
      reason: state.offlineReason(bot.id) ?? (chanStopped ? (chan.lastError ?? 'channel stopped') : null),
      channelState: chan == null ? null : { state: chan.state ?? null, lastError: chan.lastError ?? null },
      providerMissing,
    };
  });
  sendJson(res, 200, { agents });
}

async function createBotHandler({ req, res, state }) {
  const bot = await readBody(req);
  if (!isObject(bot)) throw httpError(400, 'bot record must be a JSON object');
  if (typeof bot.id === 'string' && state.doc.bots.some((b) => isObject(b) && b.id === bot.id)) {
    throw httpError(400, `bot id already exists: ${bot.id}`);
  }
  validateOrThrow(bot, state.ports);
  await materialize(state, bot);
  state.doc.bots.push(bot);
  saveBots(state.botsFile, state.doc);
  if (bot.enabled !== false) state.attach(bot);
  sendJson(res, 200, { bot: maskedBotEcho(state, bot) });
}

async function patchBotHandler({ req, res, m, state }) {
  const bot = findBot(state, idOf(m));
  if (bot == null) throw httpError(404, 'bot not found');
  const patchBody = await readBody(req);
  if (!isObject(patchBody)) throw httpError(400, 'patch body must be a JSON object');
  // Resolve write-only fields BEFORE the merge (the rules read the OLD
  // record's stored values); the schemas are the merged channel/provider's —
  // a patch may retarget either port id in the same request.
  preserveWriteOnly(state.ports?.getChannel?.(patchBody.channel ?? bot.channel)?.accountSchema,
    patchBody.account, bot.account);
  preserveWriteOnly(state.ports?.getProvider?.(patchBody.provider ?? bot.provider)?.configSchema,
    patchBody.providerConfig, bot.providerConfig);
  const merged = { ...bot, ...patchBody, id: bot.id }; // id is immutable
  validateOrThrow(merged, state.ports);
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
  if (bot.enabled !== false) { // any accepted change reconnects the runtime
    await drainBotOf(state, bot.id); // §8: the bot's serial chain settles (final frames out) before the adapter swap
    state.detach(bot.id, 're-attach after update');
    state.attach(bot);
  }
  sendJson(res, 200, { bot: maskedBotEcho(state, bot) });
}

async function deleteBotHandler({ res, m, state }) {
  const bot = findBot(state, idOf(m));
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
  state.doc.bots.splice(state.doc.bots.indexOf(bot), 1);
  saveBots(state.botsFile, state.doc);
  sendJson(res, 200, { ok: true });
}

async function toggleBotHandler({ res, m, state }) {
  const bot = findBot(state, idOf(m));
  if (bot == null) throw httpError(404, 'bot not found');
  bot.enabled = bot.enabled === false; // absent = true (DESIGN §3 record shape)
  saveBots(state.botsFile, state.doc);
  if (bot.enabled) state.attach(bot);
  else {
    await drainBotOf(state, bot.id); // a disabled runtime waits out its chain first
    state.detach(bot.id, 'bot disabled');
  }
  sendJson(res, 200, { bot: maskedBotEcho(state, bot) });
}

// Registry view for the UI's schema-driven forms (M3 T2): which channels and
// providers are live, each with the schema that validates its config block.
// `owner` (the REGISTERING plugin's id, M3 T3) lets the plugin-manager page
// compute which bots a provider/channel plugin disable would take offline —
// port ids need not match their owning plugin's id (fake-shot registers
// channel 'fakec'). Ports registry entries are {impl, owner} wrappers; a
// bare-lifecycle test without ports yields empty lists, not a 500.
async function portsHandler({ res, state }) {
  const channels = [...(state.ports?.channel?.entries() ?? [])].map(([id, { impl, owner } = {}]) => ({
    id,
    owner: owner ?? null,
    accountSchema: Array.isArray(impl?.accountSchema) ? impl.accountSchema : [],
  }));
  const providers = [...(state.ports?.provider?.entries() ?? [])].map(([id, { impl, owner } = {}]) => ({
    id,
    owner: owner ?? null,
    configSchema: Array.isArray(impl?.configSchema) ? impl.configSchema : [],
  }));
  sendJson(res, 200, { channels, providers });
}

// Full bot records for the CRUD editor (M3 T2). sendJson's sanitize strips
// secret/*apikey* keys, so what the editor receives is write-only — editing
// an unrelated field resubmits the account without the secret, which the
// PATCH keep-blank-password rule turns back into the stored value. Inside
// object-typed fields the echo additionally MASKS sensitive-looking string
// values (maskedBotEcho): a hand-filled secret literal in env/model never
// displays, and the '__MASKED__' round-trip PATCHes back as "unchanged".
async function listBotsHandler({ res, state }) {
  sendJson(res, 200, { bots: state.doc.bots.filter(isObject).map((b) => maskedBotEcho(state, b)) });
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
async function testBotHandler({ req, res, m, state }) {
  const bot = findBot(state, idOf(m));
  if (bot == null) throw httpError(404, 'bot not found');
  const port = state.ports?.getProvider?.(bot.provider);
  if (port == null || typeof port.createRunner !== 'function') {
    throw httpError(400, `provider ${bot.provider} unavailable`);
  }
  const reqBody = await readBody(req);
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
  const runner = port.createRunner({ bot, providerConfig: bot.providerConfig, log: state.log });
  let events = 0;
  const result = await runner.run({
    prompt,
    sessionId,
    signal: new AbortController().signal,
    timeoutMs: TEST_TIMEOUT_MS,
    onEvent: () => { events++; },
  });
  const body = {
    code: result?.code ?? 'error',
    finalText: result?.finalText ?? '',
    sessionId: result?.sessionId ?? null,
    events,
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
    };
    try {
      body.errorText = typeof port.describeError === 'function'
        ? String(port.describeError(result))
        : String(result?.error ?? 'run failed');
    } catch { body.errorText = String(result?.error ?? 'run failed'); }
  }
  sendJson(res, 200, body);
}

async function ledgerHandler({ res, searchParams, state }) {
  const botId = searchParams.get('bot');
  if (botId == null || botId === '') throw httpError(400, 'bot is required');
  if (findBot(state, botId) == null) throw httpError(404, 'bot not found');
  const chat = searchParams.get('chat');
  sendJson(res, 200, state.ledgerFor(botId).ledger.turns(chat ? { chatKey: chat } : {}));
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

async function timelineHandler({ res, searchParams, state }) {
  const bot = searchParams.get('bot') || undefined;
  if (bot !== undefined && findBot(state, bot) == null) throw httpError(404, 'bot not found');
  const windowParam = searchParams.get('window');
  let windowMs;
  if (windowParam != null && windowParam !== '') {
    windowMs = Number(windowParam);
    if (!Number.isFinite(windowMs) || windowMs < 0) throw httpError(400, 'window must be a non-negative number (ms)');
  }
  sendJson(res, 200, state.timeline.get({ botId: bot, windowMs }));
}

// Server-initiated push (§8). The chatRef handed to the adapter IS the raw
// chatKey string — adapters parse their OWN addressing (channel port contract,
// §4; T17 implements the wecom 'wecom:group:X' → {chatid,chatType} parse).
// The engine/API never hardcode one channel's addressing scheme.
async function sendHandler({ req, res, state }) {
  const body = await readBody(req);
  const { botId, chatKey, content } = isObject(body) ? body : {};
  if (typeof botId !== 'string' || botId === '') throw httpError(400, 'botId is required');
  if (typeof chatKey !== 'string' || chatKey === '') throw httpError(400, 'chatKey is required');
  if (typeof content !== 'string' || content === '') throw httpError(400, 'content is required');
  if (findBot(state, botId) == null) throw httpError(404, 'bot not found');
  const adapter = state.adapterFor(botId);
  if (adapter == null || typeof adapter.push !== 'function') throw httpError(409, 'bot is offline');
  await adapter.push(chatKey, content);
  sendJson(res, 200, { ok: true });
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
  ['GET', /^\/ledger$/, ledgerHandler],
  ['GET', /^\/session$/, sessionHandler],
  ['GET', /^\/export$/, exportHandler],
  ['GET', /^\/timeline$/, timelineHandler],
  ['POST', /^\/send$/, sendHandler],
];

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
