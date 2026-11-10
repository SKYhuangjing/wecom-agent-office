# Changelog

仓库版本史（Keep a Changelog 1.1 格式；各插件明细见 `plugins/*/CHANGELOG.md`）。


## [Unreleased]

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
