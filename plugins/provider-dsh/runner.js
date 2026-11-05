// DSH provider runner (Task 18): the first REAL provider behind the §5 port
// contract. Ports the proven child-process driver from
// wecom-bridge/src/dsh.js (spawn shape / NDJSON line parse / stderr tail /
// turn_end reason capture — rc.5 carries the outcome on a status event, NOT
// on `final`) and adds what the office contract demands over the 前身:
//   - machine-readable `code` mapping (lock-conflict / missing-credential /
//     timeout / aborted / completed / error) so the engine never regexes
//     error strings again,
//   - kill escalation (review P0): SIGTERM → escalationMs → SIGKILL, and the
//     run resolves ONLY on 'close' — a zombie child holding the session
//     write-lock is a known incident class,
//   - first-event-abort drops the sessionId: a NEW session aborted before the
//     CLI ever emitted its session event is half-written and must not enter
//     the cache, while a resume that simply got no echo still returns the
//     INPUT id (the session already exists on disk),
//   - unified events (session / step / tool / thinking / text) with the 前身
//     describeTool heuristic carried over as the tool event's brief.
import { spawn } from 'node:child_process';
import { readHistory } from './history.js';

// dsh reports a held session.lock this way when the GUI (or another dsh
// instance) has the same session open — kernel flock is exclusive across
// processes. Ported from wecom-bridge/src/bridge.js:16.
const LOCK_CONFLICT_RE = /already owned by an active write handle|SessionAlreadyOwnedError|writer-held/i;
const MISSING_CREDENTIAL_RE = /MISSING_CREDENTIAL|no API key/i;
const DEFAULT_ESCALATION_MS = 3000;
const STDERR_TAIL_CHARS = 4000;

// The 前身 bridge.js describeTool heuristic (~line 186): first meaningful
// input field wins (command||description||pattern||path||file_path||query||
// cmd||name), whitespace collapsed, capped at 60 chars.
export function describeToolBrief(input) {
  const i = input && typeof input === 'object' ? input : {};
  const detail = i.command || i.description || i.pattern || i.path || i.file_path || i.query || i.cmd || i.name || '';
  return String(detail).replace(/\s+/g, ' ').trim().slice(0, 60);
}

export function createRunner({ bot, providerConfig, log, escalationMs = DEFAULT_ESCALATION_MS } = {}) {
  const pc = providerConfig ?? {};
  const profile = pc.profile || `wecom-${bot?.id ?? 'bot'}`;
  const dshBin = pc.dshBin || 'dsh';
  // 前身 Bridge constructor semantics: a literal apiKey is injected as the
  // provider's apiKeyEnv var (the profile's gateway route resolves it).
  const extraEnv = {};
  const m = pc.model;
  if (m && m.apiKey && m.apiKeyEnv) extraEnv[m.apiKeyEnv] = m.apiKey;
  const logger = log ?? console;

  function run({ prompt, sessionId, signal, timeoutMs, onEvent } = {}) {
    return new Promise((resolve) => {
      const finish = (payload) => resolve(payload); // a Promise settles once; no guard needed

      // Abort-before-spawn fast path: nothing was created, so there is no
      // session to hand back either.
      if (signal?.aborted) {
        finish({
          ok: false, code: 'aborted', finalText: '', aborted: true, sessionId: null,
          reason: 'signal already aborted', error: null, detail: { exitCode: null, stderrTail: '' },
        });
        return;
      }

      const args = ['--profile', profile, '--json'];
      if (sessionId) args.push('--session-id', String(sessionId));
      args.push('-');

      let child;
      try {
        child = spawn(dshBin, args, {
          cwd: pc.cwd || undefined,
          env: { ...process.env, ...extraEnv },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        finish({
          ok: false, code: 'error', finalText: '', aborted: false, sessionId: sessionId ?? null,
          reason: null, error: err?.message ?? String(err), detail: { exitCode: null, stderrTail: '' },
        });
        return;
      }

      logger.debug?.(`dsh spawn ${dshBin} ${args.join(' ')} (cwd=${pc.cwd}) pid=${child.pid}`);

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
          logger.warn?.('dsh onEvent callback threw:', e?.message ?? e);
        }
      };

      let stdoutBuf = '';
      const onLine = (line) => {
        if (done || !line.trim()) return;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          logger.debug?.('dsh stdout non-json:', line.slice(0, 200));
          return;
        }
        switch (ev.type) {
          case 'session':
            sawSessionEvent = true;
            if (ev.sessionId) state.sessionId = ev.sessionId;
            emit({ type: 'session', sessionId: ev.sessionId ?? null });
            break;
          case 'status':
            // rc.5 carries the turn outcome on a status{phase:'turn_end'}
            // event, NOT on `final` — capture it here (ported comment).
            if (ev.reason && ev.reason.kind) state.reason = ev.reason;
            if (ev.phase === 'step_start' || ev.phase === 'step_end') {
              emit({ type: 'step', n: ev.step, phase: ev.phase });
            }
            break;
          case 'tool_call': {
            // dsh versions name the field `tool` or `name`; both are accepted.
            const name = ev.name ?? ev.tool ?? 'tool';
            emit({ type: 'tool', name, brief: describeToolBrief(ev.input) });
            break;
          }
          case 'thinking':
            emit({ type: 'thinking', text: typeof ev.text === 'string' ? ev.text : '' });
            break;
          case 'text':
            if (typeof ev.text === 'string') state.finalText = ev.text;
            emit({ type: 'text', text: typeof ev.text === 'string' ? ev.text : '' });
            break;
          case 'final':
            if (typeof ev.text === 'string' && ev.text) state.finalText = ev.text;
            // older builds put the reason on final; prefer status-derived
            if (ev.reason && ev.reason.kind && !state.reason) state.reason = ev.reason;
            if (ev.sessionId) {
              state.sessionId = ev.sessionId;
              sawSessionEvent = true;
            }
            break; // final is bookkeeping, not a unified event (前身 skipped it too)
          case 'error':
            state.error = ev.message || 'error event';
            break;
          default:
            break; // unknown events degrade silently (§5.1 宽松解析)
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
        for (const l of s.split(/\r?\n/)) if (l.trim()) logger.debug?.('dsh stderr:', l.trim());
      });

      // ---- kill escalation: SIGTERM first, SIGKILL after escalationMs ----
      let escalationTimer = null;
      const startKill = () => {
        if (done) return;
        try { child.kill('SIGTERM'); } catch { /* already dead: close will fire */ }
        if (escalationTimer == null) {
          escalationTimer = setTimeout(() => {
            if (done) return;
            logger.warn?.(`dsh pid=${child.pid} survived SIGTERM +${escalationMs}ms — SIGKILL`);
            try { child.kill('SIGKILL'); } catch { /* racing exit */ }
          }, escalationMs);
        }
      };

      const onAbort = () => {
        abortedBySignal = true;
        logger.warn?.(`dsh pid=${child.pid} aborted by signal — SIGTERM`);
        startKill();
      };
      signal?.addEventListener?.('abort', onAbort, { once: true });

      let timeoutTimer = null;
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          logger.warn?.(`dsh pid=${child.pid} timed out after ${timeoutMs}ms — killing`);
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
        const errText = [state.error, state.stderrTail, state.reason?.error?.message].filter(Boolean).join('\n');
        let code;
        if (aborted) code = 'aborted';
        else if (timedOut) code = 'timeout';
        else if (ok) code = 'completed';
        else if (LOCK_CONFLICT_RE.test(errText)) code = 'lock-conflict';
        else if (MISSING_CREDENTIAL_RE.test(errText)) code = 'missing-credential';
        else code = 'error';
        // §5 abort 处置: a run killed before the CLI ever emitted its session
        // event leaves a half-written session — hand back NO id. A resume that
        // got no echo (e.g. lock failure) still returns the INPUT id: the
        // session already exists, that IS the id to pass back next turn.
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
        // error event that arrived on stdout first.
        state.error = state.error || err.message;
        cleanup();
        finish(buildResult(null));
      });

      child.on('close', (code) => {
        if (stdoutBuf.trim()) onLine(stdoutBuf); // trailing line without \n
        cleanup();
        logger.info?.(`dsh close pid=${child.pid} code=${code} reason=${state.reason?.kind || '-'}`);
        finish(buildResult(code));
      });

      // Feed the task on stdin (the whole prompt; trailing newline not needed).
      child.stdin.on('error', () => { /* EPIPE when the child died first — close/error reports it */ });
      try {
        child.stdin.write(prompt ?? '');
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
