// W2 T1: `wao tui` — 运维仪表盘（owner dashboard）。Client view over an
// ALREADY-RUNNING service (default 127.0.0.1:8792): polls GET /api/agents
// every 2s and tails data/logs/wao.log when --data-dir is locally readable.
// Zero dependencies: node:readline (keypress) + hand-rolled ANSI.
//
// Architecture for testability: computeFrame(state, opts) is a PURE function
// (state → string[] frame, ANSI included) — the whole visual contract is
// snapshot-testable without a terminal. W2 T2 adds the keyboard surface as
// TWO more pure functions: handleKey(state, ev, deps) → {state, effects}
// (every key transition + the effect descriptors operations produce) and
// applyResult(state, effect, result) (an operation's outcome → state).
// attachTUI is the thin shell: raw mode, 1s tick (clock) driving a 2s fetch
// cadence + log tail poll → setState, keypress → handleKey → dispatch effects
// against the SAME /api the Web console uses (toggle/test/send/bots/ledger/
// ports), full-frame repaint on the alternate screen. Ctrl-C / q restore the
// terminal and quit.
import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import readline from 'node:readline';
import process from 'node:process';

const RESET = '\x1b[0m';
const CODE = {
  bold: '1', dim: '2', red: '31', green: '32', yellow: '33', cyan: '36', gray: '90',
  reverse: '7',
};
const paint = (text, ...codes) =>
  codes.length === 0 || text === '' ? text : `\x1b[${codes.join(';')}m${text}${RESET}`;

// Display width (East-AsianWide heuristic, zero-dep): CJK/fullwidth/emoji
// count 2, ANSI escapes count 0. Truncation and layout measure with this so
// an 80-col terminal never wraps a frame line.
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const isWide = (cp) =>
  (cp >= 0x231a && cp <= 0x231b) || (cp >= 0x23e9 && cp <= 0x23ec) || cp === 0x23f0 || cp === 0x23f3
  || (cp >= 0x1100 && cp <= 0x115f)
  || (cp >= 0x2e80 && cp <= 0xa4cf)
  || (cp >= 0xac00 && cp <= 0xd7a3)
  || (cp >= 0xf900 && cp <= 0xfaff)
  || (cp >= 0xfe30 && cp <= 0xfe4f)
  || (cp >= 0xff00 && cp <= 0xff60)
  || (cp >= 0xffe0 && cp <= 0xffe6)
  || (cp >= 0x1f300 && cp <= 0x1f9ff)
  || (cp >= 0x20000 && cp <= 0x3fffd);
const dispWidth = (s) => {
  let w = 0;
  for (const ch of s.replace(ANSI_RE, '')) w += isWide(ch.codePointAt(0)) ? 2 : 1;
  return w;
};

// One frame line = colored segments composed left-to-right under a display
// width budget (… when cut). Segments are {t, c:[codes]}; `extra` codes apply
// to every segment (selected row → reverse video across the whole line,
// gaps included).
const composeLine = (width, segs, extra = []) => {
  const out = [];
  let left = width;
  for (const seg of segs) {
    if (left <= 0) break;
    let text = seg.t;
    if (dispWidth(text) > left) {
      let w = 0, cut = '';
      for (const ch of text) {
        const cw = isWide(ch.codePointAt(0)) ? 2 : 1;
        if (w + cw > left - 1) break;
        cut += ch; w += cw;
      }
      text = cut + '…';
    }
    out.push(paint(text, ...(seg.c ?? []), ...extra));
    left -= dispWidth(text);
  }
  return out.join('');
};

const pad2 = (n) => String(n).padStart(2, '0');
const clockOf = (now) => {
  const d = new Date(now);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

// Hard-wrap a (possibly long, CJK-laden) string into display-width-bounded
// lines — the probation result window uses this so a long finalText scrolls
// instead of truncating.
const wrapText = (text, width) => {
  const out = [];
  let cur = '';
  let w = 0;
  for (const ch of String(text)) {
    const cw = isWide(ch.codePointAt(0)) ? 2 : 1;
    if (w + cw > width && cur !== '') {
      out.push(cur);
      cur = ch;
      w = cw;
    } else {
      cur += ch;
      w += cw;
    }
  }
  out.push(cur);
  return out;
};

// 公司话状态词 (README §4.2: 状态只用 工作中/待命/休假 三档 + 调休 for the
// enabled=false toggle) — colors: working=青 / idle=绿 / offline+调休=灰.
const STATUS_LABEL = {
  working: { text: '工作中', code: CODE.cyan },
  idle: { text: '待命', code: CODE.green },
  offline: { text: '休假', code: CODE.gray },
};

export const KEYBAR = '↑↓选择 空格:调休/返岗 t:岗前测试 b:广播 l:日志 n:入职 e:浏览器 q:退出';
const LOG_WINDOW_ROWS = 5;

// Per-mode footer hints (the dashboard keeps the classic key bar; every
// interactive mode replaces it with its own contract — the operator always
// knows which keys are live).
const HINTS = {
  dashboard: KEYBAR,
  confirm: 'y 确认执行 n/esc 取消',
  input: '回车 提交 esc 取消（输入期间其他键位暂停）',
  pick: '↑↓ 选择 回车 确认 esc 取消',
  result: '↑↓ 滚动查看 esc/回车 关闭',
  wizard: '输入后回车下一步 esc 取消向导',
};
const hintOf = (state) => {
  if (state.mode === 'wizard' && state.wizard?.step === 5) return 'y 办理入职 n/esc 取消向导';
  if (state.mode === 'wizard' && state.wizard?.step === 1) return '↑↓ 选择岗位 回车 确认 esc 取消向导';
  return HINTS[state.mode] ?? KEYBAR;
};

// computeFrame(state, opts) → string[] (exactly opts.height rows, ANSI codes
// embedded). state: { agents, now, connected, selectedIdx, logTail, mode,
// busy, notice, confirm, input, pick, result, wizard, logZoom }.
// agents rows come from GET /api/agents verbatim (botRow shape). logTail is
// string[] (reachable log, maybe empty) or null (log file not locally
// readable → 「日志需本机」). T2 modes render instead of the card area:
// result (scrollable probation output), pick (broadcast chat targets),
// wizard (mini hire); confirm/input are rows pinned above the footer on a
// dashboard backdrop, notice is the inline ✓/✗ feedback row.
export function computeFrame(state = {}, opts = {}) {
  const {
    agents = [], now = 0, connected = true, selectedIdx = 0, logTail = [], mode = 'dashboard',
    busy = 0, notice = null, confirm = null, input = null, pick = null, result = null,
    wizard = null, logZoom = false,
  } = state;
  const width = opts.width ?? 80;
  const height = opts.height ?? 24;
  const target = opts.target ?? 'http://127.0.0.1:8792';
  const lines = [];

  // 顶栏：打卡钟（活钟 · 在岗 N/M · 今日工单 X · 操作中 ⏳）。断连=红条。
  if (connected) {
    const onDuty = agents.filter((a) => (a?.status ?? 'offline') !== 'offline').length;
    const todayTurns = agents.reduce((n, a) => n + (a?.todayTurns ?? 0), 0);
    const segs = [
      { t: 'WAO 公司', c: [CODE.bold] },
      { t: ' │ ', c: [CODE.dim] },
      { t: `⏰ ${clockOf(now)}`, c: [CODE.bold] },
      { t: ' │ ', c: [CODE.dim] },
      { t: `在岗 ${onDuty}/${agents.length}`, c: [] },
      { t: ' │ ', c: [CODE.dim] },
      { t: `今日工单 ${todayTurns}`, c: [] },
    ];
    if (busy > 0) segs.push({ t: ' │ ', c: [CODE.dim] }, { t: '⏳ 处理中', c: [CODE.bold] });
    lines.push(composeLine(width, segs));
  } else {
    lines.push(paint(`⚠ 连接已断开——每 2 秒自动重试（${target}）`, CODE.red, CODE.bold));
  }
  lines.push(paint('─'.repeat(width), CODE.dim));

  // 底部专用行（紧贴键位栏之上，永不裁掉）：确认行 / 输入行 / 通知行。
  const specials = [];
  if (mode === 'confirm' && confirm?.text != null) {
    specials.push(composeLine(width, [{ t: confirm.text, c: [CODE.bold, CODE.yellow] }]));
  }
  if (mode === 'input' && input != null) specials.push(inputRow(width, input));
  if (mode === 'dashboard' && notice != null) {
    const bad = notice.kind === 'error';
    specials.push(composeLine(width, [
      { t: bad ? '✗ ' : '✓ ', c: [bad ? CODE.red : CODE.green, CODE.bold] },
      { t: notice.text ?? '', c: [bad ? CODE.red : CODE.green] },
    ]));
  }

  const hint = hintOf({ mode, wizard });
  const contentBudget = Math.max(0, height - 2 - specials.length - 1);
  let content;
  if (mode === 'result' && result != null) content = resultPane(width, contentBudget, result);
  else if (mode === 'pick' && pick != null) content = pickPane(width, contentBudget, pick);
  else if (mode === 'wizard' && wizard != null) content = wizardPane(width, contentBudget, wizard);
  else {
    content = dashboardPane(width, contentBudget, { agents, selectedIdx, now, logTail, logZoom });
  }
  lines.push(...content.slice(0, contentBudget));

  // 帧恒等于 height 行：补白 → 专用行 → 键位栏；极小终端先裁内容行。
  while (lines.length < height - specials.length - 1) lines.push('');
  lines.push(...specials);
  lines.push(composeLine(width, [{ t: hint }]));
  if (lines.length > height) lines.splice(2, lines.length - height);
  return lines;
}

// 底部输入行：<加粗 prompt> <值（secret=＊遮蔽，长值保尾）>▌ [红字 err]
const inputRow = (width, input) => {
  const raw = input.secret ? '*'.repeat(Math.min(String(input.value ?? '').length, 32)) : String(input.value ?? '');
  const budget = Math.max(8, width - dispWidth(input.prompt ?? '') - 4);
  let shown = raw;
  if (dispWidth(shown) > budget) {
    let w = 0;
    let cut = '';
    for (const ch of shown) {
      const cw = isWide(ch.codePointAt(0)) ? 2 : 1;
      if (w + cw > budget - 1) break;
      cut = ch + cut; // keep the TAIL: the caret is always at the end
      w += cw;
    }
    shown = `…${cut}`;
  }
  const segs = [
    { t: input.prompt ?? '', c: [CODE.bold] },
    { t: ` ${shown}`, c: [] },
    { t: '▌', c: [CODE.reverse] },
  ];
  if (input.err) segs.push({ t: `  ⚠ ${input.err}`, c: [CODE.red] });
  return composeLine(width, segs);
};

// —— content panes (each fills contentBudget rows at most) —————————————————

// 仪表盘主体：员工卡列表 + 日志尾随窗（l 放大：5 行 ↔ 半屏）。
const dashboardPane = (width, budget, { agents, selectedIdx, now, logTail, logZoom }) => {
  const out = [];
  const logCap = logZoom ? Math.max(LOG_WINDOW_ROWS, Math.floor(budget / 2)) : LOG_WINDOW_ROWS;
  const logWindowRows = logTail == null || logTail.length === 0
    ? 1 : Math.min(logCap, logTail.length);
  const contentRows = Math.max(1, budget - logWindowRows);
  const sel = agents.length === 0 ? 0 : Math.min(Math.max(0, selectedIdx), agents.length - 1);
  if (agents.length === 0) {
    out.push('公司还没有员工——按 n 办理入职');
  } else {
    const visible = agents.length > contentRows ? agents.slice(0, contentRows - 1) : agents;
    visible.forEach((a, i) => {
      const selected = i === sel;
      const extra = selected ? [CODE.reverse] : [];
      const st = STATUS_LABEL[a?.status] ?? STATUS_LABEL.offline;
      let label = a?.enabled === false ? '调休' : st.text;
      let stCode = a?.enabled === false ? CODE.gray : st.code;
      if (a?.enabled !== false && a?.status === 'offline' && a?.reason) label = `${label}·${a.reason}`;
      // 长名截断：名字最多占 width-30 列（窄端保底 8），把余宽留给
      // [状态]/岗位部门——截掉名字尾巴比截掉状态可读。
      const name = a?.name ?? a?.id ?? '?';
      let shownName = name;
      if (dispWidth(name) > Math.max(8, width - 30)) {
        const cap = Math.max(8, width - 30);
        let w = 0, cut = '';
        for (const ch of name) {
          const cw = isWide(ch.codePointAt(0)) ? 2 : 1;
          if (w + cw > cap - 1) break;
          cut += ch; w += cw;
        }
        shownName = cut + '…';
      }
      const segs = [
        { t: selected ? '▸ ' : '  ', c: [] },
        { t: shownName, c: [CODE.bold] },
        { t: '  ', c: [] },
        { t: `[${label}]`, c: [stCode] },
        { t: ' ', c: [] },
        { t: `${a?.provider ?? '?'}·${a?.channel ?? '?'}`, c: [CODE.gray] },
      ];
      if (a?.status === 'working' && a?.progress?.line) {
        const secs = Number.isFinite(a.progress.startedAt)
          ? Math.max(0, Math.floor((now - a.progress.startedAt) / 1000))
          : null;
        segs.push({ t: '  ', c: [] }, {
          t: secs == null ? a.progress.line : `${a.progress.line} · ${secs}s`,
          c: [CODE.cyan],
        });
      }
      segs.push({ t: '  ', c: [] }, { t: `今日${a?.todayTurns ?? 0}轮`, c: [CODE.dim] });
      if (a?.providerMissing) segs.push({ t: ' 部门缺席', c: [CODE.dim] });
      out.push(composeLine(width, segs, extra));
    });
    if (agents.length > contentRows) {
      out.push(paint(`…还有 ${agents.length - visible.length} 位员工未显示`, CODE.dim));
    }
  }

  // 日志尾随窗（默认末 5 行 / 放大=半屏，灰色小字）；读不到时明说。
  const tail = logTail == null ? null : logTail.slice(-logWindowRows);
  if (logTail == null) {
    out.push(composeLine(width, [
      { t: '日志需本机（在服务所在的机器上运行 wao tui 才能读取 data/logs/wao.log）', c: [CODE.dim] },
    ]));
  } else if (tail.length === 0) {
    out.push(paint('日志暂无输出', CODE.dim));
  } else {
    for (const l of tail) out.push(paint(l, CODE.dim));
  }
  return out;
};

// 岗前测试结果窗：code（通过绿/未通过红）+ 回复（长文折行滚动）+ 会话/事件数。
const resultPane = (width, budget, result) => {
  const out = [];
  out.push(composeLine(width, [{ t: result.title ?? '结果', c: [CODE.bold] }]));
  out.push(paint('─'.repeat(width), CODE.dim));
  const pass = result.code === 'completed';
  const rows = [{ t: `code: ${result.code ?? '?'}${pass ? '  ✅ 通过' : '  ❌ 未通过'}`, c: [pass ? CODE.green : CODE.red, CODE.bold] }];
  for (const l of wrapText(String(result.finalText ?? ''), Math.max(8, width - 4))) {
    rows.push({ t: `  ${l}`, c: [] });
  }
  rows.push({ t: `会话：${result.sessionId ?? '—'}`, c: [CODE.dim] });
  rows.push({ t: `事件流：${result.events ?? 0} 条`, c: [CODE.dim] });
  if (!pass && (result.errorText ?? result.reason)) {
    rows.push({ t: `原因：${result.errorText ?? result.reason}`, c: [CODE.red] });
  }
  const rowsCount = rows.length;
  const avail = Math.max(1, budget - 2 - (rowsCount > budget - 2 ? 1 : 0)); // 指示行自己也占预算
  const maxScroll = Math.max(0, rowsCount - avail);
  const scroll = Math.min(Math.max(0, result.scroll ?? 0), maxScroll);
  for (const r of rows.slice(scroll, scroll + avail)) out.push(composeLine(width, [r]));
  if (rowsCount > avail) {
    out.push(paint(`── ${scroll + 1}-${Math.min(scroll + avail, rowsCount)}/${rowsCount} 行（↑↓滚动）`, CODE.dim));
  }
  return out;
};

// 选择列表（广播目标会话；向导的岗位选择复用同一形状）。
const pickPane = (width, budget, pick) => {
  const out = [];
  out.push(composeLine(width, [{ t: pick.title ?? '选择', c: [CODE.bold] }]));
  const items = Array.isArray(pick.items) ? pick.items : [];
  const idx = items.length === 0 ? 0 : Math.min(Math.max(0, pick.idx ?? 0), items.length - 1);
  const avail = Math.max(1, budget - 1);
  const visible = items.length > avail ? items.slice(0, avail - 1) : items;
  visible.forEach((it, i) => {
    const selected = i === idx;
    out.push(composeLine(width, [
      { t: selected ? '▸ ' : '  ', c: [] },
      { t: it?.label ?? String(it?.value ?? ''), c: [CODE.bold] },
    ], selected ? [CODE.reverse] : []));
  });
  if (items.length > visible.length) out.push(paint(`…还有 ${items.length - visible.length} 项`, CODE.dim));
  return out;
};

// 简版入职向导：逐字段行编辑（名→岗位→cwd→botId→secret→摘要确认）。
const WIZARD_LABELS = ['姓名', '岗位', '工位（cwd）', '机器人 ID（botId）', 'Secret（不回显）'];
const WIZARD_FIELD_OF_STEP = { 0: 'name', 2: 'cwd', 3: 'botId', 4: 'secret' };
const wizardPane = (width, budget, w) => {
  if (w.step === 1) { // 岗位选择（技能部门枚举自 /api/ports）
    return pickPane(width, budget, {
      title: '选择岗位（技能部门）',
      items: (w.ports?.providers ?? []).map((p) => ({ label: p?.id ?? '?', value: p?.id })),
      idx: w.pickIdx,
    });
  }
  const out = [];
  out.push(composeLine(width, [{ t: '入职向导（esc 取消）', c: [CODE.bold] }]));
  for (let i = 0; i < WIZARD_LABELS.length; i++) {
    const field = WIZARD_FIELD_OF_STEP[i];
    if (w.step === i) { // 当前编辑行：反色 + 值 + 光标（secret 打码）
      const shown = i === 4
        ? '＊'.repeat(Math.min(String(w.fields?.secret ?? '').length, 16))
        : String(w.fields?.[field] ?? '');
      out.push(composeLine(width, [
        { t: `▸ ${WIZARD_LABELS[i]}：`, c: [CODE.bold] },
        { t: shown, c: [CODE.bold] },
        { t: '▌', c: [CODE.reverse] },
      ], [CODE.reverse]));
    } else if (i === 1) { // 岗位：已选=值，未到=占位
      const done = w.fields?.provider != null;
      out.push(composeLine(width, [
        { t: `${done ? '✓' : '·'} ${WIZARD_LABELS[i]}：`, c: [CODE.dim] },
        { t: done ? w.fields.provider : '', c: [CODE.dim] },
      ]));
    } else if (w.step > i) {
      const v = i === 4 ? (w.fields?.secret ? '＊＊＊＊（已填）' : '（未填）') : String(w.fields?.[field] ?? '');
      out.push(composeLine(width, [
        { t: `✓ ${WIZARD_LABELS[i]}：`, c: [CODE.dim] },
        { t: v, c: [CODE.dim] },
      ]));
    } else {
      out.push(paint(`· ${WIZARD_LABELS[i]}：`, CODE.dim));
    }
  }
  if (w.err) out.push(paint(`⚠ ${w.err}`, CODE.red));
  if (w.step === 5) { // 摘要确认
    const f = w.fields ?? {};
    out.push(paint('─'.repeat(Math.min(width, 44)), CODE.dim));
    out.push(composeLine(width, [{ t: `  姓名：${f.name ?? ''}`, c: [] }]));
    out.push(composeLine(width, [{ t: `  岗位：${f.provider ?? '?'}（工位 ${f.cwd ?? ''}）`, c: [] }]));
    out.push(composeLine(width, [{ t: `  通道：${w.channel ?? '—'}（机器人 ID ${f.botId || '—'}${f.secret ? '，Secret 已填' : '，Secret 未填'}）`, c: [] }]));
    out.push(composeLine(width, [{ t: `  工牌号：${w.id ?? '?'}（自动分配）`, c: [CODE.dim] }]));
    out.push(paint('  入职后先调休（enabled=false）——到 Web 人事部完善资料，或选中按空格返岗', CODE.dim));
    out.push(composeLine(width, [{ t: '确认 办理入职？(y/n)', c: [CODE.bold, CODE.yellow] }]));
  }
  return out;
};

// Incremental tail of data/logs/wao.log: first poll seeks to the last 64KB
// (drops the partial first line), then reads only the growth. Rotation
// (size < offset) rewinds to 0. Returns string[] (≤20 lines kept) or null
// when the file is not readable on this machine. Synchronous on purpose —
// poll runs on the 1s tick and reads are tiny.
export const makeLogTailer = (file) => {
  let offset = -1;
  let buf = '';
  let lines = [];
  return () => {
    if (file == null) return null;
    let size;
    try { size = statSync(file).size; } catch { return null; }
    if (offset < 0) { // first poll: start near the end, skip the partial line
      offset = Math.max(0, size - 64 * 1024);
      if (offset > 0 && offset < size) offset += 1;
    } else if (size < offset) { // rotated/truncated: rewind
      offset = 0; buf = '';
    }
    if (size > offset + 1024 * 1024) { // runaway growth: jump to the last 1MB
      offset = size - 1024 * 1024; buf = '';
    }
    const len = size - offset;
    if (len <= 0) return lines;
    let fd;
    try { fd = openSync(file, 'r'); } catch { return null; }
    const chunk = Buffer.alloc(len);
    try { readSync(fd, chunk, 0, len, offset); } catch { return lines; } finally { closeSync(fd); }
    offset = size;
    buf += chunk.toString('utf8');
    const parts = buf.split('\n');
    buf = parts.pop() ?? '';
    for (const p of parts) if (p.trim() !== '') lines.push(p.replace(/\r$/, ''));
    lines = lines.slice(-20);
    return lines;
  };
};

// —— W2 T2: keyboard operations (pure, terminal-free testable) ————————————
//
// handleKey(state, ev, deps) → { state, effects }: ev is the readline
// keypress payload { seq, key: { name, ctrl, meta } }; deps injects the two
// impure bits ({ base } for the e-key URL, { genId } for badge-id rolls).
// Effects are PLAIN DESCRIPTORS ({type:'toggle'|'test'|'ledger'|'send'|
// 'ports'|'createBot'|'openUrl'|'quit', …}) — the attach shell maps them to
// the same /api the Web console uses; tests assert descriptors without a
// terminal or a server. applyResult(state, effect, result) folds an
// operation's outcome ({ok:true,data} | {ok:false,error}) back into state.
//
// Modes: dashboard (↑↓/space/t/b/l/n/e/q) · confirm (y/n) · input (typing)
// · pick (broadcast target) · result (scrollable probation output) ·
// wizard (mini hire). Every mutating operation goes through a confirm row;
// input modes intercept all other keys.

// 工牌号 roll（与 Web 人事部 rollBadgeId 同规则：hr- + 6 位无歧义字符）。
export const genBadgeId = (taken) => {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const has = new Set(Array.isArray(taken) ? taken : []);
  for (let i = 0; i < 64; i++) {
    let s = '';
    for (let k = 0; k < 6; k++) s += abc[Math.floor(Math.random() * abc.length)];
    const id = `hr-${s}`;
    if (!has.has(id)) return id;
  }
  return `hr-${Date.now().toString(36)}`;
};

const DEFAULT_STATE = {
  agents: [], selectedIdx: 0, mode: 'dashboard', busy: 0, notice: null,
  confirm: null, input: null, pick: null, result: null, wizard: null, logZoom: false,
};
const backToDashboard = (state, extra = {}) => ({
  ...state, mode: 'dashboard', confirm: null, input: null, pick: null, result: null, wizard: null, ...extra,
});
const selectedAgent = (state) => (state.agents.length === 0
  ? null : state.agents[Math.min(Math.max(0, state.selectedIdx), state.agents.length - 1)]);
const noEmployees = (state) => ({
  state: { ...state, notice: { text: '公司还没有员工——按 n 办理入职', kind: 'error' } },
  effects: [],
});

// Each confirm kind → the effect its 'y' produces.
const confirmEffect = (confirm) => {
  const p = confirm.payload ?? {};
  switch (confirm.kind) {
    case 'toggle': return { type: 'toggle', botId: p.botId, name: p.name, toEnabled: p.toEnabled !== false };
    case 'send': return { type: 'send', botId: p.botId, name: p.name, chatKey: p.chatKey, content: p.content };
    case 'hire': return { type: 'createBot', bot: p.bot };
    default: return null;
  }
};

const INPUT_CAPS = { test: 2000, 'bcast-content': 3500 };
const WIZARD_CAPS = { name: 30, cwd: 512, botId: 128, secret: 512 };

export function handleKey(state = {}, ev = {}, deps = {}) {
  const st = { ...DEFAULT_STATE, ...state };
  if (ev?.key?.ctrl && (ev.key.name === 'c' || ev.key.name === 'd')) {
    return { state: st, effects: [{ type: 'quit' }] };
  }
  const name = ev?.key?.name ?? '';
  const seq = typeof ev?.seq === 'string' ? ev.seq : '';
  const printable = !ev?.key?.ctrl && !ev?.key?.meta && seq.length === 1 ? seq : '';
  const enter = name === 'return' || name === 'enter' || seq === '\r' || seq === '\n';
  const none = { state: st, effects: [] };

  // —— dashboard：导航与操作入口 ————————————————————————————————————————
  if (st.mode === 'dashboard') {
    const sel = selectedAgent(st);
    const move = (delta) => {
      if (st.agents.length === 0) return none;
      const cur = Math.min(Math.max(0, st.selectedIdx), st.agents.length - 1);
      return { state: { ...st, selectedIdx: Math.min(st.agents.length - 1, Math.max(0, cur + delta)) }, effects: [] };
    };
    if (name === 'up') return move(-1);
    if (name === 'down') return move(1);
    if (name === 'escape') return { state: { ...st, notice: null }, effects: [] };
    if (printable === ' ') {
      if (sel == null) return noEmployees(st);
      const goingOff = sel.enabled !== false;
      return {
        state: {
          ...st, mode: 'confirm', notice: null,
          confirm: {
            text: `确认将 ${sel.name} ${goingOff ? '调休' : '返岗'}？(y/n)`,
            kind: 'toggle',
            payload: { botId: sel.id, name: sel.name, toEnabled: !goingOff },
          },
        },
        effects: [],
      };
    }
    if (printable === 't') {
      if (sel == null) return noEmployees(st);
      return {
        state: {
          ...st, mode: 'input', notice: null,
          input: {
            kind: 'test',
            prompt: `岗前测试 · ${sel.name}——测试问题（空=默认探针「回复：收到」）：`,
            value: '', secret: false, botId: sel.id, name: sel.name, err: null,
          },
        },
        effects: [],
      };
    }
    if (printable === 'b') {
      if (sel == null) return noEmployees(st);
      return { state: { ...st, notice: null }, effects: [{ type: 'ledger', botId: sel.id, name: sel.name }] };
    }
    if (printable === 'l') return { state: { ...st, logZoom: !st.logZoom }, effects: [] };
    if (printable === 'n') return { state: { ...st, notice: null }, effects: [{ type: 'ports' }] };
    if (printable === 'e') {
      return { state: st, effects: [{ type: 'openUrl', url: `${deps.base ?? 'http://127.0.0.1:8792'}/` }] };
    }
    if (printable === 'q') return { state: st, effects: [{ type: 'quit' }] };
    return none;
  }

  // —— confirm：y 执行 / n·esc 取消（其余键吞掉，防误触）————————————————
  if (st.mode === 'confirm') {
    if (printable === 'y' || printable === 'Y') {
      const effect = confirmEffect(st.confirm ?? {});
      if (effect == null) return { state: backToDashboard(st), effects: [] };
      return { state: backToDashboard(st), effects: [effect] };
    }
    if (printable === 'n' || printable === 'N' || name === 'escape') {
      return { state: backToDashboard(st), effects: [] };
    }
    return none;
  }

  // —— input：可打印字符累积 / 退格 / 回车提交 / esc 取消 ————————————————
  if (st.mode === 'input' && st.input != null) {
    const input = st.input;
    if (name === 'escape') return { state: backToDashboard(st), effects: [] };
    if (name === 'backspace') {
      return { state: { ...st, input: { ...input, value: String(input.value ?? '').slice(0, -1), err: null } }, effects: [] };
    }
    if (enter) {
      const value = String(input.value ?? '');
      if (input.kind === 'test') {
        return {
          state: backToDashboard(st),
          effects: [{ type: 'test', botId: input.botId, name: input.name, prompt: value.trim() === '' ? null : value }],
        };
      }
      if (input.kind === 'bcast-content') {
        if (value.trim() === '') {
          return { state: { ...st, input: { ...input, err: '广播内容不能为空' } }, effects: [] };
        }
        return {
          state: {
            ...st, mode: 'confirm', input: null,
            confirm: {
              text: '将真实发送到企微，确认？(y/n)',
              kind: 'send',
              payload: { botId: input.botId, name: input.name, chatKey: input.chatKey, content: value },
            },
          },
          effects: [],
        };
      }
      return none;
    }
    if (printable !== '') {
      const cap = INPUT_CAPS[input.kind] ?? 512;
      if (String(input.value ?? '').length >= cap) return none;
      return { state: { ...st, input: { ...input, value: String(input.value ?? '') + printable, err: null } }, effects: [] };
    }
    return none;
  }

  // —— pick：广播目标会话选择 ————————————————————————————————————————————
  if (st.mode === 'pick' && st.pick != null) {
    const pick = st.pick;
    const n = (pick.items ?? []).length;
    if (name === 'up' || name === 'down') {
      if (n === 0) return none;
      const cur = Math.min(Math.max(0, pick.idx ?? 0), n - 1);
      const idx = name === 'up' ? Math.max(0, cur - 1) : Math.min(n - 1, cur + 1);
      return { state: { ...st, pick: { ...pick, idx } }, effects: [] };
    }
    if (name === 'escape') return { state: backToDashboard(st), effects: [] };
    if (enter) {
      if (n === 0) return none;
      const chosen = pick.items[Math.min(Math.max(0, pick.idx ?? 0), n - 1)];
      if (pick.kind === 'bcast-chat') {
        return {
          state: {
            ...st, mode: 'input', pick: null,
            input: {
              kind: 'bcast-content',
              prompt: `广播到 ${chosen.value}——内容：`,
              value: '', secret: false, botId: pick.botId, name: pick.name, chatKey: chosen.value, err: null,
            },
          },
          effects: [],
        };
      }
      return none;
    }
    return none;
  }

  // —— result：岗前测试结果窗滚动 / 关闭 ————————————————————————————————
  if (st.mode === 'result') {
    if (name === 'up') return { state: { ...st, result: { ...st.result, scroll: Math.max(0, (st.result.scroll ?? 0) - 1) } }, effects: [] };
    if (name === 'down') return { state: { ...st, result: { ...st.result, scroll: (st.result.scroll ?? 0) + 1 } }, effects: [] }; // clamped at render
    if (name === 'escape' || enter) return { state: backToDashboard(st), effects: [] };
    return none;
  }

  // —— wizard：简版入职向导 ——————————————————————————————————————————————
  if (st.mode === 'wizard' && st.wizard != null) {
    const w = st.wizard;
    if (name === 'escape') return { state: backToDashboard(st), effects: [] };
    if (w.step === 1) { // 岗位选择（/api/ports providers 枚举）
      const n = (w.ports?.providers ?? []).length;
      if (name === 'up' || name === 'down') {
        if (n === 0) return none;
        const cur = Math.min(Math.max(0, w.pickIdx ?? 0), n - 1);
        const pickIdx = name === 'up' ? Math.max(0, cur - 1) : Math.min(n - 1, cur + 1);
        return { state: { ...st, wizard: { ...w, pickIdx } }, effects: [] };
      }
      if (enter && n > 0) {
        const provider = w.ports.providers[Math.min(Math.max(0, w.pickIdx ?? 0), n - 1)].id;
        return { state: { ...st, wizard: { ...w, step: 2, fields: { ...w.fields, provider }, err: null } }, effects: [] };
      }
      return none;
    }
    if (w.step === 5) { // 摘要确认
      if (printable === 'y' || printable === 'Y') {
        return { state: backToDashboard(st), effects: [{ type: 'createBot', bot: w.bot }] };
      }
      if (printable === 'n' || printable === 'N') return { state: backToDashboard(st), effects: [] };
      return none;
    }
    // 字段行编辑（0 名 / 2 cwd / 3 botId / 4 secret）
    const field = WIZARD_FIELD_OF_STEP[w.step];
    if (field == null) return none;
    if (name === 'backspace') {
      return { state: { ...st, wizard: { ...w, fields: { ...w.fields, [field]: String(w.fields[field] ?? '').slice(0, -1) }, err: null } }, effects: [] };
    }
    if (enter) {
      const value = String(w.fields[field] ?? '').trim();
      if (field !== 'secret' && value === '') {
        const label = { name: '姓名', cwd: '工位目录', botId: '机器人 ID' }[field] ?? '该字段';
        return { state: { ...st, wizard: { ...w, err: `${label}不能为空` } }, effects: [] };
      }
      if (field === 'name' && value.length > 30) {
        return { state: { ...st, wizard: { ...w, err: '姓名太长（≤30 字）' } }, effects: [] };
      }
      if (w.step === 4) { // secret 完成 → 组装入职档案，进入摘要
        const f = { ...w.fields, name: String(w.fields.name ?? '').trim(), cwd: String(w.fields.cwd ?? '').trim(), botId: String(w.fields.botId ?? '').trim() };
        const account = {};
        if (w.channelKeys?.has('botId') && f.botId !== '') account.botId = f.botId;
        if (w.channelKeys?.has('secret') && f.secret !== '') account.secret = f.secret;
        const bot = {
          id: w.id, name: f.name, enabled: false, channel: w.channel,
          account, provider: f.provider, providerConfig: { cwd: f.cwd }, allowedUsers: [],
        };
        return { state: { ...st, wizard: { ...w, fields: f, step: 5, err: null, bot } }, effects: [] };
      }
      return { state: { ...st, wizard: { ...w, step: w.step + 1, err: null } }, effects: [] };
    }
    if (printable !== '') {
      const cur = String(w.fields[field] ?? '');
      if (cur.length >= (WIZARD_CAPS[field] ?? 512)) return none;
      return { state: { ...st, wizard: { ...w, fields: { ...w.fields, [field]: cur + printable }, err: null } }, effects: [] };
    }
    return none;
  }

  return none;
}

// Fold an operation outcome back into state. result: {ok:true, data} |
// {ok:false, error, status?}. Failures land as a red notice carrying the
// API's own message (透传), success as a green notice / result window /
// pick list / wizard per effect type.
const OP_LABELS = {
  toggle: '调休/返岗', send: '广播', createBot: '入职', test: '岗前测试',
  ledger: '会话查询', ports: '岗位查询', openUrl: '打开浏览器',
};
export function applyResult(state = {}, effect = {}, result = {}, deps = {}) {
  const st = { ...DEFAULT_STATE, ...state };
  const label = OP_LABELS[effect.type] ?? '操作';
  const noticeState = (text, kind) => ({
    ...backToDashboard(st), notice: { text, kind },
  });
  if (result?.ok !== true) {
    return noticeState(`${label}失败：${result?.error ?? '未知错误'}`, 'error');
  }
  const data = result.data;
  switch (effect.type) {
    case 'toggle': {
      const on = data?.bot?.enabled !== false;
      return noticeState(
        on ? `🔋 已返岗：${effect.name}（恢复上岗）` : `🌴 已调休：${effect.name}（在途工作收尾后下线）`,
        'ok',
      );
    }
    case 'test':
      return {
        ...backToDashboard(st),
        mode: 'result',
        result: {
          title: `岗前测试 · ${effect.name}`,
          code: data?.code ?? 'error',
          finalText: data?.finalText ?? '',
          sessionId: data?.sessionId ?? null,
          events: data?.events ?? 0,
          errorText: data?.errorText ?? data?.reason ?? null,
          scroll: 0,
        },
      };
    case 'send':
      return noticeState(`📢 已广播：${effect.name} → ${effect.chatKey}`, 'ok');
    case 'createBot':
      return noticeState(
        `🎉 已入职：${data?.bot?.name ?? '?'}（工牌号 ${data?.bot?.id ?? '?'}，调休态）——到 Web 人事部完善资料，或选中按空格返岗`,
        'ok',
      );
    case 'ledger': {
      const rows = Array.isArray(data) ? data : [];
      const counts = new Map();
      for (const r of rows) {
        if (typeof r?.chatKey === 'string' && r.chatKey !== '') counts.set(r.chatKey, (counts.get(r.chatKey) ?? 0) + 1);
      }
      if (counts.size === 0) return noticeState(`${effect.name} 还没有会话记录——没有可广播的目标`, 'error');
      const items = [...counts.entries()].map(([k, n]) => ({ label: `${k}（${n} 轮）`, value: k }));
      return {
        ...backToDashboard(st),
        mode: 'pick',
        pick: { kind: 'bcast-chat', title: `广播 · 选择目标会话（${effect.name}）`, items, idx: 0, botId: effect.botId, name: effect.name },
      };
    }
    case 'ports': {
      const channels = Array.isArray(data?.channels) ? data.channels : [];
      const providers = Array.isArray(data?.providers) ? data.providers : [];
      if (providers.length === 0) return noticeState('没有在册岗位（先启用 provider 插件）——无法办理入职', 'error');
      if (channels.length === 0) return noticeState('没有在册通道（先启用 channel 插件）——无法办理入职', 'error');
      const channel = channels[0]; // Web 人事部同款默认：第一个通道
      const genId = deps.genId ?? genBadgeId;
      return {
        ...backToDashboard(st),
        mode: 'wizard',
        wizard: {
          step: 0, pickIdx: 0,
          ports: { channels, providers },
          channel: channel.id,
          channelKeys: new Set((Array.isArray(channel.accountSchema) ? channel.accountSchema : [])
            .map((s) => s?.key).filter(Boolean)),
          id: genId(st.agents.map((a) => a?.id)),
          fields: { name: '', provider: null, cwd: '', botId: '', secret: '' },
          err: null, bot: null,
        },
      };
    }
    case 'openUrl':
      return noticeState(
        result.degraded ? `无法调起浏览器——请手动访问 ${effect.url}` : `已在浏览器打开 ${effect.url}`,
        'ok',
      );
    default:
      return st;
  }
}

// e 键的宿主侧执行：macOS `open` / 其他平台 `xdg-open`，失败降级为可复制
// URL 的通知行（无 GUI 环境不炸、不清屏）。
export const openInBrowser = (url) => {
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    const r = spawnSync(cmd, [url], { timeout: 5000 });
    if (r.error == null && r.status === 0) return { ok: true, degraded: false };
  } catch { /* degraded */ }
  return { ok: true, degraded: true };
};
// The thin shell around the pure core: raw mode + 1s tick. Every tick
// repaints (clock moves); every fetchEveryTicks-th tick also fetches
// /api/agents (2s cadence). Keypresses run handleKey; the effects it returns
// are dispatched against the live /api (busy ⏳ in the top bar while one is
// in flight) and folded back with applyResult. A fetch failure flips
// connected=false (last roster kept on screen under the red bar) — the next
// fetch is the retry. Returns a handle with quit(code); onQuit(code) fires
// once the terminal is restored.
export function attachTUI({
  stream = process.stdout,
  input = process.stdin,
  base = 'http://127.0.0.1:8792',
  dataDir = null,
  fetchFn = (url, init) => fetch(url, init),
  now = () => Date.now(),
  intervalMs = 1000,
  fetchEveryTicks = 2,
  width = null,
  height = null,
  onQuit = null,
} = {}) {
  const sizeOf = () => ({
    w: width ?? (stream.isTTY && stream.columns > 0 ? stream.columns : 80),
    h: height ?? (stream.isTTY && stream.rows > 0 ? stream.rows : 24),
  });
  let state = {
    ...DEFAULT_STATE, now: now(), connected: false, logTail: null,
  };
  const tailLog = makeLogTailer(dataDir == null ? null : join(dataDir, 'logs', 'wao.log'));
  const deps = { base, genId: genBadgeId };
  let painted = false;
  let tick = 0;
  let quitCalled = false;

  const render = () => {
    const { w, h } = sizeOf();
    const frame = computeFrame(state, { width: w, height: h, target: base });
    // Alternate screen + per-line erase: cursor home, clear+write each row,
    // no newline after the last row (an exact-height frame would scroll).
    stream.write(`\x1b[H${frame.map((l) => `\x1b[2K${l}`).join('\n')}`);
    painted = true;
  };

  const pollAgents = async () => {
    try {
      const res = await fetchFn(`${base}/api/agents`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (!Array.isArray(body?.agents)) throw new Error('bad /api/agents shape');
      state.agents = body.agents;
      state.connected = true;
    } catch {
      state.connected = false; // keep the last roster; red bar narrates the retry
    }
  };

  // Effect execution: one helper per the SAME /api the Web console uses.
  // Client timeouts outrank the server's (test probe alone may take ~60s).
  const runApi = async (ef) => {
    const jsonFetch = async (url, init = {}, timeoutMs = 10_000) => {
      const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      if (!res.ok) return { ok: false, error: body?.error ?? `HTTP ${res.status}`, status: res.status };
      return { ok: true, data: body };
    };
    const post = (path, payload, timeoutMs) => jsonFetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    }, timeoutMs);
    switch (ef.type) {
      case 'toggle':
        return jsonFetch(`${base}/api/bots/${encodeURIComponent(ef.botId)}/toggle`, { method: 'POST' });
      case 'test':
        return post(`/api/bots/${encodeURIComponent(ef.botId)}/test`, ef.prompt ? { prompt: ef.prompt } : {}, 65_000);
      case 'ledger':
        return jsonFetch(`${base}/api/ledger?bot=${encodeURIComponent(ef.botId)}`);
      case 'send':
        return post('/api/send', { botId: ef.botId, chatKey: ef.chatKey, content: ef.content });
      case 'ports':
        return jsonFetch(`${base}/api/ports`);
      case 'createBot':
        return post('/api/bots', ef.bot, 30_000);
      default:
        return { ok: false, error: `unknown effect: ${ef.type}` };
    }
  };

  const dispatch = async (ef) => {
    state = { ...state, busy: (state.busy ?? 0) + 1 };
    render();
    let result;
    try {
      result = await runApi(ef);
    } catch (err) {
      result = { ok: false, error: `连接不上服务（${base}）：${err?.message ?? err}` };
    }
    state = applyResult(state, ef, result);
    state = { ...state, busy: Math.max(0, (state.busy ?? 1) - 1) };
    render();
  };

  const onTick = () => {
    tick++;
    if (tick % fetchEveryTicks === 1) void pollAgents();
    state.now = now();
    state.logTail = tailLog();
    render();
  };

  const onResize = () => { if (painted) render(); };
  const onSigint = () => quit(0);
  const onKeypress = (s, key) => {
    const { state: next, effects } = handleKey(state, { seq: typeof s === 'string' ? s : '', key }, deps);
    state = next;
    for (const ef of effects) {
      if (ef.type === 'quit') { quit(0); return; }
      if (ef.type === 'openUrl') { // local, sub-second: no busy spin-up
        state = applyResult(state, ef, openInBrowser(ef.url));
        continue;
      }
      void dispatch(ef);
    }
    render();
  };

  let timer = null;
  const cleanup = () => {
    if (timer != null) { clearInterval(timer); timer = null; }
    input.off?.('keypress', onKeypress);
    stream.off?.('resize', onResize);
    process.off('SIGINT', onSigint);
    try { input.setRawMode?.(false); } catch { /* already restored */ }
    // Show cursor, leave the alternate screen, reset attributes — in that
    // order, so the operator's shell prompt comes back clean.
    stream.write(`\x1b[?25h${RESET}\x1b[?1049l\n`);
  };
  const quit = (code) => {
    if (quitCalled) return;
    quitCalled = true;
    cleanup();
    onQuit?.(code);
  };

  stream.write('\x1b[?1049h\x1b[?25l\x1b[2J'); // alternate screen, hide cursor, clear
  try { input.setRawMode?.(true); } catch { /* non-TTY input: keypress still parses */ }
  readline.emitKeypressEvents(input);
  input.on('keypress', onKeypress);
  stream.on?.('resize', onResize);
  process.on('SIGINT', onSigint); // raw mode eats keyboard ^C; kill -INT lands here
  onTick(); // first frame immediately, not after intervalMs
  timer = setInterval(onTick, intervalMs);
  timer.unref?.(); // stdin (or the test's refs) owns liveness, not the clock

  return { quit, state };
}

// CLI entry (wao tui): refuse fast and friendly when no service is on the
// port — a dashboard over nothing is a wall of red. Resolves to an exit code.
export async function runTUI({
  port = 8792, host = '127.0.0.1', dataDir,
  stream = process.stdout, input = process.stdin,
} = {}) {
  const base = `http://${host}:${port}`;
  try {
    const res = await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    console.error(`wao: tui 连不上 ${base} —— 公司服务好像没在跑`);
    console.error('提示：先执行 wao start 启动服务（或用 --port 指定端口），再开仪表盘。');
    return 1;
  }
  const dir = dataDir ?? process.env.WAO_HOME ?? join(process.cwd(), 'data');
  await new Promise((resolve) => {
    attachTUI({ stream, input, base, dataDir: dir, onQuit: resolve });
  });
  return 0;
}
