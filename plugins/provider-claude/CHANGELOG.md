# Changelog

本插件版本史（Keep a Changelog 1.1 格式；版本号与 `manifest.version` 同步）。

## [Unreleased]

### Added

- 资产面（W3 T2，§3.3 claude 列）：`materializeAssets` 纯计划钩子——skills→
  `$CLAUDE_CONFIG_DIR/skills`（V1 实证重定向装载）/回退 `<cwd>/.claude/skills`；memory→CLAUDE.md
  标记节；mcp→`data/assets/<botId>/claude-mcp.json` 单文件 owned 0600（`${VAR}` 引用透传，V8 实证
  claude spawn 时展开、缺变量=字面量）+ runner `--mcp-config`（V7 实证旗标覆盖用户 scope 同名，
  且 variadic 故置 argv 末位）；prompt/ripgrep→`--append-system-prompt` 拼接（bot prompt 在前）；
  rtk 绑定面落地（未装=unavailable 注记，hook 写面待 T3 实证）。
## [0.1.0] - 2026-11-06

初始发布。

### Added

- claude runner 与历史读取：真实会话历史工件入库，完整通过 provider 契约。

### Fixed

- claudeConfigDir 以 env 注入子进程，隔离宿主配置；超时上限提升（M2 终审跟进）。
