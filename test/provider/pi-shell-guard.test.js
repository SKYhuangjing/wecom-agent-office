// provider-pi shell timeout guard tests (2026-11-11 live incident — see
// plugins/provider-pi/models.js header). Three layers:
//   1. models.js unit: guard seconds defensive parse + deterministic bytes +
//      the materialized source is loadable ESM with a function default;
//   2. runner wiring: every leg's argv carries `-e <agentDir>/extensions/
//      wao-shell-guard.js` and the child env carries WAO_BASH_TIMEOUT_SEC
//      (default 90, providerConfig.bashTimeoutSec override);
//   3. idempotence: a second write yields byte-identical content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  writeShellGuard, shellGuardSeconds, shellGuardPathFor, SHELL_GUARD_DEFAULT_SEC,
} from '../../plugins/provider-pi/models.js';
import { createRunner } from '../../plugins/provider-pi/runner.js';

const FAKE_PI = fileURLToPath(new URL('../fake-bin/fake-pi.js', import.meta.url));
const noopLog = { debug() {}, info() {}, warn() {}, error() {} };

// --- 1: models unit ——————————————————————————————————————————————————————

test('shellGuardSeconds: override wins (number OR numeric string), garbage/default fall back to 90', () => {
  assert.equal(shellGuardSeconds({ bashTimeoutSec: '30' }), 30, 'schema string type coerces');
  assert.equal(shellGuardSeconds({ bashTimeoutSec: 30 }), 30);
  assert.equal(shellGuardSeconds({ bashTimeoutSec: 30.9 }), 30, 'floored');
  assert.equal(shellGuardSeconds({}), SHELL_GUARD_DEFAULT_SEC);
  assert.equal(shellGuardSeconds(null), SHELL_GUARD_DEFAULT_SEC);
  assert.equal(shellGuardSeconds({ bashTimeoutSec: 0 }), SHELL_GUARD_DEFAULT_SEC, 'non-positive is not a cap');
  assert.equal(shellGuardSeconds({ bashTimeoutSec: 'x' }), SHELL_GUARD_DEFAULT_SEC);
});

test('writeShellGuard: deterministic bytes, correct path formula, loadable ESM default', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-pi-guard-'));
  try {
    const agentDir = join(dir, 'pi-agent');
    const p1 = writeShellGuard(agentDir);
    assert.equal(p1, join(agentDir, 'extensions', 'wao-shell-guard.js'));
    const bytes1 = readFileSync(p1, 'utf8');
    writeShellGuard(agentDir);
    assert.equal(readFileSync(p1, 'utf8'), bytes1, 'second write is byte-identical');
    assert.ok(bytes1.includes('tool_call'), 'guard hooks the tool_call event');
    assert.ok(bytes1.includes('WAO_BASH_TIMEOUT_SEC'), 'guard reads the env ceiling');
    assert.ok(bytes1.includes('"bash"') && bytes1.includes('"powershell"'), 'both shell tools covered');
    assert.equal(
      shellGuardPathFor({ botId: 'b9' }),
      join(homedir(), '.pi', 'agent-wao-b9', 'extensions', 'wao-shell-guard.js'),
      'default path formula mirrors piAgentDirFor',
    );
    const mod = await import(`file://${p1}`);
    assert.equal(typeof mod.default, 'function', 'materialized source parses as ESM with a default fn');
    // smoke: the handler mutates a missing timeout in place and clamps oversized
    let patched = null;
    const pi = { on: (_ev, fn) => { patched = fn; } };
    mod.default(pi);
    const event = { toolName: 'bash', input: { command: 'find /' } };
    await patched(event);
    assert.equal(event.input.timeout, 90, 'missing timeout filled with the default ceiling');
    const clamped = { toolName: 'powershell', input: { command: 'x', timeout: 9999 } };
    await patched(clamped);
    assert.equal(clamped.input.timeout, 90, 'oversized timeout clamped');
    const untouched = { toolName: 'read', input: { path: 'x' } };
    await patched(untouched);
    assert.equal(untouched.input.timeout, undefined, 'non-shell tools untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 2: runner wiring —————————————————————————————————————————————————————

const mkWrapper = (dir) => {
  const fakeHome = join(dir, 'fake-home');
  mkdirSync(join(dir, 'bin'), { recursive: true });
  const bin = join(dir, 'bin', 'pi-guard.sh');
  writeFileSync(bin, '#!/bin/sh\n'
    + `export FAKE_MODE="ok"\n`
    + `export FAKE_HOME="${fakeHome}"\n`
    + `mkdir -p "$FAKE_HOME" && printf '%s\\n' "$WAO_BASH_TIMEOUT_SEC" > "$FAKE_HOME/last-guard-sec"\n`
    + `exec "${FAKE_PI}" "$@"\n`);
  chmodSync(bin, 0o755);
  return { bin, fakeHome };
};

const guardRun = async (pc) => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-pi-guardrun-'));
  try {
    const { bin, fakeHome } = mkWrapper(dir);
    const runner = createRunner({
      bot: { id: 'b1', provider: 'pi' },
      providerConfig: { cwd: dir, piBin: bin, piAgentDir: join(dir, 'pi-agent'), ...pc },
      log: noopLog,
    });
    const res = await runner.run({ prompt: 'x', signal: new AbortController().signal, timeoutMs: 20_000 });
    return {
      ok: res.ok,
      argv: readFileSync(join(fakeHome, 'last-argv'), 'utf8'),
      sec: readFileSync(join(fakeHome, 'last-guard-sec'), 'utf8').trim(),
      agentDir: join(dir, 'pi-agent'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('runner: -e guard flag + WAO_BASH_TIMEOUT_SEC default 90 on the argv/env', async () => {
  const r = await guardRun({});
  assert.equal(r.ok, true);
  assert.ok(r.argv.includes(`-e ${join(r.agentDir, 'extensions', 'wao-shell-guard.js')}`), `argv carries the guard -e: ${r.argv}`);
  assert.equal(r.sec, '90');
});

test('runner: bashTimeoutSec override reaches the child env', async () => {
  const r = await guardRun({ bashTimeoutSec: 45 });
  assert.equal(r.sec, '45');
});
