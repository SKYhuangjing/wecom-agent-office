#!/usr/bin/env node
// Programmable fake `codex` CLI (M2 Task 4) — the actor half of the provider
// port contract suite for plugins/provider-codex, mirroring fake-claude.js /
// fake-dsh.js: one script plays every role the §5 contract needs, selected by
// env FAKE_MODE (default 'ok'), emitting codex 0.166.0 `exec --json` JSONL
// shapes. Sources of truth (all verified 2026-11-06 against the real CLI):
//   - captured probe baselines test/probe-baselines/codex.ndjson and
//     codex-resume-stdin.ndjson (thread.started re-emits the SAME thread_id on
//     every resume leg; stdin accepted on every leg via the `-` prompt arg),
//   - a fresh real run with a shell command (item.started/item.completed
//     command_execution carries {command, aggregated_output, exit_code,
//     status}),
//   - the codex-cli 0.166.0 source of the exec JSONL model
//     (codex-rs/exec/src/exec_events.rs, tag rust-v0.166.0): the event set is
//     thread.started{thread_id} / turn.started / item.started|item.updated|
//     item.completed{item} / turn.completed{usage} / turn.failed{error:
//     {message}} / error{message}, and the item `type` tags are snake_case:
//     agent_message{text} · reasoning{text} · command_execution{command,
//     aggregated_output, exit_code, status} · file_change{changes:[{path,
//     kind:add|delete|update}], status} · mcp_tool_call{server, tool,
//     arguments, status} · web_search{query, action} · todo_list{items:[{text,
//     completed}]} · error{message}. NOTE: 0.166.0 has NO `plan_update` tag —
//     the plan item is `todo_list`; the runner hedge-maps the `plan_update`
//     spelling too, but this fake emits the REAL shape only.
//
// Modes (isomorphic with fake-claude; the contract suite hardcodes the name
// 'thinking' for group 2, so 'reasoning' is an alias, not the primary):
//   ok            full event set: thread.started + reasoning +
//                 command_execution(ls) + file_change + mcp_tool_call +
//                 web_search + todo_list + agent_message('答案文本') +
//                 turn.completed, exit 0 (an item.started proves the runner
//                 maps only item.completed)
//   thinking      thread.started + reasoning item + agent_message +
//                 turn.completed (alias: 'reasoning')
//   lock          stderr invented thread-lock text + turn.failed, exit 1.
//                 NOTE: real codex's conflict wording is UNKNOWN until M3
//                 real-CLI validation; the runner's LOCK_CONFLICT_RE carries
//                 plausible + generic + IsolationError hedges (see runner.js).
//   credential    stderr CODEX_API_KEY hint + turn.failed, exit 1
//   hang-sigterm  thread.started + partial agent_message, then SIGTERM is
//                 ignored — dies only on SIGKILL (kill-escalation contract)
//   hang-timeout  thread.started, then hangs — SIGTERM default-kills it
//   partial-abort thread.started + partial agent_message; on SIGTERM emits
//                 turn.failed and exits 0 (abort carries partial output)
//   resume-echo   ok, but the `resume <id>` positional in argv is echoed as
//                 the thread_id (real codex re-emits the SAME id — baseline
//                 proven, including resume-of-resume)
//
// Side files under $FAKE_HOME (written only when FAKE_HOME is set), same
// contract as fake-dsh/fake-claude: last-prompt (raw stdin), last-argv,
// last-pid.
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
const freshTid = () => randomUUID();
const USAGE = { input_tokens: 22075, cached_input_tokens: 3712, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 };

// The resume id rides as the positional right after the `resume` subcommand
// (`codex exec resume <id> --json --skip-git-repo-check -` — baseline leg2).
const threadIdFromArgv = () => {
  const i = argv.indexOf('resume');
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : null;
};

// The ok-mode full event set, real 0.166.0 shapes (see header for sources).
async function okStream(finalText = '答案文本') {
  const tid = (MODE === 'resume-echo' && threadIdFromArgv()) || freshTid();
  emit({ type: 'thread.started', thread_id: tid });
  await sleep(30);
  emit({ type: 'turn.started' });
  await sleep(30);
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: '先想一下当前目录里有什么' } });
  await sleep(30);
  // item.started must NOT map (§5.1 maps item.completed payloads; started is
  // the in_progress twin of the same item).
  emit({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: "/bin/zsh -lc 'ls -la'", aggregated_output: '', exit_code: null, status: 'in_progress' } });
  emit({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: "/bin/zsh -lc 'ls -la'", aggregated_output: 'file1\nfile2\n', exit_code: 0, status: 'completed' } });
  await sleep(30);
  emit({ type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes: [{ path: '/w/report.md', kind: 'add' }, { path: '/w/src/main.js', kind: 'update' }], status: 'completed' } });
  await sleep(30);
  emit({ type: 'item.completed', item: { id: 'item_3', type: 'mcp_tool_call', server: 'fetch', tool: 'get_url', arguments: { url: 'https://example.com/docs' }, status: 'completed' } });
  await sleep(30);
  emit({ type: 'item.completed', item: { id: 'item_4', type: 'web_search', query: 'codex exec jsonl event types', action: 'search' } });
  await sleep(30);
  emit({ type: 'item.completed', item: { id: 'item_5', type: 'todo_list', items: [{ text: '列出目录', completed: true }, { text: '汇总结果', completed: false }] } });
  await sleep(30);
  emit({ type: 'item.completed', item: { id: 'item_6', type: 'agent_message', text: finalText } });
  await sleep(30);
  emit({ type: 'turn.completed', usage: USAGE });
}

async function main() {
  // Drain ALL of stdin first (the prompt); stored raw for suite assertions.
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  if (HOME) writeFileSync(join(HOME, 'last-prompt'), Buffer.concat(chunks));

  switch (MODE) {
    case 'ok':
    case 'resume-echo': // okStream echoes the resume positional when present
      await okStream();
      process.exitCode = 0;
      return;
    case 'thinking':
    case 'reasoning': { // alias — the contract suite spells the mode 'thinking'
      const tid = freshTid();
      emit({ type: 'thread.started', thread_id: tid });
      await sleep(50);
      emit({ type: 'turn.started' });
      await sleep(50);
      emit({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: '好的，让我先想一下这个问题。' } });
      await sleep(50);
      emit({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: '答案文本' } });
      await sleep(50);
      emit({ type: 'turn.completed', usage: USAGE });
      process.exitCode = 0;
      return;
    }
    case 'lock': {
      // Invented conflict text (real wording unknown until M3): the runner's
      // LOCK_CONFLICT_RE must match this AND carry generic fallbacks. No
      // thread.started here — a locked thread mints no id, which is exactly
      // the no-echo shape (runner must return the INPUT id).
      const msg = 'Error: thread 01a1ae2d-0000-7000-8000-000000000000 is locked by another codex process (thread lock held); wait for it to finish before resuming';
      process.stderr.write(`${msg}\n`);
      emit({ type: 'turn.failed', error: { message: msg } });
      process.exitCode = 1;
      return;
    }
    case 'credential': {
      const msg = 'Error: Missing credentials. Please set CODEX_API_KEY (or run `codex login`) with access to the model and retry.';
      process.stderr.write(`${msg}\n`);
      emit({ type: 'turn.failed', error: { message: msg } });
      process.exitCode = 1;
      return;
    }
    case 'hang-sigterm': {
      const tid = freshTid();
      emit({ type: 'thread.started', thread_id: tid });
      await sleep(50);
      emit({ type: 'turn.started' });
      await sleep(50);
      emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: '部分输出' } });
      process.on('SIGTERM', () => {}); // swallow SIGTERM: only SIGKILL ends this
      hang();
      return;
    }
    case 'hang-timeout':
      emit({ type: 'thread.started', thread_id: freshTid() });
      hang(); // no SIGTERM handler → default termination
      return;
    case 'partial-abort': {
      const tid = freshTid();
      emit({ type: 'thread.started', thread_id: tid });
      await sleep(50);
      emit({ type: 'turn.started' });
      await sleep(50);
      emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: '部分输出' } });
      process.on('SIGTERM', () => {
        // A killed real codex flushes a turn.failed before dying; the runner
        // must keep the partial text and mark the run aborted.
        emit({ type: 'turn.failed', error: { message: 'OperationAborted: turn interrupted by user' } });
        // Exit from the write callback: process.exit right after a pipe write
        // can drop the line (same lesson as fake-dsh/fake-claude).
        process.stdout.write('', () => process.exit(0));
        setTimeout(() => process.exit(0), 200).unref();
      });
      hang();
      return;
    }
    default:
      process.stderr.write(`fake-codex: unknown FAKE_MODE '${MODE}'\n`);
      process.exitCode = 2;
  }
}

main().catch((err) => {
  process.stderr.write(`fake-codex: ${err?.stack ?? err}\n`);
  process.exitCode = 1;
});
