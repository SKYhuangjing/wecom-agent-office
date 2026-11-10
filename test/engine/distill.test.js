// Memory distillation (DESIGN-TOKEN-OPT §4.3) — marker protocol, merge LRU,
// middleware contract. Pure-function + factory tests; the engine's onOutbound
// chain isolation is already pinned by cost-tracker's tests on the same seam.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractMemoryUpdates, mergeMemoryNotes, createDistillMiddleware,
  DISTILL_MAX_NOTES, DISTILL_MAX_NOTE_CHARS,
} from '../../plugins/core-engine/distill.js';
import { memoryMarkdown as claudeMemory, MEMORY_DISTILL_FOOTER as claudeFooter } from '../../plugins/provider-claude/plugin.js';
import { memoryMarkdown as codexMemory, MEMORY_DISTILL_FOOTER as codexFooter } from '../../plugins/provider-codex/plugin.js';
import { memoryMarkdown as piMemory, MEMORY_DISTILL_FOOTER as piFooter } from '../../plugins/provider-pi/plugin.js';
import { MEMORY_DISTILL_FOOTER as dshFooter } from '../../plugins/provider-dsh/plugin.js';

test('extractMemoryUpdates: no markers → byte-identical passthrough', () => {
  const text = '普通回复\n没有任何标记\n';
  assert.deepEqual(extractMemoryUpdates(text), { cleanText: text, entries: [] });
  // fast path also tolerates non-string input
  assert.deepEqual(extractMemoryUpdates(null), { cleanText: null, entries: [] });
});

test('extractMemoryUpdates: strips marker lines and collects payloads in order', () => {
  const text = [
    '结论：亏舱费走费用维护配置。',
    '<!--wao-memory:亏舱费 → 维护入口在管理端费用维护，落表 freight_port_fee_detail-->',
    '<!-- wao-memory : SLS 默认 project 是 k8s-log-onedata-prod -->',
    '\t<!--wao-memory:运价日志 → logStore=timp-->',
  ].join('\n');
  const { cleanText, entries } = extractMemoryUpdates(text);
  assert.equal(cleanText, '结论：亏舱费走费用维护配置。');
  assert.deepEqual(entries, [
    '亏舱费 → 维护入口在管理端费用维护，落表 freight_port_fee_detail',
    'SLS 默认 project 是 k8s-log-onedata-prod',
    '运价日志 → logStore=timp',
  ]);
});

test('extractMemoryUpdates: empty payloads dropped; >2KB payload truncated to the asset schema limit', () => {
  const big = '长'.repeat(DISTILL_MAX_NOTE_CHARS + 500);
  const { entries } = extractMemoryUpdates(`x\n<!--wao-memory:   -->\n<!--wao-memory:${big}-->`);
  assert.equal(entries.length, 1, 'blank marker contributes nothing');
  assert.equal(entries[0].length, DISTILL_MAX_NOTE_CHARS);
});

test('extractMemoryUpdates: marker-only tail leaves no dangling blank run', () => {
  const { cleanText } = extractMemoryUpdates('答案。\n\n<!--wao-memory:Q → A-->');
  assert.ok(!cleanText.endsWith('\n\n'), `trailing blank collapsed: ${JSON.stringify(cleanText)}`);
  assert.ok(cleanText.startsWith('答案。'));
});

test('mergeMemoryNotes: normalized dedupe, append order, LRU eviction of the oldest', () => {
  const { notes, added, droppedOldest } = mergeMemoryNotes(
    ['第一条', '第二条'],
    ['第二条 ', '  新  条目 ', '第三条'],
  );
  assert.equal(added, 2, 'whitespace-normalized duplicate not re-added');
  assert.deepEqual(notes, ['第一条', '第二条', '新 条目', '第三条']);
  assert.equal(droppedOldest, 0);

  // full asset: the FRONT (oldest, first-rendered) notes make room
  const full = Array.from({ length: DISTILL_MAX_NOTES }, (_, i) => `n${i}`);
  const evicted = mergeMemoryNotes(full, ['最新一条']);
  assert.equal(evicted.droppedOldest, 1);
  assert.equal(evicted.notes.length, DISTILL_MAX_NOTES);
  assert.equal(evicted.notes[0], 'n1', 'n0 (oldest) was evicted');
  assert.equal(evicted.notes[evicted.notes.length - 1], '最新一条');
});

function fakeLog() {
  const lines = { info: [], warn: [] };
  return { lines, info: (m) => lines.info.push(m), warn: (m) => lines.warn.push(m) };
}

test('distill middleware: strips markers even with NO memory asset bound (protocol never leaks)', async () => {
  const log = fakeLog();
  const mw = createDistillMiddleware({ getMemory: () => null, writeNotes: () => { throw new Error('must not persist'); }, log });
  const out = await mw.onOutbound('回复正文\n<!--wao-memory:Q → A-->', { bot: { id: 'b1', assets: [] } });
  assert.equal(out, '回复正文');
  assert.match(log.lines.warn.join('\n'), /未绑定 memory 资产/);
});

test('distill middleware: appends into the first bound memory asset and returns clean text', async () => {
  const log = fakeLog();
  const memory = { assetId: 'ast-m1', mode: 'shared', notes: ['旧知识'] };
  const updates = [];
  const mw = createDistillMiddleware({
    getMemory: (bot) => bot.assets.some((b) => b.assetId === 'ast-m1') ? memory : null,
    writeNotes: async (bot, assetId, notes) => { updates.push({ botId: bot.id, assetId, notes }); },
    log,
  });
  const out = await mw.onOutbound(
    '结论在这里。\n<!--wao-memory:问题甲 → 答案甲-->\n<!--wao-memory:问题甲 → 答案甲-->',
    { bot: { id: 'b1', assets: [{ assetId: 'ast-m1' }, { assetId: 'ast-other' }] } },
  );
  assert.equal(out, '结论在这里。');
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], { botId: 'b1', assetId: 'ast-m1', notes: ['旧知识', '问题甲 → 答案甲'] }, 'duplicate marker persisted once');
  assert.match(log.lines.info.join('\n'), /\+1 条记忆/);
});

test('distill middleware: no new notes → no persistence call; non-marker text untouched', async () => {
  const mw = createDistillMiddleware({
    getMemory: () => ({ assetId: 'a', mode: 'shared', notes: ['已有此条'] }),
    writeNotes: () => { throw new Error('must not persist a no-op'); },
  });
  const out = await mw.onOutbound('正文\n<!--wao-memory:已有此条-->', { bot: { id: 'b', assets: [{ assetId: 'a' }] } });
  assert.equal(out, '正文');
  const untouched = await mw.onOutbound('plain', {});
  assert.equal(untouched, 'plain');
});

// exclusive 生效目标（2026-11-11 接口升级）：getMemory 返回快照 notes（mode
// exclusive），写回走同一条 writeNotes（plugin.js 的 applyMemoryNotes 路由
// 快照覆写）——快照记忆从此也能收到蒸馏写回。
test('distill middleware: exclusive snapshot target carries mode and snapshot notes', async () => {
  const log = fakeLog();
  const written = [];
  const mw = createDistillMiddleware({
    getMemory: () => ({ assetId: 'ast-m1', mode: 'exclusive', notes: ['快照旧知识'] }),
    writeNotes: async (bot, assetId, notes) => { written.push({ assetId, mode: 'exclusive', notes }); },
    log,
  });
  const out = await mw.onOutbound('正文\n<!--wao-memory:新条目-->', { bot: { id: 'b1', assets: [{ assetId: 'ast-m1', mode: 'exclusive' }] } });
  assert.equal(out, '正文');
  assert.deepEqual(written, [{ assetId: 'ast-m1', mode: 'exclusive', notes: ['快照旧知识', '新条目'] }]);
  assert.match(log.lines.info.join('\n'), /独立副本/);
});

test('every provider memory writer carries the distillation footer (marker protocol present)', () => {
  for (const [name, md] of [['claude', claudeMemory], ['codex', codexMemory], ['pi', piMemory]]) {
    const text = md({ name: '业务记忆', content: { notes: ['一条'] } });
    assert.ok(text.includes('<!--wao-memory:'), `${name} memoryMarkdown instructs the marker protocol`);
    assert.ok(text.includes('跨会话记忆'), `${name} keeps the section header`);
  }
});


test('extractMemoryUpdates tolerates CRLF line endings (windows-shaped model output)', () => {
  const text = '结论。\r\n<!--wao-memory:Q → A-->\r\n';
  const { cleanText, entries } = extractMemoryUpdates(text);
  assert.deepEqual(entries, ['Q → A']);
  assert.ok(!cleanText.includes('wao-memory'), 'marker stripped despite CRLF');
});

// 2026-11-10 PC1 真机教训：新会话丢失上下文后，bot 为「怎么查 SLS」考古翻历史、
// 找脚本，单轮空转烧掉 21.5 万 token。根因之一是记忆只沉淀了「查哪个库」（事实）
// 没沉淀「用什么工具查」（方法）。footer 必须把「操作路径/用什么工具」列为最优先
// 沉淀项并给方法形示例——四家 provider 一致。
test('distill footer: 操作路径（用什么工具/命令/参数）优先沉淀，四家一致', () => {
  for (const [name, footer] of [['claude', claudeFooter], ['codex', codexFooter], ['pi', piFooter], ['dsh', dshFooter]]) {
    assert.ok(footer.includes('操作路径'), `${name}: 提到操作路径`);
    assert.ok(/最该沉淀的是「操作路径」/.test(footer), `${name}: 操作路径列为最优先`);
    assert.ok(/用什么工具\/命令\/参数/.test(footer), `${name}: 明确方法=工具/命令/参数`);
    assert.ok(/wao-memory:查某业务日志 → 用 MCP 工具/.test(footer), `${name}: 带方法形示例`);
    assert.ok(footer.includes('绝不为输出而输出'), `${name}: 保留防滥用闸`);
  }
});
