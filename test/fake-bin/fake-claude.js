#!/usr/bin/env node
// Programmable fake `claude` CLI (M2 Task 2) — the actor half of the provider
// port contract suite for plugins/provider-claude, mirroring fake-dsh.js: one
// script plays every role the §5 contract needs, selected by env FAKE_MODE
// (default 'ok'), emitting CLAUDE stream-json shapes as captured from a real
// `claude -p --output-format stream-json --verbose` (test/probe-baselines/
// claude-resume.ndjson + claude-thinking.ndjson, claude 2.1.318):
//   system/init {type:'system', subtype:'init', session_id, cwd, model, …}
//   system/thinking_tokens — token-count noise bursts the runner must skip
//   assistant {type:'assistant', message:{content:[{type:'text'|'thinking'|
//             'tool_use', …}]}, session_id, …}  (thinking payload in .thinking)
//   result   {type:'result', subtype:'success'|'error_during_execution'|…,
//             is_error, result, session_id, …}  (final text in .result)
// Prompt arrives on STDIN (the provider pipes it; `claude -p` reads stdin when
// no positional prompt is given — verified against the real CLI).
//
// Modes:
//   ok            init + tool_use(Bash ls) + text + result success, exit 0
//   thinking      init + thinking_tokens noise + thinking block + text +
//                 result success (payload in .thinking, no .text — real shape)
//   lock          stderr session-locked text + result error, exit 1.
//                 NOTE: the exact conflict wording of real claude is UNKNOWN
//                 until M3 real-CLI validation; this text is invented to be
//                 plausible and the runner's lock regex carries a generic
//                 fallback (see runner.js LOCK_CONFLICT_RE).
//   credential    stderr ANTHROPIC_API_KEY hint + result error, exit 1
//   hang-sigterm  init + partial text, then SIGTERM is ignored — dies only on
//                 SIGKILL (kill-escalation contract)
//   hang-timeout  init, then hangs — SIGTERM default-kills it
//   partial-abort init + partial text; on SIGTERM emits a result event and
//                 exits 0 (abort carries partial output)
//   resume-echo   ok, but a `--resume <id>` in argv is echoed as the
//                 session_id (real claude re-emits the SAME id — T1 proven)
//
// Side files under $FAKE_HOME (written only when FAKE_HOME is set), same
// contract as fake-dsh: last-prompt (raw stdin), last-argv, last-pid.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MODE = process.env.FAKE_MODE || 'ok';
const HOME = process.env.FAKE_HOME;
const argv = process.argv.slice(2);

if (HOME) {
  mkdirSync(HOME, { recursive: true });
  // pid first: the suite may poll this file while we are still draining stdin
  writeFileSync(join(HOME, 'last-pid'), `${process.pid}\n`);
  writeFileSync(join(HOME, 'last-argv'), `${argv.join(' ')}\n`);
}

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
// A reader that walks away early must not crash us with an unhandled EPIPE —
// exit quietly, exactly like a C CLI dying on SIGPIPE would.
process.stdout.on('error', (err) => {
  if (err?.code === 'EPIPE') process.exit(0);
  throw err;
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A no-op interval keeps the event loop alive through the hang modes.
const hang = () => setInterval(() => {}, 1 << 30);
const freshSid = () => randomUUID();
const now = () => new Date().toISOString();

const sessionIdFromArgv = () => {
  const i = argv.indexOf('--resume');
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : null;
};

// Shared stream-json pieces. `extraBlocks` are appended to the assistant
// turn before the text block; the final result carries `resultText`.
async function happyStream(resultText, extraBlocks = []) {
  const sid = (MODE === 'resume-echo' && sessionIdFromArgv()) || freshSid();
  emit({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sid, tools: ['Bash', 'Read', 'Edit'], model: 'fake-model', permissionMode: 'default' });
  await sleep(50);
  if (extraBlocks.length > 0) {
    emit({
      type: 'assistant', parent_tool_use_id: null, session_id: sid, timestamp: now(),
      message: { id: 'msg_fake_1', type: 'message', role: 'assistant', model: 'fake-model', content: extraBlocks, stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } },
    });
    await sleep(50);
  }
  emit({
    type: 'assistant', parent_tool_use_id: null, session_id: sid, timestamp: now(),
    message: { id: 'msg_fake_2', type: 'message', role: 'assistant', model: 'fake-model', content: [{ type: 'text', text: resultText }], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 2 } },
  });
  await sleep(50);
  emit({
    type: 'result', subtype: 'success', is_error: false, result: resultText,
    session_id: sid, num_turns: 1, duration_ms: 150, total_cost_usd: 0,
    usage: { input_tokens: 10, output_tokens: 2 }, uuid: randomUUID(),
  });
}

// tool_use block shaped like a real one (name + structured input) — the
// runner's describeTool heuristic must find `ls -la` inside .input.command.
const BASH_LS = { type: 'tool_use', id: 'call_fake_ls', name: 'Bash', input: { command: 'ls -la', description: '列出当前目录' } };

async function main() {
  // Drain ALL of stdin first (the prompt); stored raw for suite assertions.
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  if (HOME) writeFileSync(join(HOME, 'last-prompt'), Buffer.concat(chunks));

  switch (MODE) {
    case 'ok':
    case 'resume-echo': // happyStream echoes the --resume id when present
      await happyStream('答案文本', [BASH_LS]);
      process.exitCode = 0;
      return;
    case 'thinking': {
      const sid = freshSid();
      emit({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sid, model: 'fake-thinking-model' });
      await sleep(50);
      // Real claude floods system/thinking_tokens estimates between blocks —
      // the runner must degrade them silently, never map them to thinking.
      for (const n of [1, 3, 5, 7]) {
        emit({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: n, estimated_tokens_delta: 1, session_id: sid, uuid: randomUUID() });
        await sleep(20);
      }
      await sleep(30);
      emit({
        type: 'assistant', session_id: sid, timestamp: now(),
        message: {
          id: 'msg_fake_think', type: 'message', role: 'assistant', model: 'fake-thinking-model',
          // real shape: payload in .thinking, NO .text field (T1 baseline)
          content: [{ type: 'thinking', thinking: '好的，让我先想一下这个问题。', signature: 'fake-sig' }],
          stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 },
        },
      });
      await sleep(50);
      emit({
        type: 'assistant', session_id: sid, timestamp: now(),
        message: { id: 'msg_fake_think2', type: 'message', role: 'assistant', model: 'fake-thinking-model', content: [{ type: 'text', text: '答案文本' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 2 } },
      });
      await sleep(50);
      emit({ type: 'result', subtype: 'success', is_error: false, result: '答案文本', session_id: sid, num_turns: 1 });
      process.exitCode = 0;
      return;
    }
    case 'lock': {
      // Invented conflict text (real wording unknown until M3): the runner's
      // LOCK_CONFLICT_RE must match this AND carry a generic fallback. No
      // init/result session_id here — a locked session mints no id, which is
      // exactly the no-echo shape (runner must return the INPUT id).
      const msg = 'Error: session "abc123" is locked by another process (another claude instance holds the session lock); wait for it to finish before resuming';
      process.stderr.write(`${msg}\n`);
      emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: msg, num_turns: 0 });
      process.exitCode = 1;
      return;
    }
    case 'credential': {
      const msg = 'Error: Missing credentials. Please set ANTHROPIC_API_KEY (or configure authentication via ANTHROPIC_AUTH_TOKEN) and retry.';
      process.stderr.write(`${msg}\n`);
      emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: msg, num_turns: 0 });
      process.exitCode = 1;
      return;
    }
    case 'hang-sigterm': {
      const sid = freshSid();
      emit({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sid, model: 'fake-model' });
      await sleep(50);
      emit({
        type: 'assistant', session_id: sid, timestamp: now(),
        message: { id: 'msg_fake_h', type: 'message', role: 'assistant', model: 'fake-model', content: [{ type: 'text', text: '部分输出' }], stop_reason: null, stop_sequence: null, usage: {} },
      });
      process.on('SIGTERM', () => {}); // swallow SIGTERM: only SIGKILL ends this
      hang();
      return;
    }
    case 'hang-timeout':
      emit({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: freshSid(), model: 'fake-model' });
      hang(); // no SIGTERM handler → default termination
      return;
    case 'partial-abort': {
      const sid = freshSid();
      emit({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sid, model: 'fake-model' });
      await sleep(50);
      emit({
        type: 'assistant', session_id: sid, timestamp: now(),
        message: { id: 'msg_fake_p', type: 'message', role: 'assistant', model: 'fake-model', content: [{ type: 'text', text: '部分输出' }], stop_reason: null, stop_sequence: null, usage: {} },
      });
      process.on('SIGTERM', () => {
        // A killed real claude flushes a result event before dying; the
        // runner must keep the partial text and mark the run aborted.
        emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '部分输出', session_id: sid, num_turns: 1 });
        // Exit from the write callback: process.exit right after a pipe write
        // can drop the line (same lesson as fake-dsh).
        process.stdout.write('', () => process.exit(0));
        setTimeout(() => process.exit(0), 200).unref();
      });
      hang();
      return;
    }
    default:
      process.stderr.write(`fake-claude: unknown FAKE_MODE '${MODE}'\n`);
      process.exitCode = 2;
  }
}

main().catch((err) => {
  process.stderr.write(`fake-claude: ${err?.stack ?? err}\n`);
  process.exitCode = 1;
});
