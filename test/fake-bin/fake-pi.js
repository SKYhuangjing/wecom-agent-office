#!/usr/bin/env node
// Programmable fake `pi` CLI — the actor half of the provider port contract
// suite for plugins/provider-pi, mirroring fake-dsh.js/fake-claude.js/
// fake-codex.js: one script plays every role the §5 contract needs, selected
// by env FAKE_MODE (default 'ok'), emitting pi 1.5.0 `--mode json` NDJSON
// shapes. Sources of truth (all verified 2026-11-07 against the real CLI,
// @earendil-works/pi-coding-agent 1.5.0, via a magpie-gateway live probe):
//   - probe baselines test/probe-baselines/pi.ndjson + pi-resume-stdin.ndjson
//     (the `session` event re-emits the SAME id on a --session resume leg;
//     prompt accepted on stdin on every leg),
//   - a fresh real run with a bash tool call (toolCall block + toolResult
//     message + a second turn — stopReason:'toolUse' drives the loop),
//   - a dead-gateway run (probe-err2): pi EXITS 0 on total model failure —
//     the stream carries assistant message_end stopReason:'error' (content [])
//     plus auto_retry_start ×N / auto_retry_end{success:false, finalError},
//     so runner success = exit 0 AND final stopReason==='stop'.
//
// Event set (1.5.0 -p --mode json): session{version,id,timestamp,cwd} /
// agent_start / turn_start / message_start|message_update|message_end
// (roles: system, user, assistant, toolResult) / turn_end{message,
// toolResults} / agent_end{messages} / agent_settled{aborted} /
// auto_retry_start{attempt,maxAttempts,delayMs,errorMessage} /
// auto_retry_end{success,attempt,finalError}. Assistant message content
// blocks: {type:'text',text} · {type:'thinking',thinking,thinkingSignature} ·
// {type:'toolCall',id,name,arguments}. toolResult message: {role:'toolResult',
// toolCallId,toolName,content:[{type:'text',text}],isError,durationMs}.
//
// Modes (isomorphic with fake-codex; the contract suite hardcodes the mode
// name 'thinking' for group 2):
//   ok            session + system/user echo + turn1 (text delta + toolCall
//                 bash ls + toolResult, stopReason:'toolUse') + turn2
//                 (text '答案文本', stopReason:'stop') + agent_end +
//                 agent_settled, exit 0
//   thinking      session + thinking block ('先想一下…') + text '答案文本',
//                 exit 0
//   lock          assistant message_end stopReason:'error' (content []) +
//                 auto_retry_end{success:false, finalError: invented
//                 session-lock text}, exit 0 — the REAL pi failure shape
//                 (exit 0 is NOT success; see probe-err2 above). Real pi's
//                 lock wording is UNKNOWN (no two-process lock observed);
//                 the runner's LOCK_CONFLICT_RE carries generic hedges.
//   credential    same failure shape, finalError mentions the missing key
//   hang-sigterm  session + text delta, then SIGTERM is ignored — dies only
//                 on SIGKILL (kill-escalation contract)
//   hang-timeout  session, then hangs — SIGTERM default-kills it
//   partial-abort session + text delta '部分输出' (message_update), then on
//                 SIGTERM flushes agent_settled{aborted:true} and exits 0 —
//                 abort carries the partial text (a real killed pi's flush
//                 behavior is unverified; the runner keeps accumulated deltas
//                 either way, so the contract locks the accumulation path)
//   resume-echo   ok, but the --session <id> value in argv is echoed as the
//                 session id (real pi re-emits the SAME id — baseline proven)
//
// Side files under $FAKE_HOME (written only when FAKE_HOME is set), same
// contract as fake-dsh/fake-claude/fake-codex: last-prompt (raw stdin),
// last-argv, last-pid.
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
  // env probe (runner test pin): $PI_CODING_AGENT_DIR must be present — the
  // runner ALWAYS injects it (per-bot default or explicit piAgentDir);
  // missing/empty = the runner pointed pi at the wrong agent dir.
  writeFileSync(join(HOME, 'last-env'), `${process.env.PI_CODING_AGENT_DIR ?? ''}\n`);
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

// The resume id rides as the --session flag value
// (`pi -p --mode json --session <partial-uuid> …` — baseline proven).
const sessionIdFromArgv = () => {
  const i = argv.indexOf('--session');
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : null;
};

// The harness preamble pi injects (system role, sections object) — the real
// shape's message_start/message_end pair for role 'system'. The runner treats
// system/user messages as noise, so a compact stand-in with the REAL key
// layout (sections) suffices.
const systemMessage = () => ({ role: 'system', content: '', sections: { preamble: 'You are a coding assistant running inside pi, a coding agent harness.' } });
const userMessage = (text) => ({ role: 'user', content: [{ type: 'text', text }] });

// One turn scaffold: turn_start + system/user echo (fresh legs replay them;
// resume legs re-emit the stored conversation — same noise either way).
async function turnPrologue() {
  emit({ type: 'turn_start' });
  emit({ type: 'message_start', message: systemMessage() });
  emit({ type: 'message_end', message: systemMessage() });
  emit({ type: 'message_start', message: userMessage('请查看当前目录') });
  emit({ type: 'message_end', message: userMessage('请查看当前目录') });
}

// ok-mode full stream, real 1.5.0 shapes (see header for sources): turn 1
// streams a text delta, ends with a toolCall block (stopReason 'toolUse'),
// the harness runs the tool and emits the toolResult message; turn 2 answers.
async function okStream(finalText = '答案文本') {
  const sid = (MODE === 'resume-echo' && sessionIdFromArgv()) || freshSid();
  emit({ type: 'session', version: 3, id: sid, timestamp: new Date().toISOString(), cwd: process.cwd() });
  emit({ type: 'agent_start' });

  await turnPrologue();
  emit({ type: 'message_start', message: { role: 'assistant', content: [], stopReason: 'pending' } });
  await sleep(30);
  // message_update deltas (text_delta) must accumulate; the in-progress tool
  // call rides as a toolCall block the same way the real stream shows it.
  emit({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: '先看看' }] }, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '先看看' } });
  emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '先看看' }, { type: 'toolCall', id: 'call_0', name: 'bash', arguments: { command: "ls -la" } }], stopReason: 'toolUse' } });
  emit({ type: 'turn_end', message: { role: 'assistant', content: [{ type: 'text', text: '先看看' }, { type: 'toolCall', id: 'call_0', name: 'bash', arguments: { command: "ls -la" } }], stopReason: 'toolUse' }, toolResults: [] });
  await sleep(30);
  emit({ type: 'message_start', message: { role: 'toolResult', toolCallId: 'call_0', toolName: 'bash', content: [] } });
  emit({ type: 'message_end', message: { role: 'toolResult', toolCallId: 'call_0', toolName: 'bash', content: [{ type: 'text', text: 'file1\nfile2\n' }], isError: false, durationMs: 8 } });
  await sleep(30);

  await turnPrologue();
  emit({ type: 'message_start', message: { role: 'assistant', content: [], stopReason: 'pending' } });
  await sleep(30);
  emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: finalText }], usage: { input: 3516, output: 6, cacheRead: 0, cacheWrite: 0, totalTokens: 3522, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, totalFromProvider: false } }, stopReason: 'stop' } });
  emit({ type: 'turn_end', message: { role: 'assistant', content: [{ type: 'text', text: finalText }], stopReason: 'stop' }, toolResults: [] });
  emit({ type: 'agent_end', messages: [] });
  emit({ type: 'agent_settled', aborted: false });
}

// The REAL pi failure shape (dead-gateway probe): assistant message_end with
// stopReason 'error' and EMPTY content — the error text lives ONLY in the
// auto_retry events. Exit stays 0.
async function failureStream(finalError) {
  emit({ type: 'session', version: 3, id: freshSid(), timestamp: new Date().toISOString(), cwd: process.cwd() });
  emit({ type: 'agent_start' });
  await turnPrologue();
  emit({ type: 'message_start', message: { role: 'assistant', content: [], stopReason: 'pending' } });
  emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: finalError });
  emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error' } });
  emit({ type: 'auto_retry_start', attempt: 2, maxAttempts: 3, delayMs: 4000, errorMessage: finalError });
  emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error' } });
  emit({ type: 'auto_retry_end', success: false, attempt: 3, finalError });
  emit({ type: 'agent_end', messages: [] });
  emit({ type: 'agent_settled', aborted: false });
}

async function main() {
  // Drain ALL of stdin first (the prompt); stored raw for suite assertions.
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  if (HOME) writeFileSync(join(HOME, 'last-prompt'), Buffer.concat(chunks));

  switch (MODE) {
    case 'ok':
    case 'resume-echo': // okStream echoes the --session value when present
      await okStream();
      process.exitCode = 0;
      return;
    case 'thinking': {
      const sid = freshSid();
      emit({ type: 'session', version: 3, id: sid, timestamp: new Date().toISOString(), cwd: process.cwd() });
      emit({ type: 'agent_start' });
      await turnPrologue();
      emit({ type: 'message_start', message: { role: 'assistant', content: [], stopReason: 'pending' } });
      await sleep(50);
      emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '好的，让我先想一下这个问题。', thinkingSignature: 'sig0' }, { type: 'text', text: '答案文本' }], stopReason: 'stop' } });
      emit({ type: 'turn_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '好的，让我先想一下这个问题。', thinkingSignature: 'sig0' }, { type: 'text', text: '答案文本' }], stopReason: 'stop' }, toolResults: [] });
      emit({ type: 'agent_end', messages: [] });
      emit({ type: 'agent_settled', aborted: false });
      process.exitCode = 0;
      return;
    }
    case 'lock': {
      // Invented conflict text (real pi lock wording unknown — no observed
      // two-process session contention): the runner's LOCK_CONFLICT_RE must
      // match this AND carry generic fallbacks.
      await failureStream('Error: session 01a1ae2d-0000-7000-8000-000000000000 is locked by another pi process (session lock held); wait for it to finish before resuming');
      process.exitCode = 0; // real pi exits 0 on model failure — verified
      return;
    }
    case 'credential': {
      await failureStream('Error: Missing credentials. Please set PI_MAGPIE_API_KEY (or run `pi /login`) with access to the model and retry.');
      process.exitCode = 0;
      return;
    }
    case 'model-error': {
      // The gateway-404 shape (live probe 2026-11-07): pi does NOT retry on a
      // non-retryable API error — no auto_retry events, content [], stderr
      // empty; the error text rides message_end.errorMessage. exit stays 0.
      const sid = freshSid();
      emit({ type: 'session', version: 3, id: sid, timestamp: new Date().toISOString(), cwd: process.cwd() });
      emit({ type: 'agent_start' });
      await turnPrologue();
      emit({ type: 'message_start', message: { role: 'assistant', content: [], stopReason: 'pending' } });
      emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '404 {"error":{"message":"magpie knows no model \\"no/such/model-id\\""}}' } });
      emit({ type: 'turn_end', message: { role: 'assistant', content: [], stopReason: 'error' }, toolResults: [] });
      emit({ type: 'agent_end', messages: [] });
      emit({ type: 'agent_settled', aborted: false });
      process.exitCode = 0;
      return;
    }
    case 'stderr-fail': {
      // Startup-failure shape (pi 1.5.0, no usable agent dir/model): exit 1,
      // empty stdout, the reason ONLY on stderr.
      process.stderr.write('Error: Model "x/y" not found. Use --list-models to see available models.\n');
      process.exitCode = 1;
      return;
    }
    case 'hang-sigterm': {
      emit({ type: 'session', version: 3, id: freshSid(), timestamp: new Date().toISOString(), cwd: process.cwd() });
      emit({ type: 'agent_start' });
      await turnPrologue();
      emit({ type: 'message_start', message: { role: 'assistant', content: [], stopReason: 'pending' } });
      emit({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: '部分输出' }] }, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '部分输出' } });
      process.on('SIGTERM', () => {}); // swallow SIGTERM: only SIGKILL ends this
      hang();
      return;
    }
    case 'hang-timeout':
      emit({ type: 'session', version: 3, id: freshSid(), timestamp: new Date().toISOString(), cwd: process.cwd() });
      hang(); // no SIGTERM handler → default termination
      return;
    case 'partial-abort': {
      emit({ type: 'session', version: 3, id: freshSid(), timestamp: new Date().toISOString(), cwd: process.cwd() });
      emit({ type: 'agent_start' });
      await turnPrologue();
      emit({ type: 'message_start', message: { role: 'assistant', content: [], stopReason: 'pending' } });
      emit({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: '部分输出' }] }, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '部分输出' } });
      process.on('SIGTERM', () => {
        // A killed real pi's flush behavior is UNVERIFIED (default kill = no
        // flush); the fake flushes agent_settled{aborted:true} so the suite
        // exercises the resolve path. The runner keeps accumulated deltas
        // either way — the contract locks the accumulation, not the flush.
        emit({ type: 'agent_settled', aborted: true });
        // Exit from the write callback: process.exit right after a pipe write
        // can drop the line (same lesson as fake-dsh/fake-claude/fake-codex).
        process.stdout.write('', () => process.exit(0));
        setTimeout(() => process.exit(0), 200).unref();
      });
      hang();
      return;
    }
    default:
      process.stderr.write(`fake-pi: unknown FAKE_MODE '${MODE}'\n`);
      process.exitCode = 2;
  }
}

main().catch((err) => {
  process.stderr.write(`fake-pi: ${err?.stack ?? err}\n`);
  process.exitCode = 1;
});
