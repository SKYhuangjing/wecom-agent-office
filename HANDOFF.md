# HANDOFF — wecom-agent-office 交接（M1：内核+插件体系+wecom+dsh ／ M2：三家 provider+切换矩阵）

> 日期：2026-11-06 ｜ 分支 `build/m1-m3` ｜ Node v24.2.0（engines ≥20.10）
> 权威设计：`docs/DESIGN.md`；插件契约：`docs/PLUGIN-DEV.md`；上手：`README.md`。

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
| `npm test` | **319/319 pass, 0 fail**（~30s；含 ledger 反例 A/B 回归与 provider 剖析） |
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

**遗留 minors**：M2 各任务 deferred minors 总账见 `.superpowers/sdd/2026-11-06-wao-m2/progress.md`
（要点：model-dependent 召回断言为已申报 flake 向量[网关漂移非回归]；roundtrip 探针 ask-present 不进
判定[装饰性]；DESIGN §5.1/§321 旧表述勘误已记）。

## 3. M1 未验证项（显式申报，M2 后仍有效部分加注）

1. **真实企微长连接端到端**：channel-wecom 仅过 fake openws 契约 + e2e；真企微按 DESIGN §12
   在 M3 **逐 bot 串行切换**时验证（切换点=新系统首个 bot 连接成功；回滚顺序 §12.5）。
2. **claude / codex provider**：~~M2 交付~~ **已于 M2 交付**（见 §2；其未验证小项=真实锁冲突文案，M3 统一）。
3. **Web UI**：M3（Shell + window.WAO SDK + ui-workbench + ui-office3d v2 + harness 截图流）。
4. **launchd 托管 / 冷启动自愈演练**：M3（模板 + KeepAlive + 24h 内演练，DESIGN §12.4）。
5. accept-m1 / smoke / probe 均为**本机**证据（magpie 网关路由）；换机换模型后 probe 基线漂移属预期流程。

> M1 终审修复（2026-11-06，全分支评审 SHIP 附 4 项 Important）：评审点名的两条「设计已声明、
> 实现未落地」缺口——**allowedUsers 执行**（DESIGN §6 步骤1）与 **data/ 0600**（DESIGN §3/§13）
> ——已在本波修复并各带回归用例（见 §1 交付清单与 task-20-report §9），不再是未实现项；
> 同波修掉：切回增量回放在抢占窗口丢 delta、per-bot drain 缺失、fourPhase phase④ 韧性、
> DESIGN §2.5 排序措辞勘误。未验证项 1-5 不变。

## 4. M3 入口（M2 已闭）

- **范围与验收**：`docs/DESIGN.md` §14（里程碑）；M3=Web UI（Shell + window.WAO SDK + ui-workbench +
  ui-office3d v2 + harness 截图流）+ 盲评清零 + §12 逐 bot 上线 + 冷启动演练。
- **任务级计划**：M1 账本 `.superpowers/sdd/2026-11-05-wao-m1/`；**M2 账本
  `.superpowers/sdd/2026-11-06-wao-m2/`**（progress.md=逐任务审查记录 + deferred minors 总账）；
  M3 立项起点=DESIGN §14 M3 行 + 两账本未闭 minors。
- **接线钉（前任务留给后续的义务）**：跨 turn 出站预算靠 adapter 限流兜底（T13 minor）、30/min 限流
  已落（T17）；~~M2 需补 claude thinking 可得性验证~~ 已闭（T1 探针：`.thinking` 载荷真实出现）。

## 5. 遗留 deferred-minors TOP 10（M1，自 progress.md 各任务 minor 行，含影响评估）

| # | 来源 | 内容 | 影响 |
|---|---|---|---|
| 1 | T5 | fourPhase 的 reloadFn 拒绝时跳过 phase④（afterAllActivated）——**已修（2026-11-06 终审修复：try/finally，phase④ 必跑且拒绝照常上抛，lifecycle.test 回归）** | reload 半途失败时 bots 不重挂，表现为全 offline；重启可恢复。触发条件罕见（reload 本身抛错） |
| 2 | T7 | disabled 插件的模块**顶层仍被求值**（discover 阶段 import） | 一个带挂起顶层 await 的禁用插件可阻塞 boot/reload；代码已诚实注释，M2 可考虑把 manifest 读取与激活 import 分离 |
| 3 | T1 | log writeSync/轮转 openSync 未包 try（ENOSPC 抛） | 磁盘满时日志写入可能抛进调用方；上线前（M3）建议包 try |
| 4 | T2 | 锁 adopt 竞态窗口裸抛 EEXIST（非规范文案）；pid>int32 视为死锁不 adopt | 双实例同毫秒抢锁才触发（第二个实例报错退出，无害方向）；pid 回绕在 macOS 上不现实 |
| 5 | T4 | SSE 背压未处理；/healthz 非 GET 404（可辩护） | 慢 SSE 客户端可占内存；M3 做 UI 时一并处理 |
| 6 | T13 | warn/hard 定时器窄窗竞态：final 已发后仍可能触发一次 | 观测层多余一行进度/心跳文案，不影响终帧正确性；T19 e2e 未复现 |
| 7 | T17 | 空 text 终帧失败会永驻 pendingFinal（观测残留） | 极端：模型空回复时该 chat 的"在跑"状态不清；M2 provider 齐后加回归 |
| 8 | T19 | sendToCurrent 发最新连接（依赖测试顺序）；enter_chat true 方向未过真企微 | 诊断用途的推送定向；A4 true 方向随 M3 真企微验证 |
| 9 | T9 | 单块超预算时 handoff 前缀可超 maxChars | 交接摘要可能超长被通道截断（截断优于丢帧）；低频 |
| 10 | T8 | PLUGIN-DEV §9 未提 disabled 顶层求值 caveat（与 #2 同源，文档面） | 文档同步问题，M2 顺手补一行 |

（T18 的「ensureProfileExists 真实引导未验证」已由本次 `accept-m1.sh` 覆盖：真 dsh 物化
profile 成功并随 DELETE 清理。完整 minors 总账见 progress.md 各任务行。）

## 6. 回滚 / 应急

- **本里程碑未接生产**：真实企微流量仍在旧系统 `wecom-bridge`（8791）+ `wecom-bots` 面板上，
  本仓库对生产零影响——直接 `Ctrl-C`（SIGINT 四阶段停机）即"下线"。
- 误起第二实例：端口占用或数据目录锁二选一必拦（doctor 可预检）。
- data/ 损坏应急：`bots.json` 坏行→loadBots 容错为空表（bot 全 offline 不崩）；ledger 坏尾→
  torn-tail 封口（T9）；锁死锁（持有者 pid 活但僵死）→ 手动 `rm -rf data/.lock`（stale-holder
  路径本可自动 adopt，仅 pid 被误报活时需要人工）。
- M3 上线后的回滚顺序固定：先停新系统两 bot（防新旧互踢死循环）→ GUI enable 旧插件 → 验证
  8791 healthz →（可选）导出新系统台账（DESIGN §12.5）。

## 7. 交接检查单

```sh
npm test                                                        # 319/319
npm run contract -- --plugin plugins/provider-dsh --port dsh     # 11/11
npm run contract -- --plugin plugins/provider-claude --port claude  # 11/11 (M2)
npm run contract -- --plugin plugins/provider-codex --port codex    # 11/11 (M2)
npm run test:matrix       # 三家真 CLI 切换矩阵 6/6 (M2)
bash test/smoke-dsh.sh    # 真 dsh PASS
bash test/accept-m1.sh    # 真 dsh 验收 PASS
bash test/accept-m2.sh    # 三家真 CLI 验收 PASS (M2)
bash test/probe.sh --check  # 3/3 基线一致
node src/index.js doctor  # 全 ✓
```
