// Read-only claude session history (M2 Task 2): parses claude's REAL on-disk
// session files into the §5 readHistory shape {turns, truncated, warnings}.
// Tolerance is the contract: missing / corrupt / oversized history is a
// warning, never a throw.
//
// ON-DISK FORMAT (discovered 2026-11-06 by running a real `claude -p
// --output-format stream-json --verbose` with the prompt on stdin in a tmp
// cwd, then inspecting the file claude wrote; claude 2.1.318):
//
//   <claudeConfigDir>/projects/<projectDirName(realpath(cwd))>/<sessionId>.jsonl
//
//   - claudeConfigDir resolves as providerConfig.claudeConfigDir, then
//     $CLAUDE_CONFIG_DIR, then ~/.claude.
//   - projectDirName: the path with EVERY non-alphanumeric char collapsed to
//     '-' (verified: /Users/sky/dev/x → -Users-sky-dev-x; a /tmp cwd lands
//     under -private-tmp-… because claude resolves the realpath first — same
//     macOS trap the dsh reader guards against).
//   - one JSON object per line; a real session interleaves many line types.
//     The turn-relevant ones:
//       {type:'user', message:{role:'user', content: string |
//        [{type:'text'|'tool_result',…}]}, timestamp, isSidechain?, isMeta?}
//         — a plain-string content is a REAL user prompt; tool_result blocks
//           are tool outputs riding on user lines (NOT user turns); isMeta
//           lines are harness-injected (system-reminder…); isSidechain lines
//           belong to subagents.
//       {type:'assistant', message:{role:'assistant', content:[{type:'text'|
//        'thinking'|'tool_use',…}]}, timestamp, isSidechain?}
//         — one assistant reply typically spans TWO lines (a thinking-only
//           line, then a text line); thinking carries its payload in .thinking.
//     Ignored noise: queue-operation, attachment, api-request,
//     api-request-shape, api-request-blob, last-prompt, cost-state, mode,
//     atis-latch.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const TURN_LIMIT = 2000;

// claude's project-dir slugging: every non-alphanumeric char → '-'. Verified
// against real sessions in this workspace (see header).
export function projectDirName(cwd) {
  return String(cwd ?? '').replace(/[^a-zA-Z0-9]/g, '-');
}

export function claudeConfigDirOf(providerConfig) {
  return providerConfig?.claudeConfigDir || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

// claude writes under the REALPATH escape; a bot config may carry the raw
// spelling (/tmp vs /private/tmp on macOS), so probe realpath first, raw
// second (belt for mounts where the writer saw a different path).
function projectDirNames(cwd) {
  const raw = projectDirName(cwd);
  const out = [];
  try {
    const real = projectDirName(realpathSync(cwd));
    if (real !== raw) out.push(real);
  } catch { /* nonexistent cwd: raw escape only */ }
  out.push(raw);
  return out;
}

// Candidate session files for (providerConfig, sessionId), most specific
// first. Exported for tests and diagnostics. sessionIds are UUIDs from claude
// itself, but readHistory also receives caller-supplied ids — strip anything
// that could traverse out of projects/ (untrusted-input guard).
export function historyCandidates(providerConfig, sessionId) {
  const cwd = providerConfig?.cwd;
  const id = String(sessionId ?? '');
  const safe = id.replace(/[^a-zA-Z0-9-]/g, '');
  const out = [];
  if (safe !== '') {
    for (const esc of projectDirNames(cwd)) {
      out.push(join(claudeConfigDirOf(providerConfig), 'projects', esc, `${safe}.jsonl`));
    }
  }
  return out;
}

// user text extraction: plain string content is the prompt; block arrays
// count only text blocks (tool_result arrays are tool outputs, not turns).
function userTextOf(message) {
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  }
  return '';
}

export function readHistory(providerConfig, sessionId) {
  const warnings = [];
  const candidates = historyCandidates(providerConfig, sessionId);
  const found = candidates.find((f) => existsSync(f));
  if (!found) {
    const where = candidates[0]
      ?? join(claudeConfigDirOf(providerConfig), 'projects', projectDirName(providerConfig?.cwd), '<sessionId>.jsonl');
    return { turns: [], truncated: false, warnings: [`session file not found: ${where}`] };
  }

  let raw = '';
  try {
    raw = readFileSync(found, 'utf8');
  } catch (e) {
    return { turns: [], truncated: false, warnings: [`session file unreadable: ${found}: ${e?.message ?? e}`] };
  }

  const lines = raw.split('\n');
  const events = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try {
      events.push(JSON.parse(lines[i]));
    } catch {
      warnings.push(`line ${i + 1} in ${found} is not JSON`);
    }
  }

  const turns = [];
  let lastUser = null;
  for (const e of events) {
    if (e?.type === 'user') {
      if (e.isSidechain === true || e.isMeta === true) continue;
      const text = userTextOf(e.message).trim();
      if (text) lastUser = text;
    } else if (e?.type === 'assistant') {
      if (e.isSidechain === true) continue;
      const blocks = e.message?.content;
      const text = (Array.isArray(blocks) ? blocks : [])
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (text) {
        turns.push({ user: lastUser, assistant: text, at: Date.parse(e.timestamp) || 0 });
        lastUser = null;
      }
    }
    // every other line type is noise (see header) — skipped silently
  }

  // Newest-first truncation (same policy as the dsh reader): a session
  // drill-down cares about the most recent turns, so an oversized history
  // keeps the NEWEST TURN_LIMIT and drops the oldest tail.
  if (turns.length > TURN_LIMIT) return { turns: turns.slice(-TURN_LIMIT), truncated: true, warnings };
  return { turns, truncated: false, warnings };
}
