// code-guard plugin tests. Three layers (cost-tracker precedent):
//   1. guard.js unit: the strip transform (tagged/untagged/json fences,
//      unclosed tail) + the per-bot codeGuard gate + never-eat-the-reply,
//   2. full-kernel integration (fake provider/channel + the REAL plugins
//      dir): a codeGuard bot's final WeCom reply has its python fence
//      replaced with the business copy (surrounding text intact), an
//      opted-out bot ships the fence verbatim.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKernel } from '../../src/index.js';
import { createGuard, stripCodeFences, maskTermsIn, STRIP_NOTE, MASK } from '../../plugins/code-guard/guard.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// --- 1: the strip transform ——————————————————————————————————————————————

test('guard: python-tagged fence replaced, business text kept', () => {
  const { text, stripped } = stripCodeFences('先说结论:\n```python\nimport requests\n```\n后面是业务说明');
  assert.equal(stripped, 1);
  assert.equal(text, `先说结论:\n${STRIP_NOTE}\n后面是业务说明`);
});

test('guard: untagged fence WITH code signal stripped; plain fence kept', () => {
  const codey = stripCodeFences('```\ndef main():\n    pass\n```');
  assert.equal(codey.stripped, 1);
  assert.ok(codey.text.includes(STRIP_NOTE));
  const plain = stripCodeFences('```\n2026-11-11 10:00 WARN timeout host=fms-1\n```');
  assert.equal(plain.stripped, 0);
  assert.ok(plain.text.includes('WARN timeout'));
});

test('guard: json fence passes through (data output is legit)', () => {
  const { text, stripped } = stripCodeFences('结果:\n```json\n{"a":1}\n```');
  assert.equal(stripped, 0);
  assert.ok(text.includes('{"a":1}'));
});

test('guard: unclosed trailing fence (aborted run) still stripped when tagged', () => {
  const { text, stripped } = stripCodeFences('模板:\n```bash\necho hi');
  assert.equal(stripped, 1);
  assert.ok(text.startsWith('模板:'));
  assert.ok(!text.includes('echo'));
});

test('guard: no fences → identical string, stripped 0', () => {
  const src = '普通业务回复,没有围栏。';
  const r = stripCodeFences(src);
  assert.equal(r.stripped, 0);
  assert.equal(r.text, src);
});

test('guard: off by default; codeGuard bot stripped; non-string passes through', () => {
  const g = createGuard({});
  assert.equal(g.onOutbound('```python\nx=1\n```', { bot: {} }), '```python\nx=1\n```');
  const on = createGuard({ isStripOn: (b) => b?.providerConfig?.codeGuard === true });
  const out = on.onOutbound('```python\nx=1\n```', {
    bot: { providerConfig: { codeGuard: true } },
  });
  assert.ok(out.includes(STRIP_NOTE));
  assert.ok(!out.includes('x=1'));
  assert.equal(on.onOutbound(null, { bot: { providerConfig: { codeGuard: true } } }), null);
});

// --- 1b: exact-term masking ————————————————————————————————————————————

test('mask: listed terms replaced case-insensitively; short/junk entries ignored', () => {
  const out = maskTermsIn('管理端（规则平台 / SkillHub）更新了 skillhub 的安装', ['SkillHub', '规则平台', 'x', 7, null]);
  assert.ok(!/SkillHub|skillhub|规则平台/.test(out));
  assert.ok(out.includes(MASK));
});

test('guard: maskTerms works WITHOUT codeGuard; text without terms unchanged', () => {
  const g = createGuard({ maskTermsOf: (b) => b?.providerConfig?.maskTerms ?? [] });
  const bot = { providerConfig: { maskTerms: ['SkillHub'] } };
  assert.equal(
    g.onOutbound('运营平台 SkillHub 有新功能', { bot }),
    `运营平台 ${MASK} 有新功能`,
  );
  assert.equal(g.onOutbound('普通业务文本', { bot }), '普通业务文本');
  assert.equal(g.onOutbound('带代码也要剥吗?不,未开 codeGuard', { bot }), '带代码也要剥吗?不,未开 codeGuard');
});

// --- 2: full-kernel integration ——————————————————————————————————————————

// Fake channel: records every outbound frame (cost-tracker test idiom).
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
        (globalThis.__cgAdapters ??= new Map()).set(bot.id, adapter);
        return adapter;
      },
    });
  },
};`;

// Fake provider: the canned reply ALWAYS carries a python fence — the guard
// (not the fake) decides whether the colleague ever sees it.
const FAKE_PROVIDER = `
export default {
  manifest: { id: 'provider-fake', name: 'Fake Provider', type: 'provider', version: '0.1.0', requires: { kernel: '^1' } },
  activate(ctx) {
    ctx.registerProvider('fakeprov', {
      configSchema: [{ key: 'cwd', label: 'Working directory', type: 'string', required: true }],
      validate(pc) { return (typeof pc?.cwd === 'string' && pc.cwd !== '') ? [] : ['cwd is required']; },
      materializeConfig() { return { changed: false }; },
      removeConfig() { return { removed: false }; },
      async materializeAssets() { return { writes: [], notes: [], entries: [], tools: [] }; },
      createRunner({ bot }) {
        return {
          async run({ prompt, sessionId, signal, onEvent }) {
            if (signal?.aborted) return { ok: false, code: 'aborted', finalText: '', aborted: true, sessionId: null, reason: 'aborted before start', detail: {} };
            onEvent?.({ type: 'text', text: '开始' });
            return {
              ok: true, code: 'completed', aborted: false,
              finalText: '开头说明\\n\`\`\`python\\nimport os\\n\`\`\`\\n结尾说明 ' + prompt,
              sessionId: sessionId || 'session-fake-' + bot.id,
              reason: { kind: 'completed', usage: { inputTokens: 9, outputTokens: 9 } }, detail: {},
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

const driveTurn = async (bot, text) => {
  const svc = kernel.services.get('engine');
  svc.onMessage(bot, {
    reqId: `req-${Math.random().toString(36).slice(2, 8)}`,
    chatKey: 'fake:group:g1', chatKind: 'group', chatid: 'g1', userid: 'u1', text, raw: {},
  });
  await waitFor(() => kernel.services.get('engine').status(bot.id).status === 'idle', 'turn to settle');
  const adapter = globalThis.__cgAdapters.get(bot.id);
  return adapter.frames.filter((f) => f.finish).at(-1);
};

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wao-cg-data-'));
  fakesDir = mkdtempSync(join(tmpdir(), 'wao-cg-fakes-'));
  writePluginDir(join(fakesDir, 'channel-fake'), FAKE_CHANNEL);
  writePluginDir(join(fakesDir, 'provider-fake'), FAKE_PROVIDER);
  kernel = await createKernel({ port: 0, dataDir, pluginsDirs: [fakesDir, join(repoRoot, 'plugins')] });
});

after(async () => {
  await kernel.stop();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(fakesDir, { recursive: true, force: true });
});

test('kernel: codeGuard bot ships the reply WITHOUT the fence; opted-out bot keeps it', async () => {
  const mk = async (id, codeGuard) => {
    const resp = await post('/api/bots', {
      id, name: id, enabled: true, channel: 'fakechan',
      account: { endpoint: 'http://fake.local' }, allowedUsers: [],
      provider: 'fakeprov', providerConfig: { cwd: '/tmp', ...(codeGuard ? { codeGuard: true } : {}) },
    });
    assert.equal(resp.status, 200, `create ${id}`);
    return (await (await get('/api/bots')).json()).bots.find((b) => b.id === id);
  };

  const guarded = await mk('guarded', true);
  const plain = await mk('plain', false);

  const gFrame = await driveTurn(guarded, '写个爬虫');
  assert.ok(gFrame.text.includes(STRIP_NOTE), 'fence replaced with business copy');
  assert.ok(!gFrame.text.includes('import os'), 'no code body ships');
  assert.ok(gFrame.text.includes('开头说明') && gFrame.text.includes('结尾说明'), 'surrounding text intact');

  const pFrame = await driveTurn(plain, '写个爬虫');
  assert.ok(pFrame.text.includes('```python'), 'opted-out bot ships the fence verbatim');
});
