// 五家 provider 的 knowledgeFace 契约（DESIGN-KNOWLEDGE §4.2）：钩子返回
// {delivery, sections[]}；secret 段必须带标记（core-engine 据此不读内容）；
// 各家送达面与 runner/物化器口径一致（argv 组成 / 盘面路径 / 任务信封）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import claudePlugin from '../../plugins/provider-claude/plugin.js';
import codexPlugin from '../../plugins/provider-codex/plugin.js';
import dshPlugin from '../../plugins/provider-dsh/plugin.js';
import piPlugin from '../../plugins/provider-pi/plugin.js';
import cursorPlugin from '../../plugins/provider-cursor/plugin.js';

const portOf = (plugin) => {
  let port = null;
  plugin.activate({ registerProvider: (_id, p) => { port = p; } });
  return port;
};

const PLAN = [
  { assetId: 'a1', type: 'skill', name: 'wao-company', mode: 'shared', content: { name: 'wao-company', description: 'd', body: '# B' } },
  { assetId: 'a2', type: 'memory', name: 'biz', mode: 'shared', content: { notes: ['n1'] } },
  { assetId: 'a3', type: 'prompt', name: 'style', mode: 'shared', content: { text: '风格约束' } },
  { assetId: 'a4', type: 'mcp', name: 'gw', mode: 'shared', content: { servers: { x: { command: 'node' } } } },
  { assetId: 'a5', type: 'tool', name: 'rg', mode: 'shared', content: { kind: 'ripgrep' } },
];

test('claude knowledgeFace: argv=人设+prompt+ripgrep 合并；记忆/技能给盘面路径；mcp 段 secret', () => {
  const face = portOf(claudePlugin).knowledgeFace(
    { id: 'b1', providerConfig: { cwd: '/w', prompt: '人设文本' } },
    { plan: PLAN, assetsRoot: '/data/assets' },
  );
  const argv = face.sections.find((s) => s.kind === 'argv');
  assert.match(argv.title, /--append-system-prompt/);
  assert.match(argv.text, /人设文本[\s\S]*风格约束[\s\S]*ripgrep/, '与 runner 同口径：人设在前');
  const memSec = face.sections.find((s) => s.title.includes('CLAUDE.md'));
  assert.equal(memSec.paths[0], '/w/CLAUDE.md', '无 claudeConfigDir 落 cwd');
  const skillSec = face.sections.find((s) => s.title.includes('SKILL.md'));
  assert.match(skillSec.paths[0], /w\/\.claude\/skills\/wao-company\/SKILL\.md$/);
  const mcp = face.sections.find((s) => s.secret === true);
  assert.match(mcp.paths[0], /data\/assets\/b1\/claude-mcp\.json$/);
  assert.ok(face.sections.some((s) => s.kind === 'stdin'));
  // claudeConfigDir 重定向面
  const redirected = portOf(claudePlugin).knowledgeFace(
    { id: 'b1', providerConfig: { cwd: '/w', claudeConfigDir: '/cfg' } }, { plan: PLAN },
  );
  assert.match(redirected.sections.find((s) => s.title.includes('CLAUDE.md')).paths[0], /^\/cfg\/CLAUDE\.md$/);
  assert.match(redirected.sections.find((s) => s.title.includes('SKILL.md')).paths[0], /^\/cfg\/skills\//);
});

test('codex knowledgeFace: AGENTS.md/config.toml 盘面；codexHome 重定向；mcp 段 secret', () => {
  const face = portOf(codexPlugin).knowledgeFace(
    { id: 'b1', providerConfig: { cwd: '/w' } }, { plan: PLAN },
  );
  const md = face.sections.find((s) => s.title.includes('AGENTS.md'));
  assert.equal(md.paths[0], '/w/AGENTS.md');
  const toml = face.sections.find((s) => s.secret === true);
  assert.equal(toml.paths[0], '/w/.codex/config.toml');
  const home = portOf(codexPlugin).knowledgeFace(
    { id: 'b1', providerConfig: { cwd: '/w', codexHome: '/ch' } }, { plan: PLAN },
  );
  assert.equal(home.sections.find((s) => s.title.includes('AGENTS.md')).paths[0], '/ch/AGENTS.md');
  assert.equal(home.sections.find((s) => s.secret === true).paths[0], '/ch/config.toml');
});

test('dsh knowledgeFace: personaPrefix 全文（单一组合器同源）；技能盘面 .wao/skills', () => {
  const face = portOf(dshPlugin).knowledgeFace(
    { id: 'b1', providerConfig: { cwd: '/w', prompt: '运营者人设' } }, { plan: PLAN },
  );
  const profile = face.sections.find((s) => s.kind === 'profile');
  assert.match(profile.text, /运营者人设/);
  assert.match(profile.text, /WAO 跨会话记忆：biz/);
  assert.match(profile.text, /n1/);
  assert.match(profile.text, /wao-memory:/, '蒸馏 footer 随节注入');
  const skills = face.sections.find((s) => s.title.includes('.wao/skills'));
  assert.match(skills.paths[0], /\/w\/\.wao\/skills\/wao-company\/SKILL\.md$/);
  assert.ok(face.sections.some((s) => s.secret === true), 'mcp 行段 secret 标记');
});

test('pi knowledgeFace: argv+记忆 wao-memory.md+技能 --skill 说明；mcp.json secret', () => {
  const face = portOf(piPlugin).knowledgeFace(
    { id: 'b1', providerConfig: { cwd: '/w', prompt: '人设' } }, { plan: PLAN },
  );
  const argv = face.sections.find((s) => s.kind === 'argv');
  assert.match(argv.text, /人设[\s\S]*风格约束/);
  const mem = face.sections.find((s) => s.title.includes('wao-memory.md'));
  assert.ok(mem.paths[0].endsWith('wao-memory.md'));
  assert.ok(face.sections.some((s) => s.secret === true));
});

test('cursor knowledgeFace: 无资产绑定面，任务信封仍在', () => {
  const face = portOf(cursorPlugin).knowledgeFace({ id: 'b1', providerConfig: { cwd: '/w' } }, { plan: [] });
  assert.match(face.delivery, /无资产绑定面/);
  assert.equal(face.sections.length, 1);
  assert.equal(face.sections[0].kind, 'stdin');
});

test('五家 sections 形状一致：{kind,title} 必有；file 段 paths 绝对路径', () => {
  for (const [name, plugin] of [['claude', claudePlugin], ['codex', codexPlugin], ['dsh', dshPlugin], ['pi', piPlugin], ['cursor', cursorPlugin]]) {
    const port = portOf(plugin);
    const face = port.knowledgeFace({ id: 'b1', providerConfig: { cwd: '/w' } }, { plan: PLAN });
    assert.equal(typeof face.delivery, 'string', `${name} delivery`);
    for (const s of face.sections) {
      assert.ok(typeof s.title === 'string' && s.title !== '', `${name} section title`);
      assert.ok(['argv', 'file', 'profile', 'stdin', 'inline'].includes(s.kind), `${name} kind ${s.kind}`);
      if (s.kind === 'file') {
        assert.ok(Array.isArray(s.paths) && s.paths.length > 0, `${name} file paths`);
        for (const p of s.paths) assert.ok(p.startsWith('/'), `${name} 绝对路径 ${p}`);
      }
    }
  }
});
