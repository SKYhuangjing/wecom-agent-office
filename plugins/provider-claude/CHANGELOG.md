# Changelog

本插件版本史（Keep a Changelog 1.1 格式；版本号与 `manifest.version` 同步）。

## [Unreleased]

### Added

- rtk 计划面 + ripgrep 预检（W3 T3，§7.1/§7.2）：rtk→`{kind:'rtk-init', flavor:'claude',
  target:$CLAUDE_CONFIG_DIR}`（V5 实证 rtk 1.1.0 尊重重定向；无 claudeConfigDir 的 bot 绑定面已拒）；
  ripgrep→预检（rg spawn 3s 探测，结论进计划返回值 `tools`，缺失=note 指引安装，预检不失败）。
- 资产面（W3 T2，§3.3 claude 列）：`materializeAssets` 纯计划钩子——skills→
  `$CLAUDE_CONFIG_DIR/skills`（V1 实证重定向装载）/回退 `<cwd>/.claude/skills`；memory→CLAUDE.md
  标记节；mcp→`data/assets/<botId>/claude-mcp.json` 单文件 owned 0600（`${VAR}` 引用透传，V8 实证
  claude spawn 时展开、缺变量=字面量）+ runner `--mcp-config`（V7 实证旗标覆盖用户 scope 同名，
  且 variadic 故置 argv 末位）；prompt/ripgrep→`--append-system-prompt` 拼接（bot prompt 在前）；
  rtk 绑定面落地（未装=unavailable 注记，hook 写面待 T3 实证）。

### Fixed

- result 事件的 usage（snake_case 原样）转发为统一 `usage` 事件——引擎 cost-tracker 累计器能读到
  claude 岗位的真实 token 数（此前岗位显示 0）；单测已钉住 ok 模式的 emit（observability wave）。

## [0.1.0] - 2026-11-06

初始发布。

### Added

- claude runner 与历史读取：真实会话历史工件入库，完整通过 provider 契约。

### Fixed

- claudeConfigDir 以 env 注入子进程，隔离宿主配置；超时上限提升（M2 终审跟进）。
