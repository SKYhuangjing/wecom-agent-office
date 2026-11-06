# Changelog

本插件版本史（Keep a Changelog 1.1 格式；版本号与 `manifest.version` 同步）。

## [Unreleased]

公司比喻重设计（company-metaphor，仓库 README §4.2 有公司话↔技术词对照表）。

### Added

- 人事部（原 Bot 管理）：入职向导四步（名片化身骰子/三部门岗位卡片/工位与门禁名单/工牌凭证）+ 成功页工牌预览（入职日期来自 createdAt）。
- 离职面谈：后果清单 + 输入姓名确认（误输禁用）+ 办结 toast；员工档案分组折叠（基础/工牌凭证/岗位配置/高级）+ sticky 保存栏 + 在岗/调休开关。
- 「头像即化身」：DiceBear notionists 全离线，同一 botId 在卡片/花名册/日志行/工牌上同脸，provider 色描边环（WAO.avatar 契约）。
- 五页公司化：今日工作（化身卡+今日工单/服务同事/档案数）、工作档案室、广播站、后勤部门（部门重组）、工作日志（每行化身+开工/收工/工单）；空态全部改邀请式公司话。

### Changed

- 状态词三档：工作中（provider 色脉动）/待命/休假；技术词（provider/botId/chatKey/kind）收进 tooltip/副标题，后果说明（真实送达企微、仅文本问答对迁移、密钥不回显）信息不减。

## [0.1.0] - 2026-11-06

初始发布。

### Added

- 工作台列表页与 bots CRUD：schema 驱动动态表单（消费 /api/state 的端口 schema）。
- 会话查看器、主动推送面板、插件管理页 + timeline/run/ledger SSE 实时事件。
- harness 截图基线（21 张）供回归对照。

### Fixed

- PATCH 深合并保留被剥离的嵌套只写字段；切回草稿重置初始化。
- 盲评 P2：人性化告警文案、名称长度上限、断连反馈、provider 缺失信号、timeline 注记。
- 密钥回显脱敏、SSE 防抖、Safari 兼容（已知边界波）。
