// M3 Task 6 ops tests, two layers over src/index.js's orphan sweep:
//   unit: sweepOrphanChildren directly — no children = silent; a live direct
//         child is SIGKILLed with a warn; a missing pgrep degrades to a warn
//         (non-macOS path) without throwing.
//   e2e:  the REAL service binary (`node src/index.js start`) with a fake
//         provider whose runner is the REAL provider-dsh runner configured
//         with a 60s SIGKILL escalation over the SIGTERM-ignoring fake CLI
//         (hang-sigterm). One SIGINT → four-phase stop's bounded drains give
//         up while the CLI is still alive → the stop-tail sweep must SIGKILL
//         it before the process exits. Asserted the bash way: the known child
//         pid reports ESRCH and `pgrep -f <wrapper>` finds nothing after the
//         service is gone — no orphaned CLI survives the service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { sweepOrphanChildren } from '../../src/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FAKE_DSH = fileURLToPath(new URL('../fake-bin/fake-dsh.js', import.meta.url));
const DSH_RUNNER = fileURLToPath(new URL('../../plugins/provider-dsh/runner.js', import.meta.url));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code !== 'ESRCH'; }
};
const pidDeadWithin = (pid, ms) => waitFor(() => !pidAlive(pid), 'pid dead', ms);
const waitFor = async (predicate, label, timeoutMs = 30000, everyMs = 50) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(everyMs);
  }
};
const makeLog = () => {
  const lines = { warn: [], error: [] };
  return { lines, debug() {}, info() {}, warn: (m) => lines.warn.push(String(m)), error: (m) => lines.error.push(String(m)) };
};

// —— unit layer ————————————————————————————————————————————————————————————

test('sweep (unit): no live children → resolves silently, nothing logged', async () => {
  const log = makeLog();
  await sweepOrphanChildren({ log });
  assert.equal(log.lines.warn.length, 0);
  assert.equal(log.lines.error.length, 0);
});

test('sweep (unit): live direct child → SIGKILLed, warn narrated, dead after', async () => {
  const log = makeLog();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)']);
  child.on('exit', () => {}); // reap: a zombie is "alive" for kill(pid,0) purposes
  await waitFor(() => child.pid != null && pidAlive(child.pid), 'child alive', 5000);
  await sweepOrphanChildren({ log });
  assert.ok(log.lines.warn.some((w) => /orphan sweep — 1 live child/.test(w)), `sweep warn logged: ${JSON.stringify(log.lines.warn)}`);
  await pidDeadWithin(child.pid, 3000);
  assert.equal(log.lines.error.length, 0);
});

test('sweep (unit): pgrep unavailable (ENOENT) → warn + skip, never throws', async () => {
  const log = makeLog();
  const enoent = (cmd, args, opts, cb) => {
    const err = new Error(`spawn ${cmd} ENOENT`);
    err.code = 'ENOENT';
    cb(err);
  };
  await sweepOrphanChildren({ log, execFileFn: enoent });
  assert.ok(log.lines.warn.some((w) => /orphan sweep skipped \(pgrep unavailable: ENOENT\)/.test(w)));
  // exit-1 (no children matched) stays the silent norm even through a stub
  const log2 = makeLog();
  const noKids = (cmd, args, opts, cb) => {
    const err = new Error('pgrep exit 1');
    err.code = 1;
    cb(err, '');
  };
  await sweepOrphanChildren({ log: log2, execFileFn: noKids });
  assert.equal(log2.lines.warn.length, 0);
});

// —— e2e layer: real service process + hung CLI → SIGINT → no orphan ——————————

// The fake provider port: the REAL dsh runner, but with a 60s SIGKILL
// escalation — far past stop()'s two bounded 5s drains, so the hung CLI is
// still alive at the stop tail and ONLY the sweep can kill it before exit.
const orphanProviderSrc = `
import { createRunner as makeDshRunner } from ${JSON.stringify(DSH_RUNNER)};
export default {
  manifest: { id: 'provider-orphan', name: 'Orphan prov', type: 'provider', version: '0.1.0', requires: { kernel: '^1', ports: { provider: '^1' } } },
  activate(ctx) {
    ctx.registerProvider('orphanprov', {
      configSchema: [
        { key: 'cwd', label: 'Working directory', type: 'string', required: true },
        { key: 'dshBin', label: 'CLI binary', type: 'string' },
      ],
      createRunner: ({ bot, providerConfig, log }) => makeDshRunner({ bot, providerConfig, log, escalationMs: 60000 }),
    });
  },
};`;

// fake WeCom openws endpoint (contract-suite pattern), with push-to-client
function startFakeWecom() {
  return new Promise((resolve) => {
    const server = createServer();
    const wss = new WebSocketServer({ server });
    const st = { frames: [], sockets: [] };
    wss.on('connection', (ws) => {
      st.sockets.push(ws);
      ws.on('message', (buf) => {
        let msg;
        try { msg = JSON.parse(buf.toString()); } catch { return; }
        st.frames.push(msg);
        if (msg.cmd === 'aibot_subscribe') {
          ws.send(JSON.stringify({ headers: { req_id: msg.headers?.req_id }, errcode: 0, errmsg: 'ok' }));
        } else if (msg.cmd && msg.cmd !== 'ping') {
          ws.send(JSON.stringify({ headers: { req_id: msg.headers?.req_id }, errcode: 0 }));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      st.url = `ws://127.0.0.1:${server.address().port}`;
      st.sendToCurrent = (obj) => {
        const ws = st.sockets[st.sockets.length - 1];
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
      };
      st.close = async () => {
        for (const ws of st.sockets) { try { ws.terminate(); } catch {} }
        await new Promise((r) => wss.close(() => r()));
        await new Promise((r) => server.close(() => r()));
      };
      resolve(st);
    });
  });
}

const pickPort = () => new Promise((resolve, reject) => {
  const srv = createServer();
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
  srv.on('error', reject);
});

// `pgrep -f <pattern>` with no match exits 1 — the bash-side "no orphan" probe.
const pgrepF = (pattern) => new Promise((resolve) => {
  execFile('pgrep', ['-f', pattern], (err, stdout) => {
    resolve(err ? null : stdout.trim());
  });
});

test('e2e: SIGINT with a hung CLI run in flight → stop-tail sweep SIGKILLs it, no orphan left', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wao-orph-data-'));
  const fakesDir = mkdtempSync(join(tmpdir(), 'wao-orph-fakes-'));
  const server = await startFakeWecom();
  let service = null;
  let bootErr = '';
  try {
    // fake provider plugin + SIGTERM-ignoring fake CLI wrapper
    const provDir = join(fakesDir, 'provider-orphan');
    mkdirSync(provDir, { recursive: true });
    writeFileSync(join(provDir, 'plugin.js'), orphanProviderSrc);
    writeFileSync(join(provDir, 'package.json'), '{"type":"module"}\n');
    const fakeHome = join(fakesDir, 'fake-home');
    const bin = join(fakesDir, 'dsh-hang.sh');
    writeFileSync(bin, '#!/bin/sh\n'
      + 'export FAKE_MODE="hang-sigterm"\n'
      + `export FAKE_HOME="${fakeHome}"\n`
      + `exec "${FAKE_DSH}" "$@"\n`);
    chmodSync(bin, 0o755);

    const port = await pickPort();
    const base = `http://127.0.0.1:${port}`;
    service = spawn(process.execPath, [join(repoRoot, 'src', 'index.js'), 'start', '--port', String(port), '--data-dir', dataDir], {
      env: { ...process.env, WAO_PLUGINS_PATH: fakesDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    service.stderr.on('data', (c) => { bootErr += c.toString(); });
    try {
      await waitFor(async () => {
        try { const r = await fetch(`${base}/healthz`); return r.ok; } catch { return false; }
      }, 'service /healthz 200', 30000);
    } catch (err) {
      throw new Error(`${err.message}; service stderr: ${bootErr.slice(-2000)}`);
    }

    // bot on the fake channel + orphan provider → drive a run that hangs
    const bot = {
      id: 'orphan-b1', name: 'orphan 一号', enabled: true, channel: 'wecom',
      account: { botId: 'OB1', secret: 's-e2e', wsUrl: server.url },
      allowedUsers: [], provider: 'orphanprov',
      providerConfig: { cwd: fakesDir, dshBin: bin },
    };
    const created = await fetch(`${base}/api/bots`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bot),
    });
    assert.equal(created.status, 200, await created.text());
    await waitFor(async () => {
      const r = await fetch(`${base}/api/agents`);
      const j = await r.json();
      return j.agents?.some((a) => a.id === 'orphan-b1' && a.channelState?.state === 'online');
    }, 'bot online', 20000);

    // message in → run spawns the hung CLI; the ack frame proves it is live
    server.frames.length = 0;
    server.sendToCurrent({
      cmd: 'aibot_msg_callback',
      headers: { req_id: 'orph-r1' },
      body: { chattype: 'group', chatid: 'OG', from: { userid: 'u1' }, msgtype: 'text', text: { content: '挂住的任务' } },
    });
    await waitFor(() => server.frames.some((f) => f.cmd === 'aibot_respond_msg' && (f.body?.stream?.content ?? '').startsWith('✅ 收到')), 'run acked (in flight)', 20000);
    const cliPid = await waitFor(() => {
      try { return Number(readFileSync(join(fakeHome, 'last-pid'), 'utf8').trim()) || null; } catch { return null; }
    }, 'hung CLI spawned (last-pid)', 10000);
    // Wait until the engine has seen the fake's PARTIAL TEXT event: the fake
    // installs its SIGTERM ignorer immediately after emitting that text, so a
    // SIGINT any earlier would take the default-kill path and prove nothing.
    // (progress.line, not progress: _registerRun pre-fills {line:null}.)
    await waitFor(async () => {
      const r = await fetch(`${base}/api/agents`);
      const j = await r.json();
      return j.agents?.find((a) => a.id === 'orphan-b1')?.progress?.line != null;
    }, 'engine saw the text event (SIGTERM ignorer installed)', 15000);
    assert.ok(pidAlive(cliPid), `hung CLI (pid ${cliPid}) alive before SIGINT`);

    // ONE SIGINT → four-phase stop (drains give up, child survives them) →
    // the stop-tail sweep must kill it before the process exits.
    service.kill('SIGINT');
    const exited = await waitFor(() => service.exitCode != null || service.signalCode != null, 'service exited', 60000);
    assert.ok(exited, 'service exited after SIGINT');
    assert.equal(service.exitCode, 0, `graceful exit 0 (signal=${service.signalCode})`);

    // bash-side assertions: known child dead + pgrep finds no straggler
    assert.ok(await pidDeadWithin(cliPid, 5000), `orphan CLI (pid ${cliPid}) dead after service exit`);
    assert.equal(await pgrepF(bin), null, `pgrep -f ${bin} finds nothing after service exit`);

    // and the sweep (not something else) did it: the service log narrates it
    const waoLog = readFileSync(join(dataDir, 'logs', 'wao.log'), 'utf8');
    assert.match(waoLog, /orphan sweep — 1 live child process\(es\) after teardown \(\d+\), SIGKILL/);
    assert.match(waoLog, /wao: stopped \(lock released\)/);
  } finally {
    if (service != null && service.exitCode == null && service.signalCode == null) service.kill('SIGKILL');
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(fakesDir, { recursive: true, force: true });
  }
}, { timeout: 180000 });
