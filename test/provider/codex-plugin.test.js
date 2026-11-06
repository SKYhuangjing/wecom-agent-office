// M2 Task 5: the provider-codex plugin ASSEMBLY — plugins/provider-codex/
// plugin.js loaded through the REAL kernel machinery (importPlugin +
// validateManifest + lifecycle.activate — the contract suite's loading
// pattern, not a bare module import), so the port registration itself is
// under test: manifest validity, the port 'codex' landing in the registry
// with the full §5 impl surface, semantic validate (cwd / sandbox enum /
// configOverrides key=value shape / model / env), materializeConfig → null,
// the code→中文 describeError copy for all six §5 runResult codes, and one
// fake-codex run driven through the PORT's createRunner proving plugin.js
// wires runner.js (the T4 gap: the plugin file was built but never loaded).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEventBus } from '../../src/kernel/events.js';
import { createServices } from '../../src/kernel/services.js';
import { createHttpShell } from '../../src/kernel/http.js';
import { createLifecycle } from '../../src/kernel/lifecycle.js';
import { importPlugin, validateManifest } from '../../src/kernel/loader.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLUGIN_DIR = join(REPO, 'plugins', 'provider-codex');
const FAKE_CODEX = fileURLToPath(new URL('../fake-bin/fake-codex.js', import.meta.url));

const noopLog = { debug() {}, info() {}, warn() {}, error() {}, child: () => noopLog };

let impl; // the registered provider port impl under test
let lifecycle;
let pluginRec; // {manifest, mod} kept for the teardown deactivate

before(async () => {
  const rec = await importPlugin(PLUGIN_DIR);
  const errors = validateManifest(rec.manifest);
  assert.deepEqual(errors, [], 'manifest passes kernel validation');
  assert.equal(rec.manifest.id, 'provider-codex');
  lifecycle = createLifecycle({
    events: createEventBus({ log: noopLog }),
    services: createServices(),
    log: noopLog,
    http: createHttpShell({ log: noopLog }),
  });
  pluginRec = { dir: PLUGIN_DIR, manifest: rec.manifest, mod: rec.mod.default, status: 'enabled', config: {} };
  await lifecycle.activate(pluginRec);
  const entry = lifecycle.portRegistry.provider.get('codex');
  assert.ok(entry, "activate registered the port 'codex'");
  impl = entry.impl;
});

after(async () => {
  await lifecycle.deactivateAll();
  assert.equal(lifecycle.portRegistry.provider.get('codex'), undefined, 'port revoked on deactivate');
});

// The impl surface §5 demands (everything plugin.js registers).
test('plugin: activate registers port codex with the full §5 impl surface', () => {
  for (const member of ['configSchema', 'validate', 'materializeConfig', 'createRunner', 'describeError']) {
    assert.ok(impl[member] != null, `${member} registered`);
  }
  for (const fn of ['validate', 'materializeConfig', 'createRunner', 'describeError']) {
    assert.equal(typeof impl[fn], 'function', `${fn} is a function`);
  }
});

test('plugin: configSchema — cwd required, sandbox enum carries the three real modes, no sandbox default', () => {
  const byKey = Object.fromEntries(impl.configSchema.map((s) => [s.key, s]));
  assert.equal(byKey.cwd.required, true, 'cwd is the one required key');
  assert.deepEqual(byKey.sandbox.options, ['read-only', 'workspace-write', 'danger-full-access']);
  assert.equal(byKey.sandbox.default, undefined, 'no sandbox default — omitting the flag keeps codex config.toml default');
});

// 2026-11-06 拟人播报: the two broadcast knobs every provider exposes (same
// rows on dsh/claude/codex/_template so the M3 UI renders them uniformly).
test('plugin: configSchema — progressStyle enum (default polite) + progressText template default', () => {
  const byKey = Object.fromEntries(impl.configSchema.map((s) => [s.key, s]));
  assert.deepEqual(byKey.progressStyle.options, ['polite', 'cot']);
  assert.equal(byKey.progressStyle.default, 'polite', 'polite is the DEFAULT since 2026-11-06 (owner decision)');
  assert.equal(byKey.progressStyle.label.includes('工作汇报风格'), true);
  assert.equal(byKey.progressText.type, 'string');
  assert.equal(byKey.progressText.default, '{bot} 思考中{dots} 请稍等（已 {elapsed}）');
  assert.ok(byKey.progressText.label.includes('{bot}'), 'the label documents the placeholders');
});

test('plugin: validate — progressText over 120 chars rejected (400), exactly 120 passes', () => {
  const bad = impl.validate({ cwd: '/w', progressText: 'x'.repeat(121) });
  assert.equal(bad.length, 1, `exactly one error (got ${JSON.stringify(bad)})`);
  assert.match(bad[0], /progressText.*120/);
  assert.deepEqual(impl.validate({ cwd: '/w', progressText: '{bot} 思考中{dots} 请稍等（已 {elapsed}）' }), [], 'the default template is valid');
  assert.deepEqual(impl.validate({ cwd: '/w', progressText: 'x'.repeat(120) }), [], 'exactly 120 chars passes');
});

test('plugin: validate — cwd presence (missing/empty/non-string)', () => {
  assert.ok(impl.validate({}).some((e) => /^providerConfig\.cwd is required/.test(e)), 'missing cwd');
  assert.ok(impl.validate({ cwd: '' }).some((e) => /cwd is required/.test(e)), 'empty cwd');
  assert.ok(impl.validate({ cwd: 42 }).some((e) => /cwd is required/.test(e)), 'non-string cwd');
  assert.ok(impl.validate(undefined).some((e) => /cwd is required/.test(e)), 'no providerConfig at all');
  assert.deepEqual(impl.validate({ cwd: '/w' }), [], 'minimal valid config is clean');
});

test('plugin: validate — sandbox enum (bad value rejected with the modes listed, all three pass)', () => {
  const bad = impl.validate({ cwd: '/w', sandbox: 'full-access' });
  assert.equal(bad.length, 1, `exactly one error (got ${JSON.stringify(bad)})`);
  assert.equal(bad[0], 'providerConfig.sandbox must be one of read-only, workspace-write, danger-full-access');
  for (const mode of ['read-only', 'workspace-write', 'danger-full-access']) {
    assert.deepEqual(impl.validate({ cwd: '/w', sandbox: mode }), [], `${mode} accepted`);
  }
});

test('plugin: validate — configOverrides must be a list of key=value with a non-empty key', () => {
  assert.ok(
    impl.validate({ cwd: '/w', configOverrides: 'openai_base_url=https://gw/v1' }).some((e) => /configOverrides must be a list/.test(e)),
    'non-list rejected',
  );
  const cases = [
    ['openai_base_url=https://gw.example/v1', true, 'gateway url entry passes'],
    ['model_reasoning_effort=high', true, 'bare-word value passes'],
    ['shell_environment_policy.inherit=all', true, 'dotted key passes'],
    ['foo', false, 'no = rejected'],
    ['=bar', false, 'empty key rejected'],
    ['   =bar', false, 'whitespace-only key rejected'],
    ['', false, 'empty string rejected'],
    [42, false, 'non-string entry rejected (and reported with its JSON shape)'],
  ];
  for (const [entry, ok, label] of cases) {
    const errors = impl.validate({ cwd: '/w', configOverrides: [entry] });
    if (ok) assert.deepEqual(errors, [], label);
    else assert.equal(
      errors.filter((e) => e.startsWith('providerConfig.configOverrides[0]')).length, 1,
      `${label} (got ${JSON.stringify(errors)})`,
    );
  }
  // every offending entry is indexed, not just the first
  const two = impl.validate({ cwd: '/w', configOverrides: ['foo', 'ok=1', '=x'] });
  assert.ok(two.some((e) => e.startsWith('providerConfig.configOverrides[0]')));
  assert.ok(two.some((e) => e.startsWith('providerConfig.configOverrides[2]')));
  assert.ok(!two.some((e) => e.startsWith('providerConfig.configOverrides[1]')), 'the good middle entry is not flagged');
});

test('plugin: validate — model completeness, apiKeyEnv, env value types', () => {
  assert.ok(impl.validate({ cwd: '/w', model: 'gpt-5.2' }).some((e) => /model must be an object/.test(e)), 'scalar model rejected');
  assert.ok(impl.validate({ cwd: '/w', model: ['x'] }).some((e) => /model must be an object/.test(e)), 'array model rejected');
  assert.ok(impl.validate({ cwd: '/w', model: { apiKey: 'sk' } }).some((e) => /model\.model is required/.test(e)), 'model without .model rejected');
  assert.deepEqual(impl.validate({ cwd: '/w', model: { model: 'gpt-5.2-codex', apiKey: 'sk' } }), [], 'full model object passes');
  assert.ok(impl.validate({ cwd: '/w', apiKeyEnv: 3 }).some((e) => /apiKeyEnv must be a string/.test(e)), 'non-string apiKeyEnv rejected');
  assert.ok(impl.validate({ cwd: '/w', env: 'nope' }).some((e) => /env must be an object/.test(e)), 'non-object env rejected');
  assert.ok(
    impl.validate({ cwd: '/w', env: { CODEX_API_KEY: 'sk', OOPS: 7 } }).some((e) => /env\.OOPS must be a string \(got number\)/.test(e)),
    'non-string env value rejected naming its key',
  );
  assert.deepEqual(impl.validate({ cwd: '/w', env: { CODEX_API_KEY: 'sk' } }), [], 'string env values pass');
});

test('plugin: materializeConfig → null (codex needs no side files — every knob is a flag/-c/env)', () => {
  assert.equal(impl.materializeConfig({ id: 'b1', providerConfig: { cwd: '/w' } }), null);
  assert.equal(impl.materializeConfig(), null, 'also null with no bot at all');
});

test('plugin: describeError — 中文 copy for all six §5 runResult codes', () => {
  const e = (runResult) => impl.describeError(runResult);
  // the four explicit branches
  assert.match(e({ code: 'lock-conflict' }), /该会话正被另一个 codex 进程使用（线程锁定）/);
  assert.match(e({ code: 'lock-conflict' }), /请稍后重试/);
  assert.match(e({ code: 'missing-credential' }), /CODEX_API_KEY 未配置/);
  assert.match(e({ code: 'missing-credential' }), /providerConfig\.env \/ model 中配置后重试/);
  assert.equal(e({ code: 'timeout' }), '任务超时。');
  assert.equal(e({ code: 'aborted' }), '本轮运行已被中止。');
  // the default branch covers 'error' and 'completed'
  assert.equal(e({ code: 'error', error: 'stream disconnected before completion' }), 'stream disconnected before completion');
  assert.equal(e({ code: 'error', reason: { kind: 'failed' } }), 'codex 运行结束：failed');
  assert.equal(e({ code: 'completed', reason: { kind: 'completed' } }), '运行结束原因=completed');
  assert.equal(e({ code: 'completed' }), '未知错误', 'completed with no reason object falls to the generic tail');
  assert.equal(e(null), '未知错误');
});

test('plugin: createRunner (through the port) drives the fake CLI — plugin.js wires runner.js', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-cxp-'));
  try {
    // same wrapper injection as codex-runner.test.js / the contract suite
    const fakeHome = join(dir, 'fake-home');
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(join(dir, 'bin'), { recursive: true });
    const bin = join(dir, 'bin', 'codex.sh');
    writeFileSync(bin, '#!/bin/sh\n'
      + 'export FAKE_MODE="ok"\n'
      + `export FAKE_HOME="${fakeHome}"\n`
      + `exec "${FAKE_CODEX}" "$@"\n`);
    chmodSync(bin, 0o755);
    const runner = impl.createRunner({
      bot: { id: 'b1', provider: 'codex' },
      providerConfig: { cwd: dir, codexBin: bin },
      log: noopLog,
    });
    const events = [];
    const res = await runner.run({
      prompt: '请查看当前目录',
      sessionId: undefined,
      signal: new AbortController().signal,
      timeoutMs: 20_000,
      onEvent: (ev) => events.push(ev),
    });
    assert.equal(res.code, 'completed');
    assert.equal(res.finalText, '答案文本');
    assert.match(res.sessionId, /^[0-9a-f]{8}-/);
    assert.ok(events.some((ev) => ev.type === 'session' && ev.sessionId === res.sessionId));
    assert.equal(typeof runner.readHistory, 'function', 'the §5 readHistory rides on the runner');
    const hist = runner.readHistory({ cwd: dir, codexHome: join(dir, 'no-sessions') }, 'no-such-thread');
    assert.deepEqual(hist.turns, []);
    assert.ok(hist.warnings.length >= 1, 'history tolerance shape through the port runner');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
