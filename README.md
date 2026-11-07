# wecom-agent-office (wao) — 企微智能机器人办公室：微内核 + 插件（M3 交接版 · 生产就绪）

> 前身：`wecom-bridge`（单 bot 数据面）+ `wecom-bots`（管理面板）。本仓库是重写：
> **微内核 + 插件体系**，一切业务（引擎/企微通道/Agent provider/UI）皆插件。
> M1 交付内核 + core-engine + channel-wecom + provider-dsh；M2 交付 provider-claude/codex
> （三家切换矩阵全绿）；M3 交付 Web UI（工作台六页 + 办公室 3D，21 张截图基线）+
> 无人值守运维（launchd）。**生产切换 runbook：`docs/CUTOVER.md`**。

---

## 1. 五分钟理解

```
终端: node src/index.js start            (127.0.0.1:8792, 独占 data/ 目录锁)
┌────────────────────────────────────────────────────────────────┐
│ src/kernel/  微内核(零业务, ≤800行预算): 装载/服务容器/事件总线/  │
│              生命周期(四阶段 reload)/HTTP 壳/配置·锁·原子写      │
├────────────────────────────────────────────────────────────────┤
│ plugins/     一切业务皆插件 (plugins.json 可禁用, 热重载)        │
│  core-engine    串行链/抢占/两阶段流式/台账 ledger/会话缓存/     │
│                 timeline/语义进度；owns bots.json；注册 /api/*   │
│  channel-wecom  企微长连接(单bot单连接)/流式回复/主动推送        │
│  provider-dsh   每消息一个 dsh 子进程；per-bot profile 物化      │
│  provider-claude  claude -p stream-json；--resume 续同一会话     │
│  provider-codex  codex exec --json；resume 子命令续同 thread     │
│  provider-pi    pi -p --mode json；--session 续同一会话          │
│  _template      channel/provider/page 三套可复制脚手架          │
├────────────────────────────────────────────────────────────────┤
│ 一个 bot = channel × provider                                   │
│   {id,name,enabled, channel:'wecom', account:{botId,secret},    │
│    provider:'dsh', providerConfig:{cwd,profile?,model?,...}}    │
│ chatKey 三段式: <channel>:<group|single>:<id> —— 跨通道统一寻址 │
└────────────────────────────────────────────────────────────────┘
```

- 消息流：企微回调 → channel-wecom adapter → engine 串行链（抢占/队列合并/出站预算）
  → provider runner（`dsh --json -` 子进程，NDJSON → 统一事件）→ 流式回传企微。
- 资产（W3）：技能/记忆/提示词/MCP/工具五类资产（`data/assets.json` 注册表 + per-bot 绑定），
  物化到 bot 声明目录（标记节/独立文件/JSON 条目型，卸载精确回收）；工具类 rtk（PreToolUse hook
  输出裁剪，真机实测省 ~18% tool 输出）与 ripgrep（指引段注入 + 环境预检）——见 docs/DESIGN-ASSETS.md。
- 会话延续：chatKey → sessionId 缓存（`data/sessions/`），下一条消息带 `--session-id` 续跑。
- 停机 = SIGINT/SIGTERM 触发四阶段（drain 补终帧 → 逆序拆插件 → 关监听 → 孤儿扫尾 → 释放锁），不是裸 kill；
  每阶段在日志留一行（`wao: stopping (four-phase)` … `wao: stopped (lock released)`），见 `data/logs/wao.log`。

四家 provider 一览（同一 runner 契约：run 7 字段 / code 枚举 / readHistory 三件套）：

| provider | 驱动方式 | 续接机制 | 副产物 |
|---|---|---|---|
| `dsh` | `dsh --json -` 子进程 | `--session-id` 同会话续跑 | per-bot profile 物化（`~/.dsh/profiles/<profile>/`，DELETE 随 bot 清理） |
| `claude` | `claude -p --output-format stream-json --verbose` | `--resume <id>` 续同一 session（init 回显同 id） | 无（materializeConfig=null） |
| `codex` | `codex exec --json --skip-git-repo-check -` | `exec resume <id>` 子命令续同 thread（全事件集：todo_list/文件修改/MCP/web_search…） | 无（materializeConfig=null） |
| `pi` | `pi -p --mode json`（prompt 走 stdin；⚠️ 模型失败时 pi 仍 exit 0——成功判定看流内 stopReason） | `--session <id>` 续同一 session（首事件回显同 id，partial uuid 可用） | per-bot models.json 物化（`~/.pi/agent-wao-<botId>/`，声明网关+`$ENV` 凭证引用，无密钥落盘；DELETE 只清 models.json，sessions/ 档案保留） |

## 2. 快速开始

```sh
npm install          # 仅一个依赖: ws
node src/index.js doctor    # 自检: node≥20.10/ws/插件扫描/数据目录可写/端口/CLI在位(dsh·claude·codex·pi)/锁探测
node src/index.js start     # 前台常驻; --port N --host H --data-dir DIR
node src/index.js version   # → 0.1.0   (拼错命令会被拒绝, 不会猜)
```

| 环境变量 | 作用 | 默认 |
|---|---|---|
| `WAO_HOME` | 数据目录（bots.json/ledger/sessions/logs） | `./data` |
| `WAO_PLUGINS_PATH` | 额外插件目录（冒号分隔，追加在仓库 plugins/ 之后） | 无 |
| `WAO_LOG_LEVEL` | 日志级别 | `info` |

端口默认 **8792**；端口被占或 data 目录被锁 = 第二实例，拒绝启动（不共享数据目录）。
`WAO_TOKEN` 鉴权 P2 预留——当前回环无鉴权，本机任意进程可控制（诚实边界，见 DESIGN §13）。

## 3. 自检与运维

```sh
curl -s localhost:8792/healthz     # 活性 + uptime
curl -s localhost:8792/api/state   # 内核视角: 插件列表(active/failed/disabled)
curl -s localhost:8792/api/plugins # 同上(纯插件表)
curl -s localhost:8792/api/agents  # 每 bot: status/progress/todayTurns/连接态/offline 原因
bash test/probe.sh --check         # dsh/claude/codex 事件序列 vs 已存基线(漂移→diff+exit 1)
```

**`wao tui`——终端运维仪表盘**（在服务所在机器上跑，`--port/--data-dir` 同 `wao start`）：
2s 轮询 `/api/agents` + 尾随 `data/logs/wao.log`（非本机则明说「日志需本机」），把上面这排
curl 大多变成按键。断连显示红条并保留最后名册、每 2s 自动重试；写操作全部走确认行，广播
（真实发送到企微）有第二道确认；与 Web 控制台走同一 API 面。零依赖（node 自带 readline +
ANSI），`q`/Ctrl-C 完整还原终端。终端帧样例：`test/tui/shots/`（ascii 存档）；全键位 pty
验收：`bash test/tui/accept-keys.sh`。

| 键 | 作用 |
|---|---|
| `↑↓` / 空格 | 选员工 / 调休·返岗确认（y 执行 n 取消） |
| `t` | 岗前测试（默认探针「回复：收到」，结果窗 ↑↓ 滚动、esc 关闭） |
| `b` | 广播：从台账选目标会话 → 输入内容 → y 二次确认 → `POST /api/send` |
| `l` | 日志窗 5 行 ↔ 半屏切换 |
| `n` | 简版入职向导（姓名→岗位→cwd→botId→Secret→摘要 y，落库 `enabled:false` 调休态） |
| `e` | 打开 Web 控制台（失败降级为可复制 URL 的通知行） |
| `q` / Ctrl-C | 退出（还原终端） |

常用操作（回环 HTTP，POST 为主）：

```sh
# 建 bot (enabled:false 只存配置不连企微 —— M3 切换的推荐姿势)
curl -X POST localhost:8792/api/bots -H 'content-type: application/json' -d '{...bot 记录...}'
curl -s localhost:8792/api/bots       # 完整 bot 记录表(UI 编辑器用; secret 仍不回显)
curl -s localhost:8792/api/ports      # channel/provider 清单 + 各自 accountSchema/configSchema(UI 动态表单用)
curl -X POST localhost:8792/api/bots/<id>/test    # 真跑该 bot 的 provider(不进引擎链/不记台账); 可选 body {sessionId?, prompt?}: sessionId 续跑该会话, prompt 自定义提问(1..2000 字符, 缺省"回复：收到")
curl -X POST localhost:8792/api/bots/<id>/toggle  # 上/下线
curl -X PATCH localhost:8792/api/bots/<id> -d '{...}'   # 改配置(last-good: 失败保留旧配置; schema 声明的 password 字段缺省/空串=保留已存值——UI 编辑器不回显 secret 的配套语义)
curl -X DELETE localhost:8792/api/bots/<id>       # 删除(连同 provider-dsh 物化的 profile)
curl -X POST localhost:8792/api/service/reload    # 四阶段热重载(升级插件后)
curl -X POST localhost:8792/api/plugins/<id>/disable|enable   # 禁/启用某插件(走同一 reload)
```

响应**永不回显 secret**（API 层递归清洗；`secret` 键与 `*apikey*` 名样键任意深度都会剥——
连带 `model.apiKeyEnv` 这类环境变量**名**也会剥，PATCH 端用「保留式回填」配平：请求里缺的键
回填已存值，显式提供的键覆盖）。`env` / `model` 这类 object 型自由文本字段值无法逐键甄别，
回显做**敏感值掩码**（2026-11-06 边界收口波）：键名命中 `secret|token|password|apikey|api_key`
（不区分大小写）的**字符串值**在 GET /api/bots 等回显里显示为 `__MASKED__`（仅回显，磁盘与
运行时不动）；PATCH 把 `__MASKED__` 原样送回=「未修改」（自动回填已存真值），显式填新值才替换。
残留面：**list 型字段不掩码**（如 codex `configOverrides` 的 `key=value` 行、pi `piArgs`）——凭证仍请走
`apiKeyEnv`（只存变量名），不要把 secret 字面量写进任何配置块。

> dsh bot 的 profile 物化是**即时**的：创建/修改 dsh bot 就把 profile 写到
> `~/.dsh/profiles/<profile>/`（即使 bot 停用）；`DELETE /api/bots/<id>` 会清理该目录。
> pi bot 同理即时物化 models.json 到 `~/.pi/agent-wao-<botId>/`（文件只含 `$变量名`
> 引用不含密钥）；`DELETE` 只删 models.json，`sessions/` 会话档案保留（离职留档）。

### 3.1 无人值守运维（launchd）

模板在 `docs/launchd.plist`（Label `com.wecom-agent-office`，KeepAlive+RunAtLoad+ProcessType
Background；头部注释即安装三步）。安装（生产切换 T9 执行，平时调试装完记得卸）：

```sh
cp docs/launchd.plist ~/Library/LaunchAgents/com.wecom-agent-office.plist
# 编辑三处占位：REPO_DIR（仓库绝对路径）/ DATA_DIR（数据目录绝对路径）/
#   NODE_BIN、NODE_DIR（`which node` 及其 bin 目录——launchd 不跑 nvm 初始化）
# ⚠ 占位符无尖括号：sed/手工替换按 token 名匹配，勿带 <>（首装踩过：带 <> sed 未中，静默失败）
mkdir -p <DATA_DIR>/logs
launchctl load ~/Library/LaunchAgents/com.wecom-agent-office.plist
curl -s localhost:8792/healthz          # 确认起来
```

**升级路径裁定（控制器 2026-11-06）——进程重启 vs reload 的定位**：

| 场景 | 手段 | 为什么 |
|---|---|---|
| **代码升级**（plugin.js 及其 import 的任何模块、`src/kernel/`） | `launchctl kickstart -k gui/$(id -u)/com.wecom-agent-office` | in-process reload 刷不掉 ESM 模块缓存：plugin.js 内部静态 import 的子模块（runner.js 等）reload 后仍是旧代码——已验。kickstart 走完整四阶段停机（在跑任务补终帧、孤儿扫尾）+ KeepAlive 自愈，是唯一可信的换代码路径 |
| **配置级变化**（plugins.json 启用表、新插件目录、bot CRUD） | `POST /api/service/reload` 或对应 API | 四阶段热重载足够：重扫目录/重读启用表/重建 bot 运行时，进程不停、在跑消息有维护终帧 |

冷启动自愈：KeepAlive=崩溃/被杀即拉活；机器重启→用户登录（RunAtLoad）→服务自动回来。
数据面（ledger/sessions/bots.json）全在 data/，重启无损；data 目录锁有 stale-holder 认领，
崩残留的锁不挡下一次启动。停机尾部还有**孤儿扫尾**：四阶段的有界 drain（5s×2）放弃后仍在跑的
CLI 子进程，进程退出前按 `pgrep -P <服务pid>` 枚举并 SIGKILL（日志 `stop: orphan sweep` 行），
不留占着会话写锁的孤儿。

日志三层（排障顺序从下往上）：

```sh
tail -50 <DATA_DIR>/logs/wao.log            # 运行日志：生命周期/drain/orphan sweep 全在这
tail -50 <DATA_DIR>/logs/launchd.err.log    # launchd 侧 stderr：进程崩溃类（wao.log 里看不到）
launchctl print gui/$(id -u)/com.wecom-agent-office | head -30   # launchd 视角：退出码/重启计数
```

无人值守巡检命令表（日常/远程只看这几条）：

| 命令 | 看什么 | 异常处置 |
|---|---|---|
| `curl -s localhost:8792/healthz` | `ok:true` + uptimeSec | 不通 → `kickstart -k`；反复挂 → launchd.err.log |
| `curl -s localhost:8792/api/agents` | 每 bot `idle/working` + `channelState.state=online` | `offline` 带 reason → 查 wao.log 对应 bot 段 |
| `curl -s localhost:8792/api/state` | 插件 active/failed/disabled | 出现 `failed` → 修后 `POST /api/service/reload` |
| `tail -50 <DATA_DIR>/logs/wao.log` | `wao: stopping` / `orphan sweep` / drain 超时 | 有 sweep 行=曾有 CLI 活过停机，确认无残留 |
| `node src/index.js doctor` | 全量自检（含 launchd 三态：✓运行/!未装/✗装了没跑） | 任何 ✗ 行=需要动手 |
| `launchctl list \| grep wecom-agent-office` | 首列 pid（`-`=没在跑） | `-` → kickstart -k 强拉 |

### 3.2 MCP 接入（AI Agent 直连操作公司）

`mcp-gateway` 插件（默认装载，可在 `data/plugins.json` 停用）把公司操作面以 MCP 最小子集暴露在
`POST http://127.0.0.1:8792/mcp`，claude / codex / ZCode 等 Agent CLI 可直连做巡检、入职、
调休、广播、部门启停（公司话词表见 §4.2；Agent 侧快捷 skill 见 `docs/skills/wao-company.md`）。
协议是 streamable HTTP 传输的无 SSE 半边：JSON-RPC 2.0 单请求，方法仅
`initialize` / `tools/list` / `tools/call` / `notifications/*`（含 `notifications/initialized`，
一律 HTTP 202 空体）；GET `/mcp` 答 405（SSE 推送二期）；`DELETE /mcp` 显式终结会话（幂等 202）。

- **会话生命周期**：`initialize` 响应头下发 `Mcp-Session-Id`（uuid）→ 之后每个请求必须带该头
  （响应回显同值）；缺失/未知/已终结 → JSON-RPC `-32002`。会话不过期（单用户），只有
  DELETE 与服务重启/部门重组（四阶段 reload 会重建全部插件路由）会让其失效——收到
  `-32002` 重新 `initialize` 即恢复。
- **错误分层**：协议错误＝HTTP 200 + JSON-RPC error（`-32700` 解析 / `-32600` 形状 /
  `-32601` 方法未知 / `-32602` 工具名或参数形状 / `-32603` 内部 / `-32002` 会话）；传输错误＝
  HTTP 状态码（405 / 415 非 JSON / 413 超 256KB）。**业务失败不是协议错误**：校验 400（如重复入职 `bot id already exists`）/
  查无 404 / 离线广播 409 以 `result.isError:true` + 中文原因返回（Agent 可读可转述）。
- **输出双形态**：每工具 `content[].text`（中文摘要）+ `structuredContent`（结构化数据）；
  secret 永不回显（`__MASKED__` 语义同 §3）。当前回环无鉴权（§2 边界同样适用）。

三家 CLI 配置样例（服务须先 `node src/index.js start`）：

```jsonc
// claude：存成 wao.mcp.json，工具名形如 mcp__wao-company__list_employees
{ "mcpServers": { "wao-company": { "type": "http", "url": "http://127.0.0.1:8792/mcp" } } }
```

```sh
claude --mcp-config wao.mcp.json "列出在岗员工并告诉我谁在休假"
```

```sh
# codex：一条命令写入 ~/.codex/config.toml
codex mcp add wao-company --url http://127.0.0.1:8792/mcp
```

```toml
# ~/.codex/config.toml（与上行等价的手写形态）
[mcp_servers.wao-company]
url = "http://127.0.0.1:8792/mcp"
```

```jsonc
// ZCode：工作区级 <repo>/.zcode/config.json（用户级 ~/.zcode/cli/config.json 同形）；
// 会话启动自动连接，状态在「设置 → MCP」查看。schema 严格：多余键会被静默丢弃，
// 模板变量 ${...} 不展开——写具体地址
{ "mcp": { "servers": { "wao-company": { "type": "http", "url": "http://127.0.0.1:8792/mcp" } } } }
```

裸 curl 冒烟（先握手拿会话头，再列工具/调用）：

```sh
curl -si -X POST localhost:8792/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
# → 200，响应头含 Mcp-Session-Id；随后带该头 POST tools/list、tools/call
```

13 个工具一览（细节与参数见 `plugins/mcp-gateway/README.md`；危险＝执行前须向用户复述后果确认）：

| 工具 | 一句话 | 危险 |
|---|---|---|
| `list_employees` | 在岗名册（状态/离线原因/工作汇报/工单数） | |
| `get_employee` | 单员工详情（配置摘要无 secret） | |
| `hire` | 办入职（全字段档案） | |
| `update_employee` | 档案更新（patch；密码留空＝保留） | |
| `offboard` | 办离职（删除；台账与时间线历史保留） | ⚠️ |
| `set_duty` | 调休 ↔ 返岗 | |
| `probation_test` | 岗前测试（成功判据看 result.code，勿只看 isError） | |
| `broadcast` | 广播（真实送达企微，无法撤回） | ⚠️ |
| `list_departments` | 部门（插件）清单 | |
| `department_toggle` | 部门启停（四阶段重组；重建 MCP 会话） | ⚠️ |
| `work_log` | 工作档案（台账轮次） | |
| `work_timeline` | 工作日志（时间线事件流） | |
| `company_state` | 公司状态摘要 | |

## 4. 开发（写插件）

- 脚手架：`cp -r plugins/_template/<channel|provider|page> plugins/<你的名字>/`，改三处名字
  （manifest.id / PORT_ID / package.json name），照模板内 README 三步走。**`package.json` 的
  `"type":"module"` 不可删**（Node<22.7 会按 CJS 解析而装载失败）。
- 契约文档：`docs/PLUGIN-DEV.md`（端口契约、ctx 能力、装载规则、共享代码政策=复制即契约）。
- 契约套件（provider 必跑）：
  ```sh
  npm run contract -- --plugin plugins/<你的provider>   # 11 组: 结果形状/kill升级/abort/容错/禁用零残留
  ```
- 装载验证：`node src/index.js doctor` 列出你的目录 → `start` → `/api/plugins` 看到 `active`。
- reload 四阶段：drain(在跑任务补终帧) → 逆序 teardown → 重扫激活 → afterAllActivated；
  排队串行，禁用 core 插件与普通插件同一条路径。
- 排查：`data/logs/wao.log`；坏插件不倒服务（装载失败进 `failed` 列表，可修后 reload）。

### 4.1 Web UI 开发（Shell / SDK / 页面插件 / harness 截图）

- **控制台**：`wao start` 后浏览器开 `http://127.0.0.1:8792/`——薄 Shell（导航/路由/主题）+ 页面插件。
  静态资源来自 `web/dist/`（**产物已提交**，运行与测试都不需要构建）；改 `web/src/{shell.jsx,sdk.js,styles.css}`
  或 `web/index.html` 后 `npm i && node web/build.mjs` 重建并提交 dist。
- **页面插件契约（硬性）**：无构建 ES Module、禁 JSX/bare import，React/SDK 一律从注入的
  `WAO` 取（`h/useState/useEffect/useCallback/api/useAgents/useTimeline/useSSE/avatar/avatarUrl/registerPage`）。
  manifest 声明 `ui: './ui'` → 内核托管 `/api/ui/<id>/` 并进 `/api/state.uiPlugins`。细节与
  harness 模板见 `docs/PLUGIN-DEV.md` §5.4，参照实现 `plugins/_template/page/`。
- **harness 截图（改 UI 红线：必须截图验证）**：每页面插件 `ui/harness.html` 用
  `web/harness-lib/wao-stub.js` 的假数据桩独立渲染（内核同源托管）。**UI 改动工作流
  = 改页 → 跑截图脚本 → 逐张看图（浅/深/空态/错误态）→ 图随代码一起提交**：

  ```sh
  bash test/ui-shot.sh      # 起临时内核(18798)+CDP 无头 Chrome，重产 21 张基线到 test/ui-shots/
  ```

  基线清单（提交进库，review 时对照）：ui-workbench 六页 × 浅/深（`?page=`）+
  ui-office3d iso/2d × 浅(day)/深(night)（`?dim=`/`?phase=`）+ template-page demo +
  边界四张（`?state=empty|error`：工作台与办公室的空态 / 断服 fetch 失败文案）。
  主题由 CDP `Emulation.setEmulatedMedia` 精确控制（不依赖系统外观）；任一图缺失或
  <5KB 脚本 exit 1。harness 还支持手工改 `ui/fake-data.js` 桩出更多状态后单张复现：

  ```sh
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --headless=new --disable-gpu --screenshot=/tmp/shot.png --window-size=1280,800 \
    http://127.0.0.1:8792/api/ui/<插件id>/harness.html
  ```

  单张手工截图时深色可加 `--force-dark-mode`；模板页 demo 需 `WAO_PLUGINS_PATH`
  指向 `plugins/_template`（脚本已自动带上）。

### 4.2 公司话 UI（company-metaphor 重设计）

产品比喻是「**一家你独自经营的公司**」：你雇的每位同事是一个 bot。UI 主层一律
公司话，技术词收进 tooltip / 副标题（双层语言，运维不歧义）；后果说明保持诚实
（如「转岗仅文本问答对迁移」这类事实不减，只换语气）。

**公司话 ↔ 技术词对照表**：

| 公司话 | 技术词 |
|---|---|
| 入职 / 办理入职 | 新建 bot（POST /api/bots） |
| 离职 / 办结离职手续 | 删除 bot（DELETE /api/bots/:id） |
| 调休 / 返岗 | 停用 / 启用（toggle，enabled=false/true） |
| 技能岗位 / 岗位部门（DSH·Claude·Codex·Pi 工程师） | provider（dsh / claude / codex / pi） |
| 工位 | 工作目录 cwd |
| 门禁名单 | allowedUsers |
| 工牌激活 / 工牌凭证 | 填企微机器人凭证（channel account） |
| 岗前测试 | 试跑（POST /api/bots/:id/test） |
| 工单 | 一轮对话（ledger turn） |
| 工作汇报 | 进度行（progress.line） |
| 工作汇报风格（拟人播报 / 详细汇报） | progressStyle（polite / cot；2026-11-06 起默认 polite——企微进度行不露思维链/工具内容，只播报一句「思考中…请稍等」） |
| 播报文案 | progressText（拟人播报模板；占位符 {bot}=名字 {dots}=呼吸点 {elapsed}=已用时 {step}=步数，≤120 字） |
| 工作日志 | 时间线（/api/timeline） |
| 工作档案 / 原生档案 | 台账 ledger / provider 原生会话 |
| 广播站 / 播音员 | 服务端主动推送 / 发送者 bot |
| 后勤部门 / 部门重组 | 插件 / 四阶段重载（reload） |
| 资产科 / 资产清单 / 装备台 | 资产注册表（/api/assets）/ per-bot 绑定面（/api/bots/:id/assets） |
| 配发 / 私发 | 绑定模式 mode:'shared'（跟源更新）/ 'exclusive'（快照独立，不随源改动漂移） |
| 卸下装备 / 下架资产 | 解绑（DELETE /api/bots/:id/assets/:id）/ 删除资产（DELETE /api/assets/:id） |
| 重新物化 | rematerialize（POST /api/bots/:id/rematerialize-assets，按当前绑定重写盘面） |
| 状态：工作中 / 待命 / 休假 | working / idle / offline(+disabled) |
| 工牌号 | bot id（同时是化身 seed——同 id 全站同脸） |

**文案原则**：① 主层公司话、技术词进 tooltip/副标题；② 状态词只用
工作中/待命/休假三档，原因（reason）照实说；③ 危险操作（办离职、部门重组）
必须列后果清单并要求显式确认（离职输姓名）；④ 「真实送达企微」「仅文本问答对
迁移」「不进引擎链、不记台账」这类后果/边界说明一个字不减。化身（DiceBear
notionists，CC0，全离线打包进 shell）由 `WAO.avatar(botId,{size,mood})` 出内联
SVG，同一工牌号在办公室/卡片/列表/日志行/工牌上都是同一张脸；打卡钟页头（活钟 ·
在岗 N/M · 今日工单 X）全站可见。可达性：全站 focus-visible 焦点环、
prefers-reduced-motion 全关动画（画布动画由 ofscene 的 reduced 标志接管）、
≤900px 侧栏折顶。

## 5. 测试矩阵

| 命令 | 内容 | 时长 |
|---|---|---|
| `npm test` | 417 用例：内核（含 log ENOSPC 降级）/loader/engine（含 createdAt 服务端落戳）/ledger/provider（dsh/claude/codex/pi 剖析）+ web 基建（静态托管/穿越拒绝/uiPlugins/SSE 桥）+ e2e 六场景（fake ws + fake-dsh 全链路）+ ops（孤儿扫尾：单元 + 真服务进程 SIGINT e2e） | ~40s |
| `npm run contract -- --plugin plugins/provider-dsh --port dsh` | provider 端口契约 11/11（真子进程语义；四家各有套件：dsh/claude/codex/pi 全部 11/11 零跳过） | 秒级 |
| `npm run contract` | _template 参考实现（4 pass + 7 skip，skip=需真 CLI 的组） | 秒级 |
| `bash test/smoke-dsh.sh` | **真 dsh**：两轮对话记忆（同 sessionId 续跑记暗号）+ 真 session 文件解码 | ~10s+ |
| `npm run test:matrix` | **真 dsh+claude+codex+pi 四家切换矩阵**：同 provider 换模型原生续 / 跨 provider 交接（含功能性召回，pi 腿 S2-pi/S1-pi 共 9 轮）/ 切回 delta-only 重放 + API 级 `/test` sessionId 透传冒烟；文件名 `.realtest.js` 不进 `npm test` glob | ~2-5min |
| `bash test/accept-m1.sh` | **真 dsh 验收**：真内核起服 → API 建 bot → /test 两轮 completed → profile 物化/删除 → SIGINT 锁释放 | ~15s |
| `bash test/accept-m2.sh` | **真 dsh+claude+codex 验收**（M2）：doctor → 三 bot（enabled:false）各家 /test 两轮（round2 透传 `{sessionId}` 同 id 回显）→ PATCH dsh→claude→dsh 真切换两轮 → agents/ledger 视图 → DELETE+profile 清理 → SIGINT 锁释放 | ~2-3min |
| `bash test/probe.sh` / `--check` | 四 CLI 事件序列基线固化/漂移检测（kill-resume、codex/pi resume+stdin、claude/codex/pi history-roundtrip 专项） | 每 CLI ≤150s |
| `bash test/ui-shot.sh` | **UI 截图基线**：临时内核 + CDP 无头 Chrome 产 21 张 harness 基线（六页×浅深/办公室 iso·2d×昼夜/模板页/空错态），缺图或 <5KB exit 1；基线图提交在 `test/ui-shots/` | ~75s |

真 CLI 套件不在 `npm test` 内（依赖本机 dsh/claude/codex/pi/凭证）；CLI 缺失时 matrix/smoke/accept 明确 skip。

## 6. 已知边界（诚实申报）

- **Web UI 已齐（M3）**：工作台六页（机器人/会话/台账/时间线/插件/推送）+ 办公室 3D
  （iso/2d × 昼夜），浅深两态 21 张 harness 截图基线提交在 `test/ui-shots/`（改 UI 红线：
  必须重截对照）；盲评清零（无 P0/P1，P2×5 修复复测）。
- **Safari 18/触屏：静态核查通过，未实测**（2026-11-06 边界收口波）：逐一对照
  shell/SDK/办公室 3D 的 API 面——Pointer Events（pointerdown/move/up/cancel +
  setPointerCapture + touch-action:none，iOS 13+）、EventSource（10+）、fetch/URL/
  URLSearchParams、动态 import()（11+）、ResizeObserver（13.1+）、matchMedia（14+）、
  rAF、canvas 2D（arcTo/ellipse/measureText/setTransform）、color-mix()（16.2+）、
  dataset——**无不兼容点**；唯一贴边项 `backdrop-filter`（办公室 HUD 磨砂，无前缀写法
  Safari 18 起支持，17 及以下仅丢磨砂、内容不受影响）。静态对照支持表得出，
  未在真 Safari/触屏设备跑过（截图基线为无头 Chrome）。
- **真实企微未接（切换就绪待执行）**：channel-wecom 只过了 fake openws 契约与 e2e；
  生产切换按 `docs/CUTOVER.md` 逐 bot 串行执行（runbook + 半自动脚本 `test/cutover.sh`），
  切换前旧系统 wecom-bridge 继续服役。
- **锁冲突无 claim-live**：前身"GUI 占锁→界面认领"协议 M1 未实现；dsh 会话被占 →
  `code=lock-conflict` → 固定友好文案（"写锁被另一个进程占用…请稍后重试"）。
- **单进程爆炸半径**：分级承诺（DESIGN §2.5）——装载失败可隔离、内核中介调用可归因；
  但一个 bot 的同步死循环/OOM 仍可能拖死全进程，靠 launchd KeepAlive 拉活（模板已交付，§3.1），不内置守护。
- **三家 provider 均已交付**（M2：dsh/claude/codex 契约 11/11×3、切换矩阵 6/6 真 CLI）；probe 基线已固化，
  升级 CLI 后 `probe.sh --check` 报漂移属预期流程（对照 test/probe-baselines/ 重捕或修 runner）。

## 7. 目录地图

| 路径 | 职责 |
|---|---|
| `src/index.js` | CLI 入口（start/doctor/version）+ `createKernel()` 装配 |
| `src/kernel/` | 微内核六件套（config 锁与原子写 / log / events / services / http / lifecycle+loader） |
| `plugins/core-engine/` | 引擎/台账/会话缓存/timeline/进度/掩码中间件 + `/api` 业务路由（api.js engine.js bots.js ledger.js sessionCache.js timeline.js middleware.js progressor.js） |
| `plugins/channel-wecom/` | 企微适配器（client.js 长连接 / adapter.js 流式·推送·欢迎语） |
| `plugins/provider-dsh/` | dsh 驱动（runner.js 子进程+事件映射 / profiles.js per-bot profile 物化 / history.js 会话史读取） |
| `plugins/provider-claude/` | claude 驱动（runner.js stream-json 解析+--resume / history.js ~/.claude/projects 读取） |
| `plugins/provider-codex/` | codex 驱动（runner.js 全事件集+exec resume / history.js rollout 读取） |
| `plugins/_template/` | channel / provider / page 三套脚手架（`_` 前缀=内核不扫描） |
| `data/`（WAO_HOME） | bots.json / plugins.json(启用表) / ledger/*.jsonl / sessions/*.json / logs/wao.log / .lock |
| `test/` | kernel·engine·ledger·provider 单测 / contract 契约套件 / e2e 六场景 + switch-matrix.realtest 三家切换矩阵（真 CLI，npm run test:matrix） / fake-bin 假 CLI / probe-baselines 基线 / probe.sh·smoke-dsh.sh·accept-m1.sh·accept-m2.sh·ui-shot.sh / cutover.sh（生产切换半自动脚本，docs/CUTOVER.md §7） |
| `docs/` | DESIGN.md（权威设计）· PLUGIN-DEV.md（插件开发契约）· CUTOVER.md（生产切换 runbook）· BLIND-REVIEW-CHECKLIST.md（盲评清单，含 UI 段）· launchd.plist（无人值守模板，§3.1） |

> 交接 Do：改插件后跑对应测试+契约；动内核先读 DESIGN §2；升级 CLI 先 `probe.sh --check`。
> Don't：别双实例（锁会拒，但别绕）；别手改 data/ 运行中文件（API 有 last-good 语义）；别在插件间 import。
