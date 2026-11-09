// Memory distillation (DESIGN-TOKEN-OPT §4.3): the write-back half of the
// FAQ-sedimentation loop. Providers inject a footer into every materialized
// memory section instructing the model to end durable replies with
// `<!--wao-memory:问题关键词 → 结论-->` lines; this middleware — registered
// by core-engine alongside maskOutbound — strips those lines from the
// outbound text (the protocol must NEVER reach a human reader, even when no
// memory asset is bound) and appends them as notes into the bot's first
// bound memory asset via the SAME updateAssetOp the REST PATCH uses, so the
// eager fan-out rematerialization (§3.2) picks them up on the next turn.
//
// Failure discipline: the engine's onOutbound chain already isolates a
// throwing middleware (warn + continue, engine.js), so a failed write-back
// degrades to "marker stripped, note lost" — never a lost reply.
const MARKER_LINE_RE = /^[ \t]*<!--[ \t]*wao-memory[ \t]*:(.*?)[ \t]*-->[ \t]*$/;

// Per-asset schema limits (assets.js LIMITS): ≤50 notes, ≤2KB each. The
// extractor truncates defensively so a chatty model can never produce an
// asset PATCH that fails validation.
export const DISTILL_MAX_NOTES = 50;
export const DISTILL_MAX_NOTE_CHARS = 2 * 1024;

// extractMemoryUpdates(text) → { cleanText, entries }
// Strips every marker line (wherever it sits), collects payloads in order,
// and collapses the blank-run the removal may leave at the tail.
export function extractMemoryUpdates(text) {
  if (typeof text !== 'string' || !text.includes('wao-memory')) {
    return { cleanText: text, entries: [] };
  }
  const entries = [];
  const keptLines = [];
  for (const line of text.split('\n')) {
    const m = MARKER_LINE_RE.exec(line);
    if (m == null) { keptLines.push(line); continue; }
    const payload = m[1].trim().slice(0, DISTILL_MAX_NOTE_CHARS);
    if (payload !== '') entries.push(payload);
  }
  let cleanText = keptLines.join('\n');
  // a marker-only tail leaves dangling separators — trim trailing blank
  // lines the strip created, but never eat meaningful trailing structure
  // beyond one newline pair.
  cleanText = cleanText.replace(/(?:\n[ \t]*)+\n?$/, (tail) => (tail.includes('\n\n') ? '\n' : tail));
  return { cleanText, entries };
}

const normalizeNote = (n) => String(n ?? '').replace(/\s+/g, ' ').trim();

// mergeMemoryNotes(existingNotes, entries) → { notes, added, droppedOldest }
// Append-only with exact-dedupe on normalized text; when the asset is full
// the OLDEST notes make room (LRU by list order — binding order renders
// notes top-down, so the front is both oldest-read and first out).
export function mergeMemoryNotes(existingNotes, entries, { maxNotes = DISTILL_MAX_NOTES } = {}) {
  const notes = Array.isArray(existingNotes) ? existingNotes.map(String) : [];
  const seen = new Set(notes.map(normalizeNote));
  let added = 0;
  let droppedOldest = 0;
  for (const entry of entries) {
    const key = normalizeNote(entry);
    if (key === '' || seen.has(key)) continue;
    while (notes.length >= maxNotes) {
      const evicted = notes.shift();
      seen.delete(normalizeNote(evicted));
      droppedOldest++;
    }
    // store the NORMALIZED form — dedupe key and stored note stay identical
    // (a note rendered in CLAUDE.md is for the model, leading blanks buy
    // nothing but diff noise).
    notes.push(key);
    seen.add(key);
    added++;
  }
  return { notes, added, droppedOldest };
}

// createDistillMiddleware({ findMemoryAsset, updateNotes, log }) → the impl
// registered on the middleware port. findMemoryAsset(bot) → asset record or
// null; updateNotes(assetId, notes) → persistence (updateAssetOp shape).
export function createDistillMiddleware({ findMemoryAsset, updateNotes, log } = {}) {
  return {
    async onOutbound(text, ctx) {
      if (typeof text !== 'string' || !text.includes('wao-memory')) return text;
      const bot = ctx?.bot;
      const { cleanText, entries } = extractMemoryUpdates(text);
      if (entries.length === 0) return cleanText;
      if (typeof findMemoryAsset !== 'function' || typeof updateNotes !== 'function') return cleanText;
      const asset = bot == null ? null : findMemoryAsset(bot);
      if (asset == null) {
        log?.warn?.(`distill: bot ${bot?.id ?? '?'} 输出了 ${entries.length} 条沉淀标记但未绑定 memory 资产——已剥离丢弃`);
        return cleanText;
      }
      const merged = mergeMemoryNotes(asset.content?.notes, entries);
      if (merged.added === 0) return cleanText;
      await updateNotes(asset.id, merged.notes);
      log?.info?.(`distill: +${merged.added} 条记忆 → ${asset.id}（现存 ${merged.notes.length} 条${merged.droppedOldest > 0 ? `，LRU 淘汰 ${merged.droppedOldest} 条最旧` : ''}）`);
      return cleanText;
    },
  };
}
