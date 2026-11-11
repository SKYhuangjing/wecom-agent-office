// Task 13: the real turn orchestration (DESIGN §6 numbered flow) living in
// defaultRunTurn. Everything below runs on millisecond-scale injected
// limits/capabilities with a scripted fake runner and a frame-recording fake
// adapter — the assertions pin:
//   - session resolution: native resume / switch-back delta replay (rule 4) /
//     full handoff prefix (rule 1, maxSeq with NO provider filter) / bornCwd
//     drift / dirty self-handoff,
//   - the outbound path: ack → throttled+budgeted progress → never-dropped
//     final, heartbeat survival over budget,
//   - two-phase deadline: warn frame closes the stream, late result goes via
//     push with no second final frame,
//   - code branches: completed / aborted / timeout (markDirty + reclassify
//     from hard-timer abort) / lock-conflict retry-once / missing-credential,
//   - bookkeeping: recordTurn four-state mapping, upsert with maxSeqAtBuild,
//     setConsumed (rule 2), timeline rows, progressor reset,
//   - abort-before-run and drain-refusal answering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Engine, defaultRunTurn } from '../../plugins/core-engine/engine.js';
import { Ledger } from '../../plugins/core-engine/ledger.js';
import { SessionCache } from '../../plugins/core-engine/sessionCache.js';
import { Timeline } from '../../plugins/core-engine/timeline.js';
import { createProgressor } from '../../plugins/core-engine/progressor.js';
import { maskOutbound } from '../../plugins/core-engine/middleware.js';

const K = 'wecom:group:g1';
const CWD = '/ws';
const HANDOFF_HEADER = '以下是本对话此前的记录（供上下文参考）：';
const ACK_TEXT = '✅ 收到，马上处理…';
const WARN_TEXT = '⏳ 任务仍在后台运行，完成后将主动推送结果';
const LOCK_TEXT = '该会话的写锁被另一个进程占用（可能是别的实例），机器人暂时无法回复。请稍后重试。';
const CANCEL_TEXT = '（已取消上一条回复）';
const DRAIN_INFLIGHT_TEXT = '⚠️ 服务维护，任务已中断，请重发';
const DRAIN_REFUSAL_TEXT = '⚠️ 服务维护，未处理，请重发';

// ms-scale defaults: no throttling/heartbeat interference unless a test asks.
const MS_LIMITS = {
  concurrency: 4, minIntervalMs: 0, heartbeatMs: 10_000, maxContentChars: 100,
  streamDeadlineMs: 600_000, hardTimeoutMs: 5_000, warnLeadMs: 90_000,
  outboundBudgetPerMin: 28,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));

function mkBot({ id = 'bot1', name, provider = 'codex', cwd = CWD, providerConfig } = {}) {
  return { id, name, provider, channel: 'wecom', providerConfig: { cwd, ...providerConfig } };
}
const mkMsg = (text, chatKey = K) => ({
  chatKey, chatKind: 'group', chatid: chatKey.split(':')[2], userid: 'u1',
  text, reqId: `req-${randomUUID()}`,
});

function fakeLog() {
  const lines = { debug: [], info: [], warn: [], error: [] };
  return {
    lines,
    debug: (m) => lines.debug.push(m), info: (m) => lines.info.push(m),
    warn: (m) => lines.warn.push(m), error: (m) => lines.error.push(m),
  };
}

// Channel adapter that records every outbound frame in order.
function fakeAdapter({ capabilities = { stream: true, push: true } } = {}) {
  const frames = [];
  return {
    frames, capabilities,
    ack: async (reqId, streamId, text) => { frames.push({ method: 'ack', at: Date.now(), reqId, streamId, text }); },
    progress: async (reqId, streamId, text, finish) => { frames.push({ method: 'progress', at: Date.now(), reqId, streamId, text, finish: !!finish }); },
    reply: async (reqId, text) => { frames.push({ method: 'reply', at: Date.now(), reqId, text }); },
    push: async (chatRef, text) => { frames.push({ method: 'push', at: Date.now(), chatRef, text }); },
  };
}

// Scripted provider runner: steps are consumed one per run() call (a
// lock-conflict retry therefore consumes the next step). `hangMs` parks the
// run until abort (the §5 contract: abort settles, never rejects).
function scriptedRunner(steps) {
  const calls = [];
  let idx = 0;
  const resultOf = (step, args, code) => ({
    ok: code === 'completed',
    code,
    finalText: step.finalText ?? '',
    aborted: step.aborted ?? code === 'aborted',
    sessionId: step.returnsSessionId !== undefined ? step.returnsSessionId : args.sessionId ?? null,
    reason: code,
    detail: step.detail,
  });
  return {
    calls,
    describeError: (r) => `DE[${r?.code ?? '?'}|${r?.detail ?? ''}]`,
    async run(args) {
      calls.push({ prompt: args.prompt, sessionId: args.sessionId, timeoutMs: args.timeoutMs });
      const step = steps[Math.min(idx++, steps.length - 1)];
      if (step.emit) for (const ev of step.emit) args.onEvent?.(ev);
      if (step.emitOver) for (const ev of step.emitOver) { args.onEvent?.(ev); if (ev.gapMs) await sleep(ev.gapMs); }
      if (step.never) return new Promise(() => {}); // 永不结算（settle-watchdog 用例）
      if (step.delayMs) await sleep(step.delayMs);
      if (step.hangMs !== undefined) {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, step.hangMs);
          if (args.signal.aborted) { clearTimeout(t); return resolve(); }
          args.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
        });
        return resultOf(step, args, step.hangCode ?? 'aborted');
      }
      return resultOf(step, args, step.code ?? 'completed');
    },
  };
}

const COMPLETE = (o = {}) => ({ code: 'completed', finalText: '答案内容', returnsSessionId: 's1', ...o });

function makeHarness({ steps, capabilities, limits, bot, middleware = { maskOutbound }, adapter, emit } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wao-run-'));
  const log = fakeLog();
  const ledger = new Ledger({ file: join(dir, 'ledger.jsonl'), log });
  const cache = new SessionCache({ file: join(dir, 'sessions.json'), log, ledger });
  const timeline = new Timeline();
  const progressor = createProgressor();
  const resets = [];
  const origReset = progressor.reset.bind(progressor);
  progressor.reset = () => { resets.push(Date.now()); origReset(); };
  const adap = adapter ?? fakeAdapter({ capabilities });
  const runner = scriptedRunner(steps ?? [COMPLETE()]);
  const b = bot ?? mkBot();
  const engine = new Engine({
    log, getRunner: () => runner, getAdapter: () => adap,
    ledgerFactory: () => ({ ledger, cache }),
    timeline, progressor, middleware, emit,
    limits: { ...MS_LIMITS, ...limits },
  });
  engine.attachBot(b, { adapter: adap, runner });
  const send = async (text, bb = b, chatKey = K) => {
    engine.onMessage(bb, mkMsg(text, chatKey));
    await engine.chains.get(chatKey);
    await tick();
  };
  return { engine, adapter: adap, runner, ledger, cache, timeline, progressor, resets, log, bot: b, send, dir };
}

// One §3 ledger row, seed-style (seq allocated by the ledger itself).
const seedRow = (ledger, o = {}) => ledger.recordTurn({
  chatKey: K, channel: 'wecom', chatKind: 'group', chatid: 'g1', userid: 'u1',
  user: '旧问题', assistant: '旧回答', provider: 'dsh', sessionId: 's-dsh',
  ok: true, reason: 'completed', tokens: null, cost: null, ...o,
});

// --- 1: happy path -----------------------------------------------------------

test('happy path: ack → throttled progress → final; ledger/cache/timeline/progressor effects', async () => {
  const h = makeHarness({
    // 2026-11-06 默认翻转（拟人播报 polite）：本用例钉的是旧「详细汇报」语义，
    // fixture 显式 progressStyle:'cot'（诚实迁移——断言一字不改）。
    bot: mkBot({ providerConfig: { progressStyle: 'cot' } }),
    steps: [{
      emit: [
        { type: 'tool', name: 'read', brief: '读取配置' },
        { type: 'text', text: '正文开始' },
      ],
      code: 'completed', finalText: '最终答案全文', returnsSessionId: 's1',
    }],
  });
  seedRow(h.ledger); seedRow(h.ledger); // two prior turns: maxSeq at build = 2

  await h.send('新问题');

  // frame order: ack (opens the stream) → ≥1 tool progress → final finish=true
  const frames = h.adapter.frames;
  assert.equal(frames[0].method, 'ack');
  assert.equal(frames[0].text, ACK_TEXT);
  assert.ok(/^s-/.test(frames[0].streamId), 'streamId is a fresh s-uuid');
  const progressFrames = frames.filter((f) => f.method === 'progress' && !f.finish);
  assert.ok(progressFrames.length >= 1, 'at least one progress frame');
  assert.ok(progressFrames.some((f) => f.text.includes('🔧')), 'tool line rendered');
  const final = frames[frames.length - 1];
  assert.equal(final.method, 'progress');
  assert.equal(final.finish, true);
  assert.ok(final.text.includes('最终答案全文'));
  assert.equal(final.streamId, frames[0].streamId, 'final lands on the same stream');

  // ledger row: completed with the runner's sessionId, raw user text
  const rows = h.ledger.turns({ chatKey: K });
  assert.equal(rows.length, 3);
  const row = rows[2];
  assert.equal(row.reason, 'completed');
  assert.equal(row.ok, true);
  assert.equal(row.sessionId, 's1');
  assert.equal(row.user, '新问题');
  assert.equal(row.assistant, '最终答案全文');

  // cache: rule-1 upsert used maxSeq BEFORE this turn (consumedAtBuild=2),
  // then rule 2 advanced consumedSeq to this turn's own row seq (3).
  const rec = h.cache.get(K);
  assert.equal(rec.current, 'codex');
  assert.equal(rec.cache.codex.sessionId, 's1');
  assert.equal(rec.cache.codex.bornCwd, CWD);
  assert.equal(rec.cache.codex.consumedAtBuild, 2);
  assert.equal(rec.cache.codex.consumedSeq, 3);

  // timeline got the event rows and the closing turn row; progressor reset once
  const kinds = h.timeline.get({ botId: h.bot.id }).map((r) => r.kind);
  assert.ok(kinds.includes('tool'), `tool row present (${kinds})`);
  assert.ok(kinds.includes('turn'), `turn row present (${kinds})`);
  assert.equal(h.resets.length, 1);
});

// --- 2: throttle + outbound budget -------------------------------------------

test('outbound budget + throttle: progress drops over budget, heartbeat survives, final never dropped', async () => {
  const h = makeHarness({
    // 同 happy path：钉旧「详细汇报」行为（🔧/已运行 心跳），显式 cot。
    bot: mkBot({ providerConfig: { progressStyle: 'cot' } }),
    limits: { minIntervalMs: 10, heartbeatMs: 60, outboundBudgetPerMin: 2 },
    steps: [{
      emitOver: Array.from({ length: 40 }, (_, i) => ({ type: 'tool', name: 't', brief: `b${i}`, gapMs: 8 })),
      code: 'completed', finalText: '预算内最终答案', returnsSessionId: 's1',
    }],
  });
  await h.send('灌事件');
  const frames = h.adapter.frames;

  const acks = frames.filter((f) => f.method === 'ack');
  const nonFinalProgress = frames.filter((f) => f.method === 'progress' && !f.finish);
  const hearts = frames.filter((f) => f.text && f.text.includes('已运行'));
  const finals = frames.filter((f) => f.method === 'progress' && f.finish);

  assert.equal(acks.length, 1, 'exactly one ack');
  // ack + event progress stay inside the per-minute budget (2): the event
  // stream stops first (DESIGN §6.4 超→先停事件流)
  assert.ok(acks.length + nonFinalProgress.length - hearts.length <= 2,
    `ack+event frames within budget: ack=${acks.length} progress=${nonFinalProgress.length} heart=${hearts.length}`);
  assert.equal(nonFinalProgress.filter((f) => !f.text.includes('已运行')).length, 1,
    'exactly one event progress frame (40 events collapsed by throttle+budget)');
  assert.ok(nonFinalProgress.some((f) => /🔧 t: b\d+/.test(f.text)), 'throttle kept the latest line');
  assert.ok(hearts.length >= 2, `heartbeat survives over budget (${hearts.length} seen)`);
  assert.equal(finals.length, 1);
  assert.ok(finals[0].text.includes('预算内最终答案'), 'final is never dropped');
});

// --- 3: two-phase deadline ----------------------------------------------------

test('two-phase: warn frame closes the stream at warnAt; late completion pushes, no second final frame', async () => {
  const h = makeHarness({
    limits: { streamDeadlineMs: 600, warnLeadMs: 100 }, // warnAt = 500ms
    steps: [{
      emit: [{ type: 'tool', name: 'slow', brief: '慢工具' }],
      delayMs: 1000, code: 'completed', finalText: '两阶段最终答案', returnsSessionId: 's1',
    }],
  });
  const t0 = Date.now();
  await h.send('长任务');

  const progressFrames = h.adapter.frames.filter((f) => f.method === 'progress');
  const warns = progressFrames.filter((f) => f.text === WARN_TEXT);
  assert.equal(warns.length, 1, 'exactly one warn frame');
  assert.equal(warns[0].finish, true, 'warn frame closes the stream');
  const warnDelay = warns[0].at - t0;
  assert.ok(warnDelay >= 440 && warnDelay <= 950, `warn fired at ~warnAt (+${warnDelay}ms)`);

  const pushes = h.adapter.frames.filter((f) => f.method === 'push');
  assert.equal(pushes.length, 1, 'background result delivered via push');
  assert.ok(pushes[0].text.includes('两阶段最终答案'));
  assert.equal(pushes[0].chatRef, K, 'push resolves the chat via the saved chatKey');

  // background mode: the final text NEVER re-appears as a stream frame
  assert.ok(!progressFrames.some((f) => f.text.includes('两阶段最终答案')),
    'final not re-sent as stream after the warn closed it');
  const lastProgress = progressFrames[progressFrames.length - 1];
  assert.equal(lastProgress.text, WARN_TEXT);

  const row = h.ledger.turns({ chatKey: K })[0];
  assert.equal(row.reason, 'completed', 'background mode does not change bookkeeping');
});

// chatRef/raw 双重语义修复（DESIGN-MULTIMODAL §1.2-7）：channel-wecom 传来的
// raw 是整帧回调对象（adapter.js 现状，channel-wecom.test.js 也在断言它），
// 不是渠道可解析的 push 引用 —— 后台模式的最终推送必须回落 chatKey，否则
// adapter.push 的 wecom:(group|single):<id> 正则会拒绝并丢弃整条结果。
test('background push falls back to chatKey when msg.raw is the whole wecom frame object', async () => {
  const h = makeHarness({
    limits: { streamDeadlineMs: 600, warnLeadMs: 100 }, // warnAt = 500ms
    steps: [{ delayMs: 1000, code: 'completed', finalText: '后台最终答案', returnsSessionId: 's1' }],
  });
  h.engine.onMessage(h.bot, { ...mkMsg('长任务'), raw: { cmd: 'aibot_msg_callback', body: { chattype: 'group' } } });
  await h.engine.chains.get(K);
  await tick();

  const pushes = h.adapter.frames.filter((f) => f.method === 'push');
  assert.equal(pushes.length, 1, 'background result delivered via push');
  assert.equal(pushes[0].chatRef, K, 'push resolves via chatKey, not the raw frame object');

  // 对照组：显式的 string raw 仍是合法 push 引用（渠道将来传引用时优先）。
  const h2 = makeHarness({
    limits: { streamDeadlineMs: 600, warnLeadMs: 100 },
    steps: [{ delayMs: 1000, code: 'completed', finalText: '后台最终答案2', returnsSessionId: 's1' }],
  });
  h2.engine.onMessage(h2.bot, { ...mkMsg('长任务', K), raw: 'wecom:group:G9' });
  await h2.engine.chains.get(K);
  await tick();
  const pushes2 = h2.adapter.frames.filter((f) => f.method === 'push');
  assert.equal(pushes2.length, 1);
  assert.equal(pushes2[0].chatRef, 'wecom:group:G9', 'a string raw IS the push ref');
});

// Known-boundaries wave (2026-11-06): the warn/hard timers' NARROW WINDOW — a
// timer firing after the runner promise settled but before stopTimers (the
// final frame's adapter awaits are the gap) must send NOTHING: the 「转后台」
// promise would be false (the final is already being delivered) and aborting
// a settled run reclassifies nothing. runSettled closes both timers.
test('narrow window: a warn timer firing after the runner settled sends no warn frame', async () => {
  // Slow progress adapter: the completed run's final frame PARKS in its
  // adapter await, holding the turn open past warnAt — exactly the window.
  const slow = fakeAdapter({});
  const origProgress = slow.progress;
  slow.progress = async (...a) => { await sleep(120); return origProgress(...a); };
  const h = makeHarness({
    adapter: slow,
    limits: { streamDeadlineMs: 80, warnLeadMs: 0 }, // warnAt = 80ms < 120ms park
    steps: [COMPLETE()], // settles immediately
  });
  await h.send('快任务');
  // The turn settles at ~t=120 (the parked final), but a stray warn's adapter
  // send is fire-and-forget — without the guard its frame would land at ~t=200.
  // Wait past that delivery window before judging the frame log.
  await sleep(280);

  const texts = h.adapter.frames.map((f) => f.text);
  assert.ok(!texts.includes(WARN_TEXT), `no warn frame for an already-settled run (${texts})`);
  const finals = h.adapter.frames.filter((f) => f.method === 'progress' && f.finish);
  assert.equal(finals.length, 1, 'the final still closes the stream');
  assert.ok(finals[0].text.includes('答案内容'), 'final content intact');
  assert.equal(h.adapter.frames.filter((f) => f.method === 'push').length, 0,
    'no false background mode (the run completed in-stream)');
  assert.equal(h.ledger.turns({ chatKey: K })[0].reason, 'completed');
});

// --- 4: hard timeout → dirty session + self-handoff ---------------------------

test('hard timeout: markDirty, timeout row, ⚠️ final; next turn self-handoffs without the old sessionId', async () => {
  const h = makeHarness({
    limits: { hardTimeoutMs: 300 },
    steps: [ // turn 1 establishes the native session; turn 2 hangs past 300ms;
      COMPLETE(),               // turn 3 runs on the fresh post-timeout session
      { hangMs: 60_000, hangCode: 'aborted', finalText: '' }, // runner can't distinguish abort causes
      COMPLETE({ returnsSessionId: 's2' }),
    ],
  });
  await h.send('第一轮');
  assert.equal(h.cache.get(K).cache.codex.sessionId, 's1');

  await h.send('第二轮');
  // engine reclassified the hard-timer abort to timeout
  const rows = h.ledger.turns({ chatKey: K });
  assert.equal(rows[1].reason, 'timeout');
  assert.equal(rows[1].ok, false);
  const final = h.adapter.frames.filter((f) => f.finish).pop();
  assert.ok(final.text.includes('⚠️ 任务超时未完成'), `timeout final text (${final.text})`);
  assert.equal(h.cache.get(K).cache.codex.dirty, true, 'session marked dirty');

  await h.send('第三轮');
  // dirty session → self-handoff: prefix present, old sessionId NOT passed
  const third = h.runner.calls[2];
  assert.equal(third.sessionId, null, 'old (dirty) sessionId must not be resumed');
  assert.ok(third.prompt.startsWith(HANDOFF_HEADER), 'self-handoff carries the ledger prefix');
  assert.ok(third.prompt.includes('第三轮'));
  assert.equal(h.cache.get(K).cache.codex.dirty, false, 'new session is clean');
  assert.equal(h.cache.get(K).cache.codex.sessionId, 's2');
});

// --- 5: preempted turn --------------------------------------------------------

test('aborted turn: partial + 打断 banner, interrupted row, consumedSeq advanced (rule 2)', async () => {
  const h = makeHarness({
    steps: [COMPLETE(), { code: 'aborted', aborted: true, finalText: '部分答案', returnsSessionId: 's1' }],
  });
  await h.send('第一轮');
  assert.equal(h.cache.get(K).cache.codex.consumedSeq, 1);
  await h.send('第二轮');

  const final = h.adapter.frames.filter((f) => f.finish).pop();
  assert.equal(final.method, 'progress');
  assert.ok(final.text.includes('部分答案'));
  assert.ok(final.text.includes('已被新消息打断'));

  const row = h.ledger.turns({ chatKey: K })[1];
  assert.equal(row.reason, 'interrupted');
  assert.equal(row.ok, false);
  assert.equal(row.assistant, '部分答案', 'partial output preserved in the row');
  assert.equal(h.cache.get(K).cache.codex.consumedSeq, 2, 'rule 2: interrupted row still advances');
});

test('aborted turn with no output sends the cancel copy', async () => {
  const h = makeHarness({ steps: [COMPLETE(), { code: 'aborted', aborted: true, finalText: '' }] });
  await h.send('第一轮');
  await h.send('第二轮');
  const final = h.adapter.frames.filter((f) => f.finish).pop();
  assert.equal(final.text, CANCEL_TEXT);
  assert.equal(h.ledger.turns({ chatKey: K })[1].reason, 'interrupted');
});

// --- 6: lock-conflict ---------------------------------------------------------

test('lock-conflict: retried once with the same sessionId, then normal final', async () => {
  const h = makeHarness({
    steps: [
      { code: 'lock-conflict', detail: 'busy' },
      { code: 'completed', finalText: '重试后完成', returnsSessionId: 's1' },
    ],
  });
  await h.send('抢锁');
  assert.equal(h.runner.calls.length, 2, 'exactly one retry');
  assert.equal(h.runner.calls[0].prompt, h.runner.calls[1].prompt, 'same prompt');
  assert.equal(h.runner.calls[1].sessionId, h.runner.calls[0].sessionId, 'sessionId resolution is NOT redone');
  const finals = h.adapter.frames.filter((f) => f.finish);
  assert.equal(finals.length, 1, 'single final');
  assert.ok(finals[0].text.includes('重试后完成'));
  const row = h.ledger.turns({ chatKey: K })[0];
  assert.equal(row.reason, 'completed');
});

// 2026-11-10 PC1 真机回归：缓存里的 session 在 CLI 磁盘已不存在（改过 config
// dir / transcript 被清 / 迁移只带缓存）时 --resume 秒败 error_during_execution
// ——用户只看到「任务未能完成」，且该会话永久坏掉。runner 映射成
// code='session-not-found'；引擎必须退役缓存 + fresh 重跑一次（带 handoff
// 前缀，续上历史），并把新 session 落到缓存。
test('session-not-found: cache retired, ONE fresh retry with handoff prefix, new session cached', async () => {
  const h = makeHarness({
    steps: [
      COMPLETE({ returnsSessionId: 's1', finalText: '第一轮' }),          // turn 1: 建立会话
      { code: 'session-not-found', returnsSessionId: 's1' },             // turn 2: resume 撞化石 id
      COMPLETE({ returnsSessionId: 's2', finalText: '自愈后回答' }),      // turn 2 retry: fresh
    ],
  });
  await h.send('第一问');
  // 默认 bot 的 provider 决定缓存键（mkBot: codex）
  const pk = h.bot.provider;
  assert.equal(h.cache.get(K)?.cache?.[pk]?.sessionId, 's1');

  await h.send('发图问路');

  assert.equal(h.runner.calls.length, 3, 'one turn = one self-heal retry');
  const retry = h.runner.calls[2];
  assert.equal(retry.sessionId, null, 'the retry is a FRESH session (stale id never reused)');
  assert.ok(retry.prompt.includes('发图问路'), 'user text survives the retry');
  assert.match(retry.prompt, /以下是本对话此前的记录/, 'handoff prefix replayed so context is not lost');
  assert.equal(h.cache.get(K)?.cache?.[pk]?.sessionId, 's2', 'new session adopted');
  const second = h.ledger.turns({ chatKey: K })[0];
  assert.equal(second.reason, 'completed', 'the user sees an answer, not a hard error');
  assert.equal(second.ok, true);
  assert.ok(h.log.lines.warn.some((m) => /missing on disk/.test(m)), 'self-heal is logged');
});

test('lock-conflict twice: exact 防线三 reply, error row, no session cached', async () => {
  const h = makeHarness({
    steps: [{ code: 'lock-conflict' }, { code: 'lock-conflict' }],
  });
  await h.send('还是抢锁');
  assert.equal(h.runner.calls.length, 2);
  const replies = h.adapter.frames.filter((f) => f.method === 'reply');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, LOCK_TEXT);
  const row = h.ledger.turns({ chatKey: K })[0];
  assert.equal(row.reason, 'error');
  assert.equal(row.ok, false);
  assert.equal(h.cache.get(K), undefined, 'no session cached for a failed turn');
});

// --- 7: missing credential ----------------------------------------------------

test('missing-credential: describeError reply verbatim, error row', async () => {
  const h = makeHarness({ steps: [{ code: 'missing-credential', detail: '凭证失效' }] });
  await h.send('坏凭证');
  const replies = h.adapter.frames.filter((f) => f.method === 'reply');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, 'DE[missing-credential|凭证失效]');
  const row = h.ledger.turns({ chatKey: K })[0];
  assert.equal(row.reason, 'error');
  assert.equal(h.cache.get(K), undefined);
});

// 2026-11-11 PC1 真机回归：模型网关未自启，claude CLI 把「API Error:
// Connection refused」当 success-shaped 流吐回，裸错误直达企微用户。runner
// 映射 code='gateway-unreachable'；引擎必须换友好文案，原话只落台账。
test('gateway-unreachable: friendly copy on the wire, raw API error only in the ledger', async () => {
  const rawApiError = 'API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)';
  const h = makeHarness({ steps: [{ code: 'gateway-unreachable', finalText: rawApiError }] });
  await h.send('最近的提交是啥');
  const GATEWAY_DOWN_TEXT = '⚠️ 服务暂时不可用（模型连接失败），请稍后重试；若持续出现请联系管理员。';
  const replies = h.adapter.frames.filter((f) => f.method === 'reply');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, GATEWAY_DOWN_TEXT);
  assert.ok(!h.adapter.frames.some((f) => /ECONNREFUSED|API Error/.test(f.text ?? '')), 'raw API error never reaches the wire');
  const row = h.ledger.turns({ chatKey: K })[0];
  assert.equal(row.reason, 'error');
  assert.equal(row.ok, false);
  assert.equal(row.assistant, rawApiError, 'ledger keeps the raw API error for forensics');
  assert.equal(h.cache.get(K), undefined, 'no session cached for a gateway-dead turn');
});

test('error with partial text keeps the partial plus a warning banner', async () => {
  const h = makeHarness({ steps: [{ code: 'error', finalText: '半成品' }] });
  await h.send('出错');
  const final = h.adapter.frames.filter((f) => f.finish).pop();
  assert.ok(final.text.includes('半成品'));
  assert.ok(final.text.includes('⚠️ 运行未正常结束'));
  assert.equal(h.ledger.turns({ chatKey: K })[0].reason, 'error');
});

// --- 8: provider switch -------------------------------------------------------

test('switch provider: full handoff prefix, upsert consumedAtBuild = maxSeq(chatKey) without provider filter', async () => {
  const h = makeHarness({ bot: mkBot({ provider: 'claude' }) });
  seedRow(h.ledger); seedRow(h.ledger); // two dsh rows: seq 1, 2
  h.cache.upsert(K, 'dsh', { sessionId: 's-dsh', bornCwd: CWD }, 1);

  await h.send('切到claude');
  const call = h.runner.calls[0];
  assert.equal(call.sessionId, null, 'new provider starts a fresh session');
  assert.ok(call.prompt.startsWith(HANDOFF_HEADER));
  assert.ok(call.prompt.includes('旧回答'), 'history crosses providers');
  assert.ok(call.prompt.endsWith('切到claude'));

  // counterexample-A pin: consumedAtBuild = 2 = maxSeq({chatKey}) over ALL
  // providers — a provider-filtered maxSeq would be 0 here.
  const rec = h.cache.get(K);
  assert.equal(rec.current, 'claude');
  assert.equal(rec.cache.claude.sessionId, 's1');
  assert.equal(rec.cache.claude.consumedAtBuild, 2);
  assert.equal(rec.cache.claude.consumedSeq, 3, 'rule 2 advanced past the claude row');
});

test('switch back: resumes INTO the cached session with only the delta replayed (rule 4)', async () => {
  const claudeBot = mkBot({ provider: 'claude' });
  const dshBot = mkBot({ provider: 'dsh', id: 'bot1' });
  const h = makeHarness({
    bot: claudeBot,
    steps: [
      COMPLETE({ finalText: 'claude的回答' }),
      { code: 'completed', finalText: 'dsh切回后的回答' }, // returns args.sessionId: the resumed id
    ],
  });
  seedRow(h.ledger, { user: 'q1', assistant: 'a1' });   // seq 1 (dsh)
  seedRow(h.ledger, { user: 'q2', assistant: 'a2' });   // seq 2 (dsh)
  h.cache.upsert(K, 'dsh', { sessionId: 's-dsh', bornCwd: CWD }, 1); // consumed through seq 1

  await h.send('claude轮', claudeBot); // seq 3 on claude, current=claude
  await h.send('切回dsh', dshBot);

  const call = h.runner.calls[1];
  assert.equal(call.sessionId, 's-dsh', 'switch-back resumes the cached dsh session');
  assert.ok(call.prompt.startsWith(HANDOFF_HEADER));
  assert.ok(call.prompt.includes('q2') && call.prompt.includes('a2'), 'delta includes the missed dsh row');
  assert.ok(!call.prompt.includes('q1'), 'already-consumed rows are NOT replayed');
  assert.ok(call.prompt.includes('claude的回答'), 'the other provider\'s turn is carried too');
  assert.ok(call.prompt.endsWith('切回dsh'));

  const dshEntry = h.cache.get(K).cache.dsh;
  assert.equal(dshEntry.sessionId, 's-dsh');
  assert.ok(dshEntry.consumedSeq >= 3, `consumed advanced to the delivered delta (${dshEntry.consumedSeq})`);
  assert.equal(h.cache.get(K).current, 'dsh');
});

// Review wave pin (switch-back × preemption window): the switch-back cache
// persistence must be POST-run (bookkeep). Persisting consumedSeq/current
// before the runner spawns meant a double-send during the ack window left
// consumedSeq advanced past rows nobody delivered — the replacement turn
// native-resumed WITHOUT the delta and the rows were never replayed again.
test('switch-back preempted during ack: the delta stays unconsumed and the replacement replays it (rule 4)', async () => {
  const claudeBot = mkBot({ provider: 'claude' });
  const dshBot = mkBot({ provider: 'dsh', id: 'bot1' });
  const h = makeHarness({
    bot: claudeBot,
    steps: [
      COMPLETE({ finalText: 'claude的回答' }),
      { code: 'completed', finalText: 'dsh切回后的回答' }, // returns args.sessionId: the resumed id
    ],
  });
  seedRow(h.ledger, { user: 'q1', assistant: 'a1' });   // seq 1 (dsh)
  seedRow(h.ledger, { user: 'q2', assistant: 'a2' });   // seq 2 (dsh)
  h.cache.upsert(K, 'dsh', { sessionId: 's-dsh', bornCwd: CWD }, 1); // consumed through seq 1

  await h.send('claude轮', claudeBot); // seq 3 on claude, current=claude

  // Preempt the switch-back turn INSIDE the ack window (double-send).
  let openAck;
  const ackGate = new Promise((r) => { openAck = r; });
  const origAck = h.adapter.ack.bind(h.adapter);
  h.adapter.ack = async (...a) => { await ackGate; await origAck(...a); };
  h.engine.onMessage(dshBot, mkMsg('切回dsh'));
  await tick(); // the switch-back turn is parked inside the ack await
  h.engine.onMessage(dshBot, mkMsg('再问')); // abort + merge
  openAck();
  await h.engine.chains.get(K);
  await tick();

  assert.equal(h.runner.calls.length, 2, 'the preempted switch-back never reached the runner');
  const call = h.runner.calls[1];
  assert.equal(call.sessionId, 's-dsh', 'the replacement takes the switch-back path again (current never flipped)');
  assert.ok(call.prompt.includes('q2') && call.prompt.includes('a2'),
    `the undelivered delta is replayed, not lost to the preemption window: ${call.prompt}`);
  assert.ok(call.prompt.includes('claude的回答'), 'cross-provider history still carried');
  assert.ok(call.prompt.endsWith('再问'));

  // The interrupted switch-back row is real history and rides the same replay
  // window; the completed replacement then advances consumed past everything.
  const rows = h.ledger.turns({ chatKey: K });
  assert.equal(rows.length, 5);
  assert.equal(rows[3].user, '切回dsh');
  assert.equal(rows[3].reason, 'interrupted');
  const dshEntry = h.cache.get(K).cache.dsh;
  assert.ok(dshEntry.consumedSeq >= 4, `consumed advanced past the replayed window (${dshEntry.consumedSeq})`);
  assert.equal(h.cache.get(K).current, 'dsh');
});

// --- 9: bornCwd drift ---------------------------------------------------------

test('bornCwd mismatch: treated as a new-session handoff (prefix, sessionId null)', async () => {
  const h = makeHarness({ bot: mkBot({ cwd: '/new-ws' }) });
  seedRow(h.ledger);
  h.cache.upsert(K, 'codex', { sessionId: 's-old', bornCwd: '/old-ws' }, 1);

  await h.send('换了目录');
  const call = h.runner.calls[0];
  assert.equal(call.sessionId, null, 'a session born in another cwd is never resumed');
  assert.ok(call.prompt.startsWith(HANDOFF_HEADER));
  const rec = h.cache.get(K);
  assert.equal(rec.cache.codex.sessionId, 's1');
  assert.equal(rec.cache.codex.bornCwd, '/new-ws', 'upsert stamps the new bornCwd');
});

// --- 10: aborted before the runner starts --------------------------------------

test('preempt during ack: no runner call, interrupted row with empty assistant, cancel frame', async () => {
  const h = makeHarness({ steps: [COMPLETE()] });
  let openAck;
  const ackGate = new Promise((r) => { openAck = r; });
  const origAck = h.adapter.ack.bind(h.adapter);
  h.adapter.ack = async (...a) => { await ackGate; await origAck(...a); };

  h.engine.onMessage(h.bot, mkMsg('first'));
  await tick(); // impl is parked inside the ack await
  h.engine.onMessage(h.bot, mkMsg('second')); // preempt: abort while acking
  openAck();
  await h.engine.chains.get(K);
  await tick();

  // The interrupted 'first' row IS real history: the replacement turn's new
  // session legitimately carries it in the handoff prefix.
  assert.equal(h.runner.calls.length, 1, 'doomed turn never reached the runner');
  assert.ok(h.runner.calls[0].prompt.endsWith('second'));
  const rows = h.ledger.turns({ chatKey: K });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].user, 'first');
  assert.equal(rows[0].reason, 'interrupted');
  assert.equal(rows[0].assistant, '');
  assert.equal(rows[1].reason, 'completed');
  const finals = h.adapter.frames.filter((f) => f.finish);
  assert.equal(finals.length, 2);
  assert.ok(finals.some((f) => f.text === CANCEL_TEXT), 'the opened stream is closed with the cancel copy');
});

// --- 11: non-stream channel ----------------------------------------------------

test('non-stream caps: ack and final go through reply(), no stream frames at all', async () => {
  const h = makeHarness({
    capabilities: { stream: false, push: true },
    steps: [{ emit: [{ type: 'tool', name: 't', brief: 'b' }], code: 'completed', finalText: '非流式答案', returnsSessionId: 's1' }],
  });
  await h.send('无流式');
  const frames = h.adapter.frames;
  assert.equal(frames.length, 2, 'exactly ack + final');
  assert.deepEqual(frames.map((f) => f.method), ['reply', 'reply']);
  assert.equal(frames[0].text, ACK_TEXT);
  assert.ok(frames[1].text.includes('非流式答案'));
  assert.equal(h.ledger.turns({ chatKey: K })[0].reason, 'completed');
  assert.equal(h.cache.get(K).cache.codex.sessionId, 's1');
});

// --- 12: drain refusals --------------------------------------------------------

test('drain: in-flight turn gets the maintenance final, pending refusal answered by sendDrainRefusals', async () => {
  const h = makeHarness({ steps: [{ hangMs: 60_000, hangCode: 'aborted', finalText: '' }] });
  h.engine.onMessage(h.bot, mkMsg('m1'));
  await tick();
  h.engine.onMessage(h.bot, mkMsg('m2')); // preempt m1 → m2 pending
  const drainP = h.engine.drain(2000);
  assert.equal(await drainP, true);

  const final = h.adapter.frames.filter((f) => f.finish).pop();
  assert.equal(final.text, DRAIN_INFLIGHT_TEXT, 'in-flight turn is closed with the maintenance copy');
  assert.equal(h.ledger.turns({ chatKey: K })[0].reason, 'interrupted');

  await h.engine.sendDrainRefusals();
  const replies = h.adapter.frames.filter((f) => f.method === 'reply');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, DRAIN_REFUSAL_TEXT);
  assert.ok(replies[0].reqId.startsWith('req-'), 'refusal answered on its own reqId');
  assert.equal(h.engine.drainRefusals.length, 0, 'refusals consumed');
});

// --- 13: outbound masking is on by default --------------------------------------

test('null middleware still masks secrets on every outbound frame (builtin default)', async () => {
  const h = makeHarness({
    // 同 happy path：思维链上屏脱敏是旧「详细汇报」行为面，显式 cot。
    bot: mkBot({ providerConfig: { progressStyle: 'cot' } }),
    middleware: null,
    steps: [{ emit: [{ type: 'thinking', text: '用 sk-abcdefghijklmnop1234 调用。' }], code: 'completed', finalText: '结果 sk-abcdefghijklmnop1234 泄漏', returnsSessionId: 's1' }],
  });
  await h.send('带密钥');
  for (const f of h.adapter.frames) {
    assert.ok(!String(f.text).includes('sk-abcdefghijklmnop1234'), `frame leaks the secret: ${f.text}`);
  }
  const final = h.adapter.frames.filter((f) => f.finish).pop();
  assert.ok(final.text.includes('***'), `final masked: ${final.text}`);
  const progress = h.adapter.frames.find((f) => f.method === 'progress' && !f.finish);
  assert.ok(progress && progress.text.includes('***'), `thinking line masked: ${progress?.text}`);
});

// --- wiring sanity ---------------------------------------------------------------

test('defaultRunTurn is the engine default and stays injectable; bare engine skips cleanly', async () => {
  assert.equal(typeof defaultRunTurn, 'function');
  const log = fakeLog();
  const engine = new Engine({ log });
  engine.attachBot(mkBot(), {});
  engine.onMessage(mkBot(), mkMsg('裸引擎'));
  await tick(); await tick();
  assert.equal(engine.inFlight.size, 0);
  assert.ok(log.lines.warn.some((l) => String(l).includes('wiring')), 'missing deps are a loud skip, not a crash');
});

test('long final is truncated with the 会话页 marker', async () => {
  const h = makeHarness({
    steps: [{ code: 'completed', finalText: 'x'.repeat(300), returnsSessionId: 's1' }],
  });
  await h.send('长回答');
  const final = h.adapter.frames.filter((f) => f.finish).pop();
  assert.ok(final.text.length <= 100 + '…（完整内容见会话页）'.length, `final capped (${final.text.length})`);
  assert.ok(final.text.includes('…（完整内容见会话页）'));
  // the ledger keeps the FULL text — truncation is presentation-only
  assert.equal(h.ledger.turns({ chatKey: K })[0].assistant.length, 300);
});

// --- 14: polite broadcast (拟人播报, 2026-11-06 default) --------------------------
//
// Owner decision 2026-11-06: the WeCom progress line no longer carries ANY
// CoT/tool/answer-preview content unless progressStyle:'cot' says so. Default
// bots broadcast one templated sentence whose elapsed time + breathing dots
// move every frame; the local timeline keeps the full raw events.

test('polite default: no progressStyle → broadcast only — no 💭/🔧/✍️ content on the wire, bot name + elapsed present, timeline keeps raw events', async () => {
  const h = makeHarness({
    bot: mkBot({ name: 'Sky 分身' }),
    steps: [{
      emit: [
        { type: 'step', n: 1, phase: 'start' },
        { type: 'thinking', text: '好的，我先把目录结构看一遍，这是思考内容。' },
        { type: 'tool', name: 'Bash', brief: 'ls -la /secret/path' },
        { type: 'text', text: '中途正文开始生成' },
      ],
      code: 'completed', finalText: '最终答案全文', returnsSessionId: 's1',
    }],
  });
  await h.send('新问题');

  const frames = h.adapter.frames;
  const progress = frames.filter((f) => f.method === 'progress' && !f.finish);
  assert.ok(progress.length >= 1, 'at least one broadcast frame');
  for (const f of progress) {
    assert.ok(!f.text.includes('💭') && !f.text.includes('🔧') && !f.text.includes('✍️'),
      `no CoT/tool/preview line on the wire: ${f.text}`);
    assert.ok(!f.text.includes('第 1 步'), `no step line either: ${f.text}`);
    assert.ok(!f.text.includes('目录结构') && !f.text.includes('ls -la') && !f.text.includes('中途正文'),
      `no thinking/tool/answer content leaks: ${f.text}`);
  }
  assert.ok(progress.some((f) => /^Sky 分身 思考中\.+ 请稍等（已 \d+ 秒）$/.test(f.text)),
    `default broadcast copy (bot name + elapsed): ${JSON.stringify(progress.map((f) => f.text))}`);
  const final = frames[frames.length - 1];
  assert.equal(final.finish, true);
  assert.ok(final.text.includes('最终答案全文'), 'final frame unchanged');

  // the local work log (timeline) still receives the FULL raw events
  const rows = h.timeline.get({ botId: h.bot.id });
  assert.ok(rows.some((r) => r.kind === 'thinking' && r.text.includes('目录结构')),
    'timeline keeps raw thinking');
  assert.ok(rows.some((r) => r.kind === 'tool' && r.text.includes('ls -la')),
    'timeline keeps raw tool brief');
});

test('polite: custom progressText template takes effect ({step} filled from step events)', async () => {
  const h = makeHarness({
    bot: mkBot({
      name: '小助手',
      providerConfig: { progressText: '{bot} 在第{step}步思考{dots}（已 {elapsed}）' },
    }),
    steps: [{
      emit: [
        { type: 'step', n: 2, phase: 'start' },
        { type: 'thinking', text: '思考内容。' },
      ],
      code: 'completed', finalText: '答案', returnsSessionId: 's1',
    }],
  });
  await h.send('问题');
  const texts = h.adapter.frames.filter((f) => f.method === 'progress' && !f.finish).map((f) => f.text);
  assert.ok(texts.length >= 2, `two broadcast frames (${JSON.stringify(texts)})`);
  assert.match(texts[0], /^小助手 在第2步思考\.（已 \d+ 秒）$/, `step placeholder filled: ${texts[0]}`);
  assert.match(texts[1], /^小助手 在第2步思考\.\.（已 \d+ 秒）$/, `dots advance: ${texts[1]}`);
});

test('polite: heartbeat frames use the broadcast template (no 已运行), dots breathe beat to beat', async () => {
  const h = makeHarness({
    bot: mkBot({ name: 'Sky 分身' }),
    limits: { minIntervalMs: 0, heartbeatMs: 25 },
    steps: [{ delayMs: 120, code: 'completed', finalText: '慢任务答案', returnsSessionId: 's1' }],
  });
  await h.send('慢任务');
  const beats = h.adapter.frames.filter((f) => f.method === 'progress' && !f.finish).map((f) => f.text);
  const hearts = beats.filter((t) => /^Sky 分身 思考中\.+ 请稍等（已 \d+ 秒）$/.test(t));
  assert.ok(hearts.length >= 2, `heartbeat frames carry the broadcast copy (${JSON.stringify(beats)})`);
  assert.ok(!beats.some((t) => t.includes('已运行')), 'the ⏳ 已运行 heartbeat copy is gone in polite mode');
  const dotSeq = hearts.map((t) => t.match(/思考中(\.+)/)[1]);
  for (let i = 1; i < dotSeq.length; i++) {
    assert.notEqual(dotSeq[i], dotSeq[i - 1], `consecutive beats differ: ${dotSeq}`);
  }
});

test('polite flip pin: legacy progressCoT:true without progressStyle → polite (2026-11-06 default inversion)', async () => {
  const h = makeHarness({
    bot: mkBot({ providerConfig: { progressCoT: true } }),
    steps: [{
      emit: [{ type: 'thinking', text: '思考句。' }, { type: 'tool', name: 't', brief: 'b' }],
      code: 'completed', finalText: '答', returnsSessionId: 's1',
    }],
  });
  await h.send('问题');
  const texts = h.adapter.frames.filter((f) => f.method === 'progress' && !f.finish).map((f) => f.text);
  assert.ok(texts.length >= 1, 'broadcast frames exist');
  assert.ok(!texts.some((t) => t.includes('💭') || t.includes('🔧')),
    `legacy progressCoT:true no longer forces CoT onto the wire: ${JSON.stringify(texts)}`);
  assert.ok(texts.some((t) => t.includes('思考中')), 'the broadcast copy shows instead');
});

test('progressStyle explicit: "polite" → broadcast; "cot" → legacy 💭/🔧 mix', async () => {
  const steps = [{
    emit: [{ type: 'thinking', text: '思考句。' }, { type: 'tool', name: 't', brief: 'b' }],
    code: 'completed', finalText: '答', returnsSessionId: 's1',
  }];
  const polite = makeHarness({ bot: mkBot({ providerConfig: { progressStyle: 'polite' } }), steps });
  await polite.send('问题');
  const politeTexts = polite.adapter.frames.filter((f) => f.method === 'progress' && !f.finish).map((f) => f.text);
  assert.ok(politeTexts.some((t) => t.includes('思考中')), 'explicit polite broadcasts');
  assert.ok(!politeTexts.some((t) => t.includes('💭') || t.includes('🔧')), 'explicit polite leaks nothing');

  const cot = makeHarness({ bot: mkBot({ providerConfig: { progressStyle: 'cot' } }), steps });
  await cot.send('问题');
  const cotTexts = cot.adapter.frames.filter((f) => f.method === 'progress' && !f.finish).map((f) => f.text);
  assert.ok(cotTexts.some((t) => t.includes('💭')), 'cot keeps the thinking line');
  assert.ok(cotTexts.some((t) => t.includes('🔧')), 'cot keeps the tool line');
});

// --- P2 observability: run start/done log lines, usage timeline row, SSE payload ---

test('run start/done log lines: greppable one-liners with session, outcome and tokens', async () => {
  const h = makeHarness({
    steps: [{
      emit: [
        { type: 'text', text: '正文', usage: { inputTokens: 10, outputTokens: 5 } },
      ],
      code: 'completed', finalText: '答', returnsSessionId: 's1',
    }],
  });
  await h.send('新问题');
  assert.ok(
    h.log.lines.info.some((l) => /^run start wecom:group:g1 bot=bot1 session=\(new\)$/.test(l)),
    `run start line exact (fresh session): ${JSON.stringify(h.log.lines.info)}`,
  );
  assert.ok(
    h.log.lines.info.some((l) => /^run done wecom:group:g1 bot=bot1 ok=true reason=completed tokens=15 dur=\d+ms$/.test(l)),
    `run done line exact (tokens 10+5, ms duration): ${JSON.stringify(h.log.lines.info)}`,
  );
  // error outcome keeps the same shape with ok=false and the mapped reason
  const bad = makeHarness({ steps: [{ code: 'error', finalText: '', detail: 'x' }] });
  await bad.send('会失败的问题');
  assert.ok(
    bad.log.lines.info.some((l) => /^run done wecom:group:g1 bot=bot1 ok=false reason=error tokens=0 dur=\d+ms$/.test(l)),
    `run done for error outcome: ${JSON.stringify(bad.log.lines.info)}`,
  );
  // resumed session logs the session id, not (new)
  const resumed = makeHarness({ steps: [COMPLETE()] });
  seedRow(resumed.ledger);
  resumed.cache.upsert(K, 'codex', { sessionId: 's-old', bornCwd: CWD }, 1);
  resumed.cache.setCurrent(K, 'codex');
  await resumed.send('续问');
  assert.ok(
    resumed.log.lines.info.some((l) => l === 'run start wecom:group:g1 bot=bot1 session=s-old'),
    `native resume names the session: ${JSON.stringify(resumed.log.lines.info)}`,
  );
});

test('run start/done pairing: a skipped turn logs neither; a mid-run abort logs both', async () => {
  // (a) abort lands synchronously, before the chain ever runs the impl: the
  // turn is skipped wholesale (no runner, no bookkeep) — no lines at all.
  const skipped = makeHarness({ steps: [{ hangMs: 50, hangCode: 'aborted' }] });
  skipped.engine.onMessage(skipped.bot, mkMsg('被替换'));
  skipped.engine.inFlight.get(K).abort(); // abort-before-run path
  await skipped.engine.chains.get(K);
  await tick();
  assert.ok(!skipped.log.lines.info.some((l) => l.startsWith('run start') || l.startsWith('run done')),
    `a replaced-before-start turn claims no lines: ${JSON.stringify(skipped.log.lines.info)}`);
  // (b) abort lands AFTER the runner spawned: start was claimed, and the
  // interrupted outcome still books its done line (bookkeep runs every path).
  const h = makeHarness({ steps: [{ hangMs: 200, hangCode: 'aborted' }] });
  h.engine.onMessage(h.bot, mkMsg('被打断'));
  await tick(); // chain started: runner spawned and hanging
  h.engine.inFlight.get(K).abort();
  await h.engine.chains.get(K);
  await tick();
  assert.ok(
    h.log.lines.info.some((l) => l === 'run start wecom:group:g1 bot=bot1 session=(new)'),
    `mid-run turn claimed its start: ${JSON.stringify(h.log.lines.info)}`,
  );
  assert.ok(
    h.log.lines.info.some((l) => /^run done wecom:group:g1 bot=bot1 ok=false reason=interrupted tokens=0 dur=\d+ms$/.test(l)),
    `the interrupted turn still books a done line: ${JSON.stringify(h.log.lines.info)}`,
  );
});

test('usage timeline row: one 📊 summary per run end, beside the turn row', async () => {
  const h = makeHarness({
    steps: [{
      emit: [{ type: 'text', text: 'x', usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 5 } }],
      code: 'completed', finalText: '答', returnsSessionId: 's1',
    }],
  });
  await h.send('问题');
  const rows = h.timeline.get();
  const usageRows = rows.filter((r) => r.kind === 'usage');
  assert.equal(usageRows.length, 1, 'exactly one usage row');
  assert.equal(usageRows[0].botId, 'bot1');
  assert.equal(usageRows[0].chatKey, K);
  assert.equal(usageRows[0].text, '📊 输入 7 · 缓存读 5 · 输出 3');
  // the closing turn row (bookkeep's), not the in-run text-event row that
  // also maps to kind 'turn' (EV_TO_KIND) — usage lands right after it.
  const turnIdx = rows.map((r) => r.kind).lastIndexOf('turn');
  const usageIdx = rows.findIndex((r) => r.kind === 'usage');
  assert.ok(turnIdx >= 0 && usageIdx === turnIdx + 1, 'usage lands right after the closing turn row');
});

test('run/start & run/end SSE frames carry usage + durationMs', async () => {
  const events = [];
  const h = makeHarness({
    emit: (topic, payload) => events.push({ topic, payload }),
    steps: [{
      emit: [{ type: 'text', text: 'x', usage: { inputTokens: 4, outputTokens: 2 } }],
      code: 'completed', finalText: '答', returnsSessionId: 's1',
    }],
  });
  await h.send('问题');
  const start = events.find((e) => e.topic === 'run/start');
  const end = events.find((e) => e.topic === 'run/end');
  assert.ok(start, 'run/start emitted');
  assert.deepEqual(start.payload, { botId: 'bot1', chatKey: K, usage: null, durationMs: 0 });
  assert.ok(end, 'run/end emitted');
  assert.equal(end.payload.botId, 'bot1');
  assert.equal(end.payload.chatKey, K);
  assert.equal(end.payload.durationMs, h.engine.lastRunOf('bot1').durationMs);
  assert.deepEqual(end.payload.usage, { inputTokens: 4, outputTokens: 2, cacheReadTokens: 0, totalTokens: 6 });
});

test('lastRunOf: null before any run, durationMs + usage after', async () => {
  const h = makeHarness({ steps: [COMPLETE()] });
  assert.equal(h.engine.lastRunOf('bot1'), null, 'never ran → null (roster answers lastDurationMs=null)');
  await h.send('问题');
  const last = h.engine.lastRunOf('bot1');
  assert.equal(typeof last.durationMs, 'number');
  assert.equal(typeof last.at, 'number');
  assert.equal(last.usage.totalTokens, 0, 'fake runner reports no usage → honest 0');
  // The returned record is a copy: mutating it must not corrupt engine state.
  last.durationMs = -1;
  assert.notEqual(h.engine.lastRunOf('bot1').durationMs, -1);
});

// --- 13: bounded outbound (R2 hardening) ————————————————————————————————————

// Channel adapter double whose every method parks forever: the worst shape a
// buggy adapter can produce (a promise that neither resolves nor rejects).
const hungAdapter = (capabilities = { stream: true, push: true }) => {
  const calls = [];
  const never = (method) => (...args) => {
    calls.push(method);
    return new Promise(() => {});
  };
  return { frames: [], calls, capabilities, ack: never('ack'), progress: never('progress'), reply: never('reply'), push: never('push') };
};

test('outbound timeout: never-settling adapter ack/final cannot wedge the chatKey chain; the turn still books', async () => {
  const adap = hungAdapter();
  const h = makeHarness({ steps: [COMPLETE()], adapter: adap, limits: { outboundTimeoutMs: 60 } });
  await Promise.race([
    h.send('慢消息'),
    sleep(1500).then(() => { throw new Error('chain never settled: an unbounded adapter await wedged the chatKey'); }),
  ]);
  assert.ok(adap.calls.includes('ack') && adap.calls.includes('progress'), 'the hung calls were actually made');
  assert.equal(h.ledger.turns({ chatKey: K }).length, 1, 'bookkeep ran for the completed run despite hung outbound');
  const warns = h.log.lines.warn.join('\n');
  assert.match(warns, /ack send failed: outbound timeout/);
  assert.match(warns, /progress send failed: outbound timeout/);
});

test('sendDrainRefusals: a hung adapter reply is bounded by the same outbound deadline', async () => {
  const adap = hungAdapter({ stream: false });
  const h = makeHarness({ adapter: adap, limits: { outboundTimeoutMs: 60 } });
  const drained = h.engine.drain(0); // latches `draining` synchronously
  h.engine.onMessage(h.bot, mkMsg('维护期消息')); // refused → parked in drainRefusals
  await drained;
  await Promise.race([
    h.engine.sendDrainRefusals(),
    sleep(1500).then(() => { throw new Error('sendDrainRefusals wedged on a hung adapter reply'); }),
  ]);
  assert.match(h.log.lines.error.join('\n'), /drain refusal reply failed: outbound timeout/);
});

// —— 会话 TTL 退役（DESIGN-TOKEN-OPT §4.4）————————————————————————————
import { isSessionStale, sessionTtlMinutes, SESSION_TTL_MIN_DEFAULT, toolLoopMaxCalls, TOOL_LOOP_MAX_CALLS_DEFAULT } from '../../plugins/core-engine/engine.js';

test('isSessionStale: pure TTL decision boundaries', () => {
  const now = Date.now();
  assert.equal(SESSION_TTL_MIN_DEFAULT, 45);
  // ttl<=0 disables retirement entirely
  assert.equal(isSessionStale({ lastAt: now - 10 * 60_000 }, now, 0), false);
  assert.equal(isSessionStale({ lastAt: now - 10 * 60_000 }, now, -1), false);
  // null pe / non-object → false
  assert.equal(isSessionStale(null, now, 45), false);
  // legacy entries without lastAt (TTL 特性上线前落盘) 判陈旧——2026-11-10
  // PC1 真机：11-09 旧 session 无 lastAt → 永不退役 → resume 撞「No
  // conversation found」永久坏会话。ttl<=0 显式关闭时仍照旧 resume。
  assert.equal(isSessionStale({}, now, 45), true);
  assert.equal(isSessionStale({ lastAt: 'yesterday' }, now, 45), true);
  assert.equal(isSessionStale({}, now, 0), false, 'ttl<=0 时一切照旧');
  // boundary: exactly TTL minutes elapsed is NOT stale (strict >)
  assert.equal(isSessionStale({ lastAt: now - 45 * 60_000 }, now, 45), false);
  assert.equal(isSessionStale({ lastAt: now - 45 * 60_001 }, now, 45), true);
  assert.equal(isSessionStale({ lastAt: now - 46 * 60_000 }, now, 45), true);
});

test('sessionTtlMinutes: defensive providerConfig parsing (unknown keys pass validation)', () => {
  assert.equal(sessionTtlMinutes({ providerConfig: {} }), SESSION_TTL_MIN_DEFAULT);
  assert.equal(sessionTtlMinutes({}), SESSION_TTL_MIN_DEFAULT);
  assert.equal(sessionTtlMinutes({ providerConfig: { sessionTtlMin: 10 } }), 10);
  assert.equal(sessionTtlMinutes({ providerConfig: { sessionTtlMin: 0 } }), 0);
  // junk shapes fall back to default, never crash, never negative
  assert.equal(sessionTtlMinutes({ providerConfig: { sessionTtlMin: -5 } }), SESSION_TTL_MIN_DEFAULT);
  assert.equal(sessionTtlMinutes({ providerConfig: { sessionTtlMin: '45' } }), SESSION_TTL_MIN_DEFAULT);
  assert.equal(sessionTtlMinutes({ providerConfig: { sessionTtlMin: NaN } }), SESSION_TTL_MIN_DEFAULT);
});

test('toolLoopMaxCalls: defensive parsing — default 60, 0 disables, junk floors to default', () => {
  assert.equal(TOOL_LOOP_MAX_CALLS_DEFAULT, 60);
  assert.equal(toolLoopMaxCalls({ providerConfig: {} }), 60);
  assert.equal(toolLoopMaxCalls({}), 60);
  assert.equal(toolLoopMaxCalls({ providerConfig: { toolLoopMaxCalls: 3 } }), 3);
  assert.equal(toolLoopMaxCalls({ providerConfig: { toolLoopMaxCalls: 0 } }), 0, '0 = 关闭熔断');
  assert.equal(toolLoopMaxCalls({ providerConfig: { toolLoopMaxCalls: 5.9 } }), 5, '取整');
  assert.equal(toolLoopMaxCalls({ providerConfig: { toolLoopMaxCalls: -1 } }), 60);
  assert.equal(toolLoopMaxCalls({ providerConfig: { toolLoopMaxCalls: '60' } }), 60);
  assert.equal(toolLoopMaxCalls({ providerConfig: { toolLoopMaxCalls: NaN } }), 60);
});

// token 利用率治理①：usage 细分（输入/缓存读/输出）durable 落台账，不再只靠
// 环形 timeline。旧行无此字段——这里钉新行必带完整细分。
test('ledger row carries usage breakdown (input/cacheRead/output/total), not just total', async () => {
  const h = makeHarness({
    steps: [{
      emit: [{ type: 'text', text: 'x', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, totalTokens: 120 } }],
      code: 'completed', finalText: '答', returnsSessionId: 's1',
    }],
  });
  await h.send('问题');
  const row = h.ledger.turns({ chatKey: K })[0];
  assert.equal(row.tokens, 120, 'total still present (backward compat)');
  assert.deepEqual(row.usage, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, totalTokens: 120 });
});

// token 利用率治理②：工具循环熔断——单轮工具调用超 toolLoopMaxCalls 即 abort，
// 终帧给专用文案、台账标 stopCause=tool-loop（reason=interrupted），防考古空转。
test('tool-loop circuit breaker: trips over cap → aborted, TOOL_LOOP copy, stopCause=tool-loop', async () => {
  const h = makeHarness({
    bot: mkBot({ providerConfig: { toolLoopMaxCalls: 3 } }),
    steps: [{
      // 5 个 tool 事件：第 4 个触发熔断 ac.abort()；hang 腿监听 signal，见已
      // aborted 立即结算 aborted。hangMs=60000 远大于 harness 硬超时(5000)——
      // 若回归成「只置 tripped 不 abort」，硬定时器必先到期→reason=timeout→
      // 下方 interrupted 断言失败。证明链不靠定时器巧合（盲评 P2-4）。
      emit: Array.from({ length: 5 }, (_, i) => ({ type: 'tool', brief: `t${i}` })),
      hangMs: 60000, hangCode: 'aborted',
    }],
  });
  await h.send('查个复杂问题');
  const finals = h.adapter.frames.filter((f) => f.finish);
  assert.equal(finals.length, 1);
  assert.ok(finals[0].text.includes('工具调用过多'), `breaker copy delivered: ${finals[0].text}`);
  const row = h.ledger.turns({ chatKey: K })[0];
  assert.equal(row.reason, 'interrupted');
  assert.equal(row.stopCause, 'tool-loop');
  assert.ok(h.log.lines.warn.some((m) => /circuit breaker tripped/.test(m)), 'trip is logged');
});

test('tool-loop breaker disabled (toolLoopMaxCalls=0): many tool calls still complete', async () => {
  const h = makeHarness({
    bot: mkBot({ providerConfig: { toolLoopMaxCalls: 0 } }),
    steps: [{
      emit: Array.from({ length: 8 }, (_, i) => ({ type: 'tool', brief: `t${i}` })),
      code: 'completed', finalText: '完成', returnsSessionId: 's1',
    }],
  });
  await h.send('正常重工具轮');
  const row = h.ledger.turns({ chatKey: K })[0];
  assert.equal(row.reason, 'completed', '0 = 不熔断');
  assert.equal(row.stopCause, undefined);
});

test('tool-loop breaker: under cap completes normally, no stopCause', async () => {
  const h = makeHarness({
    bot: mkBot({ providerConfig: { toolLoopMaxCalls: 10 } }),
    steps: [{
      emit: Array.from({ length: 3 }, (_, i) => ({ type: 'tool', brief: `t${i}` })),
      code: 'completed', finalText: '完成', returnsSessionId: 's1',
    }],
  });
  await h.send('轻度工具轮');
  const row = h.ledger.turns({ chatKey: K })[0];
  assert.equal(row.reason, 'completed');
  assert.equal(row.stopCause, undefined);
});

// —— 2026-11-10 PC1 真机 P0 回归：run-settle 看门狗 + adapter 换代终帧 ——————————
// 真机：abort（熔断/drain）后 runner promise 挂死 → bookkeep 永不跑、inFlight
// 永远 working、只能重启服务；且 drain 换 adapter 后终帧发向死连接全丢。
test('settle-watchdog: hard-timeout aborts a never-settling runner → forced settle, timeout row lands, chain unwedged', async () => {
  const h = makeHarness({
    steps: [{ never: true }], // runner 永不结算（真机挂死形状）
    limits: { hardTimeoutMs: 80, runnerSettleGuardMs: 60 },
  });
  await h.send('问题');
  const row = h.ledger.turns({ chatKey: K })[0];
  assert.equal(row.reason, 'timeout', 'hardTimedOut reclassifies the watchdog synth (aborted) to timeout');
  assert.ok(h.log.lines.warn.some((m) => /settle-watchdog fired/.test(m)), 'watchdog trip is logged');
});

test('settle-watchdog: breaker abort + hung runner → interrupted row with stopCause=tool-loop (never wedged)', async () => {
  const h = makeHarness({
    bot: mkBot({ providerConfig: { toolLoopMaxCalls: 2 } }),
    // 3 个 tool 事件触发熔断 abort；runner 却永不结算——看门狗强制结算。
    steps: [{ emit: [{ type: 'tool', brief: 'a' }, { type: 'tool', brief: 'b' }, { type: 'tool', brief: 'c' }], never: true }],
    limits: { hardTimeoutMs: 60_000, runnerSettleGuardMs: 60 },
  });
  await h.send('考古');
  const row = h.ledger.turns({ chatKey: K })[0];
  assert.equal(row.reason, 'interrupted');
  assert.equal(row.stopCause, 'tool-loop', 'the breaker cause survives the watchdog settle');
});

test('adapter swapped mid-run (drain shape): final delivered via the CURRENT adapter push, not lost to the dead one', async () => {
  const adapterB = fakeAdapter();
  // 换代时机=终帧投递前（真实 drain 形状）：turn 用 A 起跑，onOutbound（终帧
  // 前最后一跳）里把 engine.getAdapter 换成 B——deliverFinal 必须改走 B 的 push。
  let h;
  h = makeHarness({
    steps: [COMPLETE({ finalText: '最终答案全文' })],
    middleware: {
      maskOutbound: (t) => t,
      onOutbound: async (t) => { h.engine.getAdapter = () => adapterB; return t; },
    },
  });
  await h.send('问题');
  const pushes = adapterB.frames.filter((f) => f.method === 'push');
  assert.ok(pushes.some((f) => String(f.text || '').includes('最终答案全文')),
    `final reached the CURRENT adapter via push: ${JSON.stringify(adapterB.frames)}`);
  assert.ok(!h.adapter.frames.some((f) => f.finish === true), 'the stale adapter receives no final');
  assert.ok(h.log.lines.warn.some((m) => /adapter swapped mid-run/.test(m)), 'the swap fallback is logged');
});

test('SessionCache: upsert stamps lastAt; expire removes the entry and clears current', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-ttl-'));
  const log = fakeLog();
  const ledger = new Ledger({ file: join(dir, 'l.jsonl'), log });
  const cache = new SessionCache({ file: join(dir, 's.json'), log, ledger });
  const before = Date.now();
  cache.upsert(K, 'codex', { sessionId: 's1', bornCwd: CWD }, 0);
  const got = cache.get(K).cache.codex;
  assert.equal(got.sessionId, 's1');
  assert.ok(typeof got.lastAt === 'number' && got.lastAt >= before && got.lastAt <= Date.now(), 'lastAt stamped at upsert');
  assert.equal(cache.get(K).current, 'codex');
  // expire: current provider → cleared alongside
  assert.equal(cache.expire(K, 'codex'), true);
  assert.equal(cache.get(K).cache.codex, undefined);
  assert.equal(cache.get(K).current, null);
  assert.equal(cache.get(K).dirty, false);
  // idempotent: nothing left to delete
  assert.equal(cache.expire(K, 'codex'), false);
  // persistence round-trip keeps the removal
  const cache2 = new SessionCache({ file: join(dir, 's.json'), log, ledger });
  assert.equal(cache2.get(K).cache.codex, undefined);
});

test('turn flow: TTL-expired session retires to a FRESH session with NO handoff prefix', async () => {
  const h = makeHarness({ steps: [COMPLETE(), COMPLETE({ returnsSessionId: 's2' })] });
  await h.send('第一条');
  assert.equal(h.runner.calls[0].sessionId, null);
  assert.equal(h.cache.get(K).cache.codex.sessionId, 's1');
  // backdate the entry beyond TTL (default 45min)
  h.cache._data[K].cache.codex.lastAt = Date.now() - 46 * 60_000;
  await h.send('第二条');
  const second = h.runner.calls[1];
  assert.equal(second.sessionId, null, 'expired session is NOT resumed');
  assert.equal(second.prompt, '第二条', 'no handoff prefix — durable context belongs to the memory layer');
  // the fresh session is cached and clean
  assert.equal(h.cache.get(K).cache.codex.sessionId, 's2');
  assert.equal(h.cache.get(K).cache.codex.dirty, false);
  // ledger still journals both turns
  assert.equal(h.ledger.turns({ chatKey: K }).length, 2);
  assert.match(h.log.lines.info.join('\n'), /session expired by TTL/, 'the retirement is logged');
});

test('turn flow: sessionTtlMin=0 disables retirement; legacy entries without lastAt resume', async () => {
  const bot0 = mkBot({ providerConfig: { sessionTtlMin: 0 } });
  const h0 = makeHarness({ bot: bot0, steps: [COMPLETE(), COMPLETE()] });
  await h0.send('a');
  h0.cache._data[K].cache.codex.lastAt = Date.now() - 100 * 24 * 60_000; // months old, TTL off
  await h0.send('b');
  assert.equal(h0.runner.calls[1].sessionId, 's1', 'ttl=0 → always resume');

  const h1 = makeHarness({ steps: [COMPLETE(), COMPLETE()] });
  await h1.send('a');
  delete h1.cache._data[K].cache.codex.lastAt; // legacy persisted entry
  await h1.send('b');
  // 2026-11-10 PC1 真机反转：legacy 无 lastAt 的条目现在判陈旧 → fresh 会话
  // （原行为「照旧 resume」会撞上 CLI 磁盘已不存在的 session，永久坏会话）。
  assert.equal(h1.runner.calls[1].sessionId, null, 'legacy no-lastAt entry retires to a fresh session');
});

test('turn flow: within TTL the session resumes natively (the resume we WANT to pay for)', async () => {
  const h = makeHarness({ steps: [COMPLETE(), COMPLETE()] });
  await h.send('a');
  h.cache._data[K].cache.codex.lastAt = Date.now() - 10 * 60_000; // well within 45min
  await h.send('b');
  assert.equal(h.runner.calls[1].sessionId, 's1', 'native resume inside the window');
  assert.equal(h.runner.calls[1].prompt, 'b');
});


// —— 盲评修复回归 ———————————————————————————————————————————————————————
test('P1-1: native resume REFRESHES lastAt — TTL measures recency, not session age', async () => {
  const h = makeHarness({ steps: [COMPLETE(), COMPLETE()] });
  await h.send('第一条');
  // 44 分钟前：窗口内 → 第二轮原生续会话；续会话不 upsert，必须 touch
  h.cache._data[K].cache.codex.lastAt = Date.now() - 44 * 60_000;
  await h.send('第二条');
  assert.equal(h.runner.calls[1].sessionId, 's1', 'within TTL → native resume');
  const refreshed = h.cache.get(K).cache.codex.lastAt;
  assert.ok(Date.now() - refreshed < 5000, `lastAt refreshed on resume (recency), got age ${Date.now() - refreshed}ms`);
  // 刷新后：再过 3 分钟也绝不该退役（活跃对话不被会话年龄误杀）
  h.cache._data[K].cache.codex.lastAt = Date.now() - 44 * 60_000 - 1000; // 建会话后 45min 的老会话，但每轮都在 touch
  await h.send('第三条');
  assert.equal(h.runner.calls[2].sessionId, 's1', 'a chat ACTIVE every turn keeps resuming regardless of session age');
});

test('P1-2: middleware sees the FULL text; the channel frame gets the truncated version', async () => {
  const seenByMiddleware = [];
  const mw = {
    maskOutbound: (t) => t,
    onOutbound: async (text) => { seenByMiddleware.push(text.length); return text; },
  };
  // harness limit maxContentChars=100 — a 300-char base must be truncated for
  // the channel but delivered WHOLE to the onOutbound chain (distill markers
  // live at the tail; truncating first would silently eat them).
  const long = [COMPLETE({ finalText: '长'.repeat(300) })];
  const rec = fakeAdapter({});
  const h = makeHarness({ steps: long, middleware: mw, adapter: rec });
  await h.send('长回复');
  assert.equal(seenByMiddleware.length, 1);
  assert.equal(seenByMiddleware[0], 300, 'onOutbound received the untruncated text');
  const finalFrame = rec.frames.filter((f) => f.method === 'progress' && f.finish).pop() || rec.frames[rec.frames.length - 1];
  assert.ok(String(finalFrame?.text ?? '').length < 300 + 30, `the channel frame IS truncated (${String(finalFrame?.text ?? '').length})`);
});

test('P1-2 regression: middleware TAIL appendage (cost-tracker 📊) survives the final truncation', async () => {
  // 保尾截断：长回复经中间件追加尾注后，通道帧既要截断主体、也要让尾部追加物
  // 活着（纯掐头会把 📊 行一起截掉——盲评 P1-2 回归）。
  const FOOTER = '\n\n---\n📊 Token：输入 1 · 输出 2';
  const mw = {
    maskOutbound: (t) => t,
    onOutbound: async (text) => text + FOOTER,
  };
  const rec = fakeAdapter({});
  const h = makeHarness({
    steps: [COMPLETE({ finalText: '内'.repeat(300) })],
    middleware: mw, adapter: rec,
  });
  await h.send('长回复');
  const finalFrame = rec.frames.filter((f) => f.method === 'progress' && f.finish).pop() || rec.frames[rec.frames.length - 1];
  const out = String(finalFrame?.text ?? '');
  assert.ok(out.includes('📊 Token：输入 1 · 输出 2'), `tail footer survived the cut: ...${out.slice(-80)}`);
  assert.ok(out.length < 300 + FOOTER.length + 40, `and the body IS still truncated (${out.length})`);
  assert.ok(out.includes('…'), 'the cut is visible to the reader');
});
