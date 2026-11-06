// MCP gateway tool-surface tests (W1 T2): a REAL kernel boot (createKernel,
// port 0, tmp dataDir) with the repo plugins (core-engine + mcp-gateway) plus
// the two fake port plugins from test/engine/plugin.test.js (channel-fake /
// provider-fake). Every case drives the 13 company tools through real
// HTTP/JSON-RPC — the contract under test is the tool behavior: dual output
// (text + structuredContent), API-semantics error mapping (400/404/409 →
// isError results, unknown tool → -32602), secret red line (fake secrets
// never appear in ANY captured response body), and the dangerous-tool
// consequence copy (offboard / department_toggle / broadcast).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKernel } from '../../src/index.js';
import { loadBots } from '../../plugins/core-engine/bots.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Fake port plugins — the same shapes as test/engine/plugin.test.js: a
// recording channel adapter (pushes land on globalThis.__waoMcpAdapters) and
// a scripted provider runner (records prompts, echoes sessionIds).
const FAKE_CHANNEL = `
export default {
  manifest: { id: 'channel-fake', name: 'Fake Channel', type: 'channel', version: '0.1.0', requires: { kernel: '^1' } },
  activate(ctx) {
    ctx.registerChannel('fakechan', {
      accountSchema: [
        { key: 'endpoint', label: 'Endpoint', type: 'string', required: true },
        { key: 'secret', label: 'Secret', type: 'password', required: false },
      ],
      capabilities: { stream: true, push: true, group: true, welcome: false, maxContentChars: 3500, minIntervalMs: 10, heartbeatMs: 60000, streamDeadlineMs: 600000 },
      createAdapter({ bot, engine }) {
        const adapter = {
          engine, pushes: [],
          start() {}, stop() {},
          status() { return { state: 'online', lastError: null }; },
          ack() {}, progress() {}, reply() {}, welcome() {},
          push(chatRef, text) { adapter.pushes.push({ chatRef, text }); },
        };
        (globalThis.__waoMcpAdapters ??= new Map()).set(bot.id, adapter);
        return adapter;
      },
    });
  },
};`;

const FAKE_PROVIDER = `
export default {
  manifest: { id: 'provider-fake', name: 'Fake Provider', type: 'provider', version: '0.1.0', requires: { kernel: '^1' } },
  activate(ctx) {
    ctx.registerProvider('fakeprov', {
      configSchema: [
        { key: 'cwd', label: 'Working directory', type: 'string', required: true },
        { key: 'mode', label: 'Mode', type: 'enum', options: ['a', 'b'], required: false },
        { key: 'extra', label: 'Extra object', type: 'object' },
      ],
      validate(providerConfig) {
        return (typeof providerConfig?.cwd === 'string' && providerConfig?.cwd !== '') ? [] : ['cwd is required'];
      },
      materializeConfig() { return { changed: true }; },
      removeConfig() { return { removed: true }; },
      createRunner({ bot }) {
        return {
          async run({ prompt, sessionId, onEvent }) {
            (globalThis.__waoMcpPrompts ??= []).push(prompt);
            if (onEvent) onEvent({ type: 'text', text: '好的：' + prompt });
            return { ok: true, code: 'completed', finalText: 'fake 完成：' + prompt, aborted: false, sessionId: sessionId || 'session-fake-' + bot.id, reason: null, detail: { exitCode: 0 } };
          },
          async readHistory() { return { turns: [], truncated: false, warnings: [] }; },
        };
      },
      describeError(r) { return 'fake error: ' + (r?.code ?? 'unknown'); },
    });
  },
};`;

const writePluginDir = (dir, src) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.js'), src);
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
};

// The employee the whole journey hires. Carries BOTH secret shapes the red
// line must catch: a password-typed account.secret AND credential-looking
// object-field values (providerConfig.extra) that only the __MASKED__ echo
// semantics keep out of responses.
const SECRET_PW = '{{SECRET_mcptools1}}';
const SECRET_KEY = 'sk-mcp-abc123';
const SECRET_TOKEN = 'tok-mcp-456';
const BOT_M1 = {
  id: 'm1', name: '测试员工', enabled: true, channel: 'fakechan',
  account: { endpoint: 'http://mcp.local', secret: SECRET_PW },
  allowedUsers: [],
  provider: 'fakeprov',
  providerConfig: { cwd: '/tmp', mode: 'a', extra: { OPENAI_API_KEY: SECRET_KEY, HUB_TOKEN: SECRET_TOKEN, note: 'keep' } },
};

const TOOL_NAMES = [
  'list_employees', 'get_employee', 'hire', 'update_employee', 'offboard',
  'set_duty', 'probation_test', 'broadcast', 'list_departments',
  'department_toggle', 'work_log', 'work_timeline', 'company_state',
];

let kernel = null;
let dataDir = null;
let fakesDir = null;
let sessionId = null;
const capturedBodies = []; // every JSON-RPC response body, for the secret scan

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wao-mcp-tools-data-'));
  fakesDir = mkdtempSync(join(tmpdir(), 'wao-mcp-tools-fakes-'));
  writePluginDir(join(fakesDir, 'channel-fake'), FAKE_CHANNEL);
  writePluginDir(join(fakesDir, 'provider-fake'), FAKE_PROVIDER);
  kernel = await createKernel({ port: 0, dataDir, pluginsDirs: [fakesDir, join(repoRoot, 'plugins')] });
  sessionId = await initSession();
});

after(async () => {
  await kernel.stop();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(fakesDir, { recursive: true, force: true });
});

const base = () => `http://127.0.0.1:${kernel.http.port}`;

async function initSession() {
  const res = await fetch(`${base()}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tools-test', version: '0.0.0' } } }),
  });
  return res.headers.get('mcp-session-id');
}

// One tools/call round-trip. Captures the raw body for the secret scan and
// returns {status, body}. NO auto-retry: tests that rebuild the session (a
// department_toggle reload kills it) re-initialize explicitly.
async function rpcCall(payload) {
  const res = await fetch(`${base()}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'mcp-session-id': sessionId },
    body: JSON.stringify(payload),
  });
  const raw = await res.text();
  capturedBodies.push(raw);
  return { status: res.status, body: JSON.parse(raw) };
}

// callTool(name, arguments) → the tool RESULT object (asserts no RPC error).
async function call(name, args = {}) {
  const { body } = await rpcCall({ jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(body.error, undefined, `tools/call ${name} must answer a result, got ${JSON.stringify(body.error)}`);
  return body.result;
}

const waitFor = async (predicate, label, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

test('tools/list: the 13-tool roster with Chinese descriptions and object schemas', async () => {
  const { body } = await rpcCall({ jsonrpc: '2.0', id: 'list', method: 'tools/list' });
  const tools = body.result.tools;
  assert.deepEqual(tools.map((t) => t.name), TOOL_NAMES);
  for (const t of tools) {
    assert.ok(t.description.length > 10, `${t.name} has a real description`);
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(typeof t.inputSchema.properties, 'object');
  }
  // dangerous tools declare themselves in the description copy
  for (const name of ['offboard', 'broadcast', 'department_toggle']) {
    assert.match(tools.find((t) => t.name === name).description, /危险操作/);
  }
  // the probe's success judge is the result code, not isError
  assert.match(tools.find((t) => t.name === 'probation_test').description, /勿只看 isError/);
  // blind-review P2s (W1-T4): the four-tier status lexicon rides in the tool
  // descriptions so a bare client relays states verbatim; offboard's fact
  // sheet covers re-hire; get_employee describes the real masking presentation
  // (secret-class keys omitted outright — not echoed as `__MASKED__`).
  const lexicon = /状态四档：working=工作中\/idle=待命\/offline=离线\(休假\)\/enabled:false=休假\(调休\)；转述时用此词表/;
  for (const name of ['list_employees', 'get_employee', 'company_state']) {
    assert.match(tools.find((t) => t.name === name).description, lexicon);
  }
  assert.match(tools.find((t) => t.name === 'offboard').description, /同工牌号可重新 hire（历史台账不自动接续）/);
  assert.match(tools.find((t) => t.name === 'get_employee').description, /敏感值不回显（secret 类键整体省略）/);
});

test('hire → appears in list_employees → get_employee detail is secret-free', async () => {
  const hired = await call('hire', { bot: BOT_M1 });
  assert.equal(hired.isError, undefined);
  assert.match(hired.content[0].text, /入职完成：测试员工（工牌号 m1）/);
  assert.equal(hired.structuredContent.bot.account.secret, undefined, 'hire echo strips account.secret');
  assert.equal(hired.structuredContent.bot.providerConfig.extra.OPENAI_API_KEY, '__MASKED__', 'object-field credential is masked');

  const roster = await call('list_employees');
  const m1 = roster.structuredContent.agents.find((a) => a.id === 'm1');
  assert.ok(m1, 'm1 on the roster');
  assert.equal(m1.status, 'idle');
  assert.match(roster.content[0].text, /m1（测试员工）｜待命｜岗位 fakeprov/);

  const detail = await call('get_employee', { botId: 'm1' });
  assert.match(detail.content[0].text, /测试员工（工牌号 m1）/);
  assert.match(detail.content[0].text, /门禁名单：不限制/);
  assert.equal(detail.structuredContent.employee.bot.account.secret, undefined);
  assert.equal(detail.structuredContent.employee.bot.providerConfig.extra.HUB_TOKEN, '__MASKED__');
  assert.equal(detail.structuredContent.employee.bot.providerConfig.extra.note, 'keep');
  assert.ok(Number.isFinite(detail.structuredContent.employee.createdAt), '入职 stamp present');

  const unknown = await call('get_employee', { botId: 'nobody' });
  assert.equal(unknown.isError, true);
  assert.equal(unknown.structuredContent.status, 404);
  assert.match(unknown.content[0].text, /404/);
});

test('hire validation errors pass through as isError results (400 semantics) with port hints', async () => {
  const bad = await call('hire', { bot: { ...BOT_M1, id: 'bad1', providerConfig: { cwd: '/tmp', mode: 'zzz' } } });
  assert.equal(bad.isError, true);
  assert.equal(bad.structuredContent.status, 400);
  assert.ok(bad.structuredContent.errors.some((e) => /mode/.test(e)), JSON.stringify(bad.structuredContent.errors));
  const dup = await call('hire', { bot: { ...BOT_M1, id: 'm1' } });
  assert.equal(dup.isError, true);
  assert.match(dup.content[0].text, /bot id already exists: m1/);
  // the hint enriches unknown-port failures with what IS available
  const unknownPort = await call('hire', { bot: { ...BOT_M1, id: 'bad2', channel: 'nope', providerConfig: { cwd: '/tmp' } } });
  assert.ok(unknownPort.structuredContent.errors.some((e) => /当前在册通道端口.*fakechan/.test(e)), JSON.stringify(unknownPort.structuredContent.errors));
});

test('probation_test: custom prompt reaches the runner; sessionId passthrough; unknown bot 404', async () => {
  const r = await call('probation_test', { botId: 'm1', prompt: '回答：1+1=?', sessionId: 'probe-sid-1' });
  assert.equal(r.isError, undefined);
  assert.equal(r.structuredContent.result.code, 'completed');
  assert.equal(r.structuredContent.result.sessionId, 'probe-sid-1');
  assert.match(r.structuredContent.result.finalText, /fake 完成：回答：1\+1=\?/);
  assert.deepEqual(globalThis.__waoMcpPrompts.at(-1), '回答：1+1=?', 'prompt reached the fake runner');
  assert.match(r.content[0].text, /不进引擎链、不记台账/);
  const missing = await call('probation_test', { botId: 'nobody' });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent.status, 404);
});

test('update_employee: patch semantics keep blank passwords and apply config edits', async () => {
  const r = await call('update_employee', {
    botId: 'm1',
    patch: { providerConfig: { cwd: '/tmp', mode: 'b', extra: { OPENAI_API_KEY: '__MASKED__', note: 'keep' } } },
  });
  assert.equal(r.isError, undefined);
  const onDisk = loadBots(join(dataDir, 'bots.json')).bots.find((b) => b.id === 'm1');
  assert.equal(onDisk.providerConfig.mode, 'b');
  assert.equal(onDisk.providerConfig.extra.OPENAI_API_KEY, SECRET_KEY, 'masked round-trip keeps the stored literal');
  assert.equal(onDisk.account.secret, SECRET_PW, 'untouched account block keeps its secret');
  assert.equal(r.structuredContent.bot.providerConfig.extra.OPENAI_API_KEY, '__MASKED__', 'echo stays masked');
});

test('set_duty toggles 调休/返岗; broadcast while off-duty is a 409 isError', async () => {
  const off = await call('set_duty', { botId: 'm1' });
  assert.match(off.content[0].text, /调休：测试员工/);
  let roster = await call('list_employees');
  assert.match(roster.content[0].text, /m1（测试员工）｜休假/);
  const offlinePush = await call('broadcast', { botId: 'm1', chatKey: 'fake:group:g1', content: '不该发出' });
  assert.equal(offlinePush.isError, true);
  assert.equal(offlinePush.structuredContent.status, 409);
  const on = await call('set_duty', { botId: 'm1' });
  assert.match(on.content[0].text, /返岗：测试员工/);
  roster = await call('list_employees');
  assert.match(roster.content[0].text, /m1（测试员工）｜待命/);
});

test('broadcast lands on the fake channel adapter with real-delivery consequence copy', async () => {
  const r = await call('broadcast', { botId: 'm1', chatKey: 'fake:group:g1', content: 'MCP 广播测试' });
  assert.equal(r.isError, undefined);
  const adapter = globalThis.__waoMcpAdapters.get('m1');
  assert.ok(adapter, 'live adapter');
  assert.deepEqual(adapter.pushes.at(-1), { chatRef: 'fake:group:g1', text: 'MCP 广播测试' });
  assert.match(r.content[0].text, /真实送达企业微信/);
  assert.match(r.content[0].text, /无法撤回/);
});

test('work_log and work_timeline read real engine-produced records', async () => {
  const svc = kernel.services.get('engine');
  const bot = loadBots(join(dataDir, 'bots.json')).bots.find((b) => b.id === 'm1');
  svc.onMessage(bot, { reqId: 'r1', chatKey: 'fake:single:u1', chatKind: 'single', chatid: 'u1', userid: 'u1', text: '你好', raw: {} });
  await waitFor(() => svc.status('m1').status === 'idle', 'turn to settle');

  const log = await call('work_log', { botId: 'm1' });
  assert.equal(log.structuredContent.turns.length, 1);
  assert.equal(log.structuredContent.turns[0].user, '你好');
  assert.match(log.structuredContent.turns[0].assistant, /fake 完成/);
  assert.match(log.content[0].text, /共 1 轮/);

  const tl = await call('work_timeline', { botId: 'm1', windowMin: 5 });
  assert.ok(tl.structuredContent.events.length >= 1, 'timeline rows from the turn');
  assert.match(tl.content[0].text, /时间线/);
});

test('list_departments and company_state summarize the live registry', async () => {
  const depts = await call('list_departments');
  const provFake = depts.structuredContent.departments.find((p) => p.id === 'provider-fake');
  assert.deepEqual(
    { id: provFake.id, type: provFake.type, version: provFake.version, status: provFake.status },
    { id: 'provider-fake', type: 'provider', version: '0.1.0', status: 'active' },
  );
  assert.match(depts.content[0].text, /provider-fake（Fake Provider）｜provider｜v0\.1\.0｜在役/);

  const st = await call('company_state');
  assert.ok(Number.isFinite(st.structuredContent.uptimeSec));
  assert.match(st.content[0].text, /部门：在役 \d+／停用 \d+／故障 \d+/);
  assert.match(st.content[0].text, /员工：在册 1 人（工作中 0／待命 1／离线 0／休假 0）/);
});

test('department_toggle: disable takes the employee offline (reload), session rebuilds, enable restores', async () => {
  // dangerous copy + impact list computed BEFORE the flip
  const off = await call('department_toggle', { departmentId: 'provider-fake', enabled: false });
  assert.equal(off.isError, undefined);
  assert.match(off.content[0].text, /部门停用：provider-fake/);
  assert.match(off.content[0].text, /影响 1 名员工下线：m1（测试员工）/);
  assert.deepEqual(off.structuredContent.affectedEmployees, ['m1']);

  // The four-phase reload rebuilt the gateway: the old session is stale.
  const stale = await rpcCall({ jsonrpc: '2.0', id: 'stale', method: 'tools/list' });
  assert.equal(stale.body.error.code, -32002, 'reload terminates MCP sessions (documented consequence)');
  sessionId = await initSession();

  const roster = await call('list_employees');
  const m1 = roster.structuredContent.agents.find((a) => a.id === 'm1');
  assert.equal(m1.status, 'offline');
  assert.match(m1.reason ?? '', /fakeprov/, `offline reason names the vanished provider: ${m1.reason}`);
  const depts = await call('list_departments');
  assert.equal(depts.structuredContent.departments.find((p) => p.id === 'provider-fake')?.status, 'disabled');
  assert.match(depts.content[0].text, /provider-fake（Fake Provider）｜provider｜v0\.1\.0｜停用/);
  // offline employees now land in their OWN bucket — the summary line no
  // longer drops them (text and structuredContent stay consistent)
  const stOffline = await call('company_state');
  assert.match(stOffline.content[0].text, /员工：在册 1 人（工作中 0／待命 0／离线 1／休假 0）/, 'offline employee counted in the summary');

  const on = await call('department_toggle', { departmentId: 'provider-fake', enabled: true });
  assert.match(on.content[0].text, /部门恢复：provider-fake 已启用/);
  sessionId = await initSession();
  const back = await call('list_employees');
  assert.equal(back.structuredContent.agents.find((a) => a.id === 'm1').status, 'idle', 'reconcile re-attached the employee');

  const unknown = await call('department_toggle', { departmentId: 'no-such-dept', enabled: false });
  assert.equal(unknown.isError, true);
  assert.equal(unknown.structuredContent.status, 404);
});

test('offboard: exit-interview consequence copy; second call is a 404 isError', async () => {
  // A fresh turn in the CURRENT process (the department_toggle reloads emptied
  // the in-memory timeline ring) so the history claim below has something to
  // point at.
  const svc = kernel.services.get('engine');
  const bot = loadBots(join(dataDir, 'bots.json')).bots.find((b) => b.id === 'm1');
  svc.onMessage(bot, { reqId: 'r2', chatKey: 'fake:single:u1', chatKind: 'single', chatid: 'u1', userid: 'u1', text: '最后一句', raw: {} });
  await waitFor(() => svc.status('m1').status === 'idle', 'farewell turn to settle');

  const r = await call('offboard', { botId: 'm1' });
  assert.equal(r.isError, undefined);
  const text = r.content[0].text;
  assert.match(text, /离职手续已办结：测试员工（工牌号 m1）/);
  assert.match(text, /在途工作已收尾/);
  assert.match(text, /工位已清理/);
  assert.match(text, /档案留存/);
  assert.match(text, /可重新入职/);
  assert.equal(loadBots(join(dataDir, 'bots.json')).bots.some((b) => b.id === 'm1'), false, 'bot removed from bots.json');
  const roster = await call('list_employees');
  assert.equal(roster.structuredContent.agents.length, 0);
  assert.match(roster.content[0].text, /公司当前没有在册员工/);
  // timeline all-hands stream still carries the retired employee's events
  const tl = await call('work_timeline', { windowMin: 30 });
  assert.ok(tl.structuredContent.events.some((e) => e.botId === 'm1'), 'timeline history survives offboarding');
  const again = await call('offboard', { botId: 'm1' });
  assert.equal(again.isError, true);
  assert.equal(again.structuredContent.status, 404);
});

test('department_toggle impact counts only on-duty employees; an off-duty hire is not "taken down"', async () => {
  // Re-hire (same 工牌号, as the exit-interview copy promises) then park m1 on
  // 调休 BEFORE the flip: a disabled employee is already offline, so the
  // disable copy must say 0, not 1.
  const rehired = await call('hire', { bot: BOT_M1 });
  assert.equal(rehired.isError, undefined);
  assert.match(rehired.content[0].text, /入职完成：测试员工（工牌号 m1）/);
  const off = await call('set_duty', { botId: 'm1' });
  assert.match(off.content[0].text, /调休：测试员工/);

  const flip = await call('department_toggle', { departmentId: 'provider-fake', enabled: false });
  assert.equal(flip.isError, undefined);
  assert.match(flip.content[0].text, /影响 0 名员工下线/, 'off-duty employee not miscounted');
  assert.deepEqual(flip.structuredContent.affectedEmployees, []);
  sessionId = await initSession();

  const on = await call('department_toggle', { departmentId: 'provider-fake', enabled: true });
  assert.match(on.content[0].text, /部门恢复：provider-fake 已启用/);
  sessionId = await initSession();

  const back = await call('set_duty', { botId: 'm1' });
  assert.match(back.content[0].text, /返岗：测试员工/);
  // restore the journey's end state (empty roster) for the tests that follow
  const exit = await call('offboard', { botId: 'm1' });
  assert.equal(exit.isError, undefined);
});

test('department_toggle without the engine service: impact honestly unknown, the flip still works', async () => {
  // Park core-engine (companyOps) — department_toggle must not pretend "0
  // affected" from a tally it could not run.
  const offEngine = await call('department_toggle', { departmentId: 'core-engine', enabled: false });
  assert.equal(offEngine.isError, undefined);
  assert.match(offEngine.content[0].text, /部门停用：core-engine/);
  sessionId = await initSession();

  const flip = await call('department_toggle', { departmentId: 'provider-fake', enabled: false });
  assert.equal(flip.isError, undefined);
  assert.match(flip.content[0].text, /影响未知（引擎不可用）/, 'unknown impact is stated, not faked as 0');
  assert.equal(flip.structuredContent.affectedEmployees, null);
  sessionId = await initSession();

  const onProv = await call('department_toggle', { departmentId: 'provider-fake', enabled: true });
  assert.match(onProv.content[0].text, /部门恢复：provider-fake 已启用/);
  sessionId = await initSession();
  const onEngine = await call('department_toggle', { departmentId: 'core-engine', enabled: true });
  assert.match(onEngine.content[0].text, /部门恢复：core-engine 已启用/);
  sessionId = await initSession();

  // engine back behind the tools: companyOps answers again
  const st = await call('company_state');
  assert.match(st.content[0].text, /员工：在册 0 人（工作中 0／待命 0／离线 0／休假 0）/);
});

test('dirty arguments: schema violations are isError results, unknown/malformed tool names are -32602', async () => {
  const missing = await call('get_employee', {});
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /参数不符：缺少必填参数 botId/);

  const wrongType = await call('get_employee', { botId: 42 });
  assert.equal(wrongType.isError, true);
  assert.match(wrongType.content[0].text, /参数不符：参数 botId 必须是字符串/);

  const extra = await call('list_employees', { foo: 1 });
  assert.equal(extra.isError, true);
  assert.match(extra.content[0].text, /未知参数 foo/);

  // hire's TOP level is closed (typo'd keys must fail, not vanish) while the
  // bot record itself stays open (engine-side validateBot owns that layer)
  const extraTop = await call('hire', { bot: { ...BOT_M1, id: 'never-created' }, seasoning: 1 });
  assert.equal(extraTop.isError, true);
  assert.match(extraTop.content[0].text, /参数不符：未知参数 seasoning/);
  const rosterAfter = await call('list_employees');
  assert.equal(rosterAfter.structuredContent.agents.length, 0, 'rejected hire created nothing');

  const negative = await call('work_timeline', { windowMin: -5 });
  assert.equal(negative.isError, true);
  assert.match(negative.content[0].text, /windowMin 不能小于 0/);

  const partial = await call('broadcast', { botId: 'm1', chatKey: 'x' });
  assert.equal(partial.isError, true);
  assert.match(partial.content[0].text, /缺少必填参数 content/);

  const unknownTool = await rpcCall({ jsonrpc: '2.0', id: 'u1', method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } });
  assert.equal(unknownTool.body.error.code, -32602);

  const noName = await rpcCall({ jsonrpc: '2.0', id: 'u2', method: 'tools/call', params: { arguments: {} } });
  assert.equal(noName.body.error.code, -32602);

  const badArgs = await rpcCall({ jsonrpc: '2.0', id: 'u3', method: 'tools/call', params: { name: 'list_employees', arguments: 'just-a-string' } });
  assert.equal(badArgs.body.error.code, -32602);

  const noParams = await rpcCall({ jsonrpc: '2.0', id: 'u4', method: 'tools/call' });
  assert.equal(noParams.body.error.code, -32602, 'absent params default to {} → unknown-name shape');
});

test('secret red line: no fake secret literal appears in ANY captured response body', async () => {
  assert.ok(capturedBodies.length >= 20, `the journey captured a meaningful sample (${capturedBodies.length} bodies)`);
  for (const secret of [SECRET_PW, SECRET_KEY, SECRET_TOKEN]) {
    const hits = capturedBodies.filter((b) => b.includes(secret));
    assert.deepEqual(hits, [], `secret ${secret} must never appear in a tool response`);
  }
});
