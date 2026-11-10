// 知识资产面 HTTP 契约（DESIGN-KNOWLEDGE）：GET /api/bots/:id/knowledge、
// POST /api/bots/:id/curate、POST /api/assets/:id/rollback 走真内核（fakechan +
// fakeprov——fakeprov 的 runner 在最终回复里带 ```json 围栏提案，覆盖整理轮的
// 围栏回退通道）；/api/assets 回显 history 元数据（content 不出注册表）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../../src/index.js';

const PROPOSAL_JSON = JSON.stringify({
  memory: { notes: ['HTTP 围栏通道：合并后一条'] },
  skills: [{ action: 'create', name: 'http-playbook', description: 'HTTP 手册', body: '# 手册' }],
  summary: 'HTTP 轮整理',
});

const FAKE_CHANNEL = `
export default {
  manifest: { id: 'channel-fake', name: 'Fake Channel', type: 'channel', version: '0.1.0', requires: { kernel: '^1' } },
  activate(ctx) {
    ctx.registerChannel('fakechan', {
      accountSchema: [{ key: 'endpoint', label: 'Endpoint', type: 'string', required: true }],
      capabilities: { stream: true, push: true, group: true, welcome: false, maxContentChars: 3500, minIntervalMs: 10, heartbeatMs: 60000, streamDeadlineMs: 600000 },
      createAdapter({ engine }) {
        return { engine, start() {}, stop() {}, status() { return { state: 'online', lastError: null }; }, ack() {}, progress() {}, reply() {}, welcome() {}, push() {} };
      },
    });
  },
};`;

// fakeprov 的 runner 回复 = 简短总结 + ```json 围栏提案（围栏回退通道基线）。
const FENCE = '```';
const FAKE_PROVIDER = `
const PROPOSAL = ${JSON.stringify(PROPOSAL_JSON)};
export default {
  manifest: { id: 'provider-fake', name: 'Fake Provider', type: 'provider', version: '0.1.0', requires: { kernel: '^1' } },
  activate(ctx) {
    ctx.registerProvider('fakeprov', {
      configSchema: [{ key: 'cwd', label: 'Working directory', type: 'string', required: true }, { key: 'prompt', label: '人设', type: 'string' }],
      validate(providerConfig) {
        return (typeof providerConfig?.cwd === 'string' && providerConfig?.cwd !== '') ? [] : ['cwd is required'];
      },
      materializeConfig() { return { changed: true }; },
      async materializeAssets(bot, plan) {
        const writes = [];
        for (const e of Array.isArray(plan) ? plan : []) {
          writes.push({
            kind: 'file-create',
            target: bot.providerConfig.cwd + '/.wao-fake/' + e.type + '--' + e.name + '.md',
            content: e.assetId + ':' + e.name,
            for: e.assetId,
          });
        }
        return { writes, notes: [], entries: [] };
      },
      knowledgeFace(bot) {
        return {
          delivery: 'fake 送达面（argv + 任务信封）',
          sections: [
            { kind: 'argv', title: '系统提示词', text: bot.providerConfig?.prompt ?? '（空人设）' },
            { kind: 'stdin', title: '任务信封', text: '用户消息经 stdin 传入' },
          ],
        };
      },
      createRunner() {
        return {
          async run() {
            const reply = '整理完成。\\n${FENCE}json\\n' + PROPOSAL + '\\n${FENCE}';
            return { ok: true, code: 'completed', finalText: reply, aborted: false, sessionId: 'http-cur-1', reason: null, detail: { exitCode: 0 } };
          },
          async readHistory() { return { turns: [], truncated: false, warnings: [] }; },
        };
      },
      describeError(r) { return 'fake error: ' + (r?.code ?? 'unknown'); },
    });
  },
};`;

let kernel;
let dataDir;
let fakesDir;
let cwdDir;
const url = (p) => `http://127.0.0.1:${kernel.http.port}${p}`;
const req = (p, method = 'GET', body) => fetch(url(p), {
  method,
  headers: body === undefined ? undefined : { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const writePlugin = (dir, src) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.js'), src);
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
};

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wao-kn-api-data-'));
  fakesDir = mkdtempSync(join(tmpdir(), 'wao-kn-api-fakes-'));
  writePlugin(join(fakesDir, 'channel-fake'), FAKE_CHANNEL);
  writePlugin(join(fakesDir, 'provider-fake'), FAKE_PROVIDER);
  cwdDir = mkdtempSync(join(tmpdir(), 'wao-kn-api-cwd-'));
  kernel = await createKernel({ port: 0, dataDir, pluginsDirs: [fakesDir, join(process.cwd(), 'plugins')] });
  const mk = await req('/api/bots', 'POST', {
    id: 'kb1', name: '知识测试', channel: 'fakechan', provider: 'fakeprov',
    account: { endpoint: 'http://127.0.0.1:1' },
    providerConfig: { cwd: cwdDir, prompt: '人设：认真' },
  });
  assert.equal(mk.status, 200, await mk.text());
  await req('/api/assets', 'POST', {
    type: 'memory', name: 'biz', description: '业务记忆',
    content: { notes: ['第一版一条'] },
  });
  const list = await req('/api/assets').then((r) => r.json());
  const mem = list.assets.find((a) => a.type === 'memory');
  await req('/api/bots/kb1/assets', 'POST', { assetId: mem.id, mode: 'shared' });
});

after(async () => {
  await kernel.stop();
  for (const d of [dataDir, fakesDir, cwdDir]) rmSync(d, { recursive: true, force: true });
});

test('GET /api/bots/:id/knowledge: 钩子送达面 + 绑定记忆/版本面；未知 bot 404', async () => {
  assert.equal((await req('/api/bots/ghost/knowledge')).status, 404);
  const r = await req('/api/bots/kb1/knowledge');
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.botId, 'kb1');
  assert.equal(b.delivery, 'fake 送达面（argv + 任务信封）');
  assert.ok(b.prompt.sections.some((s) => s.kind === 'argv' && s.text.includes('人设：认真')), 'argv 段带人设');
  assert.ok(b.prompt.sections.some((s) => s.kind === 'stdin'));
  assert.equal(b.memories.length, 1);
  assert.deepEqual(b.memories[0].notes, ['第一版一条']);
  assert.equal(b.versions.length, 1);
  assert.deepEqual(b.curation, []);
});

test('POST /api/bots/:id/curate: 围栏提案 → 应用（记忆替换 + curation 技能建并绑）+ 整理史', async () => {
  const r = await req('/api/bots/kb1/curate', 'POST', { guidance: 'HTTP 轮' });
  assert.equal(r.status, 200);
  const rec = await r.json();
  assert.equal(rec.ok, true, JSON.stringify(rec));
  assert.equal(rec.source, 'fence');
  assert.deepEqual(rec.changes.memory, { before: 1, after: 1, mode: 'shared' });
  assert.equal(rec.changes.skillsCreated.length, 1);

  const after = await req('/api/assets').then((r2) => r2.json());
  const mem = after.assets.find((a) => a.type === 'memory');
  assert.deepEqual(mem.content.notes, ['HTTP 围栏通道：合并后一条'], '记忆整组替换（v2，v1 入历史）');
  const created = after.assets.find((a) => a.name === 'http-playbook');
  assert.equal(created.origin, 'curation');
  const bots = await req('/api/bots').then((r2) => r2.json());
  const binding = bots.bots.find((x) => x.id === 'kb1').assets.find((x) => x.assetId === created.id);
  assert.equal(binding.mode, 'exclusive', 'curation 技能自动 exclusive 绑定');

  const kb = await req('/api/bots/kb1/knowledge').then((r2) => r2.json());
  assert.equal(kb.curation.length, 1);
  assert.equal(kb.curation[0].ok, true);
  assert.equal(kb.curation[0].guidance, 'HTTP 轮');

  assert.equal((await req('/api/bots/kb1/curate', 'POST', { guidance: 5 })).status, 400);
  assert.equal((await req('/api/bots/ghost/curate', 'POST', {})).status, 404);
});

test('POST /api/assets/:id/rollback: 版本历史回滚全链（PATCH 建史 → 回滚 → 再回滚）', async () => {
  const id = (await req('/api/assets').then((r) => r.json())).assets.find((a) => a.type === 'memory').id;
  // 版本链：v1=第一版 | v2=围栏替换（curate 轮）| v3=第二版 | v4=第三版
  await req(`/api/assets/${id}`, 'PATCH', { content: { notes: ['第二版'] } });
  await req(`/api/assets/${id}`, 'PATCH', { content: { notes: ['第三版'] } });
  const withHist = await req(`/api/assets/${id}`).then((r) => r.json());
  assert.deepEqual(withHist.asset.history.map((h) => h.version), [1, 2, 3], 'history 元数据回显');
  assert.equal(JSON.stringify(withHist.asset.history).includes('第一版一条'), false, '历史条目不带内容出注册表');

  assert.equal((await req(`/api/assets/${id}/rollback`, 'POST', { version: 99 })).status, 404);
  assert.equal((await req(`/api/assets/${id}/rollback`, 'POST', { version: 'x' })).status, 400);
  assert.equal((await req(`/api/assets/${id}/rollback`, 'POST', {})).status, 400);

  const rb = await req(`/api/assets/${id}/rollback`, 'POST', { version: 2 });
  assert.equal(rb.status, 200);
  const body = await rb.json();
  assert.equal(body.scope, 'registry');
  assert.deepEqual(body.rematerialized, ['kb1'], 'shared 绑定扇出重物化');
  let cur = await req(`/api/assets/${id}`).then((r) => r.json());
  assert.deepEqual(cur.asset.content.notes, ['HTTP 围栏通道：合并后一条'], '回到 v2 内容');
  assert.equal(cur.asset.version, 5, '回滚也是 PATCH：4→5');

  const rb2 = await req(`/api/assets/${id}/rollback`, 'POST', { version: 4 });
  assert.equal(rb2.status, 200);
  cur = await req(`/api/assets/${id}`).then((r) => r.json());
  assert.deepEqual(cur.asset.content.notes, ['第三版'], '回滚前的内容也在历史（v4 可再回滚）');
  assert.equal(cur.asset.version, 6);
});

test('knowledge 面响应不含 secret/apikey 键（sanitize 复检）', async () => {
  const r = await req('/api/bots/kb1/knowledge');
  const text = JSON.stringify(await r.json());
  assert.equal(/"(secret|[^"]*apikey[^"]*)"\s*:/.test(text), false);
});
