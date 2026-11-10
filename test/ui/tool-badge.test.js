// ToolBadge 装备态徽章（_legacy/assets.js，robots.js 工具 tab 复用）。
// 2026-11-10 用户困惑修复：中间件型工具资产（cost-tracker）经引擎中间件链生效、
// 不物化文件，物化清单天然无记录——须显示「中间件·免物化」而非误导的「未物化」。
// 用 recording h（返回 [tag, props, ...children]）断言文案，无需 DOM。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolBadge } from '../../plugins/ui-workbench/ui/_legacy/assets.js';

const h = (...args) => args;
const textOf = (node) => (Array.isArray(node) ? node.slice(2) : [])
  .map((c) => (typeof c === 'string' ? c : '')).join('');

test('ToolBadge: middleware tool kind with no manifest entry → 中间件·免物化 (not 未物化)', () => {
  const node = ToolBadge({ h, entry: null, kind: 'cost-tracker' });
  assert.equal(textOf(node), '中间件·免物化');
  assert.match(node[1].title, /中间件插件/);
});

test('ToolBadge: non-middleware tool with no manifest entry → 未物化 (unchanged)', () => {
  assert.equal(textOf(ToolBadge({ h, entry: null, kind: 'rtk' })), '未物化');
  assert.equal(textOf(ToolBadge({ h, entry: null })), '未物化');
});

test('ToolBadge: armed/available → 已配置 <version>; unavailable → 未安装', () => {
  assert.equal(textOf(ToolBadge({ h, entry: { state: 'armed', version: 'rtk 1.2.0', kind: 'rtk' }, kind: 'rtk' })), '已配置 rtk 1.2.0');
  assert.equal(textOf(ToolBadge({ h, entry: { state: 'available', version: 'ripgrep 15.2.0', kind: 'ripgrep' }, kind: 'ripgrep' })), '已配置 ripgrep 15.2.0');
  assert.equal(textOf(ToolBadge({ h, entry: { state: 'unavailable', kind: 'rtk' }, kind: 'rtk' })), '未安装');
});

test('ToolBadge: middleware kind but WITH a manifest entry still uses the entry state', () => {
  // 中间件判定只在「无清单条目」分支生效；有条目时照状态走（不越权）。
  assert.equal(textOf(ToolBadge({ h, entry: { state: 'armed', kind: 'cost-tracker' }, kind: 'cost-tracker' })), '已配置 cost-tracker');
});