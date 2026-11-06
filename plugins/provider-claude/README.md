# provider-claude（Claude Provider）

M2 交付的第二个**真实** provider 插件：通过 `claude -p --output-format
stream-json --verbose` 子进程驱动 claude code（prompt 走 stdin），兑现
DESIGN §5 端口契约。进程语义（spawn/NDJSON/SIGTERM→SIGKILL 升级/abort
带部分输出）复制自已过全量契约的 provider-dsh（复制即契约），差异仅在
CLI 调用与事件解析。

## 结构

| 文件 | 职责 |
|---|---|
| `plugin.js` | 端口注册：manifest / configSchema / validate / materializeConfig（→null）/ describeError |
| `runner.js` | 子进程驱动：spawn argv、stream-json→统一事件、code 映射、kill 升级 |
| `history.js` | 会话历史只读：`~/.claude/projects/<slug(realpath cwd)>/<sessionId>.jsonl` 解析（`{turns, truncated, warnings}`） |

## 要点（实测事实来自 M2-T1 probe 基线，claude 2.1.318）

- **调用形状**：`claude -p --output-format stream-json --verbose [--model M]
  [--permission-mode P] [--allowedTools a,b] [--resume <id>]
  [--append-system-prompt <人设>]`，cwd=providerConfig.cwd，prompt 整段写
  stdin（`-p` 无位置参数时读 stdin——已实测）。
- **事件映射**：`system/init.session_id`→session；assistant 的 content 块
  text→text、thinking→thinking（载荷在 `.thinking`，无 `.text`）、
  tool_use→tool（brief 用前身 describeTool 启发式）；`system/thinking_tokens`
  计数噪声静默丢弃。
- **成功判据**：exit 0 且 `result.subtype==='success'`（`is_error!==true`）；
  最终文本以 result 事件的 `.result` 为准。错误 subtype（如
  `error_during_execution`）→ code=error（消息在 `.result`）。
- **网关路由**（M2 评审事实）：`model.baseURL`→`ANTHROPIC_BASE_URL`、
  `model.apiKey`→`ANTHROPIC_AUTH_TOKEN`（或 `model.apiKeyEnv`）；
  `providerConfig.env` 显式值优先。
- **code 映射**：abort→`aborted`；超时→`timeout`；stderr/error 命中锁冲突
  模式→`lock-conflict`（**真实冲突文案 M3 前未知**，正则为合理猜测+通用
  兜底）；`ANTHROPIC_API_KEY|invalid api key|authentication`→
  `missing-credential`。
- **sessionId 契约**（与 dsh 同构）：init/`result` 回显 id；resume 未回显→
  原样返回输入 id；**首 session 事件前被 abort/超时→返回 null**。
- **历史路径**：`<claudeConfigDir>/projects/<slug(realpath(cwd))>/
  <sessionId>.jsonl`（slug=非字母数字全部转 `-`；macOS 上 /tmp 会落在
  `-private-tmp-…`——claude 先解析 realpath）；`providerConfig.
  claudeConfigDir` / `$CLAUDE_CONFIG_DIR` 可重定向。

## 验证

```bash
node --test 'test/provider/claude-*.test.js'      # 单元格（fake-claude 注入）
node test/contract/run.js --plugin plugins/provider-claude   # 契约套件：应全绿
```
