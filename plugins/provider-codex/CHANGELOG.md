# Changelog

本插件版本史（Keep a Changelog 1.1 格式；版本号与 `manifest.version` 同步）。

## [Unreleased]

### Added

- rtk 计划面 + ripgrep 预检（W3 T3，§7.1/§7.2）：rtk→`{kind:'rtk-init', flavor:'codex',
  target:$CODEX_HOME}`（V5 实证尊重重定向；codex hook 面=hooks.json 独立文件，非 config.toml）；
  ripgrep→预检（tools 行 + 缺失 note，预检不失败）。
- 资产面（W3 T2，§3.3 codex 列）：`materializeAssets` 纯计划钩子——skills→`$CODEX_HOME/skills`
  （V2 实证重定向发现）/回退 `<cwd>/.agents/skills`；prompt/memory/ripgrep→AGENTS.md 标记节分节
  （V2 实证 `<CODEX_HOME>/AGENTS.md` 被读）；mcp→config.toml 标记节（server 名 `wao-` 前缀+引号键，
  stdio env 字面量/env `${VAR}` 引用拆 `env_vars` 转发白名单（V8 实证），http headers 引用→
  `env_http_headers`）；rtk=unavailable 注记（hook 待 T3）。
## [0.1.0] - 2026-11-06

初始发布。

### Added

- codex runner 与历史读取：全事件集解析，完整通过 provider 契约。

### Fixed

- 超时上限提升（M2 终审跟进）。
