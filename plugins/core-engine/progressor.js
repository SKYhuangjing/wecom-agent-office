// Default progressor (DESIGN §6.1): turns the unified event stream (§5) into
// ONE human-readable progress line per event — the thing WeCom users watch
// while an agent runs. Three stateful behaviors make the line readable rather
// than jumpy:
//   - HYSTERESIS: once the answer text exists and is growing, thinking must
//     not steal the line back (前身「无正文才显 thinking」语义) — alternating
//     lines read as flicker. The latch is armed by any text event with a
//     non-empty answer, or by the compose ctx carrying one.
//   - SENTENCE CACHE: a thinking chunk with no sentence-ending punctuation
//     falls back to the last COMPLETE sentence ever seen; only when none
//     exists does the raw tail (60 chars, marked unfinished with …) show.
//   - DEDUPE: the same composed line is never pushed twice (同句不重推) —
//     the engine uses null to skip the outbound update entirely.
// reset() returns the instance to a fresh run's state.

// Verbal-tic openers stripped from thinking sentences (评审词表). Stripping
// repeats: '好的，让我先看一下' → '先看一下…'. After each filler, the pause
// punctuation between it and the next word goes too.
const FILLERS = ['好的', '让我', '接下来', '那么', '嗯'];
const PAUSE = /^[，,、．。:：;；！？…!?.\s]+/;
const ENDERS = ['。', '．', '！', '？', '；', '…', '.', '!', '?', ';'];
const CONTENT = /[^\s，,、．。:：;；！？…!?.]/; // a sentence needs one non-punct char

export function createProgressor() {
  let lastLine = null; // last line actually emitted (dedupe)
  let lastSentence = null; // last COMPLETE sentence seen in any thinking chunk
  let answerGrowing = false; // hysteresis latch

  function compose(ev, { answer } = {}) {
    if (ev === null || typeof ev !== 'object') {
      throw new Error(`compose requires an event object, got ${JSON.stringify(ev)}`);
    }
    if (typeof ev.type !== 'string' || ev.type === '') {
      throw new Error(`compose requires a non-empty ev.type, got ${JSON.stringify(ev?.type)}`);
    }
    const line = lineFor(ev, answer);
    // null line (nothing to show / suppressed) must not clobber lastLine, or
    // a later legitimate repeat of the previous line would be wrongly emitted.
    if (line === null || line === lastLine) return null;
    lastLine = line;
    return line;
  }

  function reset() {
    lastLine = null;
    lastSentence = null;
    answerGrowing = false;
  }

  function lineFor(ev, answer) {
    switch (ev.type) {
      case 'tool':
        // brief is ≤60 chars by provider contract (§5) — no re-truncation here.
        return `🔧 ${ev.name ?? ''}: ${ev.brief ?? ''}`;
      case 'thinking': {
        // Latch check first, so suppressed thinking mutates NO state: the
        // sentence cache only tracks thinking that was actually eligible.
        if ((typeof answer === 'string' && answer !== '') || answerGrowing) return null;
        return thinkingLine(ev.text);
      }
      case 'text':
        // Empty answer = text just started, nothing to preview yet — and it
        // must not arm the latch (nothing is growing yet).
        if (typeof answer !== 'string' || answer === '') return null;
        answerGrowing = true;
        return `✍️ 已生成：${answer.slice(0, 40)}`;
      case 'step':
        if (!Number.isFinite(ev.n)) return null; // no step number: no line
        return ev.phase === 'end' ? `第 ${ev.n} 步完成` : `第 ${ev.n} 步`;
      default:
        // session/error/final have their own UI treatment (§6), and unknown
        // types degrade to "no line" rather than crashing the event stream.
        return null;
    }
  }

  function thinkingLine(text) {
    if (typeof text !== 'string' || text === '') return null;
    const sentence = lastSentenceOf(text);
    if (sentence !== null) {
      lastSentence = sentence; // cache for later punctuation-less chunks
      return `💭 ${stripFillers(sentence)}`;
    }
    if (lastSentence !== null) return `💭 ${stripFillers(lastSentence)}`;
    // Never seen a complete sentence: show the moving tail so the line still
    // breathes; the ellipsis marks it as an unfinished thought.
    return `💭 ${stripFillers(text.slice(-60))}…`;
  }

  return { compose, reset };
}

// The substring from just after the PREVIOUS sentence-ender up to and
// including the LAST one — e.g. '一。好的，二。三未完' → '好的，二。'.
// Returns null when the chunk has no ender or the span has no real content.
function lastSentenceOf(text) {
  let end = -1;
  for (const e of ENDERS) {
    const i = text.lastIndexOf(e);
    if (i > end) end = i;
  }
  if (end === -1) return null;
  let start = -1;
  for (const e of ENDERS) {
    const i = text.lastIndexOf(e, end - 1);
    if (i > start) start = i;
  }
  const sentence = text.slice(start + 1, end + 1).trim();
  return CONTENT.test(sentence) ? sentence : null;
}

function stripFillers(sentence) {
  let s = sentence.trim();
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const f of FILLERS) {
      if (s.startsWith(f)) {
        s = s.slice(f.length).replace(PAUSE, '');
        stripped = true;
        break;
      }
    }
  }
  return s.trim();
}
