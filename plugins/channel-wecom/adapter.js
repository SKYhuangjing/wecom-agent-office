// channel-wecom adapter (Task 17): bridges the ported WeComClient to the
// engine through the channel port contract (DESIGN §4) —
//   inbound : aibot_msg_callback → text extraction (ported verbatim from
//             wecom-bridge bridge.js) → engine.onMessage; non-text / empty-@
//             get the verbatim decline copy via reply()
//   outbound: five primitives ack/progress/reply/welcome/push
//   safety  : 30/min inbound guard + 25/60s push limiter per chatid (ported
//             生产语义), 4000-char push truncation, 断线 final 补发 (a lost
//             finish=true frame is replayed as an aibot_send_msg push after
//             reconnect — DESIGN §4; see the 'state' handler for why the
//             stale req_id is never reused)
import { createWecomClient } from './client.js';

const DEFAULT_WS_URL = 'wss://openws.work.weixin.qq.com';

// DESIGN §4 capabilities: the engine reads these for pacing/truncation.
export const CAPABILITIES = {
  stream: true,
  push: true,
  group: true,
  welcome: true,
  maxContentChars: 3500,
  minIntervalMs: 2200,
  streamDeadlineMs: 600000,
};

// Verbatim decline copy from wecom-bridge bridge.js (never reword these).
const DECLINE_NON_TEXT = '目前这个机器人只支持文字消息哦～（图片/文件/语音暂不支持）';
const DECLINE_EMPTY_AT = '收到 @，但没有文字内容～在 @ 我之后补上想问的问题就行。';

// Push limits, ported from the bridge's /send handler (生产语义):
const MAX_PUSH_CHARS = 4000; // WeCom markdown push cap; truncate + '…'
const PUSH_RATE_MAX = 25; // 25 pushes / 60s per chatid, drop + warn
// Inbound: WeCom allows 30 msgs/min per chat (bridge._rateOk, ported).
const RATE_MAX = 30;
const RATE_WINDOW_MS = 60000;
// reqId→chatKey bound: only a reqId that arrived moments ago can still get a
// final frame, so the most recent 256 mappings are plenty; oldest evicted.
const REQ_CHAT_KEY_MAX = 256;

// Ported from wecom-bridge bridge.js _extractText — with one deliberate
// refinement: a `mixed` message whose parts contain NO text at all is
// non-text (null → 暂不支持), not empty (空@). Grouped images-only mixed
// messages are images, not mentions.
function extractText(body) {
  if (body.msgtype === 'text') return body.text?.content ?? '';
  if (body.msgtype === 'mixed') {
    // mixed: text + images; concatenate the text parts
    const items = body.mixed?.msg_item || [];
    const parts = items.filter((i) => i.msgtype === 'text').map((i) => i.text?.content || '');
    if (items.length > 0 && parts.length === 0) return null;
    return parts.join('\n');
  }
  return null;
}

export function createAdapter({ account, bot, log, engine, WebSocket }) {
  const acct = account || {};
  const pingSec = Number(acct.pingIntervalSec);
  const client = createWecomClient({
    WebSocket,
    url: acct.wsUrl || DEFAULT_WS_URL,
    botId: acct.botId,
    secret: acct.secret,
    pingIntervalSec: Number.isFinite(pingSec) && pingSec > 0 ? pingSec : 30,
    logger: log,
    // 生产语义：被踢即停机，不重连抢连接；通知引擎该 channel 已断。
    onKicked: () => {
      log.warn?.('channel-wecom: kicked by another connection; client stopped');
      if (typeof engine.onChannelEvent === 'function') {
        try {
          engine.onChannelEvent({ type: 'disconnected', reqId: null, raw: null });
        } catch (e) {
          log.warn?.(`channel-wecom: onChannelEvent(disconnected) threw: ${e?.message || e}`);
        }
      }
    },
    // 凭证错误已由 client 置 stopped + lastError；这里只留痕，status() 可见。
    onAuthFail: (errcode, errmsg) => {
      log.error?.(`channel-wecom: subscribe auth failed errcode=${errcode}: ${errmsg || ''}`);
    },
  });

  // Per-chatid rate windows (ported bridge._rateOk shape).
  const inboundRate = new Map(); // chatid -> {count, windowStart}
  const pushRate = new Map(); // chatid -> {count, windowStart}
  // 断线 final 补发 (DESIGN §4): chatKey -> {text}; a NEWER final for the
  // same chat overwrites the queued older one.
  const pendingFinal = new Map();
  // reqId -> chatKey for inbound messages that reached the engine; lets a
  // failed final be re-addressed to the CHAT (push) instead of the req_id.
  const reqChatKey = new Map();

  function rateOk(map, chatid, max) {
    const now = Date.now();
    const r = map.get(chatid) || { count: 0, windowStart: now };
    if (now - r.windowStart > RATE_WINDOW_MS) {
      r.count = 0;
      r.windowStart = now;
    }
    r.count++;
    map.set(chatid, r);
    return r.count <= max;
  }

  // All outbound sends go through here: never throw to the engine, and a
  // failed finish=true frame is stored for replay once we are online again.
  function send(fn, meta) {
    return fn().catch((e) => {
      log.warn?.(`channel-wecom: send failed: ${e?.message || e}`);
      if (meta?.finish) {
        // Replay target is the CHAT (chatKey), not the failed req_id.
        const chatKey = reqChatKey.get(meta.reqId);
        if (!chatKey) {
          log.warn?.(`channel-wecom: cannot queue final replay, no chatKey known for reqId=${meta.reqId}`);
          return null;
        }
        pendingFinal.set(chatKey, { text: meta.text });
        log.info?.(`channel-wecom: final frame queued for push replay chatKey=${chatKey}`);
      }
      return null;
    });
  }

  // ---- five outbound primitives ------------------------------------------

  function ack(reqId, streamId, text) {
    return send(() => client.respondStream(reqId, streamId, text, false), { reqId, streamId, text, finish: false });
  }

  function progress(reqId, streamId, text, finish) {
    return send(() => client.respondStream(reqId, streamId, text, !!finish), { reqId, streamId, text, finish: !!finish });
  }

  function reply(reqId, text) {
    return send(() => client.respondMarkdown(reqId, text), { reqId, text, finish: false });
  }

  function welcome(reqId, text) {
    return send(() => client.respondWelcome(reqId, text), { reqId, text, finish: false });
  }

  // chatRef is the chatKey string: wecom:group:<id> → chat_type 2,
  // wecom:single:<id> → chat_type 1 (aibot_send_msg semantics).
  function push(chatRef, text) {
    const m = /^wecom:(group|single):(.+)$/.exec(String(chatRef || ''));
    if (!m) {
      log.warn?.(`channel-wecom: push rejected, bad chatRef ${JSON.stringify(chatRef)}`);
      return Promise.resolve(null);
    }
    const chatid = m[2];
    const chatType = m[1] === 'group' ? 2 : 1;
    let content = String(text ?? '');
    // Predecessor /send semantics: empty (or whitespace-only) content is
    // rejected with a warn, never sent.
    if (!content.trim()) {
      log.warn?.(`channel-wecom: push rejected, empty text for chatid=${chatid}`);
      return Promise.resolve(null);
    }
    if (content.length > MAX_PUSH_CHARS) content = content.slice(0, MAX_PUSH_CHARS - 1) + '…';
    if (!rateOk(pushRate, chatid, PUSH_RATE_MAX)) {
      log.warn?.(`channel-wecom: push rate limit hit for ${chatid}; dropped`);
      return Promise.resolve(null);
    }
    return send(() => client.sendMarkdown(chatid, chatType, content), { reqId: null, finish: false, push: { chatid, chatType } });
  }

  // ---- inbound -----------------------------------------------------------

  client.on('message', (msg) => {
    const body = msg.body || {};
    const reqId = msg.headers?.req_id;
    const userid = body.from?.userid;
    const chattype = body.chattype;
    // chatKey scoping (ported bridge._key): group → chatid, single → userid.
    const chatid = chattype === 'group' ? body.chatid : userid;
    if (!rateOk(inboundRate, chatid, RATE_MAX)) {
      log.warn?.(`rate limit hit for ${chatid}`);
      return;
    }
    const text = extractText(body);
    if (text === null) {
      // Unsupported type (image/file/voice): politely decline.
      log.warn?.(`drop msgtype=${body.msgtype}: unsupported type (no text parts)`);
      reply(reqId, DECLINE_NON_TEXT);
      return;
    }
    if (!text.trim()) {
      // A group message with only an @-mention and no text lands here. Log so
      // it is distinguishable from "no callback" (ported comment + copy).
      log.warn?.(`drop empty text chattype=${chattype} chatid=${chatid} msgtype=${body.msgtype}`);
      reply(reqId, DECLINE_EMPTY_AT);
      return;
    }
    const chatKind = chattype === 'group' ? 'group' : 'single';
    const chatKey = `wecom:${chatKind}:${chatid}`;
    // Remember reqId→chatKey so a later failed final can be replayed by push
    // to the chat (bounded; only reqIds that reached the engine matter).
    if (reqId) {
      if (reqChatKey.size >= REQ_CHAT_KEY_MAX) reqChatKey.delete(reqChatKey.keys().next().value);
      reqChatKey.set(reqId, chatKey);
    }
    engine.onMessage({ botId: bot.id, chatKey, chatKind, chatid, userid, text, reqId, raw: msg });
  });

  client.on('event', (msg) => {
    const et = msg.body?.event?.eventtype;
    const reqId = msg.headers?.req_id;
    // enter_chat: engine first; if it doesn't handle the welcome, send the
    // default copy ourselves.
    if (et === 'enter_chat') {
      let handled = false;
      if (typeof engine.onChannelEvent === 'function') {
        try {
          handled = engine.onChannelEvent({ type: 'enter_chat', reqId, raw: msg });
        } catch (e) {
          log.warn?.(`channel-wecom: onChannelEvent(enter_chat) threw: ${e?.message || e}`);
        }
      }
      if (handled !== true) {
        welcome(reqId, `您好，我是 ${bot.name || '机器人'}。直接发消息，我会在你的工作区里完成任务。`);
      }
      return;
    }
    // disconnected_event never reaches here (the client stops itself, see
    // onKicked above); other events pass straight through.
    if (typeof engine.onChannelEvent === 'function') {
      try {
        engine.onChannelEvent({ type: et, reqId, raw: msg });
      } catch (e) {
        log.warn?.(`channel-wecom: onChannelEvent(${et}) threw: ${e?.message || e}`);
      }
    }
  });

  // 断线 final 补发 (DESIGN §4): once the client is online again (reconnected),
  // flush every queued final via push (aibot_send_msg) — best-effort, subject
  // to the 25/60s push limiter. respondStream is deliberately NOT used: a
  // callback req_id belongs to the connection that delivered it and is only
  // valid inside its short callback window; replaying the OLD connection's
  // req_id on a NEW connection is unproven and unsafe. That is exactly why
  // the predecessor's /send handler exists (wecom-bridge/src/index.js: there
  // is no 5s callback window for proactive sends) and why DESIGN §4 mandates
  // push for the replay.
  client.on('state', ({ state }) => {
    if (state !== 'online' || pendingFinal.size === 0) return;
    for (const [chatKey, q] of [...pendingFinal]) {
      // Empty queued final (a finish frame that carried no text): push()'s
      // empty guard would reject it with a warn and resolve null — which the
      // ack check below reads as "keep for next reconnect", retaining the
      // entry (and re-warning) on EVERY reconnect, forever. Drop it here.
      if (!String(q?.text ?? '').trim()) {
        log.warn?.(`channel-wecom: dropping empty queued final for ${chatKey} (nothing to replay)`);
        pendingFinal.delete(chatKey);
        continue;
      }
      log.info?.(`channel-wecom: replaying final via push chatKey=${chatKey}`);
      try {
        Promise.resolve(push(chatKey, q.text))
          .then((ack) => {
            if (ack) pendingFinal.delete(chatKey);
            else log.warn?.(`channel-wecom: final push replay not confirmed for ${chatKey}; kept for next reconnect`);
          })
          .catch((e) => log.warn?.(`channel-wecom: final push replay failed for ${chatKey}: ${e?.message || e}`));
      } catch (e) {
        log.warn?.(`channel-wecom: final push replay failed for ${chatKey}: ${e?.message || e}`);
      }
    }
  });

  return {
    start() {
      client.start();
    },
    stop() {
      // Observability: anything still queued is being dropped on the floor.
      if (pendingFinal.size > 0) {
        log.warn?.(`channel-wecom: stop() discarding ${pendingFinal.size} pending final replay(s)`);
        pendingFinal.clear();
      }
      client.stop();
    },
    status() {
      return {
        state: client.state,
        lastError: client.lastError,
        callbacks: client.callbacks,
        lastCallbackAt: client.lastCallbackAt,
      };
    },
    capabilities: CAPABILITIES,
    ack,
    progress,
    reply,
    welcome,
    push,
  };
}
