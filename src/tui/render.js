// W2 T1/T2 RENDER module of src/tui/: computeFrame(state, opts) is a PURE
// function (state → string[] frame, ANSI included) — the whole visual
// contract is snapshot-testable without a terminal. Zero dependencies:
// hand-rolled ANSI + a display-width heuristic (CJK/fullwidth = 2) so an
// 80-col terminal never wraps a frame line. T2 modes (result / pick /
// wizard) render instead of the card area; confirm/input are rows pinned
// above the footer on a dashboard backdrop, notice is the inline ✓/✗ row.
import { WIZARD_FIELD_OF_STEP } from './engine.js';

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

// 终端注入清洗（评审 W2 T3 #2）：一切数据源字符串（员工名/日志行/岗前
// finalText/API error/chatKey）都是不可信输入——含 ESC 序列的文本进了帧就
// 能劫持运维终端（OSC 52 可写剪贴板、CSI 可改色/清屏；聊天用户文本会进
// wao.log 被日志窗 tail）。sanitizeTerminal 剥掉 OSC/CSI/其余 ESC 序列与
// 除 \n 外的全部 C0/C1 控制符，只留可见字符与空格；渲染器自己的配色码由
// paint() 在清洗之后包裹，不受影响。
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g; // OSC …（BEL | ST 结尾）
const CSI_RE = /\x1b\[[0-9;:<=>?]*[ -/]*[@-~]/g; // CSI 参数*中间字节*终止字节
const ESC_SEQ_RE = /\x1b[\x40-\x5f]/g; // 其余双字节 ESC 序列；散 ESC 由 C0 兜底
const CTRL_RE = /[\x00-\x09\x0b-\x1f\x7f\x80-\x9f]/g; // C0/C1 全剥，唯独放行 \n
export const sanitizeTerminal = (s) => String(s ?? '')
  .replace(OSC_RE, '')
  .replace(CSI_RE, '')
  .replace(ESC_SEQ_RE, '')
  .replace(CTRL_RE, '');
// 帧行变体：帧的一行里不能嵌 \n（会把整帧顶出行数上限）→ 换成空格。
const sanitizeLine = (s) => sanitizeTerminal(s).replace(/\n/g, ' ');
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
    let text = sanitizeLine(seg.t);
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
  const budget = Math.max(8, width - dispWidth(sanitizeLine(input.prompt ?? '')) - 4);
  let shown = raw;
  if (dispWidth(shown) > budget) {
    // 长值保尾（光标总在末尾，看的永远是刚敲的字）：从尾到头吃满预算，
    // … 打头。按码点倒序遍历（[...str].reverse()），代理对（emoji 等）整存整取。
    let w = 0;
    let cut = '';
    for (const ch of [...shown].reverse()) {
      const cw = isWide(ch.codePointAt(0)) ? 2 : 1;
      if (w + cw > budget) break;
      cut = ch + cut; // 头插 = 保尾字符的正序
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
      // 资产面徽章（v2 终审 Minor）：⚠ + 首条警示（黄）/ 🛠 + 装备工具数
      // （灰）——数据来自 /api/agents botRow 的 assetWarnings/assetTools 回显
      // （§8.1），警示长文由 composeLine 按 80 列预算 … 截断。
      const warnTitle = Array.isArray(a?.assetWarnings) && a.assetWarnings.length > 0
        ? String(a.assetWarnings[0] ?? '')
        : '';
      if (warnTitle !== '') segs.push({ t: '  ', c: [] }, { t: `⚠ ${warnTitle}`, c: [CODE.yellow] });
      const toolCount = Array.isArray(a?.assetTools) ? a.assetTools.length : 0;
      if (toolCount > 0) segs.push({ t: '  ', c: [] }, { t: `🛠${toolCount}`, c: [CODE.gray] });
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
    for (const l of tail) out.push(paint(sanitizeLine(l), CODE.dim));
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
  for (const l of wrapText(sanitizeLine(String(result.finalText ?? '')), Math.max(8, width - 4))) {
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
  if (w.err) out.push(paint(`⚠ ${sanitizeLine(w.err)}`, CODE.red));
  if (w.step === 5) { // 摘要确认
    const f = w.fields ?? {};
    out.push(paint('─'.repeat(Math.min(width, 44)), CODE.dim));
    out.push(composeLine(width, [{ t: `  姓名：${f.name ?? ''}`, c: [] }]));
    out.push(composeLine(width, [{ t: `  岗位：${f.provider ?? '?'}（工位 ${f.cwd ?? ''}）`, c: [] }]));
    out.push(composeLine(width, [{ t: `  通道：${w.channel ?? '—'}（机器人 ID ${f.botId || '—'}${f.secret ? '，Secret 已填' : '，Secret 未填'}）`, c: [] }]));
    out.push(composeLine(width, [{ t: `  工牌号：${w.id ?? '?'}（自动分配）`, c: [CODE.dim] }]));
    out.push(paint('  入职后先调休（enabled=false）——到 Web 人事部完善资料，或选中按空格返岗', CODE.dim));
    // 门禁警示（评审 W2 T3 #3）：TUI 简版向导不做 allowedUsers 字段（Web
    // 人事部已有完整编辑），但空门禁=接受任何企微用户发消息，必须醒目告知。
    out.push(paint('  ⚠ 门禁：未配置=接受任何企微用户发消息——返岗前到 Web 人事部配置白名单', CODE.yellow, CODE.bold));
    out.push(composeLine(width, [{ t: '确认 办理入职？(y/n)', c: [CODE.bold, CODE.yellow] }]));
  }
  return out;
};
