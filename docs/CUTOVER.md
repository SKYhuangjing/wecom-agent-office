# CUTOVER — 生产切换 Runbook（M3 T9）

> 把真实企微流量从旧系统（`wecom-bridge` @8791，`wecom-bots` DSH 面板托管）切到本仓库
> （wao @8792，launchd 常驻）。**控制者按本 runbook 逐步真执行**；配套半自动脚本
> `test/cutover.sh`——每步一个幂等子命令，输出自带验证断言，**脚本不自动连续执行**，
> 每步之间由控制者人工核验输出后再继续。
>
> 权威设计：`docs/DESIGN.md` §12；升级/重启裁定：README §3.1。

## 0. 事实与裁定（为什么这么切）

- **单 bot 单连接，新 subscribe 踢旧连接**——切换点=新系统该 bot 连接成功之时
  （DESIGN §12），不是停旧桥之时。
- **企微断线期间消息不补发**（秒级窗口）——丢消息声明见 §3，切换选低峰窗口。
- **裁定（控制器 2026-11-06）**：旧桥下线 = **归档旧 `bots.json`（备份+写空表）+ SIGTERM
  旧桥进程**，不走 DSH GUI disable。旧桥由 wecom-bots 插件托管、可能被自动拉起——
  空表之下即便被拉起也无害（表里没有 bot 可连）。
- 代码升级=进程重启（`launchctl kickstart -k`），配置级变化=`POST /api/service/reload`
  （README §3.1 裁定表）。
- 撰写时观测（2026-11-06，pre-cutover）：8791 healthz **不通**、旧桥 pid 已死——旧桥
  当时未在服役。本 runbook 各步对「旧桥不在跑」幂等：基线如实记录，SIGTERM/等待步
  变 no-op，新系统直接全新接管。

## 1. 前置检查单（终审清单——全部 ✓ 才进 §2）

| # | 检查 | 命令 | 通过标准 |
|---|---|---|---|
| 1 | launchd 已装且 PATH 覆盖三 CLI bin | `grep -A1 '<key>PATH' ~/Library/LaunchAgents/com.wecom-agent-office.plist`；对照 `which dsh claude codex` | 三个 CLI 的 bin 目录都在 plist PATH 串里（launchd 无 nvm 初始化，漏一个 provider 就静默失联——`docs/launchd.plist` 头注） |
| 2 | 新服活性 | `curl -s localhost:8792/healthz` | `ok:true`；`launchctl list \| grep wecom-agent-office` 首列为 pid |
| 3 | 新服插件全绿 | `curl -s localhost:8792/api/state` | core-engine / channel-wecom / provider-dsh(+claude/codex) 全 `active`，无 `failed` |
| 4 | 新服 bots 表为空 | `curl -s localhost:8792/api/bots` | `[]`（或仅含本次待切 bot）——防止误带历史 bot 连线 |
| 5 | 旧桥基线 | `curl -s localhost:8791/healthz \| jq .` | 记录全文存档（回滚对照）：两 bot `connected/subscribed/inbound.callbacks` 计数；若不通，如实记录「旧桥未服役」 |
| 6 | 文档就绪 | `git -C <repo> log --oneline -1` | 本 runbook + HANDOFF/README 终版已提交（HEAD=文档波 commit） |
| 7 | 测试与探针 | `npm test`；`bash test/probe.sh --check`；`node src/index.js doctor` | 全绿（fail=0）；3/3 基线一致；doctor 全 ✓（含 launchd ✓运行三态） |
| 8 | 访问令牌已设（非空） | `plutil -p ~/Library/LaunchAgents/com.wecom-agent-office.plist \| grep -A1 WAO_TOKEN`；`curl -s -o /dev/null -w '%{http_code}' localhost:8792/api/agents` | WAO_TOKEN 非空；无令牌 curl 得 401（带头 200）；AI CLI 三家配置已带头（README §3.2） |

脚本对应：`bash test/cutover.sh baseline`（跑 #1-#5 并把 #5 基线落盘到
`/tmp/wao-cutover/old-healthz-baseline.json`）。

## 2. 逐 bot 串行切换（先 `main` 后 `bot2`，不并行）

> 每 bot 八小步。`main` 全绿后才动 `bot2`。脚本对应：
> `bash test/cutover.sh stage1-main`（main）/ `stage2-bot2`（bot2）。
> 凭据来源：`../wecom-bridge/bots.json`（若已被 §2.4 清空，则读最新归档件
> `bots.json.archive-*`——stage2 必然如此）。

### 2.1 读旧凭据（不在终端回显 secret）

```sh
BOT=main   # bot2 轮换此变量
jq --arg id "$BOT" '.bots[] | select(.id==$id) | {id,name,botId,secret,profile,cwd,allowedUsers,model,permission,prompt,writableDirs,compaction}' \
  ../wecom-bridge/bots.json   # 或最新 archive 件
```

断言：拿到完整记录（botId/secret 非空）。**secret 只在 2.2 的请求体里流转，不落终端、不进日志。**

### 2.2 新服建 bot（`enabled:false`——只存配置不连企微）

字段映射（旧桥记录 → POST /api/bots 请求体）：

| 旧（wecom-bridge/bots.json） | 新（POST /api/bots） |
|---|---|
| `id` / `name` | `id` / `name`（≤30 字） |
| `botId` / `secret` | `account.botId` / `account.secret` |
| `profile` / `cwd` / `model` / `permission` / `prompt` / `writableDirs` / `compaction` | `providerConfig.profile` / `.cwd` / `.model` / `.permission` / `.prompt` / `.writableDirs` / `.compaction` |
| `allowedUsers` | `allowedUsers`（顶层；`[]`=全员放行） |
| `enabled:true` | **`enabled:false`** + `channel:"wecom"` + `provider:"dsh"` |

```sh
# 脚本会从旧记录组装（secret 不回显）；手工等价：
curl -s -X POST localhost:8792/api/bots -H 'content-type: application/json' \
  -d '{"id":"main","name":"Sky 分身","enabled":false,"channel":"wecom",
       "account":{"botId":"…","secret":"…"},"allowedUsers":[],
       "provider":"dsh","providerConfig":{"cwd":"…","profile":"wecom-main","model":{…},
       "permission":"read-only","prompt":"…","writableDirs":[…],"compaction":{…}}}'
```

断言：HTTP 200；响应 **不含 secret**（API 层递归清洗）。副作用：dsh profile 即时物化到
`~/.dsh/profiles/wecom-main/`（与旧系统同名 profile——内容同源，无冲突）。

### 2.3 配置核对

```sh
curl -s localhost:8792/api/bots | jq '.[] | select(.id=="main") | {id,name,enabled,account:{botId:.account.botId},allowedUsers,providerConfig}'
```

逐字段对旧记录：botId、profile、cwd、model、permission、prompt、writableDirs、
compaction、allowedUsers。**任何不一致先 PATCH 修正再往下**（此时企微零影响——bot 未连）。

### 2.4 归档旧 bots.json（cp 备份 + 写空表）

```sh
cd ../wecom-bridge
cp bots.json "bots.json.archive-$(date +%Y%m%d-%H%M%S)"
printf '{"bots":[]}' > bots.json   # 空表：即便旧桥被插件拉起也无 bot 可连
ls -la bots.json.archive-* | tail -1
```

断言：归档件存在且内容=原表（两 bot 在）；`bots.json` 现为 `{"bots":[]}`。
幂等：已存在归档件且当前已空表 → 跳过。

### 2.5 SIGTERM 旧桥（pid 从 8791 healthz 取）

```sh
OLD_PID=$(curl -s --max-time 2 localhost:8791/healthz | jq -r '.pid // empty')
[ -n "$OLD_PID" ] && kill -TERM "$OLD_PID"   # 8791 不通（旧桥没在跑）→ 本步 no-op
```

断言（下一项一起验）。幂等：进程已死则跳过。

### 2.6 等待旧连接让位

```sh
for i in $(seq 1 20); do curl -s --max-time 1 localhost:8791/healthz >/dev/null 2>&1 || break; sleep 0.5; done
curl -s --max-time 1 localhost:8791/healthz || echo "8791 down（旧桥已让位/本就未跑）"
```

断言：8791 不通（或从未通）。**必须先于 2.7**——否则新连接与旧桥互踢死循环。

### 2.7 新服接管（切换点）

```sh
curl -s -X POST localhost:8792/api/bots/main/toggle | jq '.bot.enabled'   # → true，此刻连接企微
curl -s localhost:8792/api/agents | jq '.[] | select(.id=="main") | {status,channelState,reason}'
```

断言：`status:"idle"`（非 offline）、`channelState.state:"online"`、`reason:null`。
若 `state:"stopped"` 且 lastError=鉴权失败 → secret 抄错，回 2.2 核对（此时回滚成本低：
再 toggle 一次即下线）。

### 2.8 出站验证（既有会话，从旧 state 取 chatKey）

```sh
# 旧会话表 key 形如 single:woY-…/group:wrY-…——新系统加通道前缀：
jq -r 'keys[]' ../wecom-bridge/state/sessions-main.json    # 挑 single:*（与 Sky 的单聊，不打扰群）
curl -s -X POST localhost:8792/api/send -H 'content-type: application/json' \
  -d '{"botId":"main","chatKey":"wecom:single:woY-…","content":"【wao 切换验证】main 出站推送测试——收到本条即代表新系统已接管"}'
```

断言：HTTP 200 `{ok:true}`（=已过企微长连接发出）；**确认送达=手机真实收到该条**
（人工）。UI 推送页此刻不可用（见 §6 注记 3），出站验证一律走 curl。

> `main` 八步全绿 → 对 `bot2` 重复（脚本 `stage2-bot2`；2.4/2.5/2.6 为 no-op 幂等直过）。

## 3. 切换窗口丢消息声明（知情接受）

企微**不补发**断线期间的消息：从 2.6 旧桥让位到 2.7 新服 `online` 之间（以及新服
subscribe 尚未完成的秒级窗口）发来的用户消息**会丢、无回执**。缓解：选低峰窗口执行；
§2 顺序已把窗口压到秒级；切换完成后可在群里发一条人工公告提醒重发。

## 4. 全量切换后：收尾 + 冷启动演练

```sh
# 两 bot 均在线空闲：
curl -s localhost:8792/api/agents | jq '.[] | {id,status,channelState}'
# 冷启动演练（无人值守自愈验收，DESIGN §12.4；脚本 drill）：
launchctl kickstart -k gui/$(id -u)/com.wecom-agent-office
# 预期：KeepAlive 数秒内拉活；healthz/agents 自动回来，两 bot 自动重连 online
```

断言（drill 脚本自动轮询）：`/healthz` `ok:true`；两 bot `idle`+`online`；
`launchctl list | grep wecom-agent-office` 首列 pid 为新 pid。

**入站终验 = 用户下次真实发消息**：第一条消息的流式回复正确（含会话延续）即为终验
通过（脚本无法替代——见 §6 注记 4）。

**24h 检查点**（次日巡检，命令同 §5 巡检表）：uptimeSec 正常、两 bot online、台账在涨
（`/api/agents` 的 todayTurns/turns）、`launchctl print` 重启计数无异常抖动、
wao.log 无孤儿扫尾残留。

## 5. 回滚（固定顺序，一步都不要换）

> 触发条件：新系统任一 bot 反复 offline/回复异常/凭据排障超预期。回滚粒度=整系统。

1. **新服先让位（必须第一步，否则新旧互踢死循环）**：
   `curl -X POST localhost:8792/api/bots/main/toggle` + `…/bot2/toggle`（disable 两 bot），
   或整服下线 `launchctl unload ~/Library/LaunchAgents/com.wecom-agent-office.plist`。
2. **DSH GUI enable 旧 wecom-bots 插件**（插件自动拉起旧桥，约 1.2s；空表之下的旧进程
   若还活着则随插件拉起重启）。
3. **验证 8791**：`curl -s localhost:8791/healthz | jq '.bots[] | {id,connected,subscribed}'`
   ——两 bot `connected:true`。
4. **恢复旧 bots.json 归档件**：`cp ../wecom-bridge/bots.json.archive-<ts> ../wecom-bridge/bots.json`
   ——注意 bots.json 由 wecom-bots 插件写入：GUI 面板里配置仍在则以 GUI 为准（插件落盘
   会重写该文件），归档件恢复是文件级兜底/对照。恢复后确认 8791 两 bot connected。
5. （可选）导出新系统期间台账留档：`curl -s 'localhost:8792/api/export?bot=main' > main-ledger.md`
   （若第 1 步走的是 disable 而非 unload，服务还在，可直接导出）。

脚本对应：`bash test/cutover.sh rollback`（执行 1，打印 2-4 的人工操作指引与验证命令；
DSH GUI 操作本身在 GUI 里做，脚本不代点）。

## 6. 已知边界注记（切换视角，终版清单见 HANDOFF §3）

1. **claude 同 cwd auto-memory 跨会话泄漏**（M2 探针实证：同 cwd 下 claude 自动记忆跨
   session 串扰）——**多 bot 勿共用同一 cwd**。当前旧表两 bot 同 cwd
   `/Users/sky/develop/workbuddy_workspace`：dsh 按 profile 隔离无此问题；**仅当把某 bot
   切到 claude provider 时必须先改它的 cwd**。
2. **codex 探针 ~25s 属预期**（dsh/claude ~6s；/test 超时已放宽 60s）——切 codex 或巡检
   试跑时勿把 25s 当故障。
3. **UI 推送页在首条入站消息产生台账前不可用**（推送页的会话列表来自台账）——切换时的
   出站验证一律走 §2.8 的 curl；首条入站消息落账后推送页自然可用。
4. **入站终验=用户下次真实发消息**：切换自动化只能验到出站 push + 连接 online；真实
   回调→引擎→provider→流式回复的全链路，以用户首条消息的正确回复为终验。
5. **run/* SSE 帧的括号=bot 级忙碌窗口**：`run/start`…`run/end` 按 bot 的 idle→working→
   idle 转换发帧——同一 bot 并发多个 chat 时只有一对括号（非逐 run），时间线页据此解读。

## 7. 脚本用法（test/cutover.sh——不自动执行）

```sh
bash test/cutover.sh baseline      # §1 前置检查（基线落盘 /tmp/wao-cutover/）
bash test/cutover.sh stage1-main   # §2 全八步（main），每步断言+回显
bash test/cutover.sh stage2-bot2   # §2 全八步（bot2；归档/停旧桥步幂等直过）
bash test/cutover.sh drill         # §4 冷启动演练（kickstart -k + 自动恢复轮询）
bash test/cutover.sh rollback      # §5 第 1 步 + 2-4 步人工指引
```

环境可调：`WAO_PORT`（默认 8792）、`OLD_BRIDGE_DIR`（默认 `../wecom-bridge`）、
`OLD_HEALTH_PORT`（默认 8791）、`ARCHIVE_DIR`（基线/中间产物目录，默认 `/tmp/wao-cutover`）。
每子命令幂等：已完成的步（bot 已建/已归档/旧桥已死）跳过并回显跳过原因；任一断言失败
即停（exit 1），修复后重跑同一子命令续走。
