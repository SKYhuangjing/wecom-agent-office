// M2 Task 4 unit grid: plugins/provider-codex/runner.js against the
// fake-codex CLI. The fake is injected exactly like the contract suite does
// it — a /bin/sh wrapper exporting FAKE_MODE/FAKE_HOME before exec'ing
// fake-codex.js (exec keeps the pid, so last-pid is the pid the runner
// spawned). Covers: completed shape + the FULL codex event set mapping
// (reasoning/command_execution/file_change/mcp_tool_call/web_search/todo_list
// /agent_message; item.started NOT mapped) + the plan_update hedge spelling, thinking mode, resume argv
// (`exec resume <id>` subcommand), sandbox flag split (-s fresh leg,
// -c sandbox_mode on the resume leg — resume has no -s), configOverrides
// TOML quoting, env injection (CODEX_HOME + apiKeyEnv), abort-partial,
// SIGKILL escalation (injectable escalationMs), timeout, lock,
// IsolationError hedge, credential, turn.failed→error record, first-event
// abort sessionId drop, no-id-echo, never-rejects, abort-before-spawn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunner, toCodexOverride, describeToolBrief } from '../../plugins/provider-codex/runner.js';

const FAKE_CODEX = fileURLToPath(new URL('../fake-bin/fake-codex.js', import.meta.url));
const PROMPT = '请查看当前目录';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, timeoutMs, everyMs = 25) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() >= deadline) return v;
    await sleep(everyMs);
  }
};
const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code !== 'ESRCH'; }
};
const pidDeadWithin = (pid, ms) => until(() => !pidAlive(pid), ms);

// A wrapper bakes FAKE_MODE into a /bin/sh script (same technique as the
// contract suite); exec preserves the pid, so last-pid is the pid the runner
// spawned. `prelude` runs before the exec (sleep → pre-first-event aborts).
const makeWrapper = (dir, mode, { prelude = '' } = {}) => {
  const fakeHome = join(dir, 'fake-home');
  mkdirSync(join(dir, 'bin'), { recursive: true });
  const bin = join(dir, 'bin', `codex-${mode}.sh`);
  writeFileSync(bin, '#!/bin/sh\n'
    + `export FAKE_MODE="${mode}"\n`
    + `export FAKE_HOME="${fakeHome}"\n`
    + prelude
    + `exec "${FAKE_CODEX}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
};

const noopLog = { debug() {}, info() {}, warn() {}, error() {} };
const makeRunner = (dir, pc = {}, opts = {}) => createRunner({
  bot: { id: 'b1', provider: 'codex' },
  providerConfig: { cwd: dir, ...pc },
  log: noopLog,
  ...opts,
});

const AC = () => new AbortController();
const runOnce = (runner, { prompt = PROMPT, sessionId = undefined, signal, timeoutMs = 20_000, onEvent } = {}) =>
  runner.run({ prompt, sessionId, signal: signal ?? AC().signal, timeoutMs, onEvent });

test('runner: ok run — completed shape, FULL event-set mapping, stdin piped verbatim', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cx-ok-'));
  try {
    const runner = makeRunner(dir, { codexBin: makeWrapper(dir, 'ok') });
    const events = [];
    const res = await runOnce(runner, { onEvent: (ev) => events.push(ev) });
    assert.equal(res.ok, true);
    assert.equal(res.code, 'completed');
    assert.equal(res.aborted, false);
    assert.match(res.sessionId, /^[0-9a-f]{8}-/);
    assert.equal(res.finalText, '答案文本');
    assert.equal(res.reason?.kind, 'completed');
    assert.equal(res.reason?.usage?.inputTokens, 22075);
    assert.equal(res.detail.exitCode, 0);
    // session comes from thread.started
    assert.equal(events[0]?.type, 'session');
    assert.equal(events[0]?.sessionId, res.sessionId);
    // FULL item set, each mapped once — item.started must NOT map
    const types = events.map((e) => e.type);
    assert.equal(types.filter((t) => t === 'session').length, 1, 'one session event');
    const thinks = events.filter((e) => e.type === 'thinking');
    assert.equal(thinks.length, 1, 'reasoning → exactly one thinking');
    assert.equal(thinks[0].text, '先想一下当前目录里有什么');
    const tools = events.filter((e) => e.type === 'tool');
    assert.equal(tools.length, 5, `five tool events, item.started excluded (got ${tools.map((t) => t.name).join(',')})`);
    assert.deepEqual(tools.map((t) => t.name), ['Bash', '文件修改', 'fetch/get_url', 'WebSearch', '计划']);
    assert.ok(tools[0].brief.includes('ls'), `command brief carries the command (${JSON.stringify(tools[0].brief)})`);
    assert.ok(tools[1].brief.includes('/w/report.md') && tools[1].brief.includes('update /w/src/main.js'), `file_change brief summarizes paths (${JSON.stringify(tools[1].brief)})`);
    assert.equal(tools[2].brief, 'https://example.com/docs', 'mcp brief from arguments.url');
    assert.ok(tools[3].brief.includes('codex exec jsonl'), `web_search brief carries the query (${JSON.stringify(tools[3].brief)})`);
    assert.ok(tools[4].brief.includes('列出目录') && tools[4].brief.includes('汇总结果'), `todo_list brief summarizes steps (${JSON.stringify(tools[4].brief)})`);
    const texts = events.filter((e) => e.type === 'text');
    assert.equal(texts.length, 1);
    assert.equal(texts[0].text, '答案文本');
    assert.equal(readFileSync(join(dir, 'fake-home', 'last-prompt'), 'utf8'), PROMPT, 'prompt piped verbatim via stdin');
    const argv = readFileSync(join(dir, 'fake-home', 'last-argv'), 'utf8');
    assert.equal(argv.trim(), 'exec --json --skip-git-repo-check -', 'fresh-leg argv shape (prompt is the stdin sentinel -)');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: thinking mode — reasoning item → thinking event with text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cx-think-'));
  try {
    const runner = makeRunner(dir, { codexBin: makeWrapper(dir, 'thinking') });
    const events = [];
    const res = await runOnce(runner, { onEvent: (ev) => events.push(ev) });
    assert.equal(res.code, 'completed');
    const thinks = events.filter((e) => e.type === 'thinking');
    assert.equal(thinks.length, 1, `exactly one thinking event (got ${thinks.length} of ${events.length})`);
    assert.equal(thinks[0].text, '好的，让我先想一下这个问题。');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: plan_update hedge — a plan_update-shaped item still maps to tool{计划}', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cx-pu-'));
  try {
    // 0.166.0 has NO plan_update item (its plan item is todo_list — see the
    // ok-mode test); the runner carries a hedge for the spelling anyway, and
    // fake-codex's 'plan-update' mode (also NOT a real 0.166.0 shape — see its
    // header) exists to lock that branch: item → tool{name:'计划'}, brief from
    // item.plan||item.text.
    const runner = makeRunner(dir, { codexBin: makeWrapper(dir, 'plan-update') });
    const events = [];
    const res = await runOnce(runner, { onEvent: (ev) => events.push(ev) });
    assert.equal(res.code, 'completed');
    const plans = events.filter((e) => e.type === 'tool' && e.name === '计划');
    assert.equal(plans.length, 1, `exactly one 计划 tool event (got ${JSON.stringify(events.filter((e) => e.type === 'tool'))})`);
    assert.ok(plans[0].brief.includes('先检查配置') && plans[0].brief.includes('复测'), `plan_update brief carries the plan text (${JSON.stringify(plans[0].brief)})`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: resume — `exec resume <id>` subcommand in argv, SAME id echoed back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cx-res-'));
  try {
    const first = await runOnce(makeRunner(dir, { codexBin: makeWrapper(dir, 'ok') }));
    const sid = first.sessionId;
    assert.ok(sid, 'first run minted a thread id');
    const second = await runOnce(
      makeRunner(dir, { codexBin: makeWrapper(dir, 'resume-echo') }),
      { sessionId: sid },
    );
    assert.equal(second.code, 'completed');
    assert.equal(second.sessionId, sid, 'resume returns the same thread id');
    const argv = readFileSync(join(dir, 'fake-home', 'last-argv'), 'utf8');
    assert.ok(argv.includes(`exec resume ${sid} --json`), `argv carries the resume subcommand (${argv.trim()})`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: argv assembly — -m fresh leg, -s fresh leg; resume leg swaps -s for -c sandbox_mode', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cx-argv-'));
  try {
    const fresh = makeRunner(dir, {
      codexBin: makeWrapper(dir, 'ok'),
      model: { model: 'gpt-5.2-codex' },
      sandbox: 'workspace-write',
    });
    const res = await runOnce(fresh);
    assert.equal(res.code, 'completed');
    const argv = readFileSync(join(dir, 'fake-home', 'last-argv'), 'utf8');
    assert.ok(argv.includes('-m gpt-5.2-codex'), argv.trim());
    assert.ok(argv.includes('-s workspace-write'), argv.trim());
    assert.ok(!argv.includes('sandbox_mode'), 'fresh leg uses -s, not a config override');

    const resumed = await runOnce(makeRunner(dir, {
      codexBin: makeWrapper(dir, 'resume-echo'),
      model: { model: 'gpt-5.2-codex' },
      sandbox: 'workspace-write',
    }), { sessionId: res.sessionId });
    assert.equal(resumed.code, 'completed');
    const argv2 = readFileSync(join(dir, 'fake-home', 'last-argv'), 'utf8');
    assert.ok(argv2.includes('-m gpt-5.2-codex'), 'resume leg keeps -m');
    assert.ok(argv2.includes('-c sandbox_mode="workspace-write"'), `resume leg carries sandbox as -c override (${argv2.trim()})`);
    assert.ok(!argv2.includes(' -s '), 'resume leg must NOT pass -s (the real resume subcommand rejects it)');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: configOverrides — each entry one -c, strings TOML-quoted, TOML-shaped values raw', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cx-cfg-'));
  try {
    const runner = makeRunner(dir, {
      codexBin: makeWrapper(dir, 'ok'),
      configOverrides: [
        'openai_base_url=https://gw.example/v1',
        'model_reasoning_effort=high',
        'shell_environment_policy.inherit=all',
        'features.web_search_request=true',
        'model_verbosity=5',
        'sandbox_permissions=["disk-full-read-access"]',
      ],
    });
    const res = await runOnce(runner);
    assert.equal(res.code, 'completed');
    const argv = readFileSync(join(dir, 'fake-home', 'last-argv'), 'utf8');
    assert.ok(argv.includes('-c openai_base_url="https://gw.example/v1"'), `url value TOML-quoted (${argv.trim()})`);
    assert.ok(argv.includes('-c model_reasoning_effort="high"'), 'bare word quoted');
    assert.ok(argv.includes('-c shell_environment_policy.inherit="all"'), 'dotted key, quoted value');
    assert.ok(argv.includes('-c features.web_search_request=true'), 'bool raw');
    assert.ok(argv.includes('-c model_verbosity=5'), 'number raw');
    assert.ok(argv.includes('-c sandbox_permissions=["disk-full-read-access"]'), 'array raw');
    assert.equal(argv.split(' -c ').length - 1, 6, 'six -c flags, one per entry');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: toCodexOverride — TOML basic-string escaping of quotes/backslashes', () => {
  assert.equal(toCodexOverride('msg=he said "hi"\\done'), 'msg="he said \\"hi\\"\\\\done"');
  assert.equal(toCodexOverride('k=true'), 'k=true');
  assert.equal(toCodexOverride('k=-1.5'), 'k=-1.5');
  assert.equal(toCodexOverride('k=[1,2]'), 'k=[1,2]');
  assert.equal(toCodexOverride('k={"a":1}'), 'k={"a":1}');
  assert.equal(toCodexOverride('openai_base_url=https://gw/v1'), 'openai_base_url="https://gw/v1"');
});

test('runner: describeToolBrief — url wins, whitespace collapsed, capped at 60', () => {
  assert.equal(describeToolBrief({ url: 'https://x/y', command: 'ls' }), 'https://x/y');
  assert.equal(describeToolBrief({ command: 'a   b\n c' }), 'a b c');
  assert.equal(describeToolBrief({ command: 'x'.repeat(80) }).length, 60);
});

test('runner: env injection — CODEX_HOME, model.apiKey→CODEX_API_KEY (apiKeyEnv renameable), providerConfig.env wins', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cx-env-'));
  try {
    // Wrapper captures the injected vars before exec'ing the fake.
    const fakeHome = join(dir, 'fake-home');
    const codexHome = join(dir, 'codex-home');
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(join(dir, 'bin'), { recursive: true });
    const bin = join(dir, 'bin', 'codex-envprobe.sh');
    writeFileSync(bin, '#!/bin/sh\n'
      + `export FAKE_MODE="ok"\nexport FAKE_HOME="${fakeHome}"\n`
      + `printf '%s\\n%s\\n%s' "$CODEX_HOME" "$CODEX_API_KEY" "$BOT_EXTRA" > "${join(fakeHome, 'saw-env')}"\n`
      + `exec "${FAKE_CODEX}" "$@"\n`);
    chmodSync(bin, 0o755);
    const runner = makeRunner(dir, { codexBin: bin, codexHome, model: { model: 'm', apiKey: 'sk-bot' }, env: { BOT_EXTRA: 'yes' } });
    const res = await runOnce(runner);
    assert.equal(res.code, 'completed');
    const [home, key, extra] = readFileSync(join(fakeHome, 'saw-env'), 'utf8').split('\n');
    assert.equal(home, codexHome, 'codexHome injected as $CODEX_HOME');
    assert.equal(key, 'sk-bot', 'model.apiKey lands in CODEX_API_KEY by default');

    // apiKeyEnv renames the credential var; providerConfig.env wins over it
    const bin2 = join(dir, 'bin', 'codex-envprobe2.sh');
    writeFileSync(bin2, '#!/bin/sh\n'
      + `export FAKE_MODE="ok"\nexport FAKE_HOME="${fakeHome}"\n`
      + `printf '%s\\n%s' "$GW_KEY" "$CODEX_API_KEY" > "${join(fakeHome, 'saw-env2')}"\n`
      + `exec "${FAKE_CODEX}" "$@"\n`);
    chmodSync(bin2, 0o755);
    const runner2 = makeRunner(dir, {
      codexBin: bin2,
      apiKeyEnv: 'GW_KEY',
      model: { model: 'm', apiKey: 'sk-gw' },
      env: { CODEX_API_KEY: 'sk-explicit' },
    });
    const res2 = await runOnce(runner2);
    assert.equal(res2.code, 'completed');
    const [gw, direct] = readFileSync(join(fakeHome, 'saw-env2'), 'utf8').split('\n');
    assert.equal(gw, 'sk-gw', 'model.apiKey honors apiKeyEnv');
    assert.equal(direct, 'sk-explicit', 'providerConfig.env overrides the derived value');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: abort mid-stream — aborted=true, partial finalText, child dead', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cx-ab-'));
  try {
    const runner = makeRunner(dir, { codexBin: makeWrapper(dir, 'partial-abort') });
    const events = [];
    const ac = AC();
    const p = runOnce(runner, { signal: ac.signal, onEvent: (ev) => events.push(ev) });
    const sawText = await until(() => events.some((e) => e?.type === 'text'), 3000);
    assert.ok(sawText, 'partial text observed before abort');
    ac.abort();
    const res = await p;
    assert.equal(res.aborted, true);
    assert.equal(res.code, 'aborted');
    assert.equal(res.ok, false);
    assert.equal(res.finalText, '部分输出', 'abort carries partial output');
    assert.equal(res.sessionId, res.sessionId && events[0]?.sessionId, 'aborted AFTER thread.started keeps the id');
    const pid = Number(readFileSync(join(dir, 'fake-home', 'last-pid'), 'utf8').trim());
    assert.ok(Number.isInteger(pid));
    assert.ok(await pidDeadWithin(pid, 3000), 'child dead (ESRCH) after resolve');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: SIGTERM-swallower — SIGKILL escalation, resolve fast, child dead', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cx-esc-'));
  try {
    // escalationMs injectable (default 3000): 250ms keeps the grid fast
    // while exercising the identical escalation path.
    const runner = makeRunner(dir, { codexBin: makeWrapper(dir, 'hang-sigterm') }, { escalationMs: 250 });
    const events = [];
    const ac = AC();
    const p = runOnce(runner, { signal: ac.signal, onEvent: (ev) => events.push(ev) });
    const sawText = await until(() => events.some((e) => e?.type === 'text'), 3000);
    assert.ok(sawText, 'text observed before abort');
    const t0 = Date.now();
    ac.abort();
    const res = await p;
    const took = Date.now() - t0;
    assert.ok(took <= 250 + 2000, `escalation resolved fast (took ${took}ms)`);
    assert.equal(res.code, 'aborted');
    assert.equal(res.aborted, true);
    assert.equal(res.ok, false);
    assert.equal(res.finalText, '部分输出', 'partial output preserved through SIGKILL path');
    const pid = Number(readFileSync(join(dir, 'fake-home', 'last-pid'), 'utf8').trim());
    assert.ok(await pidDeadWithin(pid, 3000), 'child dead (ESRCH) after resolve');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: timeoutMs elapsed — code=timeout, child dead', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cx-tmo-'));
  try {
    const runner = makeRunner(dir, { codexBin: makeWrapper(dir, 'hang-timeout') });
    // 3s: fake boot (wrapper+node) measured 400-900ms; keeps pid-file check firm
    const res = await runOnce(runner, { timeoutMs: 3000 });
    assert.equal(res.code, 'timeout');
    assert.equal(res.ok, false);
    assert.equal(res.aborted, false);
    const pid = Number(readFileSync(join(dir, 'fake-home', 'last-pid'), 'utf8').trim());
    assert.ok(await pidDeadWithin(pid, 3000), 'child dead (ESRCH) after resolve');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: lock stderr/turn.failed — code=lock-conflict', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cx-lock-'));
  try {
    const runner = makeRunner(dir, { codexBin: makeWrapper(dir, 'lock') });
    const res = await runOnce(runner);
    assert.equal(res.code, 'lock-conflict');
    assert.equal(res.ok, false);
    assert.match(res.detail.stderrTail, /is locked by another codex process/);
    assert.equal(res.reason?.kind, 'failed', 'turn.failed records the failed reason');
    assert.match(res.error, /locked by another codex process/);
    assert.equal(res.detail.exitCode, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: IsolationError stderr (no invented lock text) — code=lock-conflict', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cx-iso-'));
  try {
    // The regex hedge (same as claude): a bare `IsolationError` on stderr
    // with NONE of fake-codex's invented lock phrasing must still map to
    // lock-conflict — real codex's conflict wording is unknown until M3, so
    // the fallback token carries this shape on its own (fake-codex text stays
    // untouched; regex and fake are co-validated, see the lock test above).
    mkdirSync(join(dir, 'bin'), { recursive: true });
    const bin = join(dir, 'bin', 'codex-isolation.sh');
    writeFileSync(bin, '#!/bin/sh\necho "Error: IsolationError: thread is owned by an active process" >&2\nexit 1\n');
    chmodSync(bin, 0o755);
    const runner = makeRunner(dir, { codexBin: bin });
    const res = await runOnce(runner);
    assert.equal(res.code, 'lock-conflict');
    assert.equal(res.ok, false);
    assert.match(res.detail.stderrTail, /IsolationError/);
    assert.equal(res.detail.exitCode, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: credential error — code=missing-credential', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cx-cred-'));
  try {
    const runner = makeRunner(dir, { codexBin: makeWrapper(dir, 'credential') });
    const res = await runOnce(runner);
    assert.equal(res.code, 'missing-credential');
    assert.equal(res.ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: turn.failed with plain error message (no lock/credential text) — code=error, message recorded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cx-err-'));
  try {
    // A minimal inline codex stand-in: thread.started + turn.failed{boom}.
    mkdirSync(join(dir, 'bin'), { recursive: true });
    const bin = join(dir, 'bin', 'codex-boom.sh');
    writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n%s\\n%s\\n' '{"type":"thread.started","thread_id":"01a1ae2d-0000-7000-8000-000000000000"}' '{"type":"turn.started"}' '{"type":"turn.failed","error":{"message":"stream disconnected before completion"}}'\nexit 1\n`);
    chmodSync(bin, 0o755);
    const runner = makeRunner(dir, { codexBin: bin });
    const res = await runOnce(runner);
    assert.equal(res.code, 'error');
    assert.equal(res.ok, false);
    assert.equal(res.error, 'stream disconnected before completion', 'turn.failed error.message recorded');
    assert.equal(res.reason?.kind, 'failed');
    assert.equal(res.sessionId, '01a1ae2d-0000-7000-8000-000000000000', 'thread.started before failure still hands back the id');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: unknown FAKE_MODE stderr — falls through to code=error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cx-bogus-'));
  try {
    const runner = makeRunner(dir, { codexBin: makeWrapper(dir, 'bogus-mode') });
    const res = await runOnce(runner);
    assert.equal(res.code, 'error');
    assert.equal(res.ok, false);
    assert.match(res.detail.stderrTail, /unknown FAKE_MODE/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: abort BEFORE first thread.started — sessionId dropped (null), even on resume', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cx-fea-'));
  try {
    // The prelude sleeps 1s BEFORE exec'ing the fake, so an abort at ~100ms
    // kills the wrapper before any thread.started can exist — deterministic.
    const bin = makeWrapper(dir, 'partial-abort', { prelude: 'sleep 1\n' });
    const fresh = makeRunner(dir, { codexBin: bin });
    const ac1 = AC();
    const p1 = runOnce(fresh, { signal: ac1.signal });
    await sleep(100);
    ac1.abort();
    const r1 = await p1;
    assert.equal(r1.code, 'aborted');
    assert.equal(r1.sessionId, null, 'new thread aborted pre-event must not hand back an id');

    const resume = makeRunner(dir, { codexBin: bin });
    const ac2 = AC();
    const p2 = runOnce(resume, { signal: ac2.signal, sessionId: '01a1ae2d-1111-7222-8333-000000000001' });
    await sleep(100);
    ac2.abort();
    const r2 = await p2;
    assert.equal(r2.code, 'aborted');
    assert.equal(r2.sessionId, null, 'half-written resume killed pre-echo hands back no id either');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: no-id-echo — CLI never emits thread.started → INPUT sessionId returned', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cx-nie-'));
  try {
    // lock mode: no thread.started at all, plain failure — the id to hand
    // back next turn is still the one we were given (the thread already
    // exists on disk).
    const runner = makeRunner(dir, { codexBin: makeWrapper(dir, 'lock') });
    const res = await runOnce(runner, { sessionId: '01a1ae2d-2222-7333-8444-000000000002' });
    assert.equal(res.code, 'lock-conflict');
    assert.equal(res.sessionId, '01a1ae2d-2222-7333-8444-000000000002');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: never rejects — spawn failure resolves code=error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cx-enoent-'));
  try {
    const runner = makeRunner(dir, { codexBin: '/nonexistent/codex-bin-for-tests' });
    const res = await runOnce(runner);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'error');
    assert.ok(res.error || res.detail, 'diagnostics present');
    assert.equal(res.sessionId, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: abort-before-spawn — resolves aborted without spawning', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cx-pre-'));
  try {
    let spawned = false;
    const runner = createRunner({
      bot: { id: 'b1' },
      providerConfig: { cwd: dir, codexBin: '/nonexistent/either' },
      log: noopLog,
    });
    const ac = AC();
    ac.abort();
    const res = await runner.run({ prompt: PROMPT, signal: ac.signal, timeoutMs: 5000, onEvent: () => { spawned = true; } });
    assert.equal(res.code, 'aborted');
    assert.equal(res.aborted, true);
    assert.equal(res.sessionId, null);
    assert.equal(spawned, false, 'no events on the pre-abort fast path');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: onEvent stops after run() resolves (event-timing hold)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cx-timing-'));
  try {
    const runner = makeRunner(dir, { codexBin: makeWrapper(dir, 'ok') });
    const events = [];
    await runOnce(runner, { onEvent: (ev) => events.push(ev) });
    const seen = events.length;
    await sleep(150);
    assert.equal(events.length, seen, 'no onEvent callbacks after resolve');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
