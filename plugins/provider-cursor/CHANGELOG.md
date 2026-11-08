# Changelog

本插件版本史（Keep a Changelog 1.1 格式；版本号与 `manifest.version` 同步）。

## [0.1.0] - 2026-11-08

初始发布：第五家 provider（Cursor CLI `agent`，claude-code 同构）。**fake 级验证完成；
真 CLI 验证待 `agent login`（owner 暂缓），登录后以 probe.sh 基线校准事件/会话形状。**

### Added

- `agent -p --output-format stream-json -f` 驱动 + `--resume <id>` 续接;prompt 走 stdin。
- 凭证:CLI 登录态(入口保留)或 CURSOR_API_KEY env 注入;cursorHome 双 env 重定向
  (CURSOR_CONFIG_DIR/CURSOR_DATA_DIR,bundle 实证)。
- history.js:`<cursorHome>/projects/**` 有界遍历读取(容错:缺/坏/大=警告不 throw)。
- 契约 11/11 零跳过(fake-cursor)+ 单测 16 项;切换矩阵五家扩腿(S2/S1-cursor+S5 case)。

### 事实勘误(实测)

- 编辑器 token(cursor-safe-storage 信封)解密后为 type=session JWT,**api.cursor.com 拒绝**——
  编辑器与 CLI/API 凭证域分离,不可移植。
- CLI 无 base URL 覆盖(论坛确认)→ 无 magpie 路;用量走 Cursor 账号共享订阅池。
- 真 API 域名 = api.cursor.com / api2.cursor.sh(api2.cursor.com 等老域 NXDOMAIN)。
- 新 cwd 首跑弹 Workspace Trust,无人值守需 `--trust`。
