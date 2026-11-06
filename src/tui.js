// W2 T1: `wao tui` — 运维仪表盘（owner dashboard）。Client view over an
// ALREADY-RUNNING service (default 127.0.0.1:8792): polls GET /api/agents
// every 2s and tails data/logs/wao.log when --data-dir is locally readable.
// Zero dependencies: node:readline (keypress) + hand-rolled ANSI.
//
// Architecture for testability: computeFrame(state, opts) is a PURE function
// (state → string[] frame, ANSI included) — the whole visual contract is
// snapshot-testable without a terminal. attachTUI() is the thin shell: raw
// mode, 1s tick (clock) driving a 2s fetch cadence + log tail poll →
// setState → full-frame repaint on the alternate screen. Ctrl-C / q restore
// the terminal and quit. W2 T2 layers keyboard operations on the same loop;
// T1 only renders the key bar as a placeholder.
import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';
import readline from 'node:readline';
import process from 'node:process';

const RESET = '\x1b[0m';
const CODE = {
  bold: '1', dim: '2', red: '31', green: '32', cyan: '36', gray: '90',
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

// 公司话状态词 (README §4.2: 状态只用 工作中/待命/休假 三档 + 调休 for the
// enabled=false toggle) — colors: working=青 / idle=绿 / offline+调休=灰.
const STATUS_LABEL = {
  working: { text: '工作中', code: CODE.cyan },
  idle: { text: '待命', code: CODE.green },
  offline: { text: '休假', code: CODE.gray },
};

export const KEYBAR = '↑↓选择 空格:调休/返岗 t:岗前测试 b:广播 l:日志 n:入职 e:浏览器 q:退出';
const LOG_WINDOW_ROWS = 5;

// computeFrame(state, opts) → string[] (exactly opts.height rows, ANSI codes
// embedded). state: { agents, now, connected, selectedIdx, logTail, mode }.
// agents rows come from GET /api/agents verbatim (botRow shape). logTail is
// string[] (reachable log, maybe empty) or null (log file not locally
// readable → 「日志需本机」). mode is T2's surface; T1 renders the dashboard
// regardless.
export function computeFrame(state = {}, opts = {}) {
  const {
    agents = [], now = 0, connected = true, selectedIdx = 0, logTail = [], mode = 'dashboard',
  } = state;
  const width = opts.width ?? 80;
  const height = opts.height ?? 24;
  const target = opts.target ?? 'http://127.0.0.1:8792';
  const lines = [];

  // 顶栏：打卡钟（活钟 · 在岗 N/M · 今日工单 X）。断连时整条换成红条。
  if (connected) {
    const onDuty = agents.filter((a) => (a?.status ?? 'offline') !== 'offline').length;
    const todayTurns = agents.reduce((n, a) => n + (a?.todayTurns ?? 0), 0);
    lines.push(composeLine(width, [
      { t: 'WAO 公司', c: [CODE.bold] },
      { t: ' │ ', c: [CODE.dim] },
      { t: `⏰ ${clockOf(now)}`, c: [CODE.bold] },
      { t: ' │ ', c: [CODE.dim] },
      { t: `在岗 ${onDuty}/${agents.length}`, c: [] },
      { t: ' │ ', c: [CODE.dim] },
      { t: `今日工单 ${todayTurns}`, c: [] },
    ]));
  } else {
    lines.push(paint(`⚠ 连接已断开——每 2 秒自动重试（${target}）`, CODE.red, CODE.bold));
  }
  lines.push(paint('─'.repeat(width), CODE.dim));

  // 员工卡区：每行一张。content rows = height - 顶栏2行 - 日志窗 - 键位栏1行
  // （日志窗占位：读不到/暂无输出各 1 行，有内容则末 5 行）。
  const logWindowRows = logTail == null || logTail.length === 0
    ? 1 : Math.min(LOG_WINDOW_ROWS, logTail.length);
  const contentRows = Math.max(1, height - 2 - logWindowRows - 1);
  const sel = agents.length === 0 ? 0 : Math.min(Math.max(0, selectedIdx), agents.length - 1);
  if (agents.length === 0) {
    lines.push('公司还没有员工——按 n 办理入职');
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
      lines.push(composeLine(width, segs, extra));
    });
    if (agents.length > contentRows) {
      lines.push(paint(`…还有 ${agents.length - visible.length} 位员工未显示`, CODE.dim));
    }
  }

  // 日志尾随窗（最后 5 行，灰色小字）；读不到日志文件时明说。
  const tail = logTail == null ? null : logTail.slice(-LOG_WINDOW_ROWS);
  if (logTail == null) {
    lines.push(composeLine(width, [
      { t: '日志需本机（在服务所在的机器上运行 wao tui 才能读取 data/logs/wao.log）', c: [CODE.dim] },
    ]));
  } else if (tail.length === 0) {
    lines.push(paint('日志暂无输出', CODE.dim));
  } else {
    for (const l of tail) lines.push(paint(l, CODE.dim));
  }

  // 键位栏（T2 接行为，此处渲染占位）+ 中部留白补齐到整屏；极小高度下宁可
  // 裁掉日志行也保住键位栏（帧永远恰好 height 行，diff 重绘才不漂移）。
  if (lines.length > height - 1) lines.length = height - 1;
  while (lines.length < height - 1) lines.push('');
  // 键位栏也受宽度约束：窄终端截断（T2 接行为，此处渲染占位）。
  lines.push(composeLine(width, [{ t: KEYBAR }]));
  return lines;
}

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

// The thin shell around computeFrame: raw mode + 1s tick. Every tick repaints
// (clock moves); every fetchEveryTicks-th tick also fetches /api/agents (2s
// cadence). A fetch failure flips connected=false (last roster kept on
// screen under the red bar) — the next fetch is the retry. Returns a handle
// with quit(code); onQuit(code) fires once the terminal is restored.
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
  const state = { agents: [], now: now(), connected: false, selectedIdx: 0, logTail: null, mode: 'dashboard' };
  const tailLog = makeLogTailer(dataDir == null ? null : join(dataDir, 'logs', 'wao.log'));
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
    if (key?.ctrl && (key.name === 'c' || key.name === 'd')) quit(0);
    else if (s === 'q' && state.mode === 'dashboard') quit(0);
    // Everything else (↑↓/space/t/b/l/n/e) is W2 T2.
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
