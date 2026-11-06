// W2 T2 keyboard-operation tests: handleKey/applyResult are PURE, so every
// key flow (space→y duty toggle, t probation input→result window, b
// broadcast chat-pick→content→confirm, n mini hire wizard end-to-end) is
// driven as a keypress sequence with INJECTED API results — no terminal, no
// server. Frame assertions run the resulting states through computeFrame to
// pin the T2 visuals (confirm row / input row / result window / pick list /
// wizard pages). One attachTUI test wires the shell: keypress → real effect
// dispatch through the fake fetchFn → notice row painted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { handleKey, applyResult, computeFrame, attachTUI, genBadgeId } from '../../src/tui.js';

const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const frameText = (state, opts = {}) => computeFrame(state, opts).map(strip).join('\n');
const frameRaw = (state, opts = {}) => computeFrame(state, opts).join('\n');
const NOW = new Date(2026, 10, 7, 14, 23, 5).getTime();

const agent = (over = {}) => ({
  id: 'a1', name: '主号机器人', enabled: true, provider: 'dsh', channel: 'wecom',
  status: 'idle', running: 0, progress: null, todayTurns: 0, users: 0, chats: 0,
  turns: 0, reason: null, channelState: null, providerMissing: false,
  ...over,
});
const baseState = (agents, over = {}) => ({
  agents, now: NOW, connected: true, selectedIdx: 0, logTail: [], mode: 'dashboard', ...over,
});
const DEPS = { base: 'http://127.0.0.1:8792', genId: () => 'hr-test01' };

// keypress shorthands (readline shapes)
const ch = (c, name = c) => ({ seq: c, key: { name } });
const ESC = { seq: '\x1b', key: { name: 'escape' } };
const UP = { seq: '', key: { name: 'up' } };
const DOWN = { seq: '', key: { name: 'down' } };
const ENTER = { seq: '\r', key: { name: 'return' } };
const SPACE = { seq: ' ', key: { name: 'space' } };
const BS = { seq: '\x7f', key: { name: 'backspace' } };

// drive(state, [ev...], deps) → { state, effects } — accumulate one flow.
const drive = (state, events, deps = DEPS) => events.reduce((acc, ev) => {
  const r = handleKey(acc.state, ev, deps);
  return { state: r.state, effects: [...acc.effects, ...r.effects] };
}, { state, effects: [] });

// type(state, '张三') → per-char keypresses
const type = (text) => [...text].map((c) => ch(c));

test('空格→y：确认行→执行 toggle；成功绿字/失败红字透传 reason', () => {
  const on = baseState([agent()]);
  const pressed = drive(on, [SPACE]);
  assert.equal(pressed.state.mode, 'confirm');
  assert.equal(pressed.effects.length, 0, '确认前不产生副作用');
  const text = frameText(pressed.state);
  assert.ok(text.includes('确认将 主号机器人 调休？(y/n)'), 'confirm row copy');
  assert.ok(frameRaw(pressed.state).includes('1;33'), 'confirm row is highlighted');

  const yes = handleKey(pressed.state, ch('y'), DEPS);
  assert.deepEqual(yes.effects, [{ type: 'toggle', botId: 'a1', name: '主号机器人', toEnabled: false }]);
  assert.equal(yes.state.mode, 'dashboard');

  const okState = applyResult(yes.state, yes.effects[0], { ok: true, data: { bot: { enabled: false } } });
  assert.equal(okState.notice.kind, 'ok');
  assert.ok(okState.notice.text.includes('已调休：主号机器人'));
  assert.ok(frameRaw(okState).includes('\x1b[32'), 'success notice is green');

  const failState = applyResult(yes.state, yes.effects[0], { ok: false, error: 'bot not found', status: 404 });
  assert.equal(failState.notice.kind, 'error');
  assert.ok(failState.notice.text.includes('调休/返岗失败：bot not found'), 'API reason relayed');
  assert.ok(frameRaw(failState).includes('\x1b[31'), 'failure notice is red');
});

test('空格→y：调休态员工走返岗文案；n 取消不产生副作用', () => {
  const off = baseState([agent({ enabled: false })]);
  const confirm = drive(off, [SPACE]).state;
  assert.ok(frameText(confirm).includes('确认将 主号机器人 返岗？(y/n)'));
  const yes = handleKey(confirm, ch('y'), DEPS);
  assert.equal(yes.effects[0].toEnabled, true);
  const back = applyResult(yes.state, yes.effects[0], { ok: true, data: { bot: { enabled: true } } });
  assert.ok(back.notice.text.includes('已返岗：主号机器人'));

  const no = handleKey(confirm, ch('n'), DEPS);
  assert.deepEqual(no.effects, []);
  assert.equal(no.state.mode, 'dashboard');
  const esc = handleKey(confirm, ESC, DEPS);
  assert.deepEqual(esc.effects, []);
  assert.equal(esc.state.mode, 'dashboard');
});

test('t→输入行→回车：默认探针与自定义 prompt；输入期间键位拦截', () => {
  const st0 = baseState([agent()]);
  const t = handleKey(st0, ch('t'), DEPS);
  assert.equal(t.state.mode, 'input');
  assert.equal(t.state.input.kind, 'test');
  const text = frameText(t.state);
  assert.ok(text.includes('岗前测试 · 主号机器人——测试问题'), 'input prompt row');
  assert.ok(text.includes('▌'), 'caret visible');

  // 输入模式吞掉一切其他键位（q 不退出、b 不广播、空格不调休）
  const typed = drive(t.state, [...type('你好吗'), ch('q'), ch('b'), SPACE], DEPS);
  assert.equal(typed.state.mode, 'input');
  assert.equal(typed.state.input.value, '你好吗qb ');
  assert.deepEqual(typed.effects, []);

  const back = drive(typed.state, [BS, BS], DEPS); // 退格有效
  assert.equal(back.state.input.value, '你好吗q');

  const submitted = handleKey(back.state, ENTER, DEPS);
  assert.deepEqual(submitted.effects, [{ type: 'test', botId: 'a1', name: '主号机器人', prompt: '你好吗q' }]);
  assert.equal(submitted.state.mode, 'dashboard');

  const empty = drive(handleKey(st0, ch('t'), DEPS).state, [ENTER], DEPS);
  assert.equal(empty.effects[0].prompt, null, '空输入=默认探针');
  const cancelled = drive(handleKey(st0, ch('t'), DEPS).state, [ESC], DEPS);
  assert.equal(cancelled.state.mode, 'dashboard');
  assert.deepEqual(cancelled.effects, []);
});

test('t 结果窗：code/finalText/sessionId 全展示；失败带原因；长文滚动；esc 关', () => {
  const st0 = baseState([agent()]);
  const submitted = drive(st0, [ch('t'), ...type('1+1=?'), ENTER], DEPS);
  const done = applyResult(submitted.state, submitted.effects[0], {
    ok: true,
    data: { code: 'completed', finalText: '等于 2', sessionId: 'sess-abc', events: 3 },
  });
  assert.equal(done.mode, 'result');
  const text = frameText(done);
  assert.ok(text.includes('岗前测试 · 主号机器人'));
  assert.ok(text.includes('code: completed  ✅ 通过'));
  assert.ok(text.includes('等于 2'));
  assert.ok(text.includes('会话：sess-abc'));
  assert.ok(text.includes('事件流：3 条'));

  // 未通过：红 code + 原因行
  const failed = applyResult(submitted.state, submitted.effects[0], {
    ok: true, data: { code: 'timeout', finalText: '', sessionId: null, events: 0, errorText: '网关超时' },
  });
  const failText = frameText(failed);
  assert.ok(failText.includes('code: timeout  ❌ 未通过'));
  assert.ok(failText.includes('原因：网关超时'));

  // 长文折行 + 滚动：1500 字回复在 24 行帧里只能看到开头
  const long = applyResult(submitted.state, submitted.effects[0], {
    ok: true, data: { code: 'completed', finalText: `甲乙丙丁。`.repeat(300), sessionId: 's', events: 1 },
  });
  const head = frameText(long);
  assert.ok(head.includes('↑↓滚动'), 'scroll indicator appears when content overflows');
  const scrolled = drive(long, [DOWN, DOWN, DOWN], DEPS);
  const scrolledText = frameText(scrolled.state);
  assert.ok(scrolledText.includes('↑↓滚动'));
  assert.notEqual(head, scrolledText, 'scrolling changes the visible window');
  assert.ok(frameText(drive(scrolled.state, [UP], DEPS).state).includes('↑↓滚动'));

  const closed = handleKey(scrolled.state, ESC, DEPS);
  assert.equal(closed.state.mode, 'dashboard');
  assert.equal(closed.state.result, null);
  // 回车也能关
  const closedByEnter = handleKey(long, ENTER, DEPS);
  assert.equal(closedByEnter.state.mode, 'dashboard');
});

test('b 广播链：台账枚举会话→选会话→内容→真实发送确认→执行', () => {
  const st0 = baseState([agent()]);
  const started = handleKey(st0, ch('b'), DEPS);
  assert.deepEqual(started.effects, [{ type: 'ledger', botId: 'a1', name: '主号机器人' }]);
  assert.equal(started.state.mode, 'dashboard', '台账拉取期间保持仪表盘');

  const picked = applyResult(started.state, started.effects[0], {
    ok: true,
    data: [
      { chatKey: 'wecom:group:1' }, { chatKey: 'wecom:group:1' }, { chatKey: 'wecom:group:2' },
    ],
  });
  assert.equal(picked.mode, 'pick');
  assert.equal(picked.pick.items.length, 2);
  const pickText = frameText(picked);
  assert.ok(pickText.includes('wecom:group:1（2 轮）'), 'chat list with turn counts');
  assert.ok(pickText.includes('wecom:group:2（1 轮）'));
  assert.ok(pickText.includes('广播 · 选择目标会话'));

  // ↓ 选中第二个会话 → 回车 → 内容输入
  const toContent = drive(picked, [DOWN, ENTER], DEPS);
  assert.equal(toContent.state.mode, 'input');
  assert.equal(toContent.state.input.chatKey, 'wecom:group:2');
  assert.ok(frameText(toContent.state).includes('广播到 wecom:group:2——内容'));

  const typed = drive(toContent.state, [...type('通知：明早十点例会')], DEPS);
  const emptyFlow = drive(toContent.state, [ENTER], DEPS); // 内容必填
  assert.equal(emptyFlow.state.mode, 'input');
  assert.equal(emptyFlow.state.input.err, '广播内容不能为空');
  assert.deepEqual(emptyFlow.effects, []);

  const confirm = handleKey(typed.state, ENTER, DEPS);
  assert.equal(confirm.state.mode, 'confirm');
  assert.ok(frameText(confirm.state).includes('将真实发送到企微，确认？(y/n)'));

  const sent = handleKey(confirm.state, ch('y'), DEPS);
  assert.deepEqual(sent.effects, [{
    type: 'send', botId: 'a1', name: '主号机器人', chatKey: 'wecom:group:2', content: '通知：明早十点例会',
  }]);
  const done = applyResult(sent.state, sent.effects[0], { ok: true, data: { ok: true } });
  assert.ok(done.notice.text.includes('已广播：主号机器人 → wecom:group:2'));
  // 发送失败（bot 离线 409）红字透传
  const failed = applyResult(sent.state, sent.effects[0], { ok: false, error: 'bot is offline', status: 409 });
  assert.ok(failed.notice.text.includes('广播失败：bot is offline'));
  // n 取消发送
  const aborted = handleKey(confirm.state, ch('n'), DEPS);
  assert.deepEqual(aborted.effects, []);
});

test('b：无台账提示「还没有会话记录」；esc 可中途退出选择', () => {
  const st0 = baseState([agent()]);
  const started = handleKey(st0, ch('b'), DEPS);
  const empty = applyResult(started.state, started.effects[0], { ok: true, data: [] });
  assert.equal(empty.mode, 'dashboard');
  assert.ok(empty.notice.text.includes('还没有会话记录'));

  const withRows = applyResult(started.state, started.effects[0], { ok: true, data: [{ chatKey: 'k1' }] });
  const out = drive(withRows, [ESC], DEPS);
  assert.equal(out.state.mode, 'dashboard');
  assert.deepEqual(out.effects, []);
});

test('n 入职向导全流程：逐字段→摘要→y=POST /api/bots（enabled=false）', () => {
  const st0 = baseState([agent()]);
  const started = handleKey(st0, ch('n'), DEPS);
  assert.deepEqual(started.effects, [{ type: 'ports' }]);

  const wizard = applyResult(started.state, started.effects[0], {
    ok: true,
    data: {
      channels: [{ id: 'wecom', accountSchema: [{ key: 'botId' }, { key: 'secret' }] }],
      providers: [{ id: 'dsh' }, { id: 'claude' }],
    },
  }, DEPS);
  assert.equal(wizard.mode, 'wizard');
  assert.equal(wizard.wizard.step, 0);
  assert.equal(wizard.wizard.id, 'hr-test01');
  let text = frameText(wizard);
  assert.ok(text.includes('入职向导'));
  assert.ok(text.includes('▸ 姓名：'), 'name field is the editing row');

  // 空名被拒
  const noName = drive(wizard, [ENTER], DEPS);
  assert.equal(noName.state.wizard.step, 0);
  assert.equal(noName.state.wizard.err, '姓名不能为空');

  // 名 → 岗位选择页（providers 枚举）
  const atPick = drive(wizard, [...type('张三'), ENTER], DEPS);
  assert.equal(atPick.state.wizard.step, 1);
  text = frameText(atPick.state);
  assert.ok(text.includes('选择岗位'));
  assert.ok(text.includes('dsh') && text.includes('claude'));

  const atCwd = drive(atPick.state, [DOWN, ENTER], DEPS); // 选第二个岗位 claude
  assert.equal(atCwd.state.wizard.step, 2);
  assert.equal(atCwd.state.wizard.fields.provider, 'claude');
  text = frameText(atCwd.state);
  assert.ok(text.includes('✓ 姓名：张三'), 'done field collapses');
  assert.ok(text.includes('▸ 工位（cwd）：'), 'cwd is editing');

  const atBotId = drive(atCwd.state, [...type('/tmp/desk'), ENTER], DEPS);
  assert.equal(atBotId.state.wizard.step, 3);

  const atSecret = drive(atBotId.state, [...type('wwbot42'), ENTER], DEPS);
  assert.equal(atSecret.state.wizard.step, 4);
  // secret 不回显：帧里是 ＊，不是明文
  const secretTyped = drive(atSecret.state, [...type('s3cret')], DEPS);
  const secretFrame = frameText(secretTyped.state);
  assert.ok(secretFrame.includes('＊'));
  assert.ok(!secretFrame.includes('s3cret'), 'secret never echoes in the clear');

  const atSummary = drive(secretTyped.state, [ENTER], DEPS);
  assert.equal(atSummary.state.wizard.step, 5);
  text = frameText(atSummary.state);
  assert.ok(text.includes('姓名：张三'));
  assert.ok(text.includes('岗位：claude（工位 /tmp/desk）'));
  assert.ok(text.includes('通道：wecom（机器人 ID wwbot42，Secret 已填）'));
  assert.ok(text.includes('工牌号：hr-test01（自动分配）'));
  assert.ok(text.includes('调休'));
  assert.ok(text.includes('办理入职？(y/n)'));

  const hired = handleKey(atSummary.state, ch('y'), DEPS);
  assert.deepEqual(hired.effects, [{
    type: 'createBot',
    bot: {
      id: 'hr-test01', name: '张三', enabled: false, channel: 'wecom',
      account: { botId: 'wwbot42', secret: 's3cret' },
      provider: 'claude', providerConfig: { cwd: '/tmp/desk' }, allowedUsers: [],
    },
  }]);

  const done = applyResult(hired.state, hired.effects[0], {
    ok: true, data: { bot: { id: 'hr-test01', name: '张三' } },
  });
  assert.ok(done.notice.text.includes('已入职：张三（工牌号 hr-test01，调休态）'));
  assert.ok(done.notice.text.includes('按空格返岗'));

  // API 校验失败（如缺字段）红字透传
  const invalid = applyResult(hired.state, hired.effects[0], { ok: false, error: 'providerConfig.cwd is required' });
  assert.ok(invalid.notice.text.includes('入职失败：providerConfig.cwd is required'));

  // esc 中途放弃 / 摘要 n 取消
  const quitMid = drive(atCwd.state, [ESC], DEPS);
  assert.equal(quitMid.state.mode, 'dashboard');
  const noHire = handleKey(atSummary.state, ch('n'), DEPS);
  assert.deepEqual(noHire.effects, []);
});

test('n：无可册岗位/通道直接拒绝；Secret 允许留空（交给 API 校验）', () => {
  const st0 = baseState([agent()]);
  const started = handleKey(st0, ch('n'), DEPS);
  const noProv = applyResult(started.state, started.effects[0], {
    ok: true, data: { channels: [{ id: 'wecom' }], providers: [] },
  });
  assert.ok(noProv.notice.text.includes('没有在册岗位'));
  const noChan = applyResult(started.state, started.effects[0], {
    ok: true, data: { channels: [], providers: [{ id: 'dsh' }] },
  });
  assert.ok(noChan.notice.text.includes('没有在册通道'));

  // 全流程但 secret 留空 → account 不带 secret 键
  const wizard = applyResult(started.state, started.effects[0], {
    ok: true,
    data: {
      channels: [{ id: 'wecom', accountSchema: [{ key: 'botId' }, { key: 'secret' }] }],
      providers: [{ id: 'dsh' }],
    },
  }, DEPS);
  const flow = drive(wizard, [
    ...type('李四'), ENTER, ENTER, ...type('/x'), ENTER, ...type('bot9'), ENTER, ENTER, // secret 空
  ], DEPS);
  assert.equal(flow.state.wizard.step, 5);
  const hired = handleKey(flow.state, ch('y'), DEPS);
  assert.deepEqual(hired.effects[0].bot.account, { botId: 'bot9' });
  assert.ok(frameText(flow.state).includes('Secret 未填'));
});

test('l：日志窗 5 行 ↔ 半屏切换；e：浏览器打开与降级', () => {
  const tail = Array.from({ length: 12 }, (_, i) => `L${i}`);
  const st0 = baseState([agent()], { logTail: tail });
  const normal = frameText(st0);
  assert.ok(normal.includes('L11') && !normal.includes('L3'), 'default window shows last 5');
  const zoomedState = handleKey(st0, ch('l'), DEPS).state;
  assert.equal(zoomedState.logZoom, true);
  const zoomed = frameText(zoomedState);
  assert.ok(zoomed.includes('L1\nL2') || zoomed.includes('L1') && zoomed.includes('L2'), 'half-screen window reaches further back');
  const countShown = (text) => tail.filter((l) => text.includes(`\n${l}`) || text.startsWith(l)).length;
  assert.ok(countShown(zoomed) > countShown(normal), 'zoom shows more log lines');
  const back = handleKey(zoomedState, ch('l'), DEPS).state;
  assert.equal(back.logZoom, false);

  const e = handleKey(st0, ch('e'), DEPS);
  assert.deepEqual(e.effects, [{ type: 'openUrl', url: 'http://127.0.0.1:8792/' }]);
  const opened = applyResult(e.state, e.effects[0], { ok: true, degraded: false });
  assert.ok(opened.notice.text.includes('已在浏览器打开 http://127.0.0.1:8792/'));
  const degraded = applyResult(e.state, e.effects[0], { ok: true, degraded: true });
  assert.ok(degraded.notice.text.includes('请手动访问 http://127.0.0.1:8792/'));
});

test('↑↓ 移动选中；空名册下操作键给出指引；esc 清通知；q/Ctrl-C 退出', () => {
  const two = baseState([agent({ id: 'a1', name: '甲' }), agent({ id: 'a2', name: '乙' })]);
  const down = handleKey(two, DOWN, DEPS).state;
  assert.equal(down.selectedIdx, 1);
  const up = handleKey(down, UP, DEPS).state;
  assert.equal(up.selectedIdx, 0);
  assert.equal(handleKey(two, UP, DEPS).state.selectedIdx, 0, 'clamped at top');
  assert.equal(handleKey(down, DOWN, DEPS).state.selectedIdx, 1, 'clamped at bottom');

  const empty = baseState([]);
  for (const k of [SPACE, ch('t'), ch('b')]) {
    const r = handleKey(empty, k, DEPS);
    assert.deepEqual(r.effects, []);
    assert.ok(r.state.notice.text.includes('公司还没有员工'), `${k.key?.name} guards empty roster`);
  }

  const noticed = { ...two, notice: { text: '旧通知', kind: 'ok' } };
  const cleared = handleKey(noticed, ESC, DEPS).state;
  assert.equal(cleared.notice, null);

  assert.deepEqual(handleKey(two, ch('q'), DEPS).effects, [{ type: 'quit' }]);
  assert.deepEqual(handleKey(two, { seq: '\x03', key: { name: 'c', ctrl: true } }, DEPS).effects, [{ type: 'quit' }]);
  assert.deepEqual(handleKey(two, { seq: '\x04', key: { name: 'd', ctrl: true } }, DEPS).effects, [{ type: 'quit' }]);
});

test('busy 顶栏 ⏳；各模式键位栏换行内提示', () => {
  const busy = frameText(baseState([agent()], { busy: 1 }));
  assert.ok(busy.includes('⏳ 处理中'), 'busy flag paints in top bar');
  assert.ok(!frameText(baseState([agent()])).includes('⏳'));

  const confirm = handleKey(baseState([agent()]), SPACE, DEPS).state;
  assert.ok(frameText(confirm).split('\n').includes('y 确认执行 n/esc 取消'));
  const input = handleKey(baseState([agent()]), ch('t'), DEPS).state;
  assert.ok(frameText(input).split('\n').includes('回车 提交 esc 取消（输入期间其他键位暂停）'));
});

test('attachTUI：空格→y 走真 dispatch（fetchFn POST toggle）→ 绿字反馈上屏', async () => {
  const stream = new EventEmitter();
  stream.write = (s) => stream.__out.push(s);
  stream.__out = [];
  stream.isTTY = true; stream.columns = 100; stream.rows = 30;
  const input = new EventEmitter();
  input.setRawMode = () => {};
  const calls = [];
  const agents = [agent()];
  attachTUI({
    stream, input, base: 'http://tui.test',
    dataDir: '/nonexistent-wao-data',
    fetchFn: async (url, init) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ?? null });
      if (url.endsWith('/api/agents')) return { ok: true, json: async () => ({ agents }) };
      if (url.includes('/toggle')) return { ok: true, json: async () => ({ bot: { id: 'a1', enabled: false } }) };
      throw new Error(`unexpected url ${url}`);
    },
    now: () => NOW,
    intervalMs: 10,
  });
  await new Promise((r) => setTimeout(r, 30));
  input.emit('keypress', ' ', { name: 'space' });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(stream.__out.join('').includes('确认将 主号机器人 调休？'), 'confirm row painted');
  input.emit('keypress', 'y', { name: 'y' });
  await new Promise((r) => setTimeout(r, 30));
  const painted = stream.__out.join('');
  assert.ok(painted.includes('已调休：主号机器人'), 'success notice painted');
  assert.ok(painted.includes('\x1b[32'), 'notice is green');
  const toggle = calls.find((c) => c.method === 'POST' && c.url.includes('/toggle'));
  assert.ok(toggle, 'toggle POST dispatched to the real route shape');
  input.emit('keypress', 'q', { name: 'q' });
  await new Promise((r) => setTimeout(r, 10));
});

test('genBadgeId：hr- 前缀 + 避让已占用', () => {
  const taken = new Set(['hr-aaaaaa']);
  for (let i = 0; i < 20; i++) {
    const id = genBadgeId(taken);
    assert.match(id, /^hr-[a-z2-9]{6}($|[0-9a-z]+$)/);
    assert.ok(!taken.has(id));
    taken.add(id);
  }
});
