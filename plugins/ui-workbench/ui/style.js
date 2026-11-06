// Page styles for ui-workbench (M3 T2). Pages are no-build modules, so the
// CSS ships as a string injected once per document — same var(--*) tokens as
// the shell's stylesheet (web/src/styles.css), which means light/dark follow
// prefers-color-scheme with zero extra wiring. Idempotent by <style> id.

const CSS = `
.wb-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 14px; margin-top: 14px; }
.wb-card {
  background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
  padding: 14px 16px; display: flex; flex-direction: column; gap: 10px;
}
.wb-card-head { display: flex; align-items: center; gap: 10px; }
.wb-name { font-weight: 600; font-size: 15px; }
.wb-sub { color: var(--muted); font-size: 12px; }
.wb-progress { color: var(--muted); font-size: 13px; min-height: 20px; overflow-wrap: anywhere; }
.wb-reason { color: var(--bad); font-size: 12px; overflow-wrap: anywhere; }
/* P2-4: provider/channel 端口已消失的 bot 卡片角标（title 说明原因） */
.wb-dot-warn { flex: none; width: 9px; height: 9px; border-radius: 50%; background: var(--warn); }
.wb-stats {
  display: flex; gap: 18px; font-size: 13px; color: var(--muted);
  border-top: 1px dashed var(--line); padding-top: 8px;
}
.wb-stats b { color: var(--ink); font-weight: 600; }
.wb-actions { display: flex; gap: 8px; }

.wb-btn {
  border: 1px solid var(--line); background: var(--panel); color: var(--ink);
  border-radius: 8px; padding: 4px 12px; cursor: pointer; font: inherit; font-size: 13px;
}
.wb-btn:hover { border-color: var(--accent); color: var(--accent); }
.wb-btn-primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
.wb-btn-primary:hover { color: var(--accent-ink); opacity: .9; }
.wb-btn-danger { color: var(--bad); border-color: var(--bad); }
.wb-btn-danger:hover { color: var(--bad); opacity: .8; }
.wb-btn[disabled] { opacity: .5; cursor: not-allowed; pointer-events: none; }

.wb-switch { position: relative; display: inline-block; width: 36px; height: 20px; flex: none; cursor: pointer; }
.wb-switch input { position: absolute; opacity: 0; inset: 0; margin: 0; cursor: pointer; }
.wb-switch .wb-track {
  position: absolute; inset: 0; border-radius: 999px; background: var(--line);
  transition: background .15s ease;
}
.wb-switch .wb-track::after {
  content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
  border-radius: 50%; background: var(--panel); transition: left .15s ease;
}
.wb-switch input:checked + .wb-track { background: var(--ok); }
.wb-switch input:checked + .wb-track::after { left: 18px; }
.wb-switch input:focus-visible + .wb-track { outline: 2px solid var(--accent); outline-offset: 2px; }

.wb-crud { display: grid; grid-template-columns: 250px minmax(0, 1fr); gap: 18px; margin-top: 14px; align-items: start; }
.wb-side { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 10px; display: flex; flex-direction: column; gap: 4px; }
.wb-side-item {
  display: flex; justify-content: space-between; align-items: center; gap: 8px;
  padding: 8px 10px; border-radius: 8px; cursor: pointer; border: none; background: none;
  color: var(--ink); font: inherit; text-align: left; width: 100%;
}
.wb-side-item:hover { background: color-mix(in srgb, var(--accent) 10%, transparent); }
.wb-side-item.active { background: var(--accent); color: var(--accent-ink); }
.wb-side-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wb-side-id { font-size: 11px; color: var(--muted); }
.wb-side-item.active .wb-side-id { color: var(--accent-ink); opacity: .8; }
.wb-side-item .badge { flex: none; }

.wb-editor { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px 20px 20px; }
.wb-editor h3 { margin: 0 0 12px; }
.wb-form { display: flex; flex-direction: column; gap: 12px; max-width: 660px; }
.wb-field { display: flex; flex-direction: column; gap: 4px; }
.wb-field > label { font-size: 13px; color: var(--muted); }
.wb-field label .wb-req { color: var(--bad); }
.wb-input, .wb-select, .wb-textarea {
  border: 1px solid var(--line); background: var(--bg); color: var(--ink);
  border-radius: 8px; padding: 6px 10px; font: inherit; font-size: 13px; width: 100%;
}
.wb-input:focus, .wb-select:focus, .wb-textarea:focus { outline: none; border-color: var(--accent); }
.wb-input[readonly] { color: var(--muted); background: color-mix(in srgb, var(--line) 30%, var(--bg)); }
.wb-textarea { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; min-height: 60px; resize: vertical; }
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
  border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; margin-top: 12px;
  font-size: 13px; display: flex; flex-direction: column; gap: 6px; max-width: 660px;
}
.wb-result-text { overflow-wrap: anywhere; }
.wb-kv { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.wb-code-ok { color: var(--ok); border-color: var(--ok); }
.wb-code-bad { color: var(--bad); border-color: var(--bad); }
.wb-danger {
  border: 1px dashed var(--bad); border-radius: 10px; padding: 12px 14px;
  margin-top: 18px; display: flex; flex-direction: column; gap: 8px; max-width: 660px;
}
.wb-empty {
  background: var(--panel); border: 1px dashed var(--line); border-radius: 12px;
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
  background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
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
.wb-table td .wb-sub { margin-top: 2px; }
.wb-badge-active { color: var(--ok); border-color: var(--ok); }
.wb-badge-disabled { color: var(--muted); }
.wb-badge-failed { color: var(--bad); border-color: var(--bad); }

.wb-modal-wrap {
  position: fixed; inset: 0; background: color-mix(in srgb, var(--bg) 60%, transparent);
  display: flex; align-items: center; justify-content: center; z-index: 40;
}
.wb-modal {
  background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
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
  border: 1px solid var(--line);
}
.wb-tl-chat {
  flex: none; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--muted); font-size: 11px; font-family: ui-monospace, Menlo, Consolas, monospace;
}
.wb-tl-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
/* kind 分色: run_start 蓝 / step 灰 / tool 紫 / thinking 青 / turn 绿 / run_end 蓝灰 */
.wb-tl-kind-run_start { color: var(--accent); border-color: var(--accent); }
.wb-tl-kind-step { color: var(--muted); }
.wb-tl-kind-tool { color: #7c3aed; border-color: #7c3aed; }
.wb-tl-kind-thinking { color: #0e7490; border-color: #0e7490; }
.wb-tl-kind-turn { color: var(--ok); border-color: var(--ok); }
.wb-tl-kind-run_end { color: #64748b; border-color: #64748b; }
@media (prefers-color-scheme: dark) {
  .wb-tl-kind-tool { color: #a78bfa; border-color: #a78bfa; }
  .wb-tl-kind-thinking { color: #22d3ee; border-color: #22d3ee; }
  .wb-tl-kind-run_end { color: #94a3b8; border-color: #94a3b8; }
}
`;

export function ensurePageStyle() {
  if (typeof document === 'undefined' || document.getElementById('wao-ui-workbench-style') != null) return;
  const el = document.createElement('style');
  el.id = 'wao-ui-workbench-style';
  el.textContent = CSS;
  document.head.appendChild(el);
}

export { CSS };
