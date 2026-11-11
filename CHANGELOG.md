# Changelog

仓库版本史（Keep a Changelog 1.1 格式；各插件明细见 `plugins/*/CHANGELOG.md`）。


## [Unreleased]

### Fixed — 多模态信封信息面 + 测试面中止话术（ai-service 客服 bot 交付配套，2026-11-11）

- **provider-claude runner**：送达成功的图片附件在信封文本块追加本地路径注记
  （codex `-i`/pi `@file` 走 argv 天然对模型可见，claude 的 base64 块此前不带
  路径——补齐三家信息面对齐；归档/转存类工具（如 ai-feedback --media）从此可
  引用路径）。契约 `attachment-fanout.test.js` 同步（exact text 断言放宽为
  前缀+路径包含；无图送达不注记）。
- **api.js testBotOp**：非 completed 探针的 `finalText` 不再透传引擎半截推理语
  （盲评 P1：aborted 时中间文本会被当"bot 给用户的话"），换固定话术；原文降级
  `detail.probeTail`（运维面），原始 stderrTail 维持 500 字截断不变。

### Added — 知识资产模块：呈现 + AI 自主整理 + 版本回滚（DESIGN-KNOWLEDGE，2026-11-11）

bot 的记忆/文档/提示词从黑盒变成平台一等公民资产——**看得见**（bot 维度知识 tab +
平台维度知识总览矩阵）、**理得动**（AI 整理轮：bot 用自己的引擎重整自己的知识，
人只补充引导文本，结果自动生效）、**可回滚**（版本历史）。
- **看得见**：`GET /api/bots/:id/knowledge` 聚合「提示词送达面（五家 provider 新增
  knowledgeFace 钩子：argv/盘面文件/profile/任务信封分节，secret 段只列路径不读
  内容）+ 生效记忆全文（n/50 条）+ 技能正文（>16KB 截断标注）+ 版本面 + 整理史」；
  机器人详情新「知识」tab 呈现；设置→工具库新「知识总览」tab：bot × 记忆/技能
  资产矩阵（共享/独立/未绑定），点 bot 名直达其知识 tab。
- **理得动**：`POST /api/bots/:id/curate {guidance?}` 整理轮——testBotOp 同款直跑
  通道（装备态、全新会话、settle 看门狗、CURATION_TIMEOUT_MS 300s），整理提示词
  内联全量知识+整理规则+输出协议（提案文件主通道 / ```json 围栏回退——dsh 无写
  文件面）；提案校验（拒绝优于静默纠正：notes ≤50×2KB、技能 ≤3 项、update 仅
  origin=curation 且绑定本 bot、create 不得撞名）→ 应用走既有 createAssetOp/
  updateAssetOp/bindAsset（curation 产物盖章 origin:'curation' 自动 exclusive 绑
  定本 bot）→ 整理史 `data/curation/<botId>.jsonl`（含 usage、逐项 skipped 原因）。
- **可回滚**：资产内容变更即归档 `history`（cap 12，仅内容真变才归档）；exclusive
  快照 `snapshotHistory`（cap 6）；`POST /api/assets/:id/rollback {version, botId?}`
  双作用域（registry 走 updateAssetOp 保校验+扇出；botId 定向回滚该 bot 快照）。
- **MCP 四新工具**（19→23）：`list_assets`/`get_asset`（补 Agent 盘点盲区——此前
  只能盲态绑定）、`curate_bot`/`rollback_asset`（危险级，AI 会话可直接触发整理
  与回滚，与控制台 REST 同源 companyOps）。
- **配套修复**：①既有 bug——exclusive 绑定的记忆收不到蒸馏写回（updateAssetOp
  只扇出 shared，快照永不更新）：蒸馏中间件接口升级 getMemory/writeNotes，统一经
  memoryTargetOf 解析生效目标（shared→registry；exclusive→快照覆写+snapshotHistory
  +重物化本 bot）；②cost-tracker tool kind 进白名单（经 PATCH /api/assets 改它
  不再 400）；③整理提示词的示例不再用 ```json 围栏 + 围栏解析器跳过占位痕迹
  （防模型回显示例被误当提案）。
- **自动整理三层（v1.1）**：①定时——`providerConfig.autoCurate = {enabled, at:"HH:MM", thresholdNotes, minIntervalHours}`（防御式解析，默认关/03:00/40 条/12h），60s tick 到点跑（5 分钟宽限窗；错过顺延次日不补跑；失败轮也落整理史天然防打摆）；②阈值——蒸馏写回后条数 ≥thresholdNotes 且间隔允许 → 防抖 2 分钟加跑一轮（curation 写回不触发，无自激循环）；③外部调度——REST/MCP 原生可用（卡片 hint 披露）。自动轮与手动轮完全同源（默认引导/校验/版本漂移守卫/回滚/整理史/curationLocks 互斥）；知识 tab 新增「自动整理」卡片（上次/下次/阈值/间隔编辑保存，providerConfig 整块合并提交）。
- 测试 +55（825→880）：knowledge 单测（目标解析/写回两路/历史环/提案解析校验
  矩阵/整理轮 e2e 含失败与 409 锁/回滚双作用域/聚合面）、HTTP 契约、五家
  knowledgeFace 契约、MCP 四工具（含危险门禁）。UI 基线 34→38（知识 tab +
  知识总览 × 浅深）；浏览器用户路径实测（引导→整理→回执→回滚全链）PASS。

### Changed — 引擎配置编辑面 UI 治理：结构化模型编辑器替代手写 JSON（2026-11-10 PC1 真机用户困惑）

用户在 PC1 机器人设置页问「模型输入为啥是这么写」——`model` 是 object 类型，渲染成
手写 JSON textarea（placeholder `{ "key": "value" }`），label 里塞满内部机制
（`baseURL→ANTHROPIC_BASE_URL…`）；同页还有已废弃的 progressCoT 开关在渲染。
- **form.js**：schema 带 `fields` 的 object 按子字段渲染独立输入框（表单态仍是
  JSON 文本，序列化面零改动）；子键空值即省略；`password` 子型不回显；新增
  `item.hint` 渲染位。无 fields 的 object（env 等）保持 JSON textarea。
- **五家 provider schema**：model 全部改结构化子字段（模型名/网关地址/网关密钥/
  密钥环境变量名，按家裁剪），label 收敛为「模型」，机制细节进 hint；废弃的
  progressCoT 从编辑面移除（引擎仍兼容读取存量键）；工作目录/权限模式/允许的
  工具/人设/播报文案等长 label 一并拆成「短 label + hint」。
- fake-data 同步；新增引擎配置区基线 `ui-workbench-robots-engine`（34 张）。
- 测试：结构化编辑器渲染/编辑回路（改名保留他键、补键、清唯一键置空、无
  fields 仍 textarea）+ hint 渲染 + 序列化形状不变。全量 825/825。

### Fixed — run-settle 看门狗 + adapter 换代终帧兜底 + runner abort 自愈（2026-11-10 PC1 真机 P0×2）

真机症状：①熔断 abort（61>60）触发后 claude 又跑 13 分钟自然完成（无 SIGTERM
日志=一次性 abort 监听器未触发）；②该轮 bookkeep 永不跑（inFlight 永远
working，只能重启服务）；③PATCH drain 换 adapter 后运行中轮攥旧引用，最终
回复全发向死连接丢失（send failed: websocket not open 连刷 20 分钟）。
- **runner abort 自愈**（claude/codex/pi/dsh/cursor 五家）：stdout(/stderr) data
  处理器自检 `signal?.aborted && !abortedBySignal` → 补触发 kill（startKill
  幂等）——只要进程还在输出，下一个数据包就补杀，不依赖监听器单点。
- **run-settle 看门狗**（engine）：abort 后 `runnerSettleGuardMs`（默认 15s，
  limits 可覆写）runner 仍不结算 → 强制 synth aborted 兜底，bookkeep/台账/
  inFlight 保证走完；三处 runner.run（主/lock 重试/session 自愈重试）全覆盖。
  终帧投递整段（含无超时的 onOutbound 中间件）套 `deliveryGuardMs`（默认 60s）
  绝对上限，超时置 deliveryExpired——此后所有发送静默弃（迟到帧不进旧 req_id）。
- **adapter 换代终帧兜底**：deliverFinal 检测 getAdapter 换代 → 改走当前
  adapter 的 push（chatRef 连接无关）；currentAdapter try/catch 回落旧引用
  （生产 getAdapter 缺失时是 throw，`??` 接不住）。completed 分支原直调
  sendProgress 绕过 deliverFinal 的老缺口一并修掉（后台 push 全文/流式保尾
  截断语义不变，回归钉死）。
- 测试：settle-watchdog 两腿（timeout 行落地/熔断 stopCause 保留）+ 换代
  push 兜底 + 五家自检存在性契约（行为级无法进程内模拟监听器漏触发，注释
  说明）。全量 823/823。

### Fixed — 工具徽章两处真机困惑（2026-11-10 PC1 用户问「rtk 未安装/cost-tracker 未物化什么意思」）

- **rtk 升级后误判「未安装」**：二进制明明在（/api/service/tools available），但
  升级重启时的自动 rematerialize 把 manifest 记成 unavailable。根因=`probeBin`
  默认 3s，Windows 升级后 rtk 二进制首执被 Defender 实时扫描冷启动 >3s 超时
  （ripgrep 原生快二进制不受影响）——与 scope-recall 同款冷启动坑。rtk 探测超时
  3s→**15s**（RTK_PROBE_TIMEOUT_MS，三处调用统一）。回归：fake-rtk --version 睡
  4s（>旧 3s/<新 15s）须 armed 非 unavailable（invalidateProbe 清缓存防绕过）。
- **cost-tracker「未物化」误导**：它是中间件插件，经引擎中间件链生效（token 播报）、
  不往 bot 目录写文件，物化清单天然无记录——「未物化」看着像坏了。ToolBadge 对
  中间件型工具资产（cost-tracker）改显「中间件·免物化」+ 说明 tooltip；robots.js
  与 _legacy/assets.js 两处调用同步传 kind。单测钉四分支。
- 全量 819/819；33 张 UI 基线重截。

### Added — Token 利用率观测 + 工具循环熔断（2026-11-10 PC1 治理续）

- **usage 细分落台账**：每轮 `ledger.recordTurn` 增 `usage`
  （inputTokens/cacheReadTokens/outputTokens/totalTokens），`/api/ledger` 可查
  历史缓存命中——不再只靠会淘汰的环形 timeline。旧行无此字段，消费方容忍缺失；
  `tokens`（总数）保留向后兼容。timeline usage 行同步显示「缓存读」。
- **工具循环熔断**：`providerConfig.toolLoopMaxCalls`（默认 60，0=关闭，防御式
  解析同 sessionTtlMin）——单轮 `tool` 事件计数超限即 `ac.abort()`，终帧给专用
  文案（「工具调用过多已中止，请缩小问题」），台账标 `stopCause=tool-loop`
  （reason=interrupted）。截「翻历史考古/找脚本」式失控空转（PC1 曾单轮 21.5 万
  token/11min）。熔断优先于 maintenance/普通打断文案。口径注：codex 的 tool
  事件含计划更新（update_plan），有效余量略小于其余三家（默认 60 已留余量）。
- 测试：usage 落库细分、熔断触发（超限 abort+文案+stopCause+日志）、0 关闭、
   cap 内正常完成、toolLoopMaxCalls 纯函数解析。全量 814/814。

### Changed — 记忆蒸馏优先沉淀「操作路径」（2026-11-10 PC1 token 利用率治理）

- 真机观测：main bot 一轮「查日志」空转 11.3 分钟烧掉 **215,227 token**——新会话
  丢失上下文后，bot 不知道用哪个工具查 SLS，翻历史 transcript 考古、找脚本、
  甚至自己造查询脚本。诊断反转：SLS MCP 其实 `connected`（26 工具暴露），真缺口
  是知识没锚定「用什么工具」。
- 四家 provider 的 `MEMORY_DISTILL_FOOTER` 把「操作路径——用什么工具/命令/参数
  达成某事」列为**最优先**沉淀项（新会话最需要它），并加方法形示例
  （`查某业务日志 → 用 MCP 工具 mcp__xxx__sls_execute_sql，project=P、logStore=L`）；
  保留「绝不为输出而输出」防滥用闸。回归测试钉四家一致。
- 配套（PC1 数据面，非代码）：sls-usage 技能补「查询工具」段，显式点名
  `mcp__wao-oneaix-sls__sls_execute_sql` 等并明示「别找脚本/翻历史」；补后知识探针
  立即直答正确工具+参数（15k tok，无考古）。
- 测试：dsh personaPrefix 断言由裸 `includes('MCP')` 改为数 section 头（footer
  方法示例正当地提到 MCP 工具，非 MCP 资产段）。全量 809/809。

### Fixed — 会话自愈：resume 目标在 CLI 磁盘已不存在时自动重跑（2026-11-10 PC1 真机）

- 症状：企微发图（或任意消息）报「❌ 任务未能完成：result subtype
  error_during_execution」。根因：bot 改过 `claudeConfigDir` 后，session 缓存里
  仍留着落在旧目录（`~/.claude`）的会话 id；`--resume` 撞「No conversation
  found with session ID」秒败，且缓存不退役 → 该会话此后每条消息都同样失败。
- 修复：runner（claude/codex/pi）把该失败映射成 `code='session-not-found'`；
  引擎退役缓存并以全新会话**重跑一次**（补 handoff 前缀，历史不丢）；新
  session id 正常落缓存。附带：`isSessionStale` 对**缺 `lastAt` 的 legacy
  缓存条目**判陈旧（TTL 特性上线前落盘的条目此前永不退役）。
- 回归：引擎自愈（退役→fresh→新 session 入缓存）+ runner 码映射 + legacy
  条目退役 + ttl≤0 语义不变。全量 808/808。

### Added — 多模态输入（图片/文件，DESIGN-MULTIMODAL Phase 0-2，2026-11-10）

- 企微图片/文件/图文混排/语音入站全链路（出站多模态 Phase 3 不在本次）：
  channel-wecom 新增 `media.js`（fetch→AES-256-CBC 解密→sha256/magic-bytes 寻址
  落盘，与官方 SDK 同构的 32 字节块 PKCS#7 手工去填），adapter 收到即下载
  （企微 url 5 分钟时效红线）并以 `attachments` 信封送引擎；文件分级（文本
  ≤64KB 内联 / PDF→claude 走 Read 工具 / 二进制→`<cwd>/downloads/` 路径提示 /
  >20MB 婉拒）；claude runner stdin **统一迁移** stream-json 信封（init+resume
  两腿 probe 实证，图片块 base64）；codex `-i` / pi `@file` 扇出；dsh 婉拒文案。
- 开关与产品面：providerConfig `visionInput`（claude/codex/pi，默认关，dsh 不出）
  + 试跑面附件上传（robots.js 多选文件→base64→api 按 sha256/magic-bytes 落盘
  透传 runner 直跑；/test 路由 body 上限放宽到 28MB）。媒体仓库 per-bot 200MB
  LRU + 启动清 7 天旧件。
- 前置修复（Phase 0）：chatRef/raw 双重语义（wecom 整帧对象曾让后台模式最终
  推送被 adapter.push 正则丢弃——typeof string 判定回落 chatKey）；voice 识别
  文本（`voice.content`）直入 text 路径。
- 验证：真模型 e2e 金标准（加密企微图→全链路→真 claude 答出颜色，
  `test/e2e/multimodal-image.realtest.js`）+ probe 抓包入 baselines + 新增测试
  33 例。未验证项见 DESIGN-MULTIMODAL §6（生产模型视觉/codex·pi 真模型腿/
  生产回调抓样）。
  **盲评修复（0 P0/4 P1/4 P2 全清）**：下载超时覆盖 headers+**body 全程**（弱网
  拖住 body 曾拖满 undici ~300s）+ 流式逐 chunk 计数（无 content-length 也不全量
  入内存）；附件预算两层化（adapter 卡数量/引擎+runner 卡 base64 总量 ≤9MB——
  2×4MB 曾击穿 claude stdin 10MB 裸报错）；试跑面 file kind 走 `fileSectionFor`
  同口径（曾静默丢弃）；vision 门禁只拦图片（file 全 provider 放行，dsh 用户发
  txt 曾收到「不支持图片」）；读不到的图在 prompt 注记不静默；DECLINE 文案按
  能力矩阵重写（voice 已支持）。负面回归 6 例。
  **复测轮（首轮 8/8 PASS）新增 6 P2 并全修**：试跑面 body 上限 28MB→112MB
  （4×20MB base64 ≈106.7MB——两个 15MB PDF 曾必 413；UI 侧加同口径聚合预检）；
  图片总量预算**只对 claude 生效**（stdin 传输约束；codex -i / pi @file 走 argv
  不设总量，与试跑面行为一致）；纯图无文字在引擎统一补占位（codex/pi stdin 曾
  收到空串）；mixed 超额图的 vision/too-many 双注记去重；无 path 的 image 条目
  进注记不留静默洞；文档/注释三处自查纠正。新增回归 6 例。

### Added — 工具资产 kind `scope-recall`（B 产品化，2026-11-10）

- 记忆层外部系统产品化（MEMORY-RESEARCH §4 路径 B）：检索式长期记忆
  `hermes-scope-recall` 接成第三件工具资产（rtk 状态机同款三态装备/卸载），
  仅 claude+claudeConfigDir 可绑；per-bot 记忆库落 `<claudeConfigDir>/scope-recall-store`。
  Phase 0 实证：`claude -p` 下 hooks 全触发、与 rtk 零冲突（不同文件不同事件）、
  卸载面回读干净；PyPI 包名是 `hermes-scope-recall`（`scope-recall` 名不在 PyPI）。
  双写协调 v1 决策：WAO 蒸馏保持开 + scope-recall 不配模型路由（原文检索降级模式）。
- 工具供给面加 `uv`（win zip 钉 SHA256 / mac·linux brew）——scope-recall 的安装前提
  （绑定即自动 `uv tool install hermes-scope-recall==4.0.3`（钉版），含托管 Python≥3.11
  免管理员；Win 真机面未实测）；
  装备包推荐：memory ≥35/50 条时 `GET /api/assets` 回显升级提示（UI 只展示）。
  **盲评修复（0 P0/2 P1/3 P2 全清）**：卸载改**收据属主判据**（三重门：非空绝对
  path/安装收据在位/非 unavailable 态 + jailCheck——操作者预装内容绝不按名盲删）；
  uv install 钉版；manifest 行如实记 state；setup 失败路径补记行（半装残片解绑可
  回收）；toolWarnings 按 uv 在位分文案。负面回归 5 例锁定。

### Added — 服务网络代理可配置（2026-11-10）

- 设置页「网络代理」：HTTP(S) 代理地址 + 启停 + 测试连通（负路径可读文案：代理拒连/超时/重置）；`GET/POST /api/service/network(+/test)`；`data/service.json` 原子持久化、即时生效。
- 作用面=服务自身出网三链路（检查更新/更新器 codeload 下载/工具下载）+ brew 子进程（`--proxy` 旗标 + 环境变量注入，`NO_PROXY=localhost,127.0.0.1` 红线）；provider CLI/magpie/企微 WS 刻意不经此代理。
- undici 生产依赖（ProxyAgent）；**版本配套红线**：npm undici 8 的 agent 不能注入 Node 内置 fetch（跨大版本接口校验 UND_ERR_INVALID_ARG）——代理态连 fetch 用 undici 自家的，成对缓存绝不混搭。本机实测：死端口→「代理拒连」，本机 Surge 6152→「GitHub 可达 389ms」。+6 用例，735/735 绿。

### Added — Token 优化全量落地（2026-11-09 深夜，c8b76ff..0166dfc，723/723）

- **P2-B** 岗前测试轮回 usage 读数（方言归一累计器，优化验证不等生产流量）。
- **P2-A** 会话 TTL 退役（`sessionTtlMin` 默认 45min，0=永不）+ 记忆蒸馏闭环（wao-memory 标记协议→中间件剥离→memory 资产 LRU 写回→自动重物化）。
- **P1-B** rtk/ripgrep 工具资产 seed（kind 判重）+ 创建向导默认勾选「省 token 装备包」+ claude 新建自动专属 claudeConfigDir（网关 settings 预拷）。
- **P1-A** 工具装备一键供给：设置页「工具装备」卡（rtk/ripgrep/Git Bash；SHA256 门禁+镜像回退+SFX/brew）+ `POST /api/service/restart`（updater `--restart-only`）+ doctor 前置告警（win 缺 bash=claude hook 静默失效）。
- **fix** win-autostart 参数漂移：每次 start 用当前参数重写启动器（真机实例：先启用后开 `--lan`，重启丢 LAN）。

### Changed — 术语全量收口 + 安全默认（2026-11-09）

- **MCP 12 工具改名**（标准术语，README §4.2；server 名 `wao-company` 与 skill 文件名不变）：list_employees→list_bots、get_employee→get_bot、hire→create_bot、update_employee→update_bot、offboard→delete_bot、set_duty→set_enabled、probation_test→test_bot、list_departments→list_plugins、department_toggle→toggle_plugin（参数 departmentId→pluginId）、work_log→get_ledger、work_timeline→get_timeline、company_state→get_state；结构化键 departments/employee(s)/affectedEmployees/off-duty 同步 → plugins/bot(s)/affectedBots/paused。skill 文档与盲评清单同步重写。
- **office3d 文案迁移标准术语**（在岗/休假/花名册/工单/服务同事/档案 → 工作中/离线/机器人列表/消息/服务用户/会话）；工牌标签 innerHTML→textContent（bot 名防注入，XSS 修复）。
- **WAO_TOKEN 生产启用**：launchd 实例注入令牌（API/MCP 裸访问 401；healthz/静态面豁免；doctor 实测生效）；CUTOVER 检查单增 #8；docs/launchd.plist 模板加示例。
- 文档对齐实测：README/HANDOFF（669+ 用例/契约×5/33 张基线/内核 1164 行/真实企微已切换 11-06/四家 provider+cursor）；头部加「数字类以实跑为准」声明。
- TUI 验收脚本断言对齐新文案；attach/detach 断言改指 data/logs/wao.log；生产帧存档重采 ×3。
- 根目录过程产物归档 docs/archive/；新增最小 CI（npm test + 契约×5）。

### Added — UI：AI 操作能力引导（MCP/Skill onboarding，2026-11-08）

Web 是看的，MCP/Skill 是操作的——控制台三处主动引导把 AI Agent 接到 WAO：

- **总览引导卡**：复制 MCP 配置 / 查看完整指南；状态行按 `/api/mcp` 实时显示「✓ N 个 AI 会话活跃」或未连接引导文案。
- **设置「AI 操作」section**（第一 section）：MCP 端点与 Claude / Codex / ZCode 三家接入配置（一键复制 / 下载 .json/.toml；控制台已存令牌时配置自动附 `X-WAO-Token` 头）+ 19 个 MCP 工具清单（7 个高危标记）+ `wao-company` skill 文件下载/复制 + MCP 连通性测试（无会话探测，不占会话名额）。
- **机器人详情 AI 提示行**：set_enabled / broadcast 直达话术示例（原名 set_duty，11-09 术语收口改名），一键跳设置 → AI 操作。
- **mcp-gateway**：新增 `GET /api/mcp`（会话数 + 工具清单）与 `GET /api/mcp/skill`（仓库 skill 文档全文）两个只读端点供 UI 使用（走同一 WAO_TOKEN 鉴权；MCP 协议面 `tools/list` 形状不变）。
- 测试：test/mcp/protocol.test.js 新增 /api/mcp 状态面用例；截图基线 30→33 张（settings AI section ×浅/深 + 工具清单展开态）。

### Changed — UI 术语还原：公司隐喻 → 标准产品术语（2026-11-08）

只改用户可见文案，不动代码逻辑 / API 路径 / 数据结构。对照表见 README §4.2。

- **页面更名**：人事部→机器人管理、资产科→工具库（资产清单/装备台→工具清单/工具配置）、工作档案室→会话历史（工作档案/原生档案→会话历史/引擎会话）、广播站→消息推送（播音员→发送方）、后勤部门→插件管理（部门重组→重新加载）、工作日志→活动日志。
- **操作术语**：入职/办理入职→创建机器人、离职/办离职→删除、调休/返岗→暂停/启用、技能岗位→Agent 引擎（DSH/Claude/Codex/Pi 工程师→引擎）、转岗→更换引擎、配发装备→配置工具、登记资产→添加工具、下架→删除、卸下装备→移除、门禁名单→允许用户、岗前测试→测试运行、工牌号→机器人 ID、工牌凭证→连接配置、工位→工作目录、配发→共享、私发→独立（快照独立→快照隔离）。
- **状态词**：在册/在岗→在线、休假→离线（状态四档：工作中/待命/离线/暂停）；工单→消息、今日工单→今日消息。
- **Shell**：WAO 公司→WAO Console（侧栏品牌名）、打卡钟→状态栏（在岗 N/M→在线 N/M、今日工单→今日消息）。
- **MCP 工具面**（plugins/mcp-gateway/tools.js）：19 个工具 description 与中文回执同步换标准术语（hire 描述改为「创建机器人（create_bot）」语义；工具名/API 不变）。
- **后端文案**（plugins/core-engine/）：asset 绑定回执与校验错误（配发/私发→共享/独立、资产→工具、岗位→引擎）、materializer rtk 回执（已装备→已配置）、reconcile 离线原因（`provider X 已禁用`→`引擎 X 已停用`、`channel X 已禁用`→`渠道 X 已停用`）。
- **TUI**（src/tui/）：顶栏（WAO 公司→WAO Console、在岗→在线、今日工单→今日消息）、键位栏（空格:暂停/启用 t:测试运行 b:推送 n:创建）、操作回执（已入职→已创建、已返岗/已调休→已启用/已暂停、已广播→已推送）。
- **测试**：断言上述文案的用例同步更新（test/tui/render.test.js、test/mcp/tools.test.js、test/engine/assets-api.test.js、test/contract/rtk-round.test.js）；截图基线全量重截。
- 保留项：bot.prompt 里用户自设的「企微群里的智能助手」人设；办公室 3D 可视化（是功能不是术语）。
