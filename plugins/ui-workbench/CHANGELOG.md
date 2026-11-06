# Changelog

本插件版本史（Keep a Changelog 1.1 格式；版本号与 `manifest.version` 同步）。

## [0.1.0] - 2026-11-06

初始发布。

### Added

- 工作台列表页与 bots CRUD：schema 驱动动态表单（消费 /api/state 的端口 schema）。
- 会话查看器、主动推送面板、插件管理页 + timeline/run/ledger SSE 实时事件。
- harness 截图基线（21 张）供回归对照。

### Fixed

- PATCH 深合并保留被剥离的嵌套只写字段；切回草稿重置初始化。
- 盲评 P2：人性化告警文案、名称长度上限、断连反馈、provider 缺失信号、timeline 注记。
- 密钥回显脱敏、SSE 防抖、Safari 兼容（已知边界波）。
