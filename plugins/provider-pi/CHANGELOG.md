# Changelog

本插件版本史（Keep a Changelog 1.1 格式；版本号与 `manifest.version` 同步）。

## [Unreleased]

### Added — 图片附件扇出（DESIGN-MULTIMODAL Phase 2，2026-11-10）

- run 签名增 `attachments`：图片条目以 `@<path>` 位置参数追加 argv 尾部
  （print 模式实证可用，`pi --help` usage 行 `[@files...]`；RPC 模式拒 @file
  ——WAO 是 print 模式无碍）。configSchema 增 `visionInput`（默认关）+
  `features: { vision: true }` 能力声明。真模型看图端到端未验证（fake 契约
  `test/provider/attachment-fanout.test.js` 锁 argv 形状）。

### Added

- rtk 计划面 + ripgrep 预检（W3 T3，§7.1/§7.2）：rtk→`{kind:'rtk-init', flavor:'pi',
  target:agentDir}`（自定义或 WAO 默认目录——pi 装备面本就是 per-bot 命名空间；V5 实证
  `--agent pi` 尊重 PI_CODING_AGENT_DIR）；ripgrep 预检同他款（tools 行 + 缺失 note，预检不失败）。
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
