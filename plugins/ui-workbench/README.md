# ui-workbench

内置工作台页面插件（M3 T2/T3）：机器人实况 + Bot 管理 + 会话钻取 + 主动推送 + 插件管理 + 时间线。
六个页面同住本插件 `ui/`（无构建 ES Module），由内核托管在 `/api/ui/ui-workbench/`。

## 页面

| 页 id | 标题 | 内容 |
| --- | --- | --- |
| `workbench` | 工作台 | bot 卡片网格：状态徽标（工作中/空闲/离线+原因）、SSE 驱动实时进度行、今日轮次/用户/会话统计、启停开关（`POST /api/bots/:id/toggle`）、编辑/试跑快捷跳转 |
| `bots` | Bot 管理 | 左侧 bot 列表+新建；右侧编辑表单——channel 选择 + `accountSchema` 动态渲染、provider 选择 + `configSchema` 动态渲染（string→输入框、password→不回显密码框、enum→下拉、bool→开关、list→每行一项多行框、object→JSON 框带解析校验）；跨 provider 切换保留 id/名称/渠道/账号并重置 providerConfig 为新 schema 默认值 + 交接提示条；删除需输入 bot id 二次确认；试跑（`POST /api/bots/:id/test`，可自定义 prompt） |
| `session` | 会话 | bot 选择后双视图：台账（chatKey 下拉来自 `/api/ledger?bot=` 的分组聚合 → user/assistant 轮次卡片，时间戳 + reason 徽标——完成绿/被打断黄/超时·错误红 + 可点「会话 …」跳原生）；原生会话（`/api/session?bot=&session=` 的 provider 本地轮次，截断/警告提示）；「导出台账 Markdown」（`/api/export?bot=` 下载） |
| `push` | 推送 | bot → chatKey（同样来自台账分组）→ 内容 textarea（4000 字上限 + 实时计数）→ `POST /api/send`；成功绿条/失败红条（服务端错误文案）；bot 未连接（离线/停用）时禁用发送并给出原因提示。**内容会真实送达企微** |
| `plugins` | 插件 | 插件表（名称/id/类型/版本/状态徽标——运行中绿·已停用灰·加载失败红，失败原因进 title 与行内）；停用经确认弹层（provider/渠道插件按 `/api/agents` 实时计算受影响机器人并点名）；重载全部插件带「会中断在跑任务」维护确认；操作后刷新列表 |
| `timeline` | 时间线 | `useTimeline(botId, windowMin)` 事件流：最新在上；kind 分色（run 开始蓝/步骤灰/工具紫/思考青/轮次绿/run 结束蓝灰）；bot 全选/单选 + 5/15/30 分钟窗口；SSE run/* 驱动 + 5 秒轮询兜底 |

## 数据面

`GET /api/agents`（实况，经 SDK `useAgents`）、`GET /api/bots`（完整记录，secret 永不回显——
编辑时密码框留空即「保持不变」，由 PATCH 的 keep-blank-password 规则落回旧值）、
`GET /api/ports`（channels/providers 清单 + 各自 schema）、`POST/PATCH/DELETE /api/bots…`、
`POST /api/bots/:id/toggle`、`POST /api/bots/:id/test`、
`GET /api/ledger?bot=[&chat=]`（台账轮次；无 chat 参数的全量形态即 chat 列表来源）、
`GET /api/session?bot=&session=`（provider 原生会话）、`GET /api/export?bot=`（Markdown 导出）、
`POST /api/send`（服务端推送）、`GET /api/plugins` + `POST /api/plugins/:id/enable|disable`
+ `POST /api/service/reload`（内核原生）、`GET /api/timeline?bot=&window=`（事件环）。

SSE：`agent/progress`/`agent/status`/`run/start`/`run/end`/`ledger/turn`（engine 在 run 进入
working、recordTurn 后与退出 working 时 emit；SDK `useTimeline`/`useAgents` 据此刷新）。

## 截图验证（改 UI 红线）

```sh
wao start   # 或 node src/index.js start
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
BASE=http://127.0.0.1:8792/api/ui/ui-workbench/harness.html
# 每页 × 深浅色（page 取 workbench|bots|session|push|plugins|timeline）
for page in workbench bots session push plugins timeline; do
  for mode in light dark; do
    flag="--force-light-mode"; [ "$mode" = dark ] && flag="--force-dark-mode"
    "$CHROME" --headless=new --disable-gpu $flag --window-size=1280,800 \
      --screenshot="/tmp/wb-$page-$mode.png" "$BASE?page=$page"
  done
done
```

假数据在 `ui/fake-data.js`（两个 bot：一 working 带 🔧 进度行、一 offline 带原因；wecom 渠道 +
dsh/claude/codex 三 provider 的真实 schema 形态；台账四轮含被打断/超时；原生会话带截断标记；
八插件含 disabled 与 failed；时间线六种 kind 全覆盖）。要截空态/错误态，改假数据再截。
深链（同 bots 页 `?select=` 模式）：`?page=session&view=native&session=<id>` 直达原生会话视图；
`?page=plugins&disable=<pluginId>` 预开停用确认弹层。
