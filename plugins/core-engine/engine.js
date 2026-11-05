// Engine: core-engine's concurrency core (DESIGN §6 串行链, review-pinned).
// This file owns WHEN a run starts, WHEN it is preempted and WHEN the chain
// picks up the next message — the turn body itself (ack / two-phase / code
// branches / recordTurn) is injected as runTurnImpl and lands in Task 13.
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

// Channel-capability defaults (DESIGN §4/§6). minIntervalMs/maxContentChars/
// streamDeadlineMs etc. are consumed by the outbound path (Task 13) and the
// adapters — the engine itself only enforces `concurrency` today.
export const ENGINE_LIMITS = Object.freeze({
  concurrency: 4,
  minIntervalMs: 2200,
  heartbeatMs: 20000,
  maxContentChars: 3500,
  streamDeadlineMs: 600000,
  hardTimeoutMs: 1800000,
  warnLeadMs: 90000,
  outboundBudgetPerMin: 28,
});

// Task 13 replaces this with the real turn orchestration via { runTurnImpl }.
const noopRunTurn = async () => {};

// Lifecycle Phase-0 drain cap: a drain must never be able to wait forever —
// one hung run (an impl that ignores its abort signal) would otherwise leave
// `draining` latched and the engine refusing every message permanently.
const DRAIN_DEFAULT_TIMEOUT_MS = 5000;

const noopLog = Object.freeze({
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
});

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
  } = {}) {
    if (limits.concurrency !== undefined
      && (!Number.isInteger(limits.concurrency) || limits.concurrency < 1)) {
      throw new Error(`limits.concurrency must be a positive integer, got ${JSON.stringify(limits.concurrency)}`);
    }
    for (const [name, fn] of [['getRunner', getRunner], ['getAdapter', getAdapter],
      ['ledgerFactory', ledgerFactory], ['runTurnImpl', runTurnImpl]]) {
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
    this._runTurnImpl = runTurnImpl ?? noopRunTurn;

    this.chains = new Map();    // chatKey → tail promise (settles when the chain goes idle)
    this.pending = new Map();   // chatKey → { bot, msg } merged-but-not-started (latest-wins)
    this.inFlight = new Map();  // chatKey → AbortController (pinned surface, Task 13 reads it)
    this._runs = new Map();     // chatKey → { ac, botId } — retired in lockstep with inFlight
    this._bots = new Map();     // botId → { bot, adapter, runner }; absent = offline
    this._progress = new Map(); // botId → { line, source, startedAt, updatedAt }
    this._running = 0;          // turns occupying a gate slot right now
    this._waiters = [];         // FIFO of slot resolve callbacks (fairness across bots)
    this.draining = false;
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
    if (this.draining) {
      // Drain is short-lived (lifecycle reload / bot CRUD): refuse loudly and
      // keep the message for the refusal copy rather than queueing work the
      // drain just promised to finish.
      this.drainRefusals.push({ bot, msg, reason: 'draining' });
      this.log.warn?.(`engine draining: refused message for ${msg.chatKey}`);
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
  }

  // Bots going offline (plugin disabled, credentials pulled...). In-flight
  // turns are NOT aborted here: lifecycle drains the engine first (drain);
  // detach only stops NEW work from being accepted.
  detachBot(botId, reason = 'unspecified') {
    const had = this._bots.delete(botId);
    this._progress.delete(botId);
    const line = `engine: bot ${botId} detached (${reason}) — messages dropped until reattach`;
    if (had) this.log.warn?.(line); else this.log.debug?.(line);
    return had;
  }

  // Called by Task 13's runTurnImpl to refresh the status line. First call
  // for a bot stamps startedAt; later calls only bump updatedAt.
  setProgress(botId, line, source = 'run') {
    const now = Date.now();
    const cur = this._progress.get(botId);
    if (cur) {
      cur.line = line;
      cur.source = source;
      cur.updatedAt = now;
      return;
    }
    this._progress.set(botId, { line, source, startedAt: now, updatedAt: now });
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
    this.inFlight.set(key, ac);
    this._runs.set(key, { ac, botId });
    if (!this._progress.has(botId)) this.setProgress(botId, null, 'run');
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
    }
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
