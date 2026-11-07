# M1 盲评清单（零上下文评审专用）

你是一名**没有实现上下文**的评审者：只依据本清单 + 仓库里的用户文档（`README.md`、
`docs/PLUGIN-DEV.md`、`plugins/_template/*/README.md`）以最终用户的方式走一遍 M1。
不要读 `.superpowers/`、不要翻实现 diff 来"预判"行为——用户不会这么做。
逐字读你看到的每条输出（含错误提示）。发现任何与你预期不符的文案/行为都记录为发现项。

## 环境

- 机器：本机（darwin）。Node 在 PATH（v24.2.0，要求 ≥22.15）。仓库：
  `/Users/sky/develop/workbuddy_workspace/wecom-agent-office`
- 准备（一次性）：
  ```sh
  cd /Users/sky/develop/workbuddy_workspace/wecom-agent-office
  npm install          # 仅 ws 一个依赖
  D=$(mktemp -d /tmp/wao-blind-review.XXXXXX)   # 评审工作区（数据目录、demo 插件都放这）
  echo "$D"            # 后文所有 $D 都指它；每个 bash 会话开始时重新 export
  ```
- 本清单不触碰真实企微（bot 一律 `enabled:false`，secret 用假值）。

## 任务清单（12 条用户路径，每条给 ✓/✗ + 证据）

端口统一用 **18793**（避开 8792 默认口，防止与你环境里已有进程冲突）。

1. **读 README 起手 + doctor**：通读 `README.md` §1-§3，按它运行
   `node src/index.js doctor --data-dir "$D/data"`。
   预期：全部 `✓` 行、exit 0；其中有 `plugins: 3 plugin dirs`、三行 `cli dsh/claude/codex`
   （在位=✓，缺哪个都应是 `!` 信息行而非失败——如你这台缺 CLI，如实记录输出）。
2. **起服 + 自检**：
   ```sh
   node src/index.js start --port 18793 --data-dir "$D/data" > "$D/server.log" 2>&1 &
   echo $! > "$D/server.pid"
   curl -s localhost:18793/healthz      # 200
   curl -s localhost:18793/api/state    # plugins: core-engine/channel-wecom/provider-dsh 全 active
   curl -s localhost:18793/api/plugins  # 同上
   curl -s localhost:1879/api/state     # 故意打错端口 → 连接失败（应干净失败，不该挂死）
   ```
3. **照脚手架写一个 demo provider 插件**（照 `plugins/_template/provider/README.md` 三步）：
   ```sh
   mkdir -p "$D/plugins"    # 挂载根目录：里面只放插件目录（混入其他目录会被当插件候选报 failed）
   cp -r plugins/_template/provider "$D/plugins/review-demo"
   # 改三处：manifest.id → review-demo；PORT_ID → reviewdemo；package.json name → wao-plugin-review-demo
   vi "$D/plugins/review-demo/plugin.js" "$D/plugins/review-demo/package.json"   # 或用 sed
   ```
   注意 `_template` 自带 README 的告诫：`package.json` 的 `"type": "module"` 不可删。
4. **WAO_PLUGINS_PATH 挂载**：先 SIGINT 停掉步骤 2 的服（`kill -INT $(cat "$D/server.pid")`，
   等进程退出），再带环境变量重起：
   ```sh
   WAO_PLUGINS_PATH="$D/plugins" node src/index.js start --port 18793 --data-dir "$D/data" >> "$D/server.log" 2>&1 &
   echo $! > "$D/server.pid"
   curl -s localhost:18793/api/plugins   # 应出现第 4 个插件 review-demo 且 status active（全 active）
   ```
   提示：`WAO_PLUGINS_PATH` 指向的目录里**只该有插件目录**——扫描根里没有 plugin.js 的目录
   也会被当作插件候选，以 `status:"failed"` 出现在列表里（宁可报错不静默跳过是内核的既定语义）；
   如果你看到了这种 failed 行，先检查是不是把数据目录/日志目录混进了挂载根。
5. **契约套件跑 demo 插件**：
   ```sh
   npm run contract -- --plugin "$D/plugins/review-demo"
   ```
   预期分两步（`plugins/_template/provider/README.md` 的「契约套件」一节写了同样流程）：
   - 第一次跑：**约 9 FAIL**，报告带一行 `no profile entry for port 'reviewdemo' — running
     the FULL contract`——套件按 PORT_ID 查 `test/contract/profiles.js`，改名后没有档案，
     对回显实现按全量跑属**预期**（宁失败不静默跳过）。若你作为新手看不懂这条提示，记为发现项。
   - 照提示把 `test/contract/profiles.js` 里 `template` 档案复制一份、键改成 `reviewdemo`
     （fakeCli/events 关、history:'deferred'），再跑 → **`4 passed, 0 failed, 7 skipped`、exit 0**
     （skip=需要真 CLI 子进程语义的组，预期）。完成后
     `git checkout test/contract/profiles.js` 还原仓库（评审不留改动）。
6. **用它建 bot（enabled:false）**：
   ```sh
   curl -s -X POST localhost:18793/api/bots -H 'content-type: application/json' -d '{
     "id":"review-bot","name":"评审机器人","enabled":false,
     "channel":"wecom","account":{"botId":"review-test","secret":"review-secret-x"},
     "provider":"reviewdemo","providerConfig":{"cwd":"'"$D"'"}
   }'
   ```
   预期 200 且返回的 bot 里 **secret 不出现**（记录响应原文）。
7. **试跑 demo provider 的 echo**：
   ```sh
   curl -s -X POST localhost:18793/api/bots/review-bot/test
   ```
   预期：`code:"completed"`、`finalText` 为 `template echo: 回复：收到`（demo 插件是回显实现）。
   连跑两次，第二次也应 completed。
8. **脏输入边界**：
   ```sh
   curl -s -X POST localhost:18793/api/bots -H 'content-type: application/json' \
     -d '{"id":"bad","name":"坏","channel":"wecom","account":{"botId":"x","secret":"y"},"provider":"reviewdemo","providerConfig":{}}'
   ```
   预期 400 且错误点名 `providerConfig.cwd`；再试 `provider:"nope"` → 400 unknown provider；
   `curl -s -X DELETE localhost:18793/api/bots/none` → 404。
9. **禁用 demo 插件 → provider 下线**：
   ```sh
   curl -s -X POST localhost:18793/api/plugins/review-demo/disable   # 注意用 manifest id
   curl -s localhost:18793/api/plugins    # review-demo → disabled
   curl -s -X POST localhost:18793/api/bots/review-bot/test          # 400 provider reviewdemo unavailable
   curl -s localhost:18793/api/agents    # bot 仍在列表（enabled:false，不连企微）
   ```
10. **重新启用 → 回线**：
    ```sh
    curl -s -X POST localhost:18793/api/plugins/review-demo/enable
    curl -s -X POST localhost:18793/api/bots/review-bot/test         # 又 completed
    ```
11. **删 bot**：`curl -s -X DELETE localhost:18793/api/bots/review-bot` → `{ok:true}`；
    再 `POST /api/bots/review-bot/test` → 404。
12. **SIGINT 停服 + 收尾断言**：
    ```sh
    kill -INT $(cat "$D/server.pid"); sleep 2
    kill -0 $(cat "$D/server.pid") 2>/dev/null && echo "还在"   # 应已退出
    ls "$D/data/.lock" 2>/dev/null                               # 应不存在（锁已释放）
    curl -s --max-time 2 localhost:18793/healthz                 # 应连接失败（端口已空）
    tail -6 "$D/server.log"   # 停机阶段日志: wao: stopping (four-phase) / drain done / plugins deactivated / stopped (lock released)
    ```

可选加分项（如时间允许）：`node src/index.js doctor --data-dir "$D/data2"` 后手动
`mkdir "$D/data2/.lock" && echo $$ > "$D/data2/.lock/pid"` 再跑一次 doctor——锁行应 `✗` 且 exit 1。

## 报告格式

- 每条任务一行：`✓/✗ + 证据命令 + 输出摘录（原文粘贴，不要转述）`。
- 发现的问题分级：
  - **Critical**：用户路径走不通 / 数据丢失 / secret 泄漏；
  - **Important**：行为与文档承诺不符、错误文案误导、边界输入崩服；
  - **Minor**：文案瑕疵、可优化的诊断信息；
  - **Nit**：风格建议。
- 最后一节给总体结论：12 条各 ✓/✗ 一览 + 你作为新接手者按 README 独立理解系统花了多久、
  哪一段文档没看懂（这是文档质量的直接证据）。

---

# M2 盲评段（六任务：三 provider 真切换）

> 由 M2 计划 Task 7「盲评（零上下文子代理照清单：README→起服→建 claude bot→test 两轮→
> 切 codex→test→切回→disable/enable）」扩写固化（终评补记）。规则同 M1 段：零实现上下文、
> 不读 `.superpowers/`、不翻 diff、逐字读文案。**需要真 claude/codex CLI**（缺任一则本段
> 整体记 skip，不得用假实现替代后宣称通过）。bot 一律 `enabled:false`，不触真实企微。

## 环境

```sh
cd /Users/sky/develop/workbuddy_workspace/wecom-agent-office
D=$(mktemp -d /tmp/wao-m2-blind.XXXXXX); echo "$D"
node src/index.js start --port 18795 --data-dir "$D/data" > "$D/server.log" 2>&1 &
echo $! > "$D/server.pid"
curl -s localhost:18795/healthz   # 200 起服确认
```

## 任务清单（六条用户路径，每条给 ✓/✗ + 证据）

1. **读 README 起手**：通读 `README.md`，按它确认三 provider 插件就位
   `curl -s localhost:18795/api/plugins`（core-engine/channel-wecom/provider-dsh/
   provider-claude/provider-codex 全 active）。
2. **建 claude bot（enabled:false）**：`POST /api/bots`，provider=claude、
   `providerConfig.cwd` 指向独立临时目录（**勿与其他 bot 共用 cwd**——claude 同 cwd
   auto-memory 跨会话串扰是已披露边界）。预期 200、响应里 secret 不回显。
3. **claude test 两轮**：第一轮 `POST /api/bots/:id/test`（空体）→ `code:"completed"`、
   记下 `sessionId`；第二轮带 `{"sessionId":"<上轮>"}` → 仍 completed 且**同 sessionId**
   （resume 不新建会话；若第二轮开了新会话记 Critical）。
4. **切 codex → test**：`PATCH /api/bots/:id` `{"provider":"codex"}` → 200；再 test 一轮 →
   completed（跨 provider 台账交接；文案里不得出现「找不到会话」类错误）。
5. **切回 claude → test**：PATCH 回 claude → test 仍 completed（切回持久化：
   providerConfig 原样保留，不因切换丢失）。
6. **disable/enable provider 插件**：`POST /api/plugins/provider-claude/disable` →
   该 bot test 应 400 且错误点名 provider 不可用；`…/enable` → test 恢复 completed。
   收尾：`DELETE /api/bots/:id` → `{ok:true}`；`kill -INT $(cat "$D/server.pid")` 停服。

## 报告格式

- 同 M1 段：每任务一行 ✓/✗ + 证据（命令 + 输出原文粘贴）+ 分级发现项（Critical/Important/Minor/Nit）；
- 总体结论：六条一览 + 切换语义（resume 同 sessionId、切回配置保留）与文档承诺的出入。

---

# M3 UI 盲评段（六任务，双轨：真控制台 + harness）

> 由 M3-T7 盲评固化（当轮 52 截图逐读、零 P0/P1）。规则与 M1 段一致：**零实现上下文**，
> 不读 `.superpowers/`、不翻 diff；以最终用户方式走；**逐字读你看到的每条文案**
> （含空态、错误态、断连提示、长文本、计数提示）；发现项分级 Critical / Important /
> Minor / Nit。双轨 = 真内核控制台为主，harness 假数据桩复现特定状态佐证。

## 环境

```sh
cd /Users/sky/develop/workbuddy_workspace/wecom-agent-office
D=$(mktemp -d /tmp/wao-ui-blind.XXXXXX); echo "$D"
node src/index.js start --port 18794 --data-dir "$D/data" > "$D/server.log" 2>&1 &
echo $! > "$D/server.pid"
# 浏览器开 http://127.0.0.1:18794/（控制台 Shell + 六页导航）
# 单页 harness（假数据桩，不动真数据）：http://127.0.0.1:18794/api/ui/ui-workbench/harness.html
#   可带 ?page=<id> 与 ?state=empty|error；办公室 3D 的 harness 另有 ?dim=iso|2d ?phase=day|night
#   （深浅主题由浏览器外观决定，截图流走 CDP 仿真；手测切系统外观即可）
```

## 任务清单（六条用户路径，每条给 ✓/✗ + 证据）

1. **逐页读文案（六页 × 三态）**：`?page=workbench|bots|session|push|plugins|timeline`
   逐页走。每页至少读到：正常态一段**长文本**（超长 bot 名/长轮次正文——看截断与换行）、
   **空态**（`?state=empty`——空态该有一句说明而不是白板）、**错误态**（`?state=error` 或
   kill 内核后刷新——断连横幅应为完整句「连接已断开——后台每 5 秒自动重试」，带重试按钮；
   请求失败类是「加载…失败：<原因>」——两类文案不得混淆）。
2. **建 bot（schema 动态表单）**：bots 页新建：选 provider/channel 后表单字段随
   `/api/ports` schema 变化；正常保存成功；**secret 输入框不回显已存值**；脏输入各来一次——
   缺 cwd、name 超 30 字（计数提示 n/30 + 超长被 API 拒并点名）、未知 provider、
   非法 permission 枚举；编辑既有 bot 时不填 secret 保存 → 旧 secret 保留（PATCH 保留式回填）。
3. **试跑**：对新建 bot 点试跑（`POST /api/bots/:id/test` 语义）→ 会话/工作台出现
   completed 结果与 sessionId；试跑**不记台账**（台账页行数不涨）。
4. **切 provider**：bots 页把该 bot 的 provider 切到另一家（如 dsh→claude）保存 →
   bot 运行时重定向、无企微 attach（enabled:false 姿势）；切回后再试跑一次仍 completed。
5. **禁用插件**：plugins 页禁用一个 provider 插件 → 其 bot 的工作台卡片出现**橙点 +
   「provider 已不存在（插件被停用）」**类信号（灰字「离线」之外的第二信号）；重新启用 →
   信号消失、试跑恢复。
6. **办公室 3D 数据对应**：办公室 3D（iso/2d × 昼夜 `?dim= ?phase=`）里每个 bot 的
   呈现（工位/灯效/状态气泡）与 `/api/agents` 的 status/progress **一一对应**：把某 bot
   置 working（或改 harness `fake-data.js` 桩）→ 场景呈现随之变化；深浅两态与
   2D/ISO 两视角都看一遍。

## 报告格式

- 同 M1 段：每任务一行 ✓/✗ + 证据（命令 + 输出原文粘贴）+ 分级发现项（Critical/Important/Minor/Nit）；
- 截图佐证：所见状态用 harness 参数复现（`?page=/?state=/?dim=/?phase=`）并贴图；
- 总体结论：六条一览 + 作为新接手者哪一页/哪句文案与预期不符。

---

# W1 MCP 盲评段（七任务：真 Agent CLI 经 MCP 操作公司）

> 由 W1 T4 固化。规则同前段：**零实现上下文**，不读 `.superpowers/`、不翻 diff、逐字读文案。
> **需要真 claude CLI**（缺则本段整体记 skip，不得用假实现替代后宣称通过）。操作目标是一个
> **隔离内核**（端口 18796、临时数据目录、假通道 `fakechan`＋假岗位 `fakeprov`——工具面操作
> 不经过真实企微）；所有凭据用假值，secret 不得出现在任何回答里。

## 环境

```sh
cd /Users/sky/develop/workbuddy_workspace/wecom-agent-office
D=$(mktemp -d /tmp/wao-mcp-blind.XXXXXX); echo "$D"
node test/mcp/real-kernel.mjs --port 18796 --data-dir "$D/data" --fakes "$D/fakes" \
  > "$D/kernel.out" 2> "$D/kernel.err" &
echo $! > "$D/kernel.pid"
sleep 2; grep READY "$D/kernel.out"   # REAL-KERNEL READY port=18796
curl -s localhost:18796/healthz       # {"ok":true,...}
```

## 任务清单（七条用户路径，每条给 ✓/✗ + 证据）

1. **读文档起手**：通读 `README.md` §3.2「MCP 接入」、`docs/skills/wao-company.md`、
   `plugins/mcp-gateway/README.md`。记住三件事再往下走：13 个工具名、危险三件套
   （offboard/broadcast/department_toggle 要复述后果）、会话规则（-32002 → 重新 initialize）。
2. **curl 握手（照 README 裸 curl 冒烟）**：initialize（记录 `Mcp-Session-Id` 响应头）→
   带头 `tools/list`（应 13 个工具、中文描述）→ **故意缺头**再 tools/list（应 JSON-RPC
   `-32002` 且 message 提示 re-initialize）。逐字粘这三段响应。
3. **建种子员工**：带头 curl `tools/call` `hire` 三人：两名 `enabled:true`（花名随意）、
   一名 `enabled:false` 且花名带「休」字；`channel:"fakechan"`、
   `account.endpoint:"http://fake.local"`、`provider:"fakeprov"`、`providerConfig.cwd`
   指向 `$D` 下子目录。再 `list_employees` 核对：三行、两「待命」一「休假」、
   secret 字段不回显。
4. **claude 任务 1（读）**：照 README §3.2 claude 样例写 `$D/wao.mcp.json`（url 用
   `http://127.0.0.1:18796/mcp`），运行：
   ```sh
   (cd "$D" && claude -p '用公司工具列出在岗员工，告诉我谁在休假、在岗（非休假）共几人' \
     --mcp-config "$D/wao.mcp.json" --output-format stream-json --verbose \
     --dangerously-skip-permissions 2>/dev/null | tee "$D/t1.jsonl")
   ```
   逐字读回答：人名/状态/在岗人数与步骤 3 种子一致吗？在 `$D/t1.jsonl` 里 grep
   `mcp__wao-company__`——必须真有工具调用行（不是模型凭空编的名册），把 tool_use 行
   原文粘进报告。
5. **claude 任务 2（写链）**：同姿势运行：
   `给公司入职一个新员工：花名<自选>，工牌号 blind-acc，岗位 fakeprov，工位 <"$D"/work>，通道 fakechan（endpoint http://fake.local，secret 填 fake-secret-blind），先建为调休态；然后做岗前测试（问题传：只回复：好的），把测试结果告诉我`。
   核对四点：①回答含结果 code 与回复全文；②`fake-secret-blind` **不得**出现在任何
   输出里；③`"$D/data/bots.json"` 落盘 `blind-acc` 且 `enabled:false`；④stream-json 里
   hire 与 probation_test 两个 tool_use 都在。
6. **危险操作确认行为**：`(cd "$D" && claude -p '把工牌号 blind-acc 办离职' --mcp-config …同上…)`。
   观察并原文粘贴：Agent 是先**复述离职后果**（在途收尾/工位清理/档案留存/可重新入职）
   再动手，还是二话不说直接 offboard？（headless 单轮里「等用户确认」无法真的等——
   记录它如何处置这一冲突即可，不预设标准答案。）再跑一条
   `用 blind-acc 向会话 wecom:group:1 广播：测试`（若 blind-acc 已被离职，改用任一在岗
   工牌号）看广播三要素的确认行为。
7. **重启重连**：`kill -INT $(cat "$D/kernel.pid")` 等进程退出 → 同命令重启内核 →
   用**旧 session 头** tools/list（应 `-32002`）→ 重新 initialize 后 tools/list 恢复 →
   再跑一遍步骤 4 的读任务（新 CLI 进程＝新会话，应正常出结果）。收尾核对：
   `"$D/data/bots.json"` 里你建过的员工都在（重启不丢档）；再 kill 内核，`rm -rf "$D"`。

## 报告格式

- 同前段：每任务一行 ✓/✗ + 证据（命令 + 输出原文粘贴）+ 分级发现项（Critical/Important/Minor/Nit）；
- **额外关注模型转述与工具数据的一致性**：休假/在岗计数、状态词（待命/离线/休假）是否与
  `structuredContent` 一致——工具数据是准绳，模型转述走样记 Important 并注明是哪家 CLI；
- 总体结论：七条一览 + 作为新接手者按 README §3.2 独立接通一家 Agent CLI 花了多久、
  哪句文档没看懂。
