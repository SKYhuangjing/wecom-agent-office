// W3 T1 API tests: the asset registry over the REAL surfaces (fake-kernel
// boot: real core-engine + repo plugins, fakechan/fakeprov ports). Covers
// CRUD + the §4 validation refusals over HTTP, position masking on the wire
// (mcp env/headers values → __MASKED__, secret literal never in any body),
// the __MASKED__ PATCH round-trip, bind/unbind endpoints with §2.3 chain
// receipts, bots.json as the binding store + the GET /api/bots summary echo
// (content-free), the eager PATCH fan-out {rematerialized, failed} receipt,
// DELETE's shared/exclusive split, the rematerialize endpoint, and the
// dual-source contract: companyOps (the exact object mcp-gateway consumes,
// fetched from the services container) enforces the §8.1 MCP write-face
// grading — origin:'mcp' stamping, 配发-asset update/delete refusal,
// exclusive-only Agent assets — while REST stays the operator face.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKernel } from '../../src/index.js';
import { loadBots } from '../../plugins/core-engine/bots.js';
import { loadAssets } from '../../plugins/core-engine/assets.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const FAKE_CHANNEL = `
export default {
  manifest: { id: 'channel-fake', name: 'Fake Channel', type: 'channel', version: '0.1.0', requires: { kernel: '^1' } },
  activate(ctx) {
    ctx.registerChannel('fakechan', {
      accountSchema: [{ key: 'endpoint', label: 'Endpoint', type: 'string', required: true }],
      capabilities: { stream: true, push: true, group: true, welcome: false, maxContentChars: 3500, minIntervalMs: 10, heartbeatMs: 60000, streamDeadlineMs: 600000 },
      createAdapter({ bot, engine }) {
        return {
          engine, start() {}, stop() {},
          status() { return { state: 'online', lastError: null }; },
          ack() {}, progress() {}, reply() {}, welcome() {}, push() {},
        };
      },
    });
  },
};`;

const FAKE_PROVIDER = `
export default {
  manifest: { id: 'provider-fake', name: 'Fake Provider', type: 'provider', version: '0.1.0', requires: { kernel: '^1' } },
  activate(ctx) {
    ctx.registerProvider('fakeprov', {
      configSchema: [{ key: 'cwd', label: 'Working directory', type: 'string', required: true }],
      validate(providerConfig) {
        return (typeof providerConfig?.cwd === 'string' && providerConfig?.cwd !== '') ? [] : ['cwd is required'];
      },
      materializeConfig() { return { changed: true }; },
      // W3 T2: a minimal REAL materializeAssets — one file-create per plan
      // entry under the bot cwd (jail-safe). The core materializer executes
      // it (atomic write, manifest, stale cleanup), so the API receipts here
      // carry real writes instead of T1's skipped:'not-equipped'.
      async materializeAssets(bot, plan) {
        const writes = [];
        for (const e of Array.isArray(plan) ? plan : []) {
          writes.push({
            kind: 'file-create',
            target: bot.providerConfig.cwd + '/.wao-fake/' + e.type + '--' + e.name + '.md',
            content: e.assetId + ':' + e.name + '\\n',
            for: e.assetId,
          });
        }
        return { writes, notes: [], entries: [] };
      },
      removeConfig() { return { removed: true }; },
      createRunner({ bot }) {
        return {
          async run({ prompt, sessionId, onEvent }) {
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

const ENV_SECRET = 'wao-env-secret-zq71';
const HEADER_SECRET = 'wao-header-secret-km03';

let kernel;
let dataDir;
let fakesDir;
const url = (p) => `http://127.0.0.1:${kernel.http.port}${p}`;
const req = (p, method = 'GET', body) => fetch(url(p), {
  method,
  headers: body === undefined ? undefined : { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const get = (p) => req(p);
const post = (p, body) => req(p, 'POST', body);
const patch = (p, body) => req(p, 'PATCH', body);
const del = (p) => req(p, 'DELETE');

const SKILL = { type: 'skill', name: 'wao-company', description: '公司操作技能', content: { name: 'wao-company', description: '何时触发', body: '# 公司技能正文 BODYMARK' } };
const PROMPT = { type: 'prompt', name: 'style-a', content: { text: '回答风格约束' } };
const MCP = {
  type: 'mcp',
  name: 'company-mcp',
  content: {
    servers: {
      company: { command: 'node', args: ['server.js'], env: { TOKEN: ENV_SECRET, NOTE: 'plain' } },
      docs: { type: 'http', url: 'https://example.com/mcp', headers: { 'X-K': HEADER_SECRET } },
    },
  },
};

const mkBot = (id) => ({
  id, name: `资产测试-${id}`, enabled: true, channel: 'fakechan',
  account: { endpoint: 'http://fake.local' }, allowedUsers: [],
  provider: 'fakeprov', providerConfig: { cwd: join(dataDir, 'cwds', id) },
});

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wao-assets-api-data-'));
  fakesDir = mkdtempSync(join(tmpdir(), 'wao-assets-api-fakes-'));
  writePluginDir(join(fakesDir, 'channel-fake'), FAKE_CHANNEL);
  writePluginDir(join(fakesDir, 'provider-fake'), FAKE_PROVIDER);
  kernel = await createKernel({ port: 0, dataDir, pluginsDirs: [fakesDir, join(repoRoot, 'plugins')] });
  for (const id of ['ab1', 'ab2']) {
    const r = await post('/api/bots', mkBot(id));
    assert.equal(r.status, 200, `boot bot ${id}`);
  }
});

after(async () => {
  await kernel.stop();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(fakesDir, { recursive: true, force: true });
});

test('POST /api/assets: creates with origin:operator, server-set fields refused, persisted to data/assets.json', async () => {
  const r = await post('/api/assets', SKILL);
  assert.equal(r.status, 200);
  const { asset } = await r.json();
  assert.match(asset.id, /^ast-[a-z0-9]+$/);
  assert.equal(asset.version, 1);
  assert.equal(asset.origin, 'operator');
  assert.ok(Number.isFinite(asset.createdAt));
  const onDisk = loadAssets(join(dataDir, 'assets.json'));
  assert.equal(onDisk.assets.length, 1);
  assert.equal(onDisk.assets[0].name, 'wao-company');
  // 0600 pin (§8.4): the registry lands owner-only, like bots.json
  assert.equal(statSync(join(dataDir, 'assets.json')).mode & 0o777, 0o600);

  for (const field of ['id', 'origin', 'version', 'createdAt', 'updatedAt']) {
    const bad = await post('/api/assets', { ...PROMPT, [field]: 'x' });
    assert.equal(bad.status, 400, `${field} is server-set`);
  }
  const notObject = await post('/api/assets', [SKILL]);
  assert.equal(notObject.status, 400);
});

test('POST /api/assets: (type,name) uniqueness over HTTP; validation refusals carry field-level errors', async () => {
  const dup = await post('/api/assets', SKILL);
  assert.equal(dup.status, 400);
  const body = await dup.json();
  assert.ok(body.errors.some((e) => /同名资产已存在/), JSON.stringify(body));
  // same NAME, different type → fine
  const r = await post('/api/assets', { type: 'prompt', name: 'wao-company', content: { text: 'x' } });
  assert.equal(r.status, 200);
  // red-line refusals over HTTP
  const sse = await post('/api/assets', { type: 'mcp', name: 'sse-x', content: { servers: { a: { type: 'sse', url: 'https://x.example/' } } } });
  assert.equal(sse.status, 400);
  assert.ok((await sse.json()).errors.some((e) => /v1 仅支持 stdio\/http 形态 MCP server/));
  const dotName = await post('/api/assets', { type: 'prompt', name: 'a.b', content: { text: 'x' } });
  assert.equal(dotName.status, 400);
  assert.ok((await dotName.json()).errors.some((e) => /禁点号/));
});

test('GET /api/assets + /api/assets/:id: position masking on the wire — secret literals never appear', async () => {
  const r = await post('/api/assets', MCP);
  assert.equal(r.status, 200);
  const { asset: mcpAsset } = await r.json();
  const listRaw = await (await get('/api/assets')).text();
  assert.ok(!listRaw.includes(ENV_SECRET) && !listRaw.includes(HEADER_SECRET), 'no mcp secret literal in the list body');
  const list = JSON.parse(listRaw);
  const row = list.assets.find((a) => a.id === mcpAsset.id);
  assert.equal(row.content.servers.company.env.TOKEN, '__MASKED__');
  assert.equal(row.content.servers.company.env.NOTE, '__MASKED__', 'position rule: every env value masks');
  assert.equal(row.content.servers.docs.headers['X-K'], '__MASKED__');
  assert.equal(row.content.servers.company.command, 'node');
  assert.equal(row.bindings, 0);
  const single = await (await get(`/api/assets/${mcpAsset.id}`)).json();
  assert.equal(single.asset.content.servers.company.env.TOKEN, '__MASKED__');
  assert.equal((await get('/api/assets/ast-nope')).status, 404);
  // stored value stays plaintext in the 0600 registry (§4.2 明文入库)
  const onDisk = loadAssets(join(dataDir, 'assets.json'));
  assert.equal(onDisk.assets.find((a) => a.id === mcpAsset.id).content.servers.company.env.TOKEN, ENV_SECRET);
  globalThis.__waoMcpAssetId = mcpAsset.id;
});

test('PATCH /api/assets/:id: version bump, __MASKED__ round-trip keeps stored values, new values replace', async () => {
  const { asset } = await (await post('/api/assets', { type: 'prompt', name: 'patch-me', content: { text: 'v1 文案' } })).json();
  const r = await patch(`/api/assets/${asset.id}`, { description: '改描述' });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.asset.version, 2, 'every PATCH bumps');
  assert.equal(body.asset.description, '改描述');
  assert.deepEqual(body.rematerialized, [], 'no bindings → empty fan-out');
  // mcp masked round-trip: echo back the masked values unchanged
  const p1 = await patch(`/api/assets/${globalThis.__waoMcpAssetId}`, {
    content: {
      servers: {
        company: { command: 'node', args: ['server.js'], env: { TOKEN: '__MASKED__', NOTE: '换过' } },
        docs: { type: 'http', url: 'https://example.com/mcp', headers: { 'X-K': '__MASKED__' } },
      },
    },
  });
  assert.equal(p1.status, 200);
  const disk = loadAssets(join(dataDir, 'assets.json')).assets.find((a) => a.id === globalThis.__waoMcpAssetId);
  assert.equal(disk.content.servers.company.env.TOKEN, ENV_SECRET, 'sentinel round-trip keeps the stored secret');
  assert.equal(disk.content.servers.company.env.NOTE, '换过', 'an explicit new value replaces');
  assert.equal(disk.content.servers.docs.headers['X-K'], HEADER_SECRET);
  // type immutable; server-set fields refused; validation refusals 400
  assert.equal((await patch(`/api/assets/${asset.id}`, { type: 'mcp' })).status, 400);
  assert.equal((await patch(`/api/assets/${asset.id}`, { version: 99 })).status, 400);
  const bad = await patch(`/api/assets/${asset.id}`, { name: 'Bad.Name' });
  assert.equal(bad.status, 400);
  assert.ok((await bad.json()).errors.some((e) => /name/));
});

test('bind/unbind endpoints: receipt shape, bots.json is the binding store, bot echo is a content-free summary', async () => {
  const list = await (await get('/api/assets')).json();
  const skillAsset = list.assets.find((a) => a.name === 'wao-company' && a.type === 'skill');
  const r = await post('/api/bots/ab1/assets', { assetId: skillAsset.id, mode: 'shared' });
  assert.equal(r.status, 200);
  const receipt = await r.json();
  assert.equal(receipt.ok, true);
  assert.equal(receipt.binding.assetId, skillAsset.id);
  assert.deepEqual(receipt.rematerialized, ['ab1']);
  assert.deepEqual(receipt.failed, []);
  // T2 real pipeline: the fake provider's materializeAssets yields one
  // file-create per plan entry, executed by the core materializer.
  assert.deepEqual(receipt.writes.map((w) => w.action), ['write']);
  assert.match(receipt.writes[0].path, /\.wao-fake\/skill--wao-company\.md$/);
  assert.equal(receipt.skipped, undefined);
  // binding stored in the BOT record (§2.1/§2.2)
  const bots = loadBots(join(dataDir, 'bots.json'));
  assert.deepEqual(bots.bots.find((b) => b.id === 'ab1').assets, [{ assetId: skillAsset.id, mode: 'shared' }]);
  // GET /api/bots echoes the summary, never the body content
  const botsRaw = await (await get('/api/bots')).text();
  assert.ok(!botsRaw.includes('BODYMARK'), 'skill body never echoes through a bot');
  const botEcho = JSON.parse(botsRaw).bots.find((b) => b.id === 'ab1');
  assert.deepEqual(botEcho.assets, [{ assetId: skillAsset.id, name: 'wao-company', type: 'skill', mode: 'shared', origin: 'operator' }]);
  // duplicate bind refused; direct write via PATCH /api/bots refused
  assert.equal((await post('/api/bots/ab1/assets', { assetId: skillAsset.id, mode: 'shared' })).status, 400);
  assert.equal((await patch('/api/bots/ab1', { assets: [] })).status, 400);
  assert.equal((await post('/api/bots', { ...mkBot('ab3'), assets: [{ assetId: 'x', mode: 'shared' }] })).status, 400);
  // unbind
  const u = await del(`/api/bots/ab1/assets/${skillAsset.id}`);
  assert.equal(u.status, 200);
  const ureceipt = await u.json();
  assert.equal(ureceipt.removed.mode, 'shared');
  assert.equal(ureceipt.removed.exclusiveContentLost, false);
  assert.equal(loadBots(join(dataDir, 'bots.json')).bots.find((b) => b.id === 'ab1').assets.length, 0);
  assert.equal((await del('/api/bots/ab1/assets/ast-nope')).status, 404);
  assert.equal((await post('/api/bots/nobody/assets', { assetId: skillAsset.id, mode: 'shared' })).status, 404);
  // unknown paths still 404 inside /api; known path wrong method → 405
  assert.equal((await get('/api/assets/x/y')).status, 404);
  assert.equal((await req('/api/assets', 'PUT', {})).status, 405);
});

test('eager PATCH fan-out: shared-bound bots rematerialize (noop receipts), exclusive stays frozen', async () => {
  const { asset } = await (await post('/api/assets', { type: 'prompt', name: 'fan-out', content: { text: 'T1' } })).json();
  await post('/api/bots/ab1/assets', { assetId: asset.id, mode: 'exclusive' });
  await post('/api/bots/ab2/assets', { assetId: asset.id, mode: 'shared' });
  const r = await patch(`/api/assets/${asset.id}`, { content: { text: 'T2' } });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body.rematerialized, ['ab2'], 'only the shared binding fans out');
  assert.deepEqual(body.failed, []);
  assert.ok(body.writes.some((w) => /prompt--fan-out\.md$/.test(w.path)), 'fan-out wrote the shared bot product');
  assert.equal(body.asset.version, 2);
  // exclusive snapshot is frozen at binding-time version (§6)
  const bots = loadBots(join(dataDir, 'bots.json'));
  const ex = bots.bots.find((b) => b.id === 'ab1').assets[0];
  assert.equal(ex.snapshot.text, 'T1');
  assert.equal(ex.snapshotVersion, 1);
  const echo = (await (await get('/api/bots')).json()).bots.find((b) => b.id === 'ab1');
  assert.equal(echo.assets[0].exclusiveBehind, 1, 'behind-version shows in the summary');
  globalThis.__waoFanOutAssetId = asset.id;
});

test('DELETE /api/assets/:id: shared bindings swept + rematerialized, exclusive copies survive on their snapshots', async () => {
  const id = globalThis.__waoFanOutAssetId;
  const r = await del(`/api/assets/${id}`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.removedBindings, 1);
  assert.equal(body.keptExclusive, 1);
  assert.deepEqual(body.rematerialized, ['ab2']);
  assert.match(body.note, /私发（exclusive）副本仍生效/);
  assert.equal((await get(`/api/assets/${id}`)).status, 404, 'asset gone from the registry');
  const bots = loadBots(join(dataDir, 'bots.json'));
  assert.equal(bots.bots.find((b) => b.id === 'ab2').assets.length, 0, 'shared binding removed');
  const kept = bots.bots.find((b) => b.id === 'ab1').assets[0];
  assert.equal(kept.mode, 'exclusive');
  assert.deepEqual(kept.snapshot, { text: 'T1' }, 'snapshot survives the source delete');
  const echo = (await (await get('/api/bots')).json()).bots.find((b) => b.id === 'ab1');
  assert.equal(echo.assets[0].sourceDeleted, true);
  assert.equal(echo.assets[0].name, 'fan-out', 'name resolves from the snapshot stamp');
  // cleanup: unbind the orphaned exclusive copy
  const u = await del(`/api/bots/ab1/assets/${id}`);
  assert.equal((await u.json()).removed.exclusiveContentLost, true);
});

test('POST /api/bots/:id/rematerialize-assets: deterministic retry endpoint (empty plan = cleanup-only)', async () => {
  const r = await post('/api/bots/ab1/rematerialize-assets', {});
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.botId, 'ab1');
  assert.deepEqual(body.writes, [], 'no bindings → nothing to write');
  assert.equal(body.skipped, undefined);
  assert.equal((await post('/api/bots/nobody/rematerialize-assets', {})).status, 404);
});

test('dual-source: companyOps enforces the §8.1 MCP write-face grading; REST stays the operator face', async () => {
  const ops = kernel.services.get('companyOps');
  assert.ok(ops != null && typeof ops.createAsset === 'function');

  // create via the MCP face → origin:'mcp'
  const { asset: agentAsset } = await ops.createAsset({ type: 'prompt', name: 'agent-made', content: { text: 'A1' } });
  assert.equal(agentAsset.origin, 'mcp');
  assert.equal(agentAsset.content.text, 'A1');
  const viaRest = await (await get(`/api/assets/${agentAsset.id}`)).json();
  assert.equal(viaRest.asset.origin, 'mcp', 'visible over REST with the origin badge');
  await assert.rejects(ops.createAsset({ type: 'prompt', name: 'x-o', origin: 'operator', content: { text: 'x' } }), /origin is set by the server/);

  // update/delete grading: operator (配发) assets are read-only on this face
  const opAsset = (await (await post('/api/assets', { type: 'prompt', name: 'operator-made', content: { text: 'O1' } })).json()).asset;
  const refused = await ops.updateAsset(opAsset.id, { content: { text: 'hack' } }).catch((e) => e);
  assert.equal(refused.status, 403);
  assert.match(refused.message, /共享（配发）资产的改动请走控制台\/REST/);
  const refusedDel = await ops.deleteAsset(opAsset.id).catch((e) => e);
  assert.equal(refusedDel.status, 403);
  assert.match(refusedDel.message, /共享（配发）资产的删除请走控制台\/REST/);
  // Agent-made assets ARE editable on this face; REST may edit them too
  const upd = await ops.updateAsset(agentAsset.id, { content: { text: 'A2' } });
  assert.equal(upd.asset.version, 2);
  assert.equal((await patch(`/api/assets/${agentAsset.id}`, { description: '运营者补描述' })).status, 200);

  // bind grading: Agent-made assets are exclusive-only — SAME op REST runs,
  // so the refusal is face-independent (§2.3 bottom row)
  await assert.rejects(
    ops.bindAsset('ab1', { assetId: agentAsset.id, mode: 'shared' }),
    /Agent 创建的资产仅可私发（exclusive）绑定/,
  );
  assert.equal((await post('/api/bots/ab1/assets', { assetId: agentAsset.id, mode: 'shared' })).status, 400);
  const bound = await ops.bindAsset('ab1', { assetId: agentAsset.id, mode: 'exclusive' });
  assert.equal(bound.ok, true);
  // unbind + rematerialize over the same shared op
  const un = await ops.unbindAsset('ab1', agentAsset.id);
  assert.equal(un.ok, true);
  const rem = await ops.rematerialize('ab1');
  assert.equal(rem.ok, true);
  assert.equal(rem.skipped, undefined);
  // cleanup the Agent-made asset through the graded delete
  const gone = await ops.deleteAsset(agentAsset.id);
  assert.equal(gone.ok, true);
  assert.equal(gone.removedBindings, 0);
});

test('agents-face asset warnings (W3 T1 review): memory on a shared cwd flags the roster row; a dedicated dir clears it', async () => {
  const { asset } = await (await post('/api/assets', { type: 'memory', name: 'mem-warn', content: { notes: ['n'] } })).json();
  // ab1 has no dedicated config dir → the roster row carries the short-form warning
  assert.equal((await post('/api/bots/ab1/assets', { assetId: asset.id, mode: 'shared' })).status, 200);
  const rows = (await (await get('/api/agents')).json()).agents;
  assert.deepEqual(rows.find((a) => a.id === 'ab1').assetWarnings, ['memory 共享 cwd：跨会话记忆可能被同目录其他会话互见']);
  assert.deepEqual(rows.find((a) => a.id === 'ab2').assetWarnings, [], 'unbound bot stays clean');
  // ab2 gains a dedicated dir (§7.3) → memoryWarning decision source says safe
  assert.equal((await patch('/api/bots/ab2', { providerConfig: { cwd: '/tmp', claudeConfigDir: '/tmp/ab2-claude' } })).status, 200);
  assert.equal((await post('/api/bots/ab2/assets', { assetId: asset.id, mode: 'shared' })).status, 200);
  const after = (await (await get('/api/agents')).json()).agents;
  assert.equal(after.find((a) => a.id === 'ab1').assetWarnings.length, 1);
  assert.deepEqual(after.find((a) => a.id === 'ab2').assetWarnings, [], 'dedicated config dir isolates memory (§7.3)');
  // unbind clears the flag
  assert.equal((await del(`/api/bots/ab1/assets/${asset.id}`)).status, 200);
  assert.deepEqual((await (await get('/api/agents')).json()).agents.find((a) => a.id === 'ab1').assetWarnings, []);
  assert.equal((await del(`/api/bots/ab2/assets/${asset.id}`)).status, 200);
});

test('closed content schema over HTTP: stray keys 400 with「unexpected key」copy (W3 T1 review)', async () => {
  const r = await post('/api/assets', { type: 'mcp', name: 'foreign-key', content: { servers: { a: { command: 'node', oops: 1 } } } });
  assert.equal(r.status, 400);
  assert.ok((await r.json()).errors.some((e) => /servers\.a\.oops：unexpected key（stdio 形态仅接受 command\/args\/env）/.test(e)));
  const content = await post('/api/assets', { type: 'prompt', name: 'stray-key', content: { text: 'x', lang: 'zh' } });
  assert.equal(content.status, 400);
  assert.ok((await content.json()).errors.some((e) => /content\.lang：unexpected key（prompt 仅接受 text）/.test(e)));
});
