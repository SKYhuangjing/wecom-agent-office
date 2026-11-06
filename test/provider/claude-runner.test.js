// M2 Task 2 unit grid: plugins/provider-claude/runner.js against the
// fake-claude CLI. The fake is injected exactly like the contract suite does
// it — a /bin/sh wrapper exporting FAKE_MODE/FAKE_HOME before exec'ing
// fake-claude.js (exec keeps the pid, so last-pid is the pid the runner
// spawned) — so the runner needs no env-passthrough support beyond the
// gateway env injection (model.baseURL/apiKey → ANTHROPIC_*).
// Covers: completed shape + unified events + stdin piping, thinking payload
// (.thinking, thinking_tokens noise skipped), tool_use mapping, resume argv
// (--resume), abort-partial, SIGKILL escalation (injectable escalationMs),
// timeout, lock, IsolationError hedge, credential, first-event-abort sessionId
// drop, no-id-echo, never-rejects, gateway env, argv assembly
// (--model/--permission-mode/--allowedTools/--append-system-prompt).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunner } from '../../plugins/provider-claude/runner.js';

const FAKE_CLAUDE = fileURLToPath(new URL('../fake-bin/fake-claude.js', import.meta.url));
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
  const bin = join(dir, 'bin', `claude-${mode}.sh`);
  writeFileSync(bin, '#!/bin/sh\n'
    + `export FAKE_MODE="${mode}"\n`
    + `export FAKE_HOME="${fakeHome}"\n`
    + prelude
    + `exec "${FAKE_CLAUDE}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
};

const noopLog = { debug() {}, info() {}, warn() {}, error() {} };
const makeRunner = (dir, pc = {}, opts = {}) => createRunner({
  bot: { id: 'b1', provider: 'claude' },
  providerConfig: { cwd: dir, ...pc },
  log: noopLog,
  ...opts,
});

const AC = () => new AbortController();
const runOnce = (runner, { prompt = PROMPT, sessionId = undefined, signal, timeoutMs = 20_000, onEvent } = {}) =>
  runner.run({ prompt, sessionId, signal: signal ?? AC().signal, timeoutMs, onEvent });

test('runner: ok run — completed shape, unified events, stdin piped verbatim', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cla-ok-'));
  try {
    const runner = makeRunner(dir, { claudeBin: makeWrapper(dir, 'ok') });
    const events = [];
    const res = await runOnce(runner, { onEvent: (ev) => events.push(ev) });
    assert.equal(res.ok, true);
    assert.equal(res.code, 'completed');
    assert.equal(res.aborted, false);
    assert.match(res.sessionId, /^[0-9a-f]{8}-/);
    assert.equal(res.finalText, '答案文本');
    assert.equal(res.reason?.kind, 'completed');
    assert.equal(res.detail.exitCode, 0);
    // unified events: session → tool → text; result is bookkeeping only
    assert.equal(events[0]?.type, 'session');
    assert.equal(typeof events[0]?.sessionId, 'string');
    const tool = events.find((e) => e.type === 'tool');
    assert.ok(tool, 'tool event present');
    assert.equal(tool.name, 'Bash');
    assert.ok(tool.brief.includes('ls'), `tool.brief carries the command (${JSON.stringify(tool.brief)})`);
    const text = events.find((e) => e.type === 'text');
    assert.equal(text?.text, '答案文本');
    assert.ok(!events.some((e) => e.type === 'step'), 'claude has no step events');
    assert.equal(readFileSync(join(dir, 'fake-home', 'last-prompt'), 'utf8'), PROMPT, 'prompt piped verbatim via stdin');
    const argv = readFileSync(join(dir, 'fake-home', 'last-argv'), 'utf8');
    assert.match(argv, /-p --output-format stream-json --verbose/, 'spawn argv shape');
    assert.ok(!argv.includes('--resume'), 'fresh run omits --resume');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: thinking block payload in .thinking; thinking_tokens noise not mapped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cl-think-'));
  try {
    const runner = makeRunner(dir, { claudeBin: makeWrapper(dir, 'thinking') });
    const events = [];
    const res = await runOnce(runner, { onEvent: (ev) => events.push(ev) });
    assert.equal(res.code, 'completed');
    const thinks = events.filter((e) => e.type === 'thinking');
    assert.equal(thinks.length, 1, `exactly one thinking event (got ${thinks.length} of ${events.length})`);
    assert.equal(thinks[0].text, '好的，让我先想一下这个问题。');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: resume — --resume in argv, SAME id echoed back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cl-res-'));
  try {
    const first = await runOnce(makeRunner(dir, { claudeBin: makeWrapper(dir, 'ok') }));
    const sid = first.sessionId;
    assert.ok(sid, 'first run minted a session id');
    const second = await runOnce(
      makeRunner(dir, { claudeBin: makeWrapper(dir, 'resume-echo') }),
      { sessionId: sid },
    );
    assert.equal(second.code, 'completed');
    assert.equal(second.sessionId, sid, 'resume returns the same session id');
    const argv = readFileSync(join(dir, 'fake-home', 'last-argv'), 'utf8');
    assert.ok(argv.includes(`--resume ${sid}`), `argv carries --resume (${argv.trim()})`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: argv assembly — --model/--permission-mode/--allowedTools/--append-system-prompt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cl-argv-'));
  try {
    const runner = makeRunner(dir, {
      claudeBin: makeWrapper(dir, 'ok'),
      model: { model: 'auto/glm-5.3-flash' },
      permissionMode: 'acceptEdits',
      allowedTools: ['Bash', 'Read'],
      prompt: '你是严谨的助手',
    });
    const res = await runOnce(runner);
    assert.equal(res.code, 'completed');
    const argv = readFileSync(join(dir, 'fake-home', 'last-argv'), 'utf8');
    assert.ok(argv.includes('--model auto/glm-5.3-flash'), argv.trim());
    assert.ok(argv.includes('--permission-mode acceptEdits'), argv.trim());
    assert.ok(argv.includes('--allowedTools Bash,Read'), argv.trim());
    assert.ok(argv.includes('--append-system-prompt 你是严谨的助手'), argv.trim());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: gateway env — model.baseURL→ANTHROPIC_BASE_URL, apiKey→ANTHROPIC_AUTH_TOKEN; providerConfig.env wins', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cl-env-'));
  try {
    // Wrapper captures the injected vars before exec'ing the fake.
    const fakeHome = join(dir, 'fake-home');
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(join(dir, 'bin'), { recursive: true });
    const bin = join(dir, 'bin', 'claude-envprobe.sh');
    writeFileSync(bin, '#!/bin/sh\n'
      + `export FAKE_MODE="ok"\nexport FAKE_HOME="${fakeHome}"\n`
      + `printf '%s\\n%s\\n%s' "$ANTHROPIC_BASE_URL" "$ANTHROPIC_AUTH_TOKEN" "$BOT_EXTRA" > "${join(fakeHome, 'saw-env')}"\n`
      + `exec "${FAKE_CLAUDE}" "$@"\n`);
    chmodSync(bin, 0o755);
    const runner = makeRunner(dir, {
      claudeBin: bin,
      model: { model: 'm', baseURL: 'https://gw.example/v1', apiKey: 'sk-bot' },
      env: { BOT_EXTRA: 'yes', ANTHROPIC_AUTH_TOKEN: 'sk-explicit' },
    });
    const res = await runOnce(runner);
    assert.equal(res.code, 'completed');
    const [base, token, extra] = readFileSync(join(fakeHome, 'saw-env'), 'utf8').split('\n');
    assert.equal(base, 'https://gw.example/v1');
    assert.equal(token, 'sk-explicit', 'providerConfig.env overrides the model-derived token');
    assert.equal(extra, 'yes', 'providerConfig.env passed through');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: abort mid-stream — aborted=true, partial finalText, child dead', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cl-ab-'));
  try {
    const runner = makeRunner(dir, { claudeBin: makeWrapper(dir, 'partial-abort') });
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
  const dir = mkdtempSync(join(tmpdir(), 'wao-cl-esc-'));
  try {
    // escalationMs injectable (default 3000): 250ms keeps the grid fast
    // while exercising the identical escalation path.
    const runner = makeRunner(dir, { claudeBin: makeWrapper(dir, 'hang-sigterm') }, { escalationMs: 250 });
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
  const dir = mkdtempSync(join(tmpdir(), 'wao-cl-tmo-'));
  try {
    const runner = makeRunner(dir, { claudeBin: makeWrapper(dir, 'hang-timeout') });
    // 3s: fake boot (wrapper+node) measured 400-900ms; keeps pid-file check firm
    const res = await runOnce(runner, { timeoutMs: 3000 });
    assert.equal(res.code, 'timeout');
    assert.equal(res.ok, false);
    assert.equal(res.aborted, false);
    const pid = Number(readFileSync(join(dir, 'fake-home', 'last-pid'), 'utf8').trim());
    assert.ok(await pidDeadWithin(pid, 3000), 'child dead (ESRCH) after resolve');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: lock stderr/result — code=lock-conflict', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cl-lock-'));
  try {
    const runner = makeRunner(dir, { claudeBin: makeWrapper(dir, 'lock') });
    const res = await runOnce(runner);
    assert.equal(res.code, 'lock-conflict');
    assert.equal(res.ok, false);
    assert.match(res.detail.stderrTail, /is locked by another process/);
    assert.equal(res.detail.exitCode, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: IsolationError stderr (no invented lock text) — code=lock-conflict', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cl-iso-'));
  try {
    // The regex hedge (M2-T3): a bare `IsolationError` on stderr with NONE of
    // fake-claude's invented lock phrasing must still map to lock-conflict —
    // real claude's conflict wording is unknown until M3, so the fallback
    // token carries this shape on its own (fake-claude text stays untouched;
    // regex and fake are co-validated, see the lock test above).
    mkdirSync(join(dir, 'bin'), { recursive: true });
    const bin = join(dir, 'bin', 'claude-isolation.sh');
    writeFileSync(bin, '#!/bin/sh\necho "Error: IsolationError: session is owned by an active process" >&2\nexit 1\n');
    chmodSync(bin, 0o755);
    const runner = makeRunner(dir, { claudeBin: bin });
    const res = await runOnce(runner);
    assert.equal(res.code, 'lock-conflict');
    assert.equal(res.ok, false);
    assert.match(res.detail.stderrTail, /IsolationError/);
    assert.equal(res.detail.exitCode, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: credential error — code=missing-credential', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cl-cred-'));
  try {
    const runner = makeRunner(dir, { claudeBin: makeWrapper(dir, 'credential') });
    const res = await runOnce(runner);
    assert.equal(res.code, 'missing-credential');
    assert.equal(res.ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: result error subtype (no lock/credential text) — code=error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cl-err-'));
  try {
    // Unknown FAKE_MODE: stderr carries an unmatched error, exit 2 — the
    // error-subtype mapping must fall through to generic error.
    const runner = makeRunner(dir, { claudeBin: makeWrapper(dir, 'bogus-mode') });
    const res = await runOnce(runner);
    assert.equal(res.code, 'error');
    assert.equal(res.ok, false);
    assert.match(res.detail.stderrTail, /unknown FAKE_MODE/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: abort BEFORE first init event — sessionId dropped (null), even on resume', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cl-fea-'));
  try {
    // The prelude sleeps 1s BEFORE exec'ing the fake, so an abort at ~100ms
    // kills the wrapper before any init event can exist — deterministic.
    const bin = makeWrapper(dir, 'partial-abort', { prelude: 'sleep 1\n' });
    const fresh = makeRunner(dir, { claudeBin: bin });
    const ac1 = AC();
    const p1 = runOnce(fresh, { signal: ac1.signal });
    await sleep(100);
    ac1.abort();
    const r1 = await p1;
    assert.equal(r1.code, 'aborted');
    assert.equal(r1.sessionId, null, 'new session aborted pre-event must not hand back an id');

    const resume = makeRunner(dir, { claudeBin: bin });
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
  const dir = mkdtempSync(join(tmpdir(), 'wao-cl-nie-'));
  try {
    // lock mode: no init event at all, plain failure — the id to hand back
    // next turn is still the one we were given (the session already exists).
    const runner = makeRunner(dir, { claudeBin: makeWrapper(dir, 'lock') });
    const res = await runOnce(runner, { sessionId: '16cc03ca-0000-4000-8000-000000000000' });
    assert.equal(res.code, 'lock-conflict');
    assert.equal(res.sessionId, '16cc03ca-0000-4000-8000-000000000000');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: never rejects — spawn failure resolves code=error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cl-enoent-'));
  try {
    const runner = makeRunner(dir, { claudeBin: '/nonexistent/claude-bin-for-tests' });
    const res = await runOnce(runner);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'error');
    assert.ok(res.error || res.detail, 'diagnostics present');
    assert.equal(res.sessionId, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: abort-before-spawn — resolves aborted without spawning', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cl-pre-'));
  try {
    let spawned = false;
    const runner = createRunner({
      bot: { id: 'b1' },
      providerConfig: { cwd: dir, claudeBin: '/nonexistent/either' },
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
  const dir = mkdtempSync(join(tmpdir(), 'wao-cl-timing-'));
  try {
    const runner = makeRunner(dir, { claudeBin: makeWrapper(dir, 'ok') });
    const events = [];
    await runOnce(runner, { onEvent: (ev) => events.push(ev) });
    const seen = events.length;
    await sleep(150);
    assert.equal(events.length, seen, 'no onEvent callbacks after resolve');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
