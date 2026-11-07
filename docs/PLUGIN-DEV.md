# PLUGIN-DEV.md — 插件开发指南

适用于 wao（Wecom Agent Office）M1 内核（`KERNEL_API=1`；端口版本 `channel/provider/ui/middleware/progressor` 均为 `1`）。
本文是写插件时的**唯一权威参考**：脚手架在 `plugins/_template/`，架构决策背景见 [DESIGN.md](./DESIGN.md) §2。

---

## 1. 定位与加载顺序

### 1.1 本系统的插件观

- **万物皆插件**：内核（`src/kernel/`）只做六件事（装载/服务容器/事件总线/生命周期/HTTP 外壳/配置），
  一切业务——引擎、IM 接入、Agent 接入、页面——都是插件。
- **自包含**：一个插件目录 = 一个发布单元。插件之间**不 import 彼此**，交互只走端口注册表与服务容器。
- **零 npm 依赖**（首期）：WebSocket 用 `ctx.ws.WebSocket`，定时器用 ctx 包装版。未来放开时走
  manifest 声明 + doctor 检查，当前版本没有这个口子。

### 1.2 目录从哪里被扫到（三层）

启动时（`createKernel` / CLI `start`）按序扫描：

1. 仓库内置 `plugins/`（repo 自带目录）；
2. 环境变量 `WAO_PLUGINS_PATH` 追加的运营方目录（冒号分隔，空段丢弃）；
3. `plugins.json` 的 enable 表（`data/plugins.json`）做最后过滤——`enabled:false` 的目录在
   loader 看到之前就被剔除，**每次 reload 重读，不缓存**。

扫描规则：根目录下的每个子目录都是一个插件候选；**`_` 前缀（`_template` 脚手架）与 `.` 前缀目录跳过**。
`plugins/_template/` 本身不会被打包装载——把它的子目录**复制**出去用（见 §2.1）。

### 1.3 激活排序（装载期，全序确定性）

所有通过 enable 过滤的插件，按以下优先级**依次**激活（实现：`src/kernel/loader.js` `orderPlugins`，Kahn 算法）：

1. **硬依赖边**：`requires.plugins` 声明的依赖严格先于依赖方激活（声明的依赖压过下面一切软偏好）；
2. **类型分层**：同拓扑层内 `core` 类型最先（引擎核心必须先于可能用到它的一切）；
3. **`manifest.order`**（默认 `10`）：运营方可调的层内微调；
4. **id 字典序**：全部打平时的最终确定性。

循环依赖：Kahn 检出，环上全部成员（含传递依赖方）记为 failed（`dependency cycle detected`），
其余插件照常激活。依赖目标不在 active 集合（disabled/failed/缺失同权）→ 依赖方 failed 并指名
（`dependency <id> unavailable`）。

---

## 2. 插件包结构

```
plugins/<id>/
├─ plugin.js        # 唯一入口：默认导出 { manifest, activate(ctx, config) }
├─ package.json     # 独立包身份；"type":"module" 必须有（见下）
├─ CHANGELOG.md     # 本插件版本史（内置插件必备）
├─ ui/              # 可选页面资源（无构建 ES Module；M3 起由内核托管）
└─ README.md
```

### 2.1 从脚手架起步（复制，不是继承）

`plugins/_template/` 下有三个**可装载**的最小插件（`provider/`、`channel/`、`page/`），
`_` 前缀保证它们自身永不入装载列表。复制三步：

1. `cp -r plugins/_template/provider plugins/<你的目录名>/`
2. 改名三处：`manifest.id`、端口注册 id（`plugin.js` 顶部的 `PORT_ID` 常量）、`package.json` 的 `name`（`wao-plugin-<id>`）。
3. 把 demo 实现换成真实逻辑，`version` 从 `0.1.0` 起步写进 CHANGELOG。

### 2.2 `package.json` 与 `"type":"module"`（必读）

```json
{ "name": "wao-plugin-template-provider", "version": "0.1.0", "type": "module", "private": true }
```

`plugin.js` 用的是 ESM 语法。Node **< 22.7** 默认把无 `type` 声明的 `.js` 按 CommonJS 解析，
于是插件直接 import 失败（报一个 V8 的 CJS 语法错误）。loader 会附一句
`(plugin dir needs package.json {"type":"module"} on Node <22.7)` 帮你诊断，但正确做法就是：
**每个插件目录都带自己的 `package.json` 且 `"type":"module"`**。本项目 engines 下限是 Node 22.15（node:zlib zstd，provider-dsh 依赖）。

---

## 3. manifest 全字段

```js
export default {
  manifest: {
    id: 'provider-myagent',        // 必填，^[a-z0-9-]+$，全局唯一（重复=后来者 failed）
    name: 'My Agent Provider',     // 展示名
    type: 'provider',              // 必填：core|channel|provider|ui|middleware|progressor
    version: '0.1.0',              // 必填，三段数字 X.Y.Z
    requires: {                    // 全部可选；出现即校验
      kernel: '^1',                // ② 内核 API 版本
      ports: { provider: '^1' },   // ③ 端口方言版本
      plugins: { 'core-engine': '^1' }, // ④ 插件间依赖
    },
    order: 10,                     // 激活排序微调（默认 10，小者先）
  },
  activate(ctx, config) { /* 注册端口/订阅/路由；可 async */ },
};
```

### 3.1 四层版本协商（装载期，不匹配 = 插件 failed + 明确文案）

| 层 | 字段 | 协商对象 | 当前值 |
|---|---|---|---|
| ① | `manifest.version` | 插件自身版本（UI 展示、`/api/plugins`） | 各插件自定 |
| ② | `requires.kernel` | 内核 API（`KERNEL_API`） | `1` |
| ③ | `requires.ports` | 端口方言版本（`PORT_VERSIONS`），各端口**独立**版本化 | `channel/provider/ui/middleware/progressor` 均 `1` |
| ④ | `requires.plugins` | 插件间依赖（激活门控 + 排序输入） | 各插件自定 |

不匹配的插件进入 `failed` 列表（`GET /api/plugins` 可见具体原因），**不影响其余插件**。
端口契约破坏性变更 = 升该端口 major；内核会同时支持新旧一版做过渡。

### 3.2 mini-semver 范围语法（内核只认这三种）

| 写法 | 语义 |
|---|---|
| `'^1.2.0'` | 同 major 且 ≥ 1.2.0（`^` 范围） |
| `'1'` | 等价 `^1.0.0`（裸主版本） |
| `'1.2.0'` | 精确匹配 |

其余写法（`~`、`>=`、`*`…）按精确串处理，基本不会如你预期——别用。

---

## 4. ctx API 全表（`activate(ctx, config)` 的第一参数）

| 成员 | 签名/形状 | 语义与清理 |
|---|---|---|
| `ctx.id` | `string` | 本插件 manifest.id（归属键） |
| `ctx.log` | logger 子实例 | 每行自动带 `[插件id]` 前缀归因；`debug/info/warn/error`、`log.child(子前缀)` |
| `ctx.config` | `object` | `plugins.json` 里本插件的 `options`（缺省 `{}`；`enabled` 已被内核消费，不会出现） |
| `ctx.events.on(topic, fn)` | → `off()` | 订阅总线；订阅者抛错/异步拒绝只归因记日志，不影响别的订阅者。deactivate 自动退订；手动 `off()` 也会从清理清单移除 |
| `ctx.events.emit(topic, payload)` | | 发布事件（同步分发） |
| `ctx.http.register({ prefix, handler })` | | prefix 必须以 `/` 开头；**最长前缀匹配**；重复/保留前缀抛错（activate 失败）。handler 抛错/异步拒绝 → 500 + 归因，不崩进程。deactivate 自动摘路由 |
| `ctx.services` | `services.register(name, obj)` / `services.get(name)` | 服务容器（core-engine 在此注册 `engine/ledger/timeline`） |
| `ctx.registerChannel(portId, impl)` | 见 §5.2 | channel 端口注册（map 端口） |
| `ctx.registerProvider(portId, impl)` | 见 §5.3 | provider 端口注册（map 端口） |
| `ctx.registerPage(desc)` | `{ id, title, icon, order }` | ui 端口注册（落在注册表 `page` map，导航元数据）。页面托管由 manifest 的 `ui: './ui'` 声明驱动（§5.4）：内核激活后把存在 `ui/index.js` 的插件收进 `/api/state.uiPlugins` 并托管在 `/api/ui/<id>/` |
| `ctx.registerMiddleware(impl)` | `{ onInbound, onOutbound }` | 入链式追加（列表端口，消费方持有的引用即最终链） |
| `ctx.registerProgressor(impl)` | `{ compose }` | 同上 |
| `ctx.setTimeout(fn, ms)` / `ctx.setInterval(fn, ms)` | → timer 句柄 | **包装版定时器**：回调抛错/异步拒绝 → 归因日志 + 跳过，interval 继续跑；句柄被追踪，deactivate 自动清理。**不要用全局 `setTimeout`**——裸定时器会在 reload 后变成幽灵 |
| `ctx.clearTimeout(t)` / `ctx.clearInterval(t)` | | 两种句柄都可被任一 clear 清（内部做了双清 + 解追踪） |
| `ctx.ws` | `{ WebSocket }` | 内核代发的 ws 客户端类——插件 WebSocket 的唯一合法来源（零 npm 依赖原则） |
| `ctx.effect(fn)` | | 注册清理函数；**deactivate 按 LIFO 逐个 await**，单个失败只记日志不阻断其余。关连接、杀子进程、flush 状态都放这里 |
| `ctx.afterAllActivated(fn)` | | 全部插件激活完（以及每次 reload 后）再执行的钩子——core-engine 用它重建 bot 运行时。失败只归因记日志；插件被卸载时未消费的回调一并丢弃 |

map 端口（channel/provider/page）重复注册同 id = **后者覆盖前者并 warn**（reload 重扫时的合法替换），
不是错误。所有注册都随 deactivate 自动撤销——插件不需要（也不应该）自己在 activate 里写注销逻辑。

---

## 5. 六端口契约签名

### 5.1 `core`（服务容器型）

```js
// activate 里：
ctx.services.register('engine', engineImpl);   // ledger / timeline 同理
// 消费方（在 requires.plugins 声明依赖后，于 afterAllActivated 中）：
const engine = ctx.services.get('engine');
```

### 5.2 `channel`（IM 侧）

```js
ctx.registerChannel('wecom', {
  capabilities: { stream: true, push: true, group: true, welcome: true,
                  maxContentChars: 3500, minIntervalMs: 2200, streamDeadlineMs: 600000 },
  accountSchema: [ { key: 'botId', label: 'Bot ID', type: 'string', required: true }, /* … */ ],
  createAdapter({ account, bot, log, engine }) {
    return {
      start(), stop(),
      status() → { state: 'connecting'|'online'|'reconnecting'|'stopped',
                   lastError, callbacks, lastCallbackAt },
      // —— 出站五原语 ——
      ack(reqId, streamId, text),               // 流式首帧
      progress(reqId, streamId, text, finish),  // 流式原地刷新
      reply(reqId, text),                       // 一次性 markdown 直发
      welcome(reqId, text),                     // enter_chat 欢迎语
      push(chatRef, text),                      // 主动推送
      // —— 入站（调 engine）——
      // engine.onMessage({ botId, chatKey, chatKind, userid, text, reqId, raw })
      // engine.onChannelEvent({ type: 'enter_chat'|'disconnected'|…, reqId, raw })
    };
  },
});
```

引擎只读 **capabilities** 决定节流/截断/流式截止，不硬编码任何 IM 参数。chatKey 三段式
`<channel>:<group|single>:<id>`。凭证类失败快速失败（退避 5 分钟封顶，防重试风暴）。

### 5.3 `provider`（Agent 侧）

```js
ctx.registerProvider('dsh', {
  configSchema: [ { key: 'cwd', type: 'string', required: true }, /* … */ ],
  validate(providerConfig) → string[],                 // [] = 合法；字段级错误文案
  materializeConfig(bot, { log }) → { changed } | null, // 可选（dsh 专用：tmp+rename 原子写 profile）
  removeConfig(bot, { log }) → { removed } | null,      // 可选：DELETE /api/bots 时清理物化产物（dsh 删 profile）
  createRunner({ bot, providerConfig, log }) {
    return {
      run({ prompt, sessionId, signal, timeoutMs, onEvent }) → {
        ok,          // true = 真完成（判据见 DESIGN §5.1，不是 exit 0 那么简单）
        code: 'completed'|'aborted'|'timeout'|'lock-conflict'|'missing-credential'|'error',
        finalText,   // 已产出文本（abort/超时也带回部分输出，可空）
        aborted,     // 显式抢占标记
        sessionId,   // 下一轮应传回的 id；首轮不传→回传新 id，续接→原样返回
        reason, detail: { exitCode, stderrTail },
      },
      readHistory(providerConfig, sessionId) → { turns, truncated, warnings }, // 容错：缺/坏/超大都不抛
    };
  },
  describeError(runResult) → string,
});
```

**run() 契约红线**：恒 resolve 不 reject；`signal` abort 后先 SIGTERM、限时升级 SIGKILL，
子进程死透才 resolve（僵尸进程持锁是已知事故类）；`onEvent` 有序同步回调，run() resolve 后不再发事件。

### 5.4 `ui`（页面）

```js
// manifest 声明 ui 目录 —— 内核托管在 /api/ui/<id>/ 并进 /api/state.uiPlugins
export default {
  manifest: { id: 'my-page', /* … */ ui: './ui' },
  activate(ctx) {
    ctx.registerPage({ id: 'my-page', title: '我的页', icon: '▤', order: 50 }); // 导航元数据（注册表 page map）
  },
};
```

**页面模块契约（DESIGN §9，写死）**：`ui/index.js` 是**无构建 ES Module**——禁 JSX、禁 bare
import；React 与 SDK 一律从注入的 `WAO` 取（`h/useState/useEffect/useCallback/api/useAgents/
useTimeline/useSSE/registerPage`）；插件内相对 import 限于自身 `ui/`。`default` 导出
`{ id, title, icon, order, component }`，`component({WAO})` 返回 h() 树（在宿主组件渲染期内被
调用，hooks 合法）。参照实现：`plugins/_template/page/ui/index.js`。

**harness（改 UI 必须截图，红线）**：每页面插件在 `ui/harness.html` 放一份桩页（模板：
`plugins/_template/page/ui/harness.html`）——加载 `/vendor/react*.umd.js` 与
`/assets/app.css`，`import '/assets/harness-lib/wao-stub.js'` 后 `makeWAOStub(假数据)` 驱动
同源 `import('./index.js')` 渲染。改完执行：

```sh
node src/index.js start --port 8792 &   # 或任一实例
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --screenshot=shot.png --window-size=1280,800 \
  http://127.0.0.1:8792/api/ui/my-page/harness.html
```

假数据注入点在 `makeWAOStub({ agents, timeline, api: { '/api/agents': … } })`——空态/错误态
（`api` 项返回 rejected promise）各截一张。

### 5.5 `middleware`

```js
ctx.registerMiddleware({ onInbound, onOutbound }); // 链式：入站消息过滤/出站掩码等
```

`maskOutbound(text)`：每个出站帧（进度/心跳/最终回复）都会过——注册表里所有具名实现依序组合，
一个都没有时用内核内置掩码（掩码永远在，不因缺实现而放行）。

`onOutbound(text, ctx)`：**只挂在最终回复**（completed 分支；进度帧与超时/打断维护文案不经过），
可改写文本（返回新字符串；返回非字符串视为未改写；抛错被隔离并记 warn——坏插件吃不掉线上回复）。
`ctx` 携带本轮运行元数据：

| 字段 | 形状 | 说明 |
| --- | --- | --- |
| `ctx.bot` | bot 记录 | 含 `assets` 绑定（按 bot 过滤的中间件在此做开关，如 cost-tracker） |
| `ctx.usage` | `{inputTokens, outputTokens, cacheReadTokens, totalTokens}` | 本轮累计（dsh/claude/codex 三种上报方言归一，`createUsageAccumulator`） |
| `ctx.model` | `string` | `providerConfig.model.model`，缺省 `'unknown'` |
| `ctx.durationMs` | `number` | 本轮耗时 |

实现样例：`plugins/cost-tracker/`（按 bot 资产绑定开关的 Token 用量尾行）。

### 5.6 `progressor`

```js
ctx.registerProgressor({ compose }); // 语义化进度：把 provider 事件流合成为进度文案
```

---

## 6. 生命周期

### 6.1 activate

- 可 `async`；loader 对每个插件 **10s 超时**（超时 = failed，且迟到的结果仍会归因记日志）。
- activate 抛错/超时的插件被**回滚**（已注册的路由/端口/订阅/定时器全部撤销）后记入 `failed`——
  半激活状态不会泄漏。
- 诚实边界：插件在首个 await 前**同步死循环**会卡死事件循环，内核无法在进程内自保——那类问题属于
  进程级托管，不属装载器。

### 6.2 失败隔离分级承诺（写插件前先读一遍）

- ✅ **可隔离可归因**：装载期 import/manifest/activate 抛错；内核中介调用——事件订阅者回调、
  HTTP handler、ctx 包装定时器回调（异常→日志+归因插件，其余不受影响）。
- ⚠️ **不可归因只可记录**：插件内部自主异步故障（自有 Promise 链/裸定时器）→ 进程级
  `unhandledRejection` 日志，不承诺恢复。**用 ctx 的包装设施就是为了留在这层之上。**
- ❌ **不在隔离范围**（单进程信任模型固有边界）：同步死循环、OOM——一个 bot 可拖死全办公室；
  缓解 = 进程托管 + agent 任务本身在子进程里跑。

### 6.3 deactivate（LIFO 清理，永不抛错）

逆激活序逐个卸载：`ctx.effect` 清理函数按 **LIFO** 逐个 await（单个失败只记日志）→ 追踪的定时器
全清 → 事件订阅全退 → 端口条目/HTTP 路由全摘 → 未消费的 `afterAllActivated` 回调作废。
你的职责只有一条：**凡 activate 里拿到的活资源（连接/子进程/句柄），要么走 ctx 包装设施，
要么注册 effect 清理**。

### 6.4 reload 四阶段与升级流程

```
POST /api/service/reload        （或库调用 kernel.reload()；并发 reload 自动串行化）
Phase 0 drain   引擎在 channel 仍存活时排空在跑任务（上限 5s）
                ⚠️ 在跑 run 会被打断：progress(..., finish=true) 附「服务维护」中止帧
Phase 1         逆序 deactivate 全部插件
Phase 2         重扫目录 + 装载激活（版本协商、plugins.json 重读）
Phase 3         afterAllActivated 重建 bot 运行时
```

**升级一个插件 = 换目录（或原地名替换文件）→ `POST /api/service/reload`**。内置与第三方动作
完全相同。loader 按 mtime 做 ESM cache-busting，原地改写 `plugin.js` 后 reload 一定装到新代码
（同毫秒改写两次的极端情形除外）。**reload 会打断在跑任务**——挑空闲窗口做。

---

## 7. 共享代码决策记录：复制即契约

**决策**：公共逻辑（如三家 provider runner 的 NDJSON 行解析）**各自内联在插件目录里，
禁止建运行时共享层**，禁止跨插件 import，禁止把公共代码放进 `node_modules` 或某个"公共插件"
里让别的插件引用。

理由：目录 = 发布单元 = 升级单元。一旦 A import B 的内部函数，B 的任何重构都可能静默弄坏 A，
版本协商对这种耦合无能为力——这正是微内核要消灭的故障类。

行为一致性不靠共享实现，靠**契约测试的共享夹具**：`test/contract/` 参数化套件
（`npm run contract -- --plugin <插件目录>`，已落地 provider 端；详见 `test/contract/README.md`）
用**同一组事件流 fixture**（`test/fake-bin/fake-dsh.js`）跑所有 provider 插件，同一组 ws 假流跑
所有 channel 插件（channel 套件后续任务落地）。要改"公共"行为 = 改 fixture = 所有插件一起红 =
逐个改实现。宁可三份小复制，也不要一个影子 lib。

---

## 8. 配置 schema 形态（accountSchema / configSchema）

channel 的 `accountSchema`（bot 的 account 块）与 provider 的 `configSchema`
（bot 的 providerConfig 块）是同一种字段描述数组：

```js
[
  { key: 'endpoint', label: 'Endpoint',  type: 'string',   required: true },
  { key: 'secret',   label: 'Secret',    type: 'password', required: true },
  { key: 'mode',     label: 'Mode',      type: 'enum',     options: ['a', 'b'], default: 'a' },
  { key: 'debug',    label: 'Debug',     type: 'bool',     default: false },
  { key: 'tags',     label: 'Tags',      type: 'list' },
  { key: 'extra',    label: 'Extra',     type: 'object' },
]
```

- `type ∈ string | password | enum | bool | list | object`；`password` 在任何 API 响应里**永不回显**
  （控制面红线，DESIGN §8）。
- `required`（缺 = `validate` 报错文案）、`default`（未填时的缺省）、`label`（UI 展示）可选。
- `validate(config) → string[]` 是权威校验：装载/升级后对 bots.json 全量 re-validate，
  非法 bot 标 `offline` + 字段级原因，**不静默、不改写用户数据**。

---

## 9. 调试

| 手段 | 说明 |
|---|---|
| `WAO_LOG_LEVEL` | `debug`/`info`/`warn`/`error`（默认 `info`）。`debug` 会打出每轮装载的端口计数等 loader 细节 |
| 日志文件 | `<dataDir>/logs/wao.log`（默认 `data/logs/wao.log`；`WAO_HOME` 或 `--data-dir` 重定向 dataDir）。10MB × 5 份轮转 |
| `GET /api/plugins` | 每个插件的 `status` 与 **failed 的具体原因**（版本协商失败、import 失败、activate 超时……文案都带插件 id 前缀） |
| `wao doctor` | Node 版本、插件目录可扫描性、dataDir 可写、端口占用、ws 可解析 |
| 隔离坏插件 | `data/plugins.json` 把嫌疑插件 `enabled:false` → `POST /api/service/reload`——二分定位是谁弄坏了装载批次；确认后再修 |
| 数据目录锁 | 同一 dataDir 只允许一个实例（`data/.lock/`）；第二个实例启动直接报 `data dir locked by pid N` |

插件日志自带 `[插件id]` 前缀（`ctx.log`），grep 它就是你的第一现场。

**disabled 插件的边界（M1-T7/T8 遗留 minor，文档面）**：`enabled:false` 只跳过 activate——
discover 阶段仍会 import 插件模块以读 manifest，**模块顶层照常求值**，且 import 没有超时兜底。
因此一个带挂起顶层 await（或顶层死循环）的**禁用**插件照样阻塞 boot/reload；插件模块必须保持
**顶层零副作用**——顶层只做 import 与常量定义，一切动作（连接/定时器/子进程/await）都进 activate。

---

## 10. 红线（违反 = 评审不过）

1. **内核禁止 import 插件**：`src/kernel/` 对插件代码的唯一接触点是 `loader.js` 的动态 import；
   任何静态 import 插件目录的代码都是违规（行数预算 <800 的内核里塞业务同样违规）。
2. **插件禁止 import 其他插件**（含"公共插件"）、禁止读其他插件的目录；交互只走端口注册表
   与服务容器。共享代码政策 = **复制即契约**（§7）。
3. **首期零 npm 依赖**：插件目录不得出现 `node_modules` 或 manifest 之外的依赖声明；
   WebSocket 用 `ctx.ws.WebSocket`，定时器用 `ctx.setTimeout/setInterval`。
4. **裸资源必须托管**：全局 `setTimeout`、自建连接、子进程——要么换 ctx 设施，要么
   `ctx.effect` 注册清理；deactivate 后 `process.getActiveResourcesInfo()` 差值应为零。
5. **`package.json` 必须带 `"type":"module"`**（§2.2，Node < 22.7 的装载地雷）。
6. **secret 永不回显**：`type:'password'` 字段不得出现在任何 API 响应/日志正文里。
