// Ledger: append-only NDJSON turn journal (DESIGN §3) and handoff-prefix
// builder (DESIGN §7). This file is the single point where the consumedSeq
// protocol's ground truth lives: seq is a per-bot globally increasing counter,
// and every handoff/replay decision downstream derives from these rows.
//
// Durability rules (DESIGN §3 落盘规约):
//  - recordTurn appends SYNCHRONOUSLY; seq allocation and append never
//    straddle an await, so a crash can lose at most the row, never order.
//  - boot recovery scans max(seq) over ALL lines — never the last line —
//    because a torn/reordered file must not resurrect already-used seqs.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const REASONS = new Set(['completed', 'interrupted', 'timeout', 'error']);
// Every §3 field a row must carry; seq/at are excluded because recordTurn
// owns them (callers pass nextSeq()'s value or nothing).
const REQUIRED = ['chatKey', 'channel', 'chatKind', 'chatid', 'userid', 'user',
  'assistant', 'provider', 'sessionId', 'ok', 'reason', 'tokens', 'cost'];

// One QA block as injected into handoff prefixes and counted against the char
// budget. Exported so SessionCache.replay budgets rows with the SAME format —
// two private formulas would drift apart silently.
export function formatTurnBlock(row) {
  // An empty assistant (interrupted/timeout rows carry partial or no text)
  // is still context: mark it unfinished rather than dropping the turn.
  const assistant = row.assistant == null || row.assistant === '' ? '(未完成)' : row.assistant;
  return `用户: ${row.user}\n助手: ${assistant}`;
}

export class Ledger {
  constructor({ file, log }) {
    this.file = file;
    this.log = log;
    this._seq = 0; // highest seq ever handed out; nextSeq() pre-increments
    mkdirSync(dirname(file), { recursive: true }); // first boot: data/ledger/ may not exist
    if (existsSync(file)) {
      for (const row of parseLines(readFileSync(file, 'utf8'), log)) {
        if (Number.isInteger(row.seq) && row.seq > this._seq) this._seq = row.seq;
      }
    }
  }

  nextSeq() { return ++this._seq; }

  recordTurn(rec) {
    // Reject rather than silently pad: a row missing §3 fields would corrupt
    // every downstream query (history pages, handoffs, replay) for ever.
    const missing = REQUIRED.filter(k => rec[k] === undefined);
    if (missing.length) throw new Error(`ledger row missing fields: ${missing.join(',')}`);
    if (!REASONS.has(rec.reason)) {
      throw new Error(`invalid reason ${JSON.stringify(rec.reason)} (expected ${[...REASONS].join('|')})`);
    }
    if (typeof rec.ok !== 'boolean') throw new Error(`ok must be boolean, got ${typeof rec.ok}`);
    const row = {
      ...rec,
      seq: Number.isInteger(rec.seq) ? rec.seq : this.nextSeq(),
      at: rec.at ?? Date.now(),
    };
    // Keep the counter monotonic even when a caller supplies its own seq,
    // so a later nextSeq() can never collide with an appended row.
    if (row.seq > this._seq) this._seq = row.seq;
    appendFileSync(this.file, `${JSON.stringify(row)}\n`);
    return row.seq;
  }

  // Reads are always from disk: the file is the authority (rule 3), and a
  // second Ledger instance on the same file (tests, recovery flows) must be
  // visible immediately. `since` is an EXCLUSIVE floor (seq > since).
  turns({ chatKey, provider, since, limit } = {}) {
    if (!existsSync(this.file)) return [];
    const rows = parseLines(readFileSync(this.file, 'utf8'), this.log)
      .filter(r => (chatKey === undefined || r.chatKey === chatKey)
        && (provider === undefined || r.provider === provider)
        && (since === undefined || r.seq > since));
    return limit === undefined ? rows : rows.slice(0, limit);
  }

  // 0 when nothing matches. Counts EVERY row regardless of reason: rule 2 —
  // interrupted/timeout/error turns are real history the prefix may contain.
  maxSeq({ chatKey, provider } = {}) {
    let max = 0;
    for (const r of this.turns({ chatKey, provider })) if (r.seq > max) max = r.seq;
    return max;
  }

  buildHandoffPrefix({ chatKey, maxTurns = 10, maxChars = 8000 } = {}) {
    const blocks = this.turns({ chatKey }).slice(-maxTurns).map(formatTurnBlock);
    // A handoff carries the chat's history across ALL providers — switching
    // back must see what the other provider answered meanwhile.
    if (blocks.length === 0) return ''; // nothing to carry: no misleading header
    const intro = '以下是本对话此前的记录（供上下文参考）：';
    const omission = '…(更早记录已省略)';
    let omitted = false;
    const compose = () => intro + '\n\n' + (omitted ? `${omission}\n\n` : '') + blocks.join('\n\n');
    let text = compose();
    // Over the char budget: drop the OLDEST blocks first (they are the least
    // relevant) and say so — the receiving model must know history existed.
    // The turn window above is silent by design; only char loss gets the note.
    while (text.length > maxChars && blocks.length > 1) {
      blocks.shift();
      omitted = true;
      text = compose();
    }
    return text;
  }
}

// Tolerant NDJSON parse: a crash mid-append can leave a torn trailing line;
// skipping it (loudly in debug) beats refusing to boot on the journal.
function parseLines(text, log) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch { log?.debug?.('ledger: skipping unparseable line'); }
  }
  return rows;
}
