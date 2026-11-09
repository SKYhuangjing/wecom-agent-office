// SessionCache: per-(chatKey, provider) session bookkeeping (DESIGN §3) and
// the consumedSeq state machine of DESIGN §7. One in-memory object, mutated
// synchronously, persisted through atomicWrite after every mutation — never a
// read-modify-write across an await (that is how updates get lost).
//
// Persisted shape (DESIGN §3, extended with per-entry dirty + lastAt):
//   { [chatKey]: { current, dirty, cache: { [provider]: {
//       sessionId, bornCwd, consumedSeq, consumedAtBuild, dirty, lastAt } } } }
// `dirty` lives on the provider entry (only that session was killed); the
// chatKey-level `dirty` mirrors the CURRENT provider's entry so the record
// shape stays the one DESIGN §3 documents. `lastAt` (ms epoch) stamps every
// upsert — the engine's TTL retirement (DESIGN-TOKEN-OPT §4.4) reads it.
//
// The ledger is injected (constructor, recompute, or replay opts) because
// handoffReplay must read it; the cache never owns ledger state itself.
import { existsSync } from 'node:fs';
import { atomicWrite, readJson } from '../../src/kernel/config.js';
import { formatTurnBlock } from './ledger.js';

export class SessionCache {
  constructor({ file, log, ledger = null }) {
    this.file = file;
    this.log = log;
    this._ledger = ledger;
    const data = readJson(file);
    if (data == null && existsSync(file)) {
      // An existing but unreadable cache means a pre-atomicWrite crash or
      // manual damage: sessions rebuild via handoff, but say it loudly.
      this.log?.warn?.(`session cache unreadable, starting empty: ${file}`);
    }
    this._data = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  }

  // Deep copy: callers must not be able to mutate the in-memory state (or
  // bypass the persist discipline) through the returned record.
  get(chatKey) {
    const rec = this._data[chatKey];
    return rec ? structuredClone(rec) : undefined;
  }

  // Rule 1: building the handoff prefix and persisting the new sessionId are
  // ONE atomic write — the prefix physically entered the session at this
  // moment, so consumedSeq is maxSeq-at-build regardless of how the run ends.
  upsert(chatKey, provider, session, consumedSeq) {
    if (typeof session?.sessionId !== 'string' || session.sessionId === '') {
      throw new Error('upsert requires a non-empty sessionId');
    }
    if (typeof session?.bornCwd !== 'string') throw new Error('upsert requires a bornCwd string');
    if (!Number.isInteger(consumedSeq) || consumedSeq < 0) {
      throw new Error('consumedSeq must be a non-negative integer');
    }
    const rec = this._rec(chatKey);
    rec.current = provider;
    rec.dirty = false; // fresh session is clean by definition
    rec.cache[provider] = {
      sessionId: session.sessionId,
      bornCwd: session.bornCwd,
      consumedSeq,
      consumedAtBuild: consumedSeq,
      dirty: false,
      lastAt: Date.now(), // TTL 退役判据（DESIGN-TOKEN-OPT §4.4）
    };
    this._persist();
  }

  // TTL 退役（DESIGN-TOKEN-OPT §4.4）：删除该 provider 的会话条目，下一次
  // 轮次从全新会话开始。注意与 markDirty 的语义差：不落 dirty（会话本身
  // 没坏，只是过期），也不触碰其他 provider 的条目；旧会话文件留在
  // provider 侧不动（远期归档/L3 检索候选）。返回是否有条目被删。
  expire(chatKey, provider) {
    const rec = this._data[chatKey];
    if (!rec?.cache?.[provider]) return false;
    delete rec.cache[provider];
    if (rec.current === provider) {
      rec.current = null;
      rec.dirty = false;
    }
    this._persist();
    return true;
  }

  // Rule 2: advance only — a stale/lower seq must never erase progress
  // (double delivery is the bug this whole protocol exists to prevent).
  setConsumed(chatKey, provider, seq) {
    if (!Number.isInteger(seq)) throw new Error(`setConsumed: seq must be an integer, got ${typeof seq}`);
    const entry = this._data[chatKey]?.cache?.[provider];
    if (!entry || seq <= entry.consumedSeq) return; // nothing cached here yet: no-op
    entry.consumedSeq = seq;
    this._persist();
  }

  // Marks one provider's session as killed/dirty (timeout, hard kill): the
  // engine must self-handoff instead of resuming a half-written session.
  markDirty(chatKey, provider) {
    const rec = this._data[chatKey];
    const entry = rec?.cache?.[provider];
    if (!entry) return;
    entry.dirty = true;
    if (rec.current === provider) rec.dirty = true;
    this._persist();
  }

  // TTL 判据刷新（盲评 P1-1）：lastAt 语义=「距上一轮」，不是「会话创建年龄」。
  // 原生续会话（--resume 同一 sessionId）不会走 upsert，若只在 upsert 盖戳，
  // 活跃对话也会在启动 45 分钟后被强制退役。每个 SETTLED 轮次 touch 一次。
  touch(chatKey, provider) {
    const entry = this._data[chatKey]?.cache?.[provider];
    if (!entry) return false; // 没有会话不创造（fresh 会话由 upsert 负责）
    entry.lastAt = Date.now();
    this._persist();
    return true;
  }

  setCurrent(chatKey, provider) {
    const rec = this._rec(chatKey);
    rec.current = provider;
    rec.dirty = rec.cache[provider]?.dirty === true;
    this._persist();
  }

  // Rule 3: the ledger is authoritative. After a crash between recordTurn and
  // the cache persist, max(stored, ledger) wins and the drift is warned —
  // silent healing here would hide real durability bugs.
  recompute(ledger) {
    if (ledger) this._ledger = ledger;
    if (!this._ledger) throw new Error('recompute requires a ledger (pass one to the constructor or to recompute)');
    let changed = false;
    for (const [chatKey, rec] of Object.entries(this._data)) {
      for (const [provider, entry] of Object.entries(rec.cache ?? {})) {
        const truth = this._ledger.maxSeq({ chatKey, provider });
        if (truth > (entry.consumedSeq ?? 0)) {
          this.log?.warn?.(`consumedSeq drift: ${chatKey}/${provider} cache=${entry.consumedSeq ?? 0} ledger=${truth} — overriding from ledger`);
          entry.consumedSeq = truth;
          changed = true;
        }
      }
    }
    if (changed) this._persist(); // one write for the whole sweep
    return changed;
  }

  // Rule 4: replay only what the prefix does not already contain. Returns
  // null when this provider has no cached session (full handoff, not replay).
  handoffReplay(chatKey, provider, { maxTurns = 10, maxChars = 8000, ledger } = {}) {
    const entry = this._data[chatKey]?.cache?.[provider];
    if (!entry) return null;
    const ldg = ledger ?? this._ledger;
    if (!ldg) throw new Error('handoffReplay requires a ledger (constructor, recompute, or opts)');
    // The chatKey filter is MANDATORY: seq is a per-bot global counter, so an
    // unfiltered query would leak other chats' turns into this handoff.
    const candidates = ldg.turns({ chatKey, since: entry.consumedSeq ?? 0 });
    // Window newest-first (same 10-turn/8000-char budget as the prefix; budget
    // chars with the same block format), then reverse to chronological order.
    const picked = [];
    let chars = 0;
    for (let i = candidates.length - 1; i >= 0 && picked.length < maxTurns; i--) {
      const len = formatTurnBlock(candidates[i]).length;
      const next = picked.length === 0 ? len : chars + 2 + len; // '\n\n' separator
      // Always keep the newest row even alone over budget — an empty replay
      // would loop forever on a single oversized turn.
      if (picked.length > 0 && next > maxChars) break;
      chars = next;
      picked.push(candidates[i]);
    }
    picked.reverse();
    // consumedUpTo is the last row ACTUALLY delivered: the engine advances
    // consumedSeq to this (and only this) value once the replay went out —
    // dropped rows must stay unconsumed for the next handoff.
    return { rows: picked, consumedUpTo: picked.length ? picked[picked.length - 1].seq : 0 };
  }

  _rec(chatKey) {
    return this._data[chatKey] ??= { current: null, dirty: false, cache: {} };
  }

  _persist() {
    atomicWrite(this.file, `${JSON.stringify(this._data, null, 2)}\n`);
  }
}
