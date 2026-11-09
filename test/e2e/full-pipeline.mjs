#!/usr/bin/env node
// E2E: full pipeline test with REAL claude provider + FAKE WeCom ws server.
// Simulates a user sending a message → engine → middleware → claude → back.
// Verifies: progress frames, final text + cost tracker, run logs, ledger tokens, timeline usage.
//
// Usage: node test/e2e/full-pipeline.mjs
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';

const PORT = 18801;
const DATA_DIR = mkdtempSync(join(tmpdir(), 'wao-e2e-'));

// ── 1. Fake WeCom ws server ──────────────────────────────────────────
const frames = [];       // all outbound frames from the adapter
let wsConn = null;
const pendingAcks = new Map();

const httpServer = createServer();
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws) => {
  wsConn = ws;
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    // auto-ack every request
    if (msg.headers?.req_id) {
      ws.send(JSON.stringify({ headers: { req_id: msg.headers.req_id }, errcode: 0 }));
    }
    if (msg.cmd === 'aibot_subscribe') {
      ws.send(JSON.stringify({ headers: { req_id: msg.headers.req_id }, errcode: 0 }));
      return;
    }
    if (msg.cmd === 'ping') return;
    // capture all aibot_respond_msg / aibot_send_msg frames
    if (msg.cmd?.startsWith('aibot_')) {
      frames.push({ cmd: msg.cmd, body: msg.body, at: Date.now() });
    }
  });
});

await new Promise((r) => httpServer.listen(PORT, '127.0.0.1', r));
console.log(`[fake-wecom] listening on :${PORT}`);

// ── 2. Boot isolated kernel with full plugins ────────────────────────
const { createKernel } = await import('../../src/index.js');
const kernel = await createKernel({ port: 18802, dataDir: DATA_DIR });
console.log(`[kernel] booted on :18802, data=${DATA_DIR}`);

// ── 3. Create a bot: real claude + fake-wecom channel ───────────────
const botId = 'e2e-test';
const createBot = await fetch('http://127.0.0.1:18802/api/bots', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    id: botId, name: 'E2E 测试员', enabled: true,
    channel: 'wecom',
    account: { botId: 'e2e-fake', secret: 'x', wsUrl: `ws://127.0.0.1:${PORT}/ws` },
    provider: 'claude',
    providerConfig: {
      cwd: '/tmp',
      model: { model: 'auto/glm-5.3-flash' },
      permissionMode: 'bypassPermissions',
    },
  }),
}).then((r) => r.json());
if (!createBot.bot) { console.error('FAIL: create bot', createBot); process.exit(1); }
console.log('[bot] created:', createBot.bot.id);

// ── 4. Bind cost-tracker asset ───────────────────────────────────────
const assets = await fetch('http://127.0.0.1:18802/api/assets').then((r) => r.json());
const ct = assets.assets.find((a) => a.name === 'cost-tracker');
if (ct) {
  const bind = await fetch(`http://127.0.0.1:18802/api/bots/${botId}/assets`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ assetId: ct.id, mode: 'shared' }),
  }).then((r) => r.json());
  console.log('[asset] cost-tracker bound:', bind.ok || bind.error || 'ok');
}

// Wait for adapter to connect to fake ws
await new Promise((r) => setTimeout(r, 3000));
const agents = await fetch('http://127.0.0.1:18802/api/agents').then((r) => r.json());
const agent = agents.agents.find((a) => a.id === botId);
console.log('[agent] status:', agent?.status, '| connected:', !!wsConn);
if (!wsConn) { console.error('FAIL: adapter did not connect to fake ws'); process.exit(1); }

// ── 5. Simulate user message via fake ws ────────────────────────────
console.log('\n=== SIMULATING USER MESSAGE ===');
const reqId = `e2e-req-${Date.now()}`;
const userText = '只回复两个字：收到';
wsConn.send(JSON.stringify({
  cmd: 'aibot_msg_callback',
  headers: { req_id: reqId },
  body: {
    chattype: 'single',
    chatid: 'test-user-001',
    from: { userid: 'test-user-001', name: '测试用户' },
    msgtype: 'text',
    text: { content: userText },
  },
}));

// ── 6. Wait for completion (final frame with finish=true) ───────────
const deadline = Date.now() + 90_000;
let finalFrame = null;
while (Date.now() < deadline && !finalFrame) {
  await new Promise((r) => setTimeout(r, 1000));
  finalFrame = frames.find((f) =>
    f.cmd === 'aibot_respond_msg' && f.body?.stream?.finish === true
  );
}

// ── 7. Collect results ───────────────────────────────────────────────
console.log('\n=== RESULTS ===');

// 7a. Outbound frames
const respondFrames = frames.filter((f) => f.cmd === 'aibot_respond_msg');
console.log(`\n📦 Outbound frames: ${respondFrames.length}`);
respondFrames.forEach((f, i) => {
  const content = f.body?.stream?.content || '';
  const finish = f.body?.stream?.finish;
  console.log(`  [${i}] finish=${finish} | ${content.slice(0, 100)}${content.length > 100 ? '…' : ''}`);
});

// 7b. Check cost tracker in final
if (finalFrame) {
  const finalText = finalFrame.body.stream.content;
  const hasToken = finalText.includes('📊 Token：');
  console.log(`\n💰 Cost tracker in final: ${hasToken ? '✅' : '❌'}`);
  if (hasToken) {
    const tokenLine = finalText.split('\n').find((l) => l.includes('📊 Token'));
    console.log(`   ${tokenLine}`);
  }
} else {
  console.log('\n💰 Cost tracker: ❌ (no final frame — timeout)');
}

// 7c. Check ledger tokens
const ledgerFile = join(DATA_DIR, 'ledger', `${botId}.jsonl`);
try {
  const lines = readFileSync(ledgerFile, 'utf8').trim().split('\n');
  const last = JSON.parse(lines[lines.length - 1]);
  console.log(`\n📒 Ledger last entry:`);
  console.log(`   reason: ${last.reason}`);
  console.log(`   tokens: ${last.tokens}`);
  console.log(`   tokens非null: ${last.tokens !== null ? '✅' : '❌'}`);
} catch { console.log('\n📒 Ledger: ❌ (no file)'); }

// 7d. Check run log lines
const logFile = join(DATA_DIR, 'logs', 'wao.log');
const logLines = readFileSync(logFile, 'utf8').split('\n');
const runStart = logLines.filter((l) => l.includes('run start')).pop();
const runDone = logLines.filter((l) => l.includes('run done')).pop();
console.log(`\n📝 Run log lines:`);
console.log(`   run start: ${runStart ? '✅ ' + runStart.split('INFO ')[1]?.slice(0, 80) : '❌'}`);
console.log(`   run done:  ${runDone ? '✅ ' + runDone.split('INFO ')[1]?.slice(0, 80) : '❌'}`);

// 7e. Check timeline usage
const timeline = await fetch(`http://127.0.0.1:18802/api/timeline?bot=${botId}`).then((r) => r.json());
const usageEvents = (timeline || []).filter((e) => e.kind === 'usage');
console.log(`\n📊 Timeline usage events: ${usageEvents.length > 0 ? '✅' : '❌'} (${usageEvents.length} found)`);
if (usageEvents.length > 0) console.log(`   ${usageEvents[0].text}`);

// 7f. Check agents observability
const agentsAfter = await fetch('http://127.0.0.1:18802/api/agents').then((r) => r.json());
const a = agentsAfter.agents.find((x) => x.id === botId);
console.log(`\n🔍 Agents observability:`);
console.log(`   lastRunAt: ${a?.lastRunAt ? '✅ ' + new Date(a.lastRunAt).toLocaleTimeString() : '❌'}`);
console.log(`   totalTokens: ${a?.totalTokens !== undefined ? '✅ ' + a.totalTokens : '❌'}`);
console.log(`   todayTurns: ${a?.todayTurns}`);

// ── 8. Cleanup ───────────────────────────────────────────────────────
console.log('\n=== CLEANUP ===');
await kernel.stop();
wss.close();
httpServer.close();
rmSync(DATA_DIR, { recursive: true, force: true });
console.log('Done.');

// Summary
const pass = [];
const fail = [];
const checks = [
  ['adapter connected to fake ws', !!wsConn],
  ['has final frame', !!finalFrame],
  ['cost tracker token line', finalFrame?.body?.stream?.content?.includes('📊 Token') || false],
  ['ledger tokens non-null', (() => { try { const l = readFileSync(ledgerFile, 'utf8'); return JSON.parse(l.trim().split('\n').pop()).tokens !== null; } catch { return false; } })()],
  ['run start log', !!runStart],
  ['run done log', !!runDone],
  ['timeline usage event', usageEvents.length > 0],
  ['agents lastRunAt', !!a?.lastRunAt],
];
checks.forEach(([name, ok]) => (ok ? pass : fail).push(name));
console.log(`\n${'='.repeat(50)}`);
console.log(`PASS: ${pass.length}/${checks.length}`);
pass.forEach((p) => console.log(`  ✅ ${p}`));
if (fail.length) { console.log(`FAIL: ${fail.length}`); fail.forEach((f) => console.log(`  ❌ ${f}`)); }
process.exit(fail.length > 0 ? 1 : 0);
