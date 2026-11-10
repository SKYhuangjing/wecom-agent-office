# 多模态输入支持（图片/文件）——现状分析与设计底稿

> 2026-11-10 分析沉淀。背景：企微用户给 bot 发图片/文件，今天一律被婉拒
> （`目前这个机器人只支持文字消息哦～`）。本文钉死三层事实（仓库现状 / 企微
> 协议 / 四家 provider 能力，关键项**本机实测**），给出分层设计方案与分期计划。
> 结论先行：**图片输入全链路今天就是通的**（claude 侧已实测走通 magpie 真模型），
> 卡点只在企微侧「下载+解密」这一个新模块；文件输入分级处理；dsh v1 不做。

## 1. 仓库现状（接入点与缺口）

### 1.1 入站链路（全部带 file:line）

| 环节 | 现状 | 位置 |
|---|---|---|
| 回调解析 | 只取 text / mixed 的文字部分，其余 msgtype 返回 null | `plugins/channel-wecom/adapter.js:45-55` `extractText()` |
| 非文字处理 | 统一婉拒文案 `DECLINE_NON_TEXT` | adapter.js:28,193-198 |
| 引擎入口 | `engine.onMessage({botId, chatKey, chatKind, chatid, userid, text, reqId, raw})` —— **raw 已带整帧回调**，媒体字段在引擎层已可读 | adapter.js:214 |
| prompt 组装 | `prompt = prefix ? prefix+\n\n---\n\n+msg.text : msg.text` —— **纯字符串拼接，唯一来源是 text** | `plugins/core-engine/engine.js:263` |
| runner 契约 | `{prompt, sessionId, signal, timeoutMs, onEvent}`，四家 provider 的 stdin 全是**裸字符串** | engine.js:601；各 runner（§3） |
| 台账 | recordTurn 的 user 字段 = `msg.text` | engine.js:528 |

### 1.2 缺口清单

1. **client 无 HTTP 面**：`plugins/channel-wecom/client.js` 是纯 WS 协议面（25-31 行命令集），没有 fetch/access_token 概念——媒体下载能力需要新增（好消息：企微长连接模式**不需要** access_token，见 §2）。
2. **msg 契约无附件信封**；handoff 前缀、ledger、TUI 播报全是 text 假设。
3. **四家 runner stdin 均为裸字符串**；改结构化载荷需动 4 个 runner + `test/fake-bin/` 全家 + 契约测试（codex/pi 可走 argv 附加，实际只有 claude 要改 stdin，见 §4.3）。
4. **无二进制存储先例**：`ASSET_TYPES=['skill','memory','mcp','prompt','tool']`（assets.js:19），`data/` 无 media 目录命名；但 `data/assets/<botId>/` 的「WAO 拥有目录 + manifest 记账」先例可平移（materializer.js:343-353）。
5. **出站纯文本**：五原语只有 text/markdown/stream msgtype（client.js:359-395）——出站多模态是独立缺口（企微侧其实已支持，见 §2.4）。
6. **testBotOp 单行纯文本**：robots.js:563-567 单行 input；服务端 api.js:646-662 prompt 校验 `string 1..2000` 拒绝其他类型。
7. **⚠ 前置缺陷（顺带发现，与本设计耦合）**：engine.js:217 `chatRef = msg.raw ?? chatKey`，而 adapter.push 要求 `wecom:(group|single):<id>` 字符串（adapter.js:157-160）——wecom 的 raw 是整帧对象，`String(frame)` 不匹配正则 → **后台模式 10 分钟悬崖的最终推送会被 `push rejected, bad chatRef` 丢弃**（代码推导，未运行验证；多模态信封若沿用 raw 字段应先理清这层双重语义：raw 应是「渠道可解析的 push 引用」而非原始帧）。

## 2. 企微侧事实（官方文档 101463 + 官方 SDK 源码，MIT）

### 2.1 回调体字段（钉死自 [@wecom/aibot-node-sdk](https://github.com/WecomTeam/aibot-node-sdk) `src/types/message.ts`）

| msgtype | 载荷 | 说明 |
|---|---|---|
| `image` | `image: {url, aeskey}` | **url 5 分钟内有效**，已加密；aeskey 每链接唯一 |
| `file` | `file: {url, aeskey}` | 同上；filename 从下载响应取 |
| `video` | `video: {url, aeskey}` | 同上 |
| `voice` | `voice: {content}` | **语音已转文本**——识别结果直接在回调里，支持它近乎免费 |
| `mixed` | `mixed: {msg_item: [{msgtype:'text'\|'image', text?, image?}]}` | 图文混排，**群聊可用**（裸图片仅单聊，见下） |
| `quote` | `quote: {msgtype, text?/image?/mixed?/voice?/file?}` | 引用消息同样带媒体（远期） |

**单/群限制**（官方文档）：image / file / video / voice 仅**单聊**；mixed 图文混排群聊可用 → 群用户发「图文混排」即可用到视觉能力，这是产品文案要点。

### 2.2 下载+解密（唯一硬卡点，实现 ~40 行）

- 下载：直接 GET 回调里的 `url`（**5 分钟时效 → 必须收到即下载**，不能等模型层再取）。
- 解密：AES-256-CBC；key=Base64 解码的 aeskey（32 字节）；**IV=key 前 16 字节**；
  **PKCS#7 按 32 字节块填充**——Node `decipher.setAutoPadding(false)` 手工去填
  （默认 16 字节 autopad 会 bad decrypt，SDK 源码 `src/crypto.ts` 已注释此坑，测试向量在
  `__tests__/wecom-crypto.test.ts` 可直接平移做单测）。
- **零新依赖**：Node 内置 crypto + fetch 即可，无需引 SDK。

### 2.3 机器人凭证

长连接模式回调自带每链接独立 aeskey，**无需 access_token / corp 凭证**——现有 botId+secret WS 握手已够，client 不用动。

### 2.4 出站侧（本期不做，先钉死能力）

- 流式回复可**内联图片**：`msgItem: [{msgtype:'image', image:{base64, md5}}]`；
- 文件/图片回复走三步分片上传 `aibot_upload_media_init/chunk/finish`（≤512KB/chunk Base64，≤100 chunk ≈50MB，media_id 3 天有效）；
- 主动推送 aibot_send_msg 支持 file/image/voice/video。
→ Phase 3 可做「bot 回图」（图表/截图类任务的最后一块）。

## 3. Provider 能力矩阵（关键项本机实测，2026-11-10）

| provider | 图片 | 机制 | 证据 |
|---|---|---|---|
| **claude** | ✅ | `claude -p --input-format stream-json --output-format stream-json`，user 消息 content 数组混排 `[text 块, {type:'image', source:{type:'base64', media_type, data}}]` | **本机实测 PASS**：1×1 红 PNG 经 magpie（glm-5.3-flash）回答 "Red."；纯文本信封同 PASS（`result success 'ok'`）。约束：`--input-format` 必须配 `--output-format stream-json`（WAO runner.js:107 本来就是）；stdin 管道上限 10MB |
| **codex** 0.166.0 | ✅ | `codex exec -i <FILE>...`（可多值；resume 腿 `codex exec resume <id> -i ...` 同样支持） | 本机 `codex exec --help` 实证 + 官方 flag 参考 |
| **pi** 1.5.0 | ✅ | 位置参数 `pi -p @image.png "..."`（@file 挂文本或图片进首提示；RPC 模式拒 @file——WAO 用 print 模式无碍） | 本机 `pi --help` 实证（usage 行 `[@files...]`） |
| **dsh** | ❌ v1 | DeepSeek 文本模型无视觉；stdin 裸字符串无附件概念 | 未验证 dsh 能否透传 VL 模型（标开放项） |

三家可行机制全是 **argv/位置参数或既有 stdin 面**——真正要改 stdin 载荷的只有 claude 一家。

**模型侧前置校验**：vision 走通的前提是 bot 用的模型具备视觉（本机实测用的是 `auto/glm-5.3-flash`）。**PC1 生产 bot 的 `workbuddy` 模型是否带视觉未验证**——接入前必须先发一张图实测生产模型，不行则 bot 配置需指到视觉模型（magpie 订阅内选）。

## 4. 设计方案（推荐形态）

### 4.1 总体分层

```
企微回调(image/file/mixed/voice)
  └─ adapter.extractAttachments()        ← 新增：收到即下载+解密（5分钟时效红线）
       ├─ media.js: fetch url → AES-256-CBC 解密 → 落盘 data/media/<botId>/<yyyymm>/<sha256>.<ext>
       └─ 附件信封 attachments:[{kind:'image'|'file', path, sha256, size, name, mediaType}]
  └─ engine.onMessage({...msg, attachments})   ← 契约扩展一个字段，text 语义不变
       └─ runArgs 扩展 attachments → 各 provider 扇出：
            claude: stdin 换 stream-json 信封（text 块 + image 块 base64）
            codex:  argv 追加 -i <path>...
            pi:     位置参数前插 @<path>...
            dsh:    图片走婉拒/注记（v1 无视觉）；文件照走 fileSectionFor 分级（文本内联四家通吃）
```

voice：`voice.content` 识别文本直接并入 text 路径（零新机制，仅 extractText 加一个分支）。

### 4.2 存储与安全（不可信数据红线；实现后回填 2026-11-10）

- **路径永远由 sha256 决定**，filename 只作元数据（展示用，防路径穿越；后缀不信，按 magic bytes 定 ext——货代附件后缀造假的教训）。
- 尺寸预算（盲评 P1-2 修复后为**两层**）：单图解密后 ≤4MB；**多图总量 ≤6.75MB**（解密后字节和，base64 ×4/3 后 ≤9MB——2×4MB 也会击穿 claude stdin 10MB 硬上限）。超出的逐张转注记（好图保留先到先得），runner 侧另有同口径兜底。**该总量预算只对 claude 生效**（复测 P2-2 设计表态：它是 stdin 传输约束，codex -i / pi @file 走 argv 无此上限，全局照搬会白丢好图且与试跑面行为不一致）；单条消息附件数 ≤4（渠道层卡住，与试跑面同口径）。超限文案走 too-large/too-many 分级。
- 配额与留存：per-bot 媒体目录 LRU（**实际 200MB** / 7 天清）；下载超时 **10s 且覆盖 headers+body 全程**（流式逐 chunk 计数，无 content-length 的 body 超限即断；url 失效即优雅降级为「图片下载失败，请重发」——**拒绝优于静默丢**）。
- 台账：recordTurn 增记 attachments 摘要（name/sha256/size），审计可溯。

### 4.3 文件（非图片）分级（实现后回填 2026-11-10）

| 类型 | 处理 | 说明 |
|---|---|---|
| 文本类（utf8 可解码、≤64KB、无 NUL） | 读出内联进 prompt（fenced block + 文件名标注） | 四家 provider 全部受益，零机制成本 |
| PDF | claude：工作副本落 `<cwd>/downloads/<sha256>.pdf` + 提示模型用 Read 工具读 | claude 的 Read 原生渲染 PDF；其余 provider v1 在 prompt 注记婉拒（模型向用户说明） |
| 二进制/未知 magic（xls/zip/docx…） | 落 `<cwd>/downloads/<sha256>.<ext>`（未知 → `.bin`）+ prompt 提示路径 | 模型用既有工具链处理（xlsx 技能等）；**未知类型不做内容婉拒**（回填：设计稿原写「超大/未知→婉拒」，实现按二进制落盘+路径提示——未知 ≠ 危险，路径已由 sha256 钉死） |
| 超大（>20MB 解密后 / 密文 >24MB） | 婉拒 + 分级文案（图片 4MB/文件 20MB） | 边界必测项 |
| vision 门禁 | **只对图片生效**（盲评 P1-4 修复）：文件全 provider 放行进 fileSectionFor——文本类四家全受益，拿「不支持图片」文案拦文件是指鹿为马 |

「落盘 + 提示」路径的全部基建已存在：materializer file-create 写计划/jail/manifest 先例（materializer.js:343-353）、`providerConfig.cwd` 即子进程可见目录（provider-claude/plugin.js:141）。

### 4.4 产品面

- **开关**：providerConfig 加键（如 `visionInput: bool`，默认关）——schema 加一行即自动出现在 robots.js 设置 tab（SchemaFields 零成本渲染）；claude/codex/pi 三家出，dsh 不出。
- **文案**：`DECLINE_NON_TEXT` 改为按 bot 能力分级（未开视觉/图片过大/下载失败/仅单聊支持——mixed 群聊提示用户用图文混排）。
- **试跑面**：robots.js testBotOp 加文件选择（api.js prompt 校验同步放宽 + attachments 透传 runner，api.js:646-688）。
- **成本提示**：设置页 hint 注明图片按视觉 token 计费（估 ~1-1.6k token/图，按尺寸）。

### 4.5 测试面

- 解密单测：与官方 SDK **同构的加密器自产向量**（官方 `wecom-crypto.test.ts` 是密钥占位模板、无可平移密文对——回填 2026-11-10），覆盖整块 32 字节填充/坏 padding/坏 key 边界。
- 契约测试：fake WS 服务端（channel-wecom.test.js 的 startFakeWecom）加 image/file/voice/mixed 回调注入 + 本地 http 假源站（出加密字节流）。
- fake-claude 升级：解析 stream-json 信封（现在吃裸字符串），last-prompt 断言新信封；probe-baselines 补 `--input-format stream-json` 的 init+resume 腿抓包。
- UI 基线：试跑面/设置面变化跑 `bash test/ui-shot.sh` 重截。

## 5. 分期计划

| 期 | 内容 | 量级 |
|---|---|---|
| **Phase 0（前置）** | 修 chatRef/raw 双重语义缺陷（§1.2-7，push 丢帧）；extractText 支持 voice.content | 小 |
| **Phase 1（图片 MVP，claude）** | media.js 下载+解密+落盘 → attachments 信封 → claude stdin 换 stream-json 信封（含纯文本统一迁移，已实测两条路都通）→ 单聊图片 + mixed 图文 → 文案/台账/试跑面 | 中（1-2 天） |
| **Phase 2（全 provider + 文件）** | codex -i / pi @file 扇出；文件分级处理（文本内联/PDF/二进制落盘）；配额 LRU | 中 |
| **Phase 3（出站多模态）** | 流式回复内联图片 + 分片上传回文件（bot 回图） | 独立项 |

## 6. 风险与未验证项（2026-11-10 实现完成后复核）

- [ ] **PC1 生产模型 workbuddy 是否带视觉**——仍开放：本次全部真模型验证
  （probe×2 + e2e×1）走的都是 `auto/glm-5.3-flash`；生产 bot 接入前先发一张
  图实测（不行则 bot 的 model 指到视觉款）。
- [ ] dsh 透传 VL 模型可行性（v1 不做，留观察）。
- [x] **claude `--input-format stream-json` 与 `--resume` 组合行为** ✅
  2026-11-10 实证：init 腿（1×1 红 PNG 图文信封 → "Red."）与 `--resume <id>`
  腿（同信封同图 → "Red."，system/init 重发同一 session_id `be8b060b-…`）
  均 subtype=success——会话延续与图片输入同时成立。抓包：
  `test/probe-baselines/claude-streamjson-image.ndjson` 与
  `claude-streamjson-image-resume.ndjson`。**实现决策：统一迁移**（所有轮次
  走信封，无「有附件才切」分支）——runner.js `buildEnvelope` 头注释有决策记录。
- [x] **PDF 经 stream-json document 块直传**——按设计绕开 ✅：v1 落地为
  PDF→claude 工作副本（`<cwd>/downloads/<sha256>.pdf`）+ prompt 提示 Read 工具
  （engine.js `fileSectionFor`）；非 claude 引擎婉拒注记。document 块直传仍留
  远期（未试）。
- [x] **chatRef/raw 缺陷的真实触发面** ✅ 修复 + 测试钉死：engine 侧改
  `typeof msg.raw === 'string' ? msg.raw : chatKey`（对象整帧回落 chatKey），
  测试 `test/engine/run.test.js`「background push falls back to chatKey when
  msg.raw is the whole wecom frame object」覆盖对象/字符串两腿；后台模式真实
  悬崖路径（10 分钟级）未整机复测——机制面（push 正则不再拒）已由单测证明。
- [ ] **企微回调在真实生产 bot 上的 image/file/voice 字段抓样**——仍开放：
  实现以官方 SDK types（`image:{url,aeskey}`、`file:{url,aeskey}`、
  `mixed.msg_item[]`、`voice:{content}`）为准，加解密与官方 SDK `src/crypto.ts`
  同构（SDK 1.0.6 源码逐行核对）；生产首图后应回填一份真实回调样本对齐。
- [ ] **codex `-i` / pi `@file` 的真模型端到端**——flag/usage 均本机 CLI 实证，
  fake-bin 契约测试锁定 argv 形状（`test/provider/attachment-fanout.test.js`），
  但未跑真模型看图回答；claude 侧有 e2e 金标准
  （`test/e2e/multimodal-image.realtest.js`，`WAO_E2E_MULTIMODAL=1` 显式运行）。

### 6.1 独立盲评修复回填（2026-11-10，8 条全修）

首轮交付过独立盲评，FAIL（0 P0 / 4 P1 / 4 P2），逐条修复与回归钉：

- **P1-1 下载超时只护到响应头**：`media.js fetchWithMeta` 重构——headers 与
  body 同一个 try，timer 全程不清；流式读取受 abort 保护（body 拖住 →
  read() reject → download-timeout）。回归钉：`/stall-body` 假源站
  （headers 已回 body 不来，断言 ~400ms 超时而非 undici ~300s）。
- **P1-2 多图无总量预算**：三层设防——渠道层附件数 ≤4（超出逐项注记
  too-many）；engine 层图片字节总量 ≤6.75MB（超出转 image-budget 注记，
  好图保留先到先得，size 缺席按超限处理）；claude runner 兜底按真实
  base64 长度复核（≤9MB）。回归钉：2×4MB 场景（engine 与 runner 两层）。
- **P1-3 试跑面 file 附件被 runner 静默丢**：`api.js testBotOp` 对 file 复用
  引擎同款 `fileSectionFor` 拼 prompt（PDF 分流天然生效），runner 只收
  image——行为对齐 UI 承诺。回归钉：试跑 file kind 断言 prompt 内联。
- **P1-4 vision 门禁拦文件、文案指鹿为马**：门禁只对 kind==='image'；文件
  全 provider 放行进 fileSectionFor（文本类四家全受益）。回归钉：dsh+文件
  收发进引擎 + 同 bot 纯图仍被拦。
- **P2-1 buildEnvelope 静默跳图**：跳过时（读不到/超预算）在信封 text 块尾
  追加系统注记行；删除「engine 台账可溯」的不实注释。
- **P2-2 DECLINE_NON_TEXT 失实**：重写为按能力矩阵的文案（视频等才是真不
  支持；语音/图片/文件均已支持）。移植期 "never reword" 规则随本功能作废
  （CHANGELOG 注明）。
- **P2-3 无 content-length 的 body 全量入内存后验**：流式逐 chunk 累计，
  超限即断流（与 P1-1 同一重构）。
- **P2-4 文档背离**：§4.2 配额回填实际 200MB、预算两层化；§4.3 回填
  「未知 magic → .bin 工作副本」实际行为与 vision 门禁只对图片。

## 7. 参考资料

- 企微智能机器人长连接官方文档：developer.work.weixin.qq.com/document/path/101463（各 msgtype 字段、5 分钟时效、AES 细节）
- 官方 Node SDK（MIT，解密/下载/上传移植参照）：github.com/WecomTeam/aibot-node-sdk
- claude headless stdin 10MB 上限：code.claude.com/docs/en/headless；stream-json 图片块多源印证（GitHub issue #79273 复现、Amp 兼容实现、claude-code-pi 包）
- codex 图片 flag：`codex exec --help`（-i/--image）；pi @file：`pi --help`（usage 行）
