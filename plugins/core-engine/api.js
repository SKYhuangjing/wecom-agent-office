// core-engine business API (DESIGN §8), mounted by plugin.js at prefix /api
// via ctx.http.register. Kernel-native routes (/api/state, /api/plugins,
// /api/service/reload, /api/events) are exact longer prefixes on the same
// shell — longest-prefix wins, so they never land here and everything else
// under /api does. Body parsing is ours (64KB cap; the shell parses nothing),
// and EVERY JSON response is scrubbed by sanitize before serialization:
// §8 — 响应永不回显 secret.
import { saveBots, validateBot } from './bots.js';

const BODY_LIMIT_BYTES = 64 * 1024;
const TEST_PROMPT = '回复：收到';
const TEST_TIMEOUT_MS = 30_000;

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
    return {
      id: bot.id, name: bot.name, enabled: bot.enabled !== false,
      provider: bot.provider, channel: bot.channel,
      status: st.status === 'offline' || chanStopped ? 'offline' : st.status,
      running: st.running, progress: st.progress,
      todayTurns, users, chats, turns: rows.length,
      reason: state.offlineReason(bot.id) ?? (chanStopped ? (chan.lastError ?? 'channel stopped') : null),
      channelState: chan == null ? null : { state: chan.state ?? null, lastError: chan.lastError ?? null },
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
  sendJson(res, 200, { bot });
}

async function patchBotHandler({ req, res, m, state }) {
  const bot = findBot(state, idOf(m));
  if (bot == null) throw httpError(404, 'bot not found');
  const patchBody = await readBody(req);
  if (!isObject(patchBody)) throw httpError(400, 'patch body must be a JSON object');
  const merged = { ...bot, ...patchBody, id: bot.id }; // id is immutable
  validateOrThrow(merged, state.ports);
  if (patchBody.provider !== undefined || patchBody.providerConfig !== undefined) {
    try {
      await materialize(state, merged);
    } catch (err) {
      // Last-good semantics: nothing is persisted, the previous config stays
      // on disk, and the bot goes offline carrying the materialize reason.
      state.detach(bot.id, err.message);
      throw err;
    }
  }
  Object.assign(bot, patchBody, { id: bot.id });
  saveBots(state.botsFile, state.doc);
  if (bot.enabled !== false) { // any accepted change reconnects the runtime
    state.detach(bot.id, 're-attach after update');
    state.attach(bot);
  }
  sendJson(res, 200, { bot });
}

async function deleteBotHandler({ res, m, state }) {
  const bot = findBot(state, idOf(m));
  if (bot == null) throw httpError(404, 'bot not found');
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
  else state.detach(bot.id, 'bot disabled');
  sendJson(res, 200, { bot });
}

// Probe run: the provider runner DIRECTLY — no channel, no engine chain, no
// ledger row. Answers "does this bot's provider still work?" in isolation.
async function testBotHandler({ res, m, state }) {
  const bot = findBot(state, idOf(m));
  if (bot == null) throw httpError(404, 'bot not found');
  const port = state.ports?.getProvider?.(bot.provider);
  if (port == null || typeof port.createRunner !== 'function') {
    throw httpError(400, `provider ${bot.provider} unavailable`);
  }
  const runner = port.createRunner({ bot, providerConfig: bot.providerConfig, log: state.log });
  let events = 0;
  const result = await runner.run({
    prompt: TEST_PROMPT,
    sessionId: null,
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
