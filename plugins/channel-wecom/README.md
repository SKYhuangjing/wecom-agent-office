# channel-wecom

企业微信智能机器人接入（channel 端口插件）。协议客户端移植自生产验证过的
`wecom-bridge/src/wecom.js`（subscribe / 心跳 / 指数退避 / ack pending /
出站方法全部保留，改动清单见 `client.js` 文件头）。

## 结构

- `client.js` — WeCom 长连接客户端（注入式 WebSocket）。状态机
  `connecting|online|reconnecting|stopped`；被踢（`disconnected_event`）即停机不重连；
  鉴权失败（subscribe ack `errcode≠0`）快速失败：`stopped` + `鉴权失败(errcode)`，
  只安排封顶 5 分钟的单次重试，不进快速退避循环。
  运维注意：鉴权失败后的 5 分钟重试窗口内 `state` 仍读 `stopped`，但已静默排定一次
  重试——`stopped` 未必是终态，以 `lastError`（`鉴权失败(...)`）区分。
- `adapter.js` — channel 端口适配器：
  - 入站：`aibot_msg_callback` → 文本提取（`text`/`mixed` 文本部分；非文本、空 @
    分别用前身逐字文案回复）→ `engine.onMessage({botId, chatKey, chatKind, chatid,
    userid, text, reqId, raw})`；`chatKey` 三段式 `wecom:group:<chatid>` /
    `wecom:single:<userid>`；`enter_chat` → `engine.onChannelEvent`，引擎不处理时发默认欢迎语。
  - 出站五原语：`ack`/`progress` → `respondStream`；`reply` → `respondMarkdown`；
    `welcome` → `respondWelcome`；`push(chatRef, text)` → `sendMarkdown`（`wecom:group:*`
    → chat_type 2，`wecom:single:*` → 1；4000 字截断；每 chatid 25 条/60s 限流，超限丢弃并 warn）。
  - 限流：入站每 chatid 30 条/60s（移植 bridge `_rateOk`）。
  - 断线 final 补发（DESIGN §4）：`finish=true` 帧发送失败 → 按 chatKey 暂存（同一
    会话的新 final 覆盖旧的），客户端重连 `online` 后经 `push`（`aibot_send_msg`，
    受 25 条/60s 推送限流）best-effort 补发；**不走 `respond_stream`**——回调 `req_id`
    只在原连接的回调窗口内有效，跨连接复用未经验证（前身 `/send` 即为此而生）。
- `plugin.js` — manifest + `accountSchema`（`botId` / `secret`(password) / `wsUrl`）+
  `ctx.registerChannel('wecom', ...)`；WebSocket 由内核 `ctx.ws` 注入，插件零 npm 依赖。

## capabilities

`{ stream:true, push:true, group:true, welcome:true, maxContentChars:3500,
minIntervalMs:2200, streamDeadlineMs:600000 }` — 引擎据此节流/截断/定时限，
不硬编码企微参数。

## 测试

`test/contract/channel-wecom.test.js`：真实 `ws` 服务器（临时端口）跑
subscribe/心跳/文本提取/逐字文案/鉴权快速失败/被踢停机/final 补发/双向限流。
