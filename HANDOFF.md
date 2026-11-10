# Wecom Agent Office — 交接版 HANDOFF

> 最后更新：2026-11-09（术语收口/WAO_TOKEN 生产启用/文档对齐实测）｜分支 main
> 产品定位：**一台服务托管多个企微机器人**——创建（建 Bot）、对话（干活）、删除（下线）；
> 企微消息即对话，headless Agent 子进程即引擎实例，Web 办公室是状态可视化现场。
> 术语口径：标准产品术语见 README §4.2（11-08 起；11-06「公司隐喻」话术已废止，历史条目保留原记录）。
> 本文按「新接手者视角」组织：先看懂，再动手。权威设计=[DESIGN.md](docs/DESIGN.md)。

---

## 1. 五分钟理解全局

```
企微用户（单聊/群里@） ──wss 长连接──▶ wecom 渠道（单连接/bot）
                                        │ onMessage(chatKey 三段式)
      ┌─────────────────────────────────▼──────────────────────────┐
      │ 单进程服务 127.0.0.1:8792（launchd 常驻自愈）                 │
      │  内核六件套(零业务)：装载/容器/事件/生命周期/HTTP壳/配置        │
      │  plugins/ 一切业务皆插件：                                    │
      │   core-engine（引擎+台账+切换）/ channel-wecom               │
      │   provider-dsh·claude·codex·pi（四家引擎插件，契约 11/11×4）   │
      │   ui-workbench（人事部等六页）/ ui-office3d（Magpie 2D·ISO·3D）│
      │   ui-office-studio（白棚热区 · OFFICE-STUDIO-SPEC）            │
      └────────────┬──────────────────────────────▲────────────────┘
                   ▼ 每轮对话一个 headless 子进程      │ REST+SSE+Web UI
      dsh / claude / codex / pi CLI ←─ stdin prompt http://127.0.0.1:8792
```

- **每 bot = 一台机器人**：渠道身份（企微 botId/secret）× Agent 引擎（provider）× 工作目录（cwd）
- **切换语义**（已真 CLI 验证）：同引擎换模型=原生续会话；跨引擎=台账文本交接（consumedSeq 四规约，反例 A/B 回归锁定）；切回=原会话+增量重放
- **chatKey 三段式** `wecom:group:<id>` / `wecom:single:<userid>`——台账与缓存的主键

## 2. 现在去哪里看它

- **Web UI**：http://127.0.0.1:8792 （页头=在线数/今日消息；办公室 3D=状态可视化；机器人页=创建/删除/配置）
- **标准术语↔技术词对照表**：README §4.2（UI 主层标准术语、详情层技术词；2026-11-08 由公司隐喻还原，2026-11-09 MCP 工具面同步）
- **自检**：`curl 127.0.0.1:8792/healthz` ｜ `/api/agents`（status: working/idle/offline）

## 3. 日常运维（无人值守）

| 事项 | 命令/位置 |
|---|---|
| 巡检 | healthz + /api/agents（两 bot 应 idle=连接+订阅）；日志 `data/logs/wao.log`（10MB×5 轮转）+ `launchd.{out,err}.log`（**日志治理 observability wave 后：文件日志健康时不再 mirror stderr——launchd.err.log 应保持空；非空=file 侧降级 stderr-only 的告警，去查盘/权限**） |
| 升级（改任何插件/shell 代码后） | `launchctl kickstart -k gui/$(id -u)/com.wecom-agent-office`（进程重启=四阶段停机+KeepAlive 自愈；⚠️ `/api/service/reload` 只做配置级重载——静态 import 缓存局限，勿当升级用） |
| 插件启停 | UI 设置 → 插件 或 `POST /api/plugins/:id/enable\|disable`（四阶段 reload；引用它的 bot 立即离线并给原因） |
| 插件开发 | `plugins/_template/` 三脚手架 + [PLUGIN-DEV.md](docs/PLUGIN-DEV.md) + 契约套件 `npm run contract -- --plugin <dir>`（profiles 控 skip、插件侧无逃逸） |
| UI 改动 | 红线：`bash test/ui-shot.sh` 截图验证再交付（页面插件=无构建 ES Module、禁 JSX/bare import、React 走 window.WAO；shell/sdk 改后 `node web/build.mjs` 提交 dist） |
| 全量测试 | `npm test`（用例数持续增长——以实跑为准；2026-11-09 已 670+）｜契约 ×5 各 11（含 cursor）｜`npm run test:matrix`（真 CLI 四家切换矩阵，pi 腿 9 轮）｜`bash test/accept-m1.sh` / `accept-m2.sh`（真 CLI 验收）｜`bash test/probe.sh --check`（CLI 事件形状漂移检测，四家） |

## 4. 高频操作（标准术语速查，词表见 README §4.2）

- **创建机器人**：机器人页 →「创建机器人」五步（基本信息 🎲 头像可重摇｜Agent 引擎｜配置工具｜工作目录与允许用户｜通信渠道）→ 成功页 ID 卡预览（createdAt=创建日期，registry truth：API 拒收调用方改写）
- **删除机器人**：机器人详情 →「删除」→ 后果清单（会话历史保留/物化配置清理/可重新创建）→ 输名称确认
- **更换引擎**（换 provider）：编辑机器人 → 保存后首轮自动携带近期对话摘要续接（仅文本；工具/思考/压缩状态不迁移——UI 有如实提示）
- **测试运行**：机器人详情「测试运行」，可自定义问题（{sessionId?, prompt?}；不进引擎链、不记台账、不发企微）
- **消息推送**：机器人详情「发送消息」（要求 bot 在线；目标=台账里出现过的会话）
- 密钥红线：响应永不回显 secret（API 层递归剥离+自由文本对象敏感值 __MASKED__ 掩码显示、PATCH 保留式回填）；`data/` 0700、文件 0600

## 5. 生产切换史与回滚

**已切换**（2026-11-06 10:39-10:40，runbook=[CUTOVER.md](docs/CUTOVER.md)）：旧桥此前已死无互踢 → launchd 安装（PATH 覆盖三 CLI bin）→ 双 bot 建档（enabled:false）→ 旧 `../wecom-bridge/bots.json` 归档写空表（防任何复活抢连接）→ 逐 bot 接管 → **出站验证 ×3 送达** → **入站终验 PASS**（10:55 真实流量 3 条、latest-wins 抢占升级链活体、两轮 completed、台账秒级对齐）→ kickstart/kill-9 冷启动演练双通过。

**回滚三步**（压力下照做）：
1. `launchctl unload ~/Library/LaunchAgents/com.wecom-agent-office.plist`（先停新系统，防互踢）
2. 恢复旧表：`../wecom-bridge/bots.json.archive-*`（符号链接→cutover-backup-20261106 原件）复制为 `bots.json`
3. DSH GUI 里 enable 旧 wecom-bots 插件（1.2s 自动拉起旧桥）→ 验证 `127.0.0.1:8791/healthz`

## 6. 质量与验证现状（证据锚点）

- 测试 **全绿（以 `npm test` 实跑为准；2026-11-09 已 670+）**；契约套件 dsh/claude/codex/pi/cursor **11/11×5 零跳过**；切换矩阵引擎级 7/7（真 CLI，pi 腿 S2-pi/S1-pi 全绿）+ API 冒烟含 pi 腿两轮 PASS（矩阵 run2 全绿；run3 codex 腿因网关慢撞 60s 帽，见 §7）；探针基线四家（`test/probe-baselines/pi*.ndjson`：resume 三腿同 id 回显+记忆延续、history roundtrip 2 turns 0 warnings）；UI 基线 33 张（2026-11-09 术语迁移后重截）（`test/ui-shots/`，工作流脚本带 ≥5KB 门禁）
- **零上下文盲评（pi 专项，11-07）**：首轮报 P0 一个（UI 路径建 pi bot 岗前测试 5/5 失败——`PI_CODING_AGENT_DIR` 只在显式 piAgentDir 时注入，UI 建的 bot 看不到物化的 models.json）+ P1×2/P2×7；**P0 已修**（三层：①runner 恒注入 $PI_CODING_AGENT_DIR——显式 piAgentDir 优先、per-bot 兜底与 models.js 同源公式（根因：UI 建的 bot 看不到物化 models.json）②exit 1 启动失败时 stderr 首行上浮进 errorText ③网关 404 形状（exit 0/无 retry/无 stderr）捕获 message_end.errorMessage——失败诊断从裸「failed」变为真实原因，单测 2 项钉住）+ pi 特有 P2 修复（引擎人设/下拉标签/帮助行/主题色），**原路径复测 PASS**（两轮测试运行 completed、原生档案可凭 sessionId 调阅、引擎文案/下拉/帮助行核对项全过）；**终验 PASS**（故意错配模型 → 失败文案含 404+magpie knows no model+可用模型列表，可自救；遗留 P2：报错为英文原始 JSON 建议中文化+折叠）。P1×2 为跨 provider 既有 UI 问题，超出本任务范围，见 §7
- 四场零上下文盲评全 PASS（M1 12 条 / M2 / M3 UI 52 截图 / 终评复验），P0/P1 累计为零
- 里程碑终审：M1 SHIP / M2 SHIP / M3 SHIP / 全程终评 ISSUES-FOUND→已清零（ack 帧级键控真 bug、归档命名、CHANGELOG、ledger 补记）
- 生产在跑代码=含全部修复（升级重启实战过 3 次：kickstart 演练/kill-9 自愈/ack 修复装载）

## 7. 已知边界（终版裁定，均已评估影响面）

回环鉴权已落地（`WAO_TOKEN` 设非空即启用：`/api/*` 与 `/mcp` 须带 `Authorization: Bearer` 或 `X-WAO-Token` 头；`/healthz`/`/readyz`/控制台静态资源（`/`、`/assets/*`、`/vendor/*`、`/api/ui/*`）免鉴权；Web SDK 401 时弹框收令牌存 localStorage；未设置=维持回环无鉴权）｜SSE 事件流鉴权走 `?wao_token=` 查询参数（EventSource API 不能带请求头，回环单用户可接受）｜SSE 背压未处理（单用户）｜禁用插件模块顶层仍求值（PLUGIN-DEV §9 有 caveat）｜锁 adopt 竞态/pid>int32（安全方向失败）｜单块超预算交接前缀超长｜claude/codex 真实锁冲突文案=闭案（两 CLI 无自有写锁，fake 层即全貌）｜run/* SSE 帧=bot 级忙碌窗口（run/end 已带 usage+durationMs）｜Safari=静态核查通过未实测｜老 bot 无 createdAt（ID 卡显示「创建日期未知」）｜claude 同 cwd auto-memory 跨会话泄漏（**多 bot 勿共用 cwd**）｜codex 测试运行 ~25s 属正常｜**pi 引擎**：模型全败仍 exit 0（runner 已改看流内 stopReason）；magpie 对 localhost 不校验 caller key→missing-credential 不可真机触发（正则+fake 闭案）；pi 锁语义未观测（通用正则对冲）；`--model` 带斜杠 id 必须配 `--provider`（API 层有 'magpie' 默认值，直写 bots.json 者注意）｜**盲评遗留（跨 provider 既有 UI，非 pi 引入）**：模型字段=手写 JSON（object 型 schema 的统一渲染，四家同）+ 创建成功页与机器人列表状态同屏矛盾（状态机既有表现）｜**S5 codex 腿环境性 flake**——codex 经网关当前裸调 30-33s，`/api/bots/:id/test` 60s 帽边缘，网关慢时段矩阵 API 冒烟可能红（pi 腿 ~2-4s 无此问题；重跑即绿）。

**未验证项**：24h 检查点（自动化 `automation-1d16170a` 已设，2026-11-07 11:47 自动巡检推送）；pi 机器人真机企微端到端（创建→企微对话）待生产 kickstart 后用户路径实测。

## 8. 文档地图与关键裁定

| 文档 | 内容 |
|---|---|
| [DESIGN.md](docs/DESIGN.md) | v3 权威设计（微内核+万物皆插件+consumedSeq+§12 切换） |
| [ROADMAP.md](docs/ROADMAP.md) | 路线图：已交付/进行中/待启动/**搁置项+解冻条件** |
| [PROVIDER-RESEARCH.md](docs/PROVIDER-RESEARCH.md) | 第五 provider 调研底稿：候选总览+CodeBuddy(WorkBuddy CLI)深潜+搁置裁定 |
| [OFFICE-STUDIO-SPEC.md](docs/OFFICE-STUDIO-SPEC.md) | 办公室白棚场景重做：资产管线 + 热区交互（方向已定） |
| [README.md](README.md) | 运行/开发/测试矩阵/**标准术语对照表**/运维节 |
| [CUTOVER.md](docs/CUTOVER.md) + `test/cutover.sh` | 切换 runbook 与幂等子命令（baseline/stage/drill/rollback） |
| [PLUGIN-DEV.md](docs/PLUGIN-DEV.md) | 插件开发全契约（ctx/四层版本协商/复制即契约） |
| docs/launchd.plist | 四占位模板（⚠️ 占位符**无尖括号**，替换按 token 名） |
| .superpowers/sdd/×3 | 三里程碑 SDD 台账（全部裁定/遗留/盲评记录） |
| docs/archive/HANDOFF.md.archive-m1m3 | 本稿之前的逐里程碑追加式旧稿（历史细节查这里；根目录过程报告同归 docs/archive/） |

**接手者必须知道的裁定**：①升级=kickstart 进程重启（非 reload）②内核 849→1164 行（2026-11-09）>800 预算=如实申报不重构 ③台账 consumedSeq 四规约是切换正确性支柱（改前先读 DESIGN §7+反例测试）④四 provider runner 是复制即契约（改一家跑四家契约套件）⑤UI 双层语言：2026-11-08 起**标准术语主层**/技术词详情层（词表=README §4.2；11-06「公司话主层」裁定作废；2026-11-09 MCP 12 工具同步改名，server 名 `wao-company` 保留）。

## 9. 里程碑史

| 日期 | 里程碑 |
|---|---|
| 11-05~06 | 设计 v1→v3（四路架构评审吸收）→ M1 内核+插件体系+dsh（d04ffd8）→ M2 三 provider+切换矩阵（bafd72d）→ M3 Web UI+运维+生产切换（ca9a9b6）→ 收口波（259bac2） |
| 11-06 | 全程终评+收口 → **公司隐喻全站重设计**（4651eb6..149816f：入职向导/离职面谈/打卡钟/软插画办公室/头像即化身） |
| 11-07 | **provider-pi 第四技能部门**：pi CLI 1.5.0 接入（`-p --mode json`+`--session` 续接；magpie 网关 models.json 物化，`$ENV` 凭证引用无密钥落盘）→ 契约 11/11×4、探针基线 pi×3、切换矩阵扩 pi（9 轮）、单测 +19、launchd PATH 已覆盖（pi 在 nvm bin） |
| 11-08 | v2：导航收敛三页 + UI 标准术语还原（词表=README §4.2；取代 11-06 公司隐喻话术） |
| 11-09 | 术语全量收口：MCP 12 工具改名（list_employees→list_bots 等，server 名 wao-company 保留）+ office3d 迁移 + skill/盲评清单重写 + 33 张基线重截；office3d 工牌 innerHTML XSS 修复；WAO_TOKEN 生产启用（CUTOVER 检查项 #8）；文档对齐实测（669+ 用例/契约×5/内核 1164 行）；根目录过程产物归档 + 最小 CI |
| 11-11 | **知识资产模块（DESIGN-KNOWLEDGE）**：机器人「知识」tab（提示词送达面五家 knowledgeFace 钩子/记忆全文/技能/版本）+ AI 整理轮（curate：bot 自己重整自己的知识，人只给引导；提案文件/围栏双通道，校验后经既有资产写通道应用，origin:curation 独立绑定）+ 双作用域回滚（registry 12 版/快照 6 版）+ 知识总览矩阵 + MCP 23 工具（+list/get_assets、curate_bot/rollback_asset）；修复 exclusive 记忆收不到蒸馏写回；867 用例/38 基线 |

---

**交接 Do**：改 UI 先截图；升级用 kickstart；生产问题先看 /api/agents 的 reason 再查日志；多 bot 不共 cwd。
**Don't**：不跑第二实例（端口+锁双保险会拒，但企微单连接互踢）；不用 reload 当升级；不删 consumedSeq 相关测试。

---

## v2 能力迭代（2026-11-07 交付）

**W1 MCP 网关**（生产已上线）：`POST http://127.0.0.1:8792/mcp`（协议子集自研零依赖；initialize→Mcp-Session-Id→tools）；**19 工具**=13 平台操作（清单/创建/改配置/删除/暂停启用/测试运行/推送/插件启停/会话历史/活动日志/状态）+6 资产（create/update/delete/bind/unbind_asset+rematerialize，⚠️危险级）。三家 CLI 接入样例 README §3.2；ZCode 快捷 skill=`docs/skills/wao-company.md`（装 ~/.zcode/skills/）。安全分级：Agent 经 MCP 建的资产仅可私发绑定；shared 资产改动 Agent 面只读；真 CLI 验收=claude/codex 实际操作过 WAO（test/mcp/real-accept.sh 可重跑）。重启后 Agent 客户端自动重连（-32002→initialize）。

**W2 TUI 运维仪表盘**：`node src/index.js tui`（连本机服务）。活钟顶栏+机器人卡（实时进度/⚠工具警示/🛠工具计数）+日志尾随（l 半屏）；键位 ↑↓选择/空格=暂停启用/t=测试运行/b=推送（三步确认）/n=简版创建/e=开浏览器/q 退出。危险操作 y 确认；终端注入已消杀（ESC/OSC 清洗）。README §3 键位表。

**Token 优化全量落地（2026-11-09 深夜，c8b76ff..0166dfc，723/723 绿）**：PC1 生产实测（10 轮 562k：62k/轮会话重放、280k 盲扫）四连击——①test 轮 usage 读数（P2-B）②`sessionTtlMin` TTL 退役路由（lastAt 盖戳+expire+isSessionStale，越窗新会话无 handoff 前缀）③记忆蒸馏（四 provider memory 段 footer 标记协议+core-engine distill 中间件剥标写回 memory 资产 notes、updateAssetOp eager 扇出自动重物化、LRU 50×2KB）④装备包（rtk/ripgrep seed 按 kind 判重+向导默认勾选+「省 token 包」chip；claude 新建自动 claudeConfigDir 含 prepareConfigDir 网关 settings 预拷）⑤工具供给（tools-spec 钉版 SHA256/installer 三法 zip/SFX/brew/`GET|POST /api/service/tools`+`/api/service/restart`→updater --restart-only/doctor rtk/rg/bash 告警/设置页工具装备卡）；附 win-autostart 参数漂移修复（planAutostartRefresh 每次 start 重写）。设计底稿=docs/DESIGN-TOKEN-OPT.md（含 win32 根因实证：claude hook 经 bash 执行，缺 Git Bash 静默失效）。

**W3 资产系统**（docs/DESIGN-ASSETS.md 权威，双评审定稿）：五类资产（**skill/memory/mcp/prompt/tool**）+配发（shared 跟源）/私发（exclusive 快照）双模式；物化管线四家 provider（dsh=profile 组合器/claude=CLAUDE.md+skills+mcp 单文件/codex=AGENTS.md+config.toml/pi=agentDir+旗标）；**RTK 实测单轮 -18% token**（rtk 1.1.0 已装 ~/.local/bin，三 flavor）；ripgrep 指引资产。UI=Web「工具库」双视图+创建向导配置工具步；doctor 含漂移检查（`!` 告警级）；修复=POST /api/bots/:id/rematerialize-assets。mcp 资产 env/headers 值永不回显（__MASKED__ 按位置，留掩码=不改）。data/ 新增：assets.json（0600）+ assets/<botId>/manifest.json。

**cost-tracker Token 用量播报**（中间件插件，`plugins/cost-tracker/`）：最终回复尾行 `📊 Token：输入 X · 输出 Y`；**按 bot 开关=绑定/解绑工具资产 cost-tracker**（激活时自动注册进 assets.json，origin plugin；控制台/MCP 的 bind API 即开关）。引擎侧：`defaultRunTurn` 最终回复经 `middleware.onOutbound(text,{bot,usage,model,durationMs})`（进度帧/维护文案不经过；坏中间件抛错隔离不吞回复；middleware 产物仍过掩码）；usage 累计器归一 dsh/claude/codex/pi 四种上报方言（运行总量取 max，非求和）。不定价（台账 `cost` 恒 null）；**台账每行落 `tokens`=累计 totalTokens（observability wave，含 aborted/timeout/error 行——bookkeep 全分支走累计器）**。**现状**：四 provider 全通——dsh 已修（step_end usage 转发统一 `usage` 事件）、claude 已修（result usage 转发）、codex 半通→全通（reason.usage 补 cacheReadTokens）、pi 半通→全通（reason.usage 补 cacheReadTokens+cost 透传）；尾行与台账均为真实数字。注意：该资产由插件托管，勿在控制台编辑（编辑器只认 rtk/ripgrep，保存会改写 content；删除后下次 reload 自动重注册）。

**未验证项**：codex/pi 资产面真机消费（契约套件覆盖）；TUI 真终端视觉（纯函数快照锁定）；多轮长会话累计 rtk 节省。
