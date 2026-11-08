# Task: 单色 icon 系统 + 色板收敛（monochrome redesign）

Status: DONE · Commit: feat(ui): monochrome icon system + unified color palette

## 交付

- **新建 `plugins/ui-workbench/ui/icons.js`**：17 个 stroke-based SVG path（Lucide/Feather 风格，24×24、`stroke="currentColor"`、零独立颜色）。导出 `icon(name,size)`（纯描述符 `{__svg,name,size,paths}`，不依赖 React）+ `IconEl({h,name,size})` 渲染件（WAO.h 风格）。
- **新建 `web/src/icons.js`**：同一份 ICON_PATHS（shell 导航查表用）+ `navIcon(h,name)`：命中→SVG，不命中→首字符兜底。
- **`web/src/shell.jsx`**：导航 icon 走 `navIcon()`；PunchClock 硬编码 `#059669` → `var(--ok)`。
- **页面 icon 全部换名**：workbench→list、bots→bot、assets→package、session→database、push→send、plugins→plug、timeline→clock、office3d→building（`plugins/ui-office3d/ui/office.js`）。
- **页内 emoji 一并清除**：向导推荐工具包按钮（📘/🔌/🛠️/📦→book/zap/settings/package，整包选中 ✓→check SVG）、`🎲 换一副面孔`→纯文字、资产科 `🛠 已配置`→check SVG + ok 色、`⚠ 未安装`→alert SVG + warn 色。
- **Timeline kind 分色删除**：统一 muted 中性 pill；差异靠 icon 形状（run_start=play / tool=zap / turn=send / run_end=check，step/thinking 纯文字）。
- **Provider 厂商色删除**（`hr.js`）：`--pv-*` 5 token 全删；身份改为字母标识（D/C/X/P）+ 中性 `.wb-dept-letter` tile（选中态 accent）；化身描边环统一 `var(--muted)`。渠道卡同理（企微=「企」tile）。
- **色板收敛**（`styles.css` + `style.js`）：删 `--pv-dsh/claude/codex/pi/unknown`、`--st-work/idle/offline`；token 值统一 `--ink:#1E293B`、`--ok:#059669`、`--bad:#DC2626`（warn/accent/bg/panel/line 不变）。类型五色/配发方式色→中性 badge；badge-offline 紫→中性；working 徽章→ok color-mix；danger 按钮/错误框→bad color-mix；散落 hex（#0F172A/#334155/#ECFDF5/#A7F3D0/#F5F3FF/#EFF6FF…）全部收进 token 或 color-mix。深色 override 仅剩中性（stickybar 阴影），彩色 dark 段随规则删除。

## 验证（全部附证据）

- `npm test`：**647/647 绿**。
- `node web/build.mjs`：dist 重建（app.js 381.6kb / avatar-lib 371.8kb，无错）。
- `bash test/ui-shot.sh`：30/30 基线重截齐备（≥5KB gate 通过）。
- **CDP 实测真实控制台**（临时内核 127.0.0.1:18810 + 无头 Chrome，非 harness stub）：
  - 导航 9 项中 8 项渲染 SVG（今日工作/机器人管理/工具库/会话历史/办公室/消息推送/插件管理/活动日志），stroke 全部为 currentColor（active=白、常态=slate）；「机器人全景」（ui-office-studio，不在映射表）按设计退回首字符「▢」文字 icon，单色。
  - 9 个路由（/ 及 8 页）DOM 文本 `Extended_Pictographic` 扫描：**emoji 0 个**。
  - 每页色相桶（s≥12%、非近黑近白）≤4：210°（accent 蓝）为主 + 165°（ok）+ 0°（bad，仅 plugins 页 danger 按钮）+ 225°（ink 深蓝灰）——**远低于 6 色上限**。
  - 截图存证：`/tmp/wao-verify/shell-workbench.png`（验证后已清理进程）。
- 基线人工读图：workbench-light（无 emoji、状态徽章中性/绿）、wizard-equip（工具包按钮为 ▣/ϟ/⚙/⬡ SVG）、timeline-light（▷开始/⚡工具/➤消息/✓结束，全中性 pill）、assets-equip（✓已配置 ripgrep 14.1.1 绿、⚠未安装 橙、类型徽章中性）、wizard-channel（「企」tile + accent 描边）、bots-dark（无异常）。

## 未验证项 / 说明

- 深色截图与浅色几乎一致：本仓库 `:root` 从无深色 token（仅个别类有 dark override，且多为本次删除的彩色段）——深色「统一 slate-900 系列」以删除彩色 dark 段兑现，未新增整套深色主题（超本任务范围）。
- office-studio「机器人全景」icon 保持「▢」文字（不在任务映射表，走首字符兜底路径，单色合规）。
- 工作区另有他人未提交改动（office-studio、core-engine/api.js、build.mjs、package-lock、office3d/studio/template 截图等）——未纳入本 commit，仅提交本任务文件。
