# Wecom Agent Office — 技术架构设计稿 v3

> 日期：2026-11-05 ｜ 状态：待用户评审定稿
> 前身：`wecom-bots`（DSH 插件）+ `wecom-bridge`（独立进程）
> 一句话定位：**微内核 + 万物皆插件的无人值守多 bot 企微 Agent 办公室**——企微消息即任务，
> headless Agent 子进程干活，流式语义进度回传，Web 办公室总览。
>
> **修订记录**：v1 初稿 → v2 万物皆插件 → v2.1 独立迭代+全员可关闭 →
> **v3 吸收四路独立架构评审（内核/契约/引擎台账/运维上线）全部 6 P0 + ~20 P1**。
> 关键修订：四阶段 reload、consumedSeq 四规约、子进程处置契约、失败隔离分级承诺、
> 端口版本协商、§12 切换流程重写（配置即切换）、codex 路由事实修正、10min 两阶段模式。

---

## 0. 目标与非目标

### 目标（首期）

1. **万物皆插件**：微内核只做装载/服务容器/事件总线/生命周期/HTTP 壳/配置六件事（零业务逻辑）；
   **一切业务皆为插件**——channel、provider、UI 页面、middleware、progressor、**引擎与台账本体（core 型插件）**。
   内置插件与第三方走**完全相同的 API**。
2. **独立迭代 + 全员可关闭**：每插件独立版本/目录/CHANGELOG，换目录→reload 即升级；
   **任何插件（含内置/core 型）用户均可关闭**，系统优雅降级不崩溃。
3. **插件开发体验一等公民**：`plugins/_template/`、`docs/PLUGIN-DEV.md`、参数化契约测试套件。
4. **Provider 插件化**：首期 `dsh` / `claude` / `codex`；每 bot 独立绑定 provider。
5. **Channel 插件化**：首期只实现 `wecom`；channel 端口带**能力声明**（流式上限/节流/截断），
   引擎按能力降级，不硬编码任何 IM 的节奏参数。
6. **体验保持并升级**：即时 ack / 语义化进度（思维链上屏）/ 心跳 / latest-wins 抢占 / 并发队列 /
   只读历史 / 主动推送；**长任务 10min 两阶段模式**（流式收尾转后台+push 补发）。
7. **独立服务**：单进程 Node，终端启动，Web UI；REST+SSE 可被任何客户端驱动。
8. **Provider 切换**：同 provider 换模型原生续会话；跨 provider 台账交接（consumedSeq 规约保证正确性）。

### 非目标（首期明确不做）

- npm 远程插件市场 / `install` 命令（本地目录装载）
- 插件沙箱与权限隔离（本地信任模型——**失败隔离承诺见 §2.5 分级**，不做超物理边界承诺）
- 万物可热插拔（reload=四阶段受控重载；单插件 enable/disable 不做运行中状态迁移魔术）
- 第二个 channel、claim-live/归档隐藏（锁冲突=防线三友好文案+**同 chatKey 串行链**消除竞态）、
  图片消息、用量统计（台账留字段恒 null）、鉴权（回环绑定+`WAO_TOKEN` 预留接口 P2）、旧数据迁移
- **内置进程守护**（不内置 supervisor；提供 `docs/launchd.plist` 模板 + `doctor` 校验，见 §13）

---

## 1. 全景架构

```
终端启动: node src/index.js (127.0.0.1:8792)
┌────────────────────────────────────────────────────────────────────┐
│ src/kernel/ 微内核（零业务）：插件装载/服务容器/事件总线/生命周期/    │
│   HTTP 壳(路由+SSE+静态)/配置 ｜中介包裹(事件/路由/定时器)+ctx.ws     │
├────────────────────────────────────────────────────────────────────┤
│ plugins/ —— 一切业务皆插件                                          │
│  core-engine(type:core)  engine+ledger+timeline+默认progressor/     │
│                          middleware； bots.json 归它所有；           │
│                          注册 /api/agents|bots|ledger|session|...   │
│  channel-wecom(type:channel)  WeComClient+流式/推送+诊断页           │
│  provider-dsh / provider-claude / provider-codex（+各自 ui 页）      │
│  ui-workbench(type:ui)  list/bots/session/push/plugins 页           │
│  ui-office3d(type:ui)   办公室 3D v2 页                             │
├────────────────────────────────────────────────────────────────────┤
│ web/  Shell(导航/路由/主题/页面注册, 注入 window.WAO) + SDK          │
└────────────────────────────────────────────────────────────────────┘
```

**进程模型**：单进程。启动序列：
1. 内核初始化（配置/日志/HTTP 壳）
2. 扫描激活插件（排序规则见 §2.5）；**core-engine 在 `ctx.afterAllActivated` 钩子里**读 bots.json、
   逐 bot 从端口注册表解析 channel/provider、建运行时连 IM（core 先激活时 channel 尚未注册，
   bot 构建必须等全插件就绪——此钩子由内核提供，属通用机制）
3. 起 HTTP 监听（端口占用=第二实例，拒绝启动退出；`data/` 目录另有 flock 双保险，防换 `--port` 共享数据目录）

**停机（SIGINT/SIGTERM）= §2.5 四阶段**（drain 补终帧 → 逆序拆 → 退出），不是裸 kill。

**依赖方向**：插件注册端口实现，引擎消费注册表，不 import 任何具体插件；内核不 import 任何插件。
**业务 API 归属**：`/api/agents|bots|ledger|session|export|send|timeline` 由 core-engine 经
`ctx.http.register` 注册（内核原生仅 `/api/plugins*`、`/api/service/*`、`/api/state`、`/api/events`、
`/api/ui/*`、`/healthz`——core-engine 禁用时业务端点随之摘除，HTTP 与插件管理仍活）。

---

## 2. 插件体系

### 2.1 微内核六件事（`src/kernel/`，行数预算 <800，业务进内核即违规）

| 模块 | 职责 |
|---|---|
| `loader.js` | 扫描 `plugins/`（+`WAO_PLUGINS_PATH`）；manifest 校验（id 唯一/type 合法/**四层版本协商**）；依赖图（Kahn 检环）；按序激活；**ESM cache-busting**（`import(pathToFileURL(p)+'?t='+mtimeHash)`，防 reload 装回旧代码）；activate/import 均带超时（10s） |
| `services.js` | 服务容器 `register/get`（core-engine 注册 `engine/ledger/timeline`） |
| `events.js` | pub/sub 总线；**emit 时包裹每个订阅者回调**（异常→日志+归因到注册插件，不影响其他订阅者）；事件词汇表由 core-engine 定义发布（内核只提供机制） |
| `lifecycle.js` | activate/deactivate + `ctx.effect(cleanup)` + `ctx.afterAllActivated` 钩子 + **四阶段 reload/SIGINT 编排**（§2.5） |
| `http.js` | 插件路由注册（prefix 挂载，**handler 包裹**：异常→500+归因）、SSE、静态托管（web/dist 与插件 ui/）；**统一原子写工具**（tmp+rename） |
| `config.js` | `data/plugins.json` 读写（原子写）+ configSchema 校验 + 日志大小轮转（10MB×5） |

**内核提供的基础设施端口**（非业务，插件零 npm 依赖原则的配套）：`ctx.ws`（ws 客户端封装——
channel-wecom 唯一的外部依赖收归内核，使「import 限于自身目录+内核 API」规则自洽）、
`ctx.setTimeout/setInterval`（包装版：归因+deactivate 自动清理，兼作失败隔离中介）。
插件首期**不允许自带 npm 依赖**；未来放开时走 manifest.dependencies 声明+doctor 检查。

### 2.2 插件类型与端口（六个，锁定）

| type | 端口注册 | 首期实现 |
|---|---|---|
| `core` | `ctx.services.register(...)` | `core-engine` |
| `channel` | `ctx.registerChannel(id, {capabilities, accountSchema, createAdapter})` | `channel-wecom` |
| `provider` | `ctx.registerProvider(id, {configSchema, validate, materializeConfig, createRunner, readHistory, describeError})` | `provider-dsh/claude/codex` |
| `ui` | `ctx.registerPage({id, title, icon, order, entry})` | `ui-workbench`、`ui-office3d`、各插件自带页 |
| `middleware` | `ctx.registerMiddleware({onInbound, onOutbound})` 链式 | core-engine 内置掩码 |
| `progressor` | `ctx.registerProgressor({compose})` | core-engine 内置语义进度 |

> progressor 评审曾建议降级为内部策略；**保留**——消费方是引擎但替换成本低、契约独立，
> 符合「万物皆插件」方向。channel 端口必带 **capabilities**（§4），引擎不得硬编码 IM 节奏。

### 2.3 插件包结构

```
plugins/<id>/
├─ plugin.js        # 唯一入口：默认导出 { manifest, activate(ctx, config) }
├─ package.json     # name(wao-plugin-<id>)、version——独立包身份（首期无 dependencies）
├─ CHANGELOG.md     # 本插件版本史（内置插件必备）
├─ ui/              # 可选页面资源（无构建 ES Module，§9 契约），内核托管在 /api/ui/<id>/
└─ README.md
```

### 2.4 独立迭代（版本 · 升级 · 依赖 · 共享代码）

- **自包含**：插件目录=发布单元；**跨插件 import 禁止**（loader 静态扫描 import 来源=自身目录+内核 API；
  诚实声明：lint 级校验可被动态 import 绕过，本地信任模型下够用）。插件间交互只走端口/服务容器。
- **四层版本协商**（装载期校验，不匹配=插件 error+明确文案）：
  1. `manifest.version`（插件自身，UI 展示）
  2. `requires.kernel: '^1'`（内核 API）
  3. `requires.ports: { provider: '^2', channel: '^1', ... }`（**端口方言版本**——内核各端口独立
     版本化，破坏性变更升端口 major，内核同时支持新旧一版过渡；此层是评审 P0 补的，缺了它前句是空话）
  4. `requires.plugins: { 'core-engine': '^1' }`（可选插件间依赖；服务接口形状变更=core-engine 破坏性变更须升 major）
- **升级路径**：换目录（或原地名替换文件，cache-busting 保证装到新代码）→ `POST /api/service/reload`
  → 四阶段（§2.5）。内置与第三方动作完全相同。
- **共享代码归宿（决策：复制即契约）**：公共逻辑（如三家 runner 的 NDJSON 行解析）**各自内联、
  禁止建运行时共享层**；行为一致性由契约测试的**共享夹具**锁定（同一组事件流 fixture 跑所有 provider 插件）。
  决策记录进 PLUGIN-DEV.md——这是独立迭代最常翻车处，宁可三份小复制也不要影子 lib。
- **配置形状漂移**：插件装载/升级后对 bots.json 全量 re-validate；非法 bot 标 offline+字段级原因，
  UI 提示修复（不静默、不改写用户数据）。

### 2.5 生命周期与运行时管理

**排序规则（一句话定死）**：类型分层（core→其余）→ 拓扑序（requires.plugins）→ `order` → id 字典序。
循环依赖：Kahn 检出，环上全部成员 error+文案。**依赖目标非 active（disabled/error/缺失同权）→ 依赖方
error+原因**；disable 生效时级联重算。

**四阶段 reload / SIGINT / disable core-engine（评审 P0 补，解决「channel 先死 engine 后死」顺序悖论）**：

```
Phase 0 drain（core-engine 在 channel 仍存活时执行，超时上限 5s）：
  · 在跑 run：progress(..., finish=true) 附「⚠️ 服务维护，任务已中断，请重发」
  · 已入队任务：直接回拒绝终帧（用户至少收到 ack，不静默蒸发）
Phase 1 逆序 deactivate 全部插件（此时已无在途任务）
Phase 2 重扫目录+装载激活（含版本协商）
Phase 3 core-engine afterAllActivated 重建 bot 运行时
```

**disable 单插件**（`POST /api/plugins/:id/enable|disable`，任何插件含 core 型）：
- disable **channel-wecom**：摘入站 → 在途 run 补 finish=true 中止帧 → 关连接 → 清资源
- disable **core-engine**：先 drain（同 Phase 0）→ 依赖它的 channel bot 一并置 offline 关连接
  （不是连着收消息石沉大海）→ HTTP/插件管理仍活
- disable **provider-x**：引用它的 bot 立即 `offline+原因`（「provider-dsh 已禁用」）
- **disable 完备性=可测试**：①内核自有注册表（路由/页面/事件订阅/端口条目）逐项断言归零；
  ②`process.getActiveResourcesInfo()` deactivate 前后差值为零（Timer/ChildProcess/Socket）；
  ③test 模式 patch `setTimeout/spawn` 兜底计数——忘注册 effect 的裸资源由 ② 兜住
- **re-enable 调和**：core-engine 订阅 `plugin/lifecycle`，端口注册表变化时对 bots 做增删调和
  （provider 回来→引用 bot 重新上线；对称于 disable，不是只有单向）
- 持久化：`plugins.json {enabled:false}` 重启跳过

**失败隔离分级承诺（评审 P0 修正，验收措辞与物理边界对齐）**：
- ✅ **可隔离可归因**：装载期 import/activate 同步抛错（try/catch→error 状态）；内核中介调用——
  事件订阅者回调、HTTP handler、SSE 写、ctx 包装定时器（异常→日志+归因插件，其余不受影响）
- ⚠️ **不可归因只可记录**：插件内部自主异步故障（自有 Promise 链/裸定时器）→ process 级
  `unhandledRejection/uncaughtException` 日志（仅记录不承诺恢复）
- ❌ **不在隔离范围**（单进程信任模型固有边界，诚实申报）：同步死循环、OOM——一个 bot 拖死全办公室；
  缓解=进程托管（§13）+ 子进程隔离（agent 任务本来就是子进程）
- 插件 activate 可返回 Promise（loader race 10s 超时）

### 2.6 配置分层

| 层 | 文件 | 说明 |
|---|---|---|
| 插件级 | `data/plugins.json` | `{enabled, options}`，schema 校验，原子写 |
| bot 级 | `data/bots.json` | **归 core-engine 所有**；channel 引用+account（accountSchema 校验）；provider 引用+providerConfig（configSchema 校验） |

### 2.7 插件开发体验

1. `plugins/_template/`：channel/provider/page 三种脚手架（含 package.json/CHANGELOG 骨架）
2. `docs/PLUGIN-DEV.md`：manifest/ctx API/端口契约/四层版本协商/升级流程/共享代码决策记录/调试（reload 流）/harness 截图流
3. `test/contract/`：参数化契约套件（`run.js --plugin <id>`）：channel 用 fake ws、provider 用
   **共享事件流 fixture**（含 SIGTERM 不响应必须被 SIGKILL 的用例）、disable 完备性（资源计数三件套）、
   reload 装到新代码断言
4. `ctx` API 与端口版本化；内核改动走版本协商

---

## 3. 数据模型（`data/`，`WAO_HOME` 可重定向；目录权限 0600）

```
data/
├─ plugins.json  ├─ bots.json  ├─ ledger/<botId>.jsonl
├─ sessions/<botId>.json  └─ logs/wao.log（轮转 10MB×5）
```

**bots.json 记录**：`{ id, name, enabled, channel, account, allowedUsers, provider, providerConfig }`
（形状同 v2：channel 身份 × provider 绑定 × 执行配置）。

**台账行**（新增 `reason`，评审补——抢占/超时也记账）：

```jsonc
{ "seq": 42, "at": 0, "chatKey": "wecom:group:xxx", "channel": "wecom",
  "chatKind": "group", "chatid": "xxx", "userid": "u1",
  "user": "原文", "assistant": "已产出文本(可空)", "provider": "dsh",
  "sessionId": "session-abc", "ok": false,
  "reason": "completed" | "interrupted" | "timeout" | "error",   // ← 新
  "tokens": null, "cost": null }
```

**会话缓存**（新增 `bornCwd`，评审补——resume 与 cwd 绑定）：

```jsonc
{ "wecom:group:xxx": { "current": "dsh", "dirty": false,
    "cache": { "dsh": { "sessionId": "session-abc", "bornCwd": "/ws", "consumedSeq": 42, "consumedAtBuild": 42 },
               "claude": { "sessionId": "uuid", "bornCwd": "/ws", "consumedSeq": 17, "consumedAtBuild": 9 } } } }
```

**落盘规约（评审补，封竞态）**：
- `recordTurn` **同步 append**（appendFileSync 模式），seq++ 与 append 之间不得插 await
- 启动恢复扫 **max(seq)**（非尾行）
- reload 必须 **quiesce**（全部 run settle 后再重激活，防止新实例计数器落后重复 seq）
- `sessions/*.json`：单一内存对象同步变更 + tmp+rename 原子落盘（禁止 read-modify-write 竞态丢更新）
- `data/` 目录 **flock**（防换端口双进程写同一台账）

---

## 4. Channel 端口契约（IM 侧）

```js
ctx.registerChannel('wecom', {
  capabilities: { stream: true, push: true, group: true, welcome: true,
                  maxContentChars: 3500, minIntervalMs: 2200, streamDeadlineMs: 10*60_000 },
  accountSchema: [ {key:'botId',...}, {key:'secret', type:'password',...}, ... ],
  createAdapter({ account, bot, log, engine }) {
    return {
      start(), stop(),
      status() → { state: 'connecting'|'online'|'reconnecting'|'stopped',   // stopped=被踢停机，可区分
                   lastError, callbacks, lastCallbackAt },
      // —— 出站五原语（评审补 welcome/reply）——
      ack(reqId, streamId, text),              // 流式首帧
      progress(reqId, streamId, text, finish), // 流式原地刷新
      reply(reqId, text),                      // 一次性 markdown 直发（拒绝类/提示类文案）
      welcome(reqId, text),                    // enter_chat 欢迎语
      push(chatRef, text),                     // 主动推送（chatRef 服务端解析）
      // —— 入站 ——
      // engine.onMessage({ botId, chatKey, chatKind, userid, text, reqId, raw })
      // engine.onChannelEvent({ type:'enter_chat'|'disconnected'|..., reqId, raw })  ← 评审补
    };
  },
})
```

- chatKey 三段式 `<channel>:<group|single>:<id>`；引擎读 **capabilities** 决定节流/截断/截止时限，
  **不硬编码企微参数**（第二个 IM 接入即插即用）
- **断线窗口 final 补发**：final 发送失败→记 pending，重连后经 `push` 补发；台账不因此改判
- **凭证错误快速失败**：subscribe 鉴权类失败（非网络类）不无限退避——bot 标 error「凭证错误」，
  退避 5 分钟封顶（防重试风暴打企微接口）
- channel-wecom 移植 `WeComClient` 全部踩坑（subscribe/心跳/退避/**被踢停机不退避**/30 条限流/60s·25 条推送限流）

---

## 5. Provider 端口契约（Agent 侧）

```js
ctx.registerProvider('dsh', {
  configSchema: [...],
  validate(providerConfig) → string[],
  // 物化（dsh 专用；可选钩子）。tmp+rename 原子写；失败=保留 last-good + bot offline+原因 + API 4xx
  materializeConfig(bot, { log }) → { changed } | null,
  createRunner({ bot, providerConfig, log }) {
    return {
      // timeoutMs 由引擎按 channel capabilities 传入。
      // 契约（评审 P0）：signal abort 后 runner 必须先 SIGTERM、N 秒内升级 SIGKILL，
      // 保证子进程死透才 resolve——僵尸子进程持锁是已知事故类。
      // onEvent：有序、同步回调；run() resolve 后不再发事件。
      run({ prompt, sessionId, signal, timeoutMs, onEvent }) → {
        ok,                                        // 成功=真完成（三家判据见 §5.1）
        code: 'completed'|'aborted'|'timeout'|'lock-conflict'|'missing-credential'|'error',  // ← 机器可读，引擎不再对错误串做正则
        finalText,                                 // 已产出文本（abort/超时时也带回部分输出，可空）
        aborted,                                   // ← 显式抢占标记
        sessionId,                                 // 「下一轮应传回的 id」；resume 不回传时原样返回输入值
        reason, detail: { exitCode, stderrTail },  // 诊断字段（describeError/诊断页用）
      },
      readHistory(providerConfig, sessionId) → { turns, truncated, warnings },  // ← 容错结构（缺/坏/大文件）
    };
  },
  describeError(runResult) → string,
})
```

**会话续接契约（三家归一）**：首轮不传 sessionId、run() 回传新 id；后续传 id 续接
（dsh `--session-id` 纯 resume / claude `--resume` / codex `exec resume`）。
**abort 处置**：run() 恒 resolve 不 reject；首轮新会话被 abort → sessionId 丢弃不入缓存（半写会话不进台账）。
**bornCwd 校验**：缓存记录生成时 cwd；bot 改 cwd 后 sessionId 对 dsh（cwd+preset 匹配）与
claude（会话文件挂 cwd 哈希目录）必失效 → 视为切换走交接，不硬 resume。

### 5.1 三家适配要点与实测基线

| | dsh 0.2.1 | claude 2.1.318 | codex 0.166 |
|---|---|---|---|
| 起进程 | `dsh --profile P --json -`（`--session-id` 仅 resume，新会话省略；首事件回传新 id） | `claude -p --output-format stream-json --verbose`（stdin 传 prompt；新会话 `--session-id <uuid>`，续接 `--resume`） | `codex exec --json --skip-git-repo-check -`；续接 `codex exec resume <id>`（**resume+stdin 哨兵待 probe 复测**，回退=prompt 位置参数） |
| 模型 | profile（materialize） | `--model` | `-m` / `-c model=` |
| 权限/沙箱 | profile（presets+sandbox-policy） | `--permission-mode`+`--allowedTools` | `-s read-only\|workspace-write\|danger-full-access` |
| **模型网关路由（评审修正）** | `extraEnv`（apiKeyEnv，现状保留） | bot 级 `env`：`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`（官方文档化，✅成立） | ❌ **`OPENAI_BASE_URL` 不存在**——改走 `-c openai_base_url=...` + `-c model_provider=...` 运行时覆盖，或 materializeConfig 写 per-bot `CODEX_HOME/config.toml`；凭证 `CODEX_API_KEY`；ChatGPT OAuth token 对网关无效 |
| 成功判据 | exit 0 且 `turn_end.reason.kind==='completed'`（✅实测） | `result.subtype==='success'`（M2 复核） | exit 0 且 `turn.completed`（✅实测） |
| 事件映射 | session/status(step·reason)/text/tool_call/final | system(init)/assistant(text·thinking·tool_use)/result | thread.started/turn.started/**item.completed(reasoning·agent_message·command·file_change·mcp_tool_call·web_search·plan_update)**/turn.completed/**turn.failed·error**（评审补全，漏映射=进度与 timeline 整条丢失） |
| 只读历史 | zstd 多帧解码（移植 history.js） | `~/.claude/projects/<hash>/*.jsonl` | `~/.codex/sessions/**.jsonl` |
| 锁冲突 | code='lock-conflict' → 重试 1 次→防线三文案 | 独占冲突同文案 | 同左 |

**实测基线（2026-11-05 本机探针，`test/probe.sh` 固化）**：dsh 事件流形状/`--session-id` 纯 resume 语义/
两次推理探针无 thinking 事件（CoT 源缺失降级）；claude system-init/assistant-blocks/result、本机已路由
magpie；codex thread.started/item.completed(reasoning 文本✅)/turn.completed(reasoning_output_tokens)。
**probe.sh 两条专项已固化（2026-11-06，`test/probe-baselines/` 提交）**：dsh kill-then-resume（SIGKILL 后
`--session-id` resume **可用**，同一 sessionId 回显、上下文存活）；codex `exec resume <tid> -` 的
stdin 哨兵**可用**（新 prompt 经 stdin 生效、thread_id 回显）。基线漂移检测：`bash test/probe.sh --check`。

---

## 6. core-engine 插件：编排与等待体验

每 bot 一条流水线；全局并发默认 4（可配）。**同 chatKey 串行链（评审 P1，封抢占竞态）**：
同 chatKey 的消息串行执行——新消息到达先 abort 在跑 run，**await 其完全 settle**（子进程死透+
recordTurn+缓存落盘）后才 spawn 新 run（每 chatKey 一条 promise 链；跨 chatKey 并行不变）。
**队列合并**：同 chatKey 已排队任务被新消息**取代**（不逐条全跑）。inFlight 删除=compare-and-delete
（只删自己的控制器，防旧 run 的 finally 误删新 run 的）。

1. `onMessage` → middleware.onInbound → allowedUsers 校验 → 限流（30/min）→ 抢占/合并 → 入串行链
2. 出队：`~1s ack「✅ 收到，马上处理…」`（不可用流式时的提示走 `reply()`）
3. 解析会话：缓存命中且 `bornCwd` 匹配且非 dirty → 原生续接；否则交接（§7）；**dirty 会话（超时/异常
   kill 过）→ 同 provider 自交接**（新会话+台账前缀，复用跨 provider 代码路径，优于裸 resume）
4. `run({prompt, sessionId, signal, timeoutMs, onEvent})`；统一事件 → progressor.compose → 进度行
   出站节流按 channel capabilities；**出站统一预算 ≤28/min**（ack+事件+心跳合计，超了先停事件流保心跳，评审修正 31>30 超限）
5. 结束：成功→final finish=true（超长截断+「完整内容见会话页」）；`code` 分支→
   aborted：finalText||「已取消」+finish；timeout：走两阶段（见下）；lock-conflict：重试一次→防线三文案
6. `recordTurn`（**completed/interrupted/timeout/error 四态都记**，含部分正文）
7. **10min 两阶段模式（评审采纳）**：`T_warn≈8.5min`（=streamDeadline−缓冲）发 `finish=true`
   「⏳ 任务仍在后台运行，完成后将主动推送结果」→ run 转后台继续（硬上限 30min，仍占并发额度、
   仍可被抢占）→ 完成后 `push` 结果（超长按 60s/25 条节流分片）→ 失败/硬超时 push ⚠️。
   超时 kill 的会话标 dirty。**10min 悬崖从「杀任务」降级为「换通道」**，全部用已有原语。

### 6.1 语义化进度（progressor 默认实现·思维链上屏）

优先源（按事件新鲜度取最新，源缺失降级）：`thinking{text}` 💭末句 ≤60 字（codex✅/claude⚙️M2/dsh❌降级）
→ `tool` 🔧摘要 → `text` ✍️前 40 字 → `step`/心跳兜底。

规则（评审补三条交互细节）：
- **滞回**：正文（text）出现且仍在增长时 thinking 不接管进度行（沿用前身「无正文才显 thinking」语义），
  防交替跳行；thinking 末句为空（分片句未完）→ 回退缓存的上一个完整句
- 口头禅词表剥前缀；同句不重推；与节流天然配合
- **正文预算**：进度行+正文合计 cap 按 capabilities（企微 3500），正文区预留 ~3300、给头部进度行留量，
  防截断边界抖动
- `providerConfig.progressCoT`（默认 on）；思维链**原文只进本地 timeline/debug 日志**，企微只出末句摘要；
  出站全过 §6.2 middleware

### 6.2 middleware 端口（onInbound / onOutbound 链）

core-engine 内置：空 onInbound + 简单掩码 onOutbound（密钥模式→`***`）。链式执行，任一可改写/拒绝。

---

## 7. Ledger 与 Provider 切换

- **同 provider 换模型（P0 优先级）**：改 `providerConfig.model` → 会话不动原生续跑（三家均支持）
- **跨 provider 切换**：改 `bot.provider`（UI 明示「首轮携带近期对话摘要」）：
  - 无该 provider 缓存 → 新原生会话，`prompt = 交接前缀 + 用户消息`；前缀=该 chatKey 台账近 N 轮（默认 10）且 ≤8000 字
  - 切回（缓存命中+bornCwd 匹配+非 dirty）→ resume + **增量回放**
- **保真度声明进 UI**：交接只携带文本问答对（工具/思考/压缩状态不可迁移——跨运行时物理边界）

**consumedSeq 四规约（评审 P0，封两个构造性反例：切换后首轮未记账→切回整段历史双份；崩溃窗口→原生轮次重放）**：

1. **初始化**：构建交接前缀、与新 sessionId 落盘**同一次原子写**持久化
   `consumedSeq = consumedAtBuild = maxSeq(该 chatKey)`——前缀此刻已物理进入会话，与 run 后续成败无关
2. **推进**：该 provider 在该 chatKey 上每记一行台账（**含 interrupted/timeout/error 行**）即推进到该行 seq
3. **崩溃恢复**：启动时以台账重算 `consumedSeq(P,K) = max(落盘值, max{seq : chatKey=K ∧ provider=P})`，
   与缓存不一致以重算值覆盖并告警
4. **回放过滤**：交接/回放一律取 `chatKey=K AND provider 语义下 seq > consumedSeq`（seq 是 per-bot
   全局递增，**不过滤 chatKey 会跨会话串话**）；回放窗口同前缀上限（10 轮/8000 字），截断省略旧行时
   consumedSeq 只推进到**实际送达**的最后一行（保不变量）

---

## 8. 控制面 API（127.0.0.1:8792；**响应永不回显 secret**）

| 归属 | 方法 & 路径 | 作用 |
|---|---|---|
| 内核原生 | `GET /api/state` | 注册表+providers/channels（含 capabilities/schema）+uiPlugins+服务状态 |
| 内核原生 | `GET /api/plugins` / `POST /api/plugins/:id/enable\|disable` | 插件清单（版本/状态/依赖）/运行时启停 |
| 内核原生 | `POST /api/service/reload` | 四阶段重载 |
| 内核原生 | `GET /api/events` | SSE：`agent/*`、`run/*`、`ledger/turn`、`service/state`、`plugin/lifecycle` |
| 内核原生 | `GET /api/ui/*` | 页面插件静态资源（含 harness，§9） |
| 内核原生 | `GET /healthz` `/readyz` | 自检 |
| core-engine 注册 | `GET /api/agents` | 每 bot 实况（status/progress{line,source}/todayTurns/连接态） |
| core-engine 注册 | `POST /api/bots` `PATCH /api/bots/:id` `DELETE` `POST :id/toggle` `POST :id/test` | CRUD（校验→materialize→串行链 drain→重连）+试跑 |
| core-engine 注册 | `GET /api/ledger` `GET /api/session` `GET /api/export` `GET /api/timeline` | 台账/原生会话钻取/导出/事件环形缓冲（30min） |
| core-engine 注册 | `POST /api/send` | 主动推送 |

core-engine 禁用时其注册端点随之摘除（404），内核原生端点仍活。

---

## 9. Web UI：Shell + 页面插件 + 数据支撑层

Shell 只做导航/路由/主题/数据订阅；一切视图皆页面插件。数据支撑层=§8 REST+SSE+SDK
（`useAgents/useTimeline/useSSE/api`），视图不自己发明取数。

**页面插件模块契约（评审补，写死不留白）**：插件 `ui/` 为**无构建 ES Module**——
**禁止 JSX 与 bare import**；React 与 SDK 一律从 **`window.WAO`**（Shell 注入，含 h/createElement——
与旧 client.js 手写风格一致，移植成本低）；插件内部相对 import 限于自身 `ui/` 目录。
（备选方案「每插件 esbuild 产物」不采用：双构建边界复杂，无构建直用够用。）

**harness 截图工作流（评审修正加载方式）**：harness 由内核静态托管（`GET /api/ui/<id>/harness.html`），
**同源 dynamic import** 页面插件（file:// 下会被 opaque-origin CORS 拦，评审指出旧 `<script src>`
方案对新契约不成立）；harness 提供 `window.WAO` stub（React stub+registerPage 收集器+假数据）——
这是「页面插件独立渲染独立截图独立盲评」成立的全部前提。无头 Chrome 命令行仅换 URL。

页面来源：`ui-workbench`（list/bots/session/push/**plugins 插件管理页**）、`ui-office3d`
（办公室 3D v2：头顶任务卡=语义进度、屏幕=timeline、工位徽标=provider 形象；保留投影/BFS/DOM 名牌，
重画视觉）、各 channel/provider 自带页（wecom 诊断、dsh 会话浏览器）。
技术：React 18 vendored UMD + esbuild 打包 Shell/SDK 进 `web/dist`（产物提交）；插件 ui/ 无构建直用。

---

## 10. 目录结构

```
wecom-agent-office/
├─ package.json            # deps: ws（内核提供 ctx.ws 用）；devDeps: esbuild
├─ src/index.js            # start [--port][--data-dir] | doctor（含 launchd/依赖/插件体检）| version
├─ src/kernel/             # 微内核（§2.1，<800 行）
├─ plugins/
│  ├─ _template/  ├─ core-engine/  ├─ channel-wecom/
│  ├─ provider-dsh/  ├─ provider-claude/  ├─ provider-codex/
│  ├─ ui-workbench/  └─ ui-office3d/
├─ web/                    # shell.jsx + sdk.js + vendor/ + dist/ + 各插件 harness 由内核托管
├─ test/
│  ├─ kernel/              # 装载/检环/失败隔离分级/cache-busting/四阶段 reload
│  ├─ contract/            # 参数化套件：共享事件流 fixture（含 SIGTERM 不死→必被 SIGKILL）、
│  │                       # disable 完备性三件套、reload 新代码断言
│  ├─ engine/              # 串行链 settle/队列合并/compare-and-delete/两阶段/出站预算
│  ├─ ledger/              # consumedSeq 四规约（含两个评审反例的回归用例）
│  ├─ fake-bin/  ├─ probe.sh（+kill-then-resume、codex resume+stdin）  └─ smoke.sh
├─ docs/DESIGN.md  docs/PLUGIN-DEV.md  docs/launchd.plist（KeepAlive+RunAtLoad 模板）
└─ data/
```

---

## 11. 测试与验收（对齐全局交付红线）

- **内核**：排序规则/检环/依赖级联（disabled·error·缺失同权）/失败隔离**分级**（中介可归因、裸异步只记日志
  ——验收措辞按分级写，不写物理不可能的承诺）/四阶段 reload（drain 补终帧、队列拒绝帧）/cache-busting
- **契约**：channel 五原语+capabilities+状态机（被踢=stopped 不退避）/provider run() 全字段
  （code 枚举/aborted 部分输出/timeoutMs/SIGKILL 升级）/readHistory 容错 fixture（缺/坏/大）
- **engine/ledger**：串行链（抢占后立即新消息不锁冲突）/队列合并/两阶段（8.5min finish、push 补发、
  dirty 标记）/出站预算 ≤28/min（事件风暴用例）/consumedSeq 四规约 + **反例 A/B 回归**/落盘规约
  （max(seq) 恢复、quiesce、flock）
- **用户路径实测**：真实企微消息×三 provider 全链路（换模型/互切/交接生效/超时转后台）；UI 逐页逐字
  （空态/错误态/长文本）
- **独立盲评**：零上下文子代理盲测 UI+CLI+**照 _template 写 demo 插件跑通契约套件**；修复复测至清零
- **边界必测**：空文本/非文本/CLI 缺失/凭证缺失（code=missing-credential 文案）/超长/抢占/端口占用/
  data flock/schema 非法值/坏插件不倒服务（分级语义）/disable 各插件零残留+引用方降级/**secret 互换串号核对**（回调计数落在预期 bot）
- **运维演练**：冷启动自愈（重启进程 bots.json 驱动自动重连）/launchd 模板安装验收

## 12. 上线切换（评审 P0 重写：**切换点=新系统首个 bot 连接成功之时，不是 disable 旧插件之时**）

**事实**：单 bot 单连接、新 subscribe 踢旧连接——**配置即切换**；企微断线期间消息不补发（秒级窗口，需知情接受）。

1. **前置基线**：记录旧系统 8791 `/healthz` 两 bot connected/callbacks 基线（回滚对照）
2. **逐 bot 串行切换**（不并行）：bot 保存为 `enabled:false`（只存配置不连）→ 低峰窗口 toggle →
   **此刻旧系统该 bot 被踢** → 立即发测试消息验收（回复正确+`/api/agents` 该 bot callbacks 增长、
   另一 bot 不增长——**防 secret 互换串号**）→ 通过再切下一个 bot；失败即刻回滚该 bot（见 5）
3. 全部 bot 切换并验收后：**DSH GUI disable 旧 wecom-bots 插件**（停旧桥、释放 8791）
4. **上线 24h 内**冷启动演练：重启新服务，验证自动重连（无人值守自愈验收）
5. **回滚固定顺序**：① 新系统 disable 两 bot（或停进程——必须先做，否则新旧互踢死循环）
   → ② GUI enable 旧插件（1.2s 自动拉起旧桥）→ ③ 验证 8791 healthz 两 bot connected → ④（可选）导出新系统期间台账
6. 旧目录**归档=不动路径只读**（DSH 插件安装 target=绝对路径，移动即失效）

## 13. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| **reload 的真实成本**（升级=连接断开+任务中断） | 四阶段 drain 保终帧；升级选低峰；probe/契约测试前置 |
| **单进程爆炸半径**（一个 bot 的同步死循环/OOM 拖死全办公室） | 分级承诺诚实申报（§2.5）；launchd KeepAlive 拉活；agent 任务本就是子进程；主进程 kill -9 → 孤儿 agent 子进程继续跑：runner 注入父 pid、子进程侧周期检查父亡自退（P1 实现） |
| consumedSeq 复杂度 | 四规约+反例回归测试锁死；实现集中在 ledger 模块单点 |
| 三家事件形状漂移 | §5.1 基线存档；宽松解析+未知事件降级 debug；升级重跑 probe.sh（含 kill-then-resume） |
| 思维链可得性 | codex✅/claude M2 验证/dsh M1 复测；§6.1 降级链兜底 |
| claude/codex kill 后 resume 未定义行为 | dirty 标记+同 provider 自交接（§6 第 3/7 条）；probe.sh kill-then-resume 补基线 |
| 10min 企微流式上限 | 两阶段模式（8.5min finish 转后台+push 补发） |
| **安全面（诚实申报）** | 本机任意进程可控制 bot/读明文 secret（回环无鉴权的固有边界）：响应永不回显 secret；data/ 0600；`WAO_TOKEN` 简单鉴权预留 P2 接口 |
| 无人值守 vs 无内置守护 | launchd.plist 模板+doctor 校验；非目标声明「不内置守护」 |
| 无人值守孤儿子进程 | 父 pid 注入+子进程自退（见上） |

## 14. 里程碑

- **M1 内核+插件体系+wecom+dsh**：kernel 六件套（含四阶段 reload/失败隔离分级/cache-busting/
  依赖图）/四层版本协商/契约套件+_template+PLUGIN-DEV.md；core-engine（**串行链/队列合并/
  consumedSeq 四规约/两阶段**）+channel-wecom+provider-dsh；语义进度（dsh 降级）+timeline；
  内核原生+core-engine API；fake-bin 绿；真实企微+dsh 端到端。
- **M2 claude+codex+切换**：两 provider（**codex 网关路由按 §5.1 修正实现**）及 history 页；claude thinking
  验证；probe 补 kill-then-resume 与 codex resume+stdin；同 provider 换模型；跨 provider 交接/切回（反例回归绿）；试跑 API。
- **M3 Web UI+验收**：Shell+SDK（window.WAO 契约）+SSE/timeline；ui-workbench（含插件管理页）+
  ui-office3d v2；harness 内核托管截图流；盲评清零；按 **§12 逐 bot 串行切换**上线+冷启动演练。
