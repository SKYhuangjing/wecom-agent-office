// Claude provider runner (M2 Task 2): the second REAL provider behind the §5
// port contract, ported from the contract-proven provider-dsh runner (复制即
// 契约 — spawn/NDJSON/kill-escalation/code mapping/abort semantics are
// identical; ONLY the CLI invocation and event parsing differ). What changes
// for claude (facts from M2-T1 probe baselines, claude 2.1.318):
//   - spawn `claude -p --output-format stream-json --verbose`, prompt on
//     STDIN (verified: `-p` reads stdin when no positional prompt is given);
//     resume is `--resume <id>` and init re-emits the SAME session_id,
//   - events nest content blocks at ev.message.content[]:
//     text → {type:'text',text}, thinking → payload in .thinking (NOT .text),
//     tool_use → {name, input} (the 前身 describeTool heuristic applies to
//     input), while system/thinking_tokens estimate bursts degrade silently,
//   - the turn outcome lives on the result event: subtype 'success' + exit 0
//     is the ok path; error subtypes (error_during_execution/…) carry their
//     message in .result,
//   - gateway routing (M2 评审事实): model.baseURL → ANTHROPIC_BASE_URL and
//     model.apiKey → ANTHROPIC_AUTH_TOKEN (or model.apiKeyEnv); there is no
//     OPENAI_BASE_URL route for claude.
import { readFileSync } from 'node:fs';
import { spawnCli } from '../../src/kernel/spawn.js';
import { childEnv } from '../../src/kernel/safeEnv.js';
import { readHistory } from './history.js';

// ripgrep tool-asset guidance (§7.2) — byte-identical copy of the dsh/codex/pi
// guidance block (复制即契约: the four providers carry the same lines, the
// contract suite pins them equal). rgInstallHint 同样复制（P2 跨平台：
// brew/apt/winget·scoop 按平台）。
const rgInstallHint = (platform = process.platform) => platform === 'win32'
  ? 'winget install BurntSushi.ripgrep.MSVC（或 scoop install ripgrep）'
  : platform === 'linux' ? 'sudo apt-get install ripgrep（或你的发行版包管理器）'
    : 'brew install ripgrep';

const RIPGREP_GUIDANCE = [
  '代码检索一律使用 rg（ripgrep）而非 grep/find。示例：rg -t js \'pattern\'、rg -n "text" src/。',
  `rg 未安装时先执行：${rgInstallHint()}。`,
].join('\n');
const ripgrepAssetText = (entry) => [
  RIPGREP_GUIDANCE,
  ...(entry?.content?.options?.extraHints ? [String(entry.content.options.extraHints)] : []),
].join('\n');

// claude's exact session-conflict wording is UNKNOWN until M3 real-CLI
// validation; the patterns are plausible shapes plus a generic fallback so an
// unseen-but-obvious lock text still maps. Same incident class as dsh: two
// processes resuming one session file. `IsolationError` is a hedge (M2-T3):
// a distinct error-token shape seen in the wild for two-process session
// contention — kept alongside, NOT in fake-claude's lock text (the regex and
// the fake are co-validated; changing either means changing both). Unify all
// of this against the REAL wording once M3 observes an actual conflict.
const LOCK_CONFLICT_RE = /session is locked|locked by another (?:claude |process|instance)|session lock|SessionAlreadyOwnedError|IsolationError|another instance.*session|session.*already in use/i;
const MISSING_CREDENTIAL_RE = /ANTHROPIC_API_KEY|invalid api key|authentication|unauthorized/i;
// --resume 指向的 session 在 CLI 磁盘上不存在（2026-11-10 PC1 真机：bot 改过
// claudeConfigDir 后，缓存里的旧 session 仍留在 ~/.claude 一侧，resume 直接
// error_during_execution——用户只看到「任务未能完成」，且该会话永久坏掉）。
// 单独成码让引擎退役缓存 + fresh 重跑（自愈），而不是当普通错误吞掉。
const SESSION_MISSING_RE = /No conversation found with session ID|session .* not found|unknown session/i;
const DEFAULT_ESCALATION_MS = 3000;
const STDERR_TAIL_CHARS = 4000;

// stdin NDJSON 信封（DESIGN-MULTIMODAL Phase 1，决策 2026-11-10）：统一迁移
// —— 所有轮次都走 `--input-format stream-json` + 单条 user 消息信封，不按
// 「有无附件」分支。依据 probe 实证（test/probe-baselines/
// claude-streamjson-image.ndjson / -resume.ndjson）：init 腿与 resume 腿
//（`--resume <id>` + 信封 + base64 图片块）均 subtype=success 且 resume 的
// system/init 重发同一 session_id——会话延续与图片输入同时成立，纯文本信封
// 设计稿亦已实测。统一路径 = fake-claude 只需识别一种 stdin 形状，无混合
// 分支；`--input-format` 必须配 `--output-format stream-json`（argv 本就有）。
// 空文本（纯图消息）给占位说明，模型才知道用户意图。
// 盲评 P1-2/P2-1：读不到的图与 base64 总量超预算的图逐张跳过，并在 text
// 块尾追加注记行——静默跳过违反「拒绝优于静默丢」（原注释声称「engine 台账
// 可溯」并不成立：image 不进 prompt，模型与用户都不会知道少了图）。预算
//（base64 后 ≤9MB）是 engine MAX_IMAGE_BUDGET_BYTES 之外的同口径兜底
//（stdin 10MB 硬上限留余量）——engine 用信封里的 size 预扣，这里按真实
// base64 长度复核，防信封 size 造假或缺席。
const MAX_ENVELOPE_BASE64_BYTES = 9 * 1024 * 1024;
function buildEnvelope(prompt, attachments) {
  const skipped = [];
  const imageBlocks = [];
  const deliveredPaths = [];
  let budget = MAX_ENVELOPE_BASE64_BYTES;
  for (const a of Array.isArray(attachments) ? attachments : []) {
    if (a == null || typeof a !== 'object' || a.kind !== 'image') continue;
    // 无 path 的 image 条目=不可信信封（引擎侧「缺数字不配吃预算」的对称面，
    // 复测 P2-6）：同样进 skipped 注记，不留静默洞。
    if (typeof a.path !== 'string') { skipped.push(a); continue; }
    let data;
    try {
      data = readFileSync(a.path).toString('base64');
    } catch {
      // 引擎刚落盘的文件读不到（被清理/盘故障）：跳过该图并在下方注记
      // ——绝不静默，也绝不为此炸掉整轮文本。
      skipped.push(a);
      continue;
    }
    if (data.length > budget) {
      skipped.push(a);
      continue;
    }
    budget -= data.length;
    imageBlocks.push({
      type: 'image',
      source: { type: 'base64', media_type: a.mediaType ?? 'image/png', data },
    });
    deliveredPaths.push(a.path);
  }
  let text = typeof prompt === 'string' && prompt !== '' ? prompt : '（用户发来图片，无文字说明）';
  // 成功送达的图片附上本地路径注记（codex -i / pi @file 走 argv 天然对模型可见；
  // claude 的 base64 块不带路径——补齐三家的信息面对齐，供归档/转存类工具引用）。
  if (deliveredPaths.length > 0) {
    text += `\n（系统注记：图片附件已缓存到本地，路径：${deliveredPaths.join('；')}——需要归档/转存该图片时引用此路径。）`;
  }
  if (skipped.length > 0) {
    text += `\n\n（系统注记：有 ${skipped.length} 张图片未能送达（读取失败或图片总量超限）——请向用户说明，建议重发或分批发送。）`;
  }
  const content = [{ type: 'text', text }, ...imageBlocks];
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;
}

// The 前身 describeTool heuristic (wecom-bridge bridge.js / provider-dsh
// runner): first meaningful input field wins (command||description||pattern||
// path||file_path||query||cmd||name), whitespace collapsed, capped at 60.
export function describeToolBrief(input) {
  const i = input && typeof input === 'object' ? input : {};
  const detail = i.command || i.description || i.pattern || i.path || i.file_path || i.query || i.cmd || i.name || '';
  return String(detail).replace(/\s+/g, ' ').trim().slice(0, 60);
}

export function createRunner({ bot, providerConfig, assets, log, escalationMs = DEFAULT_ESCALATION_MS } = {}) {
  const pc = providerConfig ?? {};
  const claudeBin = pc.claudeBin || 'claude';
  // Asset faces (DESIGN-ASSETS §3.3, W3 T2): `assets` is the effective plan
  // (§3.1 createRunner extension, enriched with file targets by core-engine).
  // prompt/ripgrep assets ride --append-system-prompt CONCATENATED after the
  // operator prompt (拼接序通则：bot prompt 在前、资产按绑定序在后); the mcp
  // entry's target is the WAO-owned claude-mcp.json → --mcp-config (V7: the
  // flag overrides same-named user-scope servers).
  const assetPromptTexts = (Array.isArray(assets) ? assets : [])
    .filter((e) => e?.type === 'prompt' || (e?.type === 'tool' && e?.content?.kind === 'ripgrep'))
    .map((e) => (e.type === 'prompt' ? String(e.content?.text ?? '') : ripgrepAssetText(e)));
  const mcpConfigPath = (Array.isArray(assets) ? assets : []).find((e) => e?.type === 'mcp' && typeof e.target === 'string')?.target ?? null;
  // Gateway env (M2 constraint): a model-declared baseURL/apiKey routes the
  // child at the bot's gateway — ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN
  // (apiKeyEnv overrides the token's env name). Explicit providerConfig.env
  // always wins over the model-derived values.
  const extraEnv = {};
  const m = pc.model;
  if (m && typeof m === 'object') {
    if (m.baseURL) extraEnv.ANTHROPIC_BASE_URL = m.baseURL;
    if (m.apiKey) extraEnv[m.apiKeyEnv || 'ANTHROPIC_AUTH_TOKEN'] = m.apiKey;
  }
  // A redirected claudeConfigDir must reach the CLI too: claude honors
  // $CLAUDE_CONFIG_DIR for its config AND the projects/ session tree the
  // history reader walks — without this the CLI writes ~/.claude while
  // readHistory looks in the redirect (parity with codexHome in codex's runner).
  if (pc.claudeConfigDir) extraEnv.CLAUDE_CONFIG_DIR = pc.claudeConfigDir;
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

      // --input-format stream-json 与 --output-format stream-json 成对
      //（headless 约束）；stdin 载荷是 buildEnvelope 的 NDJSON 信封。
      const args = ['-p', '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json'];
      if (m?.model) args.push('--model', String(m.model));
      if (pc.permissionMode) args.push('--permission-mode', String(pc.permissionMode));
      if (Array.isArray(pc.allowedTools) && pc.allowedTools.length > 0) {
        args.push('--allowedTools', pc.allowedTools.map(String).join(','));
      }
      if (sessionId) args.push('--resume', String(sessionId));
      // ONE flag with the operator prompt + asset texts concatenated (\n\n) —
      // claude's --append-system-prompt takes a single string (F11).
      const promptText = [typeof pc.prompt === 'string' ? pc.prompt.trim() : '', ...assetPromptTexts.map((t) => t.trim())]
        .filter((t) => t !== '').join('\n\n');
      if (promptText !== '') args.push('--append-system-prompt', promptText);
      // --mcp-config LAST: the flag is variadic (<configs...>, §9 V7 probe ate
      // a following positional) — nothing may trail it.
      if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath);

      let child;
      try {
        // spawnCli: passthrough here, cmd.exe+escaping on Windows (P1 —
        // npm's .cmd shims EINVAL without a shell; see src/kernel/spawn.js).
        child = spawnCli(claudeBin, args, {
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

      logger.debug?.(`claude spawn ${claudeBin} ${args.join(' ')} (cwd=${pc.cwd}) pid=${child.pid}`);

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
          logger.warn?.('claude onEvent callback threw:', e?.message ?? e);
        }
      };

      // Map one assistant content block to a unified event. Real shapes
      // (T1 baselines): text carries .text; thinking carries the payload in
      // .thinking with NO .text; tool_use carries {name, input}.
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
          logger.debug?.('claude stdout non-json:', line.slice(0, 200));
          return;
        }
        switch (ev.type) {
          case 'system':
            // init carries the session_id (and a resume re-emits the SAME
            // id — T1 proven); thinking_tokens are estimate noise to skip.
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
          case 'result': {
            // The turn outcome: success (subtype + is_error + exit code) or
            // an error subtype whose message rides in .result.
            const okResult = ev.subtype === 'success' && ev.is_error !== true;
            state.reason = {
              kind: okResult ? 'completed' : (ev.subtype || 'error'),
              subtype: ev.subtype ?? null,
              numTurns: typeof ev.num_turns === 'number' ? ev.num_turns : null,
            };
            // Forward token usage to the engine's cost-tracker accumulator.
            // claude's result event carries usage in snake_case fields.
            if (ev.usage && typeof ev.usage === 'object') {
              emit({ type: 'usage', usage: ev.usage });
            }
            if (typeof ev.result === 'string' && ev.result !== '') {
              if (okResult) state.finalText = ev.result; // canonical final text
              else state.error = state.error || ev.result;
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
            break; // user/attachment/… events degrade silently (§5.1 宽松解析)
        }
      };

      child.stdout.on('data', (chunk) => {
        // abort 自愈（同 stderr 侧注释）：事件还在流=进程还活着，aborted 却没杀
        // 就是监听器漏了——补杀。真机 2026-11-10：熔断 abort 后 claude 又跑了
        // 13 分钟（无 SIGTERM 日志=监听器未触发），事件照流。
        if (signal?.aborted && !abortedBySignal) onAbort();
        stdoutBuf += chunk.toString();
        let idx;
        while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
          const line = stdoutBuf.slice(0, idx);
          stdoutBuf = stdoutBuf.slice(idx + 1);
          onLine(line);
        }
      });

      child.stderr.on('data', (chunk) => {
        // abort 自愈（2026-11-10 PC1 真机 P0）：熔断/drain 的 abort 若因时序问题
        // 没触发一次性监听器（进程照跑、事件照流），任何后续 stderr 数据在此补
        // 触发 kill——kill 不依赖监听器单点（startKill 幂等）。
        if (signal?.aborted && !abortedBySignal) onAbort();
        const s = chunk.toString();
        state.stderrTail = (state.stderrTail + s).slice(-STDERR_TAIL_CHARS);
        for (const l of s.split(/\r?\n/)) if (l.trim()) logger.debug?.('claude stderr:', l.trim());
      });

      // ---- kill escalation: SIGTERM first, SIGKILL after escalationMs ----
      let escalationTimer = null;
      const startKill = () => {
        if (done) return;
        try { child.kill('SIGTERM'); } catch { /* already dead: close will fire */ }
        if (escalationTimer == null) {
          escalationTimer = setTimeout(() => {
            if (done) return;
            logger.warn?.(`claude pid=${child.pid} survived SIGTERM +${escalationMs}ms — SIGKILL`);
            try { child.kill('SIGKILL'); } catch { /* racing exit */ }
          }, escalationMs);
        }
      };

      const onAbort = () => {
        abortedBySignal = true;
        logger.warn?.(`claude pid=${child.pid} aborted by signal — SIGTERM`);
        startKill();
      };
      signal?.addEventListener?.('abort', onAbort, { once: true });

      let timeoutTimer = null;
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          logger.warn?.(`claude pid=${child.pid} timed out after ${timeoutMs}ms — killing`);
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
        // error result that arrived on stdout first.
        state.error = state.error || err.message;
        cleanup();
        finish(buildResult(null));
      });

      child.on('close', (code) => {
        if (stdoutBuf.trim()) onLine(stdoutBuf); // trailing line without \n
        cleanup();
        logger.info?.(`claude close pid=${child.pid} code=${code} reason=${state.reason?.kind || '-'}`);
        finish(buildResult(code));
      });

      // Feed the task on stdin as the NDJSON user envelope (buildEnvelope 头注
      // 释：统一迁移，所有轮次同一路径；`claude -p --input-format stream-json`
      // 把每行 JSON 当一条 user 消息读入——probe 实证见 probe-baselines)。
      child.stdin.on('error', () => { /* EPIPE when the child died first — close/error reports it */ });
      try {
        child.stdin.write(buildEnvelope(prompt, attachments));
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
