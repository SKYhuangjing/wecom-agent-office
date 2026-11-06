# HANDOFF — wecom-agent-office 交接（M1：内核+插件体系 ／ M2：三家 provider+切换矩阵 ／ M3：Web UI+运维+切换就绪）

> 日期：2026-11-06 ｜ 分支 `build/m1-m3` ｜ Node v24.2.0（engines ≥20.10）
> 权威设计：`docs/DESIGN.md`；插件契约：`docs/PLUGIN-DEV.md`；上手：`README.md`；
> **生产切换：`docs/CUTOVER.md`**（runbook + `test/cutover.sh` 半自动脚本）。

## 1. M1 完成态总结

**交付清单**（对应 DESIGN §14 M1 行，全部落地）：

- **内核六件套** `src/kernel/`：config（flock 数据目录锁 + 原子写）/ log / events / services /
  http 壳（最长前缀路由 + SSE + 405/404 语义）/ lifecycle+loader（四阶段 reload、cache-busting、
  依赖图、失败隔离分级、四层版本协商）；**data/ 目录 0700、落盘文件 0600**（原子写/日志/台账
  创建时落位，boot 对既有目录 best-effort 收紧——终审修复补齐 DESIGN §3/§13 声明）。
- **core-engine**：串行链（抢占立即让位、队列合并、出站预算 ≤28/min）、两阶段流式、
  ledger（consumedSeq 四规约 + 反例回归）、会话缓存（切回增量回放的持久化在 run 后落位——
  终审修复：抢占窗口不再丢 delta）、timeline、语义进度（dsh 降级链）、
  secret 掩码中间件；**allowedUsers 准入执行**（非空=白名单，越权静默 drop+warn，与前身
  bridge 一致；空=全员，attach 时 warn 一次——终审修复补齐 DESIGN §6 步骤1）；
  **per-bot drain**（PATCH/toggle/DELETE 换适配器前先等该 bot 串行链收尾——终审修复补齐
  DESIGN §8）；bots.json 归它所有；业务 `/api/*`（agents/bots/CRUD/test/ledger/
  session/export/timeline/send）。
- **channel-wecom**：企微长连接客户端（单 bot 单连接、指数退避、凭证错误快速失败）、
  流式回复（finish:true 收尾）、主动推送、enter_chat 默认欢迎语（A4 契约）。
- **provider-dsh**：真 dsh 子进程驱动（NDJSON→统一事件、kill 升级 SIGKILL、abort 部分输出、
  锁冲突/凭证错误码）、per-bot profile 物化（原子写 + last-good）+ **removeConfig 反物化**
  （DELETE bot 连 profile 一起清，本任务补齐）、zstd 会话史读取、中文 describeError。
- **契约套件 + _template 三脚手架 + PLUGIN-DEV.md**。
- **CLI**：`start / doctor / version`（doctor 本任务完善：node 地板、ws、插件扫描含
  type:module 检查、数据目录可写、端口占用、dsh/claude/codex 在位（信息行）、锁 claim+release 探测）。
- **测试基建**：fake-bin（fake-dsh 8 模式 / fake 通道）、e2e 六场景、probe.sh 基线、
  smoke-dsh.sh、accept-m1.sh（真 dsh 验收脚本）。

**关键证据**（全部本机实际执行，2026-11-06）：

| 项 | 结果 |
|---|---|
| `npm test` | **255/255 pass, 0 fail**（含 e2e 六场景：happy/抢占/reload/换 provider 交接/凭证失败/secret 永不回显；2026-11-06 M1 终审修复 +11 用例：allowedUsers 执行/切回抢占丢 delta/drainBot/0600·0700/phase④ 韧性；复审追加 +1：per-bot drain 拒答补发） |
| `npm run contract -- --plugin plugins/provider-dsh --port dsh` | **11 passed, 0 failed, 0 skipped** |
| `npm run contract`（_template 参考实现） | 4 passed, 7 skipped（skip=需真进程组/真 CLI 的组，预期） |
| `bash test/smoke-dsh.sh`（真 dsh） | **PASS**：round1 暗号"菠萝"记住、round2 **同一 sessionId** `session-d3ede8e2…` 续跑答对、真 session 文件解码 2 turns / 0 warnings |
| `bash test/accept-m1.sh`（真 dsh 验收） | **PASS，exit 0**（输出贴文见下） |
| `bash test/probe.sh --check` | 3/3 CLI 事件序列与基线一致（dsh 0.2.1-rc.5 / claude 2.1.318 / codex 0.166.0） |

**accept-m1.sh 输出贴文**（真内核 → 真 API → 真 dsh，未接企微）：

```
accept-m1: 2026-11-06 06:37:56  node v24.2.0  0.2.1-rc.5
✓ server up (pid 5190), /healthz 200 on :18792
✓ POST /api/bots → 200, bot m1-accept persisted (enabled:false, wecom untouched)
✓ create response does not echo the secret
✓ materializeConfig: /Users/sky/.dsh/profiles/wecom-m1-accept/cordis.patch.yml written
✓ profile patch carries the agent-default-model row
✓ POST /api/bots/m1-accept/test round 1 → completed, finalText='收到'
✓ POST /api/bots/m1-accept/test round 2 → completed, finalText='收到。'
  sessionId round1=session-ee535851-… round2=session-aaec236f-…
✓ round 2 minted a new session (expected: /test passes sessionId:null by contract; cross-round resume evidence = test/smoke-dsh.sh)
✓ DELETE /api/bots/m1-accept → ok
✓ removeConfig: profile dir …/wecom-m1-accept removed with the bot
✓ bot gone: POST /test now 404
✓ SIGINT → graceful stop (exit 0)
✓ data dir lock released (…/.lock gone)
✓ port 18792 free after stop
accept-m1: PASS (real dsh probe ×2 completed, profile materialized+removed, SIGINT clean stop)
```

注：`/api/bots/:id/test` 按契约每次传 `sessionId:null`（试跑独立于引擎链），两轮各自新会话属预期；
**跨轮续跑（resume）证据以 smoke-dsh.sh 为准**（同 sessionId + 记住暗号）。
内核预算：`wc -l src/kernel/*.js` = **849 行 > 800 预算，超 49 行**（840 基础上 +9：0600 权限与
phase④ 韧性终审修复）——按"诚实申报优先"未为凑数重构；
如需回预算内，候选是 lifecycle/loader 的注释压缩，动它必须全量重跑内核测试。

## 2. M2 完成态总结（2026-11-06，三家 provider + 切换矩阵）

**交付清单**（对应 DESIGN §14 M2 行；任务账本 `.superpowers/sdd/2026-11-06-wao-m2/`）：

- **provider-claude**：`claude -p --output-format stream-json --verbose` 驱动（stdin 喂 prompt、
  thinking 块 `.thinking` 载荷映射、`--resume <id>` 续同一 session、kill 升级/abort 部分输出同构）；
  history.js 读 `~/.claude/projects/<slug(realpath cwd)>/<sessionId>.jsonl`；中文 describeError。
- **provider-codex**：`codex exec --json --skip-git-repo-check -` 驱动（**全事件集**：thread.started/
  reasoning/agent_message/command_execution/file_change/mcp_tool_call/web_search/todo_list）；续接走
  `exec resume <id>` 子命令；history.js 读 `$CODEX_HOME/sessions/**/rollout-*.jsonl`（harness 注入块过滤）。
- **/test sessionId 透传**：`POST /api/bots/:id/test` 接受可选 body `{sessionId}`（缺省保持「每次新会话」
  探针契约；脏形状 400）——探针兼任真实 CLI resume 检查。
- **切换矩阵** `test/e2e/switch-matrix.realtest.js`（`npm run test:matrix`，真 CLI）：同 provider 换模型
  原生续 ×3 / 跨 provider 交接（功能性召回）/ 切回 delta-only 重放（反例 A 真链路复证）+ API 级冒烟。
- **probe 扩展**：claude resume（去混淆：随机暗号+控制组）/ claude thinking（NOTE-only）/ codex resume
  连续性（resume-of-resume 同 thread）；**真实 roundtrip artifacts ×2**（claude/codex history 读写往返，
  `test/probe-baselines/*-history-roundtrip.ndjson`，NOTE-only 不进 --check）。
- **accept-m2.sh**：三家真 CLI 验收脚本（doctor→三 bot→各家两轮→PATCH 切换两轮→视图→清理→SIGINT）。
- **docs**：README（测试矩阵/已知边界/三家一览）；DESIGN §5.1 两处勘误（claude 新会话 id 来源、codex 事件集）。

**关键证据**（本机实际执行，2026-11-06；magpie 网关，dsh 0.2.1-rc.5 / claude 2.1.318 / codex 0.166.0）：

| 项 | 结果 |
|---|---|
| `npm test` | **321/321 pass, 0 fail**（~30s；含 ledger 反例 A/B 回归与 provider 剖析；M2 终审 follow-up +2 用例：/test 自定义 prompt、claudeConfigDir env 注入） |
| 三家契约 `npm run contract -- --plugin plugins/provider-{dsh,claude,codex} --port …` | **11/11 × 3**，0 skip |
| `npm run test:matrix`（真 CLI） | **6/6 pass**（S1a/b/c 同 provider 换模型、S2 交接含暗号召回、S3 切回 delta-only+暗号召回、S5 API 冒烟；~98s） |
| `bash test/accept-m1.sh` 重跑（/test 签名扩展后） | **PASS，exit 0**（不回归；round2 仍按契约新会话） |
| `bash test/accept-m2.sh`（三家真验收） | **PASS，exit 0**（输出贴文见下） |
| `bash test/probe.sh --check` | 3/3 CLI 事件序列与基线一致 |

（footnote：本次验收日 npm test 共跑 3 次——第 1 次 runner/claude-runner 的两个 timeout 用例假 CLI
last-pid 未落盘瞬时失败（ENOENT），第 2、3 次连续 319/319 全绿；偶发向量（区别于已修复的 01d459d
boot.test flake），非确定性回归，全量判定以连续两次全绿为准。）

**accept-m2.sh 输出贴文**（doctor→真内核:18796→三 bot enabled:false→各家 /test 两轮→PATCH dsh→claude→dsh→
视图→DELETE→SIGINT）：

```
accept-m2: 2026-11-06 11:00:10  node v24.2.0  dsh 0.2.1-rc.5  claude 2.1.318 (Claude Code)  codex codex-cli 0.166.0
✓ doctor → exit 0, no ✗ (9 ✓ lines; port 18796 free, lock probe ok)
✓ server up (pid 69277), /healthz 200 on :18796
✓ POST /api/bots m2-accept-dsh → 200 (dsh, enabled:false)
✓ POST /api/bots m2-accept-claude → 200 (claude, enabled:false)
✓ POST /api/bots m2-accept-codex → 200 (codex, enabled:false)
✓ materializeConfig: /Users/sky/.dsh/profiles/wecom-m2-accept/cordis.patch.yml written
✓ dsh round 1 (no body → fresh session) → completed, sessionId=session-79fd8c88-… finalText='收到'
✓ dsh round 2 (body {sessionId}) → completed, SAME id echoed (session-79fd8c88-…) finalText='收到'
✓ claude round 1 (no body → fresh session) → completed, sessionId=17f2de45-… finalText='收到！我已就绪。…'
✓ claude round 2 (body {sessionId}) → completed, SAME id echoed (17f2de45-…) finalText='好的！我在这儿，…'
✓ codex round 1 (no body → fresh session) → completed, sessionId=01a1aecd-… finalText='收到'
✓ codex round 2 (body {sessionId}) → completed, SAME id echoed (01a1aecd-…) finalText='收到'
✓ PATCH m2-accept-dsh provider dsh→claude → 200 (record + runtime re-targeted; enabled:false → no wecom attach)
✓ switch round 1: m2-accept-dsh on claude → /test completed, sessionId=a914a832-… finalText='收到你的消息了，…'
✓ PATCH m2-accept-dsh provider claude→dsh → 200 (dsh profile re-materialized on the switch back)
✓ switch round 2: m2-accept-dsh back on dsh → /test completed, sessionId=session-78ee5e02-… finalText='收到'
✓ GET /api/ledger?bot=m2-accept-dsh → 200, 0 rows (probe isolation: /test never journals)
✓ GET /api/ledger?bot=m2-accept-claude → 200, 0 rows (probe isolation: /test never journals)
✓ GET /api/ledger?bot=m2-accept-codex → 200, 0 rows (probe isolation: /test never journals)
✓ GET /api/agents → 3 bots present, all offline + disabled (enabled:false — wecom never attached)
✓ DELETE /api/bots m2-accept-dsh → ok
✓ DELETE /api/bots m2-accept-claude → ok
✓ DELETE /api/bots m2-accept-codex → ok
✓ removeConfig: profile dir /Users/sky/.dsh/profiles/wecom-m2-accept removed with the bot
✓ bot gone: POST /test now 404
✓ SIGINT → graceful stop (exit 0)
✓ data dir lock released (/tmp/wao-accept2-data.hn7lYM/.lock gone)
✓ port 18796 free after stop

accept-m2: PASS (doctor clean, dsh+claude+codex probe×2 each with resume, switch dsh→claude→dsh, agents/ledger views, profile cleanup, SIGINT clean stop)
```

注：/test 按契约**不记台账**（试跑独立于引擎链），故 ledger 断言=0 行（探针隔离）；真实台账行增长
（7 行、provider 序列 dsh,dsh,claude,claude,codex,codex,dsh）由 `npm run test:matrix` S3 证明。

**关键实测事实**（真 CLI，供运行手册与 M3）：

- T1：claude `--resume` **真续接**（随机暗号+控制组去混淆后 CONFIRMED）；resume 轮 `system/init`
  **回显同 id**；thinking 块载荷在字段 `.thinking`（`.text` 空）——本机网关真实出现，映射必须按此取；
  同 cwd 下 claude auto-memory **跨会话泄漏**（去混淆控制组暴露——M3 切换 runbook 素材）；codex
  resume-of-resume **同 thread id** 且 prompt 恒走 stdin 可答。
- T4：codex 0.166.0 **无 `plan_update`**——计划事件实为 `todo_list{text,completed}`（plan_update 仅作
  对冲映射）；resume 子命令**拒 `-s`** → 续接腿改 `-c sandbox_mode="…"`；`-c` 字符串值需 **TOML 引号**；
  rollout 首条 user 的 harness 注入块（`# AGENTS.md`/`<environment_context>`）需过滤。

**未验证项（M2 显式申报）**：

1. **真实企微通道下的切换体验**：矩阵用 reply-only 假适配器；真实通道的流式/推送在切换轮的表现 [M3，
   DESIGN §12 逐 bot 切换时验证]。
2. **claude/codex 真实锁冲突文案**：lock-conflict 仅 fake 层验证（真实占用进程下的 describeError 文案
   未实测）[M3 统一验证，与 dsh 一并]。
3. **反例 B 真实链路**：consumedSeq 反例 B 仍为单元级锁定（test/ledger/ledger.test.js），未进真 CLI 矩阵
   （反例 A 已在 S3 真链路活体复证）。
4. **accept-m2 切换要点仅两轮**（dsh→claude→dsh 各一轮探针），非全矩阵——完整切换语义（换模型原生续/
   交接前缀/切回 delta+功能性召回）以 `npm run test:matrix` 为准。
5. 真实企微端到端、Web UI、launchd（M1 §2 遗留）不变，见下节。

**盲评观察（M2 终审 P2-2/P3，行为记录非缺陷）**：

- claude 探针回复可能**多行冗长**（网关/模型行为；accept 脚本显示取首行，不影响 completed 判定）。
- codex 探针延迟实测 **~25s**（dsh/claude ~6s）——M3 运维预期：~~接近 /test 的 30s 超时阈值，余量
  仅 ~5s~~ 已修（M2 终审 follow-up：`TEST_TIMEOUT_MS` 30s→60s，余量 ~35s）。

**遗留 minors**：M2 各任务 deferred minors 总账见 `.superpowers/sdd/2026-11-06-wao-m2/progress.md`
（要点：model-dependent 召回断言为已申报 flake 向量[网关漂移非回归]；roundtrip 探针 ask-present 不进
判定[装饰性]；DESIGN §5.1/§321 旧表述勘误已记）。

## 3. M3 完成态总结（终版，2026-11-06）

**交付清单**（任务账本 `.superpowers/sdd/2026-11-06-wao-m3/`，T1-T9）：

- **Web UI 全量**：Shell + `window.WAO` SDK（SSE 桥/断连横幅）+ 内核静态托管
  （`web/dist/` 与插件 `ui/`）+ ui-workbench 六页（机器人/会话/台账/时间线/插件/推送，
  schema 动态表单、secret 不回显的保留式回填）+ ui-office3d v2（iso/2d × 昼夜，数据同源）
  + harness 截图机制与 **21 张基线**（`test/ui-shot.sh`，改 UI 红线=重截对照）。
- **盲评清零（T7）**：52 截图逐读，零 P0/P1；P2×5 修复复测（警告人话化/name≤30/
  断连反馈/provider 失联橙点/时间线空态注记），commit `a1fd356`。
- **运维加固（T6）**：launchd 模板+doctor 三态+真机验证（kickstart 冷启/kill-9 自愈）；
  停机孤儿扫尾（SIGKILL 残留 CLI 子进程）；两条 M1 slipped minors 补回归
  （pendingFinal 空 text 终帧残留、npm-test last-pid ENOENT flake）。
- **切换就绪（T9，本波）**：`docs/CUTOVER.md`（前置终审清单/逐 bot 八步/丢消息声明/
  冷启动演练/回滚固定顺序/已知边界注记）+ `test/cutover.sh`（baseline/stage1-main/
  stage2-bot2/drill/rollback 五个幂等子命令，已用 fake openws+真内核 harness 全路径验证）；
  README/HANDOFF 收口；**log ENOSPC 加固**（文件写失败静默降级 stderr-only+一次性 warn，
  M1 minor #3 闭案，带 2 条单测）。

**三里程碑一行表**：

| 里程碑 | 交付 | 关键证据 |
|---|---|---|
| M1（closed `d04ffd8`） | 内核六件套 + core-engine（串行链/台账/会话缓存）+ channel-wecom + provider-dsh + 契约套件/三模板 | npm test 255/255；契约 11/11；accept-m1 PASS（真 dsh） |
| M2（closed `bafd72d`） | provider-claude/codex（runner+history+resume）+ /test sessionId 透传 + 三家切换矩阵 + probe 扩展 | npm test 321/321；契约 11/11×3；matrix 6/6（真 CLI）；accept-m2 PASS |
| M3（本波收口） | Web UI 六页+3D+21 基线 + 盲评清零 + launchd/孤儿扫尾运维 + CUTOVER runbook/脚本 + log 加固 | npm test **348/348**（T7 346 + log 加固 2）；ui-shot 21 张齐备；盲评 PASS 零 P0/P1；launchd 真机三态+kickstart/kill-9 自愈；cutover.sh harness 全路径（§下） |

**运行手册**（日常自检——巡检表详见 README §3.1）：

```sh
curl -s localhost:8792/healthz     # ok:true + uptimeSec
curl -s localhost:8792/api/agents  # 每 bot idle/working + channelState.state=online
curl -s localhost:8792/api/state   # 插件全 active（failed→修后 /api/service/reload）
node src/index.js doctor           # 全量自检（含 launchd 三态）
```

常见症状 → 动作：

| 症状 | 动作 |
|---|---|
| healthz 不通 | `launchctl kickstart -k gui/$(id -u)/com.wecom-agent-office`；反复挂 → 看 launchd.err.log |
| bot offline，reason=鉴权失败 | secret 失效/抄错 → PATCH 修正（password 缺省=保留已存值）→ toggle 重连（快速失败不风暴） |
| bot offline，lastError=`kicked: 另一连接接管` | 旧桥复活或他处连了同 bot → 确认旧表已空+8791 已停（CUTOVER §2.4-2.6） |
| provider 找不到（launchd 下静默失联） | plist PATH 漏 CLI bin 目录 → 修 plist → kickstart -k（reload 刷不掉环境） |
| 回复慢（codex） | 探针 ~25s 属预期（/test 上限 60s）；真超时才排障 |
| wao.log 断更（磁盘满） | 已加固不炸服务：stderr 仍全量；清盘后 kickstart -k 恢复文件日志 |
| 换代码/升级插件 | kickstart -k（进程重启，唯一可信换码路径）；配置级变化才用 /api/service/reload |

日志三层（排障从下往上）：

```sh
tail -50 <DATA_DIR>/logs/wao.log                          # 运行日志（生命周期/drain/orphan sweep）
tail -50 <DATA_DIR>/logs/launchd.err.log                  # launchd 侧 stderr（进程崩溃类）
launchctl print gui/$(id -u)/com.wecom-agent-office       # launchd 视角（退出码/重启计数）
```

**已知边界终版清单**（M3 终审 triage 全列——接受/已加固，不再挂账）：

1. **SSE 背压/debounce**：内核 SSE 未做慢客户端背压（极端可占内存）；SSE 触发的
   refetch 无 debounce（多页同订时突发重复拉取）。观测/资源面，非正确性问题。
2. **env 回显面**：`providerConfig.env`/`configOverrides` 自由文本对象 GET **原样回显**
   ——手填 secret 字面量会出现在响应与 UI；凭证一律走 `apiKeyEnv`（只存变量名）。
3. **禁用插件顶层求值**：discover 阶段 import 会求值所有候选目录的模块顶层（含被
   禁用插件）——带挂起顶层 await 的禁用插件可阻塞 boot/reload（src/index.js 注释声明）。
4. **log ENOSPC**：~~未包 try~~ **已加固（本波）**——文件写失败（ENOSPC/EACCES/轮转
   open 失败）静默降级 stderr-only + 一次性 warn，不再抛进调用方；代价=磁盘满期间
   文件日志缺段（stderr 全量在）。
5. **锁 adopt 竞态**：双实例同毫秒抢锁，第二个裸抛 EEXIST（非规范文案）；pid>int32
   视为死锁不 adopt。触发罕见、方向无害（第二实例报错退出）。
6. **单块超预算前缀**：单块超出站预算时 handoff 交接摘要前缀可超 maxChars，由通道
   截断（截断优于丢帧）；低频。
7. **warn/hard 窄窗**：10min 两阶段 warn/hard 定时器在终帧已发后的窄窗内仍可能多发
   一行进度/心跳文案——观测层噪音，不影响终帧正确性。
8. **shell 单错误面**：控制台 Shell 层只有一条全局错误文案位（不清除/覆盖语义弱），
   多页面同时出错只显示其一。
9. **真实锁冲突文案（闭案分析）**：dsh 真实锁冲突下的 describeError 文案仅 fake 层
   验证（M2 申报）；闭案裁定——文案为固定友好句（「写锁被另一个进程占用…请稍后重试」），
   不携带底层错误细节，真实占用场景最坏表现=同一句话，无误导面，**接受闭案**。
10. **run/* 括号语义**：`run/start`…`run/end` SSE 帧与时间线括号=**bot 级忙碌窗口**
    （idle→working→idle 转换发帧）：同 bot 并发多 chat 只有一对括号，非逐 run——
    终审裁定为既定语义，UI/读者按 bot 级解读。

**未验证项（M3 显式申报）**：

1. **真实企微入站全链路直到用户首条消息**：切换后首条消息的流式回复（含会话延续）
   =终验；连接 online 与出站 push 可自动验证，入站不可（CUTOVER §4/§6 注记 4）。
2. **24h 检查点**：切换次日巡检（重启计数/两 bot online/台账增长/orphan sweep 残留），
   命令同运行手册。
3. **cutover.sh drill 子命令的真 launchd 路径**：harness 验证了 baseline/stage1/stage2/
   断点续跑/rollback 全路径与 drill 的未装拒跑分支；drill 的 kickstart 自愈段未在真
   launchd 上执行过（kickstart 语义本身 T6 已真机验证）。
4. 交接波遗留小项：M1/M2 各未验证小项已闭或并入上表；真实锁冲突文案闭案见已知边界 #9。

## 4. M1 未验证项（显式申报，M2/M3 后状态加注）

1. **真实企微长连接端到端**：channel-wecom 仅过 fake openws 契约 + e2e；~~真企微按 DESIGN §12
   在 M3 逐 bot 串行切换时验证~~ **切换就绪（M3 T9）：runbook `docs/CUTOVER.md`；终验=切换后
   用户首条消息的回复**。
2. **claude / codex provider**：~~M2 交付~~ **已于 M2 交付**（见 §2；其未验证小项=真实锁冲突文案，M3 闭案见 §3 已知边界 #9）。
3. **Web UI**：~~M3（Shell + window.WAO SDK + ui-workbench + ui-office3d v2 + harness 截图流）~~
   **已于 M3 交付**（§3：六页+3D+21 基线，盲评清零）。
4. **launchd 托管 / 冷启动自愈演练**：~~M3（模板 + KeepAlive + 24h 内演练）~~ **模板+真机验证已交付**
   （T6：doctor 三态/kickstart 冷启/kill-9 自愈）；生产安装与切换日演练按 CUTOVER §1/§4 执行，
   24h 检查点待切换后。
5. accept-m1 / smoke / probe 均为**本机**证据（magpie 网关路由）；换机换模型后 probe 基线漂移属预期流程。

> M1 终审修复（2026-11-06，全分支评审 SHIP 附 4 项 Important）：评审点名的两条「设计已声明、
> 实现未落地」缺口——**allowedUsers 执行**（DESIGN §6 步骤1）与 **data/ 0600**（DESIGN §3/§13）
> ——已在本波修复并各带回归用例（见 §1 交付清单与 task-20-report §9），不再是未实现项；
> 同波修掉：切回增量回放在抢占窗口丢 delta、per-bot drain 缺失、fourPhase phase④ 韧性、
> DESIGN §2.5 排序措辞勘误。未验证项 1-5 不变。

## 5. M3 入口（已闭）

M3 已交付并收口（§3）。原入口段所列范围（UI/盲评/§12 切换/冷启动演练）全部落地；
两条 M1 slipped minors（pendingFinal 空 text 终帧残留回归、npm-test last-pid ENOENT
flake）已随 M3-T6 修复带回归。后续入口=执行 `docs/CUTOVER.md`。

## 6. 遗留 deferred-minors TOP 10（M1，自 progress.md 各任务 minor 行，含影响评估）

| # | 来源 | 内容 | 影响 |
|---|---|---|---|
| 1 | T5 | fourPhase 的 reloadFn 拒绝时跳过 phase④（afterAllActivated）——**已修（2026-11-06 终审修复：try/finally，phase④ 必跑且拒绝照常上抛，lifecycle.test 回归）** | reload 半途失败时 bots 不重挂，表现为全 offline；重启可恢复。触发条件罕见（reload 本身抛错） |
| 2 | T7 | disabled 插件的模块**顶层仍被求值**（discover 阶段 import） | 一个带挂起顶层 await 的禁用插件可阻塞 boot/reload；代码已诚实注释，M2 可考虑把 manifest 读取与激活 import 分离 |
| 3 | T1 | log writeSync/轮转 openSync 未包 try（ENOSPC 抛）——**已修（M3-T9：静默降级 stderr-only+一次性 warn，单测×2）** | ~~磁盘满时日志写入可能抛进调用方~~ 修复后磁盘满期间文件日志缺段（stderr 全量在） |
| 4 | T2 | 锁 adopt 竞态窗口裸抛 EEXIST（非规范文案）；pid>int32 视为死锁不 adopt | 双实例同毫秒抢锁才触发（第二个实例报错退出，无害方向）；pid 回绕在 macOS 上不现实 |
| 5 | T4 | SSE 背压未处理；/healthz 非 GET 404（可辩护） | 慢 SSE 客户端可占内存；M3 做 UI 时一并处理 |
| 6 | T13 | warn/hard 定时器窄窗竞态：final 已发后仍可能触发一次 | 观测层多余一行进度/心跳文案，不影响终帧正确性；T19 e2e 未复现 |
| 7 | T17 | 空 text 终帧失败会永驻 pendingFinal（观测残留）——**已修（M3-T6 slipped-minor 回归补齐）** | 极端：模型空回复时该 chat 的"在跑"状态不清 |
| 8 | T19 | sendToCurrent 发最新连接（依赖测试顺序）；enter_chat true 方向未过真企微 | 诊断用途的推送定向；A4 true 方向随 M3 真企微验证 |
| 9 | T9 | 单块超预算时 handoff 前缀可超 maxChars | 交接摘要可能超长被通道截断（截断优于丢帧）；低频 |
| 10 | T8 | PLUGIN-DEV §9 未提 disabled 顶层求值 caveat（与 #2 同源，文档面） | 文档同步问题，M2 顺手补一行 |

（T18 的「ensureProfileExists 真实引导未验证」已由本次 `accept-m1.sh` 覆盖：真 dsh 物化
profile 成功并随 DELETE 清理。完整 minors 总账见 progress.md 各任务行。）

## 7. 回滚 / 应急

- **本里程碑未接生产**：真实企微流量仍在旧系统 `wecom-bridge`（8791）+ `wecom-bots` 面板上，
  本仓库对生产零影响——直接 `Ctrl-C`（SIGINT 四阶段停机）即"下线"。
- 误起第二实例：端口占用或数据目录锁二选一必拦（doctor 可预检）。
- data/ 损坏应急：`bots.json` 坏行→loadBots 容错为空表（bot 全 offline 不崩）；ledger 坏尾→
  torn-tail 封口（T9）；锁死锁（持有者 pid 活但僵死）→ 手动 `rm -rf data/.lock`（stale-holder
  路径本可自动 adopt，仅 pid 被误报活时需要人工）。
- M3 上线后的回滚顺序固定（详版含命令与断言：`docs/CUTOVER.md` §5 / `test/cutover.sh rollback`）：
  ① 新服 disable 两 bot（或 launchctl unload——必须先做，防新旧互踢死循环）→ ② DSH GUI enable
  旧插件（自动拉起旧桥）→ ③ 验证 8791 healthz 两 bot connected → ④ 恢复旧 bots.json 归档件
  →（可选）导出新系统台账（DESIGN §12.5）。

## 8. 交接检查单

```sh
npm test                                                        # 348/348
npm run contract -- --plugin plugins/provider-dsh --port dsh     # 11/11
npm run contract -- --plugin plugins/provider-claude --port claude  # 11/11 (M2)
npm run contract -- --plugin plugins/provider-codex --port codex    # 11/11 (M2)
npm run test:matrix       # 三家真 CLI 切换矩阵 6/6 (M2)
bash test/smoke-dsh.sh    # 真 dsh PASS
bash test/accept-m1.sh    # 真 dsh 验收 PASS
bash test/accept-m2.sh    # 三家真 CLI 验收 PASS (M2)
bash test/probe.sh --check  # 3/3 基线一致
bash test/ui-shot.sh      # 21 张 UI 截图基线齐备 (M3)
node src/index.js doctor  # 全 ✓
# 生产切换：docs/CUTOVER.md（bash test/cutover.sh baseline|stage1-main|stage2-bot2|drill|rollback 逐步）
```

---

## M3 终笔：生产切换已执行（2026-11-06 10:40）

- **现场**：切换前旧桥已死（8791 无响应无进程，旧系统无自愈）——两 bot 此前处于离线状态；切换无互踢风险，仍按 runbook 归档旧表
- **执行**（docs/CUTOVER.md 全步骤）：launchd 安装（PATH 覆盖三 CLI bin；首次失败根因=模板占位符无尖括号 sed 未中，已修）→ 双 bot enabled:false 建档（凭据从旧表直读，响应零 secret）→ 旧 bots.json 归档（bots.json.cutover-backup-20261106，1916B）+写空表防复活 → main 接管（idle）→ **出站验证 ×3 全部 {"ok":true}**（main 单聊+群聊、bot2 单聊——切换通知已真实送达企微）→ bot2 接管（idle）
- **冷启动演练**：launchctl kickstart -k → 自动复活重订阅 ✓；kill -9 → KeepAlive 自愈（15122→15155）双 bot 回线 ✓（日志「subscribed to WeCom bot OK」×2 实证）
- **入站终验**：= 用户下次给任一 bot 发消息的第一条回复（企微断线不补发；订阅成功+协议层移植+e2e 全绿为现有证据）
- **回滚**：launchctl unload ~/Library/LaunchAgents/com.wecom-agent-office.plist → 恢复 ../wecom-bridge/bots.json.cutover-backup-20261106 为 bots.json → DSH GUI 里 enable 旧 wecom-bots 插件（1.2s 自动拉起旧桥）
- **日常**：curl 127.0.0.1:8792/healthz｜/api/agents｜日志 data/logs/wao.log（轮转 10MB×5）+ launchd.{out,err}.log｜升级=launchctl kickstart -k｜Web UI=http://127.0.0.1:8792
