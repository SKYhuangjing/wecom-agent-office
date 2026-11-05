#!/usr/bin/env node
// Programmable fake `dsh` CLI (Task 15) — the actor half of the provider port
// contract suite (Task 16). One script plays every role the §5 contract needs
// to exercise, selected by env FAKE_MODE (default 'ok'), so provider plugins
// are tested against deterministic process semantics instead of a real agent
// CLI. Zero dependencies; the contract suite injects it via tiny /bin/sh
// wrappers that export FAKE_MODE/FAKE_HOME before exec'ing this file, so no
// provider needs env-passthrough support for the suite to drive it.
//
// Modes:
//   ok            full happy dsh-style NDJSON stream, exit 0
//   thinking      ok plus a thinking event before tool_call
//   lock          stderr lock error, exit 3, nothing on stdout
//   credential    stdout error event MISSING_CREDENTIAL, exit 1
//   hang-sigterm  session + partial text, then SIGTERM is ignored — dies only
//                 on SIGKILL (exercises the kill-escalation contract)
//   hang-timeout  session event, then hangs — SIGTERM default-kills it
//   partial-abort session + partial text; on SIGTERM emits final +
//                 turn_end(interrupted), exits 0 (abort carries partial output)
//   resume-echo   ok, but a `--session-id <id>` in argv is echoed as the
//                 session id (dsh --session-id is pure resume)
//
// Side files under $FAKE_HOME (all written only when FAKE_HOME is set):
//   last-prompt  the raw stdin bytes (proves the prompt was piped, unmodified)
//   last-argv    argv joined by a space (lets the suite assert --session-id)
//   last-pid     this process's pid, written BEFORE stdin is drained — the
//                suite polls process.kill(pid, 0) to prove the child is dead
import { randomBytes } from 'node:crypto';
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
// A reader that walks away early (`| head -3`, a runner closing its pipe
// during a kill path) must not crash us with an unhandled EPIPE — exit
// quietly, exactly like a C CLI dying on SIGPIPE would.
process.stdout.on('error', (err) => {
  if (err?.code === 'EPIPE') process.exit(0);
  throw err;
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A no-op interval keeps the event loop alive: the hang modes must hang
// forever (an empty loop with no handles would let the process exit).
const hang = () => setInterval(() => {}, 1 << 30);
const freshSid = () => `session-fake-${randomBytes(3).toString('hex')}`;

const sessionIdFromArgv = () => {
  const i = argv.indexOf('--session-id');
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : null;
};

// Happy-family stream (ok / thinking / resume-echo): 50ms between lines so
// abort and timeout land mid-stream instead of after everything flushed.
async function happyStream() {
  const sid = (MODE === 'resume-echo' && sessionIdFromArgv()) || freshSid();
  const lines = [
    { type: 'session', sessionId: sid },
    { type: 'status', phase: 'turn_start', turn: 1 },
    { type: 'status', phase: 'step_start', step: 1 },
    ...(MODE === 'thinking' ? [{ type: 'thinking', text: '好的，让我先查看一下目录结构。' }] : []),
    { type: 'tool_call', name: 'Bash', input: { command: 'ls -la' } },
    { type: 'text', text: '答案文本' },
    { type: 'status', phase: 'step_end', step: 1, usage: { inputTokens: 120, outputTokens: 60 } },
    { type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } },
    { type: 'final', text: '答案文本' },
  ];
  for (const line of lines) {
    emit(line);
    await sleep(50);
  }
}

async function main() {
  // Drain ALL of stdin first (the prompt); stored raw for suite assertions.
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  if (HOME) writeFileSync(join(HOME, 'last-prompt'), Buffer.concat(chunks));

  switch (MODE) {
    case 'ok':
    case 'thinking':
    case 'resume-echo':
      // Natural exit (exitCode, not process.exit) lets pending stdout writes
      // flush — an abrupt exit could truncate the final line on a pipe.
      await happyStream();
      process.exitCode = 0;
      return;
    case 'lock':
      process.stderr.write('Error: session "x" already owned by an active write handle\n');
      process.exitCode = 3;
      return;
    case 'credential':
      emit({ type: 'error', message: 'MISSING_CREDENTIAL: no API key' });
      process.exitCode = 1;
      return;
    case 'hang-sigterm':
      emit({ type: 'session', sessionId: freshSid() });
      await sleep(50);
      emit({ type: 'text', text: '部分输出' });
      process.on('SIGTERM', () => {}); // swallow SIGTERM: only SIGKILL ends this
      hang();
      return;
    case 'hang-timeout':
      emit({ type: 'session', sessionId: freshSid() });
      hang(); // no SIGTERM handler → default termination
      return;
    case 'partial-abort':
      emit({ type: 'session', sessionId: freshSid() });
      await sleep(50);
      emit({ type: 'text', text: '部分输出' });
      process.on('SIGTERM', () => {
        emit({ type: 'final', text: '部分输出' });
        // Exit from the drain callback: process.exit right after a pipe write
        // can drop the line. The timer is a backstop, not the main path.
        process.stdout.write(
          `${JSON.stringify({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'interrupted' } })}\n`,
          () => process.exit(0),
        );
        setTimeout(() => process.exit(0), 200).unref();
      });
      hang();
      return;
    default:
      process.stderr.write(`fake-dsh: unknown FAKE_MODE '${MODE}'\n`);
      process.exitCode = 2;
  }
}

main().catch((err) => {
  process.stderr.write(`fake-dsh: ${err?.stack ?? err}\n`);
  process.exitCode = 1;
});
