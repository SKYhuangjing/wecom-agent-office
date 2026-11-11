// testBotOp attachment matrix (DESIGN-MULTIMODAL 收尾 13): the probe's
// /api/bots/:id/test body accepts `attachments`（base64 上传 → sha256/magic-
// bytes 落盘 → 透传 runner 直跑，不进引擎链）. Asserted through the exported
// companyOps.testBot face with a scripted provider port; every rejection path
// must answer 400 (拒绝优于静默丢).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { companyOps } from '../../plugins/core-engine/api.js';

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function makeState(dir, { resultOverride } = {}) {
  const runs = [];
  const port = {
    createRunner: () => ({
      describeError: () => 'DE',
      async run(args) {
        runs.push({ prompt: args.prompt, sessionId: args.sessionId, attachments: args.attachments ?? [] });
        if (resultOverride) return { ...resultOverride };
        return { ok: true, code: 'completed', finalText: '答案文本', aborted: false, sessionId: args.sessionId ?? 's1', reason: 'completed' };
      },
    }),
  };
  const bot = {
    id: 'b1', provider: 'claude', channel: 'wecom', enabled: true,
    providerConfig: { cwd: dir },
  };
  return {
    runs,
    botsFile: join(dir, 'bots.json'),
    assetsDoc: { assets: [] },
    ports: { getProvider: () => port, getChannel: () => ({}) },
    materializer: { targetsFor: (_b, plan) => plan },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    get doc() { return { bots: [bot] }; },
  };
}

const pngEntry = (over = {}) => ({ kind: 'image', data: PNG_BYTES.toString('base64'), name: 'red.png', ...over });

test('testBot attachments: base64 → sha256/magic-bytes 落盘 → runner receives the envelope', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-tb-att-'));
  try {
    const state = makeState(dir);
    const ops = companyOps(state);
    const body = await ops.testBot('b1', { prompt: '看图', attachments: [pngEntry()] });
    assert.equal(body.code, 'completed');
    const call = state.runs[0];
    assert.equal(call.prompt, '看图');
    assert.equal(call.attachments.length, 1);
    const a = call.attachments[0];
    assert.equal(a.kind, 'image');
    assert.equal(a.mediaType, 'image/png');
    assert.equal(a.sha256, createHash('sha256').update(PNG_BYTES).digest('hex'));
    assert.ok(existsSync(a.path), 'working copy written');
    assert.match(a.path, /media[/\\]testbot[/\\][0-9a-f]{64}\.png$/);
    assert.deepEqual(readFileSync(a.path), PNG_BYTES);
    assert.equal(a.name, 'red.png');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('testBot attachments: file kind rides the PROMPT (engine-parity 分级), never silently dropped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-tb-bin-'));
  try {
    const state = makeState(dir);
    await companyOps(state).testBot('b1', {
      prompt: '看下这个文件',
      attachments: [{ kind: 'file', data: Buffer.from('plain text upload').toString('base64'), name: '../evil\r\nname.txt' }],
    });
    const call = state.runs[0];
    // 盲评 P1-3：file 附件走 fileSectionFor 拼 prompt（文本内联），runner
    // 只收 image 条目——不再被三家 runner 一致静默丢弃。
    assert.ok(call.prompt.includes('看下这个文件'));
    assert.ok(call.prompt.includes('plain text upload'), 'file content inlined into the probe prompt');
    assert.ok(call.prompt.includes('evil  name.txt'), 'sanitized display name in the section header');
    assert.equal(call.attachments.length, 0, 'file kind never rides runner attachments');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 2026-11-11 PC1 真机：网关拒连被探针话术误报成「超时」会误导排查方向——
// 非 completed 的探针话术必须按 code 分流（gateway-unreachable ≠ timeout）。
test('testBot probe: gateway-unreachable gets the gateway copy, not the timeout copy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-tb-gw-'));
  try {
    const state = makeState(dir, {
      resultOverride: {
        ok: false, code: 'gateway-unreachable', aborted: false, sessionId: null,
        finalText: 'API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)',
        reason: 'gateway-unreachable', detail: { exitCode: 0, stderrTail: '' },
      },
    });
    const body = await companyOps(state).testBot('b1', { prompt: '最近的提交是啥' });
    assert.equal(body.code, 'gateway-unreachable');
    assert.equal(body.finalText, '模型网关连接失败（连接被拒/超时），请先检查网关服务是否在运行，再重试。');
    assert.match(body.detail?.probeTail ?? '', /Connection refused/, 'raw error demoted to probeTail for operators');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('testBot attachments: rejection matrix — every malformed shape answers 400', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-tb-rej-'));
  try {
    const ops = companyOps(makeState(dir));
    const rejects = async (body, needle) => {
      await assert.rejects(() => ops.testBot('b1', body),
        (e) => e.status === 400 && String(e.message).includes(needle));
    };
    await rejects({ attachments: 'nope' }, 'non-empty array');
    await rejects({ attachments: [] }, 'non-empty array');
    await rejects({ attachments: Array.from({ length: 5 }, () => pngEntry()) }, 'at most 4');
    await rejects({ attachments: [{ kind: 'video', data: 'AAAA' }] }, 'kind');
    await rejects({ attachments: [{ kind: 'image' }] }, 'data');
    // Node base64 解码是宽容的：全非法字符解出空 buffer → 非法 base64；
    // 夹杂合法字符解出非空非图字节 → magic bytes 拒绝。两条都 400。
    await rejects({ attachments: [{ kind: 'image', data: '!!!!' }] }, 'not valid base64');
    await rejects({ attachments: [{ kind: 'image', data: '!!!!zzzz' }] }, 'recognized image');
    // bytes decode but are not an image → magic bytes 拒绝
    await rejects({ attachments: [{ kind: 'image', data: Buffer.from('just text').toString('base64') }] }, 'recognized image');
    // 5MB image → over the 4MB budget
    await rejects({
      attachments: [{ kind: 'image', data: Buffer.concat([PNG_BYTES, Buffer.alloc(5 * 1024 * 1024, 1)]).toString('base64') }],
    }, 'exceeds 4MB');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('testBot attachments: absent key keeps the historical probe shape (runner sees [])', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-tb-none-'));
  try {
    const state = makeState(dir);
    const body = await companyOps(state).testBot('b1', {});
    assert.equal(body.code, 'completed');
    assert.deepEqual(state.runs[0].attachments, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 复测 P2-1：试跑面 body 上限必须让 UI 承诺的「4 个 × 20MB」真的可上传——
// 4×20MB 原始字节 base64 后 ≈106.7MB。原 28MB 只按 4 张图片算，选两个 15MB
// PDF 必 413 且报错不可读（源码契约测试：改小上限会立刻挂）。
test('testBot body limit covers the advertised 4×20MB file promise', () => {
  const src = readFileSync(new URL('../../plugins/core-engine/api.js', import.meta.url), 'utf8');
  const m = /TEST_BODY_LIMIT_BYTES = (\d+)\s*\*\s*1024\s*\*\s*1024/.exec(src);
  assert.ok(m, 'constant present');
  const limit = Number(m[1]) * 1024 * 1024;
  const promise = (4 * 20 * 1024 * 1024 * 4) / 3; // 4 files × 20MB, base64 ×4/3
  assert.ok(limit > promise, `body limit ${limit} must cover 4×20MB base64 (~${Math.round(promise)})`);
});
