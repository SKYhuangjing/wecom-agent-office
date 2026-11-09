// Engine: core-engine's concurrency core (DESIGN §6 串行链, review-pinned).
// This file owns WHEN a run starts, WHEN it is preempted and WHEN the chain
// picks up the next message — the turn body itself (ack / two-phase / code
// branches / recordTurn) lives in defaultRunTurn below and is injectable as
// { runTurnImpl } for tests that only want the chain machinery.
//
// The three pinned invariants every line here protects:
//   1. PER-CHATKEY SERIAL CHAIN: turns for one chatKey run strictly one at a
//      time. A replacement run NEVER spawns before the previous run's promise
//      fully settles — settle means the whole _runTurn resolved (subprocess
//      dead + recordTurn + cache persists), not merely "abort was signaled".
//   2. QUEUE MERGE (latest-wins): a message arriving while a turn is in
//      flight aborts it and REPLACES any older queued message; queued
//      messages are never batch-run one by one.
//   3. COMPARE-AND-DELETE: a run's cleanup removes inFlight[chatKey] only if
//      the registered controller is still its OWN. The predecessor deleted
//      unconditionally and a stale finally killed the NEW run's controller.
//
// Cross-chatKey parallelism is bounded by a global gate (limits.concurrency)
// backed by a FIFO of waiting turns, so one bot's traffic cannot starve
// another bot's. Controllers are registered the moment a message is accepted
// (before a gate slot is acquired), which makes "abort before spawn" a
// first-class case: a doomed turn never reaches runTurnImpl at all.

import { randomUUID } from 'node:crypto';
import { maskOutbound } from './middleware.js';
import { formatTurnBlock } from './ledger.js';
import { createPoliteProgress, POLITE_TEMPLATE_DEFAULT } from './progressor.js';

// Channel-capability defaults (DESIGN §4/§6). minIntervalMs/maxContentChars/
// streamDeadlineMs etc. are consumed by the outbound path (defaultRunTurn) and
// the adapters — the chain machinery itself only enforces `concurrency`.
export const ENGINE_LIMITS = Object.freeze({
  concurrency: 4,
  minIntervalMs: 2200,
  heartbeatMs: 20000,
  maxContentChars: 3500,
  streamDeadlineMs: 600000,
  hardTimeoutMs: 1800000,
  warnLeadMs: 90000,
  outboundBudgetPerMin: 28,
  outboundTimeoutMs: 10000,
});

// Lifecycle Phase-0 drain cap: a drain must never be able to wait forever —
// one hung run (an impl that ignores its abort signal) would otherwise leave
// `draining` latched and the engine refusing every message permanently.
const DRAIN_DEFAULT_TIMEOUT_MS = 5000;

const noopLog = Object.freeze({
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
});

// —— the default turn body (DESIGN §6 numbered flow) ———————————————————————
//
// defaultRunTurn is what a turn DOES once the serial chain grants it a slot:
// resolve the session (§6.3 + §7 consumedSeq rules), ack, stream throttled +
// budgeted progress with a heartbeat, enforce the two-phase deadline (§6.7),
// branch on the runner's machine-readable code (§5), and leave the ledger /
// session-cache / timeline world consistent for EVERY outcome. It is the
// constructor default for runTurnImpl and stays replaceable wholesale.

const OUTBOUND_WINDOW_MS = 60_000; // §6.4: the outbound budget is per minute

// Bounded outbound (R2 hardening): an adapter promise that never settles (hung
// SDK call, dead socket without an error) would otherwise await forever inside
// the turn body — and with it permanently wedge that chatKey's serial chain.
// Every adapter call is raced against this deadline; losing the race is a
// warn and the turn moves on. The losing promise stays observed (Promise.race
// attaches handlers to it), so a much-later rejection cannot become an
// unhandledRejection.
const sendWithTimeout = (p, ms) => {
  let timer = null;
  const bail = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`outbound timeout after ${ms}ms`)), ms);
  });
  return Promise.race([Promise.resolve(p), bail]).finally(() => clearTimeout(timer));
};

// Outbound copy — single source; tests pin several of these verbatim.
const ACK_TEXT = '✅ 收到，马上处理…';
const WARN_TEXT = '⏳ 任务仍在后台运行，完成后将主动推送结果';
const TIMEOUT_TEXT = '⚠️ 任务超时未完成（会话已标记，下次将新开会话续接）';
const LOCK_TEXT = '该会话的写锁被另一个进程占用（可能是别的实例），机器人暂时无法回复。请稍后重试。';
const CANCEL_TEXT = '（已取消上一条回复）';
const ABORT_BANNER = '> ⚠️ 已被新消息打断';
const ERROR_BANNER = '⚠️ 运行未正常结束';
const EMPTY_DONE_TEXT = '（任务已完成）';
const DRAIN_INFLIGHT_TEXT = '⚠️ 服务维护，任务已中断，请重发';
// Exported: api.js answers PER-BOT drain refusals with the same copy the
// global sendDrainRefusals uses (one source for the user-facing line).
export const DRAIN_REFUSAL_TEXT = '⚠️ 服务维护，未处理，请重发';
const TRUNC_FINAL = '…（完整内容见会话页）';
const TRUNC_PROGRESS = '…(内容较长，已截断)';
const HANDOFF_HEADER = '以下是本对话此前的记录（供上下文参考）：';

// Unified events (§5) → timeline kinds (§3). session/error/final get no
// timeline row here: the closing 'turn' row already carries the outcome.
// usage: providers may report token usage as its own event kind; it lands in
// the local ring beside the per-run 'usage' summary row bookkeep appends.
const EV_TO_KIND = { step: 'step', tool: 'tool', thinking: 'thinking', text: 'turn', usage: 'usage' };

// —— per-run token usage accumulator (cost-tracker & co) ————————————————————
// Providers report usage in four dialects on their events:
//   dsh     status{phase:'step_end', usage:{inputTokens, outputTokens,
//           totalTokens, cacheReadTokens}}                     (camelCase)
//   claude  result {usage:{input_tokens, output_tokens, cache_read_input_tokens}}
//   codex   turn.completed {usage:{input_tokens, cached_input_tokens,
//           output_tokens}} — the codex runner also hands a normalized copy
//           back on result.reason.usage
//   pi      message_end {usage:{input, output, cacheRead, cost:{total}}} —
//           also normalized onto result.reason.usage by the runner (cost rides
//           along there but no summary field prices it)
// (probe-baselines/*.ndjson are the pinned sources). Everything normalizes to
// one camelCase shape. Counts are RUNNING TOTALS of the same run — dsh
// step_end re-reports the turn-so-far — so each field keeps the MAX seen,
// never a sum: a cumulative reporter would double-count.
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const maxKeep = (cur, v) => (v != null && v > cur ? v : cur);

export function createUsageAccumulator() {
  const max = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0 };
  const observe = (usage) => {
    if (usage == null || typeof usage !== 'object') return;
    max.inputTokens = maxKeep(max.inputTokens, num(usage.inputTokens ?? usage.input_tokens));
    max.outputTokens = maxKeep(max.outputTokens, num(usage.outputTokens ?? usage.output_tokens));
    // claude says cache_read_input_tokens, codex says cached_input_tokens —
    // both are the prompt-cache-read bucket.
    max.cacheReadTokens = maxKeep(max.cacheReadTokens, num(usage.cacheReadTokens
      ?? usage.cache_read_input_tokens ?? usage.cached_input_tokens ?? usage.cache_read_tokens));
    max.totalTokens = maxKeep(max.totalTokens, num(usage.totalTokens ?? usage.total_tokens));
  };
  return {
    // Any unified event may carry usage (runners forward what their CLI
    // reported); events without usage are ignored.
    observe: (ev) => observe(ev?.usage),
    // The settled run result is the last usage source: codex's runner returns
    // reason.usage (normalized), a runner forwarding the CLI result verbatim
    // may put usage at the top level instead.
    observeResult: (result) => {
      observe(result?.reason?.usage);
      observe(result?.usage);
    },
    summary: () => ({
      inputTokens: max.inputTokens,
      outputTokens: max.outputTokens,
      cacheReadTokens: max.cacheReadTokens,
      // Providers that report no total (claude/codex) still get a sane one.
      totalTokens: Math.max(max.totalTokens, max.inputTokens + max.outputTokens),
    }),
  };
}

// —— 会话 TTL 退役（DESIGN-TOKEN-OPT §4.4）————————————————————————————
// --resume 每轮把整段会话历史作为输入重放（实测一条「hi」付 62k）。TTL 内的
// 多轮任务照旧续会话（这正是 --resume 该付的钱）；越窗即退役——下一轮从全新
// 会话开始，不带 handoff 前缀，长时上下文交给记忆层（memory 资产注入）。
export const SESSION_TTL_MIN_DEFAULT = 45;

// providerConfig.sessionTtlMin：数字、≥0 才有效；0=永不退役；非法/缺省→默认。
// 引擎侧防御式解析（providerConfig 未知键自由通过，schema 无 number 类型）。
export function sessionTtlMinutes(bot) {
  const v = bot?.providerConfig?.sessionTtlMin;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : SESSION_TTL_MIN_DEFAULT;
}

// 纯判定（导出供单测）：pe 无时间戳（历史遗留条目）视为未过期——升级后首条
// 消息不惊扰既有会话，下一次 upsert 起才参与 TTL。
export function isSessionStale(pe, now, ttlMin) {
  if (pe == null || typeof pe !== 'object') return false;
  if (!(typeof ttlMin === 'number' && ttlMin > 0)) return false;
  const lastAt = pe.lastAt;
  if (typeof lastAt !== 'number' || !Number.isFinite(lastAt)) return false;
  return now - lastAt > ttlMin * 60_000;
}

export async function defaultRunTurn(bot, msg, ac) {
  const engine = this;
  // A bare engine (kernel boot) has no wiring: skip loudly instead of crashing
  // inside the chain — the serial machinery still settles cleanly.
  if (!engine.getRunner || !engine.getAdapter || !engine.ledgerFactory) {
    engine.log.warn?.('engine: turn skipped — runner/adapter/ledger wiring incomplete');
    return;
  }
  const { ledger, cache } = engine.ledgerFactory(bot.id);
  const adapter = engine.getAdapter(bot);
  const runner = engine.getRunner(bot);

  // Channel capabilities (§4) with engine-limit fallbacks (§6): the engine
  // never hardcodes one channel's numbers.
  const caps = adapter.capabilities ?? {};
  const L = engine.limits;
  const minIntervalMs = caps.minIntervalMs ?? L.minIntervalMs;
  const heartbeatMs = caps.heartbeatMs ?? L.heartbeatMs;
  const maxContentChars = caps.maxContentChars ?? L.maxContentChars;
  const streaming = caps.stream !== false;
  const pushable = caps.push !== false;
  const warnAt = Math.max(0, (caps.streamDeadlineMs ?? L.streamDeadlineMs) - L.warnLeadMs);
  const hardTimeoutMs = L.hardTimeoutMs;
  const budgetPerMin = L.outboundBudgetPerMin;
  // Masking is ALWAYS on: an injected middleware may replace the pattern, but
  // a missing one must not silently become a passthrough. `middleware` may be
  // a single impl, a LIST of impls (PLUGIN-DEV §5.5 chain port) or null.
  const middlewareImpls = engine.middleware == null ? []
    : Array.isArray(engine.middleware) ? engine.middleware : [engine.middleware];
  const maskImpls = middlewareImpls.filter((mw) => typeof mw?.maskOutbound === 'function');
  const maskFn = maskImpls.length > 0
    ? (text) => maskImpls.reduce((t, mw) => mw.maskOutbound(t), text)
    : maskOutbound;
  const describeError = runner.describeError ?? bot.describeError
    ?? ((r) => `任务失败（${r?.code ?? 'error'}）`);

  const chatKey = msg.chatKey;
  const provider = bot.provider;
  const bornCwd = bot.providerConfig?.cwd;
  const chatRef = msg.raw ?? chatKey; // the adapter resolves the push target (§4)

  // —— 1. session resolution (§6.3 + §7) ————————————————————————————————
  const entry = cache.get(chatKey);
  let pe = entry?.cache?.[provider] ?? null;
  // TTL 退役前置（DESIGN-TOKEN-OPT §4.4）：越窗的活跃会话先退役——当轮
  // 走全新会话。区别于 provider 切换的分支 3：不带 handoff 前缀（长时
  // 上下文由记忆层承接，不重放历史）。
  let expiredByTtl = false;
  if (isSessionStale(pe, Date.now(), sessionTtlMinutes(bot))) {
    cache.expire(chatKey, provider);
    pe = null;
    expiredByTtl = true;
    engine.log.info?.(`session expired by TTL: ${chatKey}/${provider} — starting fresh`);
  }
  const nativeOk = !!entry && entry.current === provider && !!pe
    && pe.bornCwd === bornCwd && pe.dirty !== true && entry.dirty !== true;
  // Rule-1 pin (review counterexample A): the upsert's consumedSeq argument is
  // maxSeq({chatKey}) — NO provider filter — captured BEFORE this turn's own
  // row exists, because the prefix physically contains cross-provider history.
  const maxSeqAtBuild = ledger.maxSeq({ chatKey });
  let sessionId = null;
  let prefix = '';
  // Switch-back resolution stages its persistence here and commits it in
  // bookkeep (post-run), mirroring the new-session upsert path: persisting
  // consumedSeq/current BEFORE the run would advance past rows only the
  // runner can deliver — a turn aborted in the ack window must leave the
  // delta unconsumed so the replacement replays it (rule 4).
  let pendingSwitchBack = null;
  if (nativeOk) {
    sessionId = pe.sessionId; // native resume: no prefix, the session has it all
  } else if (entry && pe && pe.bornCwd === bornCwd && pe.dirty !== true) {
    // Switching BACK to a provider with a clean cached session: resume INTO it
    // and replay only the delta that session has not consumed (rule 4).
    const { rows, consumedUpTo } = cache.handoffReplay(chatKey, provider);
    if (rows.length > 0) prefix = HANDOFF_HEADER + '\n\n' + rows.map(formatTurnBlock).join('\n\n');
    sessionId = pe.sessionId;
    pendingSwitchBack = consumedUpTo;
  } else {
    // New provider, dirty session (self-handoff) or bornCwd drift: fresh
    // session carrying the ledger prefix. Switching away does NOT dirty the
    // old provider's entry — only timeout / hard kill does (§7 切回语义).
    // TTL 退役同样落到这里，但不带前缀——旧历史不进新会话（§4.4）。
    prefix = expiredByTtl ? '' : ledger.buildHandoffPrefix({ chatKey });
    sessionId = null;
  }
  const sessionIdWasNull = sessionId === null;
  const prompt = prefix ? `${prefix}\n\n---\n\n${msg.text}` : msg.text;

  // —— 2. outbound plumbing: budget + throttle + truncation + mask (§6.4) ————
  const startedAt = Date.now();
  const streamId = `s-${randomUUID()}`;
  const outWindow = []; // frame timestamps inside the sliding budget window
  let lastFrameAt = 0;
  let pendingLine = null; // latest throttled line, flushed at the interval edge
  let flushTimer = null;
  let hbSendToggle = false;
  let backgroundMode = false; // warn frame sent: stream closed, result → push
  let hardTimedOut = false; // engine-side cause stamp for the reclassify

  const truncateTo = (text, marker) => {
    if (typeof text !== 'string' || text.length <= maxContentChars) return text ?? '';
    return text.slice(0, maxContentChars) + (marker ?? TRUNC_PROGRESS);
  };
  // FINAL 帧专用「保尾截断」（盲评 P1-2 回归）：中间件输出约定挂在文本尾部
  // （记忆蒸馏残留说明/cost-tracker 的 📊 尾行）——纯掐头会把尾注一起截掉。
  // 头部保留主体、尾部保留 240 字（尾注+末句），中间以省略标记衔接。
  const truncateFinalKeepingTail = (text, marker) => {
    if (typeof text !== 'string' || text.length <= maxContentChars) return text ?? '';
    const tailKeep = Math.min(240, Math.max(0, maxContentChars - 40));
    const headKeep = Math.max(0, maxContentChars - tailKeep - 24);
    return text.slice(0, headKeep) + (marker ?? TRUNC_FINAL) + '\n' + text.slice(-tailKeep);
  };
  // Mask BEFORE truncating: a truncation-split secret would dodge the pattern.
  const outboundText = (text, marker = TRUNC_PROGRESS) => truncateTo(maskFn(text), marker);

  const windowCount = (now) => {
    while (outWindow.length > 0 && now - outWindow[0] >= OUTBOUND_WINDOW_MS) outWindow.shift();
    return outWindow.length;
  };
  const stamp = () => { lastFrameAt = Date.now(); outWindow.push(lastFrameAt); };
  // Adapter calls must never take the turn down — not on rejection, not on a
  // (buggy) synchronous throw, and not on a never-settling promise (the
  // sendWithTimeout race bounds every call; a timeout logs and the turn
  // proceeds, or the chain for this chatKey would stay wedged forever).
  const outboundTimeoutMs = caps.outboundTimeoutMs ?? L.outboundTimeoutMs;
  const sendVia = (what, call) => {
    try {
      return sendWithTimeout(call(), outboundTimeoutMs).catch((e) => {
        engine.log.warn?.(`engine: ${what} send failed: ${e?.message ?? e}`);
      });
    } catch (e) {
      engine.log.warn?.(`engine: ${what} send failed: ${e?.message ?? e}`);
      return Promise.resolve();
    }
  };

  const sendProgress = (text, finish = false) => {
    stamp(); // every engine-issued frame counts against the budget (§6.4)
    return sendVia('progress', () => adapter.progress(msg.reqId, streamId, text, finish));
  };
  const sendReply = (text) => {
    stamp();
    return sendVia('reply', () => adapter.reply(msg.reqId, text));
  };
  const sendPush = (text) => sendVia('push', () => adapter.push(chatRef, text)); // push quota is adapter-side (§4)
  // Final delivery routes by mode: in background the stream was closed by the
  // warn frame, so the result must not re-appear as a stream frame.
  const deliverFinal = (text) => {
    if (backgroundMode) return pushable ? sendPush(text) : sendReply(text);
    return streaming ? sendProgress(text, true) : sendReply(text);
  };

  const offerProgress = (line) => {
    if (!streaming) return; // nothing to refresh on a reply-only channel
    if (windowCount(Date.now()) >= budgetPerMin) {
      pendingLine = null; // over budget: the event stream stops first (§6.4)
      return;
    }
    const since = Date.now() - lastFrameAt;
    if (lastFrameAt === 0 || since >= minIntervalMs || since >= heartbeatMs) {
      pendingLine = null;
      void sendProgress(outboundText(line));
      return;
    }
    pendingLine = line; // latest wins; the trailing flush keeps the freshest state
    if (flushTimer == null) flushTimer = setTimeout(flushPending, Math.max(0, minIntervalMs - since));
  };
  const flushPending = () => {
    flushTimer = null;
    const line = pendingLine;
    pendingLine = null;
    if (line != null) offerProgress(line);
  };

  // §5 contract: onEvent is ordered and synchronous — outbound inside it is
  // fire-and-forget so a slow adapter call can never stall the provider.
  //
  // Progress style (2026-11-06 owner decision — DEFAULT FLIPPED to polite):
  // unless progressStyle === 'cot', the channel-facing progress line is ONE
  // templated broadcast sentence (拟人播报) — NO 💭 thinking / 🔧 tool / ✍️
  // answer-preview content reaches WeCom; elapsed time + breathing dots keep
  // the line visibly alive, and the raw events still land in the LOCAL
  // timeline below. Legacy bots that stored progressCoT:true are flipped
  // along with everyone else (owner call); progressCoT is a DEPRECATED alias
  // that only survives INSIDE cot style, where explicit false still suppresses
  // the 💭 line (the A2 semantics).
  const pc = bot.providerConfig ?? {};
  const politeStyle = pc.progressStyle !== 'cot';
  const progressCoT = pc.progressCoT !== false;
  const politeProgress = createPoliteProgress();
  const politeTemplate = typeof pc.progressText === 'string' && pc.progressText !== ''
    ? pc.progressText : POLITE_TEMPLATE_DEFAULT;
  let politeStep = null; // last step number seen; feeds {step} once steps exist
  const elapsedText = () => {
    const secs = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    return `${secs} 秒`;
  };
  const politeCopy = () => politeProgress.line({
    template: politeTemplate,
    botName: bot.name ?? bot.id ?? '',
    elapsed: elapsedText(),
    step: politeStep,
  });

  let answer = '';
  // Per-run usage (cost-tracker ctx): zeros at run start, fed by every usage
  // event onEvent sees. Local to THIS turn on purpose — the same bot may run
  // turns in several chats concurrently (cross-chatKey parallelism), so a
  // bot-keyed accumulator would blend runs.
  const usageAcc = createUsageAccumulator();
  // onOutbound (PLUGIN-DEV §5.5): the outbound middleware that may TRANSFORM
  // the final reply text (cost-tracker's token footer & co). Only the
  // completed branch's final frame passes here — progress/heartbeat frames
  // and aborted/timeout maintenance banners never do. A throwing middleware
  // is isolated: a broken plugin must never eat a live reply.
  const runOnOutbound = async (text, ctx) => {
    let out = text;
    for (const mw of middlewareImpls) {
      if (typeof mw?.onOutbound !== 'function') continue;
      try {
        const next = await mw.onOutbound(out, ctx);
        if (typeof next === 'string') out = next;
      } catch (e) {
        engine.log.warn?.(`engine: onOutbound middleware failed: ${e?.message ?? e}`);
      }
    }
    return out;
  };
  const onEvent = (ev) => {
    try {
      usageAcc.observe(ev);
      if (ev?.type === 'text' && typeof ev.text === 'string') answer = ev.text; // cumulative
      if (politeStyle && ev?.type === 'step' && Number.isFinite(ev.n)) politeStep = ev.n;
      let line = null;
      if (politeStyle) {
        // 拟人播报: every run-progress event (thinking/tool/text/step) refreshes
        // the SAME broadcast sentence — elapsed + dots make each frame move;
        // session/error/final keep no progress meaning. The ✍️ answer preview
        // is suppressed too: the body only appears in the final frame.
        if (ev?.type === 'thinking' || ev?.type === 'tool' || ev?.type === 'text' || ev?.type === 'step') {
          line = politeCopy();
        }
      } else {
        // cot (详细汇报, legacy §6.1): composed lines via the progressor; a
        // progressCoT:false bot never sees a 💭 line — the filter sits BEFORE
        // compose (progressor untouched).
        const composeIt = engine.progressor != null && !(ev?.type === 'thinking' && !progressCoT);
        line = composeIt ? engine.progressor.compose(ev, { answer }) : null;
      }
      if (line != null) {
        offerProgress(line);
        engine.setProgress(bot.id, line, ev.type);
      }
      const kind = EV_TO_KIND[ev?.type];
      if (kind !== undefined && engine.timeline) {
        // Raw text (full CoT, tool brief) lives in the local timeline only —
        // the channel only ever saw the composed/broadcast line (§6.1).
        const raw = typeof ev?.text === 'string' ? ev.text : (ev?.brief ?? '');
        engine.timeline.push({ botId: bot.id, chatKey, kind, text: raw || line || '' });
      }
    } catch (e) {
      engine.log.warn?.(`engine: event handling failed: ${e?.message ?? e}`);
    }
  };

  // Heartbeat: elapsed-time line even with no events; halved (every other
  // tick) once the budget is spent — liveness survives, spam does not (§6.4).
  const ticker = heartbeatMs > 0
    ? setInterval(() => {
        if (!streaming) return;
        const now = Date.now();
        if (windowCount(now) >= budgetPerMin) {
          hbSendToggle = !hbSendToggle;
          if (!hbSendToggle) return; // over budget: heartbeat every other tick
        }
        if (lastFrameAt !== 0 && now - lastFrameAt < minIntervalMs) return; // a frame just went out
        const secs = Math.max(1, Math.round((now - startedAt) / 1000));
        // Polite style: the heartbeat IS a broadcast frame (elapsed grows +
        // dots advance = the visible animation); cot keeps the ⏳ copy.
        const hbText = politeStyle ? politeCopy() : `⏳ 已运行 ${secs} 秒`;
        void sendProgress(outboundText(hbText));
      }, heartbeatMs)
    : null;

  // §6.7 two-phase deadline: warn closes the stream (background mode on, run
  // keeps going); the hard timer aborts — the runner only sees 'aborted', so
  // hardTimedOut is what reclassifies the result to a timeout.
  // runSettled (known-boundaries wave 2026-11-06): once the runner's promise
  // settles, both timers lose their meaning — a warn firing in the narrow
  // window before stopTimers (during the final frame's adapter awaits) would
  // promise 「转后台推送」 for a run that is already delivering its final, and
  // a hard abort of a settled run reclassifies nothing. Fire → no-op.
  let runSettled = false;
  const warnTimer = setTimeout(() => {
    if (runSettled) return;
    backgroundMode = true; // the 10min cliff degrades to a channel switch
    const text = outboundText(WARN_TEXT);
    if (streaming) void sendProgress(text, true);
    else void sendReply(text);
  }, warnAt);
  const hardTimer = setTimeout(() => {
    if (runSettled) return;
    hardTimedOut = true;
    ac.abort();
  }, hardTimeoutMs);
  const stopTimers = () => {
    if (ticker != null) clearInterval(ticker);
    clearTimeout(warnTimer);
    clearTimeout(hardTimer);
    if (flushTimer != null) { clearTimeout(flushTimer); flushTimer = null; }
  };

  // Bookkeeping (§6.6): runs for EVERY outcome — row, cache, timeline — so
  // the consumedSeq protocol survives aborted/timed-out/failed turns.
  const bookkeep = (result) => {
    // Observability first (P2): stamp the run's usage/duration onto the live
    // run record BEFORE anything that could throw below, so the run/end SSE
    // frame and the /api/agents lastRun fields survive even a ledger failure.
    const usage = usageAcc.summary();
    const durationMs = Date.now() - startedAt;
    engine._noteRunMetrics(chatKey, bot.id, { usage, durationMs });
    // A null result means "aborted before the runner started" — same ledger
    // shape as a preempted run. hardTimedOut reclassifies a hard-timer abort
    // (the runner itself can only see 'aborted') to a timeout.
    const effCode = !result ? 'aborted'
      : result.code === 'aborted' && hardTimedOut ? 'timeout' : result.code;
    const reason = effCode === 'completed' ? 'completed'
      : effCode === 'aborted' ? 'interrupted'
        : effCode === 'timeout' ? 'timeout' : 'error';
    // §5 abort 处置: a FIRST session aborted mid-write is never cached.
    if (result?.sessionId && !(result.aborted && sessionIdWasNull)) {
      if (sessionIdWasNull || result.sessionId !== sessionId) {
        cache.upsert(chatKey, provider, { sessionId: result.sessionId, bornCwd }, maxSeqAtBuild);
      } else {
        // 原生续会话（同 sessionId）不走 upsert——TTL 判据 lastAt 必须在这里
        // 刷新，否则「距上轮」退化成「会话年龄」，活跃对话 45 分钟后被误退役
        // （盲评 P1-1）。
        cache.touch(chatKey, provider);
      }
    }
    // markDirty AFTER the upsert: upsert resets dirty on the entry it writes,
    // and a timed-out brand-new session must END dirty.
    if (effCode === 'timeout') cache.markDirty(chatKey, provider);
    const seq = ledger.nextSeq();
    // tokens: the run's accumulated total (observability wave) — bookkeep runs
    // for EVERY outcome, so aborted/timeout/error rows keep what the run
    // burned before it ended. cost stays null: no pricing, by decision.
    ledger.recordTurn({
      seq, at: Date.now(), chatKey,
      channel: bot.channel ?? chatKey.split(':')[0], chatKind: msg.chatKind,
      chatid: msg.chatid ?? chatKey.split(':')[2] ?? '', userid: msg.userid,
      user: msg.text, assistant: result?.finalText || '', provider,
      sessionId: result?.sessionId || sessionId || '',
      ok: reason === 'completed', reason,
      tokens: usageAcc.summary().totalTokens, cost: null,
    });
    // UI bridge (§8 SSE ledger/turn): the row is durable — announce it right
    // after the append so session/timeline pages can refetch immediately
    // instead of waiting for the next poll.
    engine.emit?.('ledger/turn', { botId: bot.id, chatKey, seq, reason });
    if (pendingSwitchBack != null && result != null) {
      // The runner really consumed the replayed delta: advance to exactly
      // what was delivered and flip `current` — rule 2's advance below then
      // moves past this turn's own row as usual.
      cache.setConsumed(chatKey, provider, pendingSwitchBack);
      cache.setCurrent(chatKey, provider); // the delta is in THIS session now
    }
    if (pendingSwitchBack == null || result != null) {
      cache.setConsumed(chatKey, provider, seq); // rule 2: every row advances
    }
    // else: a switch-back turn aborted BEFORE the runner ran — the delta (and
    // this interrupted row) never reached the resumed session, so both stay
    // unconsumed and replay on the next switch-back. Advancing here would
    // mark rows delivered that nobody delivered.
    engine.timeline?.push({
      botId: bot.id, chatKey, kind: 'turn',
      text: `${msg.text} → ${(result?.finalText || '').slice(0, 60)}`,
    });
    // Observability (P2): one usage summary row per run end — the token cost
    // of this turn in the local ring, beside the ledger's durable tokens field.
    engine.timeline?.push({
      botId: bot.id, chatKey, kind: 'usage',
      text: `📊 输入 ${usage.inputTokens} · 输出 ${usage.outputTokens}`,
    });
    // run done log line (P2): the one line an operator greps wao.log for —
    // outcome, reason, burned tokens and wall time on a single greppable row.
    engine.log.info?.(`run done ${chatKey} bot=${bot.id} ok=${reason === 'completed'} reason=${reason} tokens=${usage.totalTokens} dur=${durationMs}ms`);
    engine.progressor?.reset();
    engine.setProgress(bot.id, null, 'run');
  };

  // Abort-before-run (defensive: the chain skips aborted turns pre-impl, but a
  // preempt can land while the ack await below is open).
  if (ac.signal.aborted) {
    stopTimers();
    bookkeep(null);
    return;
  }

  // —— 3. ack (§6.2): open the stream, or the plain hint on reply-only channels
  const ackText = outboundText(ACK_TEXT);
  if (streaming) {
    stamp();
    await sendVia('ack', () => adapter.ack(msg.reqId, streamId, ackText));
  } else {
    await sendReply(ackText);
  }
  if (ac.signal.aborted) {
    // The stream was just opened; close it honestly instead of leaving it
    // dangling, record the interrupted row, never spawn the runner.
    try {
      await deliverFinal(outboundText(CANCEL_TEXT));
    } finally {
      stopTimers();
      bookkeep(null);
    }
    return;
  }

  // —— 4/5. run + code branches (§6.4/§6.5) ————————————————————————————
  // run start log line (P2): pairs with bookkeep's 'run done' — session=(new)
  // marks a fresh session, session=<id> a native resume. Logged here, at the
  // spawn point, so an aborted-before-runner turn never claims a start.
  engine.log.info?.(`run start ${chatKey} bot=${bot.id} session=${sessionId || '(new)'}`);
  const runArgs = () => ({ prompt, sessionId, signal: ac.signal, timeoutMs: hardTimeoutMs, onEvent });
  const synthError = (e) => ({
    ok: false, code: 'error', finalText: '', aborted: false,
    sessionId: sessionId ?? null, reason: 'exception', detail: { error: String(e?.message ?? e) },
  });
  let result;
  try {
    try {
      result = await runner.run(runArgs());
    } catch (e) {
      // §5 says run() never rejects; a violating runner still gets a row.
      engine.log.error?.(`engine: runner threw for ${chatKey}: ${e?.stack ?? e}`);
      result = synthError(e);
    }
    if (result?.code === 'lock-conflict') {
      engine.log.warn?.(`engine: ${chatKey} write-lock conflict — retrying once`);
      try {
        result = await runner.run(runArgs()); // same prompt + same sessionId
      } catch (e) {
        engine.log.error?.(`engine: lock retry threw for ${chatKey}: ${e?.stack ?? e}`);
        result = synthError(e);
      }
    }
    if (result == null) result = synthError(new Error('runner resolved without a result'));
    usageAcc.observeResult(result); // last usage source (codex reason.usage & co)
    runSettled = true; // runner promise settled: the warn/hard windows are closed from here on
    const effCode = result.code === 'aborted' && hardTimedOut ? 'timeout' : result.code;
    switch (effCode) {
      case 'completed': {
        // Push carries the FULL text (the adapter chunks it, §6.7); a stream
        // final is capped at maxContentChars with the 会话页 pointer.
        // onOutbound runs on the final reply ONLY and eats the FULL text (a
        // distill marker at the tail must not be cut before extraction); the
        // FINAL frame then uses tail-keeping truncation so middleware tail
        // appendages (📊 footer) survive the cut; the product is masked
        // again — masking is ALWAYS on, even for middleware-injected text.
        const outCtx = {
          bot,
          usage: usageAcc.summary(),
          model: bot.providerConfig?.model?.model || 'unknown',
          durationMs: Date.now() - startedAt,
        };
        const base = maskFn(result.finalText || EMPTY_DONE_TEXT);
        const finalize = async (text) => maskFn(await runOnOutbound(text, outCtx));
        // 中间件契约（盲评 P1-2 及其回归修复）：中间件吃「全文」（蒸馏标记在
        // 尾部，先截断=沉淀静默丢失）；随后 FINAL 帧用「保尾截断」——中间件的
        // 尾部追加物（cost-tracker 的 📊 行）也要在通道帧里活着。
        if (backgroundMode && pushable) await sendPush(await finalize(base));
        else if (streaming) await sendProgress(truncateFinalKeepingTail(await finalize(base)), true);
        else await sendReply(truncateFinalKeepingTail(await finalize(base)));
        break;
      }
      case 'aborted': {
        const base = result.finalText ? outboundText(result.finalText) : '';
        // During a drain (global lifecycle, or THIS bot's reconnect/delete
        // swap) the abort cause is maintenance, not a newer message.
        const maintenance = engine.draining || engine._botDrains?.has(bot.id) === true;
        const text = maintenance
          ? (base ? `${base}\n\n${DRAIN_INFLIGHT_TEXT}` : DRAIN_INFLIGHT_TEXT)
          : (base ? `${base}\n\n${ABORT_BANNER}` : CANCEL_TEXT);
        await deliverFinal(text);
        break;
      }
      case 'timeout': {
        const base = result.finalText ? outboundText(result.finalText) + '\n\n' : '';
        await deliverFinal(base + outboundText(TIMEOUT_TEXT));
        break; // markDirty happens in bookkeep, after the upsert
      }
      case 'lock-conflict': {
        await sendReply(LOCK_TEXT); // 防线三 copy (§5.1)
        break;
      }
      case 'missing-credential': {
        await sendReply(outboundText(describeError(result)));
        break;
      }
      default: {
        if (result.finalText) await deliverFinal(`${outboundText(result.finalText)}\n\n${ERROR_BANNER}`);
        else await sendReply(outboundText(`❌ 任务未能完成：${describeError(result)}`));
      }
    }
  } finally {
    stopTimers();
    try {
      bookkeep(result);
    } catch (e) {
      // A bookkeeping failure (bad row, full disk...) must not mask the branch
      // handling above — but it is loudly an error.
      engine.log.error?.(`engine: bookkeeping failed for ${chatKey}: ${e?.stack ?? e}`);
    }
  }
}

export class Engine {
  constructor({
    log = noopLog,
    getRunner = null,
    getAdapter = null,
    ledgerFactory = null,
    timeline = null,
    progressor = null,
    middleware = null,
    limits = {},
    runTurnImpl = null,
    channelEventHandler = null,
    // Kernel bus bridge (M3 UI): (topic, payload) => void, wired by plugin.js
    // to ctx.events.emit so progress/status changes reach SSE clients. Null in
    // bare engine tests — every emit site is optional-chained.
    emit = null,
  } = {}) {
    if (limits.concurrency !== undefined
      && (!Number.isInteger(limits.concurrency) || limits.concurrency < 1)) {
      throw new Error(`limits.concurrency must be a positive integer, got ${JSON.stringify(limits.concurrency)}`);
    }
    for (const [name, fn] of [['getRunner', getRunner], ['getAdapter', getAdapter],
      ['ledgerFactory', ledgerFactory], ['runTurnImpl', runTurnImpl],
      ['channelEventHandler', channelEventHandler]]) {
      if (fn !== null && typeof fn !== 'function') {
        throw new Error(`${name} must be a function or null, got ${typeof fn}`);
      }
    }
    this.log = log;
    this.getRunner = getRunner;
    this.getAdapter = getAdapter;
    this.ledgerFactory = ledgerFactory;
    this.timeline = timeline;
    this.progressor = progressor;
    this.middleware = middleware;
    this.limits = { ...ENGINE_LIMITS, ...limits };
    this._runTurnImpl = runTurnImpl ?? defaultRunTurn;
    this.channelEventHandler = channelEventHandler;
    this.emit = emit;

    this.chains = new Map();    // chatKey → tail promise (settles when the chain goes idle)
    this.pending = new Map();   // chatKey → { bot, msg } merged-but-not-started (latest-wins)
    this.inFlight = new Map();  // chatKey → AbortController (pinned surface, Task 13 reads it)
    this._runs = new Map();     // chatKey → { ac, botId, usage?, durationMs? } — retired in lockstep with inFlight
    this._bots = new Map();     // botId → { bot, adapter, runner }; absent = offline
    this._progress = new Map(); // botId → { line, source, startedAt, updatedAt }
    this._lastRun = new Map();  // botId → { at, durationMs, usage } — last settled run (P2 roster fields)
    this._running = 0;          // turns occupying a gate slot right now
    this._waiters = [];         // FIFO of slot resolve callbacks (fairness across bots)
    this.draining = false;
    this._botDrains = new Set(); // botIds mid per-bot drain (reconnect/delete swap)
    this.drainRefusals = [];    // { bot, msg, reason } — Task 13/14 send refusal copy
    this._drainSeq = Promise.resolve(); // serializes drains (same pattern as reload)
    this._drainBusy = 0;        // drains queued+running; refusals reset only at 0
  }

  onMessage(bot, msg) {
    // Input validation comes FIRST, before the draining branch: junk (an
    // offline bot, a message without chatKey) is dropped by the normal rules
    // no matter the engine state — drainRefusals must carry only messages
    // that would otherwise have RUN, since Task 13 answers every refusal.
    if (!this._bots.has(bot?.id)) {
      this.log.warn?.(`engine: bot ${JSON.stringify(bot?.id)} is offline, dropping message`);
      return;
    }
    // chatKey is the identity of the serial chain — a message without one has
    // no defined semantics, so drop it loudly instead of corrupting the maps.
    if (typeof msg?.chatKey !== 'string' || msg.chatKey === '') {
      this.log.warn?.(`engine: dropping message without chatKey from bot ${bot.id}`);
      return;
    }
    // allowedUsers (DESIGN §6 step 1): a non-empty list is an allow-list —
    // anyone else is dropped. Checked with input validation, BEFORE the drain
    // branches: a stranger's message would never have run, so it must not
    // enter drainRefusals. Silent drop + warn, matching the predecessor
    // bridge's semantics: a courtesy reply would confirm the bot's existence
    // to a stranger, so the copy stays in the log only.
    if (Array.isArray(bot.allowedUsers) && bot.allowedUsers.length > 0
      && !bot.allowedUsers.includes(msg.userid)) {
      this.log.warn?.(`engine: reject message from non-allowed user ${JSON.stringify(msg.userid)} (bot ${bot.id}, chat ${msg.chatKey})`);
      return;
    }
    if (this.draining) {
      // Drain is short-lived (lifecycle reload / bot CRUD): refuse loudly and
      // keep the message for the refusal copy rather than queueing work the
      // drain just promised to finish.
      this.drainRefusals.push({ bot, msg, reason: 'draining' });
      this.log.warn?.(`engine draining: refused message for ${msg.chatKey}`);
      return;
    }
    if (this._botDrains.has(bot.id)) {
      // Per-bot drain (PATCH/toggle/DELETE, DESIGN §8 串行链 drain): THIS bot
      // is mid-swap; every other bot keeps running. Recorded like a global
      // drain's refusals — but the ENGINE never sends these: the CRUD caller
      // (api.js drainBotOf) replies to them before the old adapter dies.
      this.drainRefusals.push({ bot, msg, reason: 'draining' });
      this.log.warn?.(`engine: bot ${bot.id} draining (reconnect/delete), refused message for ${msg.chatKey}`);
      return;
    }
    const key = msg.chatKey;
    if (this.inFlight.has(key)) {
      // Preempt + queue merge. Aborting twice is a no-op by design: the third
      // message in a burst aborts the (already aborted) current turn and
      // REPLACES the second message in pending. The chain tail — never this
      // call — spawns the replacement, and only after the aborted turn's
      // promise fully settles (invariant 1).
      this.inFlight.get(key).abort();
      this.pending.set(key, { bot, msg });
      return;
    }
    // Nothing in flight: append a fresh link to the chain. The controller is
    // registered synchronously HERE (not inside the link) so a burst of
    // messages in the same tick still sees inFlight and merges correctly.
    const ac = new AbortController();
    this._registerRun(key, ac, bot.id);
    this._spawnLink(key, { bot, msg, ac });
  }

  attachBot(bot, { adapter = null, runner = null } = {}) {
    if (bot?.id == null) throw new Error('attachBot requires a bot with an id');
    this._bots.set(bot.id, { bot, adapter, runner });
    this.log.info?.(`engine: bot ${bot.id} attached`);
    this.emit?.('agent/status', { botId: bot.id, ...this._statusOf(bot.id) });
  }

  // Bots going offline (plugin disabled, credentials pulled...). In-flight
  // turns are NOT aborted here: lifecycle drains the engine first (drain);
  // detach only stops NEW work from being accepted.
  detachBot(botId, reason = 'unspecified') {
    const had = this._bots.delete(botId);
    this._progress.delete(botId);
    const line = `engine: bot ${botId} detached (${reason}) — messages dropped until reattach`;
    if (had) this.log.warn?.(line); else this.log.debug?.(line);
    this.emit?.('agent/status', { botId, status: 'offline', running: 0, progress: null, reason });
    return had;
  }

  // Channel events (DESIGN §4 评审补): enter_chat / disconnected / ... arrive
  // from a channel adapter through the per-bot facade. Return true when the
  // ENGINE fully handled the event — the channel then SKIPS its own default
  // behavior (e.g. the default enter_chat welcome); false/undefined → the
  // channel's fallback fires. channelEventHandler is the extension seam
  // (M1 core-engine only observes: no engine-side enter_chat copy yet).
  onChannelEvent(bot, ev) {
    const type = ev?.type ?? 'unknown';
    if (type === 'disconnected') {
      this.log.warn?.(`engine: bot ${JSON.stringify(bot?.id)} channel disconnected`);
    } else {
      this.log.info?.(`engine: channel event ${type} for bot ${JSON.stringify(bot?.id)}`);
    }
    if (typeof this.channelEventHandler === 'function') {
      try {
        return this.channelEventHandler(bot, ev) === true;
      } catch (e) {
        this.log.warn?.(`engine: channelEventHandler threw: ${e?.message ?? e}`);
      }
    }
    return false;
  }

  // Called by Task 13's runTurnImpl to refresh the status line. First call
  // for a bot stamps startedAt; later calls only bump updatedAt. UI bridge:
  // a CHANGED line/source emits agent/progress — heartbeats re-sending the
  // same line do not, so SSE carries semantic deltas, not noise.
  setProgress(botId, line, source = 'run') {
    const now = Date.now();
    const cur = this._progress.get(botId);
    if (cur) {
      const changed = cur.line !== line || cur.source !== source;
      cur.line = line;
      cur.source = source;
      cur.updatedAt = now;
      if (changed) this.emit?.('agent/progress', { botId, line, source, updatedAt: now });
      return;
    }
    this._progress.set(botId, { line, source, startedAt: now, updatedAt: now });
    this.emit?.('agent/progress', { botId, line, source, updatedAt: now });
  }

  // status(botId) → that bot; status() → aggregate with a bots[] array.
  // `running` counts turns registered but not yet fully settled — including
  // turns still waiting for a gate slot — because from the operator's view
  // the bot has live work either way.
  status(botId) {
    if (botId === undefined) {
      const bots = [...this._bots.values()].map(({ bot }) => this._statusOf(bot.id));
      return {
        status: bots.some((b) => b.status === 'working') ? 'working' : 'idle',
        running: bots.reduce((n, b) => n + b.running, 0),
        progress: null,
        bots,
      };
    }
    return this._statusOf(botId);
  }

  // Abort every in-flight turn, refuse everything queued (and everything
  // arriving while draining), then wait for all chain tails to settle —
  // bounded by timeoutMs (default 5s: an unbounded drain plus one hung run
  // would latch `draining` and brick the engine). Returns true when
  // everything settled in time, false on timeout (tails may keep settling
  // afterwards; the engine reopens for new messages either way). Task 13
  // layers the in-flight final frame on top of this; drainRefusals carries
  // what it must answer. Overlapping drains serialize (reload-style chain):
  // the second queues behind the first instead of interleaving aborts.
  drain(timeoutMs = DRAIN_DEFAULT_TIMEOUT_MS) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new Error(`drain requires a non-negative timeoutMs, got ${JSON.stringify(timeoutMs)}`);
    }
    // Refusals reset only at the start of a drain WINDOW (the first drain of
    // a batch): a follow-up drain queued behind an active one shares the
    // window and must not clobber refusals the first drain's caller has not
    // read yet.
    const firstOfWindow = this._drainBusy === 0;
    this._drainBusy++;
    if (firstOfWindow) this.drainRefusals = []; // synchronous, like the latch below
    // Latch SYNCHRONOUSLY: a message arriving in the same tick as drain()
    // (before the body's microtask) must already see draining=true and be
    // refused — otherwise it would preempt-merge into pending and survive.
    this.draining = true;
    const run = this._drainSeq.then(async () => {
      try {
        return await this._drainBody(timeoutMs);
      } finally {
        this._drainBusy--;
      }
    });
    // The chain swallows the result so a later drain never sees this one's
    // rejection as its own precondition (mirrors reload serialization).
    this._drainSeq = run.then(() => {}, () => {});
    return run;
  }

  async _drainBody(timeoutMs) {
    try {
      for (const [key, entry] of this.pending) {
        this.drainRefusals.push({ bot: entry.bot, msg: entry.msg, reason: 'pending' });
        this.pending.delete(key);
      }
      for (const ac of this.inFlight.values()) ac.abort();

      const tails = [...this.chains.values()];
      const allSettled = tails.length === 0
        ? Promise.resolve([])
        : Promise.allSettled(tails);
      // _drainBusy still counts THIS drain here, so "1" means no other drain
      // is queued or running: the window is over and the engine may reopen.
      return await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        allSettled.then(() => { clearTimeout(timer); resolve(true); });
      });
    } finally {
      if (this._drainBusy === 1) this.draining = false;
    }
  }

  // Per-bot drain (DESIGN §8 校验→materialize→串行链 drain→重连): abort the
  // bot's in-flight turns, clear its queued messages (recorded as refusals)
  // and await its chains — WITHOUT latching the global draining flag, so
  // other bots' traffic is untouched. A per-bot latch refuses messages
  // arriving mid-swap for THIS bot only, and the abort copy stays the
  // maintenance line. The pending sweep and aborts run synchronously at call
  // time (same-tick determinism as drain's latch). The recorded refusals are
  // the CALLER's to answer (api.js drainBotOf replies before the adapter
  // swap; the engine's global drain window RESETS the list, so leaving them
  // here would silently drop them). Bounded like drain(): a run ignoring its
  // abort cannot wedge the swap. Returns true when the bot's chains settled
  // in time, false on timeout.
  drainBot(botId, timeoutMs = DRAIN_DEFAULT_TIMEOUT_MS) {
    if (typeof botId !== 'string' || botId === '') {
      throw new Error(`drainBot requires a non-empty bot id, got ${JSON.stringify(botId)}`);
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new Error(`drainBot requires a non-negative timeoutMs, got ${JSON.stringify(timeoutMs)}`);
    }
    this._botDrains.add(botId); // synchronous: same-tick messages for this bot are refused
    const run = (async () => {
      try {
        for (const [key, entry] of [...this.pending]) {
          if (entry.bot?.id !== botId) continue;
          this.drainRefusals.push({ bot: entry.bot, msg: entry.msg, reason: 'draining' });
          this.pending.delete(key);
        }
        // _runs is keyed by chatKey with the owning botId: it covers every
        // chat this bot has live (registered) work in, including turns still
        // waiting for a gate slot.
        const keys = [...this._runs].filter(([, r]) => r.botId === botId).map(([key]) => key);
        for (const key of keys) this.inFlight.get(key)?.abort();
        // The chain tail covers the whole link (current run + any pickups);
        // pending is already swept, so a settling chain finds nothing queued.
        const tails = keys.map((key) => this.chains.get(key)).filter(Boolean);
        const allSettled = tails.length === 0
          ? Promise.resolve([])
          : Promise.allSettled(tails);
        return await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), timeoutMs);
          allSettled.then(() => { clearTimeout(timer); resolve(true); });
        });
      } finally {
        this._botDrains.delete(botId);
      }
    })();
    return run;
  }

  // Task 13: answer every message a drain refused (T12 parked them here).
  // Lifecycle calls this after drain() resolves; ownership transfers on call
  // so a second call can never double-send. Pending turns were never acked,
  // so the honest channel is a plain reply, not a stream frame.
  async sendDrainRefusals() {
    const refusals = this.drainRefusals;
    this.drainRefusals = [];
    for (const { bot, msg } of refusals) {
      try {
        const adapter = this.getAdapter?.(bot);
        if (adapter?.reply) await sendWithTimeout(adapter.reply(msg.reqId, DRAIN_REFUSAL_TEXT), this.limits.outboundTimeoutMs);
        else this.log.warn?.(`engine: no adapter to answer the drain refusal for ${msg.chatKey}`);
      } catch (e) {
        this.log.error?.(`engine: drain refusal reply failed: ${e?.message ?? e}`);
      }
    }
  }

  // —— internal: chain machinery ————————————————————————————————————————

  async _runTurn(bot, msg, ac) {
    // The single seam Task 13 fills: everything a turn does (ack, session
    // resolve, provider run, outbound, recordTurn) happens inside impl, so
    // "impl resolved" is exactly "turn fully settled" for chain purposes.
    await this._runTurnImpl.call(this, bot, msg, ac);
  }

  _spawnLink(key, first) {
    const prev = this.chains.get(key) ?? Promise.resolve();
    // Links never reject: _chainStep catches inside _runOne, so a floating
    // tail can never become an unhandled rejection.
    const link = prev.then(() => this._chainStep(key, first)).then(() => {
      // Idle chain: drop the tail so the map does not grow with chat count.
      // Compare against `link` — a newer message may have appended its own
      // link already, and deleting THAT one would corrupt the chain.
      if (this.chains.get(key) === link) this.chains.delete(key);
    });
    this.chains.set(key, link);
  }

  // Run `first`, then drain the merged queue one latest-wins message at a
  // time. Each pickup registers its controller synchronously (before any
  // await) so a message bursting in mid-pickup still sees inFlight and
  // merges instead of appending a parallel link.
  async _chainStep(key, first) {
    await this._runGuarded(first.bot, first.msg, first.ac);
    for (;;) {
      const next = this.pending.get(key);
      if (!next) return;
      this.pending.delete(key);
      const ac = new AbortController();
      this._registerRun(key, ac, next.bot.id);
      await this._runGuarded(next.bot, next.msg, ac);
    }
  }

  async _runGuarded(bot, msg, ac) {
    const key = msg.chatKey;
    try {
      await this._acquireSlot();
      // Abort-before-start: the turn was preempted (or drained) while it sat
      // in inFlight — possibly before it ever got a gate slot. Spawning a
      // subprocess just to kill it helps nobody; the merged replacement or
      // the drain refusal copy is already queued.
      if (!ac.signal.aborted) {
        await this._runTurn(bot, msg, ac);
      } else {
        this.log.debug?.(`engine: ${key} turn replaced before start (skipped)`);
      }
    } catch (e) {
      // A throwing impl must never wedge the chain: log, settle, move on.
      this.log.error?.(`engine: turn for ${key} failed: ${e?.stack ?? e}`);
    } finally {
      this._retireInFlight(key, ac);
      this._releaseSlot();
    }
  }

  _registerRun(key, ac, botId) {
    // Overwrite is safe by construction: callers only register when no live
    // run owns the key (onMessage checked inFlight; pickups happen after the
    // previous turn retired).
    const wasWorking = [...this._runs.values()].some((r) => r.botId === botId);
    this.inFlight.set(key, ac);
    this._runs.set(key, { ac, botId });
    if (!this._progress.has(botId)) this.setProgress(botId, null, 'run');
    // idle→working transition (this bot's first live run): one status frame.
    if (!wasWorking) {
      this.emit?.('agent/status', { botId, ...this._statusOf(botId) });
      // UI bridge (§8 SSE run/*): same transition, run-scoped frame. usage is
      // honestly null at start (nothing measured yet) so consumers can key on
      // its presence; run/end carries the settled values.
      this.emit?.('run/start', { botId, chatKey: key, usage: null, durationMs: 0 });
      this.timeline?.push({ botId, chatKey: key, kind: 'run_start', text: '' });
    }
  }

  // Compare-and-delete (invariant 3): remove the registration ONLY when the
  // controller is still our own. A stale/late cleanup of an older turn must
  // leave the newer turn's controller untouched.
  _retireInFlight(key, ac) {
    if (this.inFlight.get(key) !== ac) return;
    this.inFlight.delete(key);
    const run = this._runs.get(key);
    this._runs.delete(key);
    if (run && ![...this._runs.values()].some((r) => r.botId === run.botId)) {
      this._progress.delete(run.botId); // bot's last live turn ended: no stale progress line
      // working→idle transition (the bot's last live turn settled).
      this.emit?.('agent/status', { botId: run.botId, ...this._statusOf(run.botId) });
      // UI bridge (§8 SSE run/*): run-scoped counterpart of run/start; usage/
      // durationMs are what defaultRunTurn stamped via _noteRunMetrics (null
      // when the impl never reported — custom impls keep the old shape).
      this.emit?.('run/end', {
        botId: run.botId, chatKey: key,
        usage: run.usage ?? null, durationMs: run.durationMs ?? null,
      });
      this.timeline?.push({ botId: run.botId, chatKey: key, kind: 'run_end', text: '' });
    }
  }

  // Run metrics (P2 observability): defaultRunTurn stamps the settled run's
  // usage/duration here — onto the LIVE run record (feeds the run/end SSE
  // frame) and the per-bot last-run map (feeds /api/agents lastDurationMs).
  // bookkeep calls this FIRST, before anything that might throw.
  _noteRunMetrics(key, botId, { usage, durationMs }) {
    const rec = this._runs.get(key);
    if (rec != null) {
      rec.usage = usage;
      rec.durationMs = durationMs;
    }
    this._lastRun.set(botId, { at: Date.now(), durationMs, usage });
  }

  // Last settled run of a bot (P2): { at, durationMs, usage } copy or null
  // when it never ran (roster answers lastDurationMs=null then).
  lastRunOf(botId) {
    const r = this._lastRun.get(botId);
    return r == null ? null : { ...r, usage: { ...r.usage } };
  }

  // —— internal: global concurrency gate ————————————————————————————————

  // Never rejects: the waiter promise only ever resolves (direct handoff),
  // so _runGuarded's finally can release unconditionally without underflow.
  async _acquireSlot() {
    if (this._running < this.limits.concurrency) {
      this._running++;
      return;
    }
    await new Promise((resolve) => { this._waiters.push(resolve); });
  }

  _releaseSlot() {
    const wake = this._waiters.shift(); // FIFO: one bot cannot starve another
    if (wake) {
      // Direct handoff: the slot moves to the waiter without returning to
      // the pool, so nothing can squeeze past the cap between release and
      // wakeup, and _running keeps meaning "turns holding a slot".
      wake();
    } else {
      this._running--;
    }
  }

  _statusOf(botId) {
    const attached = this._bots.has(botId);
    let running = 0;
    for (const r of this._runs.values()) if (r.botId === botId) running++;
    return {
      status: !attached ? 'offline' : running > 0 ? 'working' : 'idle',
      running,
      progress: this._progress.has(botId) ? { ...this._progress.get(botId) } : null,
    };
  }
}
