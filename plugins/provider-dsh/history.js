// Read-only dsh session history (Task 18): ports wecom-bots/lib/history.js
// (zstd multi-frame decode + turn extraction) into the §5 readHistory shape
// {turns, truncated, warnings}. Tolerance is the contract: missing / corrupt /
// oversized history is a warning, never a throw.
//
// Two on-disk locations are probed, in order:
//   1. <cwd>/sessions/<sessionId>.zst — the office convention shared with the
//      contract suite (test/contract/README.md: "dsh 会话文件位于
//      <cwd>/sessions/<id>.zst"); also where office-managed sessions land when
//      DSH_HOME is redirected into the workspace.
//   2. the REAL dsh layout <dshHome>/sessions/<cwdEscape(cwd)>/session-<id>/
//      session.v4.jsonl.zstd — what a production dsh install writes. dshHome
//      resolves from providerConfig.dshHome, then $DSH_HOME, then ~/.dsh
//      (same override chain as the 前身).
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

export const TURN_LIMIT = 2000;

// cwd escape ported from the 前身: /Users/a/b → --Users-a-b--. The 前身
// comment documented "/tmp → --private-tmp-- (macOS)" but its code never
// realpath'd — real dsh resolves the session dir from the REALPATH of its
// cwd, so on macOS a /tmp cwd's history was silently missed. We probe the
// realpath escape first, then the raw escape (belt for mounts where the
// writer saw a different path than we resolve now).
export function cwdEscape(cwd) {
  const p = typeof cwd === 'string' ? cwd : '';
  return '--' + p.replace(/^\/+/, '').replace(/[\/]+/g, '-') + '--';
}

function cwdEscapes(cwd) {
  const raw = cwdEscape(cwd);
  const out = [];
  try {
    const real = cwdEscape(realpathSync(cwd));
    if (real !== raw) out.push(real);
  } catch { /* nonexistent cwd: raw escape only */ }
  out.push(raw);
  return out;
}

export function dshHomeOf(providerConfig) {
  return providerConfig?.dshHome || process.env.DSH_HOME || join(process.env.HOME || '', '.dsh');
}

// Candidate session files for (providerConfig, sessionId), most specific
// first. Exported for tests and the diagnostics page.
export function historyCandidates(providerConfig, sessionId) {
  const cwd = providerConfig?.cwd;
  const id = String(sessionId ?? '');
  const out = [];
  if (typeof cwd === 'string' && cwd !== '') out.push(join(cwd, 'sessions', `${id}.zst`));
  for (const esc of cwdEscapes(cwd)) {
    // Session dir naming drift: dsh 0.2.1-rc.5 emits sessionIds that ALREADY
    // carry the "session-" prefix (dir name === sessionId verbatim); older
    // shapes prefixed at the path. Probe both spellings — §5.1 宽松解析.
    out.push(join(dshHomeOf(providerConfig), 'sessions', esc, `session-${id}`, 'session.v4.jsonl.zstd'));
    if (id !== '' && `session-${id}` !== id) {
      out.push(join(dshHomeOf(providerConfig), 'sessions', esc, id, 'session.v4.jsonl.zstd'));
    }
  }
  return out;
}

// Multi-frame zstd decode ported from the 前身, with the silent catch upgraded
// to a per-frame warning (readHistory callers must be able to SEE corruption,
// not just lose the frame). Frame starts are located by scanning for the zstd
// magic 0x28 b5 2f fd; a decode failure of one frame never drops the others.
function decodeZstdMultiFrame(buf, warnings, path) {
  const starts = [];
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i);
  }
  if (!starts.length) {
    warnings.push(`no zstd frame found in ${path}`);
    return '';
  }
  let out = '';
  for (let k = 0; k < starts.length; k++) {
    const seg = buf.subarray(starts[k], k + 1 < starts.length ? starts[k + 1] : buf.length);
    try {
      out += zstdDecompressSync(seg).toString('utf8');
    } catch (e) {
      warnings.push(`zstd frame ${k} decode failed in ${path}: ${e?.message ?? e}`);
    }
  }
  return out;
}

// Extract readable turns (user text + assistant text) from one session's
// events — ported from the 前身 readSessionTurns: user/message counts only
// real user input (source.kind absent or 'user'); assistant/message closes a
// turn when it carries text.
export function readHistory(providerConfig, sessionId) {
  const warnings = [];
  const candidates = historyCandidates(providerConfig, sessionId);
  const found = candidates.find((f) => existsSync(f));
  if (!found) return { turns: [], truncated: false, warnings: [`session file not found: ${candidates[0]}`] };

  let raw = '';
  try {
    raw = decodeZstdMultiFrame(readFileSync(found), warnings, found);
  } catch (e) {
    return { turns: [], truncated: false, warnings: [`session file unreadable: ${found}: ${e?.message ?? e}`] };
  }

  const events = [];
  raw.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try {
      events.push(JSON.parse(line));
    } catch {
      warnings.push(`line ${i + 1} in ${found} is not JSON`);
    }
  });

  const turns = [];
  let lastUser = null;
  for (const e of events) {
    if (e?.type === 'user/message') {
      const k = e.data?.source?.kind;
      if (k && k !== 'user') continue;
      const text = (e.data?.content || []).filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
      if (text) lastUser = text;
    } else if (e?.type === 'assistant/message') {
      const blocks = e.data?.message?.content || [];
      const text = blocks.filter((c) => c?.type === 'text').map((c) => c.text).join('\n').trim();
      if (text) {
        turns.push({ user: lastUser, assistant: text, at: e.time || e.at || 0 });
        lastUser = null;
      }
    }
  }

  // Newest-first truncation (前身 readSessionTurns slice(-limit)): a session
  // drill-down cares about the most recent turns, so an oversized history
  // keeps the NEWEST TURN_LIMIT and drops the oldest tail.
  if (turns.length > TURN_LIMIT) return { turns: turns.slice(-TURN_LIMIT), truncated: true, warnings };
  return { turns, truncated: false, warnings };
}
