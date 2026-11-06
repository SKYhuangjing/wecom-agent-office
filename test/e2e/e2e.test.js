// Task 19 e2e: the FULL chain over a real kernel boot — real core-engine +
// real channel-wecom + two fake provider ports whose runners are the REAL
// provider-dsh runner pointed at the programmable fake-dsh CLI (dshBin
// override), and the wecom adapter's wsUrl pointed at a fake WeCom openws
// server (node:http + ws, the contract-suite pattern). Six scenarios:
//   1 happy path   group @-message → ack → throttled progress (🔧 mid-run)
//                  → final finish=true '答案文本'; ledger/timeline/agents
//                  consistent; enter_chat default welcome fires (engine does
//                  not handle it — A4's false direction, live).
//   2 preemption   msg2 lands while the slow run is in flight → msg1 row
//                  interrupted (+（已取消上一条回复） final), msg2 completes,
//                  the CLI spawned exactly twice.
//   3 reload       four-phase reload mid-run → the in-run user gets the
//                  finish=true 维护 frame; after re-attach a new message
//                  completes; /healthz 200.
//   4 handoff      PATCH provider fakeprov→fakeprov2 → the next run's prompt
//                  starts with the 「以下是本对话此前的记录」 prefix and carries
//                  the prior turn (asserted on fake-dsh's last-prompt capture);
//                  ledger rows continue.
//   5 credentials  subscribe errcode 40001 → /api/agents offline with 鉴权失败
//                  reason, adapter stopped, no reconnect storm (≤3 attempts).
//   6 secret scan  none of the JSON bodies OR outbound ws frames captured
//                  during the whole run ever contains the account secret.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { createKernel } from '../../src/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FAKE_DSH = fileURLToPath(new URL('../fake-bin/fake-dsh.js', import.meta.url));
// The fake provider ports reuse the REAL provider-dsh runner: the e2e chain is
// engine → provider port → spawn/kill/NDJSON mapping → fake-dsh, i.e. the only
// fake below the port line is the CLI binary itself (dshBin override).
const DSH_RUNNER = fileURLToPath(new URL('../../plugins/provider-dsh/runner.js', import.meta.url));

const SECRET = 's3cret-wao-e2e';

// —— fake provider plugins (written to a tmp plugins dir at boot) ————————————
const fakeProviderSrc = (portId) => `
import { createRunner as makeDshRunner } from ${JSON.stringify(DSH_RUNNER)};
export default {
  manifest: { id: 'provider-${portId}', name: 'Fake ${portId}', type: 'provider', version: '0.1.0', requires: { kernel: '^1', ports: { provider: '^1' } } },
  activate(ctx) {
    ctx.registerProvider(${JSON.stringify(portId)}, {
      configSchema: [
        { key: 'cwd', label: 'Working directory', type: 'string', required: true },
        { key: 'dshBin', label: 'CLI binary', type: 'string' },
        { key: 'progressStyle', label: '工作汇报风格', type: 'enum', options: ['polite', 'cot'], default: 'polite' },
        { key: 'progressCoT', label: 'CoT progress', type: 'bool', default: true },
      ],
      validate(pc) { return pc?.mode === 'suspicious' ? ['fake ${portId} validate: mode "suspicious" rejected'] : []; },
      createRunner: ({ bot, providerConfig, log }) => makeDshRunner({ bot, providerConfig, log }),
    });
  },
};`;

const writePluginDir = (dir, src) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.js'), src);
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
};

// One dsh wrapper per BOT (own FAKE_HOME → spawn-count / last-prompt are
// isolated per scenario; exec preserves pid so last-pid is the spawned pid).
const makeWrapper = (dir, name, mode) => {
  const fakeHome = join(dir, 'fake-home', name);
  mkdirSync(join(dir, 'bin'), { recursive: true });
  mkdirSync(fakeHome, { recursive: true });
  const bin = join(dir, 'bin', `dsh-${name}.sh`);
  writeFileSync(bin, '#!/bin/sh\n'
    + `export FAKE_MODE="${mode}"\n`
    + `export FAKE_HOME="${fakeHome}"\n`
    + `printf 'x\\n' >> "${join(fakeHome, 'spawn-count')}"\n`
    + `exec "${FAKE_DSH}" "$@"\n`);
  chmodSync(bin, 0o755);
  return { bin, home: fakeHome };
};

// —— fake WeCom openws endpoint (contract-suite pattern) ————————————————————
function startFakeWecom({ subscribeErrcode = 0 } = {}) {
  return new Promise((resolve) => {
    const server = createServer();
    const wss = new WebSocketServer({ server });
    const st = { connections: 0, frames: [], sockets: [], subscribeErrcode };
    wss.on('connection', (ws) => {
      st.connections += 1;
      st.sockets.push(ws);
      ws.on('message', (buf) => {
        let msg;
        try {
          msg = JSON.parse(buf.toString());
        } catch {
          return;
        }
        st.frames.push(msg);
        if (msg.cmd === 'aibot_subscribe') {
          ws.send(JSON.stringify({
            headers: { req_id: msg.headers?.req_id },
            errcode: st.subscribeErrcode,
            errmsg: st.subscribeErrcode ? 'invalid credential' : 'ok',
          }));
        } else if (msg.cmd && msg.cmd !== 'ping') {
          ws.send(JSON.stringify({ headers: { req_id: msg.headers?.req_id }, errcode: 0 }));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      st.url = `ws://127.0.0.1:${server.address().port}`;
      st.current = () => st.sockets[st.sockets.length - 1];
      st.sendToCurrent = (obj) => {
        const ws = st.current();
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
      };
      st.close = async () => {
        for (const ws of st.sockets) {
          try { ws.terminate(); } catch {}
        }
        await new Promise((r) => wss.close(() => r()));
        await new Promise((r) => server.close(() => r()));
      };
      resolve(st);
    });
  });
}

// —— shared harness ————————————————————————————————————————————————————————
let kernel;
let dataDir;
let fakesDir;
let server1; // happy subscribe
let server2; // errcode 40001 subscribe
let b1; // scenario 1 + 4 bot fixtures (wrapper/home)
let b2, b3, b4;

// Scenario 6: every JSON body any test saw, scanned for the secret at the end.
const bodies = [];
const url = (p) => `http://127.0.0.1:${kernel.http.port}${p}`;
const jfetch = async (p, opts) => {
  const resp = await fetch(url(p), opts);
  bodies.push(await resp.clone().text());
  return resp;
};
const get = (p) => jfetch(p);
const post = (p, body) => jfetch(p, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const patch = (p, body) => jfetch(p, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const agentsOf = async () => (await (await get('/api/agents')).json()).agents;
const agentOf = async (id) => (await agentsOf()).find((a) => a.id === id) ?? null;
const ledgerOf = async (bot) => (await (await get(`/api/ledger?bot=${bot}`)).json());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (predicate, label, timeoutMs = 20000, everyMs = 50) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(everyMs);
  }
};

const groupText = (chatid, userid, content) => ({
  chattype: 'group', chatid, from: { userid }, msgtype: 'text', text: { content },
});
const msgCallback = (reqId, body) => ({ cmd: 'aibot_msg_callback', headers: { req_id: reqId }, body });
const respondFrames = (st) => st.frames.filter((f) => f.cmd === 'aibot_respond_msg');
const framesFor = (st, reqId) => respondFrames(st).filter((f) => f.headers.req_id === reqId);
const botRecord = (id, name, account, provider, providerConfig) => ({
  id, name, enabled: true, channel: 'wecom', account, allowedUsers: [], provider, providerConfig,
});
const spawnCount = (home) => {
  try { return readFileSync(join(home, 'spawn-count'), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; }
};
const lastPrompt = (home) => {
  try { return readFileSync(join(home, 'last-prompt'), 'utf8'); } catch { return null; }
};

// Outbound (user-visible) WeCom frame commands — the exact surface maskOutbound
// guards and scenario 6 scans for secrets. aibot_subscribe is deliberately
// NOT here: it is the one frame the protocol REQUIRES to carry the credential
// (bot_id+secret body), and it never reaches a user.
const OUTBOUND_CMDS = new Set(['aibot_respond_msg', 'aibot_respond_welcome_msg', 'aibot_respond_update_msg', 'aibot_send_msg']);
const outboundFrames = (st) => st.frames.filter((f) => OUTBOUND_CMDS.has(f.cmd));

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wao-e2e-data-'));
  fakesDir = mkdtempSync(join(tmpdir(), 'wao-e2e-fakes-'));
  writePluginDir(join(fakesDir, 'provider-fake1'), fakeProviderSrc('fakeprov'));
  writePluginDir(join(fakesDir, 'provider-fake2'), fakeProviderSrc('fakeprov2'));
  b1 = makeWrapper(fakesDir, 'b1', 'slow');
  b2 = makeWrapper(fakesDir, 'b2', 'slow');
  b3 = makeWrapper(fakesDir, 'b3', 'slow');
  b4 = makeWrapper(fakesDir, 'b4', 'ok');

  server1 = await startFakeWecom();
  server2 = await startFakeWecom({ subscribeErrcode: 40001 });
  kernel = await createKernel({ port: 0, dataDir, pluginsDirs: [fakesDir, join(repoRoot, 'plugins')] });
});

after(async () => {
  await kernel.stop();
  await server1.close();
  await server2.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(fakesDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
test('1. happy path: @-message → ack → 🔧 progress → final; ledger/timeline/agents; enter_chat welcome', async () => {
  // 2026-11-06 默认翻转（拟人播报）：本场景钉 🔧 进度帧=旧「详细汇报」语义，
  // 显式 progressStyle:'cot'（诚实迁移——断言一字不改）。
  const resp = await post('/api/bots', botRecord('e2e-b1', 'e2e 一号', { botId: 'B1', secret: SECRET, wsUrl: server1.url }, 'fakeprov', { cwd: dataDir, dshBin: b1.bin, progressStyle: 'cot' }));
  assert.equal(resp.status, 200, await resp.text());
  await waitFor(async () => (await agentOf('e2e-b1'))?.channelState?.state === 'online', 'b1 adapter online');

  server1.sendToCurrent(msgCallback('e2e-r1', groupText('G1', 'u1', '@_user_1 你好')));
  await waitFor(() => framesFor(server1, 'e2e-r1').some((f) => f.body?.stream?.finish === true), 'final frame for e2e-r1', 25000);

  const frames = framesFor(server1, 'e2e-r1');
  const ackIdx = frames.findIndex((f) => (f.body?.stream?.content ?? '').startsWith('✅ 收到'));
  const toolIdx = frames.findIndex((f) => (f.body?.stream?.content ?? '').startsWith('🔧'));
  const finalIdx = frames.findIndex((f) => f.body?.stream?.finish === true);
  assert.ok(ackIdx !== -1, `ack frame present: ${JSON.stringify(frames.map((f) => f.body?.stream))}`);
  assert.ok(toolIdx !== -1, 'a 🔧 tool progress frame reached the wire (past the 2200ms throttle)');
  assert.ok(finalIdx > toolIdx && toolIdx > ackIdx, `frame order ack→🔧→final (ack=${ackIdx} tool=${toolIdx} final=${finalIdx})`);
  assert.equal(frames[finalIdx].body.stream.content, '答案文本');
  assert.equal(frames[finalIdx].body.stream.finish, true);

  const rows = await waitFor(async () => {
    const r = await ledgerOf('e2e-b1');
    return r.length === 1 ? r : null;
  }, 'one ledger row');
  assert.equal(rows[0].chatKey, 'wecom:group:G1');
  assert.equal(rows[0].user, '@_user_1 你好');
  assert.equal(rows[0].reason, 'completed');
  assert.equal(rows[0].assistant, '答案文本');
  assert.equal(rows[0].provider, 'fakeprov');

  const agent = await agentOf('e2e-b1');
  assert.equal(agent.status, 'idle');
  assert.equal(agent.running, 0);
  assert.equal(agent.todayTurns, 1);
  assert.equal(agent.turns, 1);
  assert.equal(agent.reason, null);

  const tl = await (await get('/api/timeline?bot=e2e-b1')).json();
  assert.ok(Array.isArray(tl) && tl.length >= 1, 'timeline rows from the turn');

  // A4 live: enter_chat → engine observes but does NOT handle → the channel's
  // default welcome fires on the wire.
  server1.sendToCurrent({ cmd: 'aibot_event_callback', headers: { req_id: 'e2e-ev1' }, body: { event: { eventtype: 'enter_chat' } } });
  await waitFor(() => server1.frames.some((f) => f.cmd === 'aibot_respond_welcome_msg' && f.headers.req_id === 'e2e-ev1'), 'default welcome frame');
  const wf = server1.frames.find((f) => f.cmd === 'aibot_respond_welcome_msg' && f.headers.req_id === 'e2e-ev1');
  assert.match(wf.body.text.content, /您好，我是 e2e 一号/);
});

test('2. preemption: msg2 mid-run → msg1 interrupted row + （已取消） final, msg2 completes, exactly two spawns', async () => {
  const resp = await post('/api/bots', botRecord('e2e-b2', 'e2e 二号', { botId: 'B2', secret: SECRET, wsUrl: server1.url }, 'fakeprov', { cwd: dataDir, dshBin: b2.bin }));
  assert.equal(resp.status, 200, await resp.text());
  await waitFor(async () => (await agentOf('e2e-b2'))?.channelState?.state === 'online', 'b2 adapter online');

  server1.sendToCurrent(msgCallback('e2e-r2a', groupText('G2', 'u2', '@_user_2 慢任务一')));
  await waitFor(() => framesFor(server1, 'e2e-r2a').some((f) => (f.body?.stream?.content ?? '').startsWith('✅ 收到')), 'msg1 acked (run in flight)');
  await waitFor(() => spawnCount(b2.home) === 1, 'msg1 actually spawned the CLI');

  server1.sendToCurrent(msgCallback('e2e-r2b', groupText('G2', 'u2', '@_user_2 慢任务二')));
  await waitFor(() => framesFor(server1, 'e2e-r2b').some((f) => f.body?.stream?.finish === true), 'msg2 final', 25000);

  // msg1 was preempted: its stream closes with the cancel copy, finish=true
  const r2aFinal = framesFor(server1, 'e2e-r2a').find((f) => f.body?.stream?.finish === true);
  assert.ok(r2aFinal, 'msg1 stream closed (finish=true) on preemption');
  assert.equal(r2aFinal.body.stream.content, '（已取消上一条回复）');

  const rows = await waitFor(async () => {
    const r = await ledgerOf('e2e-b2');
    return r.length === 2 ? r : null;
  }, 'two ledger rows');
  assert.deepEqual(rows.map((r) => r.reason), ['interrupted', 'completed']);
  assert.deepEqual(rows.map((r) => r.user), ['@_user_2 慢任务一', '@_user_2 慢任务二']);
  assert.equal(rows[1].assistant, '答案文本');
  assert.equal(spawnCount(b2.home), 2, 'the CLI spawned exactly twice (m1 killed, m2 ran)');
});

test('3. reload four-phase: in-run 维护 final, re-attach, new message completes, /healthz 200', async () => {
  const resp = await post('/api/bots', botRecord('e2e-b3', 'e2e 三号', { botId: 'B3', secret: SECRET, wsUrl: server1.url }, 'fakeprov', { cwd: dataDir, dshBin: b3.bin }));
  assert.equal(resp.status, 200, await resp.text());
  await waitFor(async () => (await agentOf('e2e-b3'))?.channelState?.state === 'online', 'b3 adapter online');

  server1.sendToCurrent(msgCallback('e2e-r3a', groupText('G3', 'u3', '@_user_3 维护前任务')));
  await waitFor(() => framesFor(server1, 'e2e-r3a').some((f) => (f.body?.stream?.content ?? '').startsWith('✅ 收到')), 'msg acked (run in flight)');

  const reload = await post('/api/service/reload');
  assert.equal(reload.status, 200);

  // waitFor (not a sync find): the drain aborts the run asynchronously, and
  // across a reload's fresh adapter/connection the frame can land a beat
  // after the POST resolves.
  const maint = await waitFor(
    () => framesFor(server1, 'e2e-r3a').find((f) => f.body?.stream?.finish === true),
    'in-run maintenance final frame at drain time',
  );
  assert.match(maint.body.stream.content, /维护/);

  const rows = await waitFor(async () => {
    const r = await ledgerOf('e2e-b3');
    return r.length === 1 ? r : null;
  }, 'the drained turn journaled');
  assert.equal(rows[0].reason, 'interrupted');

  // after the four phases the bot re-attached on a fresh adapter
  await waitFor(async () => (await agentOf('e2e-b3'))?.channelState?.state === 'online', 'b3 re-attached after reload', 15000);
  server1.sendToCurrent(msgCallback('e2e-r3b', groupText('G3', 'u3', '@_user_3 维护后任务')));
  await waitFor(() => framesFor(server1, 'e2e-r3b').some((f) => f.body?.stream?.finish === true && f.body.stream.content === '答案文本'), 'post-reload final', 25000);
  assert.equal((await ledgerOf('e2e-b3')).length, 2);

  const healthz = await get('/healthz');
  assert.equal(healthz.status, 200);
  assert.equal((await healthz.json()).ok, true);
});

test('4. provider switch handoff: fakeprov→fakeprov2 → next prompt carries the ledger prefix', async () => {
  const resp = await patch('/api/bots/e2e-b1', { provider: 'fakeprov2' });
  assert.equal(resp.status, 200, await resp.text());
  await waitFor(async () => (await agentOf('e2e-b1'))?.channelState?.state === 'online', 'b1 re-attached on fakeprov2');

  server1.sendToCurrent(msgCallback('e2e-r4', groupText('G1', 'u1', '@_user_1 第二条消息')));
  await waitFor(() => framesFor(server1, 'e2e-r4').some((f) => f.body?.stream?.finish === true), 'handoff turn final', 25000);

  const prompt = await waitFor(() => lastPrompt(b1.home) ?? null, 'fake-dsh captured the prompt');
  assert.ok(prompt.startsWith('以下是本对话此前的记录（供上下文参考）：'), `prompt starts with the handoff header: ${prompt.slice(0, 40)}`);
  assert.ok(prompt.includes('用户: @_user_1 你好'), 'prefix carries the prior turn');
  assert.ok(prompt.includes('---'), 'separator before the new message');
  assert.ok(prompt.includes('@_user_1 第二条消息'), 'the new message itself is appended');

  const rows = await ledgerOf('e2e-b1');
  assert.equal(rows.length, 2, 'ledger rows continue across the switch');
  assert.equal(rows[1].provider, 'fakeprov2');
  assert.equal(rows[1].reason, 'completed');
});

test('5. credentials fail: subscribe 40001 → agents offline + 鉴权失败 reason, stopped, no reconnect storm', async () => {
  const resp = await post('/api/bots', botRecord('e2e-b4', 'e2e 四号', { botId: 'B4', secret: 'wrong-secret', wsUrl: server2.url }, 'fakeprov', { cwd: dataDir, dshBin: b4.bin }));
  assert.equal(resp.status, 200, await resp.text());
  const agent = await waitFor(async () => {
    const a = await agentOf('e2e-b4');
    return a?.status === 'offline' ? a : null;
  }, 'b4 reported offline');

  assert.match(agent.reason ?? '', /鉴权失败/);
  assert.match(agent.reason ?? '', /40001/);
  assert.equal(agent.channelState.state, 'stopped');

  // 凭证快速失败 (§4): single retry capped at 5min. 10s window matches the
  // contract-level storm check — a 1s→1.7x backoff loop would be at 5+
  // attempts by then; the capped client stays at the boot attempt (+1 per
  // reload), so ≤3 remains a strict bound.
  const conns = server2.connections;
  await sleep(10000);
  assert.ok(server2.connections <= conns + 1 && server2.connections <= 3,
    `no reconnect storm: ${server2.connections} connection attempts in 10s (cap 3)`);
});

test('6. the account secret never appears in any JSON response body or outbound ws frame', async () => {
  assert.ok(bodies.length >= 10, `captured ${bodies.length} response bodies during the suite`);
  // The wire is the other leak surface: every frame the adapter ever SENT
  // (progress/final/welcome/maintenance/decline/push, across reconnects) gets
  // the same scan as the API bodies — this is exactly what maskOutbound
  // guards. Subscribe frames are excluded by contract (see OUTBOUND_CMDS).
  const s1out = outboundFrames(server1);
  const s2out = outboundFrames(server2);
  assert.ok(s1out.length >= 10, `frame scan is not vacuous: ${s1out.length} outbound frames on server1`);
  const surfaces = [
    ...bodies.map((body, i) => [`api response #${i + 1}`, body]),
    ['server1 outbound frames', JSON.stringify(s1out)],
    ['server2 outbound frames', JSON.stringify(s2out)],
  ];
  for (const [where, text] of surfaces) {
    assert.equal(text.includes(SECRET), false, `secret leaked in ${where}: ${text.slice(0, 200)}`);
  }
});
