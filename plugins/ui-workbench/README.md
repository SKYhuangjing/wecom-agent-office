# ui-workbench

内置工作台页面插件（M3 T2）：机器人实况 + Bot 管理（CRUD 动态表单）。后续任务（T3）会在同一
插件的 `ui/` 下继续追加会话/推送/插件管理/时间线页。

## 页面

| 页 id | 标题 | 内容 |
| --- | --- | --- |
| `workbench` | 工作台 | bot 卡片网格：状态徽标（工作中/空闲/离线+原因）、SSE 驱动实时进度行、今日轮次/用户/会话统计、启停开关（`POST /api/bots/:id/toggle`）、编辑/试跑快捷跳转 |
| `bots` | Bot 管理 | 左侧 bot 列表+新建；右侧编辑表单——channel 选择 + `accountSchema` 动态渲染、provider 选择 + `configSchema` 动态渲染（string→输入框、password→不回显密码框、enum→下拉、bool→开关、list→每行一项多行框、object→JSON 框带解析校验）；跨 provider 切换保留 id/名称/渠道/账号并重置 providerConfig 为新 schema 默认值 + 交接提示条；删除需输入 bot id 二次确认；试跑（`POST /api/bots/:id/test`，可自定义 prompt） |

## 数据面

`GET /api/agents`（实况，经 SDK `useAgents`）、`GET /api/bots`（完整记录，secret 永不回显——
编辑时密码框留空即「保持不变」，由 PATCH 的 keep-blank-password 规则落回旧值）、
`GET /api/ports`（channels/providers 清单 + 各自 schema）、`POST/PATCH/DELETE /api/bots…`、
`POST /api/bots/:id/toggle`、`POST /api/bots/:id/test`。

## 截图验证（改 UI 红线）

```sh
wao start   # 或 node src/index.js start
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
BASE=http://127.0.0.1:8792/api/ui/ui-workbench/harness.html
"$CHROME" --headless=new --disable-gpu --force-light-mode --window-size=1280,800 \
  --screenshot=/tmp/wb-list-light.png  "$BASE"
"$CHROME" --headless=new --disable-gpu --force-dark-mode  --window-size=1280,800 \
  --screenshot=/tmp/wb-list-dark.png   "$BASE"
"$CHROME" --headless=new --disable-gpu --force-light-mode --window-size=1280,800 \
  --screenshot=/tmp/wb-bots-light.png  "$BASE?page=bots"
"$CHROME" --headless=new --disable-gpu --force-dark-mode  --window-size=1280,800 \
  --screenshot=/tmp/wb-bots-dark.png   "$BASE?page=bots"
```

假数据在 `ui/fake-data.js`（两个 bot：一 working 带 🔧 进度行、一 offline 带原因；wecom 渠道 +
dsh/claude/codex 三 provider 的真实 schema 形态）。要截空态/错误态，改假数据再截。
