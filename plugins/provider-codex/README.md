# provider-codex（Codex Provider）

M2 交付的第三个**真实** provider 插件：通过 `codex exec --json
--skip-git-repo-check -` 子进程驱动 codex-cli（prompt 走 stdin），兑现
DESIGN §5 端口契约。进程语义（spawn/NDJSON/SIGTERM→SIGKILL 升级/abort
带部分输出）复制自已过全量契约的 provider-dsh / provider-claude（复制即
契约），差异仅在 CLI 调用与事件解析。

## 结构

| 文件 | 职责 |
|---|---|
| `plugin.js` | 端口注册：manifest / configSchema / validate / materializeConfig（→null）/ describeError |
| `runner.js` | 子进程驱动：spawn argv（exec / exec resume 子命令）、JSONL→统一事件（全事件集）、code 映射、kill 升级 |
| `history.js` | 会话历史只读：`~/.codex/sessions/<YYYY/MM/DD>/rollout-*<sessionId>.jsonl` 解析（`{turns, truncated, warnings}`） |

## 要点（实测事实来自 probe 基线 + 2026-11-06 现场核查，codex-cli 0.166.0）

- **调用形状**：新会话 `codex exec --json --skip-git-repo-check -`；续接是
  **子命令**形式 `codex exec resume <id> --json --skip-git-repo-check -`
  （id 是 resume 的位置参数；两腿都走 stdin——baseline leg2/leg3 实测，
  resume 会重发 `thread.started` 且 thread_id 相同）。
- **flags**：`-m <model>` 两腿通用；`-s <sandbox>` **仅新会话腿**——
  resume 子命令不认 `-s`（实测 `error: unexpected argument '-s' found`），
  续接腿自动改传 `-c sandbox_mode="…"`（strict-config 验证过的合法键；
  静默丢弃会让续接轮跑在不同沙箱策略下）。省略 sandbox 时不传 flag，
  保持 codex 自身配置默认。
- **`-c` 覆盖**：configOverrides 每项 `key=value` 逐项传 `-c`；codex 把
  值按 TOML 解析（失败则回退裸字符串），字符串值自动加 TOML 引号
  （`-c model="o3"` 是 help 自带示例），已是 TOML 形（布尔/数字/数组/
  对象）的值原样透传。
- **全事件集映射**（0.166.0 `exec --json`，漏映射=进度与 timeline 整条
  丢失）：`thread.started{thread_id}`→session；item.completed 里
  `reasoning`→thinking、`agent_message`→text（最终文本=最后一条）、
  `command_execution`→tool{name:Bash, brief:command}、`file_change`→
  tool{name:文件修改, brief:changes 路径摘要}、`mcp_tool_call`→
  tool{name:server/tool}、`web_search`→tool{name:WebSearch, brief:query}、
  `todo_list`→tool{name:计划}（**0.166.0 无 `plan_update` 拼写**，计划
  item 实为 `todo_list`；runner 对 `plan_update` 做了对冲映射）；
  `turn.failed{error.message}`/顶层 `error`/item 型 `error`→记入 error。
- **成功判据**：exit 0 且 `turn.completed`（实测）。
- **网关路由**（M2 评审事实）：`-c openai_base_url=…`（经
  configOverrides）+ 凭证 env `CODEX_API_KEY`（apiKeyEnv 可改名）；
  **不存在 OPENAI_BASE_URL**。`codexHome` 注入 `$CODEX_HOME`。
- **code 映射**：abort→`aborted`；超时→`timeout`；stderr/error 命中锁
  冲突模式→`lock-conflict`（**真实冲突文案 M3 前未知**，正则为合理猜测
  +通用兜底+IsolationError 对冲）；`CODEX_API_KEY|unauthorized|invalid
  api key`→`missing-credential`。
- **sessionId 契约**（与 dsh/claude 同构）：thread.started 回显 id；
  resume 未回显→原样返回输入 id；**首 session 事件前被 abort/超时→
  返回 null**。
- **历史路径**：`<codexHome>/sessions/<YYYY/MM/DD>/rollout-<ts>-<threadId>
  .jsonl`（行形 `{timestamp,ordinal,type,payload}`，user/assistant 的
  `response_item/message` 对→turns，首条 user 里的 harness 注入块
  `# AGENTS.md`/`<environment_context>` 等被过滤）；`providerConfig.
  codexHome` / `$CODEX_HOME` 可重定向。

## 验证

```bash
node --test 'test/provider/codex-*.test.js'      # 单元格（fake-codex 注入）
node test/contract/run.js --plugin plugins/provider-codex   # 契约套件：应全绿
```
