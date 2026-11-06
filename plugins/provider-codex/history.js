// Read-only codex session history (M2 Task 4): parses codex's REAL on-disk
// rollout files into the §5 readHistory shape {turns, truncated, warnings}.
// Tolerance is the contract: missing / corrupt / oversized history is a
// warning, never a throw.
//
// ON-DISK FORMAT (discovered 2026-11-06 by inspecting the rollout files real
// codex-cli 0.166.0 sessions wrote — the M1 probe threads under
// ~/.codex/sessions plus a fresh command-run probe in a tmp cwd; field names
// cross-checked against codex-rs @ rust-v0.166.0):
//
//   <codexHome>/sessions/<YYYY>/<MM>/<DD>/rollout-<timestamp>-<threadId>.jsonl
//
//   - codexHome resolves as providerConfig.codexHome, then $CODEX_HOME, then
//     ~/.codex (codex itself honors $CODEX_HOME for this tree; the runner
//     injects it when providerConfig.codexHome is set).
//   - the thread id rides INSIDE the filename (`…-<threadId>.jsonl`) and in
//     the session_meta line's payload.session_id; the reader matches the
//     filename suffix (the thread id is the resume positional, so this is the
//     lookup the runner's own resume path relies on).
//   - one JSON object per line: {timestamp, ordinal, type, payload}. The
//     turn-relevant lines:
//       {type:'response_item', payload:{type:'message', role:'user',
//         content:[{type:'input_text', text}]}} — the user prompt. The FIRST
//         user message of a session interleaves harness-injected blocks
//         (`# AGENTS.md instructions`, `<environment_context>`, `## Memory`,
//         `<permissions…>`…); they are filtered by the prefixes below, a real
//         prompt block never matches them.
//       {type:'response_item', payload:{type:'message', role:'assistant',
//         content:[{type:'output_text', text}]}} — the reply; the LAST
//         assistant output_text of a turn is the final text the runner saw.
//     Ignored noise: session_meta, event_msg/* (item_completed mirrors of the
//     stream), response_item/reasoning (encrypted), turn_context,
//     token_usage_record, world_state, response_item role 'developer'
//     (harness instructions).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const TURN_LIMIT = 2000;

// Harness-injected user blocks (see header): prefixes a REAL user prompt is
// not expected to carry; matching blocks are dropped before turn pairing.
const HARNESS_BLOCK_PREFIXES = [
  '# AGENTS.md', '## Memory', '<environment_context>', '<permissions', '<skills',
  '<collaboration_mode>', '<apps', '<recommended_plugins>', '<stdin_instructions>',
];

export function codexHomeOf(providerConfig) {
  return providerConfig?.codexHome || process.env.CODEX_HOME || join(homedir(), '.codex');
}

// Walk <codexHome>/sessions (bounded depth: the real layout is YYYY/MM/DD)
// collecting rollout files whose name ends `-<sessionId>.jsonl`. The id is
// sanitized to the charset codex thread ids use, so caller-supplied ids can
// never traverse out of sessions/ (untrusted-input guard).
export function findRolloutFiles(providerConfig, sessionId) {
  const safe = String(sessionId ?? '').replace(/[^a-zA-Z0-9-]/g, '');
  const sessionsDir = join(codexHomeOf(providerConfig), 'sessions');
  const suffix = `-${safe}.jsonl`;
  const out = [];
  if (safe === '' || !existsSync(sessionsDir)) return out;
  const stack = [[sessionsDir, 0]];
  while (stack.length > 0 && out.length < 8) {
    const [dir, depth] = stack.pop();
    if (depth > 4) continue; // 3 real levels (YYYY/MM/DD) + headroom
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch { continue; /* unreadable level: not our session */ }
    for (const ent of entries) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) stack.push([p, depth + 1]);
      else if (ent.isFile() && ent.name.endsWith(suffix)) out.push(p);
    }
  }
  return out.sort(); // deterministic when several files match
}

// user text extraction: input_text blocks minus the harness wrappers.
function userTextOf(payload) {
  const content = Array.isArray(payload?.content) ? payload.content : [];
  return content
    .filter((b) => b?.type === 'input_text' && typeof b.text === 'string')
    .map((b) => b.text)
    .filter((t) => !HARNESS_BLOCK_PREFIXES.some((p) => t.startsWith(p)))
    .join('\n')
    .trim();
}

// assistant text extraction: output_text blocks joined.
function assistantTextOf(payload) {
  const content = Array.isArray(payload?.content) ? payload.content : [];
  return content
    .filter((b) => b?.type === 'output_text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

export function readHistory(providerConfig, sessionId) {
  const warnings = [];
  const files = findRolloutFiles(providerConfig, sessionId);
  if (files.length === 0) {
    const where = join(codexHomeOf(providerConfig), 'sessions', '**', `rollout-*-${String(sessionId ?? '')}.jsonl`);
    return { turns: [], truncated: false, warnings: [`session file not found: ${where}`] };
  }
  const found = files[0];
  if (files.length > 1) warnings.push(`multiple rollout files match; using ${found}`);

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
    if (e?.type !== 'response_item' || e.payload?.type !== 'message') continue;
    const role = e.payload.role;
    if (role === 'user') {
      const text = userTextOf(e.payload);
      if (text) lastUser = text;
    } else if (role === 'assistant') {
      const text = assistantTextOf(e.payload);
      if (text) {
        turns.push({ user: lastUser, assistant: text, at: Date.parse(e.timestamp) || 0 });
        lastUser = null;
      }
    }
    // 'developer' role and every other line type is noise (see header)
  }

  // Newest-first truncation (same policy as the dsh/claude readers): a
  // session drill-down cares about the most recent turns, so an oversized
  // history keeps the NEWEST TURN_LIMIT and drops the oldest tail.
  if (turns.length > TURN_LIMIT) return { turns: turns.slice(-TURN_LIMIT), truncated: true, warnings };
  return { turns, truncated: false, warnings };
}
