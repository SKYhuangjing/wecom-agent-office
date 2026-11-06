// Task 18 unit grid: plugins/provider-dsh/runner.js against the fake-dsh CLI.
// The fake is injected exactly like the contract suite does it — a /bin/sh
// wrapper exporting FAKE_MODE/FAKE_HOME before exec'ing fake-dsh.js (pid is
// preserved by exec, so last-pid is the pid the runner spawned) — so the
// runner needs no env-passthrough support beyond the 前身 apiKeyEnv injection.
// Covers: completed shape + unified events + stdin piping, resume argv,
// abort-partial, SIGKILL escalation (injectable escalationMs), timeout, lock,
// credential, first-event-abort sessionId drop, no-id-echo, never-rejects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunner } from '../../plugins/provider-dsh/runner.js';

const FAKE_DSH = fileURLToPath(new URL('../fake-bin/fake-dsh.js', import.meta.url));
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

// A wrapper bakes FAKE_MODE into a /bin/sh script (same technique as
// test/contract/provider.contract.js); exec preserves the pid, so last-pid is
// pid the runner spawned. The wrapper writes $$ itself (mkdir+printf, single
// digits of ms after spawn): the timeout cases SIGTERM 3s after run(), and
// under parallel-test load the wrapper+node boot can outrun that — killing the
// wrapper before the fake's top-level write, so last-pid never landed and the
// post-resolve read hit ENOENT (the M2 flake). $$ IS the exec'd fake's pid.
const makeWrapper = (dir, mode, { prelude = '' } = {}) => {
  const fakeHome = join(dir, 'fake-home');
  mkdirSync(join(dir, 'bin'), { recursive: true });
  const bin = join(dir, 'bin', `dsh-${mode}.sh`);
  writeFileSync(bin, '#!/bin/sh\n'
    + `export FAKE_MODE="${mode}"\n`
    + `export FAKE_HOME="${fakeHome}"\n`
    + `mkdir -p "$FAKE_HOME" && printf '%s\\n' "$$" > "$FAKE_HOME/last-pid"\n`
    + prelude
    + `exec "${FAKE_DSH}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
};

const noopLog = { debug() {}, info() {}, warn() {}, error() {} };
const makeRunner = (dir, pc = {}, opts = {}) => createRunner({
  bot: { id: 'b1', provider: 'dsh' },
  providerConfig: { cwd: dir, ...pc },
  log: noopLog,
  ...opts,
});

const AC = () => new AbortController();
const runOnce = (runner, { prompt = PROMPT, sessionId = undefined, signal, timeoutMs = 20_000, onEvent } = {}) =>
  runner.run({ prompt, sessionId, signal: signal ?? AC().signal, timeoutMs, onEvent });

test('runner: ok run — completed shape, unified events, stdin piped verbatim', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-dsh-ok-'));
  try {
    const bin = makeWrapper(dir, 'ok');
    const runner = makeRunner(dir, { dshBin: bin });
    const events = [];
    const res = await runOnce(runner, { onEvent: (ev) => events.push(ev) });
    assert.equal(res.ok, true);
    assert.equal(res.code, 'completed');
    assert.equal(res.aborted, false);
    assert.match(res.sessionId, /^session-fake-/);
    assert.equal(res.finalText, '答案文本');
    assert.equal(res.reason?.kind, 'completed');
    assert.equal(res.detail.exitCode, 0);
    assert.equal(res.detail.stderrTail, '');
    // unified events: session → step → tool → text (+ step_end), in order
    assert.equal(events[0]?.type, 'session');
    assert.equal(typeof events[0]?.sessionId, 'string');
    const step = events.find((e) => e.type === 'step');
    assert.ok(step, 'step event present');
    assert.equal(step.phase, 'step_start');
    assert.equal(step.n, 1);
    assert.ok(events.some((e) => e.type === 'step' && e.phase === 'step_end'), 'step_end event present');
    const tool = events.find((e) => e.type === 'tool');
    assert.ok(tool, 'tool event present');
    assert.equal(tool.name, 'Bash');
    assert.ok(tool.brief.includes('ls'), `tool.brief carries the command (${JSON.stringify(tool.brief)})`);
    const text = events.find((e) => e.type === 'text');
    assert.equal(text?.text, '答案文本');
    assert.ok(!events.some((e) => e.type === 'final'), 'final is bookkeeping, not a unified event');
    assert.equal(readFileSync(join(dir, 'fake-home', 'last-prompt'), 'utf8'), PROMPT, 'prompt piped verbatim via stdin');
    const argv = readFileSync(join(dir, 'fake-home', 'last-argv'), 'utf8');
    assert.match(argv, /--profile wecom-b1 --json -/, 'spawn argv shape');
    assert.ok(!argv.includes('--session-id'), 'fresh run omits --session-id');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: thinking unified event carries text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-dsh-think-'));
  try {
    const runner = makeRunner(dir, { dshBin: makeWrapper(dir, 'thinking') });
    const events = [];
    const res = await runOnce(runner, { onEvent: (ev) => events.push(ev) });
    assert.equal(res.code, 'completed');
    const think = events.find((e) => e.type === 'thinking');
    assert.ok(think, 'thinking event present');
    assert.equal(typeof think.text, 'string');
    assert.ok(think.text.length > 0, 'thinking.text non-empty');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: resume — --session-id in argv, same id returned; fresh run has none', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-dsh-res-'));
  try {
    const first = await runOnce(makeRunner(dir, { dshBin: makeWrapper(dir, 'ok') }));
    const sid = first.sessionId;
    assert.ok(sid, 'first run minted a session id');
    const second = await runOnce(
      makeRunner(dir, { dshBin: makeWrapper(dir, 'resume-echo') }),
      { sessionId: sid },
    );
    assert.equal(second.code, 'completed');
    assert.equal(second.sessionId, sid, 'resume returns the same session id');
    const argv = readFileSync(join(dir, 'fake-home', 'last-argv'), 'utf8');
    assert.ok(argv.includes(`--session-id ${sid}`), `argv carries --session-id (${argv.trim()})`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: abort mid-stream — aborted=true, partial finalText, child dead', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-dsh-ab-'));
  try {
    const runner = makeRunner(dir, { dshBin: makeWrapper(dir, 'partial-abort') });
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
    const pid = Number(readFileSync(join(dir, 'fake-home', 'last-pid'), 'utf8').trim());
    assert.ok(Number.isInteger(pid));
    assert.ok(await pidDeadWithin(pid, 3000), 'child dead (ESRCH) after resolve');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: SIGTERM-swallower — SIGKILL escalation, resolve fast, child dead', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-dsh-esc-'));
  try {
    // escalationMs injectable (default 3000): 250ms keeps the unit grid fast
    // while exercising the identical escalation path.
    const runner = makeRunner(dir, { dshBin: makeWrapper(dir, 'hang-sigterm') }, { escalationMs: 250 });
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
  const dir = mkdtempSync(join(tmpdir(), 'wao-dsh-tmo-'));
  try {
    const runner = makeRunner(dir, { dshBin: makeWrapper(dir, 'hang-timeout') });
    // 3s: fake boot (wrapper+node) measured 400-900ms; keeps pid-file check firm
    const res = await runOnce(runner, { timeoutMs: 3000 });
    assert.equal(res.code, 'timeout');
    assert.equal(res.ok, false);
    assert.equal(res.aborted, false);
    const pid = Number(readFileSync(join(dir, 'fake-home', 'last-pid'), 'utf8').trim());
    assert.ok(await pidDeadWithin(pid, 3000), 'child dead (ESRCH) after resolve');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: lock stderr — code=lock-conflict', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-dsh-lock-'));
  try {
    const runner = makeRunner(dir, { dshBin: makeWrapper(dir, 'lock') });
    const res = await runOnce(runner);
    assert.equal(res.code, 'lock-conflict');
    assert.equal(res.ok, false);
    assert.match(res.detail.stderrTail, /already owned by an active write handle/);
    assert.equal(res.detail.exitCode, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: credential error event — code=missing-credential', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-dsh-cred-'));
  try {
    const runner = makeRunner(dir, { dshBin: makeWrapper(dir, 'credential') });
    const res = await runOnce(runner);
    assert.equal(res.code, 'missing-credential');
    assert.equal(res.ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: abort BEFORE first session event — sessionId dropped (null), even on resume', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-dsh-fea-'));
  try {
    // The prelude sleeps 1s BEFORE exec'ing the fake, so an abort at ~100ms
    // kills the wrapper before any session event can exist — deterministic.
    const bin = makeWrapper(dir, 'partial-abort', { prelude: 'sleep 1\n' });
    const fresh = makeRunner(dir, { dshBin: bin });
    const ac1 = AC();
    const p1 = runOnce(fresh, { signal: ac1.signal });
    await sleep(100);
    ac1.abort();
    const r1 = await p1;
    assert.equal(r1.code, 'aborted');
    assert.equal(r1.sessionId, null, 'new session aborted pre-event must not hand back an id');

    const resume = makeRunner(dir, { dshBin: bin });
    const ac2 = AC();
    const p2 = runOnce(resume, { signal: ac2.signal, sessionId: 's-resume-1' });
    await sleep(100);
    ac2.abort();
    const r2 = await p2;
    assert.equal(r2.code, 'aborted');
    assert.equal(r2.sessionId, null, 'half-written resume killed pre-echo hands back no id either');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: no-id-echo — CLI never emits an id → INPUT sessionId returned', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-dsh-nie-'));
  try {
    // lock mode: no session event at all, plain failure — the id to hand back
    // next turn is still the one we were given (the session already exists).
    const runner = makeRunner(dir, { dshBin: makeWrapper(dir, 'lock') });
    const res = await runOnce(runner, { sessionId: 's-input-9' });
    assert.equal(res.code, 'lock-conflict');
    assert.equal(res.sessionId, 's-input-9');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: never rejects — spawn failure resolves code=error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-dsh-enoent-'));
  try {
    const runner = makeRunner(dir, { dshBin: '/nonexistent/dsh-bin-for-tests' });
    const res = await runOnce(runner);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'error');
    assert.ok(res.error || res.detail, 'diagnostics present');
    assert.equal(res.sessionId, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: abort-before-spawn — resolves aborted without spawning', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-dsh-pre-'));
  try {
    let spawned = false;
    const runner = createRunner({
      bot: { id: 'b1' },
      providerConfig: { cwd: dir, dshBin: '/nonexistent/either' },
      log: noopLog,
    });
    // any spawn attempt would fail with error anyway; assert the fast path
    const ac = AC();
    ac.abort();
    const res = await runner.run({ prompt: PROMPT, signal: ac.signal, timeoutMs: 5000, onEvent: () => { spawned = true; } });
    assert.equal(res.code, 'aborted');
    assert.equal(res.aborted, true);
    assert.equal(res.sessionId, null);
    assert.equal(spawned, false, 'no events on the pre-abort fast path');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: model apiKey+apiKeyEnv injected into child env (前身 constructor semantics)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-dsh-env-'));
  try {
    // Wrapper captures the injected var before exec'ing the fake.
    const fakeHome = join(dir, 'fake-home');
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(join(dir, 'bin'), { recursive: true });
    const bin = join(dir, 'bin', 'dsh-envprobe.sh');
    writeFileSync(bin, '#!/bin/sh\n'
      + `export FAKE_MODE="ok"\nexport FAKE_HOME="${fakeHome}"\n`
      + `printf '%s' "$BOT_KEY_ENV" > "${join(fakeHome, 'saw-key')}"\n`
      + `exec "${FAKE_DSH}" "$@"\n`);
    chmodSync(bin, 0o755);
    const runner = makeRunner(dir, {
      dshBin: bin,
      model: { provider: 'p', model: 'm', apiKeyEnv: 'BOT_KEY_ENV', apiKey: '{{SECRET_c0a4cd78}}' },
    });
    const res = await runOnce(runner);
    assert.equal(res.code, 'completed');
    assert.equal(readFileSync(join(fakeHome, 'saw-key'), 'utf8'), '{{SECRET_c0a4cd78}}');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: onEvent stops after run() resolves (event-timing hold)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-dsh-timing-'));
  try {
    const runner = makeRunner(dir, { dshBin: makeWrapper(dir, 'ok') });
    const events = [];
    await runOnce(runner, { onEvent: (ev) => events.push(ev) });
    const seen = events.length;
    await sleep(150);
    assert.equal(events.length, seen, 'no onEvent callbacks after resolve');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
