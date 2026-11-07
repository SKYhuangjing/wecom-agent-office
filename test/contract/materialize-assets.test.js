// W3 T2 contract suite: materializeAssets × the FOUR REAL providers
// (DESIGN-ASSETS §3/§10). Each provider plugin is loaded through the real
// kernel machinery (importPlugin + lifecycle.activate, the provider.contract
// pattern) and driven through the REAL core materializer
// (createMaterializer) — providers plan, the executor owns disk, exactly the
// production split. Per provider: every asset type's minimal closure (path +
// content shape), idempotence (two materializations byte-identical, §3.5),
// plan immutability (§3.1 可变引用纪律), foreign-content zero-touch + clean
// unload, the §3.4 half-deleted TOML/Markdown states, provider-specific
// faces (dsh personaPrefix combiner incl. 「改模型」; claude mcp 0600 + ${VAR}
// passthrough (V8) + runner --mcp-config/--append-system-prompt argv (fake
// CLI); codex AGENTS.md/config.toml + env_vars (V8); pi mcp.json marker
// (V9) + runner --skill argv (fake CLI)).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEventBus } from '../../src/kernel/events.js';
import { createServices } from '../../src/kernel/services.js';
import { createHttpShell } from '../../src/kernel/http.js';
import { createLifecycle } from '../../src/kernel/lifecycle.js';
import { importPlugin, validateManifest } from '../../src/kernel/loader.js';
import { createMaterializer } from '../../plugins/core-engine/materializer.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fakeLog = () => {
  const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };
  return { log };
};

// Boot one provider plugin → { portId, impl, lifecycle, plugin, stop() }.
const bootProvider = async (pluginDir) => {
  const rec = await importPlugin(pluginDir);
  const errors = validateManifest(rec.manifest);
  if (errors.length > 0) throw new Error(`manifest invalid: ${errors.join('; ')}`);
  const { log } = fakeLog();
  const lifecycle = createLifecycle({ events: createEventBus({ log }), services: createServices(), log, http: createHttpShell({ log }) });
  const plugin = { dir: pluginDir, manifest: rec.manifest, mod: rec.mod.default, status: 'enabled', config: {} };
  await lifecycle.activate(plugin);
  const registry = lifecycle.portRegistry.provider;
  const portId = [...registry.keys()][0];
  const impl = registry.get(portId).impl;
  const stop = async () => { try { await lifecycle.deactivate(plugin); } catch { /* best effort */ } };
  return { portId, impl, lifecycle, plugin, stop };
};

// A materializer over one booted provider.
const matOver = (impl, dataDir) => createMaterializer({
  ports: { getProvider: () => impl },
  dataDir,
  log: { info() {}, warn() {}, error() {} },
});

// Shared plan fixtures (§4 shapes; binding order = array order).
const mkPlan = (entries) => entries;
const SKILL = { assetId: 'ast-s1', type: 'skill', name: 'wao-company', mode: 'shared', content: { name: 'wao-company', description: '公司技能：被问到公司流程时使用', body: '# 公司流程\n1. 先查台账\n2. 再回复' } };
const PROMPT = { assetId: 'ast-p1', type: 'prompt', name: 'style', mode: 'shared', content: { text: '回答保持简短。' } };
const MEMORY = { assetId: 'ast-m1', type: 'memory', name: 'mem', mode: 'shared', content: { notes: ['台账在 /data/ledger', '人工备注：周会周三'] } };
const MCP = {
  assetId: 'ast-c1', type: 'mcp', name: 'company-mcp', mode: 'shared',
  content: {
    servers: {
      company: { command: 'node', args: ['server.js'], env: { TOKEN: 'sk-literal', REF: '${GATEWAY_TOKEN}' } },
      docs: { type: 'http', url: 'https://docs.example.com/mcp', headers: { 'X-K': 'v', 'X-Ref': '${HDR_TOKEN}' } },
    },
  },
};
const RIPGREP = { assetId: 'ast-r1', type: 'tool', name: 'rg', mode: 'shared', content: { kind: 'ripgrep', options: { extraHints: '优先 -t 过滤' } } };

// Snapshot every existing file under a dir (byte map) — idempotence/rollback
// comparisons read the world, not expectations. manifest.json is EXCLUDED:
// its lastMaterializedAt legitimately advances; §3.5 idempotence is about the
// ASSET PRODUCTS, which must be byte-stable.
const snapshotDir = (dir) => {
  const out = {};
  const walk = (d) => {
    let entries = [];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name !== 'manifest.json') out[p] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
};

let root;
before(() => { root = mkdtempSync(join(tmpdir(), 'wao-mat-contract-')); });
after(() => { rmSync(root, { recursive: true, force: true }); });

const scenario = (name) => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};

// Deep-clone helper for the plan-immutability contract.
const deepClone = (v) => structuredClone(v);

// ————————————————————————————————————————————————————————————————————————————
// dsh — personaPrefix 单一组合器 + .wao/skills tree (§3.3)
// ————————————————————————————————————————————————————————————————————————————

test('dsh: skill/prompt/memory/ripgrep ride personaPrefix + .wao skills; rtk refused (>32 serverId cap in the mcp test below); idempotent; plan untouched', async () => {
  const booted = await bootProvider(join(REPO, 'plugins/provider-dsh'));
  try {
    const sc = scenario('dsh');
    const dshHome = join(sc, 'dsh-home');
    process.env.DSH_HOME = dshHome;
    const cwd = join(sc, 'cwd');
    mkdirSync(cwd, { recursive: true });
    const dataDir = join(sc, 'data');
    const mat = matOver(booted.impl, dataDir);
    const bot = { id: 'dsh-b1', provider: 'dsh', providerConfig: { cwd, model: { provider: 'x', model: 'm1', baseURL: 'http://gw.local', api: 'anthropic-messages', contextWindow: 128000 } } };

    // bind-time support (§2.3): mcp is SUPPORTED on dsh now (W3 T6, profile
    // rows via dsh-mcp-client) — only the >32-char serverName cap refuses;
    // rtk stays refused (F27)
    assert.deepEqual(mat.checkBind(bot, MCP), [], 'dsh mcp binding allowed (W3 T6)');
    const longId = { type: 'mcp', name: 'long', content: { servers: { ['a'.repeat(33)]: { command: 'x' } } } };
    assert.ok(mat.checkBind(bot, longId).some((e) => /上限 32 字符/), 'serverName cap refused (SERVER_NAME_PATTERN)');
    assert.ok(mat.checkBind(bot, { type: 'tool', content: { kind: 'rtk' } }).some((e) => /dsh 岗位不支持 rtk/));

    const plan = mkPlan([SKILL, PROMPT, MEMORY, RIPGREP]);
    const before = deepClone(plan);
    const r1 = await mat.materialize(bot, plan);
    assert.deepEqual(deepClone(plan), before, 'plan entries read-only (§3.1 可变引用纪律)');

    const patch = join(dshHome, 'profiles', 'wecom-dsh-b1', 'cordis.patch.yml');
    assert.ok(existsSync(patch), 'profile patch written under DSH_HOME');
    const patchText = readFileSync(patch, 'utf8');
    // 单一组合器: operator prompt 在前（无 prompt 时资产节即全文），资产按绑定序
    assert.match(patchText, /【WAO 技能：wao-company】[\s\S]*?【WAO 提示词约束：style】[\s\S]*?【WAO 跨会话记忆：mem】[\s\S]*?【WAO 工具指引：ripgrep】/, 'asset sections in binding order');
    assert.match(patchText, /台账在 \/data\/ledger/);
    assert.match(patchText, /\.wao\/skills\/wao-company\/SKILL\.md/, 'skill index points at the file');
    const skillFile = join(cwd, '.wao', 'skills', 'wao-company', 'SKILL.md');
    assert.ok(existsSync(skillFile));
    assert.match(readFileSync(skillFile, 'utf8'), /^x-wao-asset: ast-s1$/m);

    // idempotence: byte-identical across materializations
    const snap1 = snapshotDir(sc);
    await mat.materialize(bot, plan);
    assert.deepEqual(snapshotDir(sc), snap1, 'second materialization byte-identical (§3.5)');

    // 「dsh 改模型」contract (P0-4): materializeConfig with the SAME plan but
    // a changed model → personaPrefix asset section byte-identical
    const prefixOf = (text) => {
      const m = /personaPrefix: \|-\n([\s\S]*?)(?:\n\s*- id:|\n\z|$)/.exec(text);
      return m == null ? null : m[1];
    };
    const botV2 = { ...bot, providerConfig: { ...bot.providerConfig, model: { provider: 'x', model: 'm2-CHANGED', baseURL: 'http://gw.local', api: 'anthropic-messages', contextWindow: 256000 } } };
    await booted.impl.materializeConfig(botV2, { assets: plan, log: fakeLog().log });
    const patchV2 = readFileSync(patch, 'utf8');
    assert.match(patchV2, /model: m2-CHANGED/, 'model row actually changed');
    assert.equal(prefixOf(patchV2), prefixOf(patchText), 'personaPrefix asset section byte-identical after model-only change');
    // and materializeConfig WITHOUT the plan (old callers) drops nothing here
    // because assets are absent → operator prompt only; that is the empty-plan
    // contract, not the model-change path — the API always passes the plan.

    // unload: empty plan → .wao tree gone, profile keeps its patch (profile
    // is materializeConfig's product, not an asset product)
    await mat.materialize(bot, []);
    assert.ok(!existsSync(skillFile));
    assert.ok(!existsSync(join(cwd, '.wao')), 'emptied .wao namespace dir removed (§3.6)');
    assert.ok(existsSync(patch), 'profile patch survives (owned by materializeConfig)');
  } finally {
    delete process.env.DSH_HOME;
    await booted.stop();
  }
});

// ————————————————————————————————————————————————————————————————————————————
// dsh — mcp profile rows via @deepseek-ai/dsh-mcp-client (W3 T6): stdio+http
// shapes, plaintext env/headers, idempotence, 「改模型」keeps the rows (P0-4
// 同型防线), unload drops them, bind-time serverName cap
// ————————————————————————————————————————————————————————————————————————————

test('dsh: mcp stdio+streamable-http rows ride the profile patch (dsh-mcp-client); idempotent; model-change keeps rows; unload drops them', async () => {
  const booted = await bootProvider(join(REPO, 'plugins/provider-dsh'));
  try {
    const sc = scenario('dsh-mcp');
    const dshHome = join(sc, 'dsh-home');
    process.env.DSH_HOME = dshHome;
    const cwd = join(sc, 'cwd');
    mkdirSync(cwd, { recursive: true });
    const mat = matOver(booted.impl, join(sc, 'data'));
    const bot = { id: 'dsh-m1', provider: 'dsh', providerConfig: { cwd, prompt: '你是值班助手。', model: { provider: 'x', model: 'm1', baseURL: 'http://gw.local', api: 'anthropic-messages', contextWindow: 128000 } } };

    const plan = mkPlan([MCP]);
    const before = deepClone(plan);
    const r1 = await mat.materialize(bot, plan);
    assert.deepEqual(deepClone(plan), before, 'plan untouched');
    assert.ok(r1.notes.some((n) => /MCP → profile 行 mcp-\{company,docs\}/), 'receipt names the profile rows');

    const patch = join(dshHome, 'profiles', 'wecom-dsh-m1', 'cordis.patch.yml');
    const text = readFileSync(patch, 'utf8');
    // stdio row: dsh-mcp-client README shape, env values VERBATIM (no ${VAR}
    // expansion semantics on this face — plaintext rides the 0600 patch)
    assert.match(text, new RegExp([
      '- id: mcp-company',
      String.raw`  name: '@deepseek-ai/dsh-mcp-client'`,
      '  config:',
      '    serverName: company',
      '    transport: stdio',
      '    command: "node"',
      '    args: \\["server\\.js"\\]',
      '    env:',
      '      REF: "\\$\\{GATEWAY_TOKEN\\}"',
      '      TOKEN: ".*"',
    ].join('\\n'), 'm'), 'stdio row in dsh-mcp-client shape');
    // http row: transport flips to streamable-http + url/headers
    assert.match(text, new RegExp([
      '- id: mcp-docs',
      String.raw`  name: '@deepseek-ai/dsh-mcp-client'`,
      '  config:',
      '    serverName: docs',
      '    transport: streamable-http',
      '    url: "https://docs\\.example\\.com/mcp"',
      '    headers:',
      '      X-K: "v"',
    ].join('\\n'), 'm'), 'streamable-http row with url+headers');
    // the patch stays owner-only: atomicWrite's 0600 (plaintext env contract)
    assert.equal(statSync(patch).mode & 0o777, 0o600, 'patch 0600 — plaintext env/headers ride an owner-only file');

    // idempotence (§3.5): second materialization byte-identical
    const snap1 = snapshotDir(sc);
    await mat.materialize(bot, plan);
    assert.deepEqual(snapshotDir(sc), snap1, 'second materialization byte-identical');

    // 「dsh 改模型」P0-4 同型: materializeConfig with the SAME plan but a
    // changed model rebuilds the WHOLE patch — mcp rows byte-identical
    const rowsOf = (t) => t.slice(t.indexOf('\n- id: mcp-'));
    const botV2 = { ...bot, providerConfig: { ...bot.providerConfig, model: { provider: 'x', model: 'm2-CHANGED', baseURL: 'http://gw.local', api: 'anthropic-messages', contextWindow: 256000 } } };
    await booted.impl.materializeConfig(botV2, { assets: plan, log: fakeLog().log });
    const textV2 = readFileSync(patch, 'utf8');
    assert.match(textV2, /model: m2-CHANGED/, 'model row actually changed');
    assert.equal(rowsOf(textV2), rowsOf(text), 'mcp rows byte-identical after a model-only change (P0-4 同型防线)');

    // unload: empty plan → mcp rows gone (whole-file rebuild), patch survives
    await mat.materialize(botV2, []);
    const textAfter = readFileSync(patch, 'utf8');
    assert.ok(!textAfter.includes('mcp-'), 'mcp rows dropped on unload');
    assert.match(textAfter, /model: m2-CHANGED/, 'providerConfig rows survive (materializeConfig owns them)');
  } finally {
    delete process.env.DSH_HOME;
    await booted.stop();
  }
});



test('claude: dedicated dir faces (V1), CLAUDE.md marker section, mcp 0600 + ${VAR} passthrough (V8), idempotent, foreign content survives', async () => {
  const booted = await bootProvider(join(REPO, 'plugins/provider-claude'));
  try {
    const sc = scenario('claude');
    const cfgDir = join(sc, 'claude-home');
    const dataDir = join(sc, 'data');
    // user-owned content in the redirect: settings + pre-existing CLAUDE.md text
    mkdirSync(cfgDir, { recursive: true });
    mkdirSync(join(sc, 'cwd'), { recursive: true }); // runner spawn cwd
    writeFileSync(join(cfgDir, 'CLAUDE.md'), '# 用户自己的项目记忆\n用户段内容\n');
    const mat = matOver(booted.impl, dataDir);
    const bot = { id: 'cl-b1', provider: 'claude', providerConfig: { cwd: join(sc, 'cwd'), claudeConfigDir: cfgDir, prompt: '你是客服。' } };

    const plan = mkPlan([SKILL, PROMPT, MEMORY, MCP, RIPGREP]);
    const before = deepClone(plan);
    await mat.materialize(bot, plan);
    assert.deepEqual(deepClone(plan), before, 'plan untouched');

    const skillFile = join(cfgDir, 'skills', 'wao-company', 'SKILL.md');
    assert.ok(existsSync(skillFile), 'skill under $CLAUDE_CONFIG_DIR/skills (V1 verified face)');
    const skillText = readFileSync(skillFile, 'utf8');
    assert.match(skillText, /^name: wao-company$/m);
    assert.match(skillText, /^x-wao-asset: ast-s1$/m);
    assert.match(skillText, /# 公司流程/);

    const claudeMd = readFileSync(join(cfgDir, 'CLAUDE.md'), 'utf8');
    assert.match(claudeMd, /^# 用户自己的项目记忆\n用户段内容\n\n<!-- wao:assets:begin:v1:bot=cl-b1 -->$/m, 'user text intact, section appended after');
    assert.match(claudeMd, /## WAO 跨会话记忆：mem/);
    assert.match(claudeMd, /周会周三/);

    const mcpFile = join(dataDir, 'assets', 'cl-b1', 'claude-mcp.json');
    const mcpDoc = JSON.parse(readFileSync(mcpFile, 'utf8'));
    assert.equal(mcpDoc.mcpServers['wao-company'].command, 'node');
    assert.equal(mcpDoc.mcpServers['wao-company'].env.TOKEN, 'sk-literal');
    assert.equal(mcpDoc.mcpServers['wao-company'].env.REF, '${GATEWAY_TOKEN}', 'V8: ${VAR} reference passes through verbatim (claude expands at spawn)');
    assert.equal(mcpDoc.mcpServers['wao-docs'].headers['X-Ref'], '${HDR_TOKEN}');
    assert.equal(statSync(mcpFile).mode & 0o777, 0o600, 'owned mcp file 0600 (§4.2 ③)');
    // server order deterministic
    assert.deepEqual(Object.keys(mcpDoc.mcpServers), ['wao-company', 'wao-docs']);

    const snap1 = snapshotDir(sc);
    await mat.materialize(bot, plan);
    assert.deepEqual(snapshotDir(sc), snap1, 'idempotent bytes');

    // half-deleted markdown marker (single-sided): repair = fresh build
    writeFileSync(join(cfgDir, 'CLAUDE.md'), `# 用户自己的项目记忆\n用户段内容\n\n<!-- wao:assets:begin:v1:bot=cl-b1 -->\n${'残骸'}\n`);
    await mat.materialize(bot, plan);
    assert.equal(readFileSync(join(cfgDir, 'CLAUDE.md'), 'utf8'), snap1[join(cfgDir, 'CLAUDE.md')], 'orphan markdown repaired to the fresh-materialization bytes');

    // targetsFor + runner argv: --append-system-prompt (operator first,
    // assets after, 拼接序通则) + --mcp-config LAST (variadic flag, V7 pitfall
    // — it eats trailing tokens). A shell wrapper around node records argv.
    const enriched = mat.targetsFor(bot, plan);
    const argvProbe = join(sc, 'argv-probe');
    mkdirSync(argvProbe, { recursive: true });
    const wrapper = join(argvProbe, 'claude-wrap.cjs');
    writeFileSync(wrapper, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(join(argvProbe, 'last-argv'))}, process.argv.slice(2).join(' ') + '\\n');\nconsole.log(JSON.stringify({type:'system',subtype:'init',session_id:'probe'}));\nconsole.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ok',session_id:'probe'}));\n`);
    chmodSync(wrapper, 0o755);
    const shWrap = join(argvProbe, 'claude.sh');
    writeFileSync(shWrap, `#!/bin/sh\nexec "${process.execPath}" "${wrapper}" "$@"\n`);
    chmodSync(shWrap, 0o755);
    const runner = booted.impl.createRunner({
      bot,
      providerConfig: { ...bot.providerConfig, claudeBin: shWrap },
      assets: enriched,
      log: fakeLog().log,
    });
    const res = await runner.run({ prompt: 'hi', signal: new AbortController().signal, timeoutMs: 15000 });
    assert.equal(res.code, 'completed');
    const argv = readFileSync(join(argvProbe, 'last-argv'), 'utf8');
    assert.match(argv, /--append-system-prompt 你是客服。\n\n回答保持简短。/, 'operator prompt first, prompt asset after (拼接序通则)');
    assert.match(argv, /rg（ripgrep）/);
    assert.ok(argv.trim().endsWith(`--mcp-config ${mcpFile}`), '--mcp-config last (variadic flag, V7 pitfall)');

    // unload: empty plan → files gone, user CLAUDE.md text kept, mcp file gone
    await mat.materialize(bot, []);
    assert.ok(!existsSync(skillFile));
    assert.ok(!existsSync(mcpFile));
    assert.equal(readFileSync(join(cfgDir, 'CLAUDE.md'), 'utf8'), '# 用户自己的项目记忆\n用户段内容\n', 'user text survives the strip byte-identically');
  } finally {
    await booted.stop();
  }
});

// ————————————————————————————————————————————————————————————————————————————
// codex — AGENTS.md + skills + config.toml marker sections (§3.3)
// ————————————————————————————————————————————————————————————————————————————

test('codex: AGENTS.md prompt/memory 分节, skills under CODEX_HOME (V2), config.toml wao- tables + env_vars (V8), TOML orphan 四态, idempotent', async () => {
  const booted = await bootProvider(join(REPO, 'plugins/provider-codex'));
  try {
    const sc = scenario('codex');
    const home = join(sc, 'codex-home');
    mkdirSync(home, { recursive: true });
    // user-owned config.toml content + AGENTS.md text
    writeFileSync(join(home, 'config.toml'), 'model = "gpt-5"\n\n[mcp_servers.user-own]\ncommand = "keep-me"\n');
    writeFileSync(join(home, 'AGENTS.md'), '# 用户全局指令\n用户段\n');
    const mat = matOver(booted.impl, dataDirOf('codex', sc));
    const bot = { id: 'cx-b1', provider: 'codex', providerConfig: { cwd: join(sc, 'cwd'), codexHome: home } };

    const plan = mkPlan([SKILL, PROMPT, MEMORY, MCP, RIPGREP]);
    const before = deepClone(plan);
    await mat.materialize(bot, plan);
    assert.deepEqual(deepClone(plan), before, 'plan untouched');

    const skillFile = join(home, 'skills', 'wao-company', 'SKILL.md');
    assert.ok(existsSync(skillFile), 'skill under $CODEX_HOME/skills (V2 verified face)');
    assert.match(readFileSync(skillFile, 'utf8'), /^x-wao-asset: ast-s1$/m);

    const agentsMd = readFileSync(join(home, 'AGENTS.md'), 'utf8');
    assert.match(agentsMd, /^# 用户全局指令\n用户段\n\n<!-- wao:assets:begin:v1:bot=cx-b1 -->$/m);
    assert.match(agentsMd, /## WAO 提示词约束：style/);
    assert.match(agentsMd, /## WAO 跨会话记忆：mem/, 'memory 与 prompt 分节');
    assert.ok(agentsMd.indexOf('提示词约束') < agentsMd.indexOf('跨会话记忆'), 'binding order preserved inside the section');

    const toml = readFileSync(join(home, 'config.toml'), 'utf8');
    assert.match(toml, /^model = "gpt-5"$/m, 'user config intact');
    assert.match(toml, /\[mcp_servers\.user-own\]\ncommand = "keep-me"/, 'user mcp table intact');
    assert.match(toml, /\[mcp_servers\."wao-company"\]\ncommand = "node"\nargs = \["server\.js"\]/, 'quoted-key wao table');
    assert.match(toml, /env_vars = \["GATEWAY_TOKEN"\]/, 'V8: ${VAR} env reference → env_vars forwarding whitelist');
    assert.match(toml, /\[mcp_servers\."wao-company"\.env\]\nTOKEN = "sk-literal"/);
    assert.match(toml, /\[mcp_servers\."wao-docs"\.env_http_headers\]\nX-Ref = "HDR_TOKEN"/, 'header ${VAR} → env_http_headers');
    assert.match(toml, /\[mcp_servers\."wao-docs"\.http_headers\]\nX-K = "v"/);
    // section at EOF, user tables BEFORE it
    assert.ok(toml.indexOf('[mcp_servers.user-own]') < toml.indexOf('# wao:assets:begin'), 'marker section appended at file end');

    const fresh = snapshotDir(sc);
    await mat.materialize(bot, plan);
    assert.deepEqual(snapshotDir(sc), fresh, 'idempotent bytes');

    // §3.4 半删标记 TOML 四态 (P0-2, mandatory face)
    const states = {
      'no-begin': (t) => t.replace(/^# wao:assets:begin.*\n/m, ''),
      'no-end': (t) => t.replace(/^# wao:assets:end.*\n/m, ''),
      'no-markers': (t) => t.replace(/^# wao:assets:(begin|end).*\n/gm, ''),
      'outside-wao-table': (t) => `${t}\n[mcp_servers."wao-ghost"]\ncommand = "x"\n`,
    };
    const freshToml = fresh[join(home, 'config.toml')];
    for (const [name, mutate] of Object.entries(states)) {
      writeFileSync(join(home, 'config.toml'), mutate(freshToml));
      await mat.materialize(bot, plan);
      assert.equal(readFileSync(join(home, 'config.toml'), 'utf8'), freshToml, `${name}: 清孤儿+重建 = 全新物化逐字节相同`);
    }

    // unload keeps user rows, drops ours
    await mat.materialize(bot, []);
    const tomlAfter = readFileSync(join(home, 'config.toml'), 'utf8');
    assert.equal(tomlAfter, 'model = "gpt-5"\n\n[mcp_servers.user-own]\ncommand = "keep-me"\n', 'user config byte-identical after unload');
    assert.equal(readFileSync(join(home, 'AGENTS.md'), 'utf8'), '# 用户全局指令\n用户段\n', 'user AGENTS.md text survives');
    assert.ok(!existsSync(skillFile));
  } finally {
    await booted.stop();
  }
});

test('codex: cwd fallback faces when codexHome is absent (F3/F9 documented fallbacks)', async () => {
  const booted = await bootProvider(join(REPO, 'plugins/provider-codex'));
  try {
    const sc = scenario('codex-fallback');
    const cwd = join(sc, 'cwd');
    mkdirSync(cwd, { recursive: true });
    const mat = matOver(booted.impl, dataDirOf('codex-fallback', sc));
    const bot = { id: 'cx-b2', provider: 'codex', providerConfig: { cwd } };
    await mat.materialize(bot, mkPlan([SKILL, PROMPT]));
    assert.ok(existsSync(join(cwd, '.agents', 'skills', 'wao-company', 'SKILL.md')), 'skill → <cwd>/.agents/skills (REPO domain)');
    assert.ok(existsSync(join(cwd, 'AGENTS.md')), 'prompt/memory → <cwd>/AGENTS.md');
  } finally {
    await booted.stop();
  }
});

// ————————————————————————————————————————————————————————————————————————————
// pi — agentDir skills + wao-memory.md + mcp.json marker (V9) (§3.3)
// ————————————————————————————————————————————————————————————————————————————

test('pi: skills/memory/mcp into the WAO-namespaced agentDir, x-wao-managed marker (V9), idempotent, foreign mcp.json refused, runner --skill argv', async () => {
  const booted = await bootProvider(join(REPO, 'plugins/provider-pi'));
  try {
    const sc = scenario('pi');
    const agentDir = join(sc, 'agent-wao-pi-b1');
    mkdirSync(join(sc, 'cwd'), { recursive: true }); // runner spawn cwd
    const mat = matOver(booted.impl, dataDirOf('pi', sc));
    const bot = { id: 'pi-b1', provider: 'pi', providerConfig: { cwd: join(sc, 'cwd'), model: { model: 'm1' }, piAgentDir: agentDir } };

    const plan = mkPlan([SKILL, PROMPT, MEMORY, MCP, RIPGREP]);
    const before = deepClone(plan);
    await mat.materialize(bot, plan);
    assert.deepEqual(deepClone(plan), before, 'plan untouched');

    const skillFile = join(agentDir, 'skills', 'wao-company', 'SKILL.md');
    assert.ok(existsSync(skillFile));
    assert.match(readFileSync(skillFile, 'utf8'), /^x-wao-asset: ast-s1$/m);
    const memoryFile = join(agentDir, 'wao-memory.md');
    assert.match(readFileSync(memoryFile, 'utf8'), /台账在 \/data\/ledger/);
    const mcpFile = join(agentDir, 'mcp.json');
    const mcpDoc = JSON.parse(readFileSync(mcpFile, 'utf8'));
    assert.equal(mcpDoc['x-wao-managed'], true, 'V9: marker tolerated by pi (verified, preserved by pi rewrites)');
    assert.equal(mcpDoc['x-wao-bot-id'], 'pi-b1');
    assert.equal(mcpDoc.mcpServers['wao-company'].env.REF, '${GATEWAY_TOKEN}');
    assert.equal(statSync(mcpFile).mode & 0o777, 0o600);

    const snap = snapshotDir(sc);
    await mat.materialize(bot, plan);
    assert.deepEqual(snapshotDir(sc), snap, 'idempotent bytes');

    // targetsFor + runner argv: --skill per skill entry + --append-system-prompt
    // (memory = file TEXT, the V3-fallback form) via fake-pi's last-argv
    const enriched = mat.targetsFor(bot, plan);
    const fakePi = join(REPO, 'test/fake-bin/fake-pi.js');
    chmodSync(fakePi, 0o755);
    const piRunner = booted.impl.createRunner({
      bot,
      providerConfig: { ...bot.providerConfig, piBin: process.execPath },
      assets: enriched,
      log: fakeLog().log,
    });
    // fake-pi records argv into $FAKE_HOME/last-argv when run with FAKE_MODE
    const fakeHome = join(sc, 'fake-home');
    mkdirSync(fakeHome, { recursive: true });
    const shWrap = join(sc, 'pi-wrap.sh');
    writeFileSync(shWrap, `#!/bin/sh\nexport FAKE_MODE="ok"\nexport FAKE_HOME="${fakeHome}"\nexec "${process.execPath}" "${fakePi}" "$@"\n`);
    chmodSync(shWrap, 0o755);
    const runner = booted.impl.createRunner({
      bot,
      providerConfig: { ...bot.providerConfig, piBin: shWrap },
      assets: enriched,
      log: fakeLog().log,
    });
    const res = await runner.run({ prompt: 'hi', signal: new AbortController().signal, timeoutMs: 15000 });
    void piRunner;
    assert.equal(res.code, 'completed', 'fake-pi run completed');
    const argv = readFileSync(join(fakeHome, 'last-argv'), 'utf8');
    assert.ok(argv.includes(`--skill ${skillFile}`), '--skill carries the absolute path');
    assert.match(argv, /--append-system-prompt 回答保持简短。/);
    assert.match(argv, /--append-system-prompt ## WAO 跨会话记忆：mem\n\n台账在 \/data\/ledger/, 'memory appended as file TEXT (V3 fallback form)');

    // foreign mcp.json in a CUSTOM dir refuses (F22 guard twin)
    const foreignDir = join(sc, 'agent-foreign');
    mkdirSync(foreignDir, { recursive: true });
    writeFileSync(join(foreignDir, 'mcp.json'), '{"mcpServers":{"user":"own"}}');
    const foreignBot = { id: 'pi-b2', provider: 'pi', providerConfig: { cwd: join(sc, 'cwd'), model: { model: 'm1' }, piAgentDir: foreignDir } };
    await assert.rejects(mat.materialize(foreignBot, mkPlan([MCP])), /目标已有非 WAO mcp\.json/);
    assert.equal(readFileSync(join(foreignDir, 'mcp.json'), 'utf8'), '{"mcpServers":{"user":"own"}}', 'foreign file untouched');

    // unload
    await mat.materialize(bot, []);
    assert.ok(!existsSync(skillFile));
    assert.ok(!existsSync(mcpFile));
    assert.ok(!existsSync(memoryFile));
  } finally {
    await booted.stop();
  }
});

// ————————————————————————————————————————————————————————————————————————————
// pi — default agentDir (no piAgentDir): the jail must allow the provider's
// own default root (W3 T2 review Critical 1)
// ————————————————————————————————————————————————————————————————————————————

test('pi: bot WITHOUT piAgentDir materializes into the default ~/.pi/agent-wao-<botId> — jail allows the provider default root', async () => {
  const booted = await bootProvider(join(REPO, 'plugins/provider-pi'));
  let prevHome;
  try {
    const sc = scenario('pi-default');
    // os.homedir() reads $HOME at call time on POSIX — point it at the
    // scenario dir so the default root lands in the sandbox, never the real ~.
    prevHome = process.env.HOME;
    const fakeHome = join(sc, 'home');
    mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;
    mkdirSync(join(sc, 'cwd'), { recursive: true });
    const mat = matOver(booted.impl, dataDirOf('pi-default', sc));
    const bot = { id: 'pi-b3', provider: 'pi', providerConfig: { cwd: join(sc, 'cwd'), model: { model: 'm1' } } };

    const plan = mkPlan([SKILL, MCP]);
    await mat.materialize(bot, plan);
    const agentDir = join(fakeHome, '.pi', 'agent-wao-pi-b3');
    assert.ok(existsSync(join(agentDir, 'skills', 'wao-company', 'SKILL.md')), 'skill under the DEFAULT agent dir');
    assert.ok(existsSync(join(agentDir, 'mcp.json')), 'mcp.json under the DEFAULT agent dir');
    // read-only verify agrees (drift-free) on the same default-dir targets
    const v = await mat.verify(bot, plan);
    assert.deepEqual(v.drift, []);
    assert.deepEqual(v.orphans, []);
  } finally {
    if (prevHome !== undefined) process.env.HOME = prevHome; else delete process.env.HOME;
    await booted.stop();
  }
});

// ————————————————————————————————————————————————————————————————————————————
// codex — TOML newline escaping through the REAL materializer (Critical 2)
// ————————————————————————————————————————————————————————————————————————————

test('codex: env value with \\n/\\r/\\t materializes as escaped TOML — never a raw newline inside the quotes, byte-stable', async () => {
  const booted = await bootProvider(join(REPO, 'plugins/provider-codex'));
  try {
    const sc = scenario('codex-nl');
    const home = join(sc, 'codex-home');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.toml'), 'model = "gpt-5"\n');
    const mat = matOver(booted.impl, dataDirOf('codex-nl', sc));
    const bot = { id: 'cx-nl', provider: 'codex', providerConfig: { cwd: join(sc, 'cwd'), codexHome: home } };
    const MCP_NL = {
      assetId: 'ast-c2', type: 'mcp', name: 'company-mcp-nl', mode: 'shared',
      content: { servers: { multiline: { command: 'node', args: ['server.js'], env: { NOTE: '第一行\n第二行', TAB: 'a\tb', CR: 'x\ry' } } } },
    };
    await mat.materialize(bot, mkPlan([MCP_NL]));
    const toml = readFileSync(join(home, 'config.toml'), 'utf8');
    // the registration surface admits \n\r\t; the product must carry them as
    // literal escape sequences — a raw newline would make the host config.toml
    // unparseable TOML (silent poisoning, Critical 2)
    const lines = toml.split('\n');
    assert.ok(lines.includes('NOTE = "第一行\\n第二行"'), 'newline → literal \\n');
    assert.ok(lines.includes('TAB = "a\\tb"'), 'tab → literal \\t');
    assert.ok(lines.includes('CR = "x\\ry"'), 'CR → literal \\r');
    assert.ok(lines.every((l) => !l.includes('\r')), 'no raw CR anywhere in the file');
    const userLine = lines.find((l) => l.startsWith('model ='));
    assert.equal(userLine, 'model = "gpt-5"', 'user row untouched');
    // byte-stable: re-materialization is idempotent (§3.5)
    const snap = snapshotDir(sc);
    await mat.materialize(bot, mkPlan([MCP_NL]));
    assert.deepEqual(snapshotDir(sc), snap, 'idempotent bytes with escaped values');
  } finally {
    await booted.stop();
  }
});

// ————————————————————————————————————————————————————————————————————————————
// claude — owned 真值 (W3 T2 review Minor 1): host file pre-dating our first
// write records owned:false and survives unload by strip, never whole-delete
// ————————————————————————————————————————————————————————————————————————————

test('claude: user-created CLAUDE.md records owned:false and survives unload even when stripped empty; WAO-created products stay owned:true', async () => {
  const booted = await bootProvider(join(REPO, 'plugins/provider-claude'));
  try {
    const sc = scenario('claude-owned');
    const cfgDir = join(sc, 'claude-home');
    mkdirSync(cfgDir, { recursive: true });
    mkdirSync(join(sc, 'cwd'), { recursive: true });
    // the toughest shape: a user-created EMPTY CLAUDE.md — after stripping our
    // section the remainder is empty; owned:false must keep the file in place
    writeFileSync(join(cfgDir, 'CLAUDE.md'), '');
    const ownedDataDir = dataDirOf('claude-owned', sc);
    const mat = matOver(booted.impl, ownedDataDir);
    const bot = { id: 'cl-ow', provider: 'claude', providerConfig: { cwd: join(sc, 'cwd'), claudeConfigDir: cfgDir } };

    // memory rides the CLAUDE.md marker section; mcp rides our owned file
    await mat.materialize(bot, mkPlan([MEMORY, MCP]));
    const manifest = JSON.parse(readFileSync(join(ownedDataDir, 'assets', 'cl-ow', 'manifest.json'), 'utf8'));
    const ownedOf = (p) => manifest.writes.find((w) => w.path === p).owned;
    assert.equal(ownedOf(join(cfgDir, 'CLAUDE.md')), false, 'host file existed at write time → owned:false');
    const mcpFile = join(ownedDataDir, 'assets', 'cl-ow', 'claude-mcp.json');
    assert.equal(ownedOf(mcpFile), true, 'absent at write time (our product) → owned:true');

    // unload: our section stripped, the user-created file SURVIVES (empty)
    await mat.materialize(bot, []);
    assert.ok(existsSync(join(cfgDir, 'CLAUDE.md')), 'user-created CLAUDE.md survives the strip-to-empty unload');
    assert.equal(readFileSync(join(cfgDir, 'CLAUDE.md'), 'utf8'), '', 'back to the user\'s original bytes');
    assert.ok(!existsSync(mcpFile), 'our own product still goes away');

    // bot-DELETE unload path (removeAssets): same rule — host file spared
    await mat.materialize(bot, mkPlan([MEMORY]));
    const r = await mat.removeAssets(bot);
    assert.ok(existsSync(join(cfgDir, 'CLAUDE.md')), 'user-created CLAUDE.md survives removeAssets too');
    assert.equal(readFileSync(join(cfgDir, 'CLAUDE.md'), 'utf8'), '', 'stripped back to the user\'s bytes');
    // and the read-only verify does not flag the spared host file as orphan
    await mat.materialize(bot, mkPlan([MEMORY])); // fresh manifest (removeAssets consumed it)
    await mat.materialize(bot, []);
    const v = await mat.verify(bot, []);
    assert.deepEqual(v.orphans, [], 'stripped host file with our markers gone is not a false orphan');
  } finally {
    await booted.stop();
  }
});

// data dir per scenario (manifests + claude-mcp.json live in the data domain)
function dataDirOf(name, sc) {
  const d = join(sc, `data-${name}`);
  mkdirSync(d, { recursive: true });
  return d;
}
