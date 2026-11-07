// Per-run usage accumulation + the onOutbound middleware context (cost-tracker
// feature, Part 1). Two layers pinned here:
//   - createUsageAccumulator: the three REAL provider usage dialects —
//     dsh status{phase:'step_end', usage:{inputTokens, outputTokens,
//     totalTokens, cacheReadTokens}} (probe-baselines/dsh.ndjson), claude
//     result {usage:{input_tokens, output_tokens, cache_read_input_tokens}}
//     and codex turn.completed {usage:{input_tokens, cached_input_tokens,
//     output_tokens}} (the codex runner already forwards a normalized copy on
//     result.reason.usage) — all normalize to one camelCase summary,
//   - defaultRunTurn: the FINAL reply (completed branch only) passes through
//     middleware.onOutbound(text, ctx) with {bot, usage, model, durationMs};
//     progress frames and aborted/timeout maintenance banners never do, and a
//     throwing middleware must never eat the reply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Engine, createUsageAccumulator } from '../../plugins/core-engine/engine.js';
import { Ledger } from '../../plugins/core-engine/ledger.js';
import { SessionCache } from '../../plugins/core-engine/sessionCache.js';
import { Timeline } from '../../plugins/core-engine/timeline.js';
import { createProgressor } from '../../plugins/core-engine/progressor.js';
import { maskOutbound } from '../../plugins/core-engine/middleware.js';

const K = 'wecom:group:g1';
const CWD = '/ws';

const MS_LIMITS = {
  concurrency: 4, minIntervalMs: 0, heartbeatMs: 10_000, maxContentChars: 100,
  streamDeadlineMs: 600_000, hardTimeoutMs: 5_000, warnLeadMs: 90_000,
  outboundBudgetPerMin: 28,
};
const tick = () => new Promise((r) => setImmediate(r));

function fakeLog() {
  const lines = { debug: [], info: [], warn: [], error: [] };
  return {
    lines,
    debug: (m) => lines.debug.push(m), info: (m) => lines.info.push(m),
    warn: (m) => lines.warn.push(m), error: (m) => lines.error.push(m),
  };
}

function fakeAdapter({ capabilities = { stream: true, push: true } } = {}) {
  const frames = [];
  return {
    frames, capabilities,
    ack: async (reqId, streamId, text) => { frames.push({ method: 'ack', reqId, streamId, text }); },
    progress: async (reqId, streamId, text, finish) => { frames.push({ method: 'progress', reqId, streamId, text, finish: !!finish }); },
    reply: async (reqId, text) => { frames.push({ method: 'reply', reqId, text }); },
    push: async (chatRef, text) => { frames.push({ method: 'push', chatRef, text }); },
  };
}

// Runner that replays scripted events then resolves one result (the §5 shape
// defaultRunTurn consumes; resultOverrides feed the codex reason.usage path).
function fakeRunner({ emit = [], resultOverrides = {} } = {}) {
  return {
    async run(args) {
      for (const ev of emit) args.onEvent?.(ev);
      return {
        ok: true, code: 'completed', finalText: '最终答案全文', aborted: false,
        sessionId: 's1', reason: null, detail: {},
        ...resultOverrides,
      };
    },
  };
}

function makeHarness({ bot, runner, middleware = { maskOutbound } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wao-usage-'));
  const log = fakeLog();
  const ledger = new Ledger({ file: join(dir, 'ledger.jsonl'), log });
  const cache = new SessionCache({ file: join(dir, 'sessions.json'), log, ledger });
  const adapter = fakeAdapter();
  const b = bot ?? {
    id: 'bot1', name: 'b', provider: 'codex', channel: 'wecom', providerConfig: { cwd: CWD },
  };
  const engine = new Engine({
    log,
    getRunner: () => runner,
    getAdapter: () => adapter,
    ledgerFactory: () => ({ ledger, cache }),
    timeline: new Timeline(),
    progressor: createProgressor(),
    middleware,
    limits: MS_LIMITS,
  });
  engine.attachBot(b, { adapter, runner });
  const send = async (text = '问题') => {
    engine.onMessage(b, {
      chatKey: K, chatKind: 'group', chatid: 'g1', userid: 'u1', text,
      reqId: `req-${randomUUID()}`,
    });
    await engine.chains.get(K);
    await tick();
  };
  return { engine, adapter, ledger, bot: b, send, log };
}

// --- 1: accumulator unit — the three provider dialects ————————————————————

test('accumulator: dsh shape (camelCase with totalTokens/cacheReadTokens) passes normalized', () => {
  const acc = createUsageAccumulator();
  acc.observe({ type: 'step', n: 1, usage: { inputTokens: 249, outputTokens: 59, totalTokens: 7092, cacheReadTokens: 6784 } });
  assert.deepEqual(acc.summary(), {
    inputTokens: 249, outputTokens: 59, cacheReadTokens: 6784, totalTokens: 7092,
  });
});

test('accumulator: claude shape (snake_case cache_read_input_tokens) normalizes', () => {
  const acc = createUsageAccumulator();
  acc.observe({ type: 'text', text: 'a', usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 60 } });
  assert.deepEqual(acc.summary(), {
    inputTokens: 100, outputTokens: 40, cacheReadTokens: 60, totalTokens: 140,
  });
});

test('accumulator: codex shape (cached_input_tokens) normalizes', () => {
  const acc = createUsageAccumulator();
  acc.observe({ type: 'tool', name: 'x', brief: 'b', usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 20 } });
  assert.deepEqual(acc.summary(), {
    inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, totalTokens: 30,
  });
});

test('accumulator: counts are running totals — a re-reporting provider keeps the MAX, never a sum', () => {
  const acc = createUsageAccumulator();
  // dsh step_end re-reports the turn-so-far (probe baseline: 7020 → 7092)
  acc.observe({ type: 'step', n: 1, usage: { inputTokens: 235, outputTokens: 1, totalTokens: 7020, cacheReadTokens: 6784 } });
  acc.observe({ type: 'step', n: 2, usage: { inputTokens: 249, outputTokens: 59, totalTokens: 7092, cacheReadTokens: 6784 } });
  assert.deepEqual(acc.summary(), {
    inputTokens: 249, outputTokens: 59, cacheReadTokens: 6784, totalTokens: 7092,
  });
});

test('accumulator: junk usage is ignored; summary starts at zeros and is a fresh object', () => {
  const acc = createUsageAccumulator();
  assert.deepEqual(acc.summary(), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0 });
  acc.observe(null);
  acc.observe({ type: 'text' }); // no usage at all
  acc.observe({ type: 'text', usage: null });
  acc.observe({ type: 'text', usage: 'lots' });
  acc.observe({ type: 'text', usage: { inputTokens: 'NaN-ish', outputTokens: -5 } });
  assert.deepEqual(acc.summary(), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0 });
  const a = acc.summary();
  const b = acc.summary();
  assert.notEqual(a, b, 'summary() returns a fresh object each call');
});

test('accumulator: observeResult reads result.usage (raw snake) and result.reason.usage (codex runner copy)', () => {
  const a = createUsageAccumulator();
  a.observeResult({ code: 'completed', usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2 } });
  assert.deepEqual(a.summary(), { inputTokens: 7, outputTokens: 3, cacheReadTokens: 2, totalTokens: 10 });

  const b = createUsageAccumulator();
  b.observeResult({ code: 'completed', reason: { kind: 'completed', usage: { inputTokens: 9, outputTokens: 4 } } });
  assert.deepEqual(b.summary(), { inputTokens: 9, outputTokens: 4, cacheReadTokens: 0, totalTokens: 13 });
});

// --- 2: engine level — the onOutbound final-reply context ——————————————————

test('engine: usage events from mixed dialects reach onOutbound ONCE, on the final reply only', async () => {
  const calls = [];
  const h = makeHarness({
    middleware: {
      maskOutbound,
      onOutbound: (text, ctx) => { calls.push({ text, ctx }); return text; },
    },
    runner: fakeRunner({
      emit: [
        { type: 'step', n: 1, usage: { inputTokens: 249, outputTokens: 59, totalTokens: 7092, cacheReadTokens: 6784 } },
        { type: 'text', text: '正文', usage: { input_tokens: 300, output_tokens: 80, cache_read_input_tokens: 6784 } },
        { type: 'tool', name: 'x', brief: 'b', usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 20 } },
      ],
    }),
  });
  await h.send();

  assert.equal(calls.length, 1, `exactly one onOutbound call (got ${calls.length})`);
  assert.equal(calls[0].text, '最终答案全文', 'the call carries the FINAL text');
  assert.deepEqual(calls[0].ctx.usage, {
    inputTokens: 300, outputTokens: 80, cacheReadTokens: 6784, totalTokens: 7092,
  });
  // progress/ack frames never saw the middleware: every delivered frame but
  // the final one is engine copy, and the final equals text+nothing (spy is
  // a passthrough).
  const frames = h.adapter.frames;
  const final = frames[frames.length - 1];
  assert.equal(final.finish, true);
  assert.equal(final.text, '最终答案全文');
  const nonFinal = frames.slice(0, -1);
  assert.ok(nonFinal.length >= 1);
  assert.ok(nonFinal.every((f) => !f.text.includes('最终答案全文')), 'progress frames carry no answer body (polite default)');
});

test('engine: codex reason.usage (no usage events) still reaches the ctx', async () => {
  const calls = [];
  const h = makeHarness({
    middleware: { maskOutbound, onOutbound: (text, ctx) => { calls.push(ctx); return text; } },
    runner: fakeRunner({
      resultOverrides: { reason: { kind: 'completed', usage: { inputTokens: 11, outputTokens: 6 } } },
    }),
  });
  await h.send();
  assert.deepEqual(calls[0].usage, { inputTokens: 11, outputTokens: 6, cacheReadTokens: 0, totalTokens: 17 });
});

test('engine: ctx carries bot record, model (fallback unknown) and durationMs', async () => {
  const calls = [];
  const withModel = makeHarness({
    bot: { id: 'bot-m', provider: 'claude', channel: 'wecom', providerConfig: { cwd: CWD, model: { model: 'glm-4.7' } } },
    middleware: { maskOutbound, onOutbound: (text, ctx) => { calls.push(ctx); return text; } },
    runner: fakeRunner(),
  });
  await withModel.send();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'glm-4.7');
  assert.equal(calls[0].bot.id, 'bot-m');
  assert.ok(Number.isFinite(calls[0].durationMs) && calls[0].durationMs >= 0, 'durationMs is a non-negative number');

  const noModel = makeHarness({
    middleware: { maskOutbound, onOutbound: (text, ctx) => { calls.push(ctx); return text; } },
    runner: fakeRunner(),
  });
  await noModel.send();
  assert.equal(calls[1].model, 'unknown', 'missing model config degrades to unknown');
});

test('engine: aborted run never calls onOutbound (maintenance banners stay untouched)', async () => {
  const calls = [];
  const h = makeHarness({
    middleware: { maskOutbound, onOutbound: (text, ctx) => { calls.push(text); return text; } },
    runner: {
      async run(args) {
        // park until abort like a real provider (§5: abort settles, never rejects)
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 5_000);
          args.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
        });
        return { ok: false, code: 'aborted', finalText: '', aborted: true, sessionId: null, reason: 'aborted', detail: {} };
      },
    },
  });
  h.engine.onMessage(h.bot, {
    chatKey: K, chatKind: 'group', chatid: 'g1', userid: 'u1', text: '打断我',
    reqId: `req-${randomUUID()}`,
  });
  const settle = h.engine.chains.get(K);
  h.engine.inFlight.get(K).abort();
  await settle;
  await tick();
  assert.equal(calls.length, 0, 'onOutbound stays silent for a non-completed outcome');
});

test('engine: a throwing onOutbound middleware is isolated — the reply still lands, unchanged, with a warn', async () => {
  const h = makeHarness({
    middleware: {
      maskOutbound,
      onOutbound: () => { throw new Error('tracker blew up'); },
    },
    runner: fakeRunner(),
  });
  await h.send();
  const frames = h.adapter.frames;
  const final = frames[frames.length - 1];
  assert.equal(final.finish, true);
  assert.equal(final.text, '最终答案全文', 'final delivered unchanged');
  assert.ok(h.log.lines.warn.some((l) => String(l).includes('onOutbound')), 'failure attributed in the log');
  // the ledger row keeps the raw answer (the footer is presentation, not data)
  const rows = h.ledger.turns({ chatKey: K });
  assert.equal(rows[rows.length - 1].assistant, '最终答案全文');
});

test('engine: middleware may be a LIST — mask impls compose, onOutbound impls chain in order', async () => {
  const order = [];
  const h = makeHarness({
    middleware: [
      {
        maskOutbound: (t) => t,
        onOutbound: (t) => { order.push('first'); return `${t}|1`; },
      },
      {
        maskOutbound,
        onOutbound: async (t) => { order.push('second'); return `${t}|2`; },
      },
    ],
    runner: fakeRunner(),
  });
  await h.send();
  assert.deepEqual(order, ['first', 'second']);
  const frames = h.adapter.frames;
  assert.equal(frames[frames.length - 1].text, '最终答案全文|1|2');
});

test('engine: no onOutbound middleware → final text and ledger byte-identical to before (no regression seam)', async () => {
  const h = makeHarness({ runner: fakeRunner() }); // default { maskOutbound } only
  await h.send();
  const frames = h.adapter.frames;
  assert.equal(frames[frames.length - 1].text, '最终答案全文');
  assert.equal(h.ledger.turns({ chatKey: K })[0].assistant, '最终答案全文');
});

test('engine: middleware returning a non-string is ignored — the reply keeps its text', async () => {
  const h = makeHarness({
    middleware: { maskOutbound, onOutbound: () => null },
    runner: fakeRunner(),
  });
  await h.send();
  assert.equal(h.adapter.frames.at(-1).text, '最终答案全文');
});

test('engine: masking still applies to middleware-injected text (a footer cannot smuggle a secret out)', async () => {
  const secret = 'sk-abcdefghijklmnop1234'; // matches the maskOutbound pattern
  const h = makeHarness({
    middleware: {
      maskOutbound,
      onOutbound: (text) => `${text}\n${secret}`,
    },
    runner: fakeRunner({ emit: [{ type: 'text', text: 'x', usage: { input_tokens: 1 } }] }),
  });
  await h.send();
  const final = h.adapter.frames.at(-1);
  assert.ok(!final.text.includes(secret), 'middleware-injected secret is masked');
  assert.ok(final.text.includes('***'));
});
