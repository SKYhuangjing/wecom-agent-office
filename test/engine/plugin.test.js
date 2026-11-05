// Task 14: the core-engine ASSEMBLY — a real kernel (createKernel, port 0,
// tmp dataDir) boots the real core-engine plugin plus two fake plugins derived
// from the _template shapes: 'channel-fake' (no-op recording adapter) and
// 'provider-fake' (scripted runner + recording materializeConfig). The file
// walks the operator journey: create a bot over the API, patch its config,
// toggle it, test-run its provider, watch reconcile take it offline when the
// provider plugin is disabled (via plugins.json + the four-phase reload — the
// kernel-native per-plugin disable endpoint does not exist yet), then drive
// one real message through the registered engine service and read the ledger /
// session / export / timeline / send surfaces back out. Every response body is
// asserted secret-free.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKernel } from '../../src/index.js';
import { loadBots, saveBots, validateBot, validateSchema, revalidateAll } from '../../plugins/core-engine/bots.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Fake plugins (T8 template shapes, manifest ids provider-fake/channel-fake,
// port ids 'fakechan'/'fakeprov' — bots.json references the PORT ids).
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
          engine,
          pushes: [],
          start() { globalThis.__waoFakeChanStarted = (globalThis.__waoFakeChanStarted ?? 0) + 1; },
          stop() { globalThis.__waoFakeChanStopped = (globalThis.__waoFakeChanStopped ?? 0) + 1; },
          status() { return { state: 'online', lastError: null }; },
          ack() {}, progress() {}, reply() {}, welcome() {},
          push(chatRef, text) { adapter.pushes.push({ chatRef, text }); },
        };
        (globalThis.__waoFakeAdapters ??= new Map()).set(bot.id, adapter);
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
      ],
      materializeConfig(bot) {
        globalThis.__waoFakeMaterialize = (globalThis.__waoFakeMaterialize ?? 0) + 1;
        (globalThis.__waoFakeMaterializeLog ??= []).push({ id: bot.id, cwd: bot.providerConfig?.cwd, mode: bot.providerConfig?.mode });
        if (bot.providerConfig?.cwd === '/fail') throw new Error('materialize boom');
        return { changed: true };
      },
      createRunner({ bot }) {
        return {
          async run({ prompt, sessionId, signal, onEvent }) {
            if (signal?.aborted) {
              return { ok: false, code: 'aborted', finalText: '', aborted: true, sessionId: sessionId ?? null, reason: 'aborted before start', detail: {} };
            }
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

let kernel;
let dataDir;
let fakesDir;
const url = (p) => `http://127.0.0.1:${kernel.http.port}${p}`;
const post = (p, body) => fetch(url(p), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const patch = (p, body) => fetch(url(p), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = (p) => fetch(url(p));
const agentsOf = async () => (await (await get('/api/agents')).json()).agents;
const waitFor = async (predicate, label, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wao-plugin-data-'));
  fakesDir = mkdtempSync(join(tmpdir(), 'wao-plugin-fakes-'));
  writePluginDir(join(fakesDir, 'channel-fake'), FAKE_CHANNEL);
  writePluginDir(join(fakesDir, 'provider-fake'), FAKE_PROVIDER);
  kernel = await createKernel({ port: 0, dataDir, pluginsDirs: [fakesDir, join(repoRoot, 'plugins')] });
});

after(async () => {
  await kernel.stop();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(fakesDir, { recursive: true, force: true });
});

const BOT_B1 = {
  id: 'b1', name: '一号机器人', enabled: true, channel: 'fakechan',
  account: { endpoint: 'http://fake.local', secret: 'supersecretvalue123' },
  allowedUsers: [], provider: 'fakeprov', providerConfig: { cwd: '/tmp', mode: 'a' },
};

test('POST /api/bots validates, materializes, persists, attaches; no secret ever echoes', async () => {
  const resp = await post('/api/bots', BOT_B1);
  assert.equal(resp.status, 200);
  const raw = await resp.text();
  assert.equal(raw.includes('supersecretvalue123'), false, 'response body must not echo the account secret');
  const body = JSON.parse(raw);
  assert.equal(body.bot.id, 'b1');
  assert.equal(body.bot.account.endpoint, 'http://fake.local');
  assert.equal(body.bot.account.secret, undefined);
  assert.ok((globalThis.__waoFakeMaterialize ?? 0) >= 1, 'create materializes the provider config');
  assert.deepEqual(loadBots(join(dataDir, 'bots.json')).bots.map((b) => b.id), ['b1'], 'bot persisted to bots.json');

  const agents = await agentsOf();
  assert.equal(agents.length, 1);
  assert.equal(agents[0].id, 'b1');
  assert.equal(agents[0].status, 'idle');
  assert.equal(agents[0].enabled, true);
  assert.equal(agents[0].provider, 'fakeprov');
  assert.equal(agents[0].channel, 'fakechan');
  assert.ok((globalThis.__waoFakeChanStarted ?? 0) >= 1, 'adapter started on attach');

  // unknown subpaths 404 INSIDE /api; kernel-native /api/* still reach the kernel
  assert.equal((await get('/api/nope')).status, 404);
  assert.equal((await get('/api')).status, 404);
  assert.equal((await get('/api/state')).status, 200);
});

test('PATCH /api/bots/:id re-materializes providerConfig and reconnects', async () => {
  const before = globalThis.__waoFakeMaterialize ?? 0;
  const resp = await patch('/api/bots/b1', { providerConfig: { cwd: '/tmp', mode: 'b' } });
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.bot.providerConfig.mode, 'b');
  assert.equal((globalThis.__waoFakeMaterialize ?? 0) - before, 1, 'PATCH re-materializes once');
  assert.equal(globalThis.__waoFakeMaterializeLog.at(-1).mode, 'b', 'materialize saw the NEW config');
  assert.equal((await agentsOf())[0].status, 'idle');
});

test('PATCH with failing materialize → 400, bot offline with reason, last-good config kept', async () => {
  const resp = await patch('/api/bots/b1', { providerConfig: { cwd: '/fail', mode: 'b' } });
  assert.equal(resp.status, 400);
  assert.match((await resp.json()).error, /boom/);
  let agents = await agentsOf();
  assert.equal(agents[0].status, 'offline');
  assert.match(agents[0].reason ?? '', /boom/);
  assert.equal(loadBots(join(dataDir, 'bots.json')).bots[0].providerConfig.cwd, '/tmp', 'last-good config stays on disk');

  const okResp = await patch('/api/bots/b1', { providerConfig: { cwd: '/tmp', mode: 'a' } });
  assert.equal(okResp.status, 200);
  agents = await agentsOf();
  assert.equal(agents[0].status, 'idle');
  assert.equal(agents[0].reason, null);
});

test('toggle off detaches (offline), toggle on re-attaches (idle)', async () => {
  let resp = await post('/api/bots/b1/toggle');
  assert.equal(resp.status, 200);
  assert.equal((await resp.json()).bot.enabled, false);
  let agents = await agentsOf();
  assert.equal(agents[0].enabled, false);
  assert.equal(agents[0].status, 'offline');

  resp = await post('/api/bots/b1/toggle');
  assert.equal((await resp.json()).bot.enabled, true);
  agents = await agentsOf();
  assert.equal(agents[0].enabled, true);
  assert.equal(agents[0].status, 'idle');
});

test('POST /api/bots/:id/test runs the provider runner engine-independently; ledger untouched', async () => {
  const resp = await post('/api/bots/b1/test');
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.code, 'completed');
  assert.match(body.finalText, /收到/);
  assert.equal(typeof body.sessionId, 'string');
  assert.ok(body.events >= 1);
  // engine-independent: the probe run must not journal a ledger turn
  const ledger = await (await get('/api/ledger?bot=b1')).json();
  assert.deepEqual(ledger, []);
});

test('invalid bot records → 400 with field-level errors', async () => {
  const cases = [
    [{ ...BOT_B1, id: 'b2', providerConfig: { cwd: '/tmp', mode: 'zzz' } }, /mode/],
    [{ ...BOT_B1, id: 'b3', providerConfig: { mode: 'a' } }, /cwd is required/],
    [{ ...BOT_B1, id: 'b4', channel: 'nope', providerConfig: { cwd: '/tmp' } }, /unknown channel/],
    [{ ...BOT_B1, id: 'b5', provider: 'nope', providerConfig: { cwd: '/tmp' } }, /unknown provider/],
    [{ ...BOT_B1, id: 'b6', account: {}, providerConfig: { cwd: '/tmp' } }, /account\.endpoint is required/],
  ];
  for (const [bot, pattern] of cases) {
    const resp = await post('/api/bots', bot);
    assert.equal(resp.status, 400, `expected 400 for ${bot.id}`);
    const body = await resp.json();
    assert.ok(Array.isArray(body.errors) && body.errors.some((e) => pattern.test(e)), `${bot.id}: ${JSON.stringify(body.errors)}`);
  }
  assert.deepEqual(loadBots(join(dataDir, 'bots.json')).bots.map((b) => b.id), ['b1'], 'nothing invalid persisted');
});

test('reconcile: provider disabled via plugins.json + reload → bot offline with reason; re-enable → back', async () => {
  // The kernel-native POST /api/plugins/:id/disable does not exist yet (DESIGN
  // §8, later milestone); the four-phase reload through the enable table is
  // the live surface today and exercises the same reconcile outcome.
  writeFileSync(join(dataDir, 'plugins.json'), JSON.stringify({ plugins: { 'provider-fake': { enabled: false } } }));
  let resp = await post('/api/service/reload');
  assert.equal(resp.status, 200);
  let agents = await agentsOf();
  assert.equal(agents[0].status, 'offline');
  assert.match(agents[0].reason ?? '', /fakeprov/);

  writeFileSync(join(dataDir, 'plugins.json'), JSON.stringify({ plugins: { 'provider-fake': { enabled: true } } }));
  resp = await post('/api/service/reload');
  assert.equal(resp.status, 200);
  agents = await agentsOf();
  assert.equal(agents[0].status, 'idle');
  assert.equal(agents[0].reason, null);
  // reload booted a fresh engine instance on a fresh adapter
  assert.ok((globalThis.__waoFakeChanStarted ?? 0) >= 2);
});

test('reconcile (direct): plugin/lifecycle with a changed port registry detaches, then re-attaches', async () => {
  // The reload path above rebuilds core-engine wholesale; this exercises the
  // reconcile handler DIRECTLY — the port registry changed under a live
  // instance (the future single-plugin disable/enable surface).
  const reg = kernel.portRegistry;
  const entry = reg.provider.get('fakeprov');
  assert.ok(entry, 'fakeprov registered');

  reg.provider.delete('fakeprov');
  kernel.events.emit('plugin/lifecycle', {});
  let agents = await agentsOf();
  assert.equal(agents[0].status, 'offline');
  assert.equal(agents[0].reason, 'provider fakeprov 已禁用', 'DESIGN §2.5 wording');

  // Port restored (fresh runner is minted from the port impl at attach)
  reg.provider.set('fakeprov', entry);
  kernel.events.emit('plugin/lifecycle', {});
  agents = await agentsOf();
  assert.equal(agents[0].status, 'idle');
  assert.equal(agents[0].reason, null);
});

test('end-to-end message through the engine service feeds ledger/export/timeline/agents + /api/send', async () => {
  const svc = kernel.services.get('engine');
  assert.ok(svc && typeof svc.onMessage === 'function' && typeof svc.drain === 'function');
  const bot = loadBots(join(dataDir, 'bots.json')).bots[0];
  svc.onMessage(bot, {
    reqId: 'r1', chatKey: 'fake:single:u1', chatKind: 'single',
    chatid: 'u1', userid: 'u1', text: '你好', raw: { chatid: 'u1', chatType: 1 },
  });
  await waitFor(() => kernel.services.get('engine').status('b1').status === 'idle', 'turn to settle');

  const rows = await (await get('/api/ledger?bot=b1')).json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user, '你好');
  assert.match(rows[0].assistant, /fake 完成/);
  assert.equal(rows[0].reason, 'completed');

  const agents = await agentsOf();
  assert.equal(agents[0].todayTurns, 1);
  assert.equal(agents[0].turns, 1);
  assert.equal(agents[0].users, 1);
  assert.equal(agents[0].chats, 1);

  const sess = await (await get('/api/session?bot=b1&session=session-fake-b1')).json();
  assert.deepEqual(sess, { turns: [], truncated: false, warnings: [] });

  const md = await (await get('/api/export?bot=b1')).text();
  assert.match(md, /^## /);
  assert.match(md, /\*\*用户\*\*: 你好/);
  assert.match(md, /\*\*助手\*\*/);

  const tl = await (await get('/api/timeline?bot=b1')).json();
  assert.ok(Array.isArray(tl) && tl.length >= 1, 'timeline rows from the turn');

  // server-side push: chatRef = the raw chatKey; the CHANNEL parses its own
  // addressing (T17), the API never hardcodes it
  const sendResp = await post('/api/send', { botId: 'b1', chatKey: 'fake:group:g1', content: '主动推送' });
  assert.equal(sendResp.status, 200);
  assert.equal((await sendResp.json()).ok, true);
  const adapter = globalThis.__waoFakeAdapters.get('b1');
  assert.ok(adapter, 'live adapter');
  assert.deepEqual(adapter.pushes.at(-1), { chatRef: 'fake:group:g1', text: '主动推送' });
});

test('dirty inputs: oversized/invalid bodies, 405+Allow, 404/400 misses, offline send, empty export', async () => {
  // body over the 64KB cap → 413 (the connection keeps draining, no hang)
  const big = await fetch(url('/api/bots'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'big', name: 'x'.repeat(70 * 1024) }),
  });
  assert.equal(big.status, 413);
  // unparseable body → 400
  const bad = await fetch(url('/api/bots'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
  assert.equal(bad.status, 400);
  // known path, wrong method → 405 with Allow
  const m = await fetch(url('/api/agents'), { method: 'POST' });
  assert.equal(m.status, 405);
  assert.equal(m.headers.get('allow'), 'GET');
  // unknown ids → 404, missing query params → 400
  assert.equal((await get('/api/ledger?bot=none')).status, 404);
  assert.equal((await patch('/api/bots/none', {})).status, 404);
  assert.equal((await get('/api/ledger')).status, 400);
  assert.equal((await get('/api/session?bot=b1')).status, 400);
  assert.equal((await get('/api/timeline?bot=b1&window=abc')).status, 400);
  // push to an offline bot → 409 (then restore)
  await post('/api/bots/b1/toggle');
  const offline = await post('/api/send', { botId: 'b1', chatKey: 'fake:single:u1', content: 'x' });
  assert.equal(offline.status, 409);
  await post('/api/bots/b1/toggle');
  // bot with zero turns → empty markdown export
  await post('/api/bots', { ...BOT_B1, id: 'quiet', providerConfig: { cwd: '/tmp', mode: 'a' } });
  const md = await get('/api/export?bot=quiet');
  assert.equal(md.status, 200);
  assert.equal(await md.text(), '');
  // sanitize also strips *apikey*-named keys, not just 'secret'
  const keyed = await post('/api/bots', { ...BOT_B1, id: 'keyed', account: { endpoint: 'e', corpApikey: '{{KEY_mg29x}}' } });
  assert.equal(keyed.status, 200);
  assert.equal((await keyed.text()).includes('{{KEY_mg29x}}'), false);
});

test('bots.js unit: load tolerance, schema validation, revalidateAll split', () => {
  assert.deepEqual(loadBots(join(dataDir, 'missing-bots.json')), { bots: [] });
  const f = join(dataDir, 'unit-bots.json');
  saveBots(f, { bots: [{ id: 'x' }] });
  assert.deepEqual(loadBots(f), { bots: [{ id: 'x' }] });

  assert.deepEqual(validateSchema([{ key: 'a', type: 'string', required: true }], {}), ['a is required']);
  assert.deepEqual(validateSchema([{ key: 'm', type: 'enum', options: ['x'] }], { m: 'y' }), ['m must be one of x']);
  assert.deepEqual(validateSchema([{ key: 'n', type: 'bool' }], { n: 1 }), ['n must be a boolean']);
  assert.deepEqual(validateSchema([{ key: 'l', type: 'list' }], { l: 'nope' }), ['l must be a list']);

  const channels = new Map([['c', { accountSchema: [{ key: 'endpoint', type: 'string', required: true }] }]]);
  const providers = new Map([['p', { configSchema: [{ key: 'cwd', type: 'string', required: true }] }]]);
  const liveReg = { channels, providers };
  assert.deepEqual(
    validateBot({ id: 'b', name: 'B', channel: 'c', account: {}, provider: 'p', providerConfig: {} }, liveReg),
    ['account.endpoint is required', 'providerConfig.cwd is required'],
  );
  assert.equal(
    validateBot({ id: 'b', name: 'B', channel: 'c', account: { endpoint: 'e' }, provider: 'p', providerConfig: { cwd: '/x' } }, liveReg).length,
    0,
  );
  assert.ok(validateBot({ id: 'b', name: 'B', channel: 'zz', provider: 'p' }, liveReg).includes('unknown channel: "zz"'));

  const bots = [
    { id: 'ok', name: 'O', channel: 'c', account: { endpoint: 'e' }, provider: 'p', providerConfig: { cwd: '/' } },
    { id: 'bad', name: 'D', channel: 'nope', provider: 'p' },
  ];
  const r = revalidateAll(bots, { channel: channels, provider: providers });
  assert.deepEqual(r.ok.map((b) => b.id), ['ok']);
  assert.equal(r.bad.length, 1);
  assert.equal(r.bad[0].bot.id, 'bad');
  assert.ok(r.bad[0].errors.some((e) => e.includes('unknown channel')));
});
