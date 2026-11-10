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

// Decline copy for genuinely unsupported msgtypes（video/quote/…——盲评 P2-2：
// 原移植文案「图片/文件/语音暂不支持」在多模态落地后失实——语音走 voice.content
// 识别文本、图片/文件开启后可用；现在唯一真不支持的是 video 等无媒体项又无
// 文本的类型。移植期的 "never reword" 规则随本功能作废，CHANGELOG 已注明）。
const DECLINE_NON_TEXT = '这类消息暂不支持哦～（视频等类型还不支持；文字、语音、图片和文件都可以，发送图片/文件请用单聊）';
const DECLINE_EMPTY_AT = '收到 @，但没有文字内容～在 @ 我之后补上想问的问题就行。';
// 附件文案矩阵（DESIGN-MULTIMODAL §4.4）：按「引擎能力 → 开关 → 下载/解密
// 结果」分级。群聊裸图到不了（企微只允许单聊裸图，群聊要走图文混排），所以
// 走到这里的一定是单聊 image/file 或 mixed 图文。
const DECLINE_ENGINE_NO_VISION = '该 bot 的引擎暂不支持图片，仅处理文字部分。';
const DECLINE_VISION_OFF = '图片处理未开启：请管理员在机器人配置中打开「图片输入」后再发图。';
const DECLINE_IMAGE_DOWNLOAD = '图片下载失败，请重发。';
const DECLINE_FILE_DOWNLOAD = '文件下载失败，请重发。';
const DECLINE_IMAGE_TOO_LARGE = '图片过大（超过 4MB），请压缩后重发。';
const DECLINE_FILE_TOO_LARGE = '文件过大（超过 20MB），请精简后重发。';
const DECLINE_IMAGE_TYPE = '图片格式暂不支持（支持 png/jpg/gif/webp）。';
const DECLINE_TOO_MANY = '附件过多，一次最多发送 4 个。';
// 单条消息的附件数上限——与试跑面 TEST_MAX_ATTACHMENTS 同口径（盲评 P1-2：
// ≥2 张贴上限图会击穿 claude stdin 10MB，数量必须在渠道层卡住，超出的逐项
// 注记而非静默丢）。
const MAX_ATTACHMENTS = 4;

// MediaError.code → 用户文案（拒绝优于静默丢；解密失败对用户=下载失败）。
function declineCopyFor(failure, kind) {
  const image = kind === 'image';
  switch (failure?.code) {
    case 'too-large': return image ? DECLINE_IMAGE_TOO_LARGE : DECLINE_FILE_TOO_LARGE;
    case 'unsupported-type': return DECLINE_IMAGE_TYPE;
    case 'too-many': return DECLINE_TOO_MANY;
    default: return image ? DECLINE_IMAGE_DOWNLOAD : DECLINE_FILE_DOWNLOAD;
  }
}

// Push limits, ported from the bridge's /send handler (生产语义):
const MAX_PUSH_CHARS = 4000; // WeCom markdown push cap; truncate + '…'
const PUSH_RATE_MAX = 25; // 25 pushes / 60s per chatid, drop + warn
// Inbound: WeCom allows 30 msgs/min per chat (bridge._rateOk, ported).
const RATE_MAX = 30;
const RATE_WINDOW_MS = 60000;
// reqId→chatKey bound: only a reqId that arrived moments ago can still get a
// final frame, so the most recent 256 mappings are plenty; oldest evicted.
const REQ_CHAT_KEY_MAX = 256;

// Ported from wecom-bridge bridge.js _extractText — with two deliberate
// refinements: a `mixed` message whose parts contain NO text at all is
// non-text (null → 暂不支持), not empty (空@). Grouped images-only mixed
// messages are images, not mentions. And `voice` carries the ASR text
// inline (企微智能机器人回调：voice.content 就是识别结果，DESIGN-MULTIMODAL
// §2.1)——识别为空串时落入空文本路径（DECLINE_EMPTY_AT），与其他空文本一致。
function extractText(body) {
  if (body.msgtype === 'text') return body.text?.content ?? '';
  if (body.msgtype === 'voice') return body.voice?.content ?? '';
  if (body.msgtype === 'mixed') {
    // mixed: text + images; concatenate the text parts
    const items = body.mixed?.msg_item || [];
    const parts = items.filter((i) => i.msgtype === 'text').map((i) => i.text?.content || '');
    if (items.length > 0 && parts.length === 0) return null;
    return parts.join('\n');
  }
  return null;
}

// 回调里的媒体项（DESIGN-MULTIMODAL §2.1）：单聊 image/file 直取；mixed 的
// msg_item 只挑 image 子项（官方类型定义：text|image）。voice 的识别文本已
// 由 extractText 处理，quote 暂不支持（远期）。返回空数组 = 无附件（纯文本
// 走原路径，语义零变化）。
function extractMediaItems(body) {
  const items = [];
  const pick = (kind, m) => {
    if (m && typeof m.url === 'string' && m.url !== '') {
      items.push({ kind, url: m.url, aeskey: typeof m.aeskey === 'string' ? m.aeskey : '' });
    }
  };
  if (body.msgtype === 'image') pick('image', body.image);
  else if (body.msgtype === 'file') pick('file', body.file);
  else if (body.msgtype === 'mixed') {
    for (const it of body.mixed?.msg_item || []) {
      if (it?.msgtype === 'image') pick('image', it.image);
    }
  }
  return items;
}

export function createAdapter({ account, bot, log, engine, WebSocket, mediaStore = null }) {
  const acct = account || {};
  const pingSec = Number(acct.pingIntervalSec);
  // Test/diagnostic knob (not part of accountSchema): shortens the 15s ack
  // wait so timeout semantics are testable in milliseconds.
  const ackMs = Number(acct.ackTimeoutMs);
  const client = createWecomClient({
    WebSocket,
    url: acct.wsUrl || DEFAULT_WS_URL,
    botId: acct.botId,
    secret: acct.secret,
    pingIntervalSec: Number.isFinite(pingSec) && pingSec > 0 ? pingSec : 30,
    ackTimeoutMs: Number.isFinite(ackMs) && ackMs > 0 ? ackMs : undefined,
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
      // 非终帧（ack/progress 流刷新）超时 = 尽力而为（前身注释 "Refresh/reply
      // acks are best-effort"）：降为 debug，不制造每轮一条的伪告警。终帧
      // 超时仍是 warn 并进入补发队列（真丢帧时的安全网）。
      if (e?.code === 'ACK_TIMEOUT' && !meta?.finish) {
        log.debug?.(`channel-wecom: non-final frame ack timeout (best-effort, dropped): ${e?.message || e}`);
        return null;
      }
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
    // 媒体项先于「非文字」判定：纯图/纯文件消息 text 是 null，但附件路径
    // 要接管它（下载解密送引擎）；text 为 null 且无媒体项才是真·不支持类型。
    const mediaItems = extractMediaItems(body);
    if (text === null && mediaItems.length === 0) {
      // Unsupported type (video/quote/…): politely decline.
      log.warn?.(`drop msgtype=${body.msgtype}: unsupported type (no text parts)`);
      reply(reqId, DECLINE_NON_TEXT);
      return;
    }
    if (text !== null && !text.trim() && mediaItems.length === 0) {
      // A group message with only an @-mention and no text lands here. Log so
      // it is distinguishable from "no callback" (ported comment + copy).
      log.warn?.(`drop empty text chattype=${chattype} chatid=${chatid} msgtype=${body.msgtype}`);
      reply(reqId, DECLINE_EMPTY_AT);
      return;
    }
    const chatKind = chattype === 'group' ? 'group' : 'single';
    const chatKey = `wecom:${chatKind}:${chatid}`;

    // —— 附件路径（DESIGN-MULTIMODAL Phase 1/2）———————————————————————————
    // mediaStore 由 plugin.js 注入（data/media 仓库）；botFeatures 由引擎的
    // channel facade 提供（provider 能力 visionSupported + 最终放行 vision =
    // 能力 × providerConfig.visionInput）。两者缺一（测试/降级）= 附件不可用。
    if (mediaItems.length > 0) {
      // 盲评 P1-4：vision 门禁只对图片。文件（含文本类）四家引擎全受益
      // （DESIGN §4.3），PDF 的 provider 分流在引擎 fileSectionFor——渠道层
      // 拿「不支持图片」的文案拦文件是指鹿为马。
      const imageItems = mediaItems.filter((it) => it.kind === 'image');
      let visionOn = false;
      let visionSupported = false;
      if (imageItems.length > 0) {
        let feats = {};
        try {
          feats = (typeof engine.botFeatures === 'function' ? engine.botFeatures() : null) ?? {};
        } catch (e) {
          log.warn?.(`channel-wecom: botFeatures() threw: ${e?.message || e}`);
        }
        visionSupported = feats.visionSupported === true;
        visionOn = feats.vision === true && mediaStore != null;
      }
      // 盲评 P1-2：附件数上限与试跑面同口径（4 个）——超出的不下载、逐项
      // 注记 too-many（好附件保留，绝不静默丢）。
      const toFetch = mediaItems.slice(0, MAX_ATTACHMENTS);
      const overQuota = mediaItems.slice(MAX_ATTACHMENTS);
      const quotaFailures = overQuota.map((it) => ({ kind: it.kind, code: 'too-many' }));

      if (imageItems.length > 0 && !visionOn) {
        // 分级：引擎有视觉能力但没开 → 引导开启；引擎根本不支持 → 明说。
        const code = visionSupported ? 'vision-off' : 'engine-no-vision';
        if (typeof text === 'string' && text.trim() !== '') {
          // mixed 图文：文字照进引擎（「只传 text」），附件拒收原因随信封
          // 注明，模型会向用户说明——不炸、不静默。只对配额内的图注 vision
          // 原因（复测 P2-5）：超额图已在 quotaFailures 里记 too-many，再按
          // 全量 imageItems 注 vision 会让同一张图出现两条注记。
          const inQuotaImages = imageItems.filter((it) => toFetch.includes(it));
          log.warn?.(`drop ${inQuotaImages.length} image(s) for ${chatKey}: ${code}`);
          deliverToEngine(chatKey, chatKind, chatid, userid, reqId, msg, text,
            [], [...inQuotaImages.map((it) => ({ kind: it.kind, code })), ...quotaFailures]);
        } else {
          log.warn?.(`drop msgtype=${body.msgtype} (no text, ${code})`);
          reply(reqId, visionSupported ? DECLINE_VISION_OFF : DECLINE_ENGINE_NO_VISION);
        }
        return;
      }
      if (mediaStore == null) {
        // 纯文件消息但媒体仓库缺席（bare 测试/降级装配）：文件也得有 store
        // 才能下载落盘——诚实婉拒，不静默。
        log.warn?.(`media store missing, drop ${toFetch.length} file attachment(s) for ${chatKey}`);
        if (typeof text === 'string' && text.trim() !== '') {
          deliverToEngine(chatKey, chatKind, chatid, userid, reqId, msg, text, [],
            [...toFetch.map((it) => ({ kind: it.kind, code: 'download-failed' })), ...quotaFailures]);
        } else {
          reply(reqId, declineCopyFor({ code: 'download-failed' }, toFetch[0]?.kind ?? 'file'));
        }
        return;
      }
      // 5 分钟 url 时效红线：收到即下载+解密+落盘，绝不等引擎层（url 过期
      // 即永远拿不回）。多附件并发；每个失败单独记录（拒绝优于静默丢）。
      Promise.allSettled(toFetch.map((it) => mediaStore.fetchAttachment({ botId: bot.id, ...it })))
        .then((results) => {
          const attachments = [];
          const attachmentFailures = [...quotaFailures];
          results.forEach((r, i) => {
            if (r.status === 'fulfilled') attachments.push(r.value);
            else attachmentFailures.push({
              kind: toFetch[i].kind,
              code: r.reason?.code || 'download-failed',
              detail: String(r.reason?.message ?? r.reason).slice(0, 200),
            });
          });
          const hasText = typeof text === 'string' && text.trim() !== '';
          if (attachments.length === 0 && !hasText) {
            // 纯图/纯文件且全军覆没：直接婉拒（文案矩阵），不进引擎。
            log.warn?.(`media download failed for ${chatKey}: ${attachmentFailures.map((f) => f.code).join(',')}`);
            reply(reqId, declineCopyFor(attachmentFailures[0], toFetch[0].kind));
            return;
          }
          deliverToEngine(chatKey, chatKind, chatid, userid, reqId, msg,
            hasText ? text : '', attachments, attachmentFailures);
        });
      return;
    }

    deliverToEngine(chatKey, chatKind, chatid, userid, reqId, msg, text, [], []);
  });

  // Common tail of the inbound path: remember reqId→chatKey so a later failed
  // final can be replayed by push to the chat, then hand the message to the
  // engine (text 语义不变；attachments/attachmentFailures 是扩展字段).
  function deliverToEngine(chatKey, chatKind, chatid, userid, reqId, msg, text, attachments, attachmentFailures) {
    if (reqId) {
      if (reqChatKey.size >= REQ_CHAT_KEY_MAX) reqChatKey.delete(reqChatKey.keys().next().value);
      reqChatKey.set(reqId, chatKey);
    }
    engine.onMessage({
      botId: bot.id, chatKey, chatKind, chatid, userid, text, reqId, raw: msg,
      attachments, attachmentFailures,
    });
  }

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
