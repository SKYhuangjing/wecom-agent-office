# Changelog

本插件版本史（Keep a Changelog 1.1 格式；版本号与 `manifest.version` 同步）。

## [Unreleased]

### Added

- `companyOps` 服务（W1 T2）：api.js 各路由的业务核心抽为同文件 `*Op` 函数并经
  `companyOps(state)` 发布到 services 容器（含 `sanitize` 与只读 `botDetail` 聚合），供
  mcp-gateway 插件按次取用——REST 与 MCP 工具共用同一函数源，HTTP 行为零变化。
- 拟人播报（`progressStyle`，2026-11-06 owner 决策默认翻转）：企微进度行默认只播报一句
  「{bot} 思考中… 请稍等（已 N 秒）」（呼吸点按出帧序 . → .. → ... 循环），不再出现任何
  思维链/工具参数/正文预览内容；心跳帧同模板。`progressText` 可配文案（占位符
  `{bot}/{dots}/{elapsed}/{step}`，≤120 字超长 400）。`progressStyle:'cot'` 保留旧 §6.1
  详细汇报；`progressCoT` 降级为废弃兼容别名（仅 cot 风格内抑制 💭，不再能翻回详细汇报）。
  timeline（本地工作日志）照旧收全量 thinking/tool 事件——仅收窄企微出站面。

### Fixed

- W1 T2 `*Op` 重构的两处错误优先级回归（终审 Important）：`GET /api/timeline` 未知 bot +
  坏 window 组合回到 404 bot 优先（bot 存在性预检查回到 window 解析前，镜像 patchBotHandler）；
  `POST /api/bots/:id/test` provider 端口不可用 + 坏 JSON body 组合回到 400 provider
  unavailable 优先（端口预检查回到 body 解析前）。「HTTP 行为零变化」的承诺在这两个组合上
  恢复成立（plugin.test.js 锁定组合序）。

## [0.1.0] - 2026-11-06

初始发布。

### Added

- 台账 + 会话缓存：consumedSeq 规约保证跨 provider 交接正确性（反例 A/B 以测试锁定），撕裂台账尾封口后重算。
- timeline 环形缓冲：轮次事件留痕供 UI 时间线消费（run/ledger SSE emit）。
- 语义化进度器：思维链分句上屏（滞回 + 上行脱敏掩码）。
- 按 chatKey 串行链：队列合并、latest-wins 抢占结算、两阶段 10 分钟截止的轮次编排。
- 插件装配与 bots 注册表：业务 API 与插件 reconcile、facade/progressCoT/validate/enter_chat 接线义务。
- removeConfig provider 钩子：DELETE /api/bots 一并清理落盘的 dsh profile。

### Fixed

- allowedUsers 强制校验、provider 切回持久化、per-bot drain（拒绝后如实回答）、data 目录 0600、四阶段关停韧性。
- claudeConfigDir env 注入、超时上限提升、文档/schema 对齐（M2 终审跟进）。
- 脱敏密钥回显、SSE 防抖、shell 错误呈现、计时窗口、Safari 兼容审计（已知边界波）。
