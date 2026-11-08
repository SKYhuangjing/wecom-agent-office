#!/usr/bin/env node
// Programmable fake `agent` (Cursor CLI) — the actor half of the provider
// port contract suite for plugins/provider-cursor, mirroring fake-dsh/
// fake-claude/fake-codex/fake-pi: one script plays every role the §5 contract
// needs, selected by env FAKE_MODE (default 'ok'), emitting Cursor CLI
// stream-json NDJSON shapes. Sources of truth:
//   - official CLI docs (cursor.com/docs/cli/headless): -p +
//     --output-format stream-json emits system/init, assistant,
//     tool_call started/completed, result{duration_ms} events
//   - REAL captured probe baselines test/probe-baselines/cursor*.ndjson
//     (2026-11-08 live run; the fake mirrors those shapes — changing either
//     means changing both, same co-validation rule as the other fakes)
//
// Modes (isomorphic with fake-claude/fake-codex):
//   ok            system/init(session_id) + assistant(text delta + tool_use
//                 bash ls) + tool_call completed + assistant(答案文本) +
//                 result success, exit 0
//   thinking      system/init + assistant thinking block + text, exit 0
//   lock          invented lock text on stderr + result error, exit 1
//   credential    "Authentication required" on stderr + result error, exit 1
//   hang-sigterm  system/init + partial text, then SIGTERM ignored —
//                 dies only on SIGKILL (kill-escalation contract)
//   hang-timeout  system/init, then hangs — SIGTERM default-kills it
//   partial-abort system/init + partial text; on SIGTERM flushes a result
//                 error and exits 0 (abort carries partial output)
//   resume-echo   ok, but the --resume <id> value in argv is echoed as the
//                 init session_id (real CLI semantics — probe leg2)
//
// Side files under $FAKE_HOME (written only when FAKE_HOME is set), same
// contract as the other fakes: last-prompt (raw stdin), last-argv, last-pid.
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

// The resume id rides as the --resume flag value (`agent -p --resume <id> …`).
const sessionIdFromArgv = () => {
  const i = argv.indexOf('--resume');
  if (i !== -1 && i + 1 < argv.length && !argv[i + 1].startsWith('-')) return argv[i + 1];
  const c = argv.indexOf('--resume='); // --resume=<id> spelling
  if (c !== -1) return argv[c].slice('--resume='.length);
  return null;
};

// system/init: the session-bearing first event (claude-code-shaped).
const initEvent = (sid) => ({
  type: 'system', subtype: 'init', session_id: sid,
  model: 'cursor-default', cwd: process.cwd(),
});

// One assistant message event (claude-code-shaped: message.content blocks).
const assistantText = (text) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

async function okStream(finalText = '答案文本') {
  const sid = (MODE === 'resume-echo' && sessionIdFromArgv()) || randomUUID();
  emit(initEvent(sid));
  await sleep(30);
  // turn 1: a tool round-trip — the assistant message carries the tool_use
  // BLOCK (what the runner maps), tool_call events are its lifecycle twins
  // (which the runner degrades — started must NOT double-map).
  emit({ type: 'tool_call', event: 'started', tool: 'Bash', input: { command: 'ls -la' } });
  await sleep(30);
  emit({
    type: 'assistant',
    message: { role: 'assistant', content: [
      { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
    ] },
  });
  emit({ type: 'tool_call', event: 'completed', tool: 'Bash', input: { command: 'ls -la' }, output: 'file1\nfile2\n' });
  await sleep(30);
  // turn 2: the final answer
  emit(assistantText(finalText));
  emit({
    type: 'result', subtype: 'success', result: finalText,
    session_id: sid, duration_ms: 1234,
  });
}

// The failure terminal: a result event with subtype error + stderr text.
async function failureResult(sid, message) {
  emit(initEvent(sid));
  await sleep(30);
  process.stderr.write(`${message}\n`);
  emit({ type: 'result', subtype: 'error_during_execution', error: message, session_id: sid, duration_ms: 10 });
}

async function main() {
  // Drain ALL of stdin first (the prompt); stored raw for suite assertions.
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  if (HOME) writeFileSync(join(HOME, 'last-prompt'), Buffer.concat(chunks));

  switch (MODE) {
    case 'ok':
    case 'resume-echo':
      await okStream();
      process.exitCode = 0;
      return;
    case 'thinking': {
      const sid = randomUUID();
      emit(initEvent(sid));
      await sleep(50);
      emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '好的，让我先想一下这个问题。' }, { type: 'text', text: '答案文本' }] } });
      emit({ type: 'result', subtype: 'success', result: '答案文本', session_id: sid, duration_ms: 99 });
      process.exitCode = 0;
      return;
    }
    case 'lock': {
      // Invented conflict text (real Cursor lock wording unknown — no
      // observed two-process session contention): the runner's
      // LOCK_CONFLICT_RE must match this AND carry generic fallbacks.
      await failureResult(randomUUID(), 'Error: chat session is locked by another agent process (chat lock held); wait for it to finish before resuming');
      process.exitCode = 1;
      return;
    }
    case 'credential': {
      await failureResult(randomUUID(), "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.");
      process.exitCode = 1;
      return;
    }
    case 'hang-sigterm': {
      emit(initEvent(randomUUID()));
      await sleep(50);
      emit(assistantText('部分输出'));
      process.on('SIGTERM', () => {}); // swallow SIGTERM: only SIGKILL ends this
      hang();
      return;
    }
    case 'hang-timeout':
      emit(initEvent(randomUUID()));
      hang(); // no SIGTERM handler → default termination
      return;
    case 'partial-abort': {
      emit(initEvent(randomUUID()));
      await sleep(50);
      emit(assistantText('部分输出'));
      process.on('SIGTERM', () => {
        // A killed real CLI flushes an error result before dying; the runner
        // must keep the partial text and mark the run aborted.
        emit({ type: 'result', subtype: 'error_during_execution', error: 'aborted by user', session_id: null, duration_ms: 0 });
        // Exit from the write callback: process.exit right after a pipe write
        // can drop the line (same lesson as the other fakes).
        process.stdout.write('', () => process.exit(0));
        setTimeout(() => process.exit(0), 200).unref();
      });
      hang();
      return;
    }
    default:
      process.stderr.write(`fake-cursor: unknown FAKE_MODE '${MODE}'\n`);
      process.exitCode = 2;
  }
}

main().catch((err) => {
  process.stderr.write(`fake-cursor: ${err?.stack ?? err}\n`);
  process.exitCode = 1;
});
