// Codex provider runner (M2 Task 4): the third REAL provider behind the §5
// port contract, ported from the contract-proven provider-claude/provider-dsh
// runners (复制即契约 — spawn/NDJSON/kill-escalation/code mapping/abort
// semantics are identical; ONLY the CLI invocation and event parsing differ).
// What changes for codex (facts verified 2026-11-06 against codex-cli 0.166.0,
// captured in test/probe-baselines/codex*.ndjson + a fresh command-run probe):
//   - spawn `codex exec --json --skip-git-repo-check -` (the `-` prompt arg
//     reads the task from STDIN on EVERY leg); resume is the SUBCOMMAND form
//     `codex exec resume <id> --json --skip-git-repo-check -` and re-emits
//     thread.started with the SAME thread_id (baseline leg2/leg3, including
//     resume-of-resume),
//   - `-m <model>` on both legs; `-s <sandbox>` on FRESH legs only — the
//     resume subcommand rejects `-s` (`error: unexpected argument '-s' found`,
//     reproduced live), so a resume leg carries the sandbox as the verified
//     config override `-c sandbox_mode="…"` instead (strict-config-proven key;
//     silently DROPPING it would run resumed turns under a different policy),
//   - `-c key=value` config overrides: the value is parsed as TOML with a
//     raw-string fallback (`codex exec --help`); string values need TOML
//     quotes (`-c model="o3"` is the help's own example), so quotes are added
//     here unless the value is already TOML-shaped (number/bool/array/object),
//   - the event stream maps thread.started/item.completed{item}/turn.completed
//     /turn.failed; the 0.166.0 item tags are agent_message/reasoning/
//     command_execution/file_change/mcp_tool_call/web_search/todo_list (+ a
//     hedge for the `plan_update` spelling, which does NOT exist in 0.166.0 —
//     the plan item is `todo_list`; sources: baselines + a live command probe
//     + codex-rs/exec/src/exec_events.rs @ rust-v0.166.0),
//   - success = exit 0 AND turn.completed (DESIGN §5.1, ✅实测); the final
//     text is the LAST agent_message item (turn.completed carries usage only),
//   - gateway routing (M2 评审事实): `-c openai_base_url=…` via
//     configOverrides + credential env CODEX_API_KEY (apiKeyEnv overridable);
//     there is NO OPENAI_BASE_URL route for codex.
import { spawnCli } from '../../src/kernel/spawn.js';
import { childEnv } from '../../src/kernel/safeEnv.js';
import { readHistory } from './history.js';

// codex's exact thread-conflict wording is UNKNOWN until M3 real-CLI
// validation; the patterns are plausible shapes plus generic fallbacks so an
// unseen-but-obvious lock text still maps. Same incident class as dsh/claude:
// two processes resuming one thread/rollout. `IsolationError` is a hedge (a
// distinct error-token shape seen in the wild for two-process session
// contention) — kept alongside, NOT in fake-codex's lock text (the regex and
// the fake are co-validated; changing either means changing both). Unify all
// of this against the REAL wording once M3 observes an actual conflict.
const LOCK_CONFLICT_RE = /thread is locked|locked by another (?:codex |process|instance)|thread lock|SessionAlreadyOwnedError|IsolationError|another (?:process|instance).*thread|thread.*already in use/i;
const MISSING_CREDENTIAL_RE = /CODEX_API_KEY|OPENAI_API_KEY|invalid api key|unauthorized|authentication|missing credential/i;
// resume 目标的 thread 在磁盘已不存在（与 claude 的 session-not-found 同款
// 自愈通道：引擎退役缓存后 fresh 重跑一次；2026-11-10 教训）。
const SESSION_MISSING_RE = /no conversation found|session .* not found|thread .* not found|unknown (?:session|thread)/i;
const DEFAULT_ESCALATION_MS = 3000;
const STDERR_TAIL_CHARS = 4000;

// The 前身 describeTool heuristic (provider-dsh/provider-claude runners):
// first meaningful input field wins (url||command||description||query||path||
// file_path||pattern||cmd||name), whitespace collapsed, capped at 60.
export function describeToolBrief(input) {
  const i = input && typeof input === 'object' ? input : {};
  const detail = i.url || i.command || i.description || i.query || i.path || i.file_path || i.pattern || i.cmd || i.name || '';
  return String(detail).replace(/\s+/g, ' ').trim().slice(0, 60);
}

const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const brief = (s) => collapse(s).slice(0, 60);

// 图片附件 → argv 扇出面（DESIGN-MULTIMODAL Phase 2）：codex 用 `-i <path>`
//（0.166.0 `codex exec --help` 实证 flag 存在，fresh 与 resume 两腿同加）；
// file 附件不在此列——引擎已把文本内联/PDF·二进制路径提示进 prompt。
const imagePathsOf = (attachments) => (Array.isArray(attachments) ? attachments : [])
  .filter((a) => a != null && typeof a === 'object' && a.kind === 'image' && typeof a.path === 'string')
  .map((a) => a.path);

// One `key=value` config override → the argv value codex receives. codex
// parses the value as TOML and falls back to the raw string when that fails
// (`--help`), but the SAFEST wire form for strings is a TOML basic string
// (`-c model="o3"` — the help's own example): a bare URL/namespace survives
// only via the fallback, and values with spaces/#/quotes would corrupt it.
// Values that are already TOML-shaped (bool/number/array/object) pass raw so
// an operator can still send structured overrides like `x=["a","b"]`.
export function toCodexOverride(entry) {
  const raw = String(entry);
  const eq = raw.indexOf('=');
  if (eq <= 0) return raw; // malformed — validate() rejects this shape earlier
  const key = raw.slice(0, eq).trim();
  const value = raw.slice(eq + 1);
  const tomlShaped = /^(true|false|-?\d+(?:\.\d+)?)$/.test(value) || /^\[[\s\S]*\]$/.test(value) || /^\{[\s\S]*\}$/.test(value);
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return tomlShaped ? `${key}=${value}` : `${key}="${escaped}"`;
}

export function createRunner({ bot, providerConfig, log, escalationMs = DEFAULT_ESCALATION_MS } = {}) {
  const pc = providerConfig ?? {};
  const codexBin = pc.codexBin || 'codex';
  // Credential env (M2 constraint): a model-declared apiKey literal is
  // injected under apiKeyEnv (default CODEX_API_KEY — there is no
  // OPENAI_BASE_URL route for codex; the gateway base URL is a
  // configOverrides entry like openai_base_url="…"). Explicit
  // providerConfig.env always wins over the model-derived value.
  const extraEnv = {};
  const m = pc.model;
  if (m && typeof m === 'object' && m.apiKey) {
    extraEnv[m.apiKeyEnv || pc.apiKeyEnv || 'CODEX_API_KEY'] = m.apiKey;
  }
  // A redirected codexHome must reach the CLI too: codex honors $CODEX_HOME
  // for config.toml AND the sessions/ rollout tree the history reader walks.
  if (pc.codexHome) extraEnv.CODEX_HOME = pc.codexHome;
  const logger = log ?? console;

  function run({ prompt, sessionId, signal, timeoutMs, onEvent, attachments } = {}) {
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

      // Fresh leg: `exec --json --skip-git-repo-check -`.
      // Resume leg: `exec resume <id> --json --skip-git-repo-check -` — the
      // subcommand comes FIRST, the id is its positional (baseline leg2), and
      // the sandbox switches from -s to -c sandbox_mode=… (resume has no -s).
      const args = sessionId
        ? ['exec', 'resume', String(sessionId), '--json', '--skip-git-repo-check']
        : ['exec', '--json', '--skip-git-repo-check'];
      if (m?.model) args.push('-m', String(m.model));
      if (pc.sandbox) {
        if (sessionId) args.push('-c', toCodexOverride(`sandbox_mode=${pc.sandbox}`));
        else args.push('-s', String(pc.sandbox));
      }
      if (Array.isArray(pc.configOverrides)) {
        for (const entry of pc.configOverrides) args.push('-c', toCodexOverride(entry));
      }
      // 图片附件：-i <path> 可多值（fresh 与 resume 两腿同加，见 imagePathsOf
      // 注释）；放在 `-` 位置参数之前，flag 区不被位置参数截断。
      for (const p of imagePathsOf(attachments)) args.push('-i', p);
      args.push('-'); // prompt arrives on stdin

      let child;
      try {
        // spawnCli: passthrough here, cmd.exe+escaping on Windows (P1 —
        // npm's .cmd shims EINVAL without a shell; see src/kernel/spawn.js).
        child = spawnCli(codexBin, args, {
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

      logger.debug?.(`codex spawn ${codexBin} ${args.join(' ')} (cwd=${pc.cwd}) pid=${child.pid}`);

      const state = { sessionId: sessionId ?? null, finalText: '', reason: null, error: null, stderrTail: '' };
      let sawSessionEvent = false; // the CLI emitted/minted a thread.started
      let abortedBySignal = false;
      let timedOut = false;
      let done = false; // after close: no more events, no more kills

      const emit = (ev) => {
        if (done || typeof onEvent !== 'function') return;
        try {
          onEvent(ev);
        } catch (e) {
          logger.warn?.('codex onEvent callback threw:', e?.message ?? e);
        }
      };

      // Map one item.completed item to a unified event. Real 0.166.0 shapes
      // (see file header for sources); unknown kinds degrade silently
      // (§5.1 宽松解析) so a newer codex item type never breaks a turn.
      const onItem = (item) => {
        if (item == null || typeof item !== 'object') return;
        switch (item.type) {
          case 'reasoning':
            emit({ type: 'thinking', text: typeof item.text === 'string' ? item.text : '' });
            break;
          case 'agent_message':
            if (typeof item.text === 'string') state.finalText = item.text;
            emit({ type: 'text', text: typeof item.text === 'string' ? item.text : '' });
            break;
          case 'command_execution':
            emit({ type: 'tool', name: 'Bash', brief: brief(item.command) });
            break;
          case 'file_change': {
            const changes = Array.isArray(item.changes) ? item.changes : [];
            const paths = changes.map((c) => `${c?.kind ? `${c.kind} ` : ''}${c?.path ?? ''}`.trim()).join(', ');
            emit({ type: 'tool', name: '文件修改', brief: brief(paths) });
            break;
          }
          case 'mcp_tool_call': {
            const name = item.server && item.tool ? `${item.server}/${item.tool}` : (item.tool || 'mcp');
            emit({ type: 'tool', name, brief: describeToolBrief(item.arguments) });
            break;
          }
          case 'web_search':
            emit({ type: 'tool', name: 'WebSearch', brief: brief(item.query) });
            break;
          case 'todo_list': {
            const items = Array.isArray(item.items) ? item.items : [];
            const text = items.map((t) => `${t?.completed === true ? '[x] ' : ''}${t?.text ?? ''}`.trim()).join('；');
            emit({ type: 'tool', name: '计划', brief: brief(text) });
            break;
          }
          case 'plan_update':
            // Hedge spelling (0.166.0 has none — its plan item is todo_list):
            // an older/newer codex emitting plan_update still maps to 计划.
            emit({ type: 'tool', name: '计划', brief: brief(item.plan || item.text || '') });
            break;
          case 'error':
            // A non-fatal error surfaced as an item (ErrorItem{message}):
            // recorded for the error branch, no unified event of its own.
            state.error = state.error || (typeof item.message === 'string' ? item.message : '');
            break;
          default:
            break; // collab_tool_call and future kinds degrade silently
        }
      };

      let stdoutBuf = '';
      const onLine = (line) => {
        if (done || !line.trim()) return;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          logger.debug?.('codex stdout non-json:', line.slice(0, 200));
          return;
        }
        switch (ev.type) {
          case 'thread.started':
            // thread.started carries the thread_id, and a resume re-emits the
            // SAME id (baseline leg2/leg3 — thread continuity proven).
            sawSessionEvent = true;
            if (ev.thread_id) state.sessionId = ev.thread_id;
            emit({ type: 'session', sessionId: ev.thread_id ?? null });
            break;
          case 'item.completed':
            onItem(ev.item);
            break;
          case 'turn.completed':
            // The turn outcome: success = turn.completed + exit 0 (§5.1 实测).
            state.reason = {
              kind: 'completed',
              usage: ev.usage && typeof ev.usage === 'object' ? {
                inputTokens: ev.usage.input_tokens ?? null,
                outputTokens: ev.usage.output_tokens ?? null,
                // cached_input_tokens is the prompt-cache-read bucket (baseline
                // 3712 on the pinned probe) — same field the accumulator's
                // cacheReadTokens summary reads.
                cacheReadTokens: ev.usage.cached_input_tokens ?? null,
              } : null,
            };
            break;
          case 'turn.failed':
            state.reason = { kind: 'failed' };
            state.error = state.error || (ev.error?.message ?? 'turn failed');
            break;
          case 'error':
            // A stream-level error event ({message}); the turn may still fail
            // after it — record, never finalize from here.
            state.error = state.error || (ev.message ?? 'stream error');
            break;
          default:
            break; // turn.started/item.started/item.updated degrade silently
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
        for (const l of s.split(/\r?\n/)) if (l.trim()) logger.debug?.('codex stderr:', l.trim());
      });

      // ---- kill escalation: SIGTERM first, SIGKILL after escalationMs ----
      let escalationTimer = null;
      const startKill = () => {
        if (done) return;
        try { child.kill('SIGTERM'); } catch { /* already dead: close will fire */ }
        if (escalationTimer == null) {
          escalationTimer = setTimeout(() => {
            if (done) return;
            logger.warn?.(`codex pid=${child.pid} survived SIGTERM +${escalationMs}ms — SIGKILL`);
            try { child.kill('SIGKILL'); } catch { /* racing exit */ }
          }, escalationMs);
        }
      };

      const onAbort = () => {
        abortedBySignal = true;
        logger.warn?.(`codex pid=${child.pid} aborted by signal — SIGTERM`);
        startKill();
      };
      signal?.addEventListener?.('abort', onAbort, { once: true });

      let timeoutTimer = null;
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          logger.warn?.(`codex pid=${child.pid} timed out after ${timeoutMs}ms — killing`);
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
        const errText = [state.error, state.stderrTail].filter(Boolean).join('\n');
        let code;
        if (aborted) code = 'aborted';
        else if (timedOut) code = 'timeout';
        else if (ok) code = 'completed';
        else if (LOCK_CONFLICT_RE.test(errText)) code = 'lock-conflict';
        else if (MISSING_CREDENTIAL_RE.test(errText)) code = 'missing-credential';
        else if (SESSION_MISSING_RE.test(errText)) code = 'session-not-found';
        else code = 'error';
        // §5 abort 处置: a run killed before the CLI ever emitted its session
        // event leaves a half-written thread — hand back NO id. A resume that
        // got no echo (e.g. lock failure) still returns the INPUT id: the
        // thread already exists, that IS the id to pass back next turn.
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
        logger.info?.(`codex close pid=${child.pid} code=${code} reason=${state.reason?.kind || '-'}`);
        finish(buildResult(code));
      });

      // Feed the task on stdin (the whole prompt; the `-` positional arg makes
      // codex read it on every leg — fresh AND resume, baseline-proven).
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
