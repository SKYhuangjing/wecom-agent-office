# Changelog

本插件版本史（Keep a Changelog 1.1 格式；版本号与 `manifest.version` 同步）。

## [Unreleased]

### Added

- 资产面（W3 T2，§3.3 pi 列）：`materializeAssets` 纯计划钩子——skill→`<agentDir>/skills/` + runner
  `--skill`；memory→`wao-memory.md` + runner 读文件拼文本传参（设计 V3 回退形态，不依赖文件旗标）；
  prompt/ripgrep→`--append-system-prompt`（F19 可重复）；mcp→`<agentDir>/mcp.json` 整文件重写 0600，
  `x-wao-managed` 注记（V9 实证 pi 容忍未知顶层键且自身重写保留），自定义 piAgentDir 外来文件拒写。
## [0.1.0] - 2026-11-07

初始发布：第四家 provider（pi coding agent，`@earendil-works/pi-coding-agent` 1.5.0）。

### Added

- `pi -p --mode json` 驱动 + `--session <partial-uuid>` 续接；prompt 走 stdin。
- 成功判据 = exit 0 且流内最后 assistant `stopReason==='stop'`（pi 模型失败仍 exit 0，实测勘误）。
- per-bot models.json 物化（`$PI_CODING_AGENT_DIR`，apiKey 只写 `$变量名`，无密钥落盘；
  DELETE 只清 models.json、sessions/ 档案保留）。
- history.js 只读解析 `<piAgentDir>/sessions/<cwdSlug>/*.jsonl`（容错三件套：缺/坏/大=警告不 throw）。
- 契约 11/11 零跳过（fake-pi）；真 CLI 基线 `test/probe-baselines/pi*.ndjson`（resume 三腿 +
  history roundtrip，经 magpie 网关）。

### 事实勘误（实测）

- pi 模型全败时 exit 0——错误文本只在 `auto_retry_end.finalError`。
- `--model` 带斜杠 id 必须配 `--provider`，否则被解析成 provider/model。
- magpie 对 localhost 不校验 caller key（missing-credential 不可真机触发）。
