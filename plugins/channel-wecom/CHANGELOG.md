# Changelog

本插件版本史（Keep a Changelog 1.1 格式；版本号与 `manifest.version` 同步）。

## [Unreleased]

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
