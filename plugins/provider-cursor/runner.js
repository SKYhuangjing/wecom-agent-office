// Cursor provider runner: the fifth REAL provider behind the §5 port
// contract, ported from the contract-proven provider-claude runner (复制即
// 契约 — spawn/NDJSON/kill-escalation/code mapping/abort semantics are
// identical; ONLY the CLI invocation and event parsing differ). The Cursor
// CLI is claude-code-shaped (facts from CLI docs + bundle inspection +
// probe baselines test/probe-baselines/cursor*.ndjson, CLI 2026.11.05):
//   - spawn `agent -p --output-format stream-json -f`, prompt on STDIN;
//     resume is `--resume <id>` (system/init re-emits the session id),
//   - `-f`/`--force` un-attends tool approvals (bot runs headless — the
//     operator flips pc.force off for a read-only-ish posture),
//   - auth: the CLI's OWN stored login (`agent login`, browser — the login
//     entry stays the default route) OR CURSOR_API_KEY env; a model-declared
//     apiKey literal is injected under apiKeyEnv (default CURSOR_API_KEY).
//     ⚠️ NO base-URL override exists in the CLI (forum-confirmed) — there is
//     no gateway/magpie route; requests always hit Cursor's own backend,
//   - cursorHome → $CURSOR_CONFIG_DIR + $CURSOR_DATA_DIR (bundle-verified
//     overrides; both default ~/.cursor) so sessions land where history.js
//     walks — same isolation discipline as codexHome/piAgentDir,
//   - events nest content blocks at ev.message.content[] (claude-shaped:
//     text {type:'text',text} / thinking payload .thinking / tool_use
//     {name,input}); the turn outcome lives on the result event
//     (subtype 'success' + exit 0); tool_call started/completed events
//     degrade silently (the assistant tool_use block already mapped them),
//   - ⚠️ exit-0 discipline is claude's (verified by probe): exit code AND
//     result subtype both decide success.
import { spawnCli } from '../../src/kernel/spawn.js';
import { childEnv } from '../../src/kernel/safeEnv.js';
import { readHistory } from './history.js';

// Cursor's exact session-conflict wording is UNKNOWN (no observed two-process
// session contention); the patterns are the generic shapes the other runners
// carry plus cursor-flavored 'chat lock' wording, so an unseen-but-obvious
// lock text still maps. Keep fake-cursor's lock text and this regex
// co-validated (changing either means changing both). Unify against REAL
// wording once an actual conflict is observed.
const LOCK_CONFLICT_RE = /chat (?:session )?is locked|locked by another (?:cursor |agent |process|instance)|session lock|IsolationError|another (?:process|instance).*(?:chat|session)|(?:chat|session).*already in use/i;
const MISSING_CREDENTIAL_RE = /CURSOR_API_KEY|Authentication required|invalid api key|unauthorized|authentication/i;
const DEFAULT_ESCALATION_MS = 3000;
const STDERR_TAIL_CHARS = 4000;

// The 前身 describeTool heuristic (provider-dsh/claude/codex/pi runners):
// first meaningful input field wins, whitespace collapsed, capped at 60.
export function describeToolBrief(input) {
  const i = input && typeof input === 'object' ? input : {};
  const detail = i.command || i.description || i.pattern || i.path || i.file_path || i.query || i.cmd || i.name || '';
  return String(detail).replace(/\s+/g, ' ').trim().slice(0, 60);
}

export function createRunner({ bot, providerConfig, assets, log, escalationMs = DEFAULT_ESCALATION_MS } = {}) {
  const pc = providerConfig ?? {};
  const cursorBin = pc.cursorBin || 'agent';
  // Asset faces (DESIGN-ASSETS §3.3): cursor v0.1.0 has no verified system-
  // prompt / mcp flags — prompt-type assets ride as a PREFIX BLOCK in the
  // prompt text; other asset kinds log-and-skip (W3 formalizes the faces;
  // .cursor/rules + mcp.json land with it).
  const assetPromptTexts = (Array.isArray(assets) ? assets : [])
    .filter((e) => e?.type === 'prompt')
    .map((e) => String(e.content?.text ?? ''));
  // Auth env: model.apiKey → CURSOR_API_KEY (apiKeyEnv overridable). Absent
  // that, the CLI uses its own stored login — the login entry stays.
  const extraEnv = {};
  const m = pc.model;
  if (m && typeof m === 'object' && m.apiKey) {
    extraEnv[m.apiKeyEnv || pc.apiKeyEnv || 'CURSOR_API_KEY'] = m.apiKey;
  }
  // A redirected cursor home must reach the CLI too: the bundle honors
  // $CURSOR_CONFIG_DIR (config + projects tree) and $CURSOR_DATA_DIR —
  // set BOTH so sessions land where the history reader walks.
  if (pc.cursorHome) {
    extraEnv.CURSOR_CONFIG_DIR = pc.cursorHome;
    extraEnv.CURSOR_DATA_DIR = pc.cursorHome;
  }
  const logger = log ?? console;

  function run({ prompt, sessionId, signal, timeoutMs, onEvent } = {}) {
    return new Promise((resolve) => {
      const finish = (payload) => resolve(payload); // a Promise settles once; no guard needed

      // Abort-before-spawn fast path: nothing was created, so there is no
      // session to hand back either.
      if (signal?.aborted) {
        finish({
          ok: false, code: 'aborted', finalText: '', aborted: true, sessionId: null,
          reason: null, error: null, detail: { exitCode: null, stderrTail: '' },
        });
        return;
      }

      const args = ['-p', '--output-format', 'stream-json'];
      // Un-attended tool approvals: a bot employee runs headless; -f is the
      // CLI's own "force allow commands" flag (--yolo alias). pc.force===false
      // opts out (the CLI then prompts → headless turns stall on tools).
      if (pc.force !== false) args.push('-f');
      if (m?.model) args.push('--model', String(m.model));
      if (pc.mode) args.push('--mode', String(pc.mode));
      if (sessionId) args.push('--resume', String(sessionId));
      // cursorArgs LAST (passthrough tail): an operator-supplied variadic
      // flag must never eat the runner's own flags (same tail discipline as
      // codex's --mcp-config).
      if (Array.isArray(pc.cursorArgs)) {
        for (const entry of pc.cursorArgs) args.push(String(entry));
      }

      let child;
      try {
        // spawnCli: passthrough here, cmd.exe+escaping on Windows (see
        // src/kernel/spawn.js — same reason as the claude runner).
        child = spawnCli(cursorBin, args, {
          cwd: pc.cwd || undefined,
          env: childEnv({ ...extraEnv, ...(pc.env && typeof pc.env === 'object' ? pc.env : {}) }),
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        finish({
          ok: false, code: 'error', finalText: '', aborted: false, sessionId: sessionId ?? null,
          reason: null, error: err?.message ?? String(err), detail: { exitCode: null, stderrTail: '' },
        });
        return;
      }

      logger.debug?.(`cursor spawn ${cursorBin} ${args.join(' ')} (cwd=${pc.cwd}) pid=${child.pid}`);

      const state = { sessionId: sessionId ?? null, finalText: '', reason: null, error: null, stderrTail: '' };
      let sawSessionEvent = false; // the CLI emitted/minted a session event
      let abortedBySignal = false;
      let timedOut = false;
      let done = false; // after close: no more events, no more kills

      const emit = (ev) => {
        if (done || typeof onEvent !== 'function') return;
        try {
          onEvent(ev);
        } catch (e) {
          logger.warn?.('cursor onEvent callback threw:', e?.message ?? e);
        }
      };

      // Map one assistant content block to a unified event (claude-shaped).
      const onContentBlock = (block) => {
        if (block == null || typeof block !== 'object') return;
        switch (block.type) {
          case 'text':
            if (typeof block.text === 'string') state.finalText = block.text;
            emit({ type: 'text', text: typeof block.text === 'string' ? block.text : '' });
            break;
          case 'thinking':
            emit({ type: 'thinking', text: block.thinking || block.text || '' });
            break;
          case 'tool_use':
            emit({ type: 'tool', name: typeof block.name === 'string' && block.name !== '' ? block.name : 'tool', brief: describeToolBrief(block.input) });
            break;
          default:
            break; // unknown block kinds degrade silently (§5.1 宽松解析)
        }
      };

      let stdoutBuf = '';
      const onLine = (line) => {
        if (done || !line.trim()) return;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          logger.debug?.('cursor stdout non-json:', line.slice(0, 200));
          return;
        }
        switch (ev.type) {
          case 'system':
            // init carries the session_id; a resume re-emits the SAME id.
            if (ev.subtype === 'init') {
              sawSessionEvent = true;
              if (ev.session_id) state.sessionId = ev.session_id;
              emit({ type: 'session', sessionId: ev.session_id ?? null });
            }
            break;
          case 'assistant': {
            const content = ev.message?.content;
            if (Array.isArray(content)) content.forEach(onContentBlock);
            else if (content != null) onContentBlock(content); // tolerate a bare block
            break;
          }
          case 'tool_call':
            // started/completed lifecycle twins of the tool_use block the
            // assistant event already mapped — degrade silently.
            break;
          case 'result': {
            // The turn outcome: success (subtype + is_error + exit code) or
            // an error subtype whose message rides in .result/.error.
            const okResult = ev.subtype === 'success' && ev.is_error !== true;
            state.reason = {
              kind: okResult ? 'completed' : (ev.subtype || 'error'),
              subtype: ev.subtype ?? null,
              numTurns: typeof ev.num_turns === 'number' ? ev.num_turns : null,
            };
            if (ev.usage && typeof ev.usage === 'object') {
              emit({ type: 'usage', usage: ev.usage });
            }
            const message = (typeof ev.result === 'string' && ev.result !== '')
              ? ev.result
              : (typeof ev.error === 'string' && ev.error !== '' ? ev.error : '');
            if (message !== '') {
              if (okResult) state.finalText = message; // canonical final text
              else state.error = state.error || message;
            } else if (!okResult) {
              state.error = state.error || `result subtype ${ev.subtype ?? 'unknown'}`;
            }
            if (ev.session_id) {
              state.sessionId = ev.session_id;
              sawSessionEvent = true;
            }
            break; // result is bookkeeping, not a unified event
          }
          default:
            break; // user/events degrade silently (§5.1 宽松解析)
        }
      };

      child.stdout.on('data', (chunk) => {
        stdoutBuf += chunk.toString();
        let idx;
        while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
          const line = stdoutBuf.slice(0, idx);
          stdoutBuf = stdoutBuf.slice(idx + 1);
          onLine(line);
        }
      });

      child.stderr.on('data', (chunk) => {
        const s = chunk.toString();
        state.stderrTail = (state.stderrTail + s).slice(-STDERR_TAIL_CHARS);
        for (const l of s.split(/\r?\n/)) if (l.trim()) logger.debug?.('cursor stderr:', l.trim());
      });

      // ---- kill escalation: SIGTERM first, SIGKILL after escalationMs ----
      let escalationTimer = null;
      const startKill = () => {
        if (done) return;
        try { child.kill('SIGTERM'); } catch { /* already dead: close will fire */ }
        if (escalationTimer == null) {
          escalationTimer = setTimeout(() => {
            if (done) return;
            logger.warn?.(`cursor pid=${child.pid} survived SIGTERM +${escalationMs}ms — SIGKILL`);
            try { child.kill('SIGKILL'); } catch { /* racing exit */ }
          }, escalationMs);
        }
      };

      const onAbort = () => {
        abortedBySignal = true;
        logger.warn?.(`cursor pid=${child.pid} aborted by signal — SIGTERM`);
        startKill();
      };
      signal?.addEventListener?.('abort', onAbort, { once: true });

      let timeoutTimer = null;
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          logger.warn?.(`cursor pid=${child.pid} timed out after ${timeoutMs}ms — killing`);
          startKill();
        }, timeoutMs);
      }

      const cleanup = () => {
        done = true;
        if (timeoutTimer != null) clearTimeout(timeoutTimer);
        if (escalationTimer != null) clearTimeout(escalationTimer);
        signal?.removeEventListener?.('abort', onAbort);
      };

      const buildResult = (exitCode) => {
        const aborted = abortedBySignal === true;
        const ok = exitCode === 0 && state.reason?.kind === 'completed' && !aborted && !timedOut;
        // Startup-level failures (auth required, bad model) never reach the
        // stream: the CLI exits 1 with the reason ONLY on stderr. Surface the
        // first meaningful stderr line as state.error (blind-review P0
        // lesson from pi: a bare 「运行结束：failed」 has zero diagnosis).
        if (!ok && !state.error && state.stderrTail.trim() !== '') {
          state.error = state.stderrTail
            .split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '')
            .slice(-3).join('\n');
        }
        const errText = [state.error, state.stderrTail].filter(Boolean).join('\n');
        let code;
        if (aborted) code = 'aborted';
        else if (timedOut) code = 'timeout';
        else if (ok) code = 'completed';
        else if (LOCK_CONFLICT_RE.test(errText)) code = 'lock-conflict';
        else if (MISSING_CREDENTIAL_RE.test(errText)) code = 'missing-credential';
        else code = 'error';
        // §5 abort 处置: a run killed before the CLI ever emitted its session
        // event leaves a half-written session — hand back NO id. A resume
        // that got no echo still returns the INPUT id: the session already
        // exists, that IS the id to pass back next turn.
        let outSessionId = state.sessionId;
        if ((aborted || timedOut) && !sawSessionEvent) outSessionId = null;
        return {
          ok,
          code,
          finalText: state.finalText,
          aborted,
          sessionId: outSessionId,
          reason: state.reason,
          error: state.error || null,
          detail: { exitCode, stderrTail: state.stderrTail },
        };
      };

      child.on('error', (err) => {
        // spawn failures (ENOENT...) land here; state.error keeps any CLI
        // error result that arrived on stdout first.
        state.error = state.error || err.message;
        cleanup();
        finish(buildResult(null));
      });

      child.on('close', (code) => {
        if (stdoutBuf.trim()) onLine(stdoutBuf); // trailing line without \n
        cleanup();
        logger.info?.(`cursor close pid=${child.pid} code=${code} reason=${state.reason?.kind || '-'}`);
        finish(buildResult(code));
      });

      // Feed the task on stdin (the whole prompt; prompt-type assets ride as
      // a prefix block — v0.1.0 has no verified system-prompt flag).
      const assetBlock = assetPromptTexts.filter((t) => t.trim() !== '').join('\n\n');
      const fullPrompt = assetBlock !== '' ? `${assetBlock}\n\n---\n\n${prompt ?? ''}` : (prompt ?? '');
      child.stdin.on('error', () => { /* EPIPE when the child died first — close/error reports it */ });
      try {
        child.stdin.write(fullPrompt);
        child.stdin.end();
      } catch { /* child gone: close/error path owns the result */ }
    });
  }

  return {
    run,
    // §5: readHistory lives on the RUNNER (same providerConfig wiring a turn
    // used); the engine/api passes the bot's providerConfig explicitly.
    readHistory: (cfg, sessionId) => readHistory(cfg ?? pc, sessionId),
  };
}
