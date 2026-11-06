// Task 19 Part A — the four accumulated wiring obligations, each pinned red
// before the fix:
//   A1  the facade handed to createAdapter must close over the bot: channels
//       call engine.onMessage({botId, chatKey, ...}) SINGLE-OBJECT (DESIGN §4);
//       the old two-arg service shape silently dropped every inbound message.
//   A2  providerConfig.progressCoT === false → no 💭 line ever (tool/text
//       still compose); default on (DESIGN §6.1).
//   A3  POST/PATCH /api/bots must also run the provider port's validate()
//       (PLUGIN-DEV §8: validate 是权威校验) and merge its errors into the 400.
//   A4  the facade must expose onChannelEvent with the handled contract:
//       false/undefined → the channel's default behavior (enter_chat welcome);
//       true → channel skips it. Engine.onChannelEvent is the seam.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKernel } from '../../src/index.js';
import { Engine } from '../../plugins/core-engine/engine.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// A channel that speaks the DESIGN §4 inbound shape: onMessage gets ONE object
// carrying botId; onChannelEvent's return value drives the default welcome.
const WIRE_CHANNEL = `
export default {
  manifest: { id: 'channel-wire', name: 'Wire Channel', type: 'channel', version: '0.1.0', requires: { kernel: '^1', ports: { channel: '^1' } } },
  activate(ctx) {
    ctx.registerChannel('wirechan', {
      accountSchema: [],
      capabilities: { stream: true, push: false, group: true, welcome: true, maxContentChars: 3500, minIntervalMs: 5, heartbeatMs: 60000, streamDeadlineMs: 600000 },
      createAdapter({ bot, engine }) {
        const a = {
          bot,
          engine,
          acks: [], progresses: [], replies: [], welcomes: [],
          capabilities: { stream: true, push: false, group: true, welcome: true, maxContentChars: 3500, minIntervalMs: 5, heartbeatMs: 60000, streamDeadlineMs: 600000 },
          start() {}, stop() {},
          status() { return { state: 'online', lastError: null }; },
          ack(reqId, streamId, text) { a.acks.push(text); return Promise.resolve(); },
          progress(reqId, streamId, text, finish) { a.progresses.push({ text, finish: !!finish }); return Promise.resolve(); },
          reply(reqId, text) { a.replies.push(text); return Promise.resolve(); },
          welcome(reqId, text) { a.welcomes.push(text); return Promise.resolve(); },
          // test hooks: inbound exactly as a channel port must deliver it
          emitMessage(m) { engine.onMessage({ botId: bot.id, chatKind: 'group', chatid: 'G1', userid: 'u1', ...m }); },
          emitEnterChat(reqId) {
            let handled = false;
            if (typeof engine.onChannelEvent === 'function') {
              handled = engine.onChannelEvent({ type: 'enter_chat', reqId, raw: { cmd: 'aibot_event_callback' } });
            }
            if (handled !== true) a.welcome(reqId, '您好，我是 ' + (bot.name || '机器人'));
          },
        };
        (globalThis.__waoWireAdapters ??= new Map()).set(bot.id, a);
        return a;
      },
    });
  },
};`;

// A provider whose runner streams thinking → tool → text (the A2 event mix)
// and whose validate() rejects one marker value (the A3 seam).
const WIRE_PROVIDER = `
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export default {
  manifest: { id: 'provider-wire', name: 'Wire Provider', type: 'provider', version: '0.1.0', requires: { kernel: '^1', ports: { provider: '^1' } } },
  activate(ctx) {
    ctx.registerProvider('wireprov', {
      configSchema: [
        { key: 'cwd', label: 'Working directory', type: 'string', required: true },
        { key: 'mode', label: 'Mode', type: 'string' },
        { key: 'progressStyle', label: '工作汇报风格', type: 'enum', options: ['polite', 'cot'], default: 'polite' },
        { key: 'progressCoT', label: '进度行展示思维链摘要', type: 'bool', default: true },
      ],
      validate(providerConfig) {
        const errors = [];
        if (providerConfig?.mode === 'suspicious') errors.push('wireprov validate: mode "suspicious" 被语义校验拒绝');
        return errors;
      },
      createRunner({ bot }) {
        return {
          async run({ prompt, sessionId, signal, onEvent }) {
            if (signal?.aborted) {
              return { ok: false, code: 'aborted', finalText: '', aborted: true, sessionId: sessionId ?? null, reason: 'aborted before start', detail: {} };
            }
            await sleep(15);
            if (onEvent) onEvent({ type: 'thinking', text: '好的，让我先看一下目录结构。' });
            await sleep(15);
            if (onEvent) onEvent({ type: 'tool', name: 'Bash', brief: 'ls -la' });
            await sleep(15);
            if (onEvent) onEvent({ type: 'text', text: '答案文本' });
            return { ok: true, code: 'completed', finalText: '答案文本', aborted: false, sessionId: sessionId || 'sess-wire-' + bot.id, reason: null, detail: { exitCode: 0 } };
          },
          async readHistory() { return { turns: [], truncated: false, warnings: [] }; },
        };
      },
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
const get = (p) => fetch(url(p));
const post = (p, body) => fetch(url(p), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const patch = (p, body) => fetch(url(p), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const agentsOf = async () => (await (await get('/api/agents')).json()).agents;
const waitFor = async (predicate, label, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
const adapterOf = (botId) => globalThis.__waoWireAdapters.get(botId);
const settle = (botId) => waitFor(() => kernel.services.get('engine').status(botId).status === 'idle', 'turn to settle');

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wao-wire-data-'));
  fakesDir = mkdtempSync(join(tmpdir(), 'wao-wire-fakes-'));
  writePluginDir(join(fakesDir, 'channel-wire'), WIRE_CHANNEL);
  writePluginDir(join(fakesDir, 'provider-wire'), WIRE_PROVIDER);
  kernel = await createKernel({ port: 0, dataDir, pluginsDirs: [fakesDir, join(repoRoot, 'plugins')] });
});

after(async () => {
  await kernel.stop();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(fakesDir, { recursive: true, force: true });
});

const BOT = (id, providerConfig = { cwd: '/tmp' }) => ({
  id, name: '接线测试', enabled: true, channel: 'wirechan', account: {},
  allowedUsers: [], provider: 'wireprov', providerConfig,
});

// A1 — single-object onMessage through the facade the assembly hands over.
test('A1: channel facade onMessage is single-object and closes over the bot', async () => {
  const resp = await post('/api/bots', BOT('w1'));
  assert.equal(resp.status, 200);
  await waitFor(() => adapterOf('w1') != null, 'adapter attached');
  const adapter = adapterOf('w1');
  adapter.emitMessage({ chatKey: 'wire:group:G1', text: '你好', reqId: 'r-a1' });
  await settle('w1');
  const rows = await (await get('/api/ledger?bot=w1')).json();
  assert.equal(rows.length, 1, 'the single-object inbound message ran a full turn');
  assert.equal(rows[0].user, '你好');
  assert.equal(rows[0].reason, 'completed');
});

// A2 — progressCoT:false kills the 💭 line only.
// 2026-11-06 默认翻转（拟人播报 polite）：本用例钉的是旧「详细汇报」语义，
// fixtures 显式 progressStyle:'cot'（诚实迁移——断言一字不改）。
test('A2: progressCoT=false → no 💭 line; default keeps it; tool/text still progress', async () => {
  await post('/api/bots', BOT('w2cot', { cwd: '/tmp', progressStyle: 'cot', progressCoT: false }));
  await post('/api/bots', BOT('w2on', { cwd: '/tmp', progressStyle: 'cot', progressCoT: true }));
  await waitFor(() => adapterOf('w2cot') != null && adapterOf('w2on') != null, 'adapters attached');

  adapterOf('w2cot').emitMessage({ chatKey: 'wire:group:COT', text: '问题一', reqId: 'r-cot' });
  await settle('w2cot');
  const off = adapterOf('w2cot').progresses;
  assert.ok(off.some((p) => p.text.startsWith('🔧 ')), 'tool line still progresses');
  assert.equal(off.filter((p) => p.text.startsWith('💭')).length, 0, 'no thinking line ever with progressCoT:false');
  assert.ok(off.some((p) => p.finish === true && p.text === '答案文本'), 'final still delivered');

  adapterOf('w2on').emitMessage({ chatKey: 'wire:group:COT', text: '问题二', reqId: 'r-cot-on' });
  await settle('w2on');
  const on = adapterOf('w2on').progresses;
  assert.ok(on.some((p) => p.text.startsWith('💭 ')), 'thinking line shows by default');
  assert.ok(on.some((p) => p.text.startsWith('🔧 ')), 'tool line still progresses');
});

// A2b — 2026-11-06 default flip (owner decision): a bot WITHOUT progressStyle
// (including legacy progressCoT:false/true) broadcasts the polite copy only —
// no 💭/🔧 content reaches the wire through the real kernel assembly.
test('A2b: no progressStyle → polite broadcast (no 💭/🔧 on the wire), legacy progressCoT included', async () => {
  await post('/api/bots', BOT('w2d', { cwd: '/tmp' }));
  await post('/api/bots', BOT('w2legacy', { cwd: '/tmp', progressCoT: false }));
  await waitFor(() => adapterOf('w2d') != null && adapterOf('w2legacy') != null, 'adapters attached');

  for (const [id, req, chat] of [['w2d', 'r-p2d', 'wire:group:P1'], ['w2legacy', 'r-p2l', 'wire:group:P2']]) {
    adapterOf(id).emitMessage({ chatKey: chat, text: '问题', reqId: req });
    await settle(id);
    const frames = adapterOf(id).progresses;
    const beats = frames.filter((p) => !p.finish);
    assert.ok(beats.length >= 1, `${id}: broadcast frames exist`);
    for (const p of beats) {
      assert.ok(!p.text.includes('💭') && !p.text.includes('🔧'),
        `${id}: no CoT/tool content on the wire: ${p.text}`);
    }
    assert.ok(beats.some((p) => /接线测试 思考中\.+ 请稍等（已 \d+ 秒）/.test(p.text)),
      `${id}: default broadcast copy (${JSON.stringify(beats.map((p) => p.text))})`);
    assert.ok(frames.some((p) => p.finish === true && p.text === '答案文本'), `${id}: final still delivered`);
  }
});

// A3 — provider validate() merged into the API 400s.
test('A3: POST/PATCH run provider validate() and merge its errors into the 400', async () => {
  const create = await post('/api/bots', BOT('w3', { cwd: '/tmp', mode: 'suspicious' }));
  assert.equal(create.status, 400);
  const body = await create.json();
  assert.ok(
    (body.errors ?? []).some((e) => e.includes('wireprov validate') && e.includes('suspicious')),
    `provider validate error in 400: ${JSON.stringify(body)}`,
  );

  const good = await post('/api/bots', BOT('w3b', { cwd: '/tmp', mode: 'fine' }));
  assert.equal(good.status, 200);
  const patched = await patch('/api/bots/w3b', { providerConfig: { cwd: '/tmp', mode: 'suspicious' } });
  assert.equal(patched.status, 400);
  const pbody = await patched.json();
  assert.ok((pbody.errors ?? []).some((e) => e.includes('wireprov validate')), `PATCH 400 carries provider error: ${JSON.stringify(pbody)}`);
});

// A4 — the handled contract through the real assembly facade + the engine seam.
test('A4: facade onChannelEvent returns false by default → default welcome; true → channel skips it', async () => {
  await post('/api/bots', BOT('w4'));
  await waitFor(() => adapterOf('w4') != null, 'adapter attached');
  const adapter = adapterOf('w4');

  adapter.emitEnterChat('ev-w4a');
  await waitFor(() => adapter.welcomes.length === 1, 'default welcome fired');
  assert.match(adapter.welcomes[0], /您好，我是/);

  // the engine seam flips the answer: a handler returning true means the
  // ENGINE handled it, the channel must not send its default copy.
  const svc = kernel.services.get('engine');
  svc.setChannelEventHandler(() => true);
  try {
    adapter.emitEnterChat('ev-w4b');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(adapter.welcomes.length, 1, 'no second welcome when the engine handles the event');
  } finally {
    svc.setChannelEventHandler(null);
  }
  adapter.emitEnterChat('ev-w4c');
  await waitFor(() => adapter.welcomes.length === 2, 'welcome returns once the handler is cleared');
});

test('A4 unit: Engine.onChannelEvent — default false, handler true wins, handler throw degrades to false', () => {
  const engine = new Engine({ log: { debug() {}, info() {}, warn() {}, error() {} } });
  const bot = { id: 'u1' };
  engine.attachBot(bot, {});
  assert.equal(engine.onChannelEvent(bot, { type: 'enter_chat', reqId: 'x' }), false, 'default: observed, not handled');
  engine.channelEventHandler = () => true;
  assert.equal(engine.onChannelEvent(bot, { type: 'enter_chat' }), true, 'handler true propagates');
  engine.channelEventHandler = () => { throw new Error('boom'); };
  assert.equal(engine.onChannelEvent(bot, { type: 'enter_chat' }), false, 'a throwing handler degrades to not-handled');
});
