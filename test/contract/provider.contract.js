// Provider port contract suite (Task 16) — verifies a provider plugin against
// DESIGN §5's port contract: createRunner({bot, providerConfig, log}) →
// { run({prompt, sessionId, signal, timeoutMs, onEvent}), readHistory() }.
// The target plugin is loaded through the REAL kernel machinery (importPlugin
// + validateManifest + lifecycle.activate, same pattern as
// test/kernel/loader.test.js) so the port registry and deactivation path are
// exercised, not simulated. Groups:
//
//  1 ok             completed result shape (+ tool event + stdin piping when
//                   the profile exposes the fake CLI and an event stream)
//  2 thinking       thinking unified event carries a text payload
//  3 resume         sessionId round-trips; fake received --session-id <id>
//  4 abort-partial  abort → aborted=true, partial finalText, child dead
//  5 kill-escalation SIGTERM ignored → SIGKILL escalation, resolve ≤5s, dead
//  6 timeout        timeoutMs → code='timeout', child dead
//  7 lock           fake lock stderr/exit → code='lock-conflict'
//  8 credential     fake credential error → code='missing-credential'
//  9 history        readHistory tolerance: missing / corrupt / huge(+hook)
// 10 event-timing   no onEvent callbacks after run() resolves
// 11 disable-clean  deactivate drops the port; no leaked handles/children
//
// Groups 4-8 and parts of 1/3/9 need the fake-dsh CLI injected through the
// provider (profile.fakeCli); the template's demo runner declares those out
// of scope via test/contract/profiles.js so `npm run contract` stays green
// today while provider-dsh (Task 18) runs everything.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEventBus } from '../../src/kernel/events.js';
import { createServices } from '../../src/kernel/services.js';
import { createHttpShell } from '../../src/kernel/http.js';
import { createLifecycle } from '../../src/kernel/lifecycle.js';
import { importPlugin, validateManifest } from '../../src/kernel/loader.js';
import { PROFILES, defaultProfile } from './profiles.js';

export const FAKE_DSH = fileURLToPath(new URL('../fake-bin/fake-dsh.js', import.meta.url));
export const FAKE_CLAUDE = fileURLToPath(new URL('../fake-bin/fake-claude.js', import.meta.url));

const PROMPT = '请查看当前目录'; // fake-dsh stores this in last-prompt; ok mode finals with 答案文本
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fakeLog = () => {
  const lines = { debug: [], info: [], warn: [], error: [] };
  const log = {
    debug: (...a) => lines.debug.push(a.map(String).join(' ')),
    info: (...a) => lines.info.push(a.map(String).join(' ')),
    warn: (...a) => lines.warn.push(a.map(String).join(' ')),
    error: (...a) => lines.error.push(a.map(String).join(' ')),
    child: () => log,
  };
  return { lines, log };
};

// Poll `fn` until truthy or the deadline; returns the final fn() value.
const until = async (fn, timeoutMs, everyMs = 25) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() >= deadline) return v;
    await sleep(everyMs);
  }
};

// A pid is dead only when kill(pid, 0) reports ESRCH — a live child (or an
// unreaped zombie, which is equally a §5 violation) reports alive.
const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code !== 'ESRCH'; }
};
const pidDeadWithin = (pid, ms) => until(() => !pidAlive(pid), ms);

const readPid = (fakeHome) => {
  try { return Number(readFileSync(join(fakeHome, 'last-pid'), 'utf8').trim()); } catch { return null; }
};
// Best-effort cleanup after a failing group: never let a leaked fake outlive
// the suite and wedge `npm run contract`.
const killLeftover = (fakeHome) => {
  const pid = readPid(fakeHome);
  if (Number.isInteger(pid) && pidAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* racing exit */ } }
};

// Race a run() promise against a watchdog — a provider that never resolves
// (the exact bug the §5 "run() 恒 resolve" clause forbids) must fail the
// group, not hang the suite.
const WATCHDOG = Symbol('watchdog');
const withWatchdog = async (p, ms) => {
  p.catch(() => {}); // if it settles after the watchdog won: observed, not unhandled
  let timer;
  const guard = new Promise((resolve) => { timer = setTimeout(() => resolve(WATCHDOG), ms); });
  try { return await Promise.race([p, guard]); } finally { clearTimeout(timer); }
};

const RESOURCE_KINDS = ['Timer', 'Timeout', 'ChildProcess', 'Immediate', 'TCPSocketWrap'];
const resourceSnapshot = () => {
  const counts = Object.fromEntries(RESOURCE_KINDS.map((k) => [k, 0]));
  for (const kind of process.getActiveResourcesInfo()) if (kind in counts) counts[kind] += 1;
  return counts;
};

// --- the suite ---------------------------------------------------------------

export async function runContractSuite({ pluginDir, providerId = null }) {
  const results = []; // { id, name, status: 'pass'|'fail'|'skip', detail }
  const root = mkdtempSync(join(tmpdir(), 'wao-contract-'));
  const { lines: logLines, log } = fakeLog();
  let seq = 0;
  mkdirSync(join(root, 'bin'), { recursive: true });
  // Mode injection without env-passthrough support in the provider: a tiny
  // /bin/sh wrapper exports FAKE_MODE/FAKE_HOME, then exec's the port's fake
  // CLI (exec keeps the pid, so last-pid is the pid the provider spawned).
  // The wrapper writes $$ itself first (ms after spawn): the timeout group's
  // deadline starts at run(), and under load the wrapper+node boot can outrun
  // it — SIGTERM would land before the fake's top-level write and last-pid
  // would never land (ENOENT flake). $$ IS the exec'd fake's pid.
  // The filename carries a bare sequence number only — embedding FAKE_MODE
  // would let a provider smell the test mode from argv[0]/$0.
  const wrapBin = (mode, fakeHome, fakeBin = FAKE_DSH) => {
    const script = join(root, 'bin', `fake-${++seq}.sh`);
    writeFileSync(script, '#!/bin/sh\n'
      + `export FAKE_MODE="${mode}"\n`
      + `export FAKE_HOME="${fakeHome}"\n`
      + `mkdir -p "$FAKE_HOME" && printf '%s\\n' "$$" > "$FAKE_HOME/last-pid"\n`
      + `exec "${fakeBin}" "$@"\n`);
    chmodSync(script, 0o755);
    return script;
  };

  const summarize = () => ({
    pass: results.filter((r) => r.status === 'pass').length,
    fail: results.filter((r) => r.status === 'fail').length,
    skip: results.filter((r) => r.status === 'skip').length,
    results,
  });
  const loadFail = (detail) => {
    results.push({ id: 'load', name: 'plugin load', status: 'fail', detail });
    return { ...summarize(), portId: null, profileNote: null, logLines };
  };

  try {
    // --- load the target plugin through the real kernel machinery ----------
    let rec;
    try {
      rec = await importPlugin(pluginDir);
    } catch (err) {
      return loadFail(`import failed: ${err?.message ?? err}`);
    }
    const manifestErrors = validateManifest(rec.manifest);
    if (manifestErrors.length > 0) return loadFail(`manifest invalid: ${manifestErrors.join('; ')}`);
    if (typeof rec.mod.default?.activate !== 'function') return loadFail('activate is not a function');

    const lifecycle = createLifecycle({
      events: createEventBus({ log }),
      services: createServices(),
      log,
      http: createHttpShell({ log }),
    });
    const plugin = { dir: pluginDir, manifest: rec.manifest, mod: rec.mod.default, status: 'enabled', config: {} };
    await lifecycle.activate(plugin);
    const registry = lifecycle.portRegistry.provider;
    if (registry.size === 0) return loadFail('activate() registered no provider port (ctx.registerProvider never called)');
    const portId = providerId ?? [...registry.keys()][0];
    if (!registry.has(portId)) {
      return loadFail(`provider port '${portId}' not registered (has: ${[...registry.keys()].join(', ')})`);
    }
    const impl = registry.get(portId)?.impl; // map holds {impl, owner} entries
    if (typeof impl?.createRunner !== 'function') return loadFail(`port '${portId}' impl has no createRunner`);
    const profile = PROFILES[portId] ?? defaultProfile(portId);

    // --- shared helpers over the loaded impl -------------------------------
    const makeRunner = (providerConfig) => impl.createRunner({
      bot: { id: 'contract-t', provider: portId, providerConfig },
      providerConfig,
      log,
    });
    const runOnce = (runner, { prompt = PROMPT, sessionId = null, signal, timeoutMs = 20_000, onEvent } = {}) =>
      runner.run({ prompt, sessionId, signal: signal ?? new AbortController().signal, timeoutMs, onEvent });

    const resourcesBefore = resourceSnapshot();

    // Group machinery: checks accumulate; a skip is decided up-front with a
    // reason; every fake home spawned inside a group is kill-checked after it
    // so one failing group can never leak a hung child into the next.
    let groupHomes = [];
    const genv = (name) => {
      const dir = mkdtempSync(join(root, `g-${name}-`));
      const fakeHome = join(dir, 'fake-home');
      mkdirSync(fakeHome, { recursive: true });
      groupHomes.push(fakeHome);
      return { dir, fakeHome };
    };
    // The fake CLI is a profile choice (fake-claude for the claude port,
    // fake-dsh otherwise); bound into wrapBin so profiles keep calling
    // wrapBin(mode, fakeHome) without knowing the binary.
    const fakeBin = profile.fakeBin ?? FAKE_DSH;
    const argsFor = (e, mode) => profile.makeRunnerArgs({
      cwd: e.dir, mode, fakeHome: e.fakeHome,
      wrapBin: (m, h) => wrapBin(m, h, fakeBin),
      fakeDsh: fakeBin,
    });

    const group = async (id, name, fn, skipReason = null) => {
      const row = { id, name, status: 'pass', detail: '' };
      results.push(row);
      const fails = [];
      const notes = [];
      const g = {
        check(cond, msg) { if (!cond) fails.push(msg); },
        note(msg) { notes.push(msg); },
      };
      if (skipReason !== null) {
        row.status = 'skip';
        row.detail = skipReason;
      } else {
        groupHomes = [];
        try {
          await fn(g);
        } catch (err) {
          // First line of the message only: a full stack in the FAIL summary
          // line buries the pass/fail table under frames.
          fails.push(`threw: ${String(err?.message ?? err).split('\n', 1)[0]}`);
        } finally {
          for (const home of groupHomes) killLeftover(home);
        }
        if (fails.length > 0) { row.status = 'fail'; row.detail = fails.join(' | '); }
        else if (notes.length > 0) row.detail = notes.join('; ');
      }
    };

    // --- 1 ok: completed result shape ---------------------------------------
    await group('ok', 'ok: completed result shape', async (g) => {
      const e = genv('ok');
      const runner = makeRunner(argsFor(e, 'ok'));
      const events = [];
      const res = await withWatchdog(runOnce(runner, { onEvent: (ev) => events.push(ev) }), 25_000);
      g.check(res !== WATCHDOG, 'run() resolved (watchdog: never settled)');
      if (res === WATCHDOG) return;
      g.check(res?.ok === true, `ok=true (got ${res?.ok})`);
      g.check(res?.code === 'completed', `code='completed' (got ${JSON.stringify(res?.code)})`);
      g.check(typeof res?.sessionId === 'string' && res.sessionId !== '', `sessionId truthy (got ${JSON.stringify(res?.sessionId)})`);
      const want = profile.expect?.okFinalText?.(PROMPT) ?? '答案文本';
      g.check(res?.finalText === want, `finalText=${JSON.stringify(want)} (got ${JSON.stringify(res?.finalText)})`);
      g.check(res?.aborted === false, `aborted=false (got ${res?.aborted})`);
      g.check(res?.reason !== undefined, 'reason field present (may be null)');
      g.check(res?.detail == null || typeof res?.detail === 'object', 'detail field shape (object or absent)');
      g.check(res?.detail?.exitCode === 0, `detail.exitCode=0 (got ${JSON.stringify(res?.detail?.exitCode)})`);
      g.check(typeof res?.detail?.stderrTail === 'string', `detail.stderrTail is a string (got ${typeof res?.detail?.stderrTail})`);
      if (profile.fakeCli && profile.events) {
        const tool = events.find((ev) => ev?.type === 'tool');
        g.check(tool !== undefined, `onEvent carried a tool event (types seen: ${events.map((ev) => ev?.type).join(',') || 'none'})`);
        g.check(tool?.name === 'Bash', `tool.name='Bash' (got ${JSON.stringify(tool?.name)})`);
        g.check(typeof tool?.brief === 'string' && tool.brief.includes('ls'), `tool.brief contains 'ls' (got ${JSON.stringify(tool?.brief)})`);
        const stored = readFileSync(join(e.fakeHome, 'last-prompt'), 'utf8');
        g.check(stored === PROMPT, `prompt piped verbatim to the CLI stdin (last-prompt=${JSON.stringify(stored)})`);
      } else {
        g.note('tool-event/stdin probes skipped (profile declares no fake-CLI event stream)');
      }
    });

    // --- 2 thinking -----------------------------------------------------------
    await group('thinking', 'thinking: unified thinking event carries text', async (g) => {
      const e = genv('think');
      const runner = makeRunner(argsFor(e, 'thinking'));
      const events = [];
      const res = await withWatchdog(runOnce(runner, { onEvent: (ev) => events.push(ev) }), 25_000);
      g.check(res !== WATCHDOG, 'run() resolved (watchdog: never settled)');
      if (res === WATCHDOG) return;
      const think = events.find((ev) => ev?.type === 'thinking');
      g.check(think !== undefined, `thinking event present (types seen: ${events.map((ev) => ev?.type).join(',') || 'none'})`);
      g.check(typeof think?.text === 'string' && think.text !== '', `thinking.text non-empty (got ${JSON.stringify(think?.text)})`);
    }, (!profile.fakeCli || !profile.events) ? 'profile declares no fake-CLI event stream' : null);

    // --- 3 resume -------------------------------------------------------------
    await group('resume', 'resume: sessionId round-trips to the CLI', async (g) => {
      const e = genv('resume');
      // Two runners: the fake's FAKE_MODE is baked into the injected bin, so
      // turn 1 runs 'ok' (mints) and turn 2 runs 'resume-echo' (echoes
      // --session-id) — exactly the two real-dsh invocation shapes.
      const first = await withWatchdog(runOnce(makeRunner(argsFor(e, 'ok'))), 25_000);
      g.check(first !== WATCHDOG, 'first run resolved (watchdog: never settled)');
      if (first === WATCHDOG) return;
      const sid = first?.sessionId;
      g.check(typeof sid === 'string' && sid !== '', `first run minted a sessionId (got ${JSON.stringify(sid)})`);
      if (typeof sid !== 'string' || sid === '') return;
      const second = await withWatchdog(runOnce(makeRunner(argsFor(e, 'resume-echo')), { sessionId: sid }), 25_000);
      g.check(second !== WATCHDOG, 'second run resolved (watchdog: never settled)');
      if (second === WATCHDOG) return;
      g.check(second?.sessionId === sid, `resume returns the SAME sessionId (got ${JSON.stringify(second?.sessionId)}, want ${JSON.stringify(sid)})`);
      if (profile.fakeCli) {
        const argv = readFileSync(join(e.fakeHome, 'last-argv'), 'utf8');
        // The resume flag is provider CLI-specific (dsh --session-id, claude
        // --resume); the profile declares it, dsh's spelling stays the default.
        const resumeArg = profile.expect?.resumeArg ?? '--session-id';
        g.check(argv.includes(`${resumeArg} ${sid}`), `CLI received ${resumeArg} (last-argv=${JSON.stringify(argv.trim())})`);
      } else {
        g.note('--session-id argv probe skipped (no fake CLI)');
      }
    });

    // --- 4 abort + partial output ---------------------------------------------
    const noFakeCli = !profile.fakeCli ? 'profile declares no spawnable fake CLI' : null;
    await group('abort-partial', 'abort: partial finalText, child dead', async (g) => {
      const e = genv('abort');
      const runner = makeRunner(argsFor(e, 'partial-abort'));
      const events = [];
      const ac = new AbortController();
      const p = runOnce(runner, { signal: ac.signal, onEvent: (ev) => events.push(ev) });
      // Abort once the partial text is observably out (the fake installs its
      // SIGTERM handler right after emitting it) — a bare 120ms sleep would
      // race node startup and could SIGTERM before the handler exists.
      if (profile.events) {
        const sawText = await until(() => events.some((ev) => ev?.type === 'text'), 3000);
        g.check(sawText, 'partial text event observed before abort');
      } else {
        await sleep(150);
      }
      ac.abort();
      const res = await withWatchdog(p, 10_000);
      g.check(res !== WATCHDOG, 'run() resolved after abort (watchdog: never settled)');
      if (res === WATCHDOG) return;
      g.check(res?.aborted === true, `aborted=true (got ${res?.aborted})`);
      g.check(res?.code === 'aborted', `code='aborted' (got ${JSON.stringify(res?.code)})`);
      g.check(res?.finalText === '部分输出', `abort carries partial output (finalText=${JSON.stringify(res?.finalText)})`);
      const pid = readPid(e.fakeHome);
      g.check(Number.isInteger(pid), 'fake wrote last-pid (did the provider spawn it?)');
      if (Number.isInteger(pid)) g.check(await pidDeadWithin(pid, 3000), `child dead (ESRCH) within 3s of resolve (pid ${pid})`);
    }, noFakeCli);

    // --- 5 SIGKILL escalation --------------------------------------------------
    await group('kill-escalation', 'escalation: SIGTERM-ignoring child killed ≤5s', async (g) => {
      const e = genv('esc');
      const runner = makeRunner(argsFor(e, 'hang-sigterm'));
      const events = [];
      const ac = new AbortController();
      const p = runOnce(runner, { signal: ac.signal, onEvent: (ev) => events.push(ev) });
      if (profile.events) {
        const sawText = await until(() => events.some((ev) => ev?.type === 'text'), 3000);
        g.check(sawText, 'text event observed before abort (fake installs its SIGTERM-ignorer after it)');
      } else {
        await sleep(300); // the SIGTERM-ignorer is installed right after the text line
      }
      ac.abort();
      const t0 = Date.now();
      const res = await withWatchdog(p, 15_000);
      const escalateMs = Date.now() - t0;
      g.check(res !== WATCHDOG, 'run() resolved (watchdog: child never died / runner never settled)');
      if (res === WATCHDOG) return;
      g.check(escalateMs <= 5000, `SIGTERM→SIGKILL escalation resolved within 5s (took ${escalateMs}ms)`);
      g.check(res?.code === 'aborted', `code='aborted' (got ${JSON.stringify(res?.code)})`);
      g.check(res?.aborted === true, `aborted=true (got ${res?.aborted})`);
      const pid = readPid(e.fakeHome);
      g.check(Number.isInteger(pid), 'fake wrote last-pid (did the provider spawn the fake CLI?)');
      if (Number.isInteger(pid)) g.check(await pidDeadWithin(pid, 3000), `child dead (ESRCH) within 3s of resolve (pid ${pid})`);
    }, noFakeCli);

    // --- 6 timeout --------------------------------------------------------------
    await group('timeout', 'timeout: timeoutMs kills with code=timeout', async (g) => {
      const e = genv('tmo');
      const runner = makeRunner(argsFor(e, 'hang-timeout'));
      // The runner's deadline starts at run() — before the child has booted.
      // Measured spawn→last-pid latency for the wrapper+node fake runs
      // 400-900ms on this class of machine, so a sub-second timeoutMs would
      // SIGTERM the wrapper before the fake ever starts and the mandatory
      // last-pid check below would flake. 2s keeps the kill semantics under
      // test while giving the fixture firm boot headroom.
      const res = await withWatchdog(runOnce(runner, { timeoutMs: 2000 }), 15_000);
      g.check(res !== WATCHDOG, 'run() resolved on timeout (watchdog: never settled)');
      if (res === WATCHDOG) return;
      g.check(res?.code === 'timeout', `code='timeout' (got ${JSON.stringify(res?.code)})`);
      g.check(res?.ok === false, `ok=false (got ${res?.ok})`);
      const pid = readPid(e.fakeHome);
      g.check(Number.isInteger(pid), 'fake wrote last-pid (did the provider spawn the fake CLI?)');
      if (Number.isInteger(pid)) g.check(await pidDeadWithin(pid, 3000), `child dead (ESRCH) within 3s of resolve (pid ${pid})`);
    }, noFakeCli);

    // --- 7 lock ------------------------------------------------------------------
    await group('lock', 'lock: fake lock stderr/exit → code=lock-conflict', async (g) => {
      const e = genv('lock');
      const runner = makeRunner(argsFor(e, 'lock'));
      const res = await withWatchdog(runOnce(runner), 25_000);
      g.check(res !== WATCHDOG, 'run() resolved (watchdog: never settled)');
      if (res === WATCHDOG) return;
      g.check(res?.code === 'lock-conflict', `code='lock-conflict' (got ${JSON.stringify(res?.code)})`);
      g.check(res?.ok === false, `ok=false (got ${res?.ok})`);
    }, noFakeCli);

    // --- 8 credential --------------------------------------------------------------
    await group('credential', 'credential: → code=missing-credential', async (g) => {
      const e = genv('cred');
      const runner = makeRunner(argsFor(e, 'credential'));
      const res = await withWatchdog(runOnce(runner), 25_000);
      g.check(res !== WATCHDOG, 'run() resolved (watchdog: never settled)');
      if (res === WATCHDOG) return;
      g.check(res?.code === 'missing-credential', `code='missing-credential' (got ${JSON.stringify(res?.code)})`);
      g.check(res?.ok === false, `ok=false (got ${res?.ok})`);
    }, noFakeCli);

    // --- 9 readHistory tolerance -----------------------------------------------------
    // §5 puts readHistory on the RUNNER object (createRunner().readHistory),
    // not on the registered impl — history is read through the same
    // providerConfig wiring a turn used. Skipping this group is a SUITE-side
    // declaration ONLY (profile.history === 'deferred' in profiles.js): a
    // plugin opting out via capabilities.history, a missing runner method, or
    // a "not implemented" throw are all contract FAILURES, not skips.
    const historySkip = (profile.history === 'deferred')
      ? 'profile declares history deferred (real reader pending — test/contract/profiles.js)'
      : null;
    await group('history', 'readHistory: missing/corrupt/huge are tolerant', async (g) => {
      const read = async (runner, pc, sid) => {
        try { return { value: await runner.readHistory(pc, sid) }; } catch (err) { return { err }; }
      };
      const historyRunnerOf = (e) => makeRunner(argsFor(e, 'ok'));

      // missing file — doubles as the probe for a runner without §5's method
      const eMiss = genv('hist-miss');
      const missRunner = historyRunnerOf(eMiss);
      g.check(typeof missRunner.readHistory === 'function',
        'runner.readHistory is a function (§5: createRunner().readHistory — declare profile history:"deferred" in test/contract/profiles.js if genuinely pending)');
      if (typeof missRunner.readHistory !== 'function') return; // later cases would only repeat this failure
      const miss = await read(missRunner, argsFor(eMiss, 'ok'), 'no-such-session');
      g.check(!miss.err, `missing file must not throw (threw ${miss.err?.message})`);
      g.check(Array.isArray(miss.value?.turns) && miss.value.turns.length === 0,
        `missing → turns=[] (got ${JSON.stringify(miss.value?.turns)})`);
      g.check(Array.isArray(miss.value?.warnings) && miss.value.warnings.length >= 1,
        `missing → ≥1 warning (got ${JSON.stringify(miss.value?.warnings)})`);

      // corrupt file — garbage bytes are garbage in ANY provider format
      const eCor = genv('hist-corrupt');
      const corruptPath = profile.historyPath(eCor.dir, 'corrupt-session');
      mkdirSync(dirname(corruptPath), { recursive: true });
      writeFileSync(corruptPath, Buffer.concat([
        Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0x00, 0x01]),
        Buffer.from('definitely not a session file'),
      ]));
      const cor = await read(historyRunnerOf(eCor), argsFor(eCor, 'ok'), 'corrupt-session');
      g.check(!cor.err, `corrupt file must not throw (threw ${cor.err?.message})`);
      g.check(Array.isArray(cor.value?.warnings) && cor.value.warnings.length >= 1,
        `corrupt → ≥1 warning (got ${JSON.stringify(cor.value?.warnings)})`);
      // defaultProfile GUESSES the dsh sessions/<id>.zst layout; a provider
      // with a different layout never reads the fixture above and answers
      // with missing-file semantics — identical warnings expose exactly that,
      // so fail loudly instead of letting the corrupt case pass by accident.
      if (profile.assumedHistoryPath) {
        g.check(JSON.stringify(cor.value?.warnings) !== JSON.stringify(miss.value?.warnings),
          'corrupt-file warnings differ from missing-file warnings (identical warnings mean our corrupt fixture was never read — the default profile assumes the dsh sessions/<id>.zst layout; declare a profile with the real historyPath)');
      }

      // huge file — needs the provider's REAL on-disk format, so the writer
      // is a profile hook (see profiles.js); absent hook → SKIP this case only
      if (typeof profile.hugeHistory === 'function') {
        const eHuge = genv('hist-huge');
        const hugePath = profile.historyPath(eHuge.dir, 'huge-session');
        mkdirSync(dirname(hugePath), { recursive: true });
        await profile.hugeHistory(hugePath);
        const huge = await read(historyRunnerOf(eHuge), argsFor(eHuge, 'ok'), 'huge-session');
        g.check(!huge.err, `huge file must not throw (threw ${huge.err?.message})`);
        g.check(huge.value?.truncated === true, `huge → truncated=true (got ${JSON.stringify(huge.value?.truncated)})`);
      } else {
        g.note('huge-file case skipped: profile provides no hugeHistory fixture writer (provider-format-specific)');
      }
    }, historySkip);

    // --- 10 onEvent timing -------------------------------------------------------------
    await group('event-timing', 'onEvent: nothing after run() resolves', async (g) => {
      const e = genv('timing');
      const runner = makeRunner(argsFor(e, 'ok'));
      const events = [];
      const res = await withWatchdog(runOnce(runner, { onEvent: (ev) => events.push(ev) }), 25_000);
      g.check(res !== WATCHDOG, 'run() resolved (watchdog: never settled)');
      if (res === WATCHDOG) return;
      const seen = events.length;
      await sleep(150);
      g.check(events.length === seen, `no events after resolve (had ${seen}, then ${events.length})`);
      if (!profile.events) g.note('vacuous for event-less providers (0 events ever) — still a contract hold');
    });

    // --- 11 disable completeness + resource accounting ---------------------------------
    await group('disable-clean', 'disable: port revoked, no leaked handles', async (g) => {
      await lifecycle.deactivate(plugin);
      g.check(lifecycle.portRegistry.provider.get(portId) === undefined, 'portRegistry no longer carries the provider after deactivate');
      g.check(!lifecycle.debugState().active.includes(rec.manifest.id), 'plugin left the active set');
      await sleep(500); // settle: late child-exit/stdout flushes land here or never
      const after = resourceSnapshot();
      const delta = Object.fromEntries(RESOURCE_KINDS.map((k) => [k, after[k] - resourcesBefore[k]]));
      g.check(delta.ChildProcess === 0, `no ChildProcess handle remains (delta ${delta.ChildProcess})`);
      // Non-child handles must return to the pre-suite baseline EXACTLY. If
      // suite-side noise is ever proven here, exclude that handle by NAME
      // below with the evidence — never widen the tolerance back.
      const SUITE_NOISE_HANDLES = []; // named, evidenced suite-side leaks (none today)
      const noiseKinds = RESOURCE_KINDS.filter((k) => k !== 'ChildProcess' && !SUITE_NOISE_HANDLES.includes(k));
      const handleNoise = noiseKinds.reduce((sum, k) => sum + delta[k], 0);
      g.check(handleNoise === 0, `no timer/immediate/socket handle remains (deltas ${JSON.stringify(delta)})`);
    });

    return { ...summarize(), portId, profileNote: profile.note, logLines };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
