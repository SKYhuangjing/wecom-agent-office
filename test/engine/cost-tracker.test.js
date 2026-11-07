// cost-tracker plugin tests. Three layers:
//   1. tracker.js unit: the footer transform + the per-bot binding gate,
//   2. binding resolution: exclusive snapshots are self-describing, shared
//      bindings resolve through the asset registry,
//   3. full-kernel integration (fake provider/channel + the REAL plugins
//      dir): the plugin auto-registers its tool-type asset, bind/unbind via
//      the EXISTING asset API is the per-bot toggle, and the final WeCom
//      reply — and only the final reply — carries the token footer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKernel } from '../../src/index.js';
import { createTracker, isBoundToCostTracker } from '../../plugins/cost-tracker/tracker.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// --- 1: the footer transform ——————————————————————————————————————————————

test('tracker: bound bot + usage ctx → exact footer line appended', () => {
  const t = createTracker({ isBound: () => true });
  const out = t.onOutbound('答案', {
    usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 60, totalTokens: 200 },
    bot: {},
  });
  assert.equal(out, '答案\n\n---\n📊 Token：输入 100 · 输出 40');
});

test('tracker: without usage ctx (or without ctx) the text is unchanged', () => {
  const t = createTracker({ isBound: () => true });
  assert.equal(t.onOutbound('答案', { bot: {} }), '答案');
  assert.equal(t.onOutbound('答案', null), '答案');
  assert.equal(t.onOutbound('答案', { usage: null }), '答案');
});

test('tracker: unbound bot → text unchanged (the toggle is off)', () => {
  const t = createTracker({ isBound: () => false });
  const ctx = { usage: { inputTokens: 1, outputTokens: 2 }, bot: { id: 'x' } };
  assert.equal(t.onOutbound('答案', ctx), '答案');
});

test('tracker: default isBound is off — a bare createTracker never touches text', () => {
  const t = createTracker();
  assert.equal(t.onOutbound('答案', { usage: { inputTokens: 1, outputTokens: 2 }, bot: {} }), '答案');
});

test('tracker: counts format 999→raw, ≥1000→k with one decimal; missing fields read as 0', () => {
  const t = createTracker({ isBound: () => true });
  const line = (i, o) => t.onOutbound('', { usage: { inputTokens: i, outputTokens: o }, bot: {} });
  assert.equal(line(999, 1), '\n\n---\n📊 Token：输入 999 · 输出 1');
  assert.equal(line(1000, 12345), '\n\n---\n📊 Token：输入 1.0k · 输出 12.3k');
  assert.equal(line(undefined, undefined), '\n\n---\n📊 Token：输入 0 · 输出 0');
});

// --- 2: binding resolution ——————————————————————————————————————————————————

test('binding: exclusive snapshot binding is self-describing (no registry needed)', () => {
  const bot = {
    assets: [{ assetId: 'ast-x', mode: 'exclusive', snapshot: { kind: 'cost-tracker' }, snapshotType: 'tool', snapshotName: 'cost-tracker' }],
  };
  assert.equal(isBoundToCostTracker(bot), true);
  assert.equal(isBoundToCostTracker({ assets: [] }), false);
  assert.equal(isBoundToCostTracker(null), false);
});

test('binding: shared binding resolves through the injected registry lookup', () => {
  const registry = new Map([
    ['ast-ct', { id: 'ast-ct', type: 'tool', name: 'cost-tracker', content: { kind: 'cost-tracker' } }],
    ['ast-rg', { id: 'ast-rg', type: 'tool', name: 'ripgrep', content: { kind: 'ripgrep' } }],
    ['ast-sk', { id: 'ast-sk', type: 'skill', name: 'cost-tracker', content: { name: 'cost-tracker' } }],
  ]);
  const resolve = (id) => registry.get(id) ?? null;
  assert.equal(isBoundToCostTracker({ assets: [{ assetId: 'ast-ct', mode: 'shared' }] }, resolve), true);
  assert.equal(isBoundToCostTracker({ assets: [{ assetId: 'ast-rg', mode: 'shared' }] }, resolve), false, 'other tool kinds do not count');
  assert.equal(isBoundToCostTracker({ assets: [{ assetId: 'ast-sk', mode: 'shared' }] }, resolve), false, 'name alone on a non-tool asset does not count');
  assert.equal(isBoundToCostTracker({ assets: [{ assetId: 'ast-gone', mode: 'shared' }] }, resolve), false, 'dangling binding is off');
});

// --- 3: full-kernel integration ————————————————————————————————————————————

// Fake channel: records every outbound frame so the footer's placement
// (final reply only, never progress) can be asserted verbatim.
const FAKE_CHANNEL = `
export default {
  manifest: { id: 'channel-fake', name: 'Fake Channel', type: 'channel', version: '0.1.0', requires: { kernel: '^1' } },
  activate(ctx) {
    ctx.registerChannel('fakechan', {
      accountSchema: [{ key: 'endpoint', label: 'Endpoint', type: 'string', required: true }],
      capabilities: { stream: true, push: true, group: true, welcome: false, maxContentChars: 3500, minIntervalMs: 10, heartbeatMs: 60000, streamDeadlineMs: 600000 },
      createAdapter({ bot }) {
        const adapter = {
          frames: [],
          start() {}, stop() {},
          ack(reqId, streamId, text) { adapter.frames.push({ method: 'ack', text, finish: false }); },
          progress(reqId, streamId, text, finish) { adapter.frames.push({ method: 'progress', text, finish: !!finish }); },
          reply(reqId, text) { adapter.frames.push({ method: 'reply', text, finish: true }); },
          push(chatRef, text) { adapter.frames.push({ method: 'push', text, finish: true }); },
        };
        (globalThis.__ctAdapters ??= new Map()).set(bot.id, adapter);
        return adapter;
      },
    });
  },
};`;

// Fake provider: emits a claude-dialect usage event mid-run, completes with a
// codex-style reason.usage, and materializes the cost-tracker tool asset as
// pure metadata (writes:[], tools:[{kind:'cost-tracker',state:'armed'}]).
const FAKE_PROVIDER = `
export default {
  manifest: { id: 'provider-fake', name: 'Fake Provider', type: 'provider', version: '0.1.0', requires: { kernel: '^1' } },
  activate(ctx) {
    ctx.registerProvider('fakeprov', {
      configSchema: [{ key: 'cwd', label: 'Working directory', type: 'string', required: true }],
      validate(pc) { return (typeof pc?.cwd === 'string' && pc.cwd !== '') ? [] : ['cwd is required']; },
      materializeConfig() { return { changed: false }; },
      removeConfig() { return { removed: false }; },
      async materializeAssets(bot, plan) {
        const tools = (plan ?? [])
          .filter((e) => e?.type === 'tool' && e?.content?.kind === 'cost-tracker')
          .map((e) => ({ assetId: e.assetId, kind: 'cost-tracker', state: 'armed' }));
        return { writes: [], notes: [], entries: [], tools };
      },
      createRunner({ bot }) {
        return {
          async run({ prompt, sessionId, signal, onEvent }) {
            if (signal?.aborted) return { ok: false, code: 'aborted', finalText: '', aborted: true, sessionId: null, reason: 'aborted before start', detail: {} };
            onEvent?.({ type: 'text', text: '开始' });
            onEvent?.({ type: 'text', text: '好的', usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 60 } });
            return {
              ok: true, code: 'completed', finalText: 'fake 完成：' + prompt, aborted: false,
              sessionId: sessionId || 'session-fake-' + bot.id,
              reason: { kind: 'completed', usage: { inputTokens: 100, outputTokens: 40 } }, detail: {},
            };
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
const post = (p, body) => fetch(url(p), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const del = (p) => fetch(url(p), { method: 'DELETE' });
const get = (p) => fetch(url(p));
const waitFor = async (predicate, label, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

const FOOTER = '\n\n---\n📊 Token：输入 100 · 输出 40';

// One inbound message → the adapter's final frame text.
const driveTurn = async (bot, text) => {
  const svc = kernel.services.get('engine');
  svc.onMessage(bot, {
    reqId: `req-${text}-${Math.random().toString(36).slice(2, 8)}`,
    chatKey: 'fake:group:g1', chatKind: 'group', chatid: 'g1', userid: 'u1', text, raw: {},
  });
  await waitFor(() => kernel.services.get('engine').status(bot.id).status === 'idle', 'turn to settle');
  const adapter = globalThis.__ctAdapters.get(bot.id);
  const final = adapter.frames.filter((f) => f.finish).at(-1);
  const nonFinal = adapter.frames.filter((f) => !f.finish);
  return { final, nonFinal, frames: adapter.frames };
};

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wao-ct-data-'));
  fakesDir = mkdtempSync(join(tmpdir(), 'wao-ct-fakes-'));
  writePluginDir(join(fakesDir, 'channel-fake'), FAKE_CHANNEL);
  writePluginDir(join(fakesDir, 'provider-fake'), FAKE_PROVIDER);
  kernel = await createKernel({ port: 0, dataDir, pluginsDirs: [fakesDir, join(repoRoot, 'plugins')] });
});

after(async () => {
  await kernel.stop();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(fakesDir, { recursive: true, force: true });
});

test('plugin activation auto-registers the tool-type asset into data/assets.json', async () => {
  const doc = JSON.parse(readFileSync(join(dataDir, 'assets.json'), 'utf8'));
  const assets = doc.assets.filter((a) => a?.name === 'cost-tracker');
  assert.equal(assets.length, 1, 'exactly one cost-tracker asset, not duplicated');
  assert.equal(assets[0].type, 'tool');
  assert.equal(assets[0].content.kind, 'cost-tracker');
  assert.equal(assets[0].origin, 'plugin');
  // visible through the REAL API too (core-engine loaded the registry after
  // the plugin's activation-phase write)
  const listed = await (await get('/api/assets')).json();
  const api = listed.assets.find((a) => a.name === 'cost-tracker');
  assert.ok(api, 'asset listed via GET /api/assets');
  assert.equal(api.content.kind, 'cost-tracker');
});

test('bot without binding gets NO footer; bind → footer on the final reply only; unbind → gone', async () => {
  // create a bot over the real API
  const resp = await post('/api/bots', {
    id: 'b1', name: '一号机器人', enabled: true, channel: 'fakechan',
    account: { endpoint: 'http://fake.local' }, allowedUsers: [],
    provider: 'fakeprov', providerConfig: { cwd: '/tmp' },
  });
  assert.equal(resp.status, 200);
  const bot = (await (await get('/api/bots')).json()).bots[0];

  // 1. unbound: final reply has no footer
  let turn = await driveTurn(bot, '没绑定');
  assert.equal(turn.final.text, 'fake 完成：没绑定');
  assert.ok(!turn.final.text.includes('📊'), 'no token footer while unbound');

  // 2. bind the cost-tracker asset (shared mode → registry resolution path)
  const { assets } = await (await get('/api/assets')).json();
  const assetId = assets.find((a) => a.name === 'cost-tracker').id;
  const bindResp = await post(`/api/bots/b1/assets`, { assetId, mode: 'shared' });
  assert.equal(bindResp.status, 200, await bindResp.text());

  // re-read the bot record the engine actually carries (bindings persisted)
  const boundBot = JSON.parse(readFileSync(join(dataDir, 'bots.json'), 'utf8')).bots[0];
  turn = await driveTurn(boundBot, '绑定后');
  assert.equal(turn.final.text, 'fake 完成：绑定后' + FOOTER, 'final reply ends with the exact token footer');
  assert.ok(turn.nonFinal.length >= 1, 'progress frames exist');
  assert.ok(turn.nonFinal.every((f) => !f.text.includes('📊')), 'no progress frame ever carries the footer');

  // the ledger row stays clean — usage is presentation, never persisted
  const rows = await (await get('/api/ledger?bot=b1')).json();
  const lastRow = rows[rows.length - 1];
  assert.equal(lastRow.assistant, 'fake 完成：绑定后', 'ledger keeps the raw answer without the footer');

  // 3. unbind → footer gone again (the toggle is off)
  const unbindResp = await del(`/api/bots/b1/assets/${assetId}`);
  assert.equal(unbindResp.status, 200, await unbindResp.text());
  const freeBot = JSON.parse(readFileSync(join(dataDir, 'bots.json'), 'utf8')).bots[0];
  turn = await driveTurn(freeBot, '解绑后');
  assert.equal(turn.final.text, 'fake 完成：解绑后');
  assert.ok(!turn.final.text.includes('📊'), 'footer gone after unbind');
});

test('exclusive binding (snapshot) toggles the footer too', async () => {
  const { assets } = await (await get('/api/assets')).json();
  const assetId = assets.find((a) => a.name === 'cost-tracker').id;
  const bindResp = await post(`/api/bots/b1/assets`, { assetId, mode: 'exclusive' });
  assert.equal(bindResp.status, 200, await bindResp.text());
  const bot = JSON.parse(readFileSync(join(dataDir, 'bots.json'), 'utf8')).bots[0];
  const turn = await driveTurn(bot, '私发');
  assert.equal(turn.final.text, 'fake 完成：私发' + FOOTER);
  const unbindResp = await del(`/api/bots/b1/assets/${assetId}`);
  assert.equal(unbindResp.status, 200);
});

test('service reload: asset not duplicated, middleware survives, footer stays bound-on', async () => {
  // bind again so the post-reload turn proves the CHAIN (not just the file)
  const { assets } = await (await get('/api/assets')).json();
  const assetId = assets.find((a) => a.name === 'cost-tracker').id;
  assert.equal((await post(`/api/bots/b1/assets`, { assetId, mode: 'shared' })).status, 200);

  const reload = await post('/api/service/reload');
  assert.equal(reload.status, 200, await reload.text());

  // activate runs again → ensureAsset must be a no-op (still exactly one)
  const doc = JSON.parse(readFileSync(join(dataDir, 'assets.json'), 'utf8'));
  assert.equal(doc.assets.filter((a) => a?.name === 'cost-tracker').length, 1, 'no duplicate asset after reload');

  // the reloaded world still answers a full turn with the footer
  const bot = JSON.parse(readFileSync(join(dataDir, 'bots.json'), 'utf8')).bots[0];
  const turn = await driveTurn(bot, '重启后');
  assert.equal(turn.final.text, 'fake 完成：重启后' + FOOTER);

  assert.equal((await del(`/api/bots/b1/assets/${assetId}`)).status, 200);
});
