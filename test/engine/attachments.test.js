// Engine attachment-envelope tests (DESIGN-MULTIMODAL Phase 1/2): file 分级
//（fileSectionFor 矩阵：文本内联 / PDF→claude Read 提示 / PDF→其他引擎婉拒
// 注记 / 二进制落盘 downloads/ / 读取失败注记）+ defaultRunTurn 的信封消费
//（prompt 组装、runArgs 只带图片附件、recordTurn 台账摘要、timeline 占位、
// 纯文本轮 prompt 逐字节不变）。Harness 是 run.test.js 的精简复制（scripted
// runner + 记录 adapter + 真 Ledger/SessionCache）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { Engine } from '../../plugins/core-engine/engine.js';
import { Ledger } from '../../plugins/core-engine/ledger.js';
import { SessionCache } from '../../plugins/core-engine/sessionCache.js';
import { Timeline } from '../../plugins/core-engine/timeline.js';
import { fileSectionFor, failureSection } from '../../plugins/core-engine/engine.js';

const K = 'wecom:group:g1';
const MS_LIMITS = {
  concurrency: 4, minIntervalMs: 0, heartbeatMs: 10_000, maxContentChars: 100,
  streamDeadlineMs: 600_000, hardTimeoutMs: 5_000, warnLeadMs: 90_000,
  outboundBudgetPerMin: 28,
};
const tick = () => new Promise((r) => setImmediate(r));

function fakeLog() {
  const lines = { debug: [], info: [], warn: [], error: [] };
  return {
    lines,
    debug: (m) => lines.debug.push(m), info: (m) => lines.info.push(m),
    warn: (m) => lines.warn.push(m), error: (m) => lines.error.push(m),
  };
}

function fakeAdapter() {
  const frames = [];
  return {
    frames, capabilities: { stream: true, push: true },
    ack: async (reqId, streamId, text) => { frames.push({ method: 'ack', reqId, streamId, text }); },
    progress: async (reqId, streamId, text, finish) => { frames.push({ method: 'progress', reqId, streamId, text, finish: !!finish }); },
    reply: async (reqId, text) => { frames.push({ method: 'reply', reqId, text }); },
    push: async (chatRef, text) => { frames.push({ method: 'push', chatRef, text }); },
  };
}

function scriptedRunner(finalText = '答案内容') {
  const calls = [];
  return {
    calls,
    describeError: (r) => `DE[${r?.code ?? '?'}]`,
    async run(args) {
      calls.push({ prompt: args.prompt, sessionId: args.sessionId, attachments: args.attachments });
      return { ok: true, code: 'completed', finalText, aborted: false, sessionId: args.sessionId ?? 's1', reason: 'completed' };
    },
  };
}

function makeHarness({ bot } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wao-att-eng-'));
  const log = fakeLog();
  const ledger = new Ledger({ file: join(dir, 'ledger.jsonl'), log });
  const cache = new SessionCache({ file: join(dir, 'sessions.json'), log, ledger });
  const timeline = new Timeline();
  const adapter = fakeAdapter();
  const runner = scriptedRunner();
  const b = bot ?? { id: 'bot1', name: 'b', provider: 'claude', channel: 'wecom', providerConfig: { cwd: dir } };
  const engine = new Engine({
    log, getRunner: () => runner, getAdapter: () => adapter,
    ledgerFactory: () => ({ ledger, cache }), timeline, middleware: { maskOutbound: (t) => t },
    limits: MS_LIMITS,
  });
  engine.attachBot(b, { adapter, runner });
  const send = async (msg) => {
    engine.onMessage(b, {
      chatKey: K, chatKind: 'group', chatid: 'g1', userid: 'u1', text: msg.text ?? '',
      reqId: `req-${randomUUID()}`, ...msg,
    });
    await engine.chains.get(K);
    await tick();
  };
  return { engine, adapter, runner, ledger, cache, timeline, log, bot: b, send, dir };
}

// --- fileSectionFor 矩阵 -------------------------------------------------------

function withTempFile(prefix, bytes, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const p = join(dir, 'file.bin');
  writeFileSync(p, bytes);
  try {
    return fn(p, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const att = (path, over = {}) => ({
  kind: 'file', path, sha256: 'c'.repeat(64), size: 1, name: 'note.md', mediaType: 'application/octet-stream', ...over,
});

test('fileSectionFor: decodable text ≤64KB inlines fenced with the display name', async () => {
  await withTempFile('wao-fs-text-', Buffer.from('# 标题\n正文内容\n', 'utf8'), (path) => {
    const s = fileSectionFor(att(path, { name: '周报.md' }), { provider: 'claude', cwd: '/tmp' });
    assert.ok(s.startsWith('用户发来文件「周报.md」，内容如下：'));
    assert.ok(s.includes('```'));
    assert.ok(s.includes('# 标题'));
  });
});

test('fileSectionFor: >64KB text falls through to the working-copy branch (no giant prompt)', async () => {
  await withTempFile('wao-fs-big-', Buffer.alloc(65 * 1024, 0x61), (path, dir) => {
    const s = fileSectionFor(att(path), { provider: 'claude', cwd: dir });
    assert.ok(s.includes('已保存到'), `falls to path hint (${s.slice(0, 60)}…)`);
    assert.ok(existsSync(join(dir, 'downloads')));
  });
});

test('fileSectionFor: PDF → claude copies to <cwd>/downloads and points at the Read tool; other providers get the declination note', async () => {
  await withTempFile('wao-fs-pdf-', Buffer.from('%PDF-1.7\nfake body', 'latin1'), (path, dir) => {
    const s = fileSectionFor(att(path, { name: '合同.pdf', mediaType: 'application/pdf' }), { provider: 'claude', cwd: dir });
    assert.ok(s.includes('已保存到'), 'claude gets the working copy');
    assert.ok(s.includes('Read 工具'), 'claude is told to Read it');
    assert.ok(s.includes(join(dir, 'downloads', `${'c'.repeat(64)}.bin`)), 'copy lands under downloads/ named by sha256');

    const s2 = fileSectionFor(att(path, { name: '合同.pdf', mediaType: 'application/pdf' }), { provider: 'dsh', cwd: dir });
    assert.ok(s2.includes('暂不支持读取 PDF'), 'non-claude gets the declination note');
    assert.ok(!s2.includes('已保存到'));
  });
});

test('fileSectionFor: binary lands in downloads/ with a path hint; unreadable file degrades to a note', async () => {
  await withTempFile('wao-fs-bin-', Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]), (path, dir) => {
    const s = fileSectionFor(att(path, { name: '数据.xlsm' }), { provider: 'codex', cwd: dir });
    assert.ok(s.includes('用户发来文件「数据.xlsm」'));
    assert.ok(s.includes(join(dir, 'downloads')));
  });
  const s = fileSectionFor(att('/nonexistent/definitely/missing.bin'), { provider: 'claude', cwd: '/tmp' });
  assert.ok(s.includes('读取失败'));
});

test('failureSection: every adapter decline code maps to a model-facing note', async () => {
  assert.ok(failureSection({ code: 'engine-no-vision' }).includes('当前引擎暂不支持图片'));
  assert.ok(failureSection({ code: 'vision-off' }).includes('图片处理未开启'));
  assert.ok(failureSection({ code: 'too-large' }).includes('文件过大'));
  assert.ok(failureSection({ code: 'download-failed' }).includes('下载失败'));
});

// --- defaultRunTurn 信封消费 ————————————————————————————————————————————————

test('turn: image → runArgs.attachments; file inlined into prompt; ledger row carries the summary', async () => {
  const h = makeHarness();
  try {
    const imgPath = join(h.dir, 'red.png');
    writeFileSync(imgPath, Buffer.from('89504e47', 'hex'));
    const txtPath = join(h.dir, 'note.txt');
    writeFileSync(txtPath, Buffer.from('文本附件内容 ABC', 'utf8'));

    await h.send({
      text: '看下这些',
      attachments: [
        { kind: 'image', path: imgPath, sha256: 'd'.repeat(64), size: 4, name: 'red.png', mediaType: 'image/png' },
        { kind: 'file', path: txtPath, sha256: 'e'.repeat(64), size: 20, name: 'note.txt', mediaType: 'text/plain' },
      ],
    });

    const call = h.runner.calls[0];
    assert.equal(call.attachments.length, 1, 'only the image rides runArgs');
    assert.equal(call.attachments[0].kind, 'image');
    assert.ok(call.prompt.startsWith('看下这些'), `text first (${call.prompt.slice(0, 20)}…)`);
    assert.ok(call.prompt.includes('---'), 'sections separated');
    assert.ok(call.prompt.includes('用户发来文件「note.txt」'), 'file section inlined');
    assert.ok(call.prompt.includes('文本附件内容 ABC'));

    const row = h.ledger.turns({ chatKey: K })[0];
    assert.deepEqual(row.attachments, [
      { kind: 'image', name: 'red.png', sha256: 'd'.repeat(64), size: 4 },
      { kind: 'file', name: 'note.txt', sha256: 'e'.repeat(64), size: 20 },
    ]);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test('turn: attachmentFailures annotate the prompt; pure-image turn records [附件×N] in timeline', async () => {
  const h = makeHarness();
  try {
    const imgPath = join(h.dir, 'red.png');
    writeFileSync(imgPath, Buffer.from('89504e47', 'hex'));

    await h.send({
      text: '图里是什么',
      attachmentFailures: [{ kind: 'image', code: 'engine-no-vision' }],
    });
    assert.ok(h.runner.calls[0].prompt.includes('当前引擎暂不支持图片'), 'failure note reaches the model');
    assert.deepEqual(h.runner.calls[0].attachments, []);

    await h.send({
      text: '',
      attachments: [{ kind: 'image', path: imgPath, sha256: 'd'.repeat(64), size: 4, name: '', mediaType: 'image/png' }],
    });
    const turnRows = h.timeline.get({ botId: h.bot.id }).filter((r) => r.kind === 'turn');
    assert.ok(turnRows.some((r) => r.text.startsWith('[附件×1] →')), `pure-image timeline placeholder (${turnRows.map((r) => r.text)})`);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test('turn: plain-text message keeps a byte-identical prompt (no attachment fields)', async () => {
  const h = makeHarness();
  try {
    await h.send({ text: '普通问题' });
    assert.equal(h.runner.calls[0].prompt, '普通问题');
    assert.deepEqual(h.runner.calls[0].attachments, []);
    const row = h.ledger.turns({ chatKey: K })[0];
    assert.equal(row.attachments, undefined, 'no attachments key on plain turns');
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

// 盲评 P1-2 回归钉：单图 4MB 上限只算一张——2×4MB 的 base64（×4/3 ≈
// 10.7MB）会击穿 claude stdin 10MB。总量预算 6.75MB：第一张放行、第二张
// 转 image-budget 注记（好图保留），台账摘要仍记两张（审计可溯）。
test('turn: image budget — 2×4MB overruns, second image annotated instead of delivered', async () => {
  const h = makeHarness();
  try {
    const fourMb = 4 * 1024 * 1024;
    await h.send({
      text: '看这两张图',
      attachments: [
        { kind: 'image', path: '/nonexistent/a.png', sha256: 'a'.repeat(64), size: fourMb, name: '', mediaType: 'image/png' },
        { kind: 'image', path: '/nonexistent/b.png', sha256: 'b'.repeat(64), size: fourMb, name: '', mediaType: 'image/png' },
      ],
    });
    const call = h.runner.calls[0];
    assert.equal(call.attachments.length, 1, 'only the first image fits the budget');
    assert.ok(call.prompt.includes('图片总量过大'), `overrun note in prompt (${call.prompt.slice(-120)})`);
    // size 缺席的信封条目不吃预算（不可信数据红线：按超限处理）
    const h2 = makeHarness();
    try {
      await h2.send({
        text: '未知大小的图',
        attachments: [{ kind: 'image', path: '/nonexistent/c.png', sha256: 'c'.repeat(64), name: '', mediaType: 'image/png' }],
      });
      assert.equal(h2.runner.calls[0].attachments.length, 0, 'missing size never rides runArgs');
      assert.ok(h2.runner.calls[0].prompt.includes('图片总量过大'));
    } finally { rmSync(h2.dir, { recursive: true, force: true }); }
    // 台账摘要记录全部两张（审计），runArgs 只送一张
    const row = h.ledger.turns({ chatKey: K })[0];
    assert.equal(row.attachments.length, 2);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

// 复测 P2-2 设计表态：6.75MB 总量预算只为 claude 的 stdin 10MB 存在——codex/pi
// 走 argv 传路径，同样 2×4MB 两张都必须送达 runner（不丢图、不注记）。
test('turn: the aggregate image budget is claude-only — codex gets both 4MB images', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-att-codex-'));
  const h = makeHarness({ bot: { id: 'bot1', name: 'b', provider: 'codex', channel: 'wecom', providerConfig: { cwd: dir } } });
  try {
    const fourMb = 4 * 1024 * 1024;
    await h.send({
      text: '看这两张图',
      attachments: [
        { kind: 'image', path: '/nonexistent/a.png', sha256: 'a'.repeat(64), size: fourMb, name: '', mediaType: 'image/png' },
        { kind: 'image', path: '/nonexistent/b.png', sha256: 'b'.repeat(64), size: fourMb, name: '', mediaType: 'image/png' },
      ],
    });
    assert.equal(h.runner.calls[0].attachments.length, 2, 'codex has no stdin budget — both images ride');
    assert.ok(!h.runner.calls[0].prompt.includes('图片总量过大'), 'no budget note for codex');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(h.dir, { recursive: true, force: true });
  }
});

// 复测 P2-3：纯图无文字 → 引擎统一补占位。codex/pi 的 stdin 是裸 prompt，空串
// 会让 CLI 收到空输入（最坏直接报错→用户只看到通用「任务失败」）；claude 的
// runner 兜底保留，但不该是唯一防线。
test('turn: pure-image message with no text carries the placeholder prompt (codex and claude)', async () => {
  for (const provider of ['codex', 'claude']) {
    const dir = mkdtempSync(join(tmpdir(), `wao-att-pure-${provider}-`));
    const h = makeHarness({ bot: { id: 'bot1', name: 'b', provider, channel: 'wecom', providerConfig: { cwd: dir } } });
    try {
      await h.send({
        text: '',
        attachments: [{ kind: 'image', path: '/nonexistent/a.png', sha256: 'a'.repeat(64), size: 1024, name: '', mediaType: 'image/png' }],
      });
      assert.equal(h.runner.calls[0].prompt, '（用户发来图片，无文字说明）', `${provider}: prompt must never be empty`);
      assert.equal(h.runner.calls[0].attachments.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(h.dir, { recursive: true, force: true });
    }
  }
});
