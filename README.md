# wecom-agent-office (wao) — 企微智能机器人办公室：微内核 + 插件（M3 交接版 · 生产就绪）

> 前身：`wecom-bridge`（单 bot 数据面）+ `wecom-bots`（管理面板）。本仓库是重写：
> **微内核 + 插件体系**，一切业务（引擎/企微通道/Agent provider/UI）皆插件。
> M1 交付内核 + core-engine + channel-wecom + provider-dsh；M2 交付 provider-claude/codex
> （四家切换矩阵全绿）；M3 交付 Web UI；v2（2026-11-08）导航收敛为 总览/机器人/设置 三页（33 张截图基线，2026-11-09 重截）+
> 无人值守运维（launchd）。**生产切换 runbook：`docs/CUTOVER.md`**。
> 事实截至 2026-11-09：数字类事实（用例/截图/行数）以 `npm test`、`test/ui-shots/`、`wc -l src/kernel/*.js` 实跑为准；运行状态以 `curl /api/agents` 与 HANDOFF §5 为准。

---

## 1. 五分钟理解

```
终端: node src/index.js start            (127.0.0.1:8792, 独占 data/ 目录锁)
┌────────────────────────────────────────────────────────────────┐
│ src/kernel/  微内核(零业务, 当前 1164 行——超 800 行预算, HANDOFF 裁定②如实申报不重构): 装载/服务容器/事件总线/  │
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
  输出裁剪，真机实测省 ~18% tool 输出）、ripgrep（指引段注入 + 环境预检）与 scope-recall
  （检索式长期记忆，hermes-scope-recall——记忆条数逼近 50 上限时的升级项，v1 仅 claude 引擎）
  ——见 docs/DESIGN-ASSETS.md。
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
npm install          # 运行时依赖: ws + @dicebear/core + @dicebear/notionists（头像，全离线）
node src/index.js doctor    # 自检: node≥22.15(node:zlib zstd)/插件扫描/数据目录可写/端口/CLI在位(dsh·claude·codex·pi)/锁探测
                       #   doctor/tui 与 start 同参: --port N --host H --data-dir DIR
node src/index.js start     # 前台常驻; --port N --host H --data-dir DIR
node src/index.js version   # → 0.1.0   (拼错命令会被拒绝, 不会猜)
```

**Windows（无 git/无管理员也行）**：`scripts/win-install.ps1` 一条命令装齐（Node zip 版
+ 仓库 + 依赖 + 分离进程启动，坑位全兜住）——用法与坑位清单见
[docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md)。

**企微凭证获取**（第一次接入必读）：在**企微管理后台 → 应用管理 → 智能机器人**中创建
**API 模式**机器人，获取 **Bot ID** 和 **Secret**——这两个值填进 bot 记录的
`account.botId` / `account.secret`（Web 创建向导第 5 步「通信渠道」的凭证表单，或
`POST /api/bots`）。WebSocket 地址留默认（官方 `wss://openws.work.weixin.qq.com`）即可。
凭证填错不致命：bot 会显示「离线」并在原因里带出鉴权错误，改对凭证即恢复上线。

| 环境变量 | 作用 | 默认 |
|---|---|---|
| `WAO_HOME` | 数据目录（bots.json/ledger/sessions/logs） | `./data` |
| `WAO_PLUGINS_PATH` | 额外插件目录（按平台分隔符：POSIX `:` / Windows `;`，追加在仓库 plugins/ 之后） | 无 |
| `WAO_LOG_LEVEL` | 日志级别 | `info` |
| `WAO_TOKEN` | 访问鉴权令牌：设置后所有 `/api/*`、`/mcp` 请求须带 `Authorization: Bearer <t>` 或 `X-WAO-Token: <t>` 头 | 未设置=回环无鉴权 |

端口默认 **8792**；端口被占或 data 目录被锁 = 第二实例，拒绝启动（不共享数据目录）。
`WAO_TOKEN` 设置即启用鉴权（P1 已落地）：`/healthz`（与 `/readyz`）免鉴权供 launchd/doctor 探活；Web 控制台静态资源（`/`、`/assets/*`、`/vendor/*`、`/api/ui/*`）免鉴权——页面先加载，SDK 发现 401 会弹输入框收令牌（存 localStorage，SSE 事件流因 EventSource 不能带头、单独接受 `?wao_token=` 查询参数）；其余 `/api/*` 与 `/mcp` 一律要求令牌，缺失/不符答 401。`wao tui` 与 `wao doctor` 自动带本进程环境里的 `WAO_TOKEN`。

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
| `↑↓` / 空格 | 选机器人 / 暂停·启用确认（y 执行 n 取消） |
| `t` | 测试运行（默认探针「回复：收到」，结果窗 ↑↓ 滚动、esc 关闭） |
| `b` | 推送：从台账选目标会话 → 输入内容 → y 二次确认 → `POST /api/send` |
| `l` | 日志窗 5 行 ↔ 半屏切换 |
| `n` | 简版创建向导（姓名→引擎→cwd→botId→Secret→摘要 y，落库 `enabled:false` 暂停态） |
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
> 引用不含密钥）；`DELETE` 只删 models.json，`sessions/` 会话数据保留（删除机器人时留档）。

### 3.1 无人值守运维（launchd / systemd / NSSM）

**macOS（launchd，生产在用）** — 模板在 `docs/launchd.plist`（Label `com.wecom-agent-office`，KeepAlive+RunAtLoad+ProcessType
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

**升级路径裁定（控制器 2026-11-06 / 2026-11-09 在线一键升级交付）**：

| 场景 | 手段 | 为什么 |
|---|---|---|
| **在线一键升级（多端通用）** | 打开 Web 控制台「设置 → 系统信息」，点「检查更新」→「一键升级」 | 跨平台平滑升级：自动比对 GitHub 远程最新 Commit，下载解压、保护 `data/` 目录不被改动、依赖变动自动 npm install、自适应对应平台（macOS launchd / Linux systemd / Windows 独立更新器）平滑重启服务并在就绪后无缝刷新页面 |
| **工具装备一键安装（11-09）** | 「设置 → 系统信息 → 工具装备」：rtk / ripgrep / Git Bash（win）/ uv 状态徽章 + 一键安装（钉版 SHA256 门禁、`WAO_DOWNLOAD_MIRROR` 镜像回退、装完一键「重启服务」刷新 PATH） | 把 11-09 PC1 上 40 分钟的人工装备（慢网截断/PATH/重启）变成三次点击；win 上 Git Bash 是 claude hook 的执行前提；uv 是 scope-recall 记忆工具的安装前提（绑定即自动 `uv tool install hermes-scope-recall`，自带托管 Python） |
| **网络代理可配置（11-10）** | 「设置 → 系统信息 → 网络代理」：HTTP(S) 代理地址 + 一键测试连通；检查更新/在线升级/工具安装三条出网链路即时生效（undici ProxyAgent，无需重启） | 国内直连 GitHub 慢/被截断的根治（2026-11-09 PC1 实测 zip 静默截断后沉淀）；magpie/企微连接刻意不经代理 |
| **会话 TTL + 记忆蒸馏（11-09）** | bot `providerConfig.sessionTtlMin`（默认 45min，0=永不）控制 `--resume` 会话退役；绑 memory 资产的 bot 自动获得 FAQ 沉淀：回复末尾标记被中间件剥离并写回记忆，容量 LRU 守恒 | 实测闲聊一条从 76k（62k 纯历史重放）降到 ~16k；「沉淀成 F&Q 文档」从人设空话变成闭环机制（详见 docs/DESIGN-TOKEN-OPT.md） |
| **Token 利用率观测 + 工具循环熔断（11-10）** | 每轮台账 durable 存 usage 细分（`usage.inputTokens/cacheReadTokens/outputTokens/totalTokens`，`/api/ledger` 可查历史缓存命中）；bot `providerConfig.toolLoopMaxCalls`（默认 60，0=关闭）单轮工具调用超限自动中止，终帧提示缩小问题、台账标 `stopCause=tool-loop` | PC1 实测一轮「查日志」考古空转烧 21.5 万 token/11min——熔断截失控循环；usage 落台账让利用率长期可观测（不再只靠会淘汰的环形时间线） |
| **代码升级（macOS launchd 命令行手动）** | `launchctl kickstart -k gui/$(id -u)/com.wecom-agent-office` | in-process reload 刷不掉 ESM 模块缓存：plugin.js 内部静态 import 的子模块（runner.js 等）reload 后仍是旧代码——已验。kickstart 走完整四阶段停机（在跑任务补终帧、孤儿扫尾）+ KeepAlive 自愈，是唯一可信的换代码路径 |
| **代码升级（Linux systemd 命令行手动）** | `systemctl --user restart wao` | 同理进程重启使新模块代码生效 |
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
| `curl -s localhost:8792/healthz` | `ok:true` + uptimeSec + version + bots 汇总（免鉴权） | 不通 → `kickstart -k`；反复挂 → launchd.err.log |
| `curl -s localhost:8792/api/agents` | 每 bot `idle/working` + `channelState.state=online`（设 WAO_TOKEN 时加 `-H "X-WAO-Token: $WAO_TOKEN"`） | `offline` 带 reason → 查 wao.log 对应 bot 段 |
| `curl -s localhost:8792/api/state` | 插件 active/failed/disabled | 出现 `failed` → 修后 `POST /api/service/reload` |
| `tail -50 <DATA_DIR>/logs/wao.log` | `wao: stopping` / `orphan sweep` / drain 超时 | 有 sweep 行=曾有 CLI 活过停机，确认无残留 |
| `node src/index.js doctor` | 全量自检（进程管理三态按平台：macOS launchd / Linux systemd） | 任何 ✗ 行=需要动手 |
| `launchctl list \| grep wecom-agent-office` | 首列 pid（`-`=没在跑） | `-` → kickstart -k 强拉 |

**Linux（systemd --user）** — 模板在 `docs/wao.service`（`Restart=always`+`RestartSec=3`，头部注释即安装三步）：

```sh
cp docs/wao.service ~/.config/systemd/user/wao.service
# 编辑 ExecStart：node 绝对路径（which node）、仓库 src/index.js、--data-dir
systemctl --user daemon-reload && systemctl --user enable --now wao
loginctl enable-linger $USER        # 不登录也自起（无人值守必做）
curl -s localhost:8792/healthz      # 确认起来
```

升级=进程重启（与 macOS kickstart 同级裁定，理由同上表）：`systemctl --user restart wao`；
配置级变化仍用 `POST /api/service/reload`。日志：`data/logs/wao.log` + `journalctl --user -u wao -n 50`
（进程崩溃类）。无人值守巡检同 macOS 命令表，`launchctl` 行换成 `systemctl --user is-active wao`。

**Windows（注册表 Run 键原生自启动 + NSSM 可选）** — 「开机自启动」设置开关在
win32 已原生支持（`/api/service/autostart` 同源）：用户级注册表 Run 键 → 启用时生成的
`data\win-autostart.cmd`（烘焙绝对路径，规避登录时 System32 cwd 与 PATH 陷阱；详见
[docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md) §3）。Run 键只管登录拉起、无崩溃自愈，
需要 KeepAlive 等价物时二选一：

- **NSSM（推荐，有 KeepAlive 等价物）**：`nssm install WAO "C:\Program Files\nodejs\node.exe" "<仓库>\src\index.js start --port 8792 --data-dir <数据目录>"`
  再 `nssm set WAO AppDirectory <仓库>`、`nssm start WAO`（崩溃自拉活=Restart=always 等价）。
  PATH 里须含 node 与各 agent CLI 的目录（nvm4w 机器写绝对路径最稳）。
- **任务计划程序（系统自带）**：建"启动时触发"任务运行同上命令行，勾"如果任务失败，每 1 分钟重启"；
  无 KeepAlive 语义，崩溃靠计划任务重试，弱于 NSSM。

注意（Windows 已知边界）：provider CLI 是 npm `.cmd` shim，wao 已按 cmd.exe 路径 spawn（CVE-2024-27980
背景，见 `src/kernel/spawn.js`）；但 claude/pi 的多行系统提示词走 argv，cmd.exe 命令行无法携带裸换行——
Windows 上优先用 dsh/codex（提示词走 stdin）或把人设写成单行。`wao doctor` 在 Windows 上
报告注册表自启动状态行（enabled ✓ / 未启用 ! 信息级）。

### 3.2 MCP 接入（AI Agent 直连操作公司）

`mcp-gateway` 插件（默认装载，可在 `data/plugins.json` 停用）把公司操作面以 MCP 最小子集暴露在
`POST http://127.0.0.1:8792/mcp`，claude / codex / ZCode 等 Agent CLI 可直连做巡检、创建机器人、
暂停启用、消息推送、插件启停、工具共享（标准术语词表见 §4.2；Agent 侧快捷 skill 见 `docs/skills/wao-company.md`）。
协议是 streamable HTTP 传输的无 SSE 半边：JSON-RPC 2.0 单请求，方法仅
`initialize` / `tools/list` / `tools/call` / `notifications/*`（含 `notifications/initialized`，
一律 HTTP 202 空体）；GET `/mcp` 答 405（SSE 推送二期）；`DELETE /mcp` 显式终结会话（幂等 202）。

- **会话生命周期**：`initialize` 响应头下发 `Mcp-Session-Id`（uuid）→ 之后每个请求必须带该头
  （响应回显同值）；缺失/未知/已终结 → JSON-RPC `-32002`。会话不过期（单用户），只有
  DELETE 与服务重启/插件重载（四阶段 reload 会重建全部插件路由）会让其失效——收到
  `-32002` 重新 `initialize` 即恢复。
- **错误分层**：协议错误＝HTTP 200 + JSON-RPC error（`-32700` 解析 / `-32600` 形状 /
  `-32601` 方法未知 / `-32602` 工具名或参数形状 / `-32603` 内部 / `-32002` 会话）；传输错误＝
  HTTP 状态码（405 / 415 非 JSON / 413 超 256KB）。**业务失败不是协议错误**：校验 400（如重复创建 `bot id already exists`）/
  查无 404 / 离线广播 409 以 `result.isError:true` + 中文原因返回（Agent 可读可转述）。
- **输出双形态**：每工具 `content[].text`（中文摘要）+ `structuredContent`（结构化数据）；
  secret 永不回显（`__MASKED__` 语义同 §3）。当前回环鉴权由 `WAO_TOKEN` 控制（设置后所有 /api 与 /mcp 请求需带 Authorization Bearer 或 X-WAO-Token 头；healthz/静态面豁免，见 §2）。

控制台里也有同款引导：**总览页引导卡**（一键复制 MCP 配置）与**设置 → AI 操作** section（三家配置复制/下载、19 个工具清单、skill 文件下载、MCP 连通性测试，实时显示活跃 AI 会话数——数据来自 mcp-gateway 的 `GET /api/mcp`）。

> **破坏性变更（2026-11-09）**：MCP 工具已按 §4.2 标准术语改名——旧名
> `list_employees` / `get_employee` / `hire` / `update_employee` / `offboard` / `set_duty` /
> `probation_test` / `list_departments` / `department_toggle` / `work_log` / `work_timeline` /
> `company_state` **全部失效**（调用报 -32602 工具名未知）。已配置的 AI 会话与自建脚本请改用
> 新名（速查表 `docs/skills/wao-company.md`）；server 名 `wao-company` 不变。

三家 CLI 配置样例（服务须先 `node src/index.js start`；**设置 `WAO_TOKEN` 后三家都要在配置里带头**，令牌换成实际值）：

- 令牌取值（launchd 部署）：`plutil -extract EnvironmentVariables.WAO_TOKEN raw ~/Library/LaunchAgents/com.wecom-agent-office.plist`
- `wao tui` / `wao doctor` 读**本进程环境**的 `WAO_TOKEN`（`WAO_TOKEN=$(plutil …) node src/index.js doctor`）；未 export 时 doctor 会输出「未设 env，跳过 auth 生效性实测」，不代表鉴权有问题。

```jsonc
// claude：存成 wao.mcp.json，工具名形如 mcp__wao-company__list_bots
{
  "mcpServers": {
    "wao-company": {
      "type": "http",
      "url": "http://127.0.0.1:8792/mcp",
      "headers": { "X-WAO-Token": "<你的 WAO_TOKEN>" }
    }
  }
}
```

```sh
claude --mcp-config wao.mcp.json "列出机器人并告诉我谁离线"
```

```sh
# codex：一条命令写入 ~/.codex/config.toml（WAO_TOKEN 未设置时省略 --header）
codex mcp add wao-company --url http://127.0.0.1:8792/mcp --header 'X-WAO-Token: <你的 WAO_TOKEN>'
```

```toml
# ~/.codex/config.toml（与上行等价的手写形态）
[mcp_servers.wao-company]
url = "http://127.0.0.1:8792/mcp"
http_headers = { "X-WAO-Token" = "<你的 WAO_TOKEN>" }
```

```jsonc
// ZCode：工作区级 <repo>/.zcode/config.json（用户级 ~/.zcode/cli/config.json 同形）；
// 会话启动自动连接，状态在「设置 → MCP」查看。schema 严格：多余键会被静默丢弃，
// 模板变量 ${...} 不展开——写具体地址
{
  "mcp": {
    "servers": {
      "wao-company": {
        "type": "http",
        "url": "http://127.0.0.1:8792/mcp",
        "headers": { "X-WAO-Token": "<你的 WAO_TOKEN>" }
      }
    }
  }
}
```

裸 curl 冒烟（先握手拿会话头，再列工具/调用；设了 WAO_TOKEN 时加 `-H "X-WAO-Token: $WAO_TOKEN"`）：

```sh
curl -si -X POST localhost:8792/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
# → 200，响应头含 Mcp-Session-Id；随后带该头 POST tools/list、tools/call
```

19 个工具一览（细节与参数见 `plugins/mcp-gateway/README.md`；危险＝执行前须向用户复述后果确认）：

| 工具 | 一句话 | 危险 |
|---|---|---|
| `list_employees` | 机器人清单（状态/离线原因/运行进度/消息数） | |
| `get_employee` | 单机器人详情（配置摘要无 secret） | |
| `hire` | 创建机器人（全字段记录） | |
| `update_employee` | 配置更新（patch；密码留空＝保留） | |
| `offboard` | 删除（台账与时间线历史保留） | ⚠️ |
| `set_duty` | 暂停 ↔ 启用 | |
| `probation_test` | 测试运行（成功判据看 result.code，勿只看 isError） | |
| `broadcast` | 消息推送（真实送达企微，无法撤回） | ⚠️ |
| `list_departments` | 插件清单 | |
| `department_toggle` | 插件启停（四阶段重载；重建 MCP 会话） | ⚠️ |
| `work_log` | 会话历史（台账轮次） | |
| `work_timeline` | 活动日志（时间线事件流） | |
| `company_state` | 系统状态摘要 | |
| `create_asset` | 添加工具（五类 skill/memory/mcp/prompt/tool；Agent 自建仅可独立 exclusive 绑定） | |
| `update_asset` | 更新工具（version 自增；共享绑定扇出重物化；仅 Agent 自建工具可改，共享池走控制台/REST） | |
| `delete_asset` | 删除工具（共享绑定解绑＋清理；独立副本保留生效；仅 Agent 自建工具可删） | ⚠️ |
| `bind_asset` | 绑定资产到 bot（配发 shared 跟源／私发 exclusive 快照） | ⚠️ |
| `unbind_asset` | 解绑（删除盘上产物；私发副本内容随卸载丢失） | ⚠️ |
| `rematerialize` | 强制重物化（确定性/幂等；漂移修复与失败重试） | ⚠️ |

### 3.3 备份、恢复与版本回滚

完整手册在 **`docs/BACKUP.md`**（含 Windows/权限细节与频率建议）。速查：

- **备份**：停服 → `cp -R <DATA_DIR> <备份>/` → 重启；不想停服时可直接热备
  `bots.json` / `assets.json`（tmp+rename 原子写，任意时刻 cp 不会撕裂）与 `ledger/`（追加型）。
- **恢复**：停服 → 备份覆盖 `data/` → 重启 → `node src/index.js doctor --data-dir <DATA_DIR>` 验证 →
  `/api/agents` 确认每 bot 在线。
- **版本回滚**：`git log --oneline` 找上一个可用 commit → `git checkout <hash>` →
  `launchctl kickstart -k gui/$(id -u)/com.wecom-agent-office`（代码升级只有进程重启可信）→
  `bash test/probe.sh --check` 对基线。
- **密钥纪律**：`bots.json` 含企微 secret、`assets.json` 可能含 env 值——备份副本
  `chmod -R go-rwx`，不进网盘/仓库等会被同步走的地方。

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
  `WAO` 取（`h/useState/useEffect/useCallback/api/useAgents/useTimeline/useSSE/avatar/avatarUrl/registerPage/getPage`——
  `getPage(id)` 供页间内嵌查找，页面描述带 `hidden: true` 时注册但不进导航）。manifest 声明 `ui: './ui'` → 内核托管 `/api/ui/<id>/` 并进 `/api/state.uiPlugins`。细节与
  harness 模板见 `docs/PLUGIN-DEV.md` §5.4，参照实现 `plugins/_template/page/`。
- **harness 截图（改 UI 红线：必须截图验证）**：每页面插件 `ui/harness.html` 用
  `web/harness-lib/wao-stub.js` 的假数据桩独立渲染（内核同源托管）。**UI 改动工作流
  = 改页 → 跑截图脚本 → 逐张看图（浅/深/空态/错误态）→ 图随代码一起提交**：

  ```sh
  bash test/ui-shot.sh      # 起临时内核(18798)+CDP 无头 Chrome，重产 30 张基线到 test/ui-shots/
  ```

  基线清单（提交进库，review 时对照）：ui-workbench 三页（v2 导航收敛：overview/robots/
  settings）× 浅/深 + 总览卡片视图/机器人详情 tab（工具/设置）/向导两步 × 浅/深 +
  设置系统信息与内嵌装备台 × 浅/深 + ui-office3d iso/2d × 浅/深（插件自带 harness，
  页面 hidden 不占导航、由总览内嵌）+ ui-office-studio + template-page demo +
  边界四张（`?state=empty|error`：总览与办公室的空态 / 断服 fetch 失败文案）。
  主题由 CDP `Emulation.setEmulatedMedia` 精确控制（不依赖系统外观）；任一图缺失或
  <5KB 脚本 exit 1。harness 还支持手工改 `ui/fake-data.js` 桩出更多状态后单张复现：

  ```sh
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --headless=new --disable-gpu --screenshot=/tmp/shot.png --window-size=1280,800 \
    http://127.0.0.1:8792/api/ui/<插件id>/harness.html
  ```

  单张手工截图时深色可加 `--force-dark-mode`；模板页 demo 需 `WAO_PLUGINS_PATH`
  指向 `plugins/_template`（脚本已自动带上）。

### 4.2 标准 UI 术语（2026-11-08 由公司隐喻还原）

产品用**标准产品术语**：管理的每个对象是一个机器人（bot）。UI 主层一律标准
术语，技术词收进 tooltip / 副标题（双层语言，运维不歧义）；后果说明保持诚实
（如「更换引擎仅文本问答对迁移」这类事实不减，只换语气）。

**标准术语 ↔ 技术词对照表**：

| 标准术语 | 技术词 |
|---|---|
| 创建机器人 | 新建 bot（POST /api/bots） |
| 删除 | 删除 bot（DELETE /api/bots/:id） |
| 暂停 / 启用 | 停用 / 启用（toggle，enabled=false/true） |
| Agent 引擎（DSH·Claude·Codex·Pi 引擎） | provider（dsh / claude / codex / pi） |
| 工作目录 | cwd |
| 允许用户 | allowedUsers |
| 连接配置 / 机器人凭证 | 填企微机器人凭证（channel account） |
| 测试运行 | 试跑（POST /api/bots/:id/test） |
| 消息 | 一轮对话（ledger turn） |
| 运行进度 | 进度行（progress.line） |
| 进度风格（拟人播报 / 详细汇报） | progressStyle（polite / cot；2026-11-06 起默认 polite——企微进度行不露思维链/工具内容，只播报一句「思考中…请稍等」） |
| 播报文案 | progressText（拟人播报模板；占位符 {bot}=名字 {dots}=呼吸点 {elapsed}=已用时 {step}=步数，≤120 字） |
| 活动日志 | 时间线（/api/timeline） |
| 会话历史 / 引擎会话 | 台账 ledger / provider 原生会话 |
| 消息推送 / 发送方 | 服务端主动推送 / 发送者 bot |
| 插件管理 / 重新加载 | 插件 / 四阶段重载（reload） |
| 工具库 / 工具清单 / 工具配置 | 资产注册表（/api/assets）/ per-bot 绑定面（/api/bots/:id/assets） |
| 共享 / 独立 | 绑定模式 mode:'shared'（跟源更新）/ 'exclusive'（快照隔离，不随源改动漂移） |
| 移除 / 删除工具 | 解绑（DELETE /api/bots/:id/assets/:id）/ 删除资产（DELETE /api/assets/:id） |
| 重新物化 | rematerialize（POST /api/bots/:id/rematerialize-assets，按当前绑定重写盘面） |
| 状态：工作中 / 待命 / 离线 / 暂停 | working / idle / offline(+disabled) |
| 机器人 ID | bot id（同时是化身 seed——同 id 全站同脸） |

**文案原则**：① 主层标准术语、技术词进 tooltip/副标题；② 状态词只用
工作中/待命/离线/暂停四档，原因（reason）照实说；③ 危险操作（删除、重载）
必须列后果清单并要求显式确认（删除输入名称）；④ 「真实送达企微」「仅文本问答对
迁移」「不进引擎链、不记台账」这类后果/边界说明一个字不减。化身（DiceBear
notionists，CC0，全离线打包进 shell）由 `WAO.avatar(botId,{size,mood})` 出内联
SVG，同一机器人 ID 在办公室 3D/卡片/列表/日志行/ID 卡上都是同一张脸；状态栏页头
（活钟 · 在线 N/M · 今日消息 X）全站可见。可达性：全站 focus-visible 焦点环、
prefers-reduced-motion 全关动画（画布动画由 ofscene 的 reduced 标志接管）、
≤900px 侧栏折顶。

## 5. 测试矩阵

| 命令 | 内容 | 时长 |
|---|---|---|
| `npm test` | 全绿（用例数持续增长，以 `npm test` 实跑为准；2026-11-09 已 670+）：内核（含 log ENOSPC 降级）/loader/engine（含 createdAt 服务端落戳、healthz 口径与 /api/agents 统一、cwd 存在性校验）/ledger/provider（dsh/claude/codex/pi 剖析）+ web 基建（静态托管/穿越拒绝/uiPlugins/SSE 桥）+ e2e 六场景（fake ws + fake-dsh 全链路）+ ops（孤儿扫尾：单元 + 真服务进程 SIGINT e2e） | ~40s |
| `npm run contract -- --plugin plugins/provider-dsh --port dsh` | provider 端口契约 11/11（真子进程语义；五家各有套件：dsh/claude/codex/pi/cursor 全部 11/11 零跳过（cursor 走 fake 级探针）） | 秒级 |
| `npm run contract` | _template 参考实现（4 pass + 7 skip，skip=需真 CLI 的组） | 秒级 |
| `bash test/smoke-dsh.sh` | **真 dsh**：两轮对话记忆（同 sessionId 续跑记暗号）+ 真 session 文件解码 | ~10s+ |
| `npm run test:matrix` | **真 dsh+claude+codex+pi 四家切换矩阵**：同 provider 换模型原生续 / 跨 provider 交接（含功能性召回，pi 腿 S2-pi/S1-pi 共 9 轮）/ 切回 delta-only 重放 + API 级 `/test` sessionId 透传冒烟；文件名 `.realtest.js` 不进 `npm test` glob | ~2-5min |
| `bash test/accept-m1.sh` | **真 dsh 验收**：真内核起服 → API 建 bot → /test 两轮 completed → profile 物化/删除 → SIGINT 锁释放 | ~15s |
| `bash test/accept-m2.sh` | **真 dsh+claude+codex 验收**（M2）：doctor → 三 bot（enabled:false）各家 /test 两轮（round2 透传 `{sessionId}` 同 id 回显）→ PATCH dsh→claude→dsh 真切换两轮 → agents/ledger 视图 → DELETE+profile 清理 → SIGINT 锁释放 | ~2-3min |
| `bash test/probe.sh` / `--check` | 四 CLI 事件序列基线固化/漂移检测（kill-resume、codex/pi resume+stdin、claude/codex/pi history-roundtrip 专项） | 每 CLI ≤150s |
| `bash test/ui-shot.sh` | **UI 截图基线**：临时内核 + CDP 无头 Chrome 产 33 张 harness 基线（三页×浅深＋卡片/详情 tab/向导两视图/AI section/内嵌工具配置等深链＋办公室 iso/2d＋白棚＋模板页＋空错态×4），缺图或 <5KB exit 1；基线图提交在 `test/ui-shots/` | ~75s |

真 CLI 套件不在 `npm test` 内（依赖本机 dsh/claude/codex/pi/凭证）；CLI 缺失时 matrix/smoke/accept 明确 skip。

## 6. 已知边界（诚实申报）

- **Web UI 已齐（M3，v2 三页导航）**：工作台三页（总览/机器人/设置）+ 办公室 3D
  （iso/2d × 浅深），33 张 harness 截图基线提交在 `test/ui-shots/`（改 UI 红线：
  必须重截对照）；盲评清零（无 P0/P1，P2×5 修复复测）。
- **Safari 18/触屏：静态核查通过，未实测**（2026-11-06 边界收口波）：逐一对照
  shell/SDK/办公室 3D 的 API 面——Pointer Events（pointerdown/move/up/cancel +
  setPointerCapture + touch-action:none，iOS 13+）、EventSource（10+）、fetch/URL/
  URLSearchParams、动态 import()（11+）、ResizeObserver（13.1+）、matchMedia（14+）、
  rAF、canvas 2D（arcTo/ellipse/measureText/setTransform）、color-mix()（16.2+）、
  dataset——**无不兼容点**；唯一贴边项 `backdrop-filter`（办公室 HUD 磨砂，无前缀写法
  Safari 18 起支持，17 及以下仅丢磨砂、内容不受影响）。静态对照支持表得出，
  未在真 Safari/触屏设备跑过（截图基线为无头 Chrome）。
- **真实企微已切换（2026-11-06 10:39 完成，出站×3 送达+入站终验 PASS）**：main/bot2
  双 bot 在役、旧桥 8791 已停、旧表 bots.json 归档写空防复活；全程记录见
  HANDOFF §5，回滚与 24h 巡检按 `docs/CUTOVER.md` §5/§6。
- **锁冲突无 claim-live**：前身"GUI 占锁→界面认领"协议 M1 未实现；dsh 会话被占 →
  `code=lock-conflict` → 固定友好文案（"写锁被另一个进程占用…请稍后重试"）。
- **单进程爆炸半径**：分级承诺（DESIGN §2.5）——装载失败可隔离、内核中介调用可归因；
  但一个 bot 的同步死循环/OOM 仍可能拖死全进程，靠 launchd KeepAlive 拉活（模板已交付，§3.1），不内置守护。
- **五家 provider（四家真 CLI + cursor fake 级）**：dsh/claude/codex/pi 契约各 11/11、
  切换矩阵真 CLI 全绿；cursor 第五家 fake 级 active（契约 11/11，真探针待凭证，
  调研底稿 docs/PROVIDER-RESEARCH.md）；probe 基线已固化，
  升级 CLI 后 `probe.sh --check` 报漂移属预期流程（对照 test/probe-baselines/ 重捕或修 runner）。
- **MCP `dangerousTools` 默认 true（生产安全选择题，非默认安全）**：mcp-gateway 插件选项
  `dangerousTools` 缺省放行 7 个高危工具（`delete_bot` / `broadcast` / `toggle_plugin` /
  `delete_asset` / `bind_asset` / `unbind_asset` / `rematerialize`）——删除机器人、真实送达企微的
  推送、插件启停均可由 AI Agent 调用。软缓解是设置页提示的「执行前复述后果并确认」规范
  （skill `docs/skills/wao-company.md` §危险操作确认规范）与 `WAO_TOKEN` 鉴权（§2/§3.2）。
  生产若不需要 Agent 写操作，在插件选项设 `dangerousTools:false` 一键禁用（工具仍列出，
  调用返回 isError 说明被禁用）；CUTOVER 检查项 #8 已要求令牌，此项按部署场景自行决定。

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
| `docs/` | DESIGN.md（权威设计）· PLUGIN-DEV.md（插件开发契约）· CUTOVER.md（生产切换 runbook）· BLIND-REVIEW-CHECKLIST.md（盲评清单，含 UI 段）· launchd.plist（macOS 无人值守模板，§3.1）· wao.service（Linux systemd 模板，§3.1） |

> 交接 Do：改插件后跑对应测试+契约；动内核先读 DESIGN §2；升级 CLI 先 `probe.sh --check`。
> Don't：别双实例（锁会拒，但别绕）；别手改 data/ 运行中文件（API 有 last-good 语义）；别在插件间 import。
