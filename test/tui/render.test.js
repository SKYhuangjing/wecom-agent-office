// W2 T1 render tests: computeFrame is a pure state→frame function, so the
// whole visual contract (top bar, employee cards, colors, truncation, log
// window, key bar) is pinned here without a terminal. The attach layer is
// thin by design — one smoke test covers enter/restore and the fetch tick.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeFrame, attachTUI, makeLogTailer, KEYBAR } from '../../src/tui.js';

const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
// Simplified display-width counter (CJK + emoji = 2) mirroring the renderer's
// invariant: no frame line may exceed the terminal width.
const dispW = (s) => {
  let w = 0;
  for (const ch of strip(s)) {
    const cp = ch.codePointAt(0);
    w += (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0x1f300 && cp <= 0x1f9ff) || cp === 0x23f0 ? 2 : 1;
  }
  return w;
};
const frameText = (frame) => frame.map(strip).join('\n');

const NOW = new Date(2026, 10, 7, 14, 23, 5).getTime(); // 14:23:05 local
const agent = (over = {}) => ({
  id: 'a1', name: '主号机器人', enabled: true, provider: 'dsh', channel: 'wecom',
  status: 'idle', running: 0, progress: null, todayTurns: 0, users: 0, chats: 0,
  turns: 0, reason: null, channelState: null, providerMissing: false,
  ...over,
});

test('computeFrame: 顶栏打卡钟 — 活钟 · 在岗 N/M · 今日工单 X', () => {
  const frame = computeFrame({
    agents: [agent({ todayTurns: 3 }), agent({ id: 'a2', name: 'Sky 分身 2', todayTurns: 2 })],
    now: NOW, connected: true, selectedIdx: 0, logTail: [],
  });
  assert.equal(frame.length, 24);
  assert.equal(strip(frame[0]), 'WAO 公司 │ ⏰ 14:23:05 │ 在岗 2/2 │ 今日工单 5');
});

test('computeFrame: 空名册提示办理入职', () => {
  const frame = computeFrame({ agents: [], now: NOW, connected: true, logTail: [] });
  assert.ok(frameText(frame).includes('公司还没有员工——按 n 办理入职'));
});

test('computeFrame: 工作中员工卡 — 状态青色 + 进度行 + 已用时 + 今日轮数', () => {
  const frame = computeFrame({
    agents: [agent({
      status: 'working',
      progress: { line: '🔧 修复中(第3步)', startedAt: NOW - 65_000, updatedAt: NOW },
      todayTurns: 5,
    })],
    now: NOW, connected: true, selectedIdx: 0, logTail: [],
  });
  const card = strip(frame[2]);
  assert.equal(card, '▸ 主号机器人  [工作中] dsh·wecom  🔧 修复中(第3步) · 65s  今日5轮');
  // 选中行反色合成（36;7）— 断言青色前缀而非完整 SGR 串。
  assert.ok(frame[2].includes('\x1b[36'), 'working card carries cyan');
});

test('computeFrame: 待命绿色 / 休假灰色带原因 / 停用=调休', () => {
  const frame = computeFrame({
    agents: [
      agent({ id: 'a1', name: '甲', status: 'idle' }),
      agent({ id: 'a2', name: '乙', status: 'offline', reason: '凭证无效' }),
      agent({ id: 'a3', name: '丙', enabled: false }),
    ],
    now: NOW, connected: true, selectedIdx: 1, logTail: [],
  });
  assert.ok(frameText(frame).includes('[待命]'));
  assert.ok(frame[2].includes('\x1b[32m'), 'idle carries green');
  assert.ok(frameText(frame).includes('[休假·凭证无效]'));
  assert.ok(frame[3].includes('\x1b[90'), 'offline carries gray (reversed)');
  assert.ok(frameText(frame).includes('[调休]'));
  assert.ok(frame[4].includes('\x1b[90m'), '调休 carries gray');
});

test('computeFrame: 断连时顶栏整条红 + 自动重试文案', () => {
  const frame = computeFrame({
    agents: [agent()], now: NOW, connected: false, logTail: [],
  }, { target: 'http://127.0.0.1:8792' });
  assert.equal(strip(frame[0]), '⚠ 连接已断开——每 2 秒自动重试（http://127.0.0.1:8792）');
  assert.ok(frame[0].includes('\x1b[31'), 'disconnect bar is red');
  assert.ok(!frameText(frame).includes('⏰'), 'no clock while disconnected');
});

test('computeFrame: 选中行 ▸ + 反色，未选中行空两格；越界下标收敛', () => {
  const mk = (sel) => computeFrame({
    agents: [agent({ id: 'a1', name: '甲' }), agent({ id: 'a2', name: '乙' })],
    now: NOW, connected: true, selectedIdx: sel, logTail: [],
  });
  const selFrame = mk(1);
  assert.ok(selFrame[3].includes('\x1b[7m'), 'selected row reverse video');
  assert.ok(strip(selFrame[3]).startsWith('▸ 乙'));
  assert.ok(!selFrame[2].includes('\x1b[7m'), 'unselected row is not reversed');
  assert.ok(strip(selFrame[2]).startsWith('  甲'));
  assert.ok(strip(mk(99)[3]).startsWith('▸ 乙'), 'out-of-range selection clamps to last');
  assert.ok(!mk(99)[2].includes('\x1b[7m'), 'clamped selection un-reverses the first row');
  assert.ok(strip(mk(-5)[2]).startsWith('▸ 甲'), 'negative selection clamps to first');
});

test('computeFrame: 长名/长行按显示宽度截断（CJK=2 列），不换行', () => {
  const longName = '测试员工姓名'.repeat(12); // 72 display cols alone
  const frame = computeFrame({
    agents: [agent({
      name: longName,
      status: 'working',
      progress: { line: '🔧 修复中(第3步)', startedAt: NOW - 65_000 },
    })],
    now: NOW, connected: true, selectedIdx: 0, logTail: [],
  }, { width: 60, height: 24 });
  for (const line of frame) assert.ok(dispW(line) <= 60, `line too wide: ${dispW(line)}`);
  assert.ok(frameText(frame).includes('…'), 'truncation elided');
  assert.ok(frameText(frame).includes('[工作中]'), 'status survives truncation');
});

test('computeFrame: 名册超出屏高 → 溢出行；帧恒等于 height 行', () => {
  const many = Array.from({ length: 30 }, (_, i) => agent({ id: `a${i}`, name: `员工${i}` }));
  const frame = computeFrame({
    agents: many, now: NOW, connected: true, selectedIdx: 0,
    logTail: ['tail-A', 'tail-B', 'tail-C', 'tail-D', 'tail-E'],
  });
  assert.equal(frame.length, 24);
  assert.ok(frameText(frame).includes('还有 15 位员工未显示'));
});

test('computeFrame: 日志尾随窗只取最后 5 行（灰）', () => {
  const frame = computeFrame({
    agents: [agent()], now: NOW, connected: true, selectedIdx: 0,
    logTail: ['tail-A', 'tail-B', 'tail-C', 'tail-D', 'tail-E', 'tail-F', 'tail-G'],
  });
  const text = frameText(frame);
  assert.ok(text.includes('tail-G') && text.includes('tail-F'));
  assert.ok(!text.includes('tail-A') && !text.includes('tail-B'));
  const logLine = frame.find((l) => strip(l) === 'tail-G');
  assert.ok(logLine?.includes('\x1b[2m'), 'log tail is dim');
});

test('computeFrame: 日志不可达 → 日志需本机；可达无输出 → 占位', () => {
  const away = computeFrame({ agents: [agent()], now: NOW, connected: true, logTail: null });
  assert.ok(frameText(away).includes('日志需本机'));
  const quiet = computeFrame({ agents: [agent()], now: NOW, connected: true, logTail: [] });
  assert.ok(frameText(quiet).includes('日志暂无输出'));
});

test('computeFrame: 键位栏是最后一行（T2 接行为的渲染占位）', () => {
  const frame = computeFrame({ agents: [agent()], now: NOW, connected: true, logTail: ['x'] });
  assert.equal(frame[frame.length - 1], KEYBAR);
  assert.equal(strip(frame[23]), '↑↓选择 空格:调休/返岗 t:岗前测试 b:广播 l:日志 n:入职 e:浏览器 q:退出');
});

test('makeLogTailer: 首拉取尾部、增量、轮转回卷、不可达为 null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-tui-log-'));
  const file = join(dir, 'wao.log');
  try {
    writeFileSync(file, ['h1', 'h2', 'h3', 'h4', 'h5'].map((s) => `${s}\n`).join(''));
    const tail = makeLogTailer(file);
    assert.deepEqual(tail(), ['h1', 'h2', 'h3', 'h4', 'h5']);
    appendFileSync(file, 'h6\nh7\n');
    assert.deepEqual(tail(), ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7']);
    truncateSync(file, 0); // rotation: size < offset → rewind, no wedge
    appendFileSync(file, 'r1\n');
    assert.ok(tail().includes('r1'));
    assert.equal(makeLogTailer(join(dir, 'missing.log'))(), null);
    assert.equal(makeLogTailer(null)(), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('attachTUI: 进备用屏渲染 → q 退出还原终端、停轮询', async () => {
  const stream = new EventEmitter();
  stream.write = (s) => stream.__out.push(s);
  stream.__out = [];
  stream.isTTY = true; stream.columns = 100; stream.rows = 30;
  const input = new EventEmitter();
  const rawModes = [];
  input.setRawMode = (v) => rawModes.push(v);
  let fetches = 0;
  const agents = [agent({ id: 'a1', name: '甲', todayTurns: 5 })];
  let code = null;
  attachTUI({
    stream, input, base: 'http://tui.test',
    dataDir: '/nonexistent-wao-data',
    fetchFn: async () => { fetches++; return { ok: true, json: async () => ({ agents }) }; },
    now: () => NOW,
    intervalMs: 10,
    onQuit: (c) => { code = c; },
  });
  await new Promise((r) => setTimeout(r, 40));
  const painted = stream.__out.join('');
  assert.ok(painted.includes('\x1b[?1049h'), 'enters the alternate screen');
  assert.ok(painted.includes('\x1b[?25l'), 'hides the cursor');
  assert.ok(painted.includes('WAO 公司'), 'renders the dashboard');
  assert.ok(painted.includes('在岗 1/1'));
  assert.ok(painted.includes('日志需本机'), 'unreachable data dir narrated');
  assert.ok(fetches >= 1, 'first fetch is immediate');

  input.emit('keypress', 'q', { name: 'q' }); // T2 owns the other keys
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(code, 0);
  const done = stream.__out.join('');
  assert.ok(done.includes('\x1b[?1049l'), 'leaves the alternate screen');
  assert.ok(done.includes('\x1b[?25h'), 'restores the cursor');
  const fetchesAtQuit = fetches;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(fetches, fetchesAtQuit, 'polling stopped after quit');
  assert.deepEqual(rawModes, [true, false]);
});
