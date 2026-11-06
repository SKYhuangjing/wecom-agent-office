// WeCom intelligent-robot long-connection client.
//
// Ported from ../wecom-bridge/src/wecom.js (production-proven); the protocol
// logic is unchanged — see that file's history for the 踩坑 record. Diffs of
// this port (Task 17):
//   1. WebSocket is INJECTED (constructor) so the plugin has zero npm deps
//      (kernel re-exports 'ws' as ctx.ws.WebSocket).
//   2. Observable state machine: 'connecting'|'online'|'reconnecting'|'stopped'
//      + lastError, transitions logged and emitted as ('state', ...) events.
//   3. Subscribe ack errcode≠0 (凭证错误) → onAuthFail(errcode, errmsg),
//      authFailed=true, state 'stopped' with lastError 鉴权失败(errcode) —
//      NO tight reconnect loop; a single capped retry (5min) is scheduled
//      (DESIGN §4 凭证快速失败, 防重试风暴).
//   4. disconnected_event → state 'stopped', lastError 'kicked: 另一连接接管',
//      onKicked() — still NO reconnect (生产语义原样).
//   5. Normal close → state 'reconnecting', backoff 1s→1.7x→30s cap (reset on
//      successful subscribe) as before.
//   6. stop() also clears a pending reconnect timer (the original leaked it;
//      here the 5-min auth retry would otherwise outlive the adapter).
//   7. Pending acks are FIFO queues per req_id (the original stored one slot
//      per req_id): a streamed reply reuses the callback req_id for ALL its
//      frames, so single-slot keying orphaned every earlier frame's timer —
//      a false "ack timeout" rejection per streamed turn.
//
// Protocol (see https://developer.work.weixin.qq.com/document/path/101463):
//   - Connect WebSocket to wss://openws.work.weixin.qq.com
//   - Send  {"cmd":"aibot_subscribe","headers":{"req_id":...},"body":{"bot_id","secret"}}
//   - Receive callbacks: aibot_msg_callback / aibot_event_callback
//   - Reply / push: aibot_respond_msg, aibot_respond_welcome_msg,
//                   aibot_respond_update_msg, aibot_send_msg
//   - Heartbeat: {"cmd":"ping"} -> {"cmd":"pong"}
//
// Only ONE valid connection per bot: a new subscribe evicts the old connection.
// We therefore run a single client and reconnect with backoff.

import { randomUUID } from 'node:crypto';

// 凭证类失败的重试封顶（DESIGN §4：快速失败，5 分钟一次，不打企微接口）。
const AUTH_FAIL_RETRY_MS = 5 * 60 * 1000;

export class WeComClient {
  constructor({ WebSocket, url, botId, secret, pingIntervalSec = 30, ackTimeoutMs = 15000, logger, onKicked, onAuthFail }) {
    this.WebSocket = WebSocket;
    this.url = url;
    this.botId = botId;
    this.secret = secret;
    this.pingIntervalSec = pingIntervalSec;
    this.ackTimeoutMs = ackTimeoutMs;
    this.log = logger;
    this.onKicked = onKicked;
    this.onAuthFail = onAuthFail;
    this.ws = null;
    this.subscribed = false;
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.backoff = 1000;
    this.maxBackoff = 30000;
    this.stopped = false;
    this.authFailed = false;
    this.handlers = { message: [], event: [], state: [] };
    // reqId -> [{resolve,reject,timer}] FIFO queue. A streamed reply reuses
    // ONE callback req_id for ALL its frames (respondStream), so several ack
    // slots can be in flight under the same key — each frame gets its OWN
    // slot+timer and an ack settles the OLDEST one (acks come in send order).
    // (Keying by reqId alone made each later frame overwrite the previous
    // slot, whose orphan timer then rejected at +15s — one false
    // "ack timeout" warn per streamed turn; production 2026-11-06 log shows
    // exactly 2, each +15.0s after a turn's final frame.)
    this.pending = new Map();
    this.seq = 0;
    // Diagnostics: did WeCom actually push a callback? Exposed via status().
    this.callbacks = 0;
    this.lastCallbackAt = 0;
    this.lastFrameAt = 0;
    this.state = 'stopped'; // start() flips it to 'connecting'
    this.lastError = null;
  }

  on(kind, fn) {
    if (this.handlers[kind]) this.handlers[kind].push(fn);
    return this;
  }

  _emit(kind, payload) {
    for (const fn of this.handlers[kind] || []) {
      try {
        const r = fn(payload);
        if (r && typeof r.catch === 'function') r.catch((e) => this.log.error(`${kind} handler failed:`, e));
      } catch (e) {
        this.log.error(`${kind} handler threw:`, e);
      }
    }
  }

  _setState(next) {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    this.log.info(`state ${prev} -> ${next}${this.lastError ? ` (${this.lastError})` : ''}`);
    this._emit('state', { state: next, prev, lastError: this.lastError });
  }

  start() {
    this.stopped = false;
    this._setState('connecting');
    this._connect();
    return this;
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this._clearPing();
    this._setState('stopped');
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
    }
  }

  get connected() {
    return !!this.ws && this.ws.readyState === this.WebSocket.OPEN && this.subscribed;
  }

  _connect() {
    if (this.stopped) return;
    this._setState('connecting');
    this.log.info(`connecting ${this.url} ...`);
    const ws = new this.WebSocket(this.url);
    this.ws = ws;
    this.subscribed = false;

    ws.on('open', () => {
      this.log.info('websocket open, sending subscribe');
      this._subscribe();
    });

    ws.on('message', (buf) => this._onRaw(buf.toString()));

    ws.on('close', (code, reason) => {
      this.log.warn(`websocket closed code=${code} reason=${reason?.toString?.() || ''}`);
      this._clearPing();
      this.subscribed = false;
      this._rejectAllPending(new Error('connection closed'));
      // Kicked/auth-failed already recorded their terminal 'stopped' state —
      // only a plain network close is a 'reconnecting' event.
      if (!this.stopped && !this.authFailed) this._setState('reconnecting');
      this._scheduleReconnect();
    });

    ws.on('error', (err) => {
      this.log.error('websocket error:', err?.message || err);
      // 'close' will follow; reconnect handled there.
    });
  }

  _scheduleReconnect() {
    if (this.stopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.authFailed) {
      // 凭证错误：不进入 1s→30s 快速退避循环，只安排一次封顶 5 分钟后的
      // 重试（凭证可能已被运维改好）；期间 state 保持 'stopped'。
      this.log.info(`auth failed earlier; single retry in ${AUTH_FAIL_RETRY_MS}ms`);
      this.reconnectTimer = setTimeout(() => this._connect(), AUTH_FAIL_RETRY_MS);
      return;
    }
    const delay = this.backoff;
    this.backoff = Math.min(this.maxBackoff, Math.round(this.backoff * 1.7));
    this.log.info(`reconnect in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => this._connect(), delay);
  }

  _newReqId() {
    return `req-${Date.now().toString(36)}-${(this.seq++).toString(36)}-${randomUUID().slice(0, 8)}`;
  }

  _send(obj) {
    if (!this.ws || this.ws.readyState !== this.WebSocket.OPEN) {
      throw new Error('websocket not open');
    }
    this.ws.send(JSON.stringify(obj));
  }

  _subscribe() {
    const req_id = this._newReqId();
    this._send({ cmd: 'aibot_subscribe', headers: { req_id }, body: { bot_id: this.botId, secret: this.secret } });
    this._awaitAck(req_id, 15000)
      .then(() => {
        this.subscribed = true;
        this.authFailed = false;
        this.backoff = 1000;
        this.log.info('subscribed to WeCom bot OK');
        this._setState('online');
        this._startPing();
      })
      .catch((err) => {
        if (typeof err?.errcode === 'number' && err.errcode !== 0) {
          // 鉴权类失败（凭证错误）：快速失败语义，见类头 diff 3。
          this._authFailed(err.errcode, err.errmsg);
          return;
        }
        this.log.error('subscribe failed:', err.message);
        // Backoff and reconnect; a wrong secret will keep failing visibly.
        try {
          this.ws?.close();
        } catch {}
      });
  }

  // 凭证错误终态：置 lastError、通知宿主、断开；_scheduleReconnect 的
  // authFailed 分支接管后续（封顶 5 分钟单次重试，无风暴）。
  _authFailed(errcode, errmsg) {
    this.authFailed = true;
    this.lastError = `鉴权失败(${errcode})${errmsg ? `：${errmsg}` : ''}`;
    this.log.error(`subscribe auth failed errcode=${errcode}: ${errmsg || ''}; retry capped at ${AUTH_FAIL_RETRY_MS}ms`);
    this._setState('stopped');
    this._clearPing();
    try {
      this.ws?.close();
    } catch {}
    if (typeof this.onAuthFail === 'function') {
      try {
        this.onAuthFail(errcode, errmsg);
      } catch (e) {
        this.log.error('onAuthFail handler threw:', e);
      }
    }
  }

  _startPing() {
    this._clearPing();
    this.pingTimer = setInterval(() => {
      try {
        this._send({ cmd: 'ping' });
        this.log.debug('ping');
      } catch (e) {
        this.log.debug('ping failed:', e.message);
      }
    }, this.pingIntervalSec * 1000);
  }

  _clearPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  _awaitAck(reqId, timeoutMs) {
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      const q = this.pending.get(reqId) || [];
      if (q.length === 0) this.pending.set(reqId, q);
      q.push(entry);
      entry.timer = setTimeout(() => {
        // Only retire THIS entry — sibling frames under the same reqId keep waiting.
        const cur = this.pending.get(reqId) || [];
        const i = cur.indexOf(entry);
        if (i >= 0) cur.splice(i, 1);
        if (cur.length === 0) this.pending.delete(reqId);
        const err = new Error(`ack timeout for ${reqId}`);
        // Adapter downgrades non-final stream timeouts to debug (best-effort).
        err.code = 'ACK_TIMEOUT';
        reject(err);
      }, timeoutMs);
    });
  }

  _rejectAllPending(err) {
    for (const [, q] of this.pending) {
      for (const p of q) {
        clearTimeout(p.timer);
        p.reject(err);
      }
    }
    this.pending.clear();
  }

  _onRaw(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      this.log.warn('non-JSON frame:', text.slice(0, 200));
      return;
    }
    const cmd = msg.cmd;
    this.lastFrameAt = Date.now();
    this.log.debug('<-', cmd || 'ack', msg.headers?.req_id || '');

    // Acks for our requests (subscribe / respond / send) carry errcode.
    if (!cmd) {
      this._settleAck(msg);
      return;
    }
    if (cmd === 'pong') return;

    if (cmd === 'aibot_msg_callback') {
      const b = msg.body || {};
      // INFO level (was debug): without this, an inbound callback that gets
      // silently dropped downstream leaves NO trace and "no reply" is
      // indistinguishable from "WeCom never pushed the callback".
      this.log.info(`inbound msg_callback chattype=${b.chattype || '?'} chatid=${b.chatid || b.from?.userid || '?'} msgtype=${b.msgtype || '?'} reqId=${msg.headers?.req_id || '?'}`);
      this.callbacks++;
      this.lastCallbackAt = Date.now();
      this._emit('message', msg);
    } else if (cmd === 'aibot_event_callback') {
      const et = msg.body?.event?.eventtype;
      this.log.info(`event: ${et}`);
      if (et === 'disconnected_event') {
        // Another connection took over this bot. Stop and let ops fix it.
        this.log.error('disconnected_event: bot connected elsewhere. Stopping to avoid fight.');
        this.stopped = true;
        this.lastError = 'kicked: 另一连接接管';
        this._clearPing();
        this._setState('stopped');
        try {
          this.ws?.close();
        } catch {}
        if (typeof this.onKicked === 'function') {
          try {
            this.onKicked();
          } catch (e) {
            this.log.error('onKicked handler threw:', e);
          }
        }
        return;
      }
      this._emit('event', msg);
    } else {
      // Possibly an ack carrying the cmd echo
      if (typeof msg.errcode === 'number') this._settleAck(msg);
      else this.log.debug('unhandled cmd:', cmd);
    }
  }

  _settleAck(msg) {
    const reqId = msg.headers?.req_id;
    if (!reqId) return;
    // FIFO: the ack answers the oldest outstanding frame under this reqId.
    const q = this.pending.get(reqId);
    const p = q && q.shift();
    if (!p) return;
    if (!q || q.length === 0) this.pending.delete(reqId);
    clearTimeout(p.timer);
    if (msg.errcode === 0 || msg.errcode === undefined) p.resolve(msg);
    else {
      // Carry errcode/errmsg on the rejection so _subscribe can tell an
      // auth failure (errcode≠0 ack) from a network/timeout failure.
      const err = new Error(`errcode ${msg.errcode}: ${msg.errmsg || ''}`);
      err.errcode = msg.errcode;
      err.errmsg = msg.errmsg;
      p.reject(err);
    }
  }

  // ---- outbound helpers -------------------------------------------------

  async respondWelcome(reqId, text) {
    return this._request({
      cmd: 'aibot_respond_welcome_msg',
      headers: { req_id: reqId },
      body: { msgtype: 'text', text: { content: text } },
    });
  }

  // Send or refresh a streaming reply. Same streamId updates the message.
  async respondStream(reqId, streamId, content, finish) {
    return this._request({
      cmd: 'aibot_respond_msg',
      headers: { req_id: reqId },
      body: {
        msgtype: 'stream',
        stream: { id: streamId, finish: !!finish, content },
      },
    });
  }

  // Plain markdown reply (no streaming).
  async respondMarkdown(reqId, content) {
    return this._request({
      cmd: 'aibot_respond_msg',
      headers: { req_id: reqId },
      body: { msgtype: 'markdown', markdown: { content } },
    });
  }

  // Proactive push to a chat (user must have messaged the bot before).
  async sendMarkdown(chatid, chatType, content) {
    return this._request({
      cmd: 'aibot_send_msg',
      headers: { req_id: this._newReqId() },
      body: { chatid, chat_type: chatType, msgtype: 'markdown', markdown: { content } },
    });
  }

  _request(frame, ackTimeoutMs = this.ackTimeoutMs) {
    const reqId = frame.headers.req_id;
    // Refresh/reply acks are best-effort; don't block the pipeline forever.
    this._send(frame);
    return this._awaitAck(reqId, ackTimeoutMs);
  }
}

// Documented constructor surface (Task 17 brief).
export function createWecomClient(opts) {
  return new WeComClient(opts);
}
