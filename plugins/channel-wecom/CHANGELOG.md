# Changelog

本插件版本史（Keep a Changelog 1.1 格式；版本号与 `manifest.version` 同步）。

## [Unreleased]

### Added — 多模态输入面（DESIGN-MULTIMODAL Phase 0-2，2026-11-10）

- `media.js`（§2.2/§4.2）：企微回传媒体「url+aeskey」收到即下载（10s 超时、
  24MB 密文上限）→ AES-256-CBC 解密（key=Base64 解码、IV=key 前 16 字节、
  32 字节块 PKCS#7 手工去填——Node 默认 16 字节 autopad 会 bad decrypt，与官方
  SDK src/crypto.ts 同构）→ `data/media/<botId>/<yyyymm>/<sha256>.<ext>`
  （ext 由 magic bytes 定、后缀/回传字段不采信；filename 仅清洗后作展示）；
  图片 ≤4MB/文件 ≤20MB 婉拒、per-bot 200MB 配额 LRU、启动清 7 天旧件
  （plugin activate 时 `sweepAll`）。
- adapter 附件信封：单聊 image/file 与 mixed 图文 → `attachments` 数组送引擎
  （`engine.botFeatures()` 提供 visionSupported/vision 放行）；下载/解密失败逐项
  记 `attachmentFailures`，纯图全失败按文案矩阵直接婉拒（下载失败/过大/格式），
  图文 mixed 文字照走 + 失败注记随信封。`extractText` 增 voice 分支
  （`voice.content` 识别文本直入 text 路径，空识别仍走空@文案）。
- DECLINE 文案分级：引擎不支持（dsh）/未开视觉（引导开启）/下载失败请重发/
  过大请压缩/格式不支持；video 等无媒体项且无文本的类型使用重写后的统一婉拒
  文案（「视频等类型还不支持」——原移植期「只支持文字」说法随多模态落地作废）。

### Fixed

- 流式回复改为每帧独立 ack 槽位（同一回调 req_id 的多帧 FIFO 逐帧结算），消除每轮一条的伪「ack timeout」告警；非终帧超时降为 debug，终帧保留 warn+补发队列。

## [0.1.0] - 2026-11-06

初始发布（自 wecom-bridge 生产验证逻辑移植）。

### Added

- 企微智能机器人长连接客户端：可注入 WebSocket、可观测状态机（connecting/online/reconnecting/stopped）、凭证错误快速失败（封顶 5 分钟单次重试）与被踢即停语义。
- 五原语适配器 ack/progress/reply/welcome/push：入站限速 30/min、push 限速 25/60s 与 4000 字截断（生产语义原样移植）。
- 断线终帧补发：丢失的 finish 帧按 chatKey 经 aibot_send_msg 重放，stop 时丢弃并留痕。

### Fixed

- 终帧补发改走 push 而非跨连接复用旧 req_id（DESIGN §4）；stop 时清理待补发队列。
