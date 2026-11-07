// Pi provider runner: the fourth REAL provider behind the §5 port contract,
// ported from the contract-proven provider-dsh/provider-claude/
// provider-codex runners (复制即契约 — spawn/NDJSON/kill-escalation/code
// mapping/abort semantics are identical; ONLY the CLI invocation and event
// parsing differ).
// What changes for pi (facts verified 2026-11-07 against
// @earendil-works/pi-coding-agent 1.5.0 via a magpie-gateway live probe,
// captured in test/probe-baselines/pi.ndjson + pi-resume-stdin.ndjson):
//   - spawn `pi -p --mode json` with the task on STDIN (no positional prompt
//     arg needed — print mode reads stdin when no prompt arguments are
//     given, probe-proven on fresh AND resume legs),
//   - resume is the SAME argv plus `--session <id>` (partial or full uuid
//     accepted); the first `session` event re-emits the SAME id (baseline
//     leg2) — thread continuity proven,
//   - `$PI_CODING_AGENT_DIR` redirects pi's whole agent dir (models.json /
//     auth.json / sessions/) — per-bot isolation lives there; the runner
//     injects it when providerConfig.piAgentDir is set,
//   - the event stream maps session/agent_start/turn_start/message_start|
//     update|end/turn_end/agent_end/agent_settled/auto_retry_*; assistant
//     message content blocks are text/thinking/toolCall; toolResult arrives
//     as its own message (ignored — a failed tool call is normal flow),
//   - text accumulates from message_update text_delta events AND is
//     overwritten by each assistant message_end (the complete message is
//     authoritative; the last turn's text is the final answer),
//   - SUCCESS = exit 0 AND the last assistant message_end stopReason==='stop'
//     (⚠️ pi EXITS 0 on total model failure — dead gateway probe: the stream
//     carries assistant message_end stopReason:'error' with empty content
//     plus auto_retry_start ×3 / auto_retry_end{success:false, finalError};
//     the error text lives ONLY in those events, never on stderr),
//   - gateway routing: models.json (materialized per bot) declares the
//     provider with baseUrl/api and an `$ENV` apiKey reference; the key
//     literal is injected under apiKeyEnv (default PI_MAGPIE_API_KEY) —
//     ⚠️ the magpie gateway does not enforce caller auth on localhost
//     (verified: wrong/missing keys are accepted), so a live
//     missing-credential shape is UNVERIFIED; the mapping is regex + fake
//     layer, same closure path as codex's unknown lock wording.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readHistory } from './history.js';
import { piAgentDirFor } from './models.js';

// pi's session-conflict wording is UNKNOWN (no two-process session contention
// observed on 1.5.0); the patterns are the generic shapes the other runners
// carry plus pi-flavored 'session lock' wording, so an unseen-but-obvious
// lock text still maps. Keep fake-pi's lock text and this regex co-validated
// (changing either means changing both). Unify against REAL wording once an
// actual conflict is observed.
const LOCK_CONFLICT_RE = /session is locked|locked by another (?:codex |pi |process|instance)|session lock|(?:thread|session).*already in use|IsolationError|another (?:process|instance).*(?:thread|session)/i;
const MISSING_CREDENTIAL_RE = /PI_[A-Z_]*API_KEY|MAGPIE_API_KEY|missing credential|invalid api key|unauthorized|authentication|401/i;
const DEFAULT_ESCALATION_MS = 3000;
const STDERR_TAIL_CHARS = 4000;

// The 前身 describeTool heuristic (provider-dsh/provider-claude/
// provider-codex runners): first meaningful input field wins (url||command||
// description||query||path||file_path||pattern||cmd||name), whitespace
// collapsed, capped at 60.
export function describeToolBrief(input) {
  const i = input && typeof input === 'object' ? input : {};
  const detail = i.url || i.command || i.description || i.query || i.path || i.file_path || i.pattern || i.cmd || i.name || '';
  return String(detail).replace(/\s+/g, ' ').trim().slice(0, 60);
}

// pi built-in tool names → the unified tool-event labels the other providers
// use (codex: command_execution→'Bash', file_change→'文件修改', …). Unknown
// (extension) names pass through capitalized so a new tool never renders
// empty.
const TOOL_LABELS = { bash: 'Bash', read: '读取', edit: '编辑', write: '写入' };
export const toolLabel = (name) => TOOL_LABELS[String(name ?? '').toLowerCase()]
  || (String(name ?? 'tool').charAt(0).toUpperCase() + String(name ?? 'tool').slice(1));

export function createRunner({ bot, providerConfig, assets, log, escalationMs = DEFAULT_ESCALATION_MS } = {}) {
  const pc = providerConfig ?? {};
  const piBin = pc.piBin || 'pi';
  // Asset faces (DESIGN-ASSETS §3.3, W3 T2): `assets` = effective plan with
  // file targets (core-engine enrich). F19: --skill and --append-system-prompt
  // are REPEATABLE — one flag pair per asset, binding order, operator prompt
  // first (拼接序通则). Memory: the wao-memory.md target file is READ HERE and
  // its TEXT appended (the design's V3 fallback — no dependence on pi's
  // file-form flag semantics; a missing/unreadable file degrades to a note).
  const assetFlags = [];
  for (const entry of Array.isArray(assets) ? assets : []) {
    if (entry?.type === 'skill' && typeof entry.target === 'string') {
      assetFlags.push('--skill', entry.target);
    } else if (entry?.type === 'prompt') {
      assetFlags.push('--append-system-prompt', String(entry.content?.text ?? ''));
    } else if (entry?.type === 'memory' && typeof entry.target === 'string') {
      let text = null;
      try { text = readFileSync(entry.target, 'utf8'); } catch { text = null; }
      if (text != null) assetFlags.push('--append-system-prompt', text);
    } else if (entry?.type === 'tool' && entry?.content?.kind === 'ripgrep') {
      assetFlags.push('--append-system-prompt', [
        '代码检索一律使用 rg（ripgrep）而非 grep/find。示例：rg -t js \'pattern\'、rg -n "text" src/。',
        'rg 未安装时先执行：brew install ripgrep。',
        ...(entry.content.options?.extraHints ? [String(entry.content.options.extraHints)] : []),
      ].join('\n'));
    }
  }
  // Credential env (M2 constraint, codex pattern): a model-declared apiKey
  // literal is injected under apiKeyEnv; models.json (materialized per bot)
  // references it as "$<apiKeyEnv>" — the literal never lands on disk or
  // argv. Explicit providerConfig.env always wins over the model-derived
  // value.
  const extraEnv = {};
  const m = pc.model;
  if (m && typeof m === 'object' && m.apiKey) {
    extraEnv[m.apiKeyEnv || pc.apiKeyEnv || 'PI_MAGPIE_API_KEY'] = m.apiKey;
  }
  // The agent dir must reach the CLI: pi honors $PI_CODING_AGENT_DIR for
  // models.json/auth.json AND the sessions/ tree the history reader walks.
  // ALWAYS inject it — when providerConfig.piAgentDir is unset the
  // materializer wrote models.json into the per-bot default
  // (~/.pi/agent-wao-<botId>, same formula in models.js) and pi must look
  // THERE, not at the user's own ~/.pi/agent (blind-review P0: a UI-created
  // bot without explicit piAgentDir saw no gateway and died with `Model not
  // found`, exit 1). One source of truth for the default: models.js.
  extraEnv.PI_CODING_AGENT_DIR = pc.piAgentDir || piAgentDirFor({ botId: bot?.id });
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

      // Fresh AND resume legs share one argv shape; the resume leg adds
      // `--session <id>` (partial uuid accepted, baseline-proven). Asset
      // flags ride after the provider's own knobs, binding order.
      const args = ['-p', '--mode', 'json'];
      if (sessionId) args.push('--session', String(sessionId));
      if (pc.thinking && pc.thinking !== 'off') args.push('--thinking', String(pc.thinking));
      if (pc.provider) args.push('--provider', String(pc.provider));
      if (m?.model) args.push('--model', String(m.model));
      if (Array.isArray(pc.piArgs)) {
        for (const entry of pc.piArgs) args.push(String(entry));
      }
      if (typeof pc.prompt === 'string' && pc.prompt !== '') args.push('--append-system-prompt', pc.prompt);
      for (const f of assetFlags) args.push(f);

      let child;
      try {
        child = spawn(piBin, args, {
          cwd: pc.cwd || undefined,
          env: { ...process.env, ...extraEnv, ...(pc.env && typeof pc.env === 'object' ? pc.env : {}) },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        finish({
          ok: false, code: 'error', finalText: '', aborted: false, sessionId: sessionId ?? null,
          reason: null, error: err?.message ?? String(err), detail: { exitCode: null, stderrTail: '' },
        });
        return;
      }

      logger.debug?.(`pi spawn ${piBin} ${args.join(' ')} (cwd=${pc.cwd}) pid=${child.pid}`);

      const state = {
        sessionId: sessionId ?? null, finalText: '', reason: null, error: null, stderrTail: '',
        finalStopReason: null, usage: null,
      };
      let sawSessionEvent = false; // the CLI emitted/minted a session
      let abortedBySignal = false;
      let timedOut = false;
      let done = false; // after close: no more events, no more kills

      const emit = (ev) => {
        if (done || typeof onEvent !== 'function') return;
        try {
          onEvent(ev);
        } catch (e) {
          logger.warn?.('pi onEvent callback threw:', e?.message ?? e);
        }
      };

      // One assistant message_end → unified events. Real 1.5.0 shapes (see
      // file header for sources); unknown block kinds degrade silently
      // (§5.1 宽松解析) so a newer pi block type never breaks a turn.
      const onAssistantEnd = (message) => {
        const content = Array.isArray(message.content) ? message.content : [];
        for (const block of content) {
          if (block == null || typeof block !== 'object') continue;
          switch (block.type) {
            case 'text':
              if (typeof block.text === 'string' && block.text !== '') {
                emit({ type: 'text', text: block.text });
              }
              break;
            case 'thinking':
              emit({ type: 'thinking', text: typeof block.thinking === 'string' ? block.thinking : (typeof block.text === 'string' ? block.text : '') });
              break;
            case 'toolCall':
              emit({ type: 'tool', name: toolLabel(block.name), brief: describeToolBrief(block.arguments) });
              break;
            default:
              break; // future block kinds degrade silently
          }
        }
        if (typeof message.stopReason === 'string') state.finalStopReason = message.stopReason;
        // The error text rides HERE for non-retried failures (gateway 404 on
        // an unknown model — probe 2026-11-07): pi skips auto_retry for
        // non-retryable errors, leaves content [] AND stderr empty, and puts
        // the message in message_end.errorMessage. Without this the user sees
        // a bare 「运行结束：failed」 with zero diagnosis.
        if (typeof message.errorMessage === 'string' && message.errorMessage !== '') {
          state.error = state.error || message.errorMessage;
        }
        if (message.usage && typeof message.usage === 'object') {
          // pi's dialect (probe-baselines/pi.ndjson): {input, output, cacheRead,
          // cacheWrite, totalTokens, cost:{…, total}} — cacheRead and cost.total
          // ride along so the observability layer sees the full picture (cost is
          // carried, never priced into the ledger — user decision).
          state.usage = {
            inputTokens: message.usage.input ?? null,
            outputTokens: message.usage.output ?? null,
            cacheReadTokens: message.usage.cacheRead ?? null,
            cost: message.usage.cost?.total ?? null,
          };
        }
      };

      let stdoutBuf = '';
      const onLine = (line) => {
        if (done || !line.trim()) return;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          logger.debug?.('pi stdout non-json:', line.slice(0, 200));
          return;
        }
        switch (ev.type) {
          case 'session':
            // The first event carries the session id; a resume re-emits the
            // SAME id (baseline leg2 — thread continuity proven).
            sawSessionEvent = true;
            if (ev.id) state.sessionId = ev.id;
            emit({ type: 'session', sessionId: ev.id ?? null });
            break;
          case 'message_update': {
            // Streaming deltas: accumulate text so an abort keeps the partial
            // output; thinking/toolCall deltas degrade (the message_end is
            // authoritative for all block kinds).
            const delta = ev.assistantMessageEvent;
            if (ev.message?.role === 'assistant' && delta?.type === 'text_delta' && typeof delta.delta === 'string' && delta.delta !== '') {
              state.finalText += delta.delta;
              emit({ type: 'text', text: delta.delta });
            }
            break;
          }
          case 'message_end':
            if (ev.message?.role === 'assistant') {
              // The complete message is authoritative: overwrite the
              // accumulated deltas with ITS text blocks (the last turn's
              // text is the final answer).
              const content = Array.isArray(ev.message.content) ? ev.message.content : [];
              const text = content
                .filter((b) => b?.type === 'text' && typeof b.text === 'string')
                .map((b) => b.text)
                .join('\n');
              if (text !== '') state.finalText = text;
              onAssistantEnd(ev.message);
            }
            break;
          case 'auto_retry_end':
            // The failure verdict lives ONLY here (stopReason:'error' messages
            // carry empty content; stderr stays empty — dead-gateway probe).
            if (ev.success === false && typeof ev.finalError === 'string' && ev.finalError !== '') {
              state.error = state.error || ev.finalError;
            }
            break;
          case 'agent_settled':
            if (ev.aborted === true) logger.info?.('pi stream reports agent_settled{aborted:true}');
            break;
          default:
            break; // agent_start/turn_start/message_start/turn_end/agent_end/
          // auto_retry_start degrade silently (§5.1 宽松解析)
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
        for (const l of s.split(/\r?\n/)) if (l.trim()) logger.debug?.('pi stderr:', l.trim());
      });

      // ---- kill escalation: SIGTERM first, SIGKILL after escalationMs ----
      let escalationTimer = null;
      const startKill = () => {
        if (done) return;
        try { child.kill('SIGTERM'); } catch { /* already dead: close will fire */ }
        if (escalationTimer == null) {
          escalationTimer = setTimeout(() => {
            if (done) return;
            logger.warn?.(`pi pid=${child.pid} survived SIGTERM +${escalationMs}ms — SIGKILL`);
            try { child.kill('SIGKILL'); } catch { /* racing exit */ }
          }, escalationMs);
        }
      };

      const onAbort = () => {
        abortedBySignal = true;
        logger.warn?.(`pi pid=${child.pid} aborted by signal — SIGTERM`);
        startKill();
      };
      signal?.addEventListener?.('abort', onAbort, { once: true });

      let timeoutTimer = null;
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          logger.warn?.(`pi pid=${child.pid} timed out after ${timeoutMs}ms — killing`);
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
        // pi exits 0 even on total model failure — success needs the stream
        // verdict (last assistant message_end stopReason==='stop') too.
        const ok = exitCode === 0 && state.finalStopReason === 'stop' && !aborted && !timedOut;
        // Startup-level failures (bad --model, no session found, missing
        // config) never reach the stream: pi exits 1 with the reason ONLY on
        // stderr. Surface the first meaningful stderr line as state.error —
        // describeError's copy has nothing real to say otherwise (blind-review
        // P0: the user saw a bare 「pi 运行结束：failed」 for a Model-not-found).
        if (!ok && !state.error && state.stderrTail.trim() !== '') {
          state.error = state.stderrTail
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l !== '')
            .filter((l) => !/^warning:/i.test(l))
            .slice(-3)
            .join('\n');
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
        // that got no echo (e.g. lock failure) still returns the INPUT id:
        // the session already exists, that IS the id to pass back next turn.
        let outSessionId = state.sessionId;
        if ((aborted || timedOut) && !sawSessionEvent) outSessionId = null;
        return {
          ok,
          code,
          finalText: state.finalText,
          aborted,
          sessionId: outSessionId,
          reason: ok
            ? { kind: 'completed', usage: state.usage }
            : { kind: 'failed', usage: state.usage },
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
        logger.info?.(`pi close pid=${child.pid} code=${code} stop=${state.finalStopReason ?? '-'}`);
        finish(buildResult(code));
      });

      // Feed the task on stdin (the whole prompt; print mode reads stdin on
      // every leg — fresh AND resume, probe-proven).
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
    // used); the engine/api passes the bot's providerConfig explicitly. The
    // per-bot default agent dir needs bot.id — the createRunner closure.
    readHistory: (cfg, sessionId) => readHistory(cfg ?? pc, sessionId, { botId: bot?.id }),
  };
}
