// W3 T2 provider asset-face unit tests: the pure format builders exported by
// the four provider plugins. Pins: dsh combinePersonaPrefix (单一组合器 —
// empty plan must stay byte-identical to the pre-asset era, asset order =
// binding order), codex mcpTomlBlock (quoted table names, env_vars extraction
// for ${VAR}, TOML escaping, scalars-before-subtables), claude/pi mcp document
// builders (wao- prefixes, sorted keys, V9 marker), and the 复制即契约 pin —
// skillMarkdown/RIPGREP_GUIDANCE byte-identical across all four providers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combinePersonaPrefix, skillMarkdown as dshSkill, RIPGREP_GUIDANCE as dshRg } from '../../plugins/provider-dsh/plugin.js';
import { skillMarkdown as claudeSkill, RIPGREP_GUIDANCE as claudeRg, claudeMcpDocument } from '../../plugins/provider-claude/plugin.js';
import { skillMarkdown as codexSkill, RIPGREP_GUIDANCE as codexRg, mcpTomlBlock } from '../../plugins/provider-codex/plugin.js';
import { skillMarkdown as piSkill, RIPGREP_GUIDANCE as piRg, piMcpDocument } from '../../plugins/provider-pi/plugin.js';

const ENTRY = (over = {}) => ({ assetId: 'ast-x1', type: 'skill', name: 'wao-company', mode: 'shared', content: { name: 'wao-company', description: '描述', body: '# 正文' }, ...over });

test('skillMarkdown + RIPGREP_GUIDANCE are byte-identical across the four providers (复制即契约)', () => {
  const docs = [dshSkill(ENTRY()), claudeSkill(ENTRY()), codexSkill(ENTRY()), piSkill(ENTRY())];
  for (const d of docs.slice(1)) assert.equal(d, docs[0]);
  assert.match(docs[0], /^---\nname: wao-company\ndescription: 描述\nx-wao-asset: ast-x1\n---\n\n# 正文\n$/);
  const guides = [dshRg, claudeRg, codexRg, piRg];
  for (const g of guides.slice(1)) assert.equal(g, guides[0]);
  assert.match(guides[0], /rg -t js/);
  // description with newlines flattens (frontmatter-safe)
  const multi = dshSkill(ENTRY({ content: { name: 's', description: '行1\n行2', body: 'b' } }));
  assert.match(multi, /^description: 行1 行2$/m);
});

test('dsh combinePersonaPrefix: empty plan = operator prompt alone (pre-asset bytes); assets in binding order; mcp/rtk sections never emitted', () => {
  assert.equal(combinePersonaPrefix('  人设文本  \n', []), '人设文本');
  assert.equal(combinePersonaPrefix(undefined, []), '');
  const combined = combinePersonaPrefix('人设', [
    ENTRY({ type: 'prompt', name: 'style', content: { text: '简短' } }),
    ENTRY({ type: 'memory', name: 'mem', content: { notes: ['n1'] } }),
    ENTRY({ type: 'skill' }),
    ENTRY({ type: 'tool', name: 'rg', content: { kind: 'ripgrep', options: {} } }),
    ENTRY({ type: 'mcp', content: { servers: {} } }),      // never reaches (bind refusal)
    ENTRY({ type: 'tool', content: { kind: 'rtk' } }),      // never reaches (bind refusal)
  ]);
  const order = ['【WAO 提示词约束：style】', '【WAO 跨会话记忆：mem】', '【WAO 技能：wao-company】', '【WAO 工具指引：ripgrep】']
    .map((h) => combined.indexOf(h));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'sections in binding order');
  assert.ok(order.every((i) => i >= 0));
  assert.ok(!combined.includes('MCP'), 'mcp entries never produce a section (bind refusal upstream)');
  assert.ok(!combined.includes('rtk'), 'rtk section never emitted');
  // deterministic: a rebuild of a single-asset plan equals that plan's prefix
  const solo = combinePersonaPrefix('人设', [ENTRY({ type: 'prompt', name: 'style', content: { text: '简短' } })]);
  assert.ok(combined.startsWith(`${solo}\n\n【WAO 跨会话记忆：mem】`), 'same content → same bytes (§3.5)');
});

test('codex mcpTomlBlock: stdio literal+${VAR} split, quoted table names, escaping, http header refs', () => {
  const stdio = mcpTomlBlock('company', { command: 'node "x"', args: ['a"b'], env: { TOKEN: 'sk', REF: '${GATEWAY_TOKEN}' } });
  assert.equal(stdio, [
    '[mcp_servers."wao-company"]',
    'command = "node \\"x\\""',
    'args = ["a\\"b"]',
    'env_vars = ["GATEWAY_TOKEN"]',
    '',
    '[mcp_servers."wao-company".env]',
    'TOKEN = "sk"',
  ].join('\n'));
  const http = mcpTomlBlock('docs', { type: 'http', url: 'https://x.example/', headers: { 'X-K': 'v', 'X-Ref': '${HDR}' } });
  assert.match(http, /\[mcp_servers\."wao-docs"\]\nurl = "https:\/\/x\.example\/"/);
  assert.match(http, /\.http_headers\]\nX-K = "v"/);
  assert.match(http, /\.env_http_headers\]\nX-Ref = "HDR"/);
});

test('claude/pi mcp documents: wao- prefixes, sorted server keys, shapes as-is; pi carries the V9 marker', () => {
  const plan = [ENTRY({ type: 'mcp', name: 'm', content: { servers: { zzz: { command: 'a' }, aaa: { type: 'http', url: 'https://x/' } } } })];
  const claude = claudeMcpDocument(plan);
  assert.deepEqual(Object.keys(claude.mcpServers), ['wao-aaa', 'wao-zzz']);
  assert.deepEqual(claude.mcpServers['wao-aaa'], { type: 'http', url: 'https://x/' });
  const pi = piMcpDocument('b1', plan);
  assert.equal(pi['x-wao-managed'], true);
  assert.equal(pi['x-wao-bot-id'], 'b1');
  assert.deepEqual(Object.keys(pi.mcpServers), ['wao-aaa', 'wao-zzz']);
});
