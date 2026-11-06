// Read-only pi session history: parses pi's REAL on-disk session files into
// the §5 readHistory shape {turns, truncated, warnings}. Tolerance is the
// contract: missing / corrupt / oversized history is a warning, never a throw.
//
// ON-DISK FORMAT (discovered 2026-11-07 by live-probing
// @earendil-works/pi-coding-agent 1.5.0 — two-round magpie-gateway session in
// a tmp cwd, cross-checked against the pi 1.5.0 dist core/session-manager.js):
//
//   <piAgentDir>/sessions/<cwdSlug>/<fileTimestamp>_<sessionId>.jsonl
//
//   - piAgentDir resolves as providerConfig.piAgentDir, then
//     $PI_CODING_AGENT_DIR (pi itself honors it for the whole agent dir), then
//     the WAO per-bot default ~/.pi/agent-wao-<botId> (materializeConfig's
//     default — the runner closes over bot.id, readHistory's third arg).
//   - cwdSlug is pi's own encoding (getDefaultSessionDirPath):
//     `--${cwd minus ONE leading slash, [/\\:] → -}--` — NOT claude's
//     replace-all-non-alphanumerics rule. pi resolves via path.resolve of
//     process.cwd() (already physical), so on macOS a /tmp cwd lands under
//     the /private/... slug; we probe the realpath slug first, then the raw
//     resolve slug (same belt-and-suspenders as the dsh reader).
//   - the session id rides INSIDE the filename (`<ts>_<id>.jsonl`); the
//     reader matches the `_<id>.jsonl` filename suffix (the id is the
//     --session resume value, so this is the lookup the runner's own resume
//     path relies on).
//   - one JSON object per line, {type, message?}. The turn-relevant lines are
//     {type:'message', message:{role:'user'|'assistant', content:[blocks]}}:
//       user content blocks {type:'text', text} — the raw prompt (verified:
//       pi keeps user messages unprefixed; harness context rides in the
//       separate system message entry, so no wrapper filtering is needed —
//       a defensive prefix filter is kept anyway for forward safety).
//       assistant content blocks {type:'text', text} — the reply; the LAST
//       assistant text of a turn is the final text the runner saw.
//     Ignored noise: session / model_change / thinking_level_change entries,
//     system messages, toolResult-role messages, thinking/toolCall blocks.
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const TURN_LIMIT = 2000;

// Defensive wrapper filter (see header): prefixes a REAL user prompt is not
// expected to carry. pi 1.5.0 keeps user messages clean (harness context
// rides in the system entry) — the filter costs nothing and degrades safely.
const HARNESS_BLOCK_PREFIXES = [
  '<environment_context>', '<permissions', '<stdin_instructions>', '# AGENTS.md',
];

// pi's own cwd encoding (verbatim semantics of session-manager.js
// getDefaultSessionDirPath: strip ONE leading slash, replace / \ : with '-',
// wrap in '--…--').
export function piSessionSlug(cwd) {
  return `--${String(cwd ?? '').replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

export function piAgentDirOf(providerConfig, botId) {
  return providerConfig?.piAgentDir
    || process.env.PI_CODING_AGENT_DIR
    || join(homedir(), '.pi', `agent-wao-${botId ?? 'bot'}`);
}

// The slug candidates for a configured cwd: pi resolves process.cwd()
// physically (OS), so the realpath slug is what a real run writes; the raw
// resolve slug is the belt for mounts where the writer saw a different path.
export function cwdSlugs(cwd) {
  const raw = piSessionSlug(resolve(String(cwd ?? '') || '.'));
  const out = [];
  try {
    const real = piSessionSlug(realpathSync(cwd));
    if (real !== raw) out.push(real);
  } catch { /* nonexistent cwd: raw slug only */ }
  out.push(raw);
  return out;
}

// Collect session files whose name ends `_<sessionId>.jsonl` under
// <piAgentDir>/sessions/<slug>/. The id is sanitized to the charset pi
// session ids use (uuid: hex + dashes), so caller-supplied ids can never
// traverse out of sessions/ (untrusted-input guard).
export function findSessionFiles(providerConfig, sessionId, botId) {
  const safe = String(sessionId ?? '').replace(/[^a-zA-Z0-9-]/g, '');
  const suffix = `_${safe}.jsonl`;
  const sessionsRoot = join(piAgentDirOf(providerConfig, botId), 'sessions');
  const out = [];
  if (safe === '' || !existsSync(sessionsRoot)) return out;
  for (const slug of cwdSlugs(providerConfig?.cwd)) {
    const dir = join(sessionsRoot, slug);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch { continue; /* unreadable/absent slug: try the next candidate */ }
    for (const ent of entries) {
      if (ent.isFile() && ent.name.endsWith(suffix)) out.push(join(dir, ent.name));
    }
    if (out.length > 0) break; // one slug hit is the answer
  }
  return out.sort(); // deterministic when several files match
}

// user text extraction: text blocks minus the defensive wrappers.
function userTextOf(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .filter((t) => !HARNESS_BLOCK_PREFIXES.some((p) => t.startsWith(p)))
    .join('\n')
    .trim();
}

// assistant text extraction: text blocks joined (thinking/toolCall ignored).
function assistantTextOf(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

export function readHistory(providerConfig, sessionId, { botId } = {}) {
  const warnings = [];
  const files = findSessionFiles(providerConfig, sessionId, botId);
  if (files.length === 0) {
    const where = join(piAgentDirOf(providerConfig, botId), 'sessions', '**', `*_${String(sessionId ?? '')}.jsonl`);
    return { turns: [], truncated: false, warnings: [`session file not found: ${where}`] };
  }
  const found = files[0];
  if (files.length > 1) warnings.push(`multiple session files match; using ${found}`);

  let raw = '';
  try {
    raw = readFileSync(found, 'utf8');
  } catch (e) {
    return { turns: [], truncated: false, warnings: [`session file unreadable: ${found}: ${e?.message ?? e}`] };
  }

  const lines = raw.split('\n');
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try {
      entries.push(JSON.parse(lines[i]));
    } catch {
      warnings.push(`line ${i + 1} in ${found} is not JSON`);
    }
  }

  const turns = [];
  let lastUser = null;
  for (const e of entries) {
    if (e?.type !== 'message' || e.message == null || typeof e.message !== 'object') continue;
    const role = e.message.role;
    if (role === 'user') {
      const text = userTextOf(e.message);
      if (text) lastUser = text;
    } else if (role === 'assistant') {
      const text = assistantTextOf(e.message);
      if (text) {
        turns.push({ user: lastUser, assistant: text, at: Date.parse(e.timestamp) || 0 });
        lastUser = null;
      }
    }
    // system / toolResult roles and every other entry type is noise (header)
  }

  // Newest-first truncation (same policy as the dsh/claude/codex readers): a
  // session drill-down cares about the most recent turns, so an oversized
  // history keeps the NEWEST TURN_LIMIT and drops the oldest tail.
  if (turns.length > TURN_LIMIT) return { turns: turns.slice(-TURN_LIMIT), truncated: true, warnings };
  return { turns, truncated: false, warnings };
}
