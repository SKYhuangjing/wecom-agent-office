// Read-only Cursor CLI session history: parses the agent CLI's on-disk
// session files into the §5 readHistory shape {turns, truncated, warnings}.
// Tolerance is the contract: missing / corrupt / oversized history is a
// warning, never a throw.
//
// ON-DISK FORMAT (working hypothesis 2026-11-08, CLI 2026.11.05 — the CLI is
// claude-code-shaped and the bundle nests a projects/ tree under the config
// dir; the EXACT session-file layout lands with the live probe
// test/probe-baselines/cursor*.ndjson — calibrate this header + the walker
// when it does):
//
//   <cursorHome>/projects/**/<sessionId>.jsonl   (bounded walk, see below)
//
//   - cursorHome resolves as providerConfig.cursorHome, then
//     $CURSOR_CONFIG_DIR, then ~/.cursor (bundle-verified override names:
//     CURSOR_CONFIG_DIR config+projects, CURSOR_DATA_DIR data — the runner
//     sets BOTH to cursorHome).
//   - the session id rides in the FILENAME (`…/<sessionId>.jsonl`, the id
//     the --resume flag and the system/init event carry); the walker
//     searches the whole projects tree bounded-depth for a file whose name
//     matches, so the exact per-cwd slug rule is not load-bearing.
//   - line shape mirrors claude (same CLI family): {type:'user'|
//     'assistant'|…, message:{role, content}} — user content may be a plain
//     string or text blocks; assistant content blocks are text/thinking/
//     tool_use; tool_result blocks ride on user lines and are NOT user
//     turns.
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const TURN_LIMIT = 2000;

// Harness-injected user prefixes a REAL user prompt is not expected to carry
// (defensive, same list as the claude/codex readers).
const HARNESS_BLOCK_PREFIXES = [
  '<system-reminder', '<environment_context', '<permissions', '# Cursor Rules', '<user_instructions',
];

export function cursorHomeOf(providerConfig) {
  return providerConfig?.cursorHome || process.env.CURSOR_CONFIG_DIR || join(homedir(), '.cursor');
}

// Collect session files whose name IS `<sessionId>.jsonl` (or ends with the
// id) under <cursorHome>/projects (bounded depth — the real layout is one
// slug level). The id is sanitized to filename-safe chars so caller-supplied
// ids can never traverse out of projects/ (untrusted-input guard).
export function findSessionFiles(providerConfig, sessionId) {
  const safe = String(sessionId ?? '').replace(/[^a-zA-Z0-9._-]/g, '');
  const suffix = `${safe}.jsonl`;
  const projectsDir = join(cursorHomeOf(providerConfig), 'projects');
  const out = [];
  if (safe === '' || !existsSync(projectsDir)) return out;
  const stack = [[projectsDir, 0]];
  while (stack.length > 0 && out.length < 8) {
    const [dir, depth] = stack.pop();
    if (depth > 4) continue; // slug level + headroom
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

// user text extraction: plain-string content OR text blocks minus wrappers.
function userTextOf(message) {
  const content = message?.content;
  if (typeof content === 'string') {
    const t = content.trim();
    return HARNESS_BLOCK_PREFIXES.some((p) => t.startsWith(p)) ? '' : t;
  }
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .filter((t) => !HARNESS_BLOCK_PREFIXES.some((p) => t.startsWith(p)))
    .join('\n')
    .trim();
}

// assistant text extraction: text blocks joined (thinking/tool_use ignored).
function assistantTextOf(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

export function readHistory(providerConfig, sessionId) {
  const warnings = [];
  const files = findSessionFiles(providerConfig, sessionId);
  if (files.length === 0) {
    const where = join(cursorHomeOf(providerConfig), 'projects', '**', `*${String(sessionId ?? '')}.jsonl`);
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
    if (e?.isMeta === true || e?.isSidechain === true) continue; // harness/subagent noise
    const message = e?.message;
    if (message == null || typeof message !== 'object') continue; // queue-op/cost-state/… noise
    if (message.role === 'user') {
      const text = userTextOf(message);
      if (text) lastUser = text;
    } else if (message.role === 'assistant') {
      const text = assistantTextOf(message);
      if (text) {
        turns.push({ user: lastUser, assistant: text, at: Date.parse(e.timestamp) || 0 });
        lastUser = null;
      }
    }
  }

  // Newest-first truncation (same policy as every reader): an oversized
  // history keeps the NEWEST TURN_LIMIT and drops the oldest tail.
  if (turns.length > TURN_LIMIT) return { turns: turns.slice(-TURN_LIMIT), truncated: true, warnings };
  return { turns, truncated: false, warnings };
}
