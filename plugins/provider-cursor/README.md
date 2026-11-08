# provider-cursor

Cursor CLI(`agent`,原 cursor-agent)作为技能岗位的 provider 插件。复制即契约的第五家(前作
provider-dsh/claude/codex/pi);CLI 是 claude-code 同构(stream-json/`--resume`/result 判据)。

> **状态(2026-11-08):fake 级验证完成(契约 11/11+单测 16/16),真 CLI 验证待登录**——
> `agent login` 是唯一前置(owner 暂缓);登录后跑 probe.sh 基线校准 fake/runner/history 的
> 真实形状。底稿见 docs/PROVIDER-RESEARCH.md §3.6。

## 驱动方式

```
agent -p --output-format stream-json [-f] [--model <id>] [--mode plan|ask] [--resume <id>] [cursorArgs…]
```

- prompt 走 stdin;`-f` 默认开(机器人无人值守需要;`force:false` 可关)。
- **认证:CLI 自己的登录态(`agent login`,login 入口保留)或 `CURSOR_API_KEY`**。
  ⚠️ 编辑器 token 不可移植(实测:api.cursor.com 拒绝 type=session 的编辑器 JWT,凭证域分离);
  ⚠️ 无 base URL 覆盖——**不能走 magpie**,用量走 Cursor 账号订阅池(编辑器/CLI 共享)。
- cursorHome → `$CURSOR_CONFIG_DIR`+`$CURSOR_DATA_DIR`(bundle 实证),会话在
  `<cursorHome>/projects/**` 下,history.js 有界遍历读取(容错三件套)。
- 工作区信任:新 cwd 首跑会弹 Workspace Trust——无人值守场景需 `--trust`(cursorArgs 透传)。

## providerConfig 一览(与 configSchema 同步)

| 键 | 说明 |
|---|---|
| `cwd`(必填) | 作业目录;首跑触发 Workspace Trust(建议 cursorArgs 加 `--trust`) |
| `model` | `{model?, apiKey?, apiKeyEnv?}`;不填 model 用账号默认;apiKey 走 CURSOR_API_KEY,不填用登录态 |
| `mode` | agent(默认)/plan/ask |
| `force` | 免确认执行工具(默认 true) |
| `cursorArgs` | 额外参数(垫尾,variadic 安全序) |
| `apiKeyEnv` | 凭证 env 名(默认 CURSOR_API_KEY) |
| `cursorBin` | 可执行文件(默认 `agent`) |
| `cursorHome` | 配置目录重定向(默认 ~/.cursor;多 bot 共用同一登录态) |
| `env` | 注入子进程的环境变量 |
| `progressStyle`/`progressText` | 播报(与其他家同参) |
