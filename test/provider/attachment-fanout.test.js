// Attachment fan-out contract tests (DESIGN-MULTIMODAL Phase 1/2): the one
// place all three vision-capable runners' attachment faces are pinned
// together —
//   claude: stdin 换 NDJSON stream-json 信封（统一迁移，probe-baselines/
//           claude-streamjson-image*.ndjson 实证 init+resume 两腿），图片走
//           base64 块，argv 加 --input-format stream-json；
//   codex:  argv 追加 -i <path>（fresh 与 exec resume 两腿）；
//   pi:     位置参数 @<path>（print 模式）。
// file 附件不进 runner（引擎已内联/落盘进 prompt）——这里也断言 runner 对
// kind:'file' 条目无动作。fake-bin 的 last-argv/last-prompt/last-envelope.json
// 是断言面（fake-claude 在 --input-format 模式解码信封落盘）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRunner as createClaudeRunner } from '../../plugins/provider-claude/runner.js';
import { createRunner as createCodexRunner } from '../../plugins/provider-codex/runner.js';
import { createRunner as createPiRunner } from '../../plugins/provider-pi/runner.js';

const FAKE_BIN = fileURLToPath(new URL('../fake-bin', import.meta.url));
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const noopLog = { debug() {}, info() {}, warn() {}, error() {} };

// Same /bin/sh wrapper technique as the per-provider suites: bake FAKE_MODE +
// FAKE_HOME, exec the fake (pid preserved so last-pid is the spawned pid).
function makeWrapper(dir, binName, mode) {
  const fakeHome = join(dir, 'fake-home');
  mkdirSync(join(dir, 'bin'), { recursive: true });
  const bin = join(dir, 'bin', `${binName}-${mode}.sh`);
  writeFileSync(bin, '#!/bin/sh\n'
    + `export FAKE_MODE="${mode}"\n`
    + `export FAKE_HOME="${fakeHome}"\n`
    + `mkdir -p "$FAKE_HOME" && printf '%s\\n' "$$" > "$FAKE_HOME/last-pid"\n`
    + `exec "${FAKE_BIN}/fake-${binName}.js" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

// One temp world per case: an image file on disk + fake-home under the cwd.
function makeWorld(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const imgPath = join(dir, 'red.png');
  writeFileSync(imgPath, PNG_BYTES);
  return { dir, imgPath };
}

const AC = () => new AbortController();

test('claude: image attachment rides the stream-json envelope (fresh leg)', async () => {
  const { dir, imgPath } = makeWorld('wao-att-cl-');
  try {
    const runner = createClaudeRunner({
      bot: { id: 'b1', provider: 'claude' },
      providerConfig: { cwd: dir, claudeBin: makeWrapper(dir, 'claude', 'ok') },
      log: noopLog,
    });
    const res = await runner.run({
      prompt: '这张图是什么颜色', signal: AC().signal, timeoutMs: 20_000,
      attachments: [{ kind: 'image', path: imgPath, sha256: 'a'.repeat(64), size: PNG_BYTES.length, name: 'red.png', mediaType: 'image/png' }],
    });
    assert.equal(res.code, 'completed');

    const argv = readFileSync(join(dir, 'fake-home', 'last-argv'), 'utf8');
    assert.ok(argv.includes('--input-format stream-json'), `argv carries --input-format (${argv.trim()})`);

    const envelope = JSON.parse(readFileSync(join(dir, 'fake-home', 'last-envelope.json'), 'utf8'));
    assert.equal(envelope.text, '这张图是什么颜色');
    assert.equal(envelope.images.length, 1);
    assert.equal(envelope.images[0].media_type, 'image/png');
    assert.equal(envelope.images[0].bytes, PNG_BYTES.length, 'base64 block decodes back to the full image');
    // last-prompt 在信封模式下是解码后的 text 块（fake-claude 契约）
    assert.equal(readFileSync(join(dir, 'fake-home', 'last-prompt'), 'utf8'), '这张图是什么颜色');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('claude: empty prompt (pure image) → placeholder text block; file attachments ignored; resume leg keeps the envelope', async () => {
  const { dir, imgPath } = makeWorld('wao-att-cl2-');
  try {
    const mk = () => createClaudeRunner({
      bot: { id: 'b1', provider: 'claude' },
      providerConfig: { cwd: dir, claudeBin: makeWrapper(dir, 'claude', 'resume-echo') },
      log: noopLog,
    });
    const first = await mk().run({
      prompt: '', signal: AC().signal, timeoutMs: 20_000,
      attachments: [{ kind: 'image', path: imgPath, sha256: 'a'.repeat(64), size: PNG_BYTES.length, name: '', mediaType: 'image/png' }],
    });
    assert.equal(first.code, 'completed');
    let envelope = JSON.parse(readFileSync(join(dir, 'fake-home', 'last-envelope.json'), 'utf8'));
    assert.equal(envelope.text, '（用户发来图片，无文字说明）', 'pure-image placeholder text block');

    // resume 腿 + 图片信封（probe 实证组合）
    const second = await mk().run({
      prompt: '继续看这张图', sessionId: first.sessionId, signal: AC().signal, timeoutMs: 20_000,
      attachments: [{ kind: 'image', path: imgPath, sha256: 'a'.repeat(64), size: PNG_BYTES.length, name: '', mediaType: 'image/png' }],
    });
    assert.equal(second.code, 'completed');
    assert.equal(second.sessionId, first.sessionId, 'resume-echo re-emits the SAME session id');
    const argv = readFileSync(join(dir, 'fake-home', 'last-argv'), 'utf8');
    assert.ok(argv.includes(`--resume ${first.sessionId}`), 'resume leg argv');
    assert.ok(argv.includes('--input-format stream-json'), 'resume leg keeps --input-format');
    envelope = JSON.parse(readFileSync(join(dir, 'fake-home', 'last-envelope.json'), 'utf8'));
    assert.equal(envelope.text, '继续看这张图');
    assert.equal(envelope.images.length, 1);

    // kind:'file' 条目不进信封（引擎已内联/落盘进 prompt）
    await mk().run({
      prompt: '只带文件', signal: AC().signal, timeoutMs: 20_000,
      attachments: [{ kind: 'file', path: imgPath, sha256: 'b'.repeat(64), size: PNG_BYTES.length, name: 'x.png', mediaType: 'image/png' }],
    });
    envelope = JSON.parse(readFileSync(join(dir, 'fake-home', 'last-envelope.json'), 'utf8'));
    assert.equal(envelope.images.length, 0, 'file-kind attachments never become image blocks');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('codex: image attachments append -i <path> on BOTH legs; file kind ignored', async () => {
  const { dir, imgPath } = makeWorld('wao-att-cx-');
  try {
    const mk = () => createCodexRunner({
      bot: { id: 'b1', provider: 'codex' },
      providerConfig: { cwd: dir, codexBin: makeWrapper(dir, 'codex', 'resume-echo') },
      log: noopLog,
    });
    const first = await mk().run({
      prompt: '看图', signal: AC().signal, timeoutMs: 20_000,
      attachments: [
        { kind: 'image', path: imgPath, sha256: 'a'.repeat(64), size: 1, name: '', mediaType: 'image/png' },
        { kind: 'file', path: join(dir, 'note.txt'), sha256: 'b'.repeat(64), size: 1, name: 'note.txt', mediaType: 'text/plain' },
      ],
    });
    assert.equal(first.code, 'completed');
    let argv = readFileSync(join(dir, 'fake-home', 'last-argv'), 'utf8');
    assert.ok(argv.includes(`-i ${imgPath}`), `fresh leg carries -i (${argv.trim()})`);
    assert.equal((argv.match(/ -i /g) || []).length, 1, 'only image kinds fan out');

    const second = await mk().run({
      prompt: '再看一次', sessionId: first.sessionId, signal: AC().signal, timeoutMs: 20_000,
      attachments: [{ kind: 'image', path: imgPath, sha256: 'a'.repeat(64), size: 1, name: '', mediaType: 'image/png' }],
    });
    assert.equal(second.code, 'completed');
    argv = readFileSync(join(dir, 'fake-home', 'last-argv'), 'utf8');
    assert.ok(argv.includes(`exec resume ${first.sessionId}`), 'resume subcommand');
    assert.ok(argv.includes(`-i ${imgPath}`), 'resume leg carries -i too');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pi: image attachments append @<path> positionals (print mode); file kind ignored', async () => {
  const { dir, imgPath } = makeWorld('wao-att-pi-');
  try {
    const mk = () => createPiRunner({
      bot: { id: 'b1', provider: 'pi' },
      providerConfig: { cwd: dir, piBin: makeWrapper(dir, 'pi', 'ok'), piAgentDir: join(dir, 'agent') },
      log: noopLog,
    });
    const res = await mk().run({
      prompt: '看图', signal: AC().signal, timeoutMs: 20_000,
      attachments: [
        { kind: 'image', path: imgPath, sha256: 'a'.repeat(64), size: 1, name: '', mediaType: 'image/png' },
        { kind: 'file', path: join(dir, 'note.txt'), sha256: 'b'.repeat(64), size: 1, name: 'note.txt', mediaType: 'text/plain' },
      ],
    });
    assert.equal(res.code, 'completed');
    const argv = readFileSync(join(dir, 'fake-home', 'last-argv'), 'utf8');
    assert.ok(argv.trim().endsWith(`@${imgPath}`), `@file positional appended (${argv.trim()})`);
    assert.equal((argv.match(/@\/.*\.png/g) || []).length, 1, 'only image kinds fan out');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 盲评 P1-2（runner 兜底）+ P2-1：2×4MB 的 base64 总量（~10.7MB）超 9MB
// 预算——第二张跳过且 text 块尾有注记（绝不静默少图）；读不到的图同样
// 注记而非无声消失。
test('claude: 2×4MB images exceed the 9MB base64 budget — overrun and unreadable images both NOTED in the text block', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-att-budget-'));
  try {
    const big = (n) => {
      const p = join(dir, `big${n}.png`);
      writeFileSync(p, Buffer.concat([PNG_BYTES, Buffer.alloc(4 * 1024 * 1024, n)])); // ~4MB，base64 ~5.4MB
      return p;
    };
    const runner = createClaudeRunner({
      bot: { id: 'b1', provider: 'claude' },
      providerConfig: { cwd: dir, claudeBin: makeWrapper(dir, 'claude', 'ok') },
      log: noopLog,
    });
    const res = await runner.run({
      prompt: '对比这两张大图', signal: AC().signal, timeoutMs: 20_000,
      attachments: [
        { kind: 'image', path: big(1), sha256: '1'.repeat(64), size: 4 * 1024 * 1024, name: '', mediaType: 'image/png' },
        { kind: 'image', path: big(2), sha256: '2'.repeat(64), size: 4 * 1024 * 1024, name: '', mediaType: 'image/png' },
      ],
    });
    assert.equal(res.code, 'completed');
    const envelope = JSON.parse(readFileSync(join(dir, 'fake-home', 'last-envelope.json'), 'utf8'));
    assert.equal(envelope.images.length, 1, 'only the first 4MB image fits the 9MB base64 budget');
    assert.ok(envelope.text.includes('对比这两张大图'));
    assert.ok(envelope.text.includes('未能送达'), `overrun note appended (${envelope.text.slice(-80)})`);

    // 读不到的图（文件被清理/盘故障）：同样注记，绝不静默
    const res2 = await runner.run({
      prompt: '看这张图', signal: AC().signal, timeoutMs: 20_000,
      attachments: [{ kind: 'image', path: '/nonexistent/gone.png', sha256: '3'.repeat(64), size: 10, name: '', mediaType: 'image/png' }],
    });
    assert.equal(res2.code, 'completed');
    const env2 = JSON.parse(readFileSync(join(dir, 'fake-home', 'last-envelope.json'), 'utf8'));
    assert.equal(env2.images.length, 0);
    assert.ok(env2.text.includes('未能送达'), 'unreadable image is noted, never silently dropped');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 复测 P2-6：无 path 的 image 条目=不可信信封（引擎侧「缺数字不配吃预算」的
// 对称面）——与「读不到」同路进注记，不留守静的洞。
test('claude: an image entry without a path is NOTED, never silently skipped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-att-nopath-'));
  try {
    const runner = createClaudeRunner({
      bot: { id: 'b1', provider: 'claude' },
      providerConfig: { cwd: dir, claudeBin: makeWrapper(dir, 'claude', 'ok') },
      log: noopLog,
    });
    const res = await runner.run({
      prompt: '看图', signal: AC().signal, timeoutMs: 20_000,
      attachments: [{ kind: 'image', sha256: 'x'.repeat(64), size: 10, name: '', mediaType: 'image/png' }],
    });
    assert.equal(res.code, 'completed');
    const env = JSON.parse(readFileSync(join(dir, 'fake-home', 'last-envelope.json'), 'utf8'));
    assert.equal(env.images.length, 0);
    assert.ok(env.text.includes('未能送达'), 'malformed envelope entry is noted');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
