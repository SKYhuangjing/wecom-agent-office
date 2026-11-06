// W2 T1/T2 ATTACH module of src/tui/: the thin shell around the pure core
// (render's computeFrame + engine's handleKey/applyResult). raw mode + 1s
// tick; every tick repaints (clock moves); every fetchEveryTicks-th tick
// also fetches /api/agents (2s cadence) and polls the log tail. Keypresses
// run handleKey; the effects it returns are dispatched against the live
// /api (busy ⏳ in the top bar while one is in flight; the SAME endpoints
// the Web console uses) and folded back with applyResult. A fetch failure
// flips connected=false (last roster kept on screen under the red bar) —
// the next fetch is the retry. Returns a handle with quit(code); onQuit
// (code) fires once the terminal is restored.
import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import readline from 'node:readline';
import process from 'node:process';
import { computeFrame } from './render.js';
import { DEFAULT_STATE, handleKey, applyResult, genBadgeId } from './engine.js';

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
    stream.write(`\x1b[?25h\x1b[0m\x1b[?1049l\n`);
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

  // `state` as a live getter: the local is rebound on every key/dispatch, a
  // plain property would hand callers a stale attach-time snapshot.
  return { quit, get state() { return state; } };
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
