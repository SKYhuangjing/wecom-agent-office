# ui-workbench

内置工作台页面插件（M3 T2/T3 → company-metaphor 重设计 → W3 T4 资产科 → **v2 导航收敛**）：
三个页面同住本插件 `ui/`（无构建 ES Module），由内核托管在 `/api/ui/ui-workbench/`。

## v2 导航收敛（2026-11-08）

九个导航位收敛为三个（旧七页不再独立注册，文件移入 `ui/_legacy/` 作组件库复用，
未删除）：

| 页 id | 标题 | 内容 |
| --- | --- | --- |
| `overview` | 总览（落地页） | 办公室 3D 为主视觉（`WAO.getPage('office3d')` 内嵌渲染 ui-office3d 插件页面，未注册时同源兜底 import；该插件 `hidden: true` 不占导航）+ 状态卡片视图（`_legacy/list.js` 精简版：化身/状态徽标/进度行/调休返岗开关/机器人配置·测试运行快捷键）+ 最近活动摘要（最近 5 条，点击行跳机器人详情日志 tab） |
| `robots` | 机器人 | 花名册（化身+状态徽标）+ 入职向导五步（`_legacy/wizard.js`，第 3.5 步配发装备可跳过）+ 离职面谈；详情四 tab：**会话**（`_legacy/session.js` 按 bot 固定：台账 chatKey 归档 + 引擎会话钻取 + 导出）、**日志**（`_legacy/timeline.js` 按 bot 固定：5/15/30 分钟窗事件流）、**工具**（`_legacy/assets.js` 装备台精简为 per-bot：绑定表/配置/卸下/重物化 + 回执）、**设置**（`_legacy/bots.js` 编辑表单：分组折叠 + schema 动态渲染 + sticky 保存栏 + 岗前测试）+ 「发送消息」按钮（`_legacy/push.js` 精简为 dialog：选会话→填内容→`POST /api/send`） |
| `settings` | 设置 | **工具库**（`_legacy/assets.js` 整页内嵌：清单 CRUD + 装备台双视图，深链不变）、**插件**（`_legacy/plugins.js` 整页内嵌：启停/四阶段重载）、**系统信息**（/healthz 版本 + /api/state 运行时间·PID·数据目录·插件与页面清单；数据目录字段随 v2 一并入 /api/state） |

跨页交接：总览（卡片/活动行/快捷键）经 sessionStorage handoff
（`wao-robots-handoff`：`{id, tab, test}`）跳进机器人详情；顶栏状态条的链接全部指向
新三页。深链：`#/overview`、`#/robots?select=new&step=N`（向导第 N 步）、
`#/robots?select=<botId>&tab=session|logs|tools|settings`、`#/settings?section=system`、
`#/settings&view=equip&bot=<id>`（内嵌装备台）；hidden 页 `#/office3d` 仍可路由。
旧页 id（workbench/bots/assets/session/push/plugins/timeline）不再存在——书签请换新锚点。

## 公司化说明（company-metaphor 重设计）

UI 主层公司话（入职/离职/调休/工位/工单…），技术词（provider、botId、chatKey、kind）
收进 tooltip/副标题；每位同事的化身由 `WAO.avatar(botId)` 生成（DiceBear notionists，
全离线），同一 botId 在卡片、花名册、日志行上是同一张脸，provider 色描边环编码岗位；
状态词统一三档工作中/待命/休假。词表对照见仓库 README §4.2。

## 数据面

`GET /api/agents`（实况，经 SDK `useAgents`）、`GET /api/bots`（完整记录，secret 永不回显——
编辑时密码框留空即「保持不变」，由 PATCH 的 keep-blank 规则落回旧值）、
`GET /api/ports`（channels/providers 清单 + 各自 schema）、`POST/PATCH/DELETE /api/bots…`、
`POST /api/bots/:id/toggle`、`POST /api/bots/:id/test`、
`GET /api/ledger?bot=[&chat=]`（台账轮次；无 chat 参数的全量形态即 chat 列表来源）、
`GET /api/session?bot=&session=`（provider 原生会话）、`GET /api/export?bot=`（Markdown 导出）、
`POST /api/send`（服务端推送）、`GET /api/plugins` + `POST /api/plugins/:id/enable|disable`
+ `POST /api/service/reload`（内核原生）、`GET /api/timeline?bot=&window=`（事件环）、
资产面 `GET/POST /api/assets`、`GET/PATCH/DELETE /api/assets/:id`（mcp 位置掩码
`__MASKED__` 回写=不改）、`POST /api/bots/:id/assets`、`DELETE
/api/bots/:id/assets/:assetId`、`POST /api/bots/:id/rematerialize-assets`（回执
rematerialized/failed/writes/notes）。v2 起 `/api/state` 追加只读 `dataDir`。

SSE：`agent/progress`/`agent/status`/`run/start`/`run/end`/`ledger/turn`（engine 在 run 进入
working、recordTurn 后与退出 working 时 emit；SDK `useTimeline`/`useAgents` 据此刷新）。

## 截图验证（改 UI 红线）

统一走仓库脚本（CDP 精确控深浅色，30 张基线入库）：

```sh
bash test/ui-shot.sh
```

假数据在 `ui/fake-data.js`（三个 bot：一 working 带 🔧 进度行、一 offline 带原因与
assetWarnings/assetTools、一停用带 providerMissing 橙点；wecom 渠道 + dsh/claude/codex 三
provider 的真实 schema 形态；台账四轮含被打断/超时；原生会话带截断标记；八插件含
disabled 与 failed；时间线六种 kind 全覆盖；四资产 + 绑定摘要（含私发落后 1 版与源已删
快照）+ `/healthz` 与 `/api/state` 假条目供系统信息 section）。要截空态/错误态，用
`?state=empty|error` 或改假数据再截。
深链：`?view=cards`（总览卡片视图）；`?select=new&step=N`（向导第 N 步）；
`?select=<botId>&tab=…`（详情 tab）；`?section=system`（系统信息）；
`?view=equip&bot=<botId>`（内嵌装备台）、`&new=1`/`&edit=<assetId>`（资产编辑器）。
