// Timeline: in-memory event ring buffer (DESIGN §3) backing SSE and
// GET /api/timeline. Two bounding rules keep it a *bounded* structure:
//   - capacity: a fixed-size ring — a full ring overwrites the OLDEST row
//     (O(1), never an Array#shift sweep), so a runaway bot cannot grow it;
//   - time: reads drop rows older than the window (default 30min, DESIGN §8).
//
// In-memory only, never persisted: the ledger is the durable record; this
// buffer exists so the UI can poll recent activity without touching disk.
//
// Rows come back in chronological order (sorted by `at`, stable — equal
// timestamps keep insertion order). get() returns shallow copies: callers
// must not be able to corrupt ring contents through a read.

// The closed event-kind set from the unified event mapping (DESIGN §5.1).
// Unknown kinds are a provider-mapping bug; rejecting beats storing junk
// the UI would render as an unknown row forever.
const KINDS = new Set(['run_start', 'step', 'tool', 'thinking', 'turn', 'run_end']);

export class Timeline {
  constructor({ windowMs = 30 * 60_000, cap = 2000 } = {}) {
    if (!Number.isInteger(cap) || cap < 1) {
      throw new Error(`cap must be a positive integer, got ${JSON.stringify(cap)}`);
    }
    if (!Number.isFinite(windowMs) || windowMs < 0) {
      throw new Error(`windowMs must be a non-negative number, got ${JSON.stringify(windowMs)}`);
    }
    this._windowMs = windowMs;
    this._cap = cap;
    this._buf = new Array(cap);
    this._head = 0; // slot of the oldest row (meaningful once _len > 0)
    this._len = 0;
  }

  push({ botId, chatKey, kind, text, at } = {}) {
    if (typeof botId !== 'string' || botId === '') {
      throw new Error(`push requires a non-empty botId, got ${JSON.stringify(botId)}`);
    }
    if (typeof chatKey !== 'string' || chatKey === '') {
      throw new Error(`push requires a non-empty chatKey, got ${JSON.stringify(chatKey)}`);
    }
    if (!KINDS.has(kind)) {
      throw new Error(`invalid kind ${JSON.stringify(kind)} (expected ${[...KINDS].join('|')})`);
    }
    if (at !== undefined && (typeof at !== 'number' || !Number.isFinite(at))) {
      throw new Error(`at must be an epoch-ms number when given, got ${JSON.stringify(at)}`);
    }
    const row = { botId, chatKey, kind, text: text ?? '', at: at ?? Date.now() };
    if (this._len < this._cap) {
      this._buf[(this._head + this._len) % this._cap] = row;
      this._len++;
    } else {
      // Ring full: the new row takes the oldest slot and the head moves on.
      this._buf[this._head] = row;
      this._head = (this._head + 1) % this._cap;
    }
  }

  // windowMs given here overrides the constructor default for THIS read
  // only; the instance default is never mutated.
  get({ botId, windowMs } = {}) {
    const cutoff = Date.now() - (windowMs ?? this._windowMs);
    const rows = [];
    for (let i = 0; i < this._len; i++) {
      const row = this._buf[(this._head + i) % this._cap];
      if (row.at < cutoff) continue;
      if (botId !== undefined && row.botId !== botId) continue;
      rows.push({ ...row });
    }
    // Providers emit ordered events, so this is usually already sorted; the
    // stable sort only fixes injected/backdated timestamps and costs nothing.
    rows.sort((a, b) => a.at - b.at);
    return rows;
  }
}
