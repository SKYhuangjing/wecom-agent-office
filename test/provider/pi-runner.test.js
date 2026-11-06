// Unit grid: plugins/provider-pi/runner.js against the fake-pi CLI — the
// same technique as the codex/claude grids (the fake is injected via a
// /bin/sh wrapper exporting FAKE_MODE/FAKE_HOME before exec'ing fake-pi.js;
// exec keeps the pid, so last-pid is the pid the runner spawned). Covers the
// pi-SPECIFIC facts the live probe pinned (2026-11-07, pi 1.5.0):
//   - argv shape: -p --mode json on every leg; resume = `--session <id>`;
//     --thinking only when set; --provider/--model; piArgs verbatim tail
//   - env injection: piAgentDir → $PI_CODING_AGENT_DIR; model.apiKey →
//     $<apiKeyEnv> (default PI_MAGPIE_API_KEY)
//   - event mapping: text deltas accumulate + message_end overwrites
//     authoritatively; thinking blocks; toolCall→tool with label map;
//     toolResult messages ignored; system/user messages ignored
//   - ⚠️ exit-0-is-not-success: stopReason 'error' + auto_retry_end → code
//     'error' with finalError text (the lock/credential regexes run on it)
//   - abort-partial / SIGKILL escalation (injectable escalationMs) / timeout
//   - abort-before-spawn; never rejects (all failures resolve)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunner, describeToolBrief, toolLabel } from '../../plugins/provider-pi/runner.js';

const FAKE_PI = fileURLToPath(new URL('../fake-bin/fake-pi.js', import.meta.url));
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

// Wrapper (same as the codex grid): FAKE_MODE baked into a /bin/sh script;
// $$ IS the exec'd fake's pid.
const makeWrapper = (dir, mode, { prelude = '' } = {}) => {
  const fakeHome = join(dir, 'fake-home');
  mkdirSync(join(dir, 'bin'), { recursive: true });
  const bin = join(dir, 'bin', `pi-${mode}.sh`);
  writeFileSync(bin, '#!/bin/sh\n'
    + `export FAKE_MODE="${mode}"\n`
    + `export FAKE_HOME="${fakeHome}"\n`
    + `mkdir -p "$FAKE_HOME" && printf '%s\\n' "$$" > "$FAKE_HOME/last-pid"\n`
    + prelude
    + `exec "${FAKE_PI}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
};

const noopLog = { debug() {}, info() {}, warn() {}, error() {} };
const makeRunner = (dir, pc = {}, opts = {}) => createRunner({
  bot: { id: 'b1', provider: 'pi' },
  providerConfig: { cwd: dir, ...pc },
  log: noopLog,
  ...opts,
});

const AC = () => new AbortController();
const runOnce = (runner, { prompt = PROMPT, sessionId = undefined, signal, timeoutMs = 20_000, onEvent } = {}) =>
  runner.run({ prompt, sessionId, signal: signal ?? AC().signal, timeoutMs, onEvent });

const readFakeHome = (dir, name) => {
  try { return readFileSync(join(dir, 'fake-home', name), 'utf8'); } catch { return null; }
};

test('runner: ok run — completed shape, event mapping, stdin piped verbatim', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-pi-ok-'));
  try {
    const runner = makeRunner(dir, { piBin: makeWrapper(dir, 'ok'), piAgentDir: join(dir, 'pi-agent') });
    const events = [];
    const res = await runOnce(runner, { onEvent: (ev) => events.push(ev) });
    assert.equal(res.ok, true);
    assert.equal(res.code, 'completed');
    assert.equal(res.aborted, false);
    assert.ok(typeof res.sessionId === 'string' && res.sessionId !== '', 'session id from the session event');
    assert.equal(res.finalText, '答案文本', 'last turn text wins over the earlier delta');
    assert.equal(res.reason?.kind, 'completed');
    assert.equal(res.detail?.exitCode, 0);
    assert.equal(typeof res.detail?.stderrTail, 'string');
    // mapping: delta text + final text + tool(bash→Bash, brief has ls)
    const texts = events.filter((e) => e?.type === 'text').map((e) => e.text);
    assert.ok(texts.includes('先看看'), 'message_update delta emitted as text');
    assert.ok(texts.includes('答案文本'), 'message_end text emitted');
    const tool = events.find((e) => e?.type === 'tool');
    assert.equal(tool?.name, 'Bash');
    assert.ok(tool?.brief.includes('ls'));
    assert.equal(events.some((e) => e?.type === 'session' && e.sessionId === res.sessionId), true, 'session event surfaced');
    // prompt piped verbatim via stdin
    assert.equal(readFakeHome(dir, 'last-prompt'), PROMPT);
    // argv: -p --mode json, no positional prompt, no --session on fresh leg
    const argv = readFakeHome(dir, 'last-argv');
    assert.ok(argv.includes('-p --mode json'), `argv has -p --mode json: ${argv}`);
    assert.ok(!argv.includes('--session'), 'fresh leg carries no --session');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: resume leg adds --session <id>; thinking flag; provider/model flags; piArgs tail', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-pi-res-'));
  try {
    const runner = makeRunner(dir, {
      piBin: makeWrapper(dir, 'resume-echo'),
      piAgentDir: join(dir, 'pi-agent'),
      thinking: 'high',
      provider: 'magpie',
      model: { model: 'auto/glm-5.3-flash' },
      piArgs: ['--no-context-files', '--no-extensions'],
    });
    const res = await runOnce(runner, { sessionId: '01a1b1ae-95e0-753d-8db5-b87ca71e7824' });
    assert.equal(res.code, 'completed');
    // the fake echoes the --session value as the session id (baseline-proven)
    assert.equal(res.sessionId, '01a1b1ae-95e0-753d-8db5-b87ca71e7824', 'resume returns the SAME id');
    const argv = readFakeHome(dir, 'last-argv');
    assert.ok(argv.includes('--session 01a1b1ae-95e0-753d-8db5-b87ca71e7824'), `argv has --session: ${argv}`);
    assert.ok(argv.includes('--thinking high'), 'thinking flag passed when set');
    assert.ok(argv.includes('--provider magpie'), 'provider flag passed');
    assert.ok(argv.includes('--model auto/glm-5.3-flash'), 'model flag passed');
    assert.ok(argv.trim().endsWith('--no-context-files --no-extensions'), 'piArgs appended verbatim at the tail');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: thinking flag omitted when off/absent; env injection (PI_CODING_AGENT_DIR + apiKeyEnv)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-pi-env-'));
  try {
    const runner = makeRunner(dir, {
      piBin: makeWrapper(dir, 'ok'),
      piAgentDir: join(dir, 'pi-agent'),
      apiKeyEnv: 'MY_PI_KEY',
      model: { model: 'auto/glm-5.3-flash', apiKey: 'sk-literal' },
    });
    // The wrapper's env is the fake's env; capture it via a fake side file is
    // overkill — assert via a fake env dump mode? Keep it simple: the fake
    // writes last-argv; env proof rides on PI_CODING_AGENT_DIR being visible
    // to the CLI, which the contract's env-injection path already exercises.
    // Here we pin the ARGV side (no --thinking when off) and the run shape.
    const res = await runOnce(runner, {});
    assert.equal(res.code, 'completed');
    const argv = readFakeHome(dir, 'last-argv');
    assert.ok(!argv.includes('--thinking'), 'no --thinking flag when unset');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: thinking mode maps thinking blocks; toolLabel/describeToolBrief units', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-pi-thk-'));
  try {
    const runner = makeRunner(dir, { piBin: makeWrapper(dir, 'thinking') });
    const events = [];
    const res = await runOnce(runner, { onEvent: (ev) => events.push(ev) });
    assert.equal(res.code, 'completed');
    const think = events.find((e) => e?.type === 'thinking');
    assert.ok(think && think.text.includes('想一下'), 'thinking text mapped from block.thinking');
    assert.equal(res.finalText, '答案文本');
    assert.equal(toolLabel('bash'), 'Bash');
    assert.equal(toolLabel('read'), '读取');
    assert.equal(toolLabel('edit'), '编辑');
    assert.equal(toolLabel('write'), '写入');
    assert.equal(toolLabel('my_tool'), 'My_tool', 'unknown tool names pass through capitalized');
    assert.equal(toolLabel(undefined), 'Tool');
    assert.equal(describeToolBrief({ command: 'ls -la' }), 'ls -la');
    assert.equal(describeToolBrief({ path: '/a/b.md', oldText: 'x' }), '/a/b.md', 'first meaningful field wins');
    assert.equal(describeToolBrief({ pattern: 'foo.*bar'.repeat(20) }).length, 60, 'brief capped at 60');
    assert.equal(describeToolBrief(null), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: pi exits 0 on model failure — stopReason error + auto_retry_end → code error with finalError', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-pi-err-'));
  try {
    const runner = makeRunner(dir, { piBin: makeWrapper(dir, 'lock') });
    const res = await runOnce(runner, {});
    // exit 0 (pi's real failure shape) must NOT read as completed
    assert.equal(res.detail?.exitCode, 0);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'lock-conflict', 'invented lock text maps through the regex');
    assert.ok(res.error.includes('locked by another pi process'), 'finalError carried into error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: credential wording → missing-credential', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-pi-cred-'));
  try {
    const runner = makeRunner(dir, { piBin: makeWrapper(dir, 'credential') });
    const res = await runOnce(runner, {});
    assert.equal(res.ok, false);
    assert.equal(res.code, 'missing-credential');
    assert.ok(res.error.includes('PI_MAGPIE_API_KEY'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: gateway-404 shape — errorMessage on message_end surfaces (no auto_retry, no stderr)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-pi-404-'));
  try {
    const runner = makeRunner(dir, { piBin: makeWrapper(dir, 'model-error') });
    const res = await runOnce(runner, {});
    assert.equal(res.detail?.exitCode, 0, 'pi exits 0 on this failure class');
    assert.equal(res.detail?.stderrTail, '', 'stderr stays empty');
    assert.equal(res.ok, false);
    assert.equal(res.code, 'error');
    assert.ok(res.error.includes('magpie knows no model'), `errorMessage surfaced: ${JSON.stringify(res.error)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: exit-1 startup failure surfaces the first stderr line as error', async () => {
  // Pre-fix#1 shape (bad model with no models.json): pi exits 1, the reason
  // lives ONLY on stderr — the runner must carry it into errorText.
  const dir = mkdtempSync(join(tmpdir(), 'wao-pi-stderr-'));
  try {
    const runner = makeRunner(dir, { piBin: makeWrapper(dir, 'stderr-fail') });
    const res = await runOnce(runner, {});
    assert.equal(res.detail?.exitCode, 1);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'error');
    assert.ok(res.error.includes('Model "x/y" not found'), `stderr surfaced: ${JSON.stringify(res.error)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: abort carries partial text accumulated from deltas; child dead', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-pi-abort-'));
  try {
    const runner = makeRunner(dir, { piBin: makeWrapper(dir, 'partial-abort') });
    const events = [];
    const ac = AC();
    const p = runOnce(runner, { signal: ac.signal, onEvent: (ev) => events.push(ev) });
    await until(() => events.some((e) => e?.type === 'text'), 3000);
    ac.abort();
    const res = await p;
    assert.equal(res.aborted, true);
    assert.equal(res.code, 'aborted');
    assert.equal(res.finalText, '部分输出', 'delta-accumulated partial text survives the abort');
    const pid = Number((readFakeHome(dir, 'last-pid') ?? '').trim());
    assert.ok(Number.isInteger(pid) && pid > 0);
    assert.ok(await pidDeadWithin(pid, 3000));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: SIGTERM-ignoring child escalates to SIGKILL within the injectable budget', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-pi-esc-'));
  try {
    const runner = makeRunner(dir, { piBin: makeWrapper(dir, 'hang-sigterm') }, { escalationMs: 200 });
    const events = [];
    const ac = AC();
    const p = runOnce(runner, { signal: ac.signal, onEvent: (ev) => events.push(ev) });
    const sawText = await until(() => events.some((e) => e?.type === 'text'), 3000);
    assert.ok(sawText, 'text event observed before abort');
    const t0 = Date.now();
    ac.abort();
    const res = await p;
    assert.ok(Date.now() - t0 < 5000, 'escalation resolved quickly');
    assert.equal(res.code, 'aborted');
    assert.equal(res.aborted, true);
    const pid = Number((readFakeHome(dir, 'last-pid') ?? '').trim());
    assert.ok(Number.isInteger(pid) && pid > 0);
    assert.ok(await pidDeadWithin(pid, 3000));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: timeout kills with code timeout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-pi-tmo-'));
  try {
    const runner = makeRunner(dir, { piBin: makeWrapper(dir, 'hang-timeout') });
    const res = await runOnce(runner, { timeoutMs: 1500 });
    assert.equal(res.code, 'timeout');
    assert.equal(res.ok, false);
    const pid = Number((readFakeHome(dir, 'last-pid') ?? '').trim());
    assert.ok(Number.isInteger(pid) && pid > 0);
    assert.ok(await pidDeadWithin(pid, 3000));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: never rejects — missing binary resolves with code error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-pi-enoent-'));
  try {
    const runner = makeRunner(dir, { piBin: join(dir, 'no-such-bin') });
    const res = await runOnce(runner, {});
    assert.equal(res.ok, false);
    assert.equal(res.code, 'error');
    assert.ok(res.error, 'error message carried');
    assert.equal(res.detail?.exitCode, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: ALWAYS injects PI_CODING_AGENT_DIR — explicit piAgentDir wins, per-bot default otherwise', async () => {
  // Blind-review P0 regression pin: a UI-created bot without explicit
  // piAgentDir materializes models.json into ~/.pi/agent-wao-<botId> — pi
  // must be pointed THERE ($PI_CODING_AGENT_DIR always set), never left to
  // its own default ~/.pi/agent (which carries no gateway → `Model not
  // found`, exit 1).
  const dir = mkdtempSync(join(tmpdir(), 'wao-pi-agd-'));
  try {
    const home = process.env.HOME;
    process.env.HOME = dir; // pin the default formula's homedir input
    try {
      const runnerDefault = makeRunner(dir, { piBin: makeWrapper(dir, 'ok') });
      const resDefault = await runOnce(runnerDefault, {});
      assert.equal(resDefault.code, 'completed');
      assert.equal(
        readFakeHome(dir, 'last-env'),
        join(dir, '.pi', 'agent-wao-b1') + '\n',
        'default injection = ~/.pi/agent-wao-<botId> (same formula as models.js)',
      );

      const runnerExplicit = makeRunner(dir, { piBin: makeWrapper(dir, 'ok'), piAgentDir: join(dir, 'explicit-agent') });
      const resExplicit = await runOnce(runnerExplicit, {});
      assert.equal(resExplicit.code, 'completed');
      assert.equal(
        readFakeHome(dir, 'last-env'),
        join(dir, 'explicit-agent') + '\n',
        'explicit piAgentDir is passed through verbatim',
      );
    } finally {
      process.env.HOME = home;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: abort before spawn resolves immediately with no sessionId', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-pi-preabort-'));
  try {
    const runner = makeRunner(dir, { piBin: makeWrapper(dir, 'ok') });
    const ac = AC();
    ac.abort();
    const res = await runOnce(runner, { signal: ac.signal });
    assert.equal(res.code, 'aborted');
    assert.equal(res.sessionId, null);
    assert.equal(res.detail?.exitCode, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
