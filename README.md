# wecom-agent-office (wao) — 企微智能机器人办公室：微内核 + 插件（M1 交接版）

> 前身：`wecom-bridge`（单 bot 数据面）+ `wecom-bots`（管理面板）。本仓库是重写：
> **微内核 + 插件体系**，一切业务（引擎/企微通道/Agent provider/UI）皆插件。
> M1 交付内核 + core-engine + channel-wecom + provider-dsh；真实企微切换在 M3（见 HANDOFF.md）。

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
- 会话延续：chatKey → sessionId 缓存（`data/sessions/`），下一条消息带 `--session-id` 续跑。
- 停机 = SIGINT/SIGTERM 触发四阶段（drain 补终帧 → 逆序拆插件 → 关监听 → 释放锁），不是裸 kill。

## 2. 快速开始

```sh
npm install          # 仅一个依赖: ws
node src/index.js doctor    # 自检: node≥20.10/ws/插件扫描/数据目录可写/端口/CLI在位(dsh·claude·codex)/锁探测
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

常用操作（回环 HTTP，POST 为主）：

```sh
# 建 bot (enabled:false 只存配置不连企微 —— M3 切换的推荐姿势)
curl -X POST localhost:8792/api/bots -H 'content-type: application/json' -d '{...bot 记录...}'
curl -X POST localhost:8792/api/bots/<id>/test    # 真 dsh 试跑(不进引擎链/不记台账)
curl -X POST localhost:8792/api/bots/<id>/toggle  # 上/下线
curl -X PATCH localhost:8792/api/bots/<id> -d '{...}'   # 改配置(last-good: 失败保留旧配置)
curl -X DELETE localhost:8792/api/bots/<id>       # 删除(连同 provider-dsh 物化的 profile)
curl -X POST localhost:8792/api/service/reload    # 四阶段热重载(升级插件后)
curl -X POST localhost:8792/api/plugins/<id>/disable|enable   # 禁/启用某插件(走同一 reload)
```

响应**永不回显 secret**（API 层递归清洗）。

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

## 5. 测试矩阵

| 命令 | 内容 | 时长 |
|---|---|---|
| `npm test` | 239 用例：内核/loader/engine/ledger/provider 剖析 + e2e 六场景（fake ws + fake-dsh 全链路） | ~30s |
| `npm run contract -- --plugin plugins/provider-dsh --port dsh` | provider 端口契约 11/11（真子进程语义） | 秒级 |
| `npm run contract` | _template 参考实现（4 pass + 7 skip，skip=需真 CLI 的组） | 秒级 |
| `bash test/smoke-dsh.sh` | **真 dsh**：两轮对话记忆（同 sessionId 续跑记暗号）+ 真 session 文件解码 | ~10s+ |
| `bash test/accept-m1.sh` | **真 dsh 验收**：真内核起服 → API 建 bot → /test 两轮 completed → profile 物化/删除 → SIGINT 锁释放 | ~15s |
| `bash test/probe.sh` / `--check` | 三 CLI 事件序列基线固化/漂移检测（kill-resume、codex resume 专项） | 每 CLI ≤150s |

真 CLI 套件不在 `npm test` 内（依赖本机 dsh/凭证）；dsh 缺失时 smoke/accept 明确 skip。

## 6. 已知边界（诚实申报）

- **M1 无 Web UI**：纯 API 运维（M3 交付 Shell+workbench+3D）。
- **真实企微未接**：channel-wecom 只过了 fake openws 契约与 e2e；生产切换按 DESIGN §12 逐 bot
  串行切换（M3），切换前旧系统 wecom-bridge 继续服役。
- **锁冲突无 claim-live**：前身"GUI 占锁→界面认领"协议 M1 未实现；dsh 会话被占 →
  `code=lock-conflict` → 固定友好文案（"写锁被另一个进程占用…请稍后重试"）。
- **单进程爆炸半径**：分级承诺（DESIGN §2.5）——装载失败可隔离、内核中介调用可归因；
  但一个 bot 的同步死循环/OOM 仍可能拖死全进程，靠 M3 launchd KeepAlive 拉活，不内置守护。
- **claude/codex provider 未实现**（M2）；probe 基线已固化，升级 CLI 后 `probe.sh --check` 报漂移属预期流程。

## 7. 目录地图

| 路径 | 职责 |
|---|---|
| `src/index.js` | CLI 入口（start/doctor/version）+ `createKernel()` 装配 |
| `src/kernel/` | 微内核六件套（config 锁与原子写 / log / events / services / http / lifecycle+loader） |
| `plugins/core-engine/` | 引擎/台账/会话缓存/timeline/进度/掩码中间件 + `/api` 业务路由（api.js engine.js bots.js ledger.js sessionCache.js timeline.js middleware.js progressor.js） |
| `plugins/channel-wecom/` | 企微适配器（client.js 长连接 / adapter.js 流式·推送·欢迎语） |
| `plugins/provider-dsh/` | dsh 驱动（runner.js 子进程+事件映射 / profiles.js per-bot profile 物化 / history.js 会话史读取） |
| `plugins/_template/` | channel / provider / page 三套脚手架（`_` 前缀=内核不扫描） |
| `data/`（WAO_HOME） | bots.json / plugins.json(启用表) / ledger/*.jsonl / sessions/*.json / logs/wao.log / .lock |
| `test/` | kernel·engine·ledger·provider 单测 / contract 契约套件 / e2e 六场景 / fake-bin 假 CLI / probe-baselines 基线 / probe.sh·smoke-dsh.sh·accept-m1.sh |
| `docs/` | DESIGN.md（权威设计）· PLUGIN-DEV.md（插件开发契约） |

> 交接 Do：改插件后跑对应测试+契约；动内核先读 DESIGN §2；升级 CLI 先 `probe.sh --check`。
> Don't：别双实例（锁会拒，但别绕）；别手改 data/ 运行中文件（API 有 last-good 语义）；别在插件间 import。
