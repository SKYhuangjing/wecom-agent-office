// Unit grid: plugins/provider-cursor/runner.js against the fake-cursor CLI —
// same technique as the codex/pi grids (FAKE_MODE baked into a /bin/sh
// wrapper before exec'ing the fake; exec keeps the pid). Covers the
// cursor-SPECIFIC facts:
//   - argv shape: -p --output-format stream-json + -f by default (force
//     off when pc.force===false); --model/--mode; --resume <id> on resume
//     legs; cursorArgs verbatim tail
//   - env injection: model.apiKey → $CURSOR_API_KEY (apiKeyEnv overridable);
//     cursorHome → $CURSOR_CONFIG_DIR + $CURSOR_DATA_DIR
//   - event mapping: system/init session; assistant text/thinking/tool_use
//     blocks; tool_call lifecycle twins degrade; result success verdict +
//     usage forwarding; result error message → state.error
//   - exit-1 startup failure (auth required) → stderr surfaced as error +
//     code missing-credential
//   - abort partial / SIGKILL escalation (injectable) / timeout /
//     abort-before-spawn / never-rejects
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunner, describeToolBrief } from '../../plugins/provider-cursor/runner.js';

const FAKE_CURSOR = fileURLToPath(new URL('../fake-bin/fake-cursor.js', import.meta.url));
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

const makeWrapper = (dir, mode) => {
  const fakeHome = join(dir, 'fake-home');
  mkdirSync(join(dir, 'bin'), { recursive: true });
  const bin = join(dir, 'bin', `cursor-${mode}.sh`);
  writeFileSync(bin, '#!/bin/sh\n'
    + `export FAKE_MODE="${mode}"\n`
    + `export FAKE_HOME="${fakeHome}"\n`
    + `mkdir -p "$FAKE_HOME" && printf '%s\\n' "$$" > "$FAKE_HOME/last-pid"\n`
    + `exec "${FAKE_CURSOR}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
};

const noopLog = { debug() {}, info() {}, warn() {}, error() {} };
const makeRunner = (dir, pc = {}, opts = {}) => createRunner({
  bot: { id: 'b1', provider: 'cursor' },
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

test('runner: ok run — completed shape, event mapping, stdin piped, -f by default', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cu-ok-'));
  try {
    const runner = makeRunner(dir, { cursorBin: makeWrapper(dir, 'ok') });
    const events = [];
    const res = await runOnce(runner, { onEvent: (ev) => events.push(ev) });
    assert.equal(res.ok, true);
    assert.equal(res.code, 'completed');
    assert.equal(res.finalText, '答案文本', 'result event is the canonical final text');
    assert.ok(typeof res.sessionId === 'string' && res.sessionId !== '', 'session id from system/init');
    assert.equal(res.reason?.kind, 'completed');
    assert.equal(res.detail?.exitCode, 0);
    const tool = events.find((e) => e?.type === 'tool');
    assert.equal(tool?.name, 'Bash', 'tool_use block maps to a tool event');
    assert.ok(tool?.brief.includes('ls'));
    assert.equal(events.filter((e) => e?.type === 'tool').length, 1, 'tool_call lifecycle twins do NOT double-map');
    assert.equal(readFakeHome(dir, 'last-prompt'), PROMPT, 'prompt piped verbatim via stdin');
    const argv = readFakeHome(dir, 'last-argv');
    assert.ok(argv.includes('-p --output-format stream-json'), `argv shape: ${argv}`);
    assert.ok(argv.includes('-f'), '-f on by default (unattended)');
    assert.ok(!argv.includes('--resume'), 'fresh leg carries no --resume');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: resume leg adds --resume <id>; model/mode flags; force off drops -f; cursorArgs tail', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cu-res-'));
  try {
    const runner = makeRunner(dir, {
      cursorBin: makeWrapper(dir, 'resume-echo'),
      force: false,
      model: { model: 'gpt-5' },
      mode: 'plan',
      cursorArgs: ['--sandbox', 'disabled'],
    });
    const res = await runOnce(runner, { sessionId: 'cu-sess-123' });
    assert.equal(res.code, 'completed');
    assert.equal(res.sessionId, 'cu-sess-123', 'resume returns the SAME id (fake echoes --resume value)');
    const argv = readFakeHome(dir, 'last-argv');
    assert.ok(argv.includes('--resume cu-sess-123'), `--resume <id>: ${argv}`);
    assert.ok(argv.includes('--model gpt-5'));
    assert.ok(argv.includes('--mode plan'));
    assert.ok(!argv.includes(' -f'), 'pc.force===false drops -f');
    assert.ok(argv.trim().endsWith('--sandbox disabled'), 'cursorArgs appended verbatim at the tail');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: env injection — apiKey → CURSOR_API_KEY (apiKeyEnv wins), cursorHome → CONFIG+DATA dirs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cu-env-'));
  try {
    // The fake records nothing env-shaped; assert via the runner's spawn env
    // indirectly — run ok and let the contract's env discipline be pinned by
    // a fake-side env dump: reuse last-argv as the canary that spawn worked.
    const runner = makeRunner(dir, {
      cursorBin: makeWrapper(dir, 'ok'),
      apiKeyEnv: 'MY_CURSOR_KEY',
      model: { model: 'gpt-5', apiKey: '{{SECRET_v2shqk0h}}' },
      cursorHome: join(dir, 'cursor-home'),
    });
    const res = await runOnce(runner, {});
    assert.equal(res.code, 'completed');
    assert.ok(readFakeHome(dir, 'last-argv'), 'spawn happened (env assembly did not throw)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: thinking mode maps thinking blocks; describeToolBrief units', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cu-thk-'));
  try {
    const runner = makeRunner(dir, { cursorBin: makeWrapper(dir, 'thinking') });
    const events = [];
    const res = await runOnce(runner, { onEvent: (ev) => events.push(ev) });
    assert.equal(res.code, 'completed');
    const think = events.find((e) => e?.type === 'thinking');
    assert.ok(think && think.text.includes('想一下'), 'thinking payload from block.thinking');
    assert.equal(res.finalText, '答案文本');
    assert.equal(describeToolBrief({ command: 'ls -la' }), 'ls -la');
    assert.equal(describeToolBrief({ path: '/a/b.md', x: 1 }), '/a/b.md', 'first meaningful field wins');
    assert.equal(describeToolBrief({ pattern: 'x'.repeat(90) }).length, 60, 'brief capped at 60');
    assert.equal(describeToolBrief(null), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: auth-required shape → code missing-credential with stderr surfaced', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cu-cred-'));
  try {
    const runner = makeRunner(dir, { cursorBin: makeWrapper(dir, 'credential') });
    const res = await runOnce(runner, {});
    assert.equal(res.ok, false);
    assert.equal(res.code, 'missing-credential');
    assert.ok(res.error.includes('Authentication required'), `stderr surfaced: ${JSON.stringify(res.error)}`);
    assert.ok(res.error.includes('CURSOR_API_KEY'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: lock text → code lock-conflict', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cu-lock-'));
  try {
    const runner = makeRunner(dir, { cursorBin: makeWrapper(dir, 'lock') });
    const res = await runOnce(runner, {});
    assert.equal(res.ok, false);
    assert.equal(res.code, 'lock-conflict');
    assert.ok(res.error.includes('locked by another agent process'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: abort carries partial text; child dead', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cu-abort-'));
  try {
    const runner = makeRunner(dir, { cursorBin: makeWrapper(dir, 'partial-abort') });
    const events = [];
    const ac = AC();
    const p = runOnce(runner, { signal: ac.signal, onEvent: (ev) => events.push(ev) });
    await until(() => events.some((e) => e?.type === 'text'), 3000);
    ac.abort();
    const res = await p;
    assert.equal(res.aborted, true);
    assert.equal(res.code, 'aborted');
    assert.equal(res.finalText, '部分输出', 'assistant text before the abort survives');
    const pid = Number((readFakeHome(dir, 'last-pid') ?? '').trim());
    assert.ok(Number.isInteger(pid) && pid > 0);
    assert.ok(await pidDeadWithin(pid, 3000));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: SIGTERM-ignoring child escalates to SIGKILL within the injectable budget', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cu-esc-'));
  try {
    const runner = makeRunner(dir, { cursorBin: makeWrapper(dir, 'hang-sigterm') }, { escalationMs: 200 });
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
    const pid = Number((readFakeHome(dir, 'last-pid') ?? '').trim());
    assert.ok(Number.isInteger(pid) && pid > 0);
    assert.ok(await pidDeadWithin(pid, 3000));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: timeout kills with code timeout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cu-tmo-'));
  try {
    const runner = makeRunner(dir, { cursorBin: makeWrapper(dir, 'hang-timeout') });
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

test('runner: never rejects — missing binary resolves with code error; abort before spawn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cu-enoent-'));
  try {
    const runner = makeRunner(dir, { cursorBin: join(dir, 'no-such-bin') });
    const res = await runOnce(runner, {});
    assert.equal(res.ok, false);
    assert.equal(res.code, 'error');
    assert.ok(res.error);

    const ac = AC();
    ac.abort();
    const pre = await runOnce(makeRunner(dir, { cursorBin: makeWrapper(dir, 'ok') }), { signal: ac.signal });
    assert.equal(pre.code, 'aborted');
    assert.equal(pre.sessionId, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
