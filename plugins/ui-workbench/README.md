# ui-workbench

内置工作台页面插件（M3 T2/T3 → company-metaphor 重设计 → W3 T4 资产科）：七个页面同住本插件 `ui/`
（无构建 ES Module），由内核托管在 `/api/ui/ui-workbench/`。

## 公司化说明（company-metaphor 重设计）

本插件已按「一家你独自经营的公司」重设计（仓库 README §4.2 有公司话↔技术词
对照表与文案原则）：UI 主层一律公司话（入职/离职/调休/工位/工牌/工单/广播…），
技术词（provider、botId、chatKey、kind）收进 tooltip/副标题；每位同事的化身由
`WAO.avatar(botId)` 生成（DiceBear notionists，全离线），同一工牌号在卡片、花名册、
日志行与工牌上是同一张脸，provider 色描边环编码岗位。`bots` 页重构为「人事部」：
入职向导五步（第 3.5 步「配发装备」可跳过，默认私发）+ 离职面谈（姓名确认）+
分组折叠员工档案；状态词统一三档工作中/待命/休假。旧页名对照：工作台→今日工作、
Bot 管理→人事部、会话→工作档案室、推送→广播站、插件→后勤部门、时间线→工作日志、
资产→资产科（页面 id 不变，锚点兼容）。

## 页面

| 页 id | 标题 | 内容 |
| --- | --- | --- |
| `workbench` | 今日工作 | bot 卡片网格：化身头像（provider 色环+岗位称呼）、状态徽标（工作中 provider 色脉动/待命/休假+原因）、SSE 驱动实时进度行（工作汇报）、今日工单/服务同事/档案数统计、调休/返岗开关（`POST /api/bots/:id/toggle`）、员工档案/岗前测试快捷跳转 |
| `bots` | 人事部 | 花名册（化身+状态）；入职向导五步（名片化身骰子/三部门岗位卡片/配发装备·可跳过·资产多选默认私发，配发失败不回滚入职、成功页点名补配/工位与门禁名单/工牌凭证）→ 工牌预览成功页（入职日期 createdAt）；员工档案分组折叠（基础/工牌凭证/岗位配置/高级）+ sticky 保存栏——channel/provider schema 动态渲染（password 不回显、enum 下拉、bool 开关、list/object 框）；转岗保留 id/姓名/渠道/账号并重置 providerConfig + 交接提示；离职面谈（后果清单+输入姓名确认）；岗前测试（`POST /api/bots/:id/test`，可自定义 prompt） |
| `assets` | 资产科 | 双视图（DESIGN-ASSETS §8.1；词表定死：配发=shared/私发=exclusive）。**资产清单**：表（类型五色徽章/名称+备注/绑定数（tooltip 点名同事与模式）/来源 控制台·Agent 自建/更新时间）+「登记资产」per-type 表单（skill 技能名+描述+正文；mcp servers JSON 编辑器（本地 JSON 校验+机密位提示「env/headers 值保存后不回显」）；prompt 正文；memory notes 每行一条；tool kind rtk·ripgrep（ripgrep 可选 extraHints））+ 编辑（type immutable；mcp `__MASKED__` 显示+「留掩码=不改」）+ 下架确认弹层（点名将解绑的配发同事与保留的私发快照）+ fan-out 失败横幅（指向装备台重物化）。**装备台**：选同事 → assetWarnings 警示条（memory 共享 cwd/rtk 不可用）+ 已装备表（资产/类型/配发·私发徽章/快照（跟源更新·落后 N 版·源已删快照独立）+ 卸下装备确认（私发副本丢失/源已删不可找回警示））+ 配发选择器（资产×模式；Agent 自建强制私发）+ 重新物化（危险确认+回执 writes/failed/notes 逐条展示） |
| `session` | 工作档案室 | bot 选择后双视图：工作档案（chatKey=部门群/同事，下拉来自 `/api/ledger?bot=` 分组聚合 → user/assistant 工单卡片，reason 徽标 + 可点「原生档案 …」跳原生）；原生档案（`/api/session?bot=&session=` 的 provider 本地轮次，截断/警告提示）；「导出工作档案」（`/api/export?bot=` 下载） |
| `push` | 广播站 | 播音员 bot → 播给谁（同样来自台账分组）→ 广播内容（4000 字上限 + 实时计数）→ `POST /api/send`；成功绿条/失败红条；播音员不在岗（离线/停用）时禁用并给出原因。**内容会真实送达企微** |
| `plugins` | 后勤部门 | 部门表（名称/id/类型/版本/状态徽标，失败原因进 title 与行内）；停用经确认弹层（provider/渠道按 `/api/agents` 实时点名受影响同事）；「部门重组」带「会中断在跑工单」维护确认；操作后刷新列表 |
| `timeline` | 工作日志 | `useTimeline(botId, windowMin)` 事件流：最新在上，每行化身头像；kind 分色公司话（开工/步骤/工具/思考/工单/收工，技术值进 title）；全部同事/单选 + 5/15/30 分钟窗口；SSE run/* 驱动 + 5 秒轮询兜底 |

## 数据面

`GET /api/agents`（实况，经 SDK `useAgents`）、`GET /api/bots`（完整记录，secret 永不回显——
编辑时密码框留空即「保持不变」，由 PATCH 的 keep-blank-password 规则落回旧值）、
`GET /api/ports`（channels/providers 清单 + 各自 schema）、`POST/PATCH/DELETE /api/bots…`、
`POST /api/bots/:id/toggle`、`POST /api/bots/:id/test`、
`GET /api/ledger?bot=[&chat=]`（台账轮次；无 chat 参数的全量形态即 chat 列表来源）、
`GET /api/session?bot=&session=`（provider 原生会话）、`GET /api/export?bot=`（Markdown 导出）、
`POST /api/send`（服务端推送）、`GET /api/plugins` + `POST /api/plugins/:id/enable|disable`
+ `POST /api/service/reload`（内核原生）、`GET /api/timeline?bot=&window=`（事件环）、
资产面 `GET/POST /api/assets`、`GET/PATCH/DELETE /api/assets/:id`（mcp 位置掩码
`__MASKED__` 回写=不改）、`POST /api/bots/:id/assets`、`DELETE
/api/bots/:id/assets/:assetId`、`POST /api/bots/:id/rematerialize-assets`（回执
rematerialized/failed/writes/notes）。

SSE：`agent/progress`/`agent/status`/`run/start`/`run/end`/`ledger/turn`（engine 在 run 进入
working、recordTurn 后与退出 working 时 emit；SDK `useTimeline`/`useAgents` 据此刷新）。

## 截图验证（改 UI 红线）

```sh
wao start   # 或 node src/index.js start
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
BASE=http://127.0.0.1:8792/api/ui/ui-workbench/harness.html
# 每页 × 深浅色（page 取 workbench|bots|assets|session|push|plugins|timeline）
for page in workbench bots assets session push plugins timeline; do
  for mode in light dark; do
    flag="--force-light-mode"; [ "$mode" = dark ] && flag="--force-dark-mode"
    "$CHROME" --headless=new --disable-gpu $flag --window-size=1280,800 \
      --screenshot="/tmp/wb-$page-$mode.png" "$BASE?page=$page"
  done
done
```

假数据在 `ui/fake-data.js`（两个 bot：一 working 带 🔧 进度行、一 offline 带原因；wecom 渠道 +
dsh/claude/codex 三 provider 的真实 schema 形态；台账四轮含被打断/超时；原生会话带截断标记；
八插件含 disabled 与 failed；时间线六种 kind 全覆盖；W3 T4 起三资产（skill/mcp·`__MASKED__` 剥敏/
memory）+ 两 bot 绑定摘要（含私发落后 1 版与源已删快照）+ assetWarnings 警示）。要截空态/错误态，
改假数据再截。
深链（同 bots 页 `?select=` 模式）：`?page=session&view=native&session=<id>` 直达原生会话视图；
`?page=plugins&disable=<pluginId>` 预开停用确认弹层；
`?page=assets&view=equip&bot=<botId>` 直达装备台，`?page=assets&new=1`/`&edit=<assetId>` 预开编辑器。
