// Page styles for ui-workbench (M3 T2). Pages are no-build modules, so the
// CSS ships as a string injected once per document — same var(--*) tokens as
// the shell's stylesheet (web/src/styles.css), which means light/dark follow
// prefers-color-scheme with zero extra wiring. Idempotent by <style> id.

const CSS = `
.wb-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 16px; margin-top: 14px; }
.wb-card {
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-card);
  padding: 16px 18px; display: flex; flex-direction: column; gap: 10px;
  transition: border-color 0.2s ease;
}
.wb-card:hover {
  border-color: #D4D4D8;
}
.wb-card-head { display: flex; align-items: center; gap: 10px; }
.wb-name { font-weight: 700; font-size: 15px; letter-spacing: -0.01em; color: var(--ink); }
.wb-sub { color: var(--muted); font-size: 12px; }
.wb-progress { color: var(--ink); font-size: 13px; min-height: 20px; overflow-wrap: anywhere; background: var(--bg); border-radius: 6px; padding: 6px 10px; border: 1px solid var(--line-subtle); }
.wb-reason { color: var(--bad); font-size: 12px; overflow-wrap: anywhere; }
/* P2-4: provider/channel 端口已消失的 bot 卡片角标（title 说明原因） */
.wb-dot-warn { flex: none; width: 9px; height: 9px; border-radius: 50%; background: var(--warn); }
.wb-stats {
  display: flex; gap: 18px; font-size: 12.5px; color: var(--muted);
  border-top: 1px dashed var(--line); padding-top: 10px; font-family: var(--mono);
}
.wb-stats b { color: var(--ink); font-weight: 700; }
.wb-actions { display: flex; gap: 8px; margin-top: 2px; }

.wb-btn {
  border: 1px solid var(--line); background: var(--panel); color: var(--ink);
  border-radius: var(--r-ctl); padding: 5px 14px; cursor: pointer; font: inherit; font-size: 13px; font-weight: 600;
  transition: all 0.15s ease;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
}
.wb-btn:hover { background: var(--panel-2); border-color: #D4D4D8; }
.wb-btn-primary { background: var(--ink); color: #FFFFFF; border-color: var(--ink); }
.wb-btn-primary:hover { background: #26262A; color: #FFFFFF; }
.wb-btn:active { transform: scale(0.985); }           /* 按压微反馈（shadcn Button 手感） */
.wb-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.wb-btn-danger { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 30%, transparent); background: color-mix(in srgb, var(--bad) 6%, var(--panel)); }
.wb-btn-danger:hover { background: color-mix(in srgb, var(--bad) 12%, var(--panel)); }
.wb-btn[disabled] { opacity: .5; cursor: not-allowed; pointer-events: none; }

/* 内联 SVG icon（icons.js）：currentColor 描边，颜色完全跟文字 */
.wic { flex: none; vertical-align: -0.15em; }

.wb-switch { position: relative; display: inline-block; width: 36px; height: 20px; flex: none; cursor: pointer; }
.wb-switch input { position: absolute; opacity: 0; inset: 0; margin: 0; cursor: pointer; }
.wb-switch .wb-track {
  position: absolute; inset: 0; border-radius: 999px; background: var(--line);
  transition: background .15s ease;
}
.wb-switch .wb-track::after {
  content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
  border-radius: 50%; background: var(--panel); transition: left .15s ease;
  box-shadow: 0 1px 3px rgba(0,0,0,0.15);
}
.wb-switch input:checked + .wb-track { background: var(--ok); }
.wb-switch input:checked + .wb-track::after { left: 18px; }
.wb-switch input:focus-visible + .wb-track { outline: 2px solid var(--accent); outline-offset: 2px; }

.wb-crud { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 20px; margin-top: 14px; align-items: start; }
.wb-side { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-card); padding: 12px; display: flex; flex-direction: column; gap: 4px; }
.wb-side-item {
  display: flex; justify-content: space-between; align-items: center; gap: 8px;
  padding: 8px 12px; border-radius: 8px; cursor: pointer; border: none; background: none;
  color: var(--ink); font: inherit; text-align: left; width: 100%; transition: all 0.15s ease;
}
.wb-side-item:hover { background: var(--panel-2); }
.wb-side-item.active { background: var(--ink); color: #FFFFFF; font-weight: 600; box-shadow: 0 2px 8px rgba(15, 23, 42, 0.12); }
.wb-side-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wb-side-id { font-size: 11px; color: var(--muted); font-family: var(--mono); }
.wb-side-item.active .wb-side-id { color: var(--muted-light); }
.wb-side-item .badge { flex: none; }

.wb-editor { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-card); padding: 20px 24px; }
.wb-editor h3 { margin: 0 0 14px; font-size: 16px; font-weight: 700; color: var(--ink); }
.wb-form { display: flex; flex-direction: column; gap: 14px; max-width: 660px; }
.wb-field { display: flex; flex-direction: column; gap: 5px; }
.wb-field > label { font-size: 13px; font-weight: 600; color: var(--ink); }
.wb-field label .wb-req { color: var(--bad); }
.wb-input, .wb-select, .wb-textarea {
  border: 1px solid var(--line); background: var(--panel); color: var(--ink);
  border-radius: 8px; padding: 7px 12px; font: inherit; font-size: 13px; width: 100%;
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.02);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.wb-input:focus, .wb-select:focus, .wb-textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent); }
.wb-input[readonly] { color: var(--muted); background: var(--bg); }
.wb-textarea { font-family: var(--mono); font-size: 12px; min-height: 70px; resize: vertical; }
.wb-hint { font-size: 12px; color: var(--muted); }
.wb-field-error { color: var(--bad); font-size: 12px; }
.wb-check { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.wb-check input { width: 15px; height: 15px; accent-color: var(--accent); }
.wb-notice {
  background: color-mix(in srgb, var(--warn) 14%, transparent);
  border: 1px solid var(--warn); color: var(--warn);
  padding: 8px 12px; border-radius: 8px; font-size: 13px;
}
.wb-error-box { color: var(--bad); background: var(--bad-bg); padding: 8px 12px; border-radius: 8px; font-size: 13px; }
.wb-error-box ul { margin: 0; padding-left: 18px; }
.wb-section-title {
  font-size: 12px; font-weight: 600; color: var(--muted);
  margin-top: 8px; text-transform: uppercase; letter-spacing: .05em;
}
.wb-toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.wb-result {
  border: 1px solid var(--line); border-radius: var(--r-ctl); padding: 12px 14px; margin-top: 12px;
  font-size: 13px; display: flex; flex-direction: column; gap: 6px; max-width: 660px;
}
.wb-result-text { overflow-wrap: anywhere; }
.wb-kv { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.wb-code-ok { color: var(--ok); border-color: var(--ok); }
.wb-code-bad { color: var(--bad); border-color: var(--bad); }
.wb-danger {
  border: 1px dashed var(--bad); border-radius: var(--r-ctl); padding: 12px 14px;
  margin-top: 18px; display: flex; flex-direction: column; gap: 8px; max-width: 660px;
}
.wb-empty {
  background: var(--panel); border: 1px dashed var(--line); border-radius: var(--r-card);
  padding: 40px 20px; text-align: center; color: var(--muted); margin-top: 14px;
}
.wb-empty .wb-btn { margin-top: 12px; }

/* —— T3: session / push / plugins / timeline ————————————————————————— */
.wb-tabs { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.wb-tab {
  border: none; background: var(--panel); color: var(--muted);
  padding: 5px 16px; cursor: pointer; font: inherit; font-size: 13px;
}
.wb-tab + .wb-tab { border-left: 1px solid var(--line); }
.wb-tab.active { background: var(--accent); color: var(--accent-ink); }

.wb-turns { display: flex; flex-direction: column; gap: 10px; margin-top: 14px; max-width: 760px; }
.wb-turn {
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-ctl);
  padding: 10px 14px; display: flex; flex-direction: column; gap: 6px;
}
.wb-turn-head { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); }
.wb-turn-head time { font-variant-numeric: tabular-nums; }
.wb-turn-user, .wb-turn-assistant { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; }
.wb-turn-role { font-size: 11px; color: var(--muted); flex: none; }
.wb-badge-completed { color: var(--ok); border-color: var(--ok); }
.wb-badge-interrupted { color: var(--warn); border-color: var(--warn); }
.wb-badge-timeout, .wb-badge-error { color: var(--bad); border-color: var(--bad); }
.wb-chip {
  border: 1px dashed var(--line); background: none; color: var(--muted);
  font: inherit; font-size: 11px; font-family: ui-monospace, Menlo, Consolas, monospace;
  border-radius: 6px; padding: 1px 8px; cursor: pointer;
}
.wb-chip:hover { color: var(--accent); border-color: var(--accent); }
.wb-truncated-note { font-size: 12px; color: var(--warn); }

.wb-banner {
  border-radius: 8px; padding: 8px 12px; font-size: 13px; margin-top: 12px;
  max-width: 660px; overflow-wrap: anywhere;
}
.wb-banner-ok { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); border: 1px solid var(--ok); }
.wb-banner-bad { color: var(--bad); background: var(--bad-bg); border: 1px solid var(--bad); }

.wb-counter { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.wb-counter.over { color: var(--bad); }

.wb-table { border-collapse: collapse; width: 100%; max-width: 980px; margin-top: 14px; background: var(--panel); }
.wb-table th, .wb-table td {
  border: 1px solid var(--line); padding: 8px 12px; font-size: 13px; text-align: left;
  vertical-align: top;
}
.wb-table th { color: var(--muted); font-weight: 600; background: color-mix(in srgb, var(--line) 25%, var(--panel)); }
.wb-table tbody tr { transition: background-color 0.12s ease; }
.wb-table tbody tr:hover { background: color-mix(in srgb, var(--panel-2) 55%, transparent); }
.wb-table td .wb-sub { margin-top: 2px; }
/* 窄屏表格不挤碎（走查 M5）：列压成逐字竖排/按钮挤出屏——改为容器内横向滚动 */
.wb-table-scroll { overflow-x: auto; max-width: 980px; }
.wb-table-scroll .wb-table { min-width: 560px; }

/* 会话历史的迷你 Markdown 渲染（md.js）：覆盖 .wb-turn-assistant 的 pre-wrap */
.wb-md { white-space: normal; font-size: 13px; }
.wb-md .wb-md-h { font-weight: 650; margin: 8px 0 4px; }
.wb-md .wb-md-h1 { font-size: 15px; }
.wb-md .wb-md-h2 { font-size: 14px; }
.wb-md .wb-md-h3, .wb-md .wb-md-h4 { font-size: 13px; }
.wb-md .wb-md-list { margin: 4px 0 4px 18px; padding: 0; }
.wb-md .wb-md-p { margin: 2px 0; }
.wb-md .wb-md-code {
  margin: 6px 0; padding: 8px 10px; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere;
  background: color-mix(in srgb, var(--line) 20%, var(--panel)); border-radius: 8px;
}
.wb-md .wb-md-table { margin-top: 8px; font-size: 12.5px; }
.wb-badge-active { color: var(--ok); border-color: var(--ok); }
.wb-badge-disabled { color: var(--muted); }
.wb-badge-failed { color: var(--bad); border-color: var(--bad); }

.wb-modal-wrap {
  position: fixed; inset: 0; background: color-mix(in srgb, var(--bg) 60%, transparent);
  display: flex; align-items: center; justify-content: center; z-index: 40;
}
.wb-modal {
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-card);
  padding: 18px 22px; max-width: 480px; display: flex; flex-direction: column; gap: 10px;
  box-shadow: 0 12px 40px rgb(0 0 0 / .25);
}
.wb-modal h3 { margin: 0; }
.wb-modal .wb-hint { overflow-wrap: anywhere; }

.wb-tl { list-style: none; margin: 14px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-width: 860px; }
.wb-tl-row {
  display: flex; align-items: baseline; gap: 10px; font-size: 13px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
  padding: 5px 12px; min-width: 0;
}
.wb-tl-time { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; flex: none; }
.wb-tl-kind {
  flex: none; font-size: 11px; border-radius: 999px; padding: 0 8px;
  border: 1px solid var(--line); color: var(--muted);
  display: inline-flex; align-items: center; gap: 4px;
}
.wb-tl-chat {
  flex: none; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--muted); font-size: 11px; font-family: ui-monospace, Menlo, Consolas, monospace;
}
.wb-tl-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
/* 单色收敛：kind 不再分色——统一 muted 中性 pill，差异靠 icon 形状（timeline.js） */

/* —— 公司比喻重设计 (P2 人事部) ——————————————————————————————————— */
.wb-mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }

/* 头像即化身：seed=botId 全站同脸，provider 色描边环 */
.wao-av {
  display: inline-flex; flex: none; border-radius: 50%;
  border: 2px solid var(--line); background: var(--panel-2);
  overflow: hidden; line-height: 0;
}
.wao-av svg { width: 100%; height: 100%; display: block; }

.wb-side-item { gap: 8px; }
.wb-side-new { color: var(--accent); font-weight: 600; }
.wb-file-head {
  display: flex; align-items: center; gap: 12px; margin: -4px 0 12px;
  padding-bottom: 12px; border-bottom: 1px solid var(--line);
}

/* 分组折叠 */
.wb-group {
  border: 1px solid var(--line); border-radius: var(--r-ctl);
  margin-bottom: 10px; overflow: hidden; background: var(--panel);
}
.wb-group-head {
  display: flex; align-items: baseline; gap: 8px; width: 100%;
  padding: 9px 14px; border: none; background: var(--panel-2);
  color: var(--ink); font: inherit; cursor: pointer; text-align: left;
}
.wb-group-head:hover { background: color-mix(in srgb, var(--ink) 6%, var(--panel-2)); }
.wb-group-caret { width: 1em; color: var(--muted); }
.wb-group-title { font-weight: 600; font-size: 13px; }
.wb-group-body { padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 12px; }

/* sticky 保存栏 */
.wb-stickybar {
  position: sticky; bottom: -20px; margin: 14px -20px -20px;
  padding: 10px 20px; background: var(--panel);
  border-top: 1px solid var(--line); border-radius: 0 0 12px 12px;
  box-shadow: 0 -8px 20px rgb(35 42 44 / .06);
}
@media (prefers-color-scheme: dark) {
  .wb-stickybar { box-shadow: 0 -8px 20px rgb(0 0 0 / .35); }
}

/* 入职向导 */
.wb-wizard { display: flex; flex-direction: column; gap: 16px; }
.wb-steps { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.wb-step {
  display: inline-flex; align-items: center; gap: 7px;
  border: 1px solid var(--line); background: var(--panel); color: var(--muted);
  border-radius: 999px; padding: 5px 14px; cursor: pointer; font: inherit; font-size: 13px;
}
.wb-step .wb-step-num {
  width: 18px; height: 18px; border-radius: 50%; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 11px; background: var(--panel-2); border: 1px solid var(--line);
}
.wb-step.visited { color: var(--ink); }
.wb-step.visited .wb-step-num { background: var(--muted); border-color: var(--muted); color: var(--panel); }
.wb-step.active { border-color: var(--accent); color: var(--accent); font-weight: 600; }
.wb-step.active .wb-step-num { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.wb-step[disabled] { cursor: not-allowed; opacity: .75; }
.wb-step-sub { font-size: 12px; color: var(--muted); margin-left: 6px; }
.wb-wizard-card-row { display: flex; gap: 16px; align-items: flex-start; }
.wb-wizard-nav {
  position: sticky; bottom: 0; margin: 0 -20px -20px; padding: 12px 20px;
  background: var(--panel); border-top: 1px solid var(--line);
  border-radius: 0 0 12px 12px; display: flex; gap: 10px; justify-content: flex-end;
}
.wb-editor { padding-bottom: 20px; } /* sticky 栏有自己的负 margin 贴底，非 sticky 编辑器保持底边距 */

/* 技能岗位三部门卡片 */
.wb-dept-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
.wb-dept-card {
  position: relative; display: flex; flex-direction: column; gap: 6px;
  border: 1.5px solid var(--line); border-radius: var(--r-card); background: var(--panel);
  padding: 16px 14px 14px; cursor: pointer; font: inherit; color: var(--ink);
  text-align: left; transition: border-color .12s ease, box-shadow .12s ease;
}
.wb-dept-card:hover { box-shadow: var(--shadow); }
.wb-dept-card.active { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 15%, transparent); }
.wb-dept-letter {
  width: 26px; height: 26px; border-radius: 7px; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 12.5px; font-weight: 700; color: var(--muted);
  background: var(--panel-2); border: 1px solid var(--line);
}
.wb-dept-card.active .wb-dept-letter { color: var(--accent-ink); background: var(--accent); border-color: var(--accent); }
.wb-dept-name { font-weight: 700; margin-top: 6px; }
.wb-dept-card.active .wb-dept-name { color: var(--accent); }
.wb-dept-blurb { font-size: 12.5px; color: var(--muted); line-height: 1.55; }
.wb-dept-tech { font-size: 11px; color: var(--muted); font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }

/* 成功页工牌 */
.wb-wizard-done { display: flex; flex-direction: column; gap: 14px; }
.wb-badgecard {
  display: flex; gap: 16px; align-items: center;
  border: 1px solid var(--line); border-radius: var(--r-card); background: var(--panel);
  box-shadow: var(--shadow); padding: 18px 20px;
}
.wb-badgecard-body { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.wb-badgecard-name { font-size: 18px; font-weight: 700; }
.wb-badgecard-rows { display: flex; gap: 18px; font-size: 13px; margin-top: 6px; flex-wrap: wrap; }

/* 离职面谈 */
.wb-offboard { max-width: 520px; }
.wb-offboard-head { display: flex; align-items: center; gap: 12px; }
.wb-offboard-head h3 { margin: 0; }
.wb-offboard-list { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 6px; font-size: 13px; }

/* toast */
.wb-toast {
  position: fixed; bottom: 26px; left: 50%; transform: translateX(-50%);
  background: var(--panel); border: 1px solid var(--line); border-radius: 999px;
  box-shadow: var(--shadow-lift); padding: 9px 20px; font-size: 13px; color: var(--ink);
  z-index: 60; animation: wb-toast-in .25s ease;
}
@keyframes wb-toast-in { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }
@media (prefers-reduced-motion: reduce) { .wb-toast { animation: none; } }

/* —— W3 T4: 资产科（单色收敛：类型/配发方式徽章全中性，靠文字标签区分；
   语义色只保留 ok（已配置）/ warn（源删除·未安装）——————————————— */
.wb-tool-ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 35%, transparent); }
.wb-srcdel { color: var(--warn); border-color: var(--warn); }
.wb-writes {
  margin: 4px 0 0; padding-left: 18px; max-height: 180px; overflow: auto;
  font-size: 12px; color: var(--muted);
}
.wb-writes li { overflow-wrap: anywhere; }

/* —— P5 收口：窄屏（shell 侧栏折顶时，双栏布局也收成单列） ———————————— */
@media (max-width: 900px) {
  .wb-crud { grid-template-columns: 1fr; }
  .wb-side { flex-direction: row; flex-wrap: wrap; }
  .wb-side-item { width: auto; }
  .wb-grid { grid-template-columns: 1fr; }
}

/* —— v2 导航收敛：总览页（3D 内嵌高度适配 + 卡片名可点 + 最近活动条） ———— */
/* 卡片名字是按钮（进详情）：去掉按钮外观，保留可点语义 */
.wb-name-btn {
  border: 0; background: none; padding: 0; font: inherit; color: inherit;
  cursor: pointer; text-align: left; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; max-width: 100%;
}
.wb-name-btn:hover { color: var(--accent, var(--ink)); text-decoration: underline; }

/* 办公室 3D 原页按独立页预留 158px 顶栏；总览还有页头+切换条+活动条，重设高 */
.ov-embed .of-stage { height: calc(100vh - 330px); min-height: 420px; }
@media (max-width: 900px) { .ov-embed .of-stage { height: 60vh; min-height: 360px; } }

/* 最近活动摘要（最近 5 条，点击进机器人详情日志 tab） */
.ov-act { margin-top: 16px; }
.ov-act-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px; }
.ov-act-head h3 { margin: 0; font-size: 14px; }
.ov-act-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.ov-act-row {
  display: flex; align-items: center; gap: 10px;
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-ctl);
  padding: 7px 12px; cursor: pointer; font-size: 12.5px;
  transition: border-color .15s ease;
}
.ov-act-row:hover { border-color: #CBD5E1; }

/* —— v2 AI 操作引导：设置 AI section + 机器人详情提示行（总览大卡已收敛为
   shell 侧栏小卡，样式随 shell styles.css 的 .side-ai，见走查后迭代）————— */

/* 小号按钮（配置块/工具行内联动作） */
.wb-btn-sm { padding: 3px 10px; font-size: 12px; }

/* 配置块：标题+按钮排 + 等宽代码体 */
.ai-box {
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-card);
  padding: 12px 14px; margin-top: 12px; box-shadow: var(--shadow-sm);
  display: flex; flex-direction: column; gap: 8px;
}
.ai-box-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.ai-box-title { font-weight: 600; font-size: 13px; color: var(--ink); }
.ai-box-actions { display: flex; gap: 6px; }
.ai-code {
  margin: 0; padding: 10px 12px; border-radius: 8px; overflow-x: auto;
  background: var(--bg); border: 1px solid var(--line-subtle);
  font-family: var(--mono); font-size: 12px; line-height: 1.55;
  color: var(--ink); white-space: pre;
}

/* 工具清单 / skill / 连通性 */
.ai-tools, .ai-skill { margin-top: 14px; }
.ai-tools-head {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  flex-wrap: wrap; font-size: 13px; color: var(--ink);
}
.ai-tool-list {
  list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px;
}
.ai-tool-list li {
  display: flex; align-items: baseline; gap: 8px; font-size: 12.5px;
  background: var(--panel); border: 1px solid var(--line-subtle); border-radius: 8px;
  padding: 7px 10px;
}
.ai-tool-list code { flex: none; font-size: 12px; }
.ai-tool-danger {
  flex: none; font-size: 11px; font-weight: 600; color: var(--bad);
  border: 1px solid color-mix(in srgb, var(--bad) 35%, transparent);
  border-radius: 999px; padding: 0 7px;
}
.ai-tool-desc { color: var(--muted); min-width: 0; overflow-wrap: anywhere; }
.ai-probe { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
.ai-probe-ok { color: var(--ok); font-size: 12.5px; }
.ai-probe-bad { color: var(--bad); font-size: 12.5px; overflow-wrap: anywhere; }

/* 机器人详情的 AI 提示行：一行点到为止 */
.wb-bot-ai-hint {
  margin-top: 10px; font-size: 12px; overflow-wrap: anywhere;
}
.wb-bot-ai-hint code {
  font-family: var(--mono); font-size: 11.5px; background: var(--bg);
  border: 1px solid var(--line-subtle); border-radius: 5px; padding: 0 4px;
}
.wb-linklike {
  border: 0; background: none; padding: 0; font: inherit; font-size: 12px;
  color: var(--accent); cursor: pointer; text-decoration: underline;
}
.wb-linklike:hover { color: color-mix(in srgb, var(--accent) 80%, #000); }
`;

export function ensurePageStyle() {
  if (typeof document === 'undefined' || document.getElementById('wao-ui-workbench-style') != null) return;
  const el = document.createElement('style');
  el.id = 'wao-ui-workbench-style';
  el.textContent = CSS;
  document.head.appendChild(el);
}

export { CSS };
