# Changelog

仓库版本史（Keep a Changelog 1.1 格式；各插件明细见 `plugins/*/CHANGELOG.md`）。

## [Unreleased]

### Changed — 术语全量收口 + 安全默认（2026-11-09）

- **MCP 12 工具改名**（标准术语，README §4.2；server 名 `wao-company` 与 skill 文件名不变）：list_employees→list_bots、get_employee→get_bot、hire→create_bot、update_employee→update_bot、offboard→delete_bot、set_duty→set_enabled、probation_test→test_bot、list_departments→list_plugins、department_toggle→toggle_plugin（参数 departmentId→pluginId）、work_log→get_ledger、work_timeline→get_timeline、company_state→get_state；结构化键 departments/employee(s)/affectedEmployees/off-duty 同步 → plugins/bot(s)/affectedBots/paused。skill 文档与盲评清单同步重写。
- **office3d 文案迁移标准术语**（在岗/休假/花名册/工单/服务同事/档案 → 工作中/离线/机器人列表/消息/服务用户/会话）；工牌标签 innerHTML→textContent（bot 名防注入，XSS 修复）。
- **WAO_TOKEN 生产启用**：launchd 实例注入令牌（API/MCP 裸访问 401；healthz/静态面豁免；doctor 实测生效）；CUTOVER 检查单增 #8；docs/launchd.plist 模板加示例。
- 文档对齐实测：README/HANDOFF（666 用例/契约×5/33 张基线/内核 1164 行/真实企微已切换 11-06/四家 provider+cursor）；头部加「数字类以实跑为准」声明。
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
