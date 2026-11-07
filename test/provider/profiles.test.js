// Task 18 unit grid: plugins/provider-dsh/profiles.js — the port of the
// production-proven wecom-bots/lib/profiles.js, with the two contractual
// changes (atomicWrite + last-good on throw). DSH_HOME is pointed at a temp
// dir so nothing here touches the real ~/.dsh.
// W3 T6: the MCP asset face rides the SAME patch builder — mcpClientRows
// (pure, dsh-mcp-client README shape) + buildBotPatch's assetsPlan param
// (bot PATCH 重物化不掉 mcp 行, P0-4 同型防线).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeBotProfile, ensureProfileExists, removeProfile, profilePatchPath, buildBotPatch, mcpClientRows } from '../../plugins/provider-dsh/profiles.js';

const withHome = async (fn) => {
  const home = mkdtempSync(join(tmpdir(), 'wao-dsh-home-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
};

// A synthetic headless source profile carrying the borrowed provider table
// (the block readProviderBlock extracts), plus a pre-created target profile
// dir so ensureProfileExists short-circuits without spawning dsh.
const seedHome = (home, targetProfile) => {
  const headlessDir = join(home, 'profiles', 'headless');
  mkdirSync(headlessDir, { recursive: true });
  writeFileSync(join(headlessDir, 'cordis.patch.yml'), [
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '  config:',
    '    providers:',
    '      magpie:',
    '        displayName: magpie',
    '        apiKeyEnv: MAGPIE_API_KEY',
    '        models:',
    '          - id: workbuddy/deepseek-v4.1-flash',
    '- id: some-other-row',
    '  config: {}',
    '',
  ].join('\n'));
  const target = join(home, 'profiles', targetProfile);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'cordis.patch.yml'), ''); // placeholder: ensureProfileExists skips spawn
  return join(headlessDir, 'cordis.patch.yml');
};

test('profiles: writeBotProfile borrowed route — all sections written', async () => {
  await withHome(async (home) => {
    seedHome(home, 'wecom-b1');
    const res = writeBotProfile({
      profile: 'wecom-b1',
      model: { provider: 'magpie', model: 'workbuddy/deepseek-v4.1-flash' },
      permission: 'read-only',
      prompt: '你是严谨的助手。\n回答保持简短。',
      writableDirs: ['/data/logs', '/data/cache'],
      workspaceRoot: '/ws/b1',
      dshBin: 'dsh',
      nodeBin: process.execPath,
      compaction: { enabled: true, thresholdRatio: 0.7 },
    });
    assert.equal(res.profile, 'wecom-b1');
    assert.equal(res.permission, 'read-only');
    assert.equal(res.customProvider, false);
    assert.equal(res.writableDirs.length, 2);
    const text = readFileSync(profilePatchPath('wecom-b1'), 'utf8');
    assert.match(text, /- id: llm-pi-ai\n/, 'borrowed provider table present');
    assert.ok(!text.includes('some-other-row'), 'only the llm-pi-ai block is borrowed');
    assert.match(text, /- id: agent-default-model\n[\s\S]*?provider: magpie\n\s+model: workbuddy\/deepseek-v4\.1-flash/);
    assert.match(text, /- id: permission-presets\n[\s\S]*?defaultPreset: read-only/);
    assert.match(text, /- id: compaction-basic\n[\s\S]*?thresholdRatio: 0\.7\n\s+headroomTokens: 65536\n\s+retainRatio: 0\.16/);
    assert.match(text, /- id: system-prompt\n[\s\S]*?personaPrefix: \|-\n\s+你是严谨的助手。\n\s+回答保持简短。/);
    assert.match(text, /- id: sandbox-policy\n[\s\S]*?mode: read-only\n\s+workspaceRoot: "\/ws\/b1"\n\s+additionalWritableRoots:\n\s+- "\/data\/logs"\n\s+- "\/data\/cache"/);
    assert.ok(!existsSync(`${profilePatchPath('wecom-b1')}.tmp.${process.pid}`), 'no tmp residue after atomic write');
  });
});

test('profiles: custom provider route — slug, apiKeyEnv, contextWindow', async () => {
  await withHome(async (home) => {
    seedHome(home, 'wecom-b2');
    const res = writeBotProfile({
      profile: 'wecom-b2',
      model: { provider: 'My Prov!', model: 'big-model', baseURL: '{{BASEURL_3c80cb}}', api: 'pi-ai', apiKeyEnv: 'BOT_KEY', contextWindow: 200000, maxTokens: 8192 },
      permission: 'workspace-write',
      workspaceRoot: '/ws/b2',
      dshBin: 'dsh',
      nodeBin: process.execPath,
    });
    assert.equal(res.customProvider, true);
    assert.equal(res.model.provider, 'my-prov', 'provider id slugified');
    const text = readFileSync(profilePatchPath('wecom-b2'), 'utf8');
    assert.match(text, /my-prov:\n\s+displayName: "Bot wecom-b2"\n\s+apiKeyEnv: BOT_KEY\n\s+api: pi-ai\n\s+baseURL: "\{\{BASEURL_3c80cb\}\}"/);
    assert.match(text, /contextWindow: 200000\n\s+maxTokens: 8192/);
    assert.match(text, /- id: agent-default-model\n[\s\S]*?provider: my-prov\n\s+model: big-model/);
    assert.match(text, /- id: sandbox-policy\n[\s\S]*?mode: workspace-write\n\s+workspaceRoot: "\/ws\/b2"/);
  });
});

test('profiles: missing model falls back to the 前身 default; permission junk coerces', async () => {
  await withHome(async (home) => {
    seedHome(home, 'wecom-b3');
    const res = writeBotProfile({ profile: 'wecom-b3', model: null, permission: 'yolo', dshBin: 'dsh', nodeBin: process.execPath });
    assert.deepEqual(res.model.provider, 'magpie');
    assert.equal(res.model.model, 'workbuddy/deepseek-v4.1-flash');
    assert.equal(res.permission, 'workspace-write');
    assert.match(readFileSync(profilePatchPath('wecom-b3'), 'utf8'), /defaultPreset: workspace-write/);
  });
});

test('profiles: last-good — a throw leaves the previous file untouched', async () => {
  await withHome(async (home) => {
    seedHome(home, 'wecom-b4');
    writeBotProfile({
      profile: 'wecom-b4', model: { provider: 'magpie', model: 'm1' },
      dshBin: 'dsh', nodeBin: process.execPath,
    });
    const before = readFileSync(profilePatchPath('wecom-b4'), 'utf8');
    // borrowed route against a source profile with no provider block → throws
    assert.throws(
      () => writeBotProfile({ profile: 'wecom-b4', sourceProfile: 'no-such-source', dshBin: 'dsh', nodeBin: process.execPath }),
      /cannot read provider table from profile "no-such-source"/,
    );
    assert.equal(readFileSync(profilePatchPath('wecom-b4'), 'utf8'), before, 'last-good file untouched');
    assert.ok(!existsSync(join(home, 'profiles', 'wecom-b4', `cordis.patch.yml.tmp.${process.pid}`)), 'no tmp residue on throw');
  });
});

test('profiles: ensureProfileExists — existing short-circuits; spawn status honored', async () => {
  await withHome(async (home) => {
    const dir = join(home, 'profiles', 'wecom-b5');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cordis.patch.yml'), 'x');
    const have = ensureProfileExists('wecom-b5', { dshBin: 'dsh', nodeBin: process.execPath });
    assert.equal(have.created, false);
    // /bin/true exits 0 → "created"; /bin/false exits 1 → not created
    const ok = ensureProfileExists('wecom-b6', { dshBin: '/usr/bin/true', nodeBin: process.execPath });
    assert.equal(ok.created, true);
    const bad = ensureProfileExists('wecom-b7', { dshBin: '/usr/bin/false', nodeBin: process.execPath });
    assert.equal(bad.created, false);
    assert.equal(bad.status, 1);
  });
});

test('profiles: removeProfile removes when present, false when absent', async () => {
  await withHome(async (home) => {
    const dir = join(home, 'profiles', 'wecom-b8');
    mkdirSync(join(dir), { recursive: true });
    writeFileSync(join(dir, 'cordis.patch.yml'), 'x');
    assert.equal(removeProfile('wecom-b8'), true);
    assert.ok(!existsSync(dir));
    assert.equal(removeProfile('wecom-b8'), false);
  });
});

// —— W3 T6: MCP asset face ———————————————————————————————————————————————————

const MCP_PLAN = [{
  assetId: 'ast-c1', type: 'mcp', name: 'company-mcp', mode: 'shared',
  content: {
    servers: {
      docs: { type: 'http', url: 'https://docs.example.com/mcp', headers: { 'X-Ref': '${HDR_TOKEN}', 'X-K': 'v' } },
      company: { command: 'node', args: ['server.js'], env: { TOKEN: 'sk-plain-text', REF: '${GATEWAY_TOKEN}' } },
    },
  },
}];

test('mcpClientRows: stdio + streamable-http rows in the dsh-mcp-client shape; servers sorted; env/headers sorted; empty sections omitted', () => {
  assert.equal(mcpClientRows(MCP_PLAN), [
    '- id: mcp-company',
    "  name: '@deepseek-ai/dsh-mcp-client'",
    '  config:',
    '    serverName: company',
    '    transport: stdio',
    '    command: "node"',
    '    args: ["server.js"]',
    '    env:',
    '      REF: "${GATEWAY_TOKEN}"',
    '      TOKEN: "sk-plain-text"',
    '',
    '- id: mcp-docs',
    "  name: '@deepseek-ai/dsh-mcp-client'",
    '  config:',
    '    serverName: docs',
    '    transport: streamable-http',
    '    url: "https://docs.example.com/mcp"',
    '    headers:',
    '      X-K: "v"',
    '      X-Ref: "${HDR_TOKEN}"',
    '',
  ].join('\n'));
  // dsh-mcp-client has no ${VAR} expansion of its own (unlike claude V8):
  // reference-looking values pass through VERBATIM — the operator resolves
  // secrets at asset-creation time; the profile carries plaintext.
  // minimal forms: bare stdio (no args/env) and bare http (no headers) omit
  // the empty sections — dsh-mcp-client defaults args/env/headers to []/{}
  assert.equal(mcpClientRows([{ type: 'mcp', assetId: 'a', name: 'n', mode: 'shared', content: { servers: {
    bare: { command: 'only-cmd' },
    barehttp: { type: 'http', url: 'https://x.example/mcp' },
  } } }]), [
    '- id: mcp-bare',
    "  name: '@deepseek-ai/dsh-mcp-client'",
    '  config:',
    '    serverName: bare',
    '    transport: stdio',
    '    command: "only-cmd"',
    '',
    '- id: mcp-barehttp',
    "  name: '@deepseek-ai/dsh-mcp-client'",
    '  config:',
    '    serverName: barehttp',
    '    transport: streamable-http',
    '    url: "https://x.example/mcp"',
    '',
  ].join('\n'));
  assert.equal(mcpClientRows([]), '', 'no mcp entries → no rows');
  assert.equal(mcpClientRows([{ type: 'skill', assetId: 'a', name: 'n', mode: 'shared', content: {} }]), '', 'non-mcp entries produce no rows');
});

test('mcpClientRows: \\n \\t " \\\\ and CJK escape JSON-style — one physical line each, no raw newline anywhere (YAML-safe)', () => {
  const rows = mcpClientRows([{ type: 'mcp', assetId: 'a', name: 'n', mode: 'shared', content: { servers: {
    esc: { command: 'node', env: { NOTE: '行1\n行2', TAB: 'a\tb', BS: 'a\\b', Q: 'c"d', CJK: '中文值' } },
  } } }]);
  const lines = rows.split('\n');
  assert.ok(lines.includes('      NOTE: "行1\\n行2"'), 'newline → literal \\n escape');
  assert.ok(lines.includes('      TAB: "a\\tb"'), 'tab → literal \\t escape');
  assert.ok(lines.includes('      BS: "a\\\\b"'), 'backslash stays escaped');
  assert.ok(lines.includes('      Q: "c\\"d"'), 'quote stays escaped');
  assert.ok(lines.includes('      CJK: "中文值"'), 'CJK passes through unescaped');
  assert.ok(lines.every((l) => !/\t/.test(l.replace(/\\t/g, ''))), 'no raw tab anywhere');
  // single-pass unescape round-trip decodes back to the original value
  const unescape = (s) => s.replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t', '"': '"', '\\': '\\' }[c] ?? c));
  const m = /NOTE: "(.*)"$/m.exec(rows);
  assert.equal(unescape(m[1]), '行1\n行2', 'round-trips byte-identically');
  // header names carrying YAML indicator characters (! & * # | — all legal per
  // HEADER_NAME) must land QUOTED: bare `!K:` reads as a tag, `#K:` as a
  // comment, `|K:` as a block indicator
  const httpRows = mcpClientRows([{ type: 'mcp', assetId: 'a', name: 'n', mode: 'shared', content: { servers: {
    h: { type: 'http', url: 'https://x/', headers: { '!Tag': 'a', '#Frag': 'b', '|Pipe': 'c', 'X-Normal': 'd' } },
  } } }]);
  const hLines = httpRows.split('\n');
  assert.ok(hLines.includes('      "!Tag": "a"'));
  assert.ok(hLines.includes('      "#Frag": "b"'));
  assert.ok(hLines.includes('      "|Pipe": "c"'));
  assert.ok(hLines.includes('      X-Normal: "d"'), 'plain-safe names stay bare (README style)');
});

test('mcpClientRows: serverId beyond the dsh serverName limit (32, SERVER_NAME_PATTERN) throws — 拒绝优于静默纠正', () => {
  const long = 'a'.repeat(33);
  assert.throws(
    () => mcpClientRows([{ type: 'mcp', assetId: 'a', name: 'n', mode: 'shared', content: { servers: { [long]: { command: 'x' } } } }]),
    new RegExp(`serverId ${long} 超出 dsh-mcp-client serverName 上限 32 字符`),
  );
  // 32 is exactly at the limit → fine
  assert.doesNotThrow(() => mcpClientRows([{ type: 'mcp', assetId: 'a', name: 'n', mode: 'shared', content: { servers: { ['b'.repeat(32)]: { command: 'x' } } } }]));
});

test('buildBotPatch/writeBotProfile: assetsPlan mcp rows ride the SAME patch build (P0-4 同型防线); absent plan = pre-asset bytes', async () => {
  await withHome(async (home) => {
    seedHome(home, 'wecom-b9');
    const opts = {
      profile: 'wecom-b9',
      model: { provider: 'magpie', model: 'workbuddy/deepseek-v4.1-flash' },
      prompt: '你是严谨的助手。',
      workspaceRoot: '/ws/b9',
      dshBin: 'dsh',
      nodeBin: process.execPath,
    };
    writeBotProfile(opts);
    const before = readFileSync(profilePatchPath('wecom-b9'), 'utf8');
    assert.ok(!before.includes('mcp-'), 'no mcp rows without an assetsPlan (pre-asset bytes)');
    // same profile, plan with an mcp asset → rows appended AFTER the existing
    // rows (sandbox-policy stays last among the pre-asset rows)
    writeBotProfile({ ...opts, assetsPlan: MCP_PLAN });
    const withMcp = readFileSync(profilePatchPath('wecom-b9'), 'utf8');
    assert.ok(withMcp.startsWith(before), 'asset era = pre-asset bytes + appended mcp rows only');
    assert.ok(withMcp.includes('id: mcp-company'), 'stdio row present');
    assert.ok(withMcp.includes('id: mcp-docs'), 'http row present');
    assert.ok(withMcp.indexOf('sandbox-policy') < withMcp.indexOf('id: mcp-company'), 'mcp rows appended after sandbox-policy');
    // model-only change THROUGH the same builder keeps the mcp rows (P0-4):
    // materializeConfig passes the effective plan as assetsPlan
    writeBotProfile({ ...opts, model: { provider: 'magpie', model: 'm2-CHANGED' }, assetsPlan: MCP_PLAN });
    const v2 = readFileSync(profilePatchPath('wecom-b9'), 'utf8');
    assert.match(v2, /model: m2-CHANGED/);
    const rowsOf = (t) => t.slice(t.indexOf('\n- id: mcp-'));
    assert.equal(rowsOf(v2), rowsOf(withMcp), 'mcp rows byte-identical after a model-only change');
  });
});
