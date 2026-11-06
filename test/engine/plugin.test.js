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
      // Restates the schema's required-cwd fact WITHOUT the record prefix —
      // deliberately the duplication shape validateBot must collapse.
      validate(providerConfig) {
        return (typeof providerConfig?.cwd === 'string' && providerConfig.cwd !== '') ? [] : ['cwd is required'];
      },
      materializeConfig(bot) {
        globalThis.__waoFakeMaterialize = (globalThis.__waoFakeMaterialize ?? 0) + 1;
        (globalThis.__waoFakeMaterializeLog ??= []).push({ id: bot.id, cwd: bot.providerConfig?.cwd, mode: bot.providerConfig?.mode });
        if (bot.providerConfig?.cwd === '/fail') throw new Error('materialize boom');
        return { changed: true };
      },
      removeConfig(bot) {
        globalThis.__waoFakeRemoveCfg = (globalThis.__waoFakeRemoveCfg ?? 0) + 1;
        (globalThis.__waoFakeRemoveCfgLog ??= []).push({ id: bot.id, cwd: bot.providerConfig?.cwd });
        if (bot.providerConfig?.cwd === '/rm-fail') throw new Error('removeConfig boom');
        return { removed: true };
      },
      createRunner({ bot }) {
        return {
          async run({ prompt, sessionId, signal, onEvent }) {
            // prompt reached the runner — recorded for the body.prompt tests
            (globalThis.__waoFakePrompts ??= []).push(prompt);
            if (signal?.aborted) {
              return { ok: false, code: 'aborted', finalText: '', aborted: true, sessionId: sessionId ?? null, reason: 'aborted before start', detail: {} };
            }
            if (bot.providerConfig?.cwd === '/hang') {
              // Park mid-run until aborted — mirrors a real provider whose
              // subprocess settles on abort (what drainBot relies on).
              await new Promise((resolve) => {
                signal?.addEventListener('abort', () => resolve(), { once: true });
              });
              return { ok: false, code: 'aborted', finalText: '', aborted: true, sessionId: sessionId ?? null, reason: 'aborted (hang)', detail: {} };
            }
            if (bot.providerConfig?.cwd === '/err') {
              return {
                ok: false, code: 'error', finalText: '', aborted: false,
                sessionId: 'session-err-' + bot.id,
                reason: { kind: 'exit', error: { message: 'kaboom' } },
                detail: { exitCode: 3, stderrTail: 'E'.repeat(600) },
              };
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
let logLines = [];
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
  // Capturing logger double (createKernel accepts `log`): lets the
  // allowedUsers attach-warn test assert the copy without stderr scraping.
  const capture = (prefix) => ({
    debug() {},
    info: (...a) => logLines.push((prefix ? `[${prefix}] ` : '') + a.join(' ')),
    warn: (...a) => logLines.push((prefix ? `[${prefix}] ` : '') + a.join(' ')),
    error: (...a) => logLines.push((prefix ? `[${prefix}] ` : '') + a.join(' ')),
    child: capture,
  });
  kernel = await createKernel({ port: 0, dataDir, pluginsDirs: [fakesDir, join(repoRoot, 'plugins')], log: capture(null) });
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

// M3 T2 UI data surface: the schema-driven editor reads /api/ports for the
// dynamic forms and /api/bots for the sanitized records.
test('GET /api/ports lists channels/providers with their schemas; GET /api/bots is secret-free', async () => {
  const ports = await (await get('/api/ports')).json();
  const chanIds = ports.channels.map((c) => c.id);
  assert.ok(chanIds.includes('fakechan') && chanIds.includes('wecom'), `fake + repo channels listed: ${chanIds}`);
  const fakeChan = ports.channels.find((c) => c.id === 'fakechan');
  assert.deepEqual(fakeChan.accountSchema.map((i) => `${i.key}:${i.type}`), ['endpoint:string', 'secret:password']);
  const provIds = ports.providers.map((p) => p.id);
  assert.ok(provIds.includes('fakeprov') && provIds.includes('dsh'), `fake + repo providers listed: ${provIds}`);
  assert.ok(ports.providers.every((p) => Array.isArray(p.configSchema)), 'every provider carries a configSchema array');

  const list = await (await get('/api/bots')).json();
  const b1 = list.bots.find((b) => b.id === 'b1');
  assert.equal(b1.account.endpoint, 'http://fake.local');
  assert.equal(b1.account.secret, undefined, 'GET /api/bots must not echo the account secret');
});

// The write-only password flow: the editor never receives the stored secret
// and omits untouched fields from the PATCHed block — both an ABSENT key and
// an explicit '' must keep the stored value, while POST (nothing stored yet)
// keeps the raw required-error semantics.
test('PATCH blank/absent password keeps the stored secret; POST stays strict', async () => {
  // absent key (what the UI sends: serializeSchema omits blank text fields)
  const resp = await patch('/api/bots/b1', { account: { endpoint: 'http://v2.local' } });
  assert.equal(resp.status, 200);
  const onDisk = loadBots(join(dataDir, 'bots.json')).bots.find((b) => b.id === 'b1');
  assert.equal(onDisk.account.endpoint, 'http://v2.local');
  assert.equal(onDisk.account.secret, 'supersecretvalue123', 'absent password on PATCH = keep the stored one');
  // explicit '' — the curl shape gets the same rule
  const resp2 = await patch('/api/bots/b1', { account: { endpoint: 'http://v2.local', secret: '' } });
  assert.equal(resp2.status, 200);
  assert.equal(loadBots(join(dataDir, 'bots.json')).bots.find((b) => b.id === 'b1').account.secret,
    'supersecretvalue123', 'blank password on PATCH = keep the stored one');
  assert.equal((await (await get('/api/bots')).json()).bots.find((b) => b.id === 'b1').account.endpoint, 'http://v2.local');

  // enabled:false + a required blank password → 400 BEFORE persistence or attach
  const bad = await post('/api/bots', {
    id: 'wecom-x', name: 'X', enabled: false, channel: 'wecom',
    account: { botId: '1', secret: '' }, provider: 'dsh', providerConfig: { cwd: '/tmp' },
  });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /account\.secret is required/);
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

test('POST /api/bots/:id/test failure answers WHY inline: reason, truncated detail, provider errorText', async () => {
  assert.equal((await post('/api/bots', { ...BOT_B1, id: 'errbot', providerConfig: { cwd: '/err', mode: 'a' } })).status, 200);
  const resp = await post('/api/bots/errbot/test');
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.code, 'error');
  assert.deepEqual(body.reason, { kind: 'exit', error: { message: 'kaboom' } });
  assert.equal(body.detail.exitCode, 3);
  assert.equal(body.detail.stderrTail.length, 500, 'stderrTail truncated to 500 chars (600 sent)');
  assert.equal(body.errorText, 'fake error: error', 'human line via providerPort.describeError(result)');
  // completed responses stay lean: no diagnostics keys on the success path
  const okBody = await (await post('/api/bots/b1/test')).json();
  assert.equal(okBody.reason, undefined);
  assert.equal(okBody.detail, undefined);
  assert.equal(okBody.errorText, undefined);
  // cleanup: later tests assert the exact bots.json registry contents
  assert.equal((await fetch(url('/api/bots/errbot'), { method: 'DELETE' })).status, 200);
});

test('POST /api/bots/:id/test optional body.sessionId resumes that session; junk shapes 400', async () => {
  // The fake runner echoes the sessionId it received — the response proves the
  // passthrough without a real CLI (the real-CLI leg is switch-matrix.realtest).
  const resp = await post('/api/bots/b1/test', { sessionId: 'probe-resume-sid' });
  assert.equal(resp.status, 200);
  const body = JSON.parse(await resp.text());
  assert.equal(body.code, 'completed');
  assert.equal(body.sessionId, 'probe-resume-sid', 'the probe resumed the caller-supplied session');
  // absent / null body.sessionId keeps the fresh-probe contract (a NEW session)
  const fresh = await (await post('/api/bots/b1/test', {})).json();
  assert.equal(fresh.sessionId, 'session-fake-b1');
  const nullSid = await (await post('/api/bots/b1/test', { sessionId: null })).json();
  assert.equal(nullSid.sessionId, 'session-fake-b1');
  // untrusted-input shapes are rejected, never silently coerced
  assert.equal((await post('/api/bots/b1/test', { sessionId: '' })).status, 400);
  assert.equal((await post('/api/bots/b1/test', { sessionId: 42 })).status, 400);
  assert.equal((await post('/api/bots/b1/test', { sessionId: ['x'] })).status, 400);
});

test('POST /api/bots/:id/test optional body.prompt reaches the runner; junk 400; empty string → default', async () => {
  // The fake runner RECORDS every prompt it received (globalThis log, same
  // shape as the materialize/removeConfig recordings) — the assertion reads
  // the recording itself, not only the echoed finalText.
  const lastPrompt = async () => globalThis.__waoFakePrompts?.at(-1);
  const resp = await post('/api/bots/b1/test', { prompt: '自定义探针问题：1+1=?' });
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.code, 'completed');
  assert.equal(await lastPrompt(), '自定义探针问题：1+1=?', 'custom prompt reached the runner');
  assert.equal(body.finalText, 'fake 完成：自定义探针问题：1+1=?');
  // absent / null / '' fall back to the default probe prompt (unlike
  // sessionId, an empty question is "not given", not junk)
  await post('/api/bots/b1/test', {});
  assert.equal(await lastPrompt(), '回复：收到');
  await post('/api/bots/b1/test', { prompt: null });
  assert.equal(await lastPrompt(), '回复：收到');
  await post('/api/bots/b1/test', { prompt: '' });
  assert.equal(await lastPrompt(), '回复：收到');
  // untrusted-input shapes and the 2000-char cap are rejected, never coerced
  assert.equal((await post('/api/bots/b1/test', { prompt: 42 })).status, 400);
  assert.equal((await post('/api/bots/b1/test', { prompt: ['x'] })).status, 400);
  assert.equal((await post('/api/bots/b1/test', { prompt: { q: 1 } })).status, 400);
  assert.equal((await post('/api/bots/b1/test', { prompt: 'x'.repeat(2000) })).status, 200);
  assert.equal((await post('/api/bots/b1/test', { prompt: 'x'.repeat(2001) })).status, 400);
  // sessionId and prompt compose on one probe
  const both = await (await post('/api/bots/b1/test', { sessionId: 'probe-both-sid', prompt: '第二个问题' })).json();
  assert.equal(both.sessionId, 'probe-both-sid');
  assert.equal(await lastPrompt(), '第二个问题');
});

test('DELETE /api/bots/:id detaches, removeConfig cleans materialized files, persists; failure is non-fatal', async () => {
  assert.equal((await post('/api/bots', { ...BOT_B1, id: 'bye', providerConfig: { cwd: '/tmp/bye', mode: 'a' } })).status, 200);
  assert.equal((await post('/api/bots', { ...BOT_B1, id: 'boom', providerConfig: { cwd: '/rm-fail', mode: 'a' } })).status, 200);
  const before = globalThis.__waoFakeRemoveCfg ?? 0;

  // A throwing removeConfig must NOT block the delete (best-effort cleanup).
  assert.equal((await fetch(url('/api/bots/boom'), { method: 'DELETE' })).status, 200);
  assert.deepEqual(loadBots(join(dataDir, 'bots.json')).bots.map((b) => b.id), ['b1', 'bye']);

  assert.equal((await fetch(url('/api/bots/bye'), { method: 'DELETE' })).status, 200);
  assert.equal((globalThis.__waoFakeRemoveCfg ?? 0) - before, 2, 'DELETE calls provider removeConfig');
  assert.equal(globalThis.__waoFakeRemoveCfgLog.at(-1).cwd, '/tmp/bye', 'removeConfig saw the deleted bot');
  assert.deepEqual(loadBots(join(dataDir, 'bots.json')).bots.map((b) => b.id), ['b1'], 'both bots gone from bots.json');
  assert.ok(!(await agentsOf()).some((a) => a.id === 'bye' || a.id === 'boom'), 'gone from /api/agents');
  assert.equal((await fetch(url('/api/bots/bye'), { method: 'DELETE' })).status, 404, 'second delete 404s');
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
  // Deduped copy (P2 review): schema ('providerConfig.cwd is required') and the
  // provider validate restatement ('cwd is required') collapse to ONE message,
  // and `error` is exactly the joined errors — no secondhand prefixing.
  const resp = await post('/api/bots', { ...BOT_B1, id: 'b3', providerConfig: { mode: 'a' } });
  const body = await resp.json();
  assert.equal(body.errors.filter((e) => /cwd/.test(e)).length, 1, `exactly one cwd message: ${JSON.stringify(body.errors)}`);
  assert.deepEqual(body.errors, ['providerConfig.cwd is required'], 'the prefixed (more specific) copy wins');
  assert.equal(body.error, body.errors.join('; '));
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

  // provider validate restating a schema-flagged field minus the record prefix
  // → collapse: the prefixed (more specific) schema message is kept alone
  const providersV = new Map([['pv', {
    configSchema: [{ key: 'cwd', type: 'string', required: true }],
    validate: (pc) => (typeof pc?.cwd === 'string' && pc.cwd !== '' ? [] : ['cwd is required']),
  }]]);
  assert.deepEqual(
    validateBot({ id: 'b', name: 'B', channel: 'c', account: { endpoint: 'e' }, provider: 'pv', providerConfig: {} }, { channels, providers: providersV }),
    ['providerConfig.cwd is required'],
  );

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

// --- allowedUsers (DESIGN §6 step 1, M3 gate) — through the real assembly -----

test('allowedUsers: non-empty admit-list drops strangers silently; empty list allows all (warned at attach)', async () => {
  // Empty list = allow-all, and attach says so once per bot (operator visibility).
  assert.ok(
    logLines.some((l) => l.includes('accepts messages from ANY user')),
    `attach warns for allow-all bots: ${JSON.stringify(logLines.slice(-20))}`,
  );

  assert.equal((await post('/api/bots', { ...BOT_B1, id: 'allowbot', allowedUsers: ['u1'] })).status, 200);
  await waitFor(() => globalThis.__waoFakeAdapters.get('allowbot') != null, 'allowbot attached');
  const svc = kernel.services.get('engine');
  const bot = loadBots(join(dataDir, 'bots.json')).bots.find((b) => b.id === 'allowbot');

  // Stranger: silently dropped (a reply would confirm the bot exists) — no
  // ledger row, no runner work, engine stays idle.
  svc.onMessage(bot, { reqId: 'au-stranger', chatKey: 'fake:single:u2', chatKind: 'single', chatid: 'u2', userid: 'u2', text: '陌生人', raw: {} });
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(await (await get('/api/ledger?bot=allowbot')).json(), [], 'stranger message never ran');
  assert.equal(svc.status('allowbot').status, 'idle');
  assert.ok(logLines.some((l) => l.includes('reject message from non-allowed user') && l.includes('u2')));

  // Member: full turn through the chain.
  svc.onMessage(bot, { reqId: 'au-member', chatKey: 'fake:single:u1', chatKind: 'single', chatid: 'u1', userid: 'u1', text: '自己人', raw: {} });
  await waitFor(async () => (await (await get('/api/ledger?bot=allowbot')).json()).length === 1, 'member turn recorded');
  const rows = await (await get('/api/ledger?bot=allowbot')).json();
  assert.equal(rows[0].user, '自己人');
  assert.equal(rows[0].reason, 'completed');

  assert.equal((await fetch(url('/api/bots/allowbot'), { method: 'DELETE' })).status, 200);
});

// --- per-bot drain on the CRUD surface (DESIGN §8 校验→materialize→串行链 drain→重连)

test('mid-run PATCH: the in-flight turn settles with its final frame BEFORE the adapter swap; ledger row intact', async () => {
  assert.equal((await post('/api/bots', { ...BOT_B1, id: 'hangbot', providerConfig: { cwd: '/hang', mode: 'a' } })).status, 200);
  await waitFor(() => globalThis.__waoFakeAdapters.get('hangbot') != null, 'hangbot attached');
  const svc = kernel.services.get('engine');
  const bot = loadBots(join(dataDir, 'bots.json')).bots.find((b) => b.id === 'hangbot');

  // Observe the outbound surface and the adapter's death in one ordered log.
  const marks = [];
  const adapter = globalThis.__waoFakeAdapters.get('hangbot');
  const origProgress = adapter.progress.bind(adapter);
  adapter.progress = (reqId, streamId, text, finish) => {
    marks.push(finish ? `final:${text}` : `progress:${text}`);
    return origProgress(reqId, streamId, text, finish);
  };
  const origStop = adapter.stop.bind(adapter);
  adapter.stop = () => { marks.push('adapter-stop'); return origStop(); };

  svc.onMessage(bot, { reqId: 'hp-1', chatKey: 'fake:group:G1', chatKind: 'group', chatid: 'G1', userid: 'u1', text: '长任务', raw: {} });
  await waitFor(() => svc.status('hangbot').status === 'working', 'turn running (parked in /hang)');

  const resp = await patch('/api/bots/hangbot', { providerConfig: { cwd: '/tmp', mode: 'b' } });
  assert.equal(resp.status, 200, await resp.text());

  // The abort landed as MAINTENANCE copy (per-bot drain), not the
  // "interrupted by a new message" banner — and it went out before the swap.
  const finalIdx = marks.findIndex((m) => m.startsWith('final:'));
  assert.ok(finalIdx !== -1, `an aborted final frame was delivered: ${JSON.stringify(marks)}`);
  assert.ok(marks[finalIdx].includes('服务维护'), `maintenance copy on a per-bot drain: ${marks[finalIdx]}`);
  assert.ok(marks.indexOf('adapter-stop') > finalIdx, `adapter swapped only after the final frame: ${JSON.stringify(marks)}`);

  const rows = await (await get('/api/ledger?bot=hangbot')).json();
  assert.equal(rows.length, 1, 'the interrupted turn is booked');
  assert.equal(rows[0].user, '长任务');
  assert.equal(rows[0].reason, 'interrupted');
  assert.equal(svc.status('hangbot').status, 'idle');

  assert.equal((await fetch(url('/api/bots/hangbot'), { method: 'DELETE' })).status, 200);
});

// Re-review pin: per-bot drain REFUSALS must be answered by the CRUD swap —
// drainBot records them, but the engine's global path never sends them (and a
// later global drain window resets the list). The queued-never-acked message
// must hear 「已入队任务：直接回拒绝终帧」, and OTHER bots' refusals must stay
// for their own owners.
test('per-bot drain answers its swept queued messages before the swap; other bots\' refusals are not consumed', async () => {
  const REFUSAL = '⚠️ 服务维护，未处理，请重发';
  const mk = (id) => ({ ...BOT_B1, id, providerConfig: { cwd: '/hang', mode: 'a' } });
  assert.equal((await post('/api/bots', mk('qbot'))).status, 200);
  assert.equal((await post('/api/bots', mk('obot'))).status, 200);
  await waitFor(() => globalThis.__waoFakeAdapters.get('qbot') != null && globalThis.__waoFakeAdapters.get('obot') != null, 'both attached');
  const svc = kernel.services.get('engine');
  const doc = () => loadBots(join(dataDir, 'bots.json')).bots;

  // Gate each bot's adapter: a first turn parks inside the (gated) ack, so a
  // second message on the same chatKey preempts-merges into pending — the
  // exact never-acked population a drain sweeps into drainRefusals.
  const gate = (id) => {
    const a = globalThis.__waoFakeAdapters.get(id);
    const g = { marks: [], open: null };
    const parked = new Promise((r) => { g.open = r; });
    a.ack = async () => { g.marks.push('ack-park'); await parked; };
    a.reply = async (reqId, text) => { g.marks.push(`reply:${reqId}:${text}`); };
    a.stop = () => { g.marks.push('adapter-stop'); };
    return g;
  };
  const gq = gate('qbot');
  const go = gate('obot');
  const send = (bot, chat, reqId, text) =>
    svc.onMessage(bot, { reqId, chatKey: chat, chatKind: 'group', chatid: chat.split(':')[2], userid: 'u1', text, raw: {} });

  send(doc().find((b) => b.id === 'qbot'), 'fake:group:Q', 'q1', '第一条');
  await waitFor(() => gq.marks.includes('ack-park'), 'q1 parked in ack');
  send(doc().find((b) => b.id === 'qbot'), 'fake:group:Q', 'q2', '排队的'); // preempt: q2 merged into pending
  send(doc().find((b) => b.id === 'obot'), 'fake:group:O', 'o1', '另一bot第一条');
  await waitFor(() => go.marks.includes('ack-park'), 'o1 parked in ack');
  send(doc().find((b) => b.id === 'obot'), 'fake:group:O', 'o2', '另一bot排队');

  // Fire both PATCHes without awaiting. saveBots runs in the SAME synchronous
  // block as drainBot's pending sweep, so a persisted patch mode proves the
  // sweep already happened — the gates then hold both chains parked.
  const patchQ = patch('/api/bots/qbot', { providerConfig: { cwd: '/tmp', mode: 'b' } });
  await waitFor(() => doc().find((b) => b.id === 'qbot')?.providerConfig?.mode === 'b', 'qbot drain swept its pending');
  const patchO = patch('/api/bots/obot', { providerConfig: { cwd: '/tmp', mode: 'b' } });
  await waitFor(() => doc().find((b) => b.id === 'obot')?.providerConfig?.mode === 'b', 'obot drain swept its pending');

  try {
    gq.open(); // q1 settles (pre-runner abort), qbot's drain completes and answers
    assert.equal((await patchQ).status, 200);
    assert.ok(gq.marks.includes(`reply:q2:${REFUSAL}`), `the queued message got the refusal copy: ${JSON.stringify(gq.marks)}`);
    assert.ok(gq.marks.indexOf(`reply:q2:${REFUSAL}`) < gq.marks.indexOf('adapter-stop'), 'answered BEFORE the old adapter died');
    assert.ok(!gq.marks.some((m) => m.startsWith('reply:o2')), "qbot's answering never touches another bot's refusal");
    assert.ok(!go.marks.some((m) => m.startsWith('reply:')), `obot's refusal left unconsumed so far: ${JSON.stringify(go.marks)}`);

    go.open(); // obot's own swap answers its own refusal
    assert.equal((await patchO).status, 200);
    assert.ok(go.marks.includes(`reply:o2:${REFUSAL}`), `obot's queued message answered by obot's own swap: ${JSON.stringify(go.marks)}`);

    // Only the two interrupted first-turns are booked; the queued messages
    // never ran (pending, never acked) and never reached the runner.
    const qrows = await (await get('/api/ledger?bot=qbot')).json();
    assert.deepEqual(qrows.map((r) => [r.user, r.reason]), [['第一条', 'interrupted']]);
  } finally {
    gq.open(); go.open(); // a failed assert must not leave turns parked on the gates
    await Promise.allSettled([patchQ, patchO]); // nor floating request promises
  }

  assert.equal((await fetch(url('/api/bots/qbot'), { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(url('/api/bots/obot'), { method: 'DELETE' })).status, 200);
});
