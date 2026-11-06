# Wecom Agent Office — 交接版 HANDOFF

> 最后更新：2026-11-07（provider-pi 第四技能部门接入）｜分支 main
> 产品定位：**一家你独自经营的公司**——入职（建 Bot）、上班（干活）、离职（下线）；
> 企微消息即工单，headless Agent 子进程即员工，Web 办公室即公司现场。
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
      │   provider-dsh·claude·codex·pi（四家技能部门，契约 11/11×4）   │
      │   ui-workbench（人事部等六页）/ ui-office3d（Magpie 2D·ISO·3D）│
      │   ui-office-studio（白棚热区 · OFFICE-STUDIO-SPEC）            │
      └────────────┬──────────────────────────────▲────────────────┘
                   ▼ 每工单一个 headless 子进程      │ REST+SSE+Web UI
      dsh / claude / codex / pi CLI ←─ stdin prompt http://127.0.0.1:8792
```

- **每 bot = 一名员工**：渠道身份（企微 botId/secret）× 技能岗位（provider）× 工位（cwd）
- **切换语义**（已真 CLI 验证）：同岗位换模型=原生续会话；跨岗位=台账文本交接（consumedSeq 四规约，反例 A/B 回归锁定）；切回=原会话+增量重放
- **chatKey 三段式** `wecom:group:<id>` / `wecom:single:<userid>`——台账与缓存的主键

## 2. 现在去哪里看它

- **Web UI**：http://127.0.0.1:8792 （页头打卡钟=在岗/工单；办公室=公司现场；人事部=入职/离职）
- **公司话↔技术词对照表**：README §4.2（19 行；UI 主层公司话、详情层技术词，运维不歧义）
- **自检**：`curl 127.0.0.1:8792/healthz` ｜ `/api/agents`（status: working/idle/offline）

## 3. 日常运维（无人值守）

| 事项 | 命令/位置 |
|---|---|
| 巡检 | healthz + /api/agents（两 bot 应 idle=连接+订阅）；日志 `data/logs/wao.log`（10MB×5 轮转）+ `launchd.{out,err}.log` |
| 升级（改任何插件/shell 代码后） | `launchctl kickstart -k gui/$(id -u)/com.wecom-agent-office`（进程重启=四阶段停机+KeepAlive 自愈；⚠️ `/api/service/reload` 只做配置级重载——静态 import 缓存局限，勿当升级用） |
| 插件启停（=部门开张/歇业） | UI 后勤部门页 或 `POST /api/plugins/:id/enable\|disable`（四阶段 reload；引用它的 bot 立即离线并给原因） |
| 插件开发 | `plugins/_template/` 三脚手架 + [PLUGIN-DEV.md](docs/PLUGIN-DEV.md) + 契约套件 `npm run contract -- --plugin <dir>`（profiles 控 skip、插件侧无逃逸） |
| UI 改动 | 红线：`bash test/ui-shot.sh` 截图验证再交付（页面插件=无构建 ES Module、禁 JSX/bare import、React 走 window.WAO；shell/sdk 改后 `node web/build.mjs` 提交 dist） |
| 全量测试 | `npm test`（414）｜契约 ×4 各 11｜`npm run test:matrix`（真 CLI 四家切换矩阵，pi 腿 9 轮）｜`bash test/accept-m1.sh` / `accept-m2.sh`（真 CLI 验收）｜`bash test/probe.sh --check`（CLI 事件形状漂移检测，四家） |

## 4. 高频操作（公司话速查）

- **入职**：人事部 →「办理入职」四步（名片 🎲 头像可重摇｜技能岗位｜工位与门禁｜工牌激活）→ 工牌预览（createdAt=入职日期，registry truth：API 拒收调用方改写）
- **离职**：员工卡 →「办理离职」→ 面谈清单（档案保留/物化配置清理）→ 输名字确认
- **转岗**（换 provider）：编辑员工 → 保存后首轮自动携带近期对话摘要续接（仅文本；工具/思考/压缩状态不迁移——UI 有如实提示）
- **岗前测试**：员工卡「岗前测试」，可自定义问题（{sessionId?, prompt?}；不进引擎链、不记台账、不发企微）
- **广播**：广播站页（要求 bot 在线；目标=台账里出现过的会话）
- 密钥红线：响应永不回显 secret（API 层递归剥离+自由文本对象敏感值 __MASKED__ 掩码显示、PATCH 保留式回填）；`data/` 0700、文件 0600

## 5. 生产切换史与回滚

**已切换**（2026-11-06 10:39-10:40，runbook=[CUTOVER.md](docs/CUTOVER.md)）：旧桥此前已死无互踢 → launchd 安装（PATH 覆盖三 CLI bin）→ 双 bot 建档（enabled:false）→ 旧 `../wecom-bridge/bots.json` 归档写空表（防任何复活抢连接）→ 逐 bot 接管 → **出站验证 ×3 送达** → **入站终验 PASS**（10:55 真实流量 3 条、latest-wins 抢占升级链活体、两轮 completed、台账秒级对齐）→ kickstart/kill-9 冷启动演练双通过。

**回滚三步**（压力下照做）：
1. `launchctl unload ~/Library/LaunchAgents/com.wecom-agent-office.plist`（先停新系统，防互踢）
2. 恢复旧表：`../wecom-bridge/bots.json.archive-*`（符号链接→cutover-backup-20261106 原件）复制为 `bots.json`
3. DSH GUI 里 enable 旧 wecom-bots 插件（1.2s 自动拉起旧桥）→ 验证 `127.0.0.1:8791/healthz`

## 6. 质量与验证现状（证据锚点）

- 测试 **417/417**（含 pi-runner 14 项 + pi-history 8 项）；契约套件 dsh/claude/codex/pi **11/11×4 零跳过**；切换矩阵引擎级 7/7（真 CLI，pi 腿 S2-pi/S1-pi 全绿）+ API 冒烟含 pi 腿两轮 PASS（矩阵 run2 全绿；run3 codex 腿因网关慢撞 60s 帽，见 §7）；探针基线四家（`test/probe-baselines/pi*.ndjson`：resume 三腿同 id 回显+记忆延续、history roundtrip 2 turns 0 warnings）；UI 基线 22 张（`test/ui-shots/`，工作流脚本带 ≥5KB 门禁）
- **零上下文盲评（pi 专项，11-07）**：首轮报 P0 一个（UI 路径建 pi bot 岗前测试 5/5 失败——`PI_CODING_AGENT_DIR` 只在显式 piAgentDir 时注入，UI 建的 bot 看不到物化的 models.json）+ P1×2/P2×7；**P0 已修**（三层：①runner 恒注入 $PI_CODING_AGENT_DIR——显式 piAgentDir 优先、per-bot 兜底与 models.js 同源公式（根因：UI 建的 bot 看不到物化 models.json）②exit 1 启动失败时 stderr 首行上浮进 errorText ③网关 404 形状（exit 0/无 retry/无 stderr）捕获 message_end.errorMessage——失败诊断从裸「failed」变为真实原因，单测 2 项钉住）+ pi 特有 P2 修复（岗位人设/下拉标签/帮助行/主题色），**原路径复测 PASS**（两轮岗前测试 completed、原生档案可凭 sessionId 调阅、岗位文案/下拉/帮助行核对项全过）；**终验 PASS**（故意错配模型 → 失败文案含 404+magpie knows no model+可用模型列表，可自救；遗留 P2：报错为英文原始 JSON 建议中文化+折叠）。P1×2 为跨 provider 既有 UI 问题，超出本任务范围，见 §7
- 四场零上下文盲评全 PASS（M1 12 条 / M2 / M3 UI 52 截图 / 终评复验），P0/P1 累计为零
- 里程碑终审：M1 SHIP / M2 SHIP / M3 SHIP / 全程终评 ISSUES-FOUND→已清零（ack 帧级键控真 bug、归档命名、CHANGELOG、ledger 补记）
- 生产在跑代码=含全部修复（升级重启实战过 3 次：kickstart 演练/kill-9 自愈/ack 修复装载）

## 7. 已知边界（终版裁定，均已评估影响面）

回环无鉴权（WAO_TOKEN 留 P2，单用户桌面可接受）｜SSE 背压未处理（单用户）｜禁用插件模块顶层仍求值（PLUGIN-DEV §9 有 caveat）｜锁 adopt 竞态/pid>int32（安全方向失败）｜单块超预算交接前缀超长｜claude/codex 真实锁冲突文案=闭案（两 CLI 无自有写锁，fake 层即全貌）｜run/* SSE 帧=bot 级忙碌窗口｜Safari=静态核查通过未实测｜老 bot 无 createdAt（工牌显示「早期入职」）｜claude 同 cwd auto-memory 跨会话泄漏（**多 bot 勿共用 cwd**）｜codex 岗前测试 ~25s 属正常｜**pi 岗位**：模型全败仍 exit 0（runner 已改看流内 stopReason）；magpie 对 localhost 不校验 caller key→missing-credential 不可真机触发（正则+fake 闭案）；pi 锁语义未观测（通用正则对冲）；`--model` 带斜杠 id 必须配 `--provider`（API 层有 'magpie' 默认值，直写 bots.json 者注意）｜**盲评遗留（跨 provider 既有 UI，非 pi 引入）**：模型字段=手写 JSON（object 型 schema 的统一渲染，四家同）+ 入职完成卡与花名册状态同屏矛盾（状态机既有表现）｜**S5 codex 腿环境性 flake**——codex 经网关当前裸调 30-33s，`/api/bots/:id/test` 60s 帽边缘，网关慢时段矩阵 API 冒烟可能红（pi 腿 ~2-4s 无此问题；重跑即绿）。

**未验证项**：24h 检查点（自动化 `automation-1d16170a` 已设，2026-11-07 11:47 自动巡检推送）；pi 员工真机企微端到端（入职→企微对话）待生产 kickstart 后用户路径实测。

## 8. 文档地图与关键裁定

| 文档 | 内容 |
|---|---|
| [DESIGN.md](docs/DESIGN.md) | v3 权威设计（微内核+万物皆插件+consumedSeq+§12 切换） |
| [OFFICE-STUDIO-SPEC.md](docs/OFFICE-STUDIO-SPEC.md) | 办公室白棚工位重做：资产管线 + 热区交互（方向已定） |
| [README.md](README.md) | 运行/开发/测试矩阵/**公司话对照表**/运维节 |
| [CUTOVER.md](docs/CUTOVER.md) + `test/cutover.sh` | 切换 runbook 与幂等子命令（baseline/stage/drill/rollback） |
| [PLUGIN-DEV.md](docs/PLUGIN-DEV.md) | 插件开发全契约（ctx/四层版本协商/复制即契约） |
| docs/launchd.plist | 四占位模板（⚠️ 占位符**无尖括号**，替换按 token 名） |
| .superpowers/sdd/×3 | 三里程碑 SDD 台账（全部裁定/遗留/盲评记录） |
| HANDOFF.md.archive-m1m3 | 本稿之前的逐里程碑追加式旧稿（历史细节查这里） |

**接手者必须知道的裁定**：①升级=kickstart 进程重启（非 reload）②内核 849 行>800 预算=如实申报不重构 ③台账 consumedSeq 四规约是切换正确性支柱（改前先读 DESIGN §7+反例测试）④四 provider runner 是复制即契约（改一家跑四家契约套件）⑤UI 双层语言（公司话主层/技术词详情层）是文案纪律。

## 9. 里程碑史

| 日期 | 里程碑 |
|---|---|
| 11-05~06 | 设计 v1→v3（四路架构评审吸收）→ M1 内核+插件体系+dsh（d04ffd8）→ M2 三 provider+切换矩阵（bafd72d）→ M3 Web UI+运维+生产切换（ca9a9b6）→ 收口波（259bac2） |
| 11-06 | 全程终评+收口 → **公司隐喻全站重设计**（4651eb6..149816f：入职向导/离职面谈/打卡钟/软插画办公室/头像即化身） |
| 11-07 | **provider-pi 第四技能部门**：pi CLI 1.5.0 接入（`-p --mode json`+`--session` 续接；magpie 网关 models.json 物化，`$ENV` 凭证引用无密钥落盘）→ 契约 11/11×4、探针基线 pi×3、切换矩阵扩 pi（9 轮）、单测 +19、launchd PATH 已覆盖（pi 在 nvm bin） |

---

**交接 Do**：改 UI 先截图；升级用 kickstart；生产问题先看 /api/agents 的 reason 再查日志；多 bot 不共 cwd。
**Don't**：不跑第二实例（端口+锁双保险会拒，但企微单连接互踢）；不用 reload 当升级；不删 consumedSeq 相关测试。
