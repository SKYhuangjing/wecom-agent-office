// Default semantic progressor (DESIGN §6.1) + outbound secret mask
// (DESIGN §6.2). One event stream drives every rule: priority lines per
// event type, the hysteresis latch (growing answer suppresses thinking),
// incomplete-sentence fallback to the cached last complete sentence, filler
// stripping, line dedupe, and reset. The masking tests lock the built-in
// onOutbound behavior every outbound message must pass through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProgressor } from '../../plugins/core-engine/progressor.js';
import { maskOutbound } from '../../plugins/core-engine/middleware.js';

// --- the full event-sequence walkthrough (DESIGN §6 pipeline order) ---------

test('sequence: step → tool → thinking → answer starts → thinking suppressed → text preview', () => {
  const p = createProgressor();
  assert.equal(p.compose({ type: 'step', n: 1, phase: 'start' }), '第 1 步');
  assert.equal(p.compose({ type: 'step', n: 1, phase: 'end' }), '第 1 步完成');
  assert.equal(p.compose({ type: 'tool', name: 'bash', brief: '检查端口占用' }), '🔧 bash: 检查端口占用');
  // complete sentence in chunk, filler '好的，' stripped
  assert.equal(p.compose({ type: 'thinking', text: '好的，我先查看日志。' }), '💭 我先查看日志。');
  // text event: answer preview AND arms the hysteresis latch
  assert.equal(p.compose({ type: 'text' }, { answer: '正文正在生成' }), '✍️ 已生成：正文正在生成');
  // thinking while the answer is non-empty: must NOT take over the line
  assert.equal(p.compose({ type: 'thinking', text: '我继续分析。' }, { answer: '正文正在生成，还在变长' }), null);
  // suppression is sticky even when this call carries no answer ctx
  assert.equal(p.compose({ type: 'thinking', text: '还在思考下一句。' }), null);
  // only thinking is suppressed — steps still compose
  assert.equal(p.compose({ type: 'step', n: 2, phase: 'start' }), '第 2 步');
});

test('hysteresis also fires from ctx alone on a fresh progressor (no prior text event)', () => {
  const p = createProgressor();
  assert.equal(p.compose({ type: 'thinking', text: '分析中。' }, { answer: '已有部分正文' }), null);
});

test('dsh degradation path: tool/text only, no thinking source — lines still correct', () => {
  const p = createProgressor();
  assert.equal(p.compose({ type: 'tool', name: 'dsh-tool', brief: '执行命令' }), '🔧 dsh-tool: 执行命令');
  assert.equal(p.compose({ type: 'text' }, { answer: '命令输出正文' }), '✍️ 已生成：命令输出正文');
  assert.equal(p.compose({ type: 'final' }), null);
});

// --- thinking rules -----------------------------------------------------------

test('thinking takes the LAST complete sentence of the chunk', () => {
  const p = createProgressor();
  // '好的，那么第二句。' — repeated filler strip (好的 + 那么) across the ，
  assert.equal(p.compose({ type: 'thinking', text: '第一句。好的，那么第二句。第三句未完' }), '💭 第二句。');
});

test('no sentence-ending in chunk → fall back to the cached last complete sentence', () => {
  const p = createProgressor();
  assert.equal(p.compose({ type: 'thinking', text: '我先分析一下需求。' }), '💭 我先分析一下需求。');
  // move lastLine so the fallback is observable through dedupe
  assert.equal(p.compose({ type: 'tool', name: 'grep', brief: '搜索配置项' }), '🔧 grep: 搜索配置项');
  assert.equal(p.compose({ type: 'thinking', text: '接下来检查网络连通性' }), '💭 我先分析一下需求。');
});

test('no complete sentence ever seen → tail-60 fallback, filler-stripped, marked unfinished', () => {
  const p = createProgressor();
  // the §6.1 example: filler strip 好的，让我 → 先看一下…
  assert.equal(p.compose({ type: 'thinking', text: '好的，让我先看一下' }), '💭 先看一下…');
  // exactly the LAST 60 chars when the chunk is longer
  assert.equal(p.compose({ type: 'thinking', text: 'x'.repeat(80) }), `💭 ${'x'.repeat(60)}…`);
});

test('same complete sentence again → deduped (同句不重推)', () => {
  const p = createProgressor();
  assert.equal(p.compose({ type: 'thinking', text: '我来汇总结论。' }), '💭 我来汇总结论。');
  assert.equal(p.compose({ type: 'thinking', text: '我来汇总结论。然后补充细节' }), null);
});

test('thinking line caps at the last 60 chars even for complete sentences (§6.1)', () => {
  const p = createProgressor();
  const long = '前'.repeat(70) + '后'.repeat(10) + '。'; // 81-char sentence
  const clipped = '前'.repeat(49) + '后'.repeat(10) + '。'; // last 60 chars
  assert.equal(p.compose({ type: 'thinking', text: long }), `💭 ${clipped}`);
  // the cached-sentence fallback path clips too
  assert.equal(p.compose({ type: 'tool', name: 'x', brief: 'y' }), '🔧 x: y');
  assert.equal(p.compose({ type: 'thinking', text: '接下来继续没有句读' }), `💭 ${clipped}`);
});

test('ASCII dot inside version/decimal numbers is not a sentence boundary', () => {
  const p = createProgressor();
  assert.equal(p.compose({ type: 'thinking', text: '查看v1.2的配置。' }), '💭 查看v1.2的配置。');
  assert.equal(p.compose({ type: 'thinking', text: 'The value is 3.14 here.' }), '💭 The value is 3.14 here.');
});

test('pure verbal-tic thinking yields no line instead of a bare 💭', () => {
  const p = createProgressor();
  assert.equal(p.compose({ type: 'thinking', text: '好的。' }), null);
  // all-filler tail (no sentence, no cache) is empty after stripping → no line
  assert.equal(p.compose({ type: 'thinking', text: '接下来' }), null);
});

// --- text / step / null-out rules ---------------------------------------------

test('text preview caps at the first 40 chars and dedupes while unchanged', () => {
  const p = createProgressor();
  assert.equal(p.compose({ type: 'text' }, { answer: 'a'.repeat(100) }), `✍️ 已生成：${'a'.repeat(40)}`);
  // answer grew but the first 40 chars are identical → same line → null
  assert.equal(p.compose({ type: 'text' }, { answer: 'a'.repeat(100) + '尾部增长' }), null);
});

test('text with empty/missing answer → null and does NOT arm hysteresis', () => {
  const p = createProgressor();
  assert.equal(p.compose({ type: 'text' }, { answer: '' }), null);
  assert.equal(p.compose({ type: 'text' }), null);
  assert.equal(p.compose({ type: 'thinking', text: '仍在思考。' }), '💭 仍在思考。');
});

test('step: phase start/end, phase omitted = start, missing n = null', () => {
  const p = createProgressor();
  assert.equal(p.compose({ type: 'step', n: 3 }), '第 3 步');
  assert.equal(p.compose({ type: 'step', n: 3, phase: 'end' }), '第 3 步完成');
  assert.equal(p.compose({ type: 'step' }), null);
});

test('session/error/final and unknown types produce no line', () => {
  const p = createProgressor();
  assert.equal(p.compose({ type: 'session' }), null);
  assert.equal(p.compose({ type: 'error' }), null);
  assert.equal(p.compose({ type: 'final' }), null);
  assert.equal(p.compose({ type: 'mystery' }), null);
});

// --- dedupe & reset ------------------------------------------------------------

test('tool dedupe: identical tool line twice → second is null, a different tool composes again', () => {
  const p = createProgressor();
  assert.equal(p.compose({ type: 'tool', name: 'web', brief: '搜索资料' }), '🔧 web: 搜索资料');
  assert.equal(p.compose({ type: 'tool', name: 'web', brief: '搜索资料' }), null);
  assert.equal(p.compose({ type: 'tool', name: 'web', brief: '搜索更多资料' }), '🔧 web: 搜索更多资料');
});

test('reset() clears dedupe cache, sentence cache, and the hysteresis latch', () => {
  const p = createProgressor();
  assert.equal(p.compose({ type: 'thinking', text: '第一段思考。' }), '💭 第一段思考。'); // fills cache
  assert.equal(p.compose({ type: 'text' }, { answer: '正文' }), '✍️ 已生成：正文'); // arms latch
  assert.equal(p.compose({ type: 'tool', name: 'ls', brief: '列出文件' }), '🔧 ls: 列出文件');
  assert.equal(p.compose({ type: 'tool', name: 'ls', brief: '列出文件' }), null); // dedupe armed
  p.reset();
  // dedupe cache cleared: same line composes again
  assert.equal(p.compose({ type: 'tool', name: 'ls', brief: '列出文件' }), '🔧 ls: 列出文件');
  // one assertion, three states: had the hysteresis latch survived it would
  // be null; had the sentence cache survived it would repeat '💭 第一段思考。';
  // correctly it takes the fresh tail-fallback path.
  assert.equal(p.compose({ type: 'thinking', text: '没有句子的新尾巴' }), '💭 没有句子的新尾巴…');
});

test('compose rejects malformed events loudly (no silent undefined lines)', () => {
  const p = createProgressor();
  assert.throws(() => p.compose(null), /event/);
  assert.throws(() => p.compose({}), /type/);
});

// --- maskOutbound (DESIGN §6.2 built-in onOutbound) ----------------------------

test('maskOutbound: sk-/pk_/Bearer tokens are replaced with ***', () => {
  assert.equal(maskOutbound('我的密钥是 sk-abc123def456ghi789 请删除'), '我的密钥是 *** 请删除');
  assert.equal(maskOutbound('key pk_live_0123456789abcd end'), 'key *** end');
  assert.equal(maskOutbound('Bearer-ghp_abcdefgh01234567 done'), '*** done');
});

test('maskOutbound: Bearer + space (HTTP wire format) is masked', () => {
  assert.equal(maskOutbound('Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'), '***');
  assert.equal(maskOutbound('bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 ok'), '*** ok');
});

test('maskOutbound: mid-word sk/pk identifiers are not masked (word boundary)', () => {
  assert.equal(maskOutbound('ran task-0123456789abcdef ok'), 'ran task-0123456789abcdef ok');
  assert.equal(maskOutbound('skip_the_long_paragraph'), 'skip_the_long_paragraph');
});

test('maskOutbound: case-insensitive prefix; sk/pk separator is mandatory', () => {
  assert.equal(maskOutbound('SK-ABCDEF0123456789'), '***');
  // accepted trade-off (hardened pattern): a 16+ body with NO separator is
  // left as-is — the mandatory separator is what kills mid-word matches
  // like 'task-…'; real provider tokens (sk-/pk-/Bearer) always carry one.
  assert.equal(maskOutbound('skABCDEFGHIJKLMNOP'), 'skABCDEFGHIJKLMNOP');
});

test('maskOutbound: short tokens and normal text are untouched', () => {
  assert.equal(maskOutbound('sk-abc123'), 'sk-abc123');
  assert.equal(maskOutbound('pk_123'), 'pk_123');
  assert.equal(maskOutbound('今天天气不错，普通文本没有任何密钥 token here'),
    '今天天气不错，普通文本没有任何密钥 token here');
});

test('maskOutbound: every occurrence in one message is masked (global)', () => {
  assert.equal(maskOutbound('a sk-0123456789abcdef b pk-0123456789abcdef c'),
    'a *** b *** c');
});

test('maskOutbound: non-string input passes through unchanged', () => {
  assert.equal(maskOutbound(null), null);
  assert.equal(maskOutbound(undefined), undefined);
  assert.equal(maskOutbound(42), 42);
});
