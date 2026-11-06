# Changelog

本插件版本史（Keep a Changelog 1.1 格式；版本号与 `manifest.version` 同步）。

## [0.1.0] - 2026-11-06

初始发布。

### Added

- claude runner 与历史读取：真实会话历史工件入库，完整通过 provider 契约。

### Fixed

- claudeConfigDir 以 env 注入子进程，隔离宿主配置；超时上限提升（M2 终审跟进）。
