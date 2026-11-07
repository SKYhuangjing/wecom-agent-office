// W3 T3 contract suite: RTK/ripgrep tool assets over the REAL surfaces.
//   A. REAL rtk (1.1.0 installed at ~/.local/bin/rtk — loud skip when absent)
//      through the REAL provider plugins + REAL core materializer: one full
//      equip/unequip round per flavor (claude settings.json hook entry,
//      codex hooks.json, pi extensions/rtk.ts), asserting the V5-verified
//      shapes on disk + manifest.tools/entries, then `materialize(bot, [])`
//      → rtk uninstall + .bak sweep leaves the config dir clean.
//   B. API-level unavailable binding flow: full kernel boot with
//      $WAO_RTK_BIN pointing nowhere → rtk bind SUCCEEDS (§7.1: binding
//      survives), receipt notes carry the install guidance, GET /api/agents
//      shows the standing assetWarnings; unbind receipt is note-clean.
//   C. ripgrep precheck at the provider planning face: PATH without rg →
//      tools row unavailable + note (指引段 still injected, 预检不失败).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEventBus } from '../../src/kernel/events.js';
import { createServices } from '../../src/kernel/services.js';
import { createHttpShell } from '../../src/kernel/http.js';
import { createLifecycle } from '../../src/kernel/lifecycle.js';
import { importPlugin, validateManifest } from '../../src/kernel/loader.js';
import { createMaterializer, probeBin } from '../../plugins/core-engine/materializer.js';
import { createKernel } from '../../src/index.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fakeLog = () => {
  const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };
  return { log };
};

// rtk presence gate (loud skip, probe.sh convention): the whole suite A is
// about the REAL binary's faces.
const RTK = probeBin('rtk');
const RTK_OK = RTK.ok;
const RTK_SKIP = RTK_OK ? false : `rtk not on PATH (${RTK.error}) — install to run the real equip round`;

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
  return { portId, impl, stop };
};

const RTK_ASSET_CLAUDE = { assetId: 'ast-rtk-c', type: 'tool', name: 'rtk', mode: 'shared', content: { kind: 'rtk' } };
const RTK_ASSET_CODEX = { assetId: 'ast-rtk-x', type: 'tool', name: 'rtk', mode: 'shared', content: { kind: 'rtk' } };
const RTK_ASSET_PI = { assetId: 'ast-rtk-p', type: 'tool', name: 'rtk', mode: 'shared', content: { kind: 'rtk' } };

let root;
before(() => { root = mkdtempSync(join(tmpdir(), 'wao-rtk-contract-')); });
after(() => { rmSync(root, { recursive: true, force: true }); });
const scenario = (name) => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};

test('REAL rtk claude flavor: equip writes the V5 hook entry + RTK.md into $CLAUDE_CONFIG_DIR; unload = rtk uninstall, .bak swept, dir clean', { skip: RTK_SKIP }, async () => {
  const booted = await bootProvider(join(REPO, 'plugins/provider-claude'));
  try {
    const sc = scenario('real-claude');
    const cfgDir = join(sc, 'claude-cfg');
    const dataDir = join(sc, 'data');
    const mat = createMaterializer({ ports: { getProvider: () => booted.impl }, dataDir, log: { info() {}, warn() {}, error() {} } });
    const bot = { id: 'rc-b1', provider: 'claude', providerConfig: { cwd: join(sc, 'cwd'), claudeConfigDir: cfgDir } };

    const r1 = await mat.materialize(bot, [RTK_ASSET_CLAUDE]);
    assert.ok(r1.notes.some((n) => /rtk 已装备（rtk \d+\.\d+\.\d+，flavor claude，主路径）/.test(n.detail)), `armed note: ${JSON.stringify(r1.notes)}`);
    const settings = JSON.parse(readFileSync(join(cfgDir, 'settings.json'), 'utf8'));
    assert.deepEqual(settings.hooks.PreToolUse, [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] }], 'V5-verified hook entry shape');
    assert.ok(existsSync(join(cfgDir, 'RTK.md')), 'RTK.md guidance file');
    assert.match(readFileSync(join(cfgDir, 'CLAUDE.md'), 'utf8'), /@RTK\.md/, '@RTK.md reference line');
    assert.equal(existsSync(join(cfgDir, 'settings.json.bak')), false, 'install-time .bak swept');
    const manifest = JSON.parse(readFileSync(join(dataDir, 'assets', 'rc-b1', 'manifest.json'), 'utf8'));
    const t = manifest.tools.find((x) => x.kind === 'rtk');
    assert.equal(t.state, 'armed');
    assert.match(t.version, /^rtk \d+/);
    assert.deepEqual(manifest.entries, [{ file: join(cfgDir, 'settings.json'), pointer: '/hooks/PreToolUse', entry: settings.hooks.PreToolUse[0], via: 'rtk' }]);

    const r2 = await mat.materialize(bot, []);
    assert.ok(r2.notes.some((n) => /rtk 卸载成功/.test(n.detail)));
    assert.deepEqual(JSON.parse(readFileSync(join(cfgDir, 'settings.json'), 'utf8')), {}, 'hook entry removed by rtk uninstall (empty settings survive)');
    assert.equal(existsSync(join(cfgDir, 'RTK.md')), false, 'RTK.md removed');
    assert.equal(existsSync(join(cfgDir, 'settings.json.bak')), false, 'uninstall .bak residue swept');
  } finally {
    await booted.stop();
  }
});

test('REAL rtk codex flavor: hooks.json entry + AGENTS.md @ref under $CODEX_HOME; unload clean', { skip: RTK_SKIP }, async () => {
  const booted = await bootProvider(join(REPO, 'plugins/provider-codex'));
  try {
    const sc = scenario('real-codex');
    const home = join(sc, 'codex-home');
    const dataDir = join(sc, 'data');
    const mat = createMaterializer({ ports: { getProvider: () => booted.impl }, dataDir, log: { info() {}, warn() {}, error() {} } });
    const bot = { id: 'rc-x1', provider: 'codex', providerConfig: { cwd: join(sc, 'cwd'), codexHome: home } };

    await mat.materialize(bot, [RTK_ASSET_CODEX]);
    const hooks = JSON.parse(readFileSync(join(home, 'hooks.json'), 'utf8'));
    assert.deepEqual(hooks.hooks.PreToolUse, [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook codex' }] }], 'codex hook entry (hooks.json, V5)');
    assert.ok(existsSync(join(home, 'RTK.md')));
    assert.match(readFileSync(join(home, 'AGENTS.md'), 'utf8'), /@.*RTK\.md/, 'AGENTS.md absolute @ref');
    assert.equal(existsSync(join(home, 'hooks.json.bak')), false, 'install .bak swept');

    await mat.materialize(bot, []);
    // 实证（2026-11-07）：rtk codex uninstall 保留空骨架 {"hooks":{"PreToolUse":[]}}
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'hooks.json'), 'utf8')), { hooks: { PreToolUse: [] } }, 'hook entry removed (empty skeleton survives)');
    assert.equal(existsSync(join(home, 'RTK.md')), false);
    assert.equal(existsSync(join(home, 'hooks.json.bak')), false, 'uninstall .bak swept');
  } finally {
    await booted.stop();
  }
});

test('REAL rtk pi flavor: extensions/rtk.ts under $PI_CODING_AGENT_DIR; unload clean', { skip: RTK_SKIP }, async () => {
  const booted = await bootProvider(join(REPO, 'plugins/provider-pi'));
  try {
    const sc = scenario('real-pi');
    const agentDir = join(sc, 'pi-agent');
    const dataDir = join(sc, 'data');
    const mat = createMaterializer({ ports: { getProvider: () => booted.impl }, dataDir, log: { info() {}, warn() {}, error() {} } });
    const bot = { id: 'rc-p1', provider: 'pi', providerConfig: { cwd: join(sc, 'cwd'), model: { model: 'm1' }, piAgentDir: agentDir } };

    const r1 = await mat.materialize(bot, [RTK_ASSET_PI]);
    assert.ok(r1.notes.some((n) => /flavor pi，主路径/.test(n.detail)), `armed note: ${JSON.stringify(r1.notes)}`);
    assert.ok(existsSync(join(agentDir, 'extensions', 'rtk.ts')), 'pi extension installed');

    const r2 = await mat.materialize(bot, []);
    assert.ok(r2.notes.some((n) => /rtk 卸载成功/.test(n.detail)));
    assert.equal(existsSync(join(agentDir, 'extensions', 'rtk.ts')), false, 'extension removed');
  } finally {
    await booted.stop();
  }
});

// ————————————————————————————————————————————————————————————————————————————
// B. API-level unavailable binding flow (§7.1 state 1 over the real API)
// ————————————————————————————————————————————————————————————————————————————

const FAKE_CHANNEL = `
export default {
  manifest: { id: 'channel-fake', name: 'Fake Channel', type: 'channel', version: '0.1.0', requires: { kernel: '^1' } },
  activate(ctx) {
    ctx.registerChannel('fakechan', {
      accountSchema: [{ key: 'endpoint', label: 'Endpoint', type: 'string', required: true }],
      capabilities: { stream: true, push: true, group: true, welcome: false, maxContentChars: 3500, minIntervalMs: 10, heartbeatMs: 60000, streamDeadlineMs: 600000 },
      createAdapter({ engine }) {
        return { engine, start() {}, stop() {}, status() { return { state: 'online', lastError: null }; }, ack() {}, progress() {}, reply() {}, welcome() {}, push() {} };
      },
    });
  },
};`;

test('API unavailable flow: rtk bind succeeds with rtk missing — receipt notes + agents assetWarnings carry the install guidance; unbind clean', async () => {
  const sc = scenario('api-unavailable');
  const fakesDir = join(sc, 'fakes');
  mkdirSync(join(fakesDir, 'channel-fake'), { recursive: true });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(fakesDir, 'channel-fake', 'plugin.js'), FAKE_CHANNEL);
  writeFileSync(join(fakesDir, 'channel-fake', 'package.json'), '{"type":"module"}\n');
  // point the kernel's materializer at a missing rtk (§7.1 state 1)
  const prevRtkBin = process.env.WAO_RTK_BIN;
  process.env.WAO_RTK_BIN = join(sc, 'no-such-rtk');
  const kernel = await createKernel({ port: 0, dataDir: join(sc, 'data'), pluginsDirs: [fakesDir, join(REPO, 'plugins')] });
  try {
    const url = (p) => `http://127.0.0.1:${kernel.http.port}${p}`;
    const req = (p, method = 'GET', body) => fetch(url(p), {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const post = (p, body) => req(p, 'POST', body);

    const cfgDir = join(sc, 'claude-cfg');
    const botBody = {
      id: 'rtk-api-b1', name: 'rtk 冒烟', enabled: true, channel: 'fakechan',
      account: { endpoint: 'http://fake.local' }, allowedUsers: [],
      provider: 'claude', providerConfig: { cwd: join(sc, 'cwd'), claudeConfigDir: cfgDir },
    };
    assert.equal((await post('/api/bots', botBody)).status, 200, 'bot with dedicated dir created');

    const asset = await (await post('/api/assets', { type: 'tool', name: 'rtk-main', description: '主 rtk', content: { kind: 'rtk' } })).json();
    const bind = await post(`/api/bots/rtk-api-b1/assets`, { assetId: asset.asset.id, mode: 'shared' });
    assert.equal(bind.status, 200, 'bind SUCCEEDS in unavailable state (§7.1: 绑定保留)');
    const bindBody = await bind.json();
    assert.ok(bindBody.notes.some((n) => /rtk 未安装（unavailable）/.test(n.detail)), `receipt notes carry guidance: ${JSON.stringify(bindBody.notes)}`);
    assert.equal(existsSync(join(cfgDir, 'settings.json')), false, 'zero products while unavailable');

    const agents = await (await req('/api/agents')).json();
    const row = agents.agents.find((a) => a.id === 'rtk-api-b1');
    assert.ok(row.assetWarnings.some((w) => /rtk 未安装/.test(w)), `agents face standing warning: ${JSON.stringify(row.assetWarnings)}`);

    const unbind = await req(`/api/bots/rtk-api-b1/assets/${asset.asset.id}`, 'DELETE');
    assert.equal(unbind.status, 200);
    const unbindBody = await unbind.json();
    assert.equal(existsSync(join(cfgDir, 'settings.json')), false, 'still zero products after unbind');
    void unbindBody;
  } finally {
    if (prevRtkBin === undefined) delete process.env.WAO_RTK_BIN; else process.env.WAO_RTK_BIN = prevRtkBin;
    await kernel.stop();
  }
});

// ————————————————————————————————————————————————————————————————————————————
// C. ripgrep precheck at the provider planning face (§7.2: 预检不失败)
// ————————————————————————————————————————————————————————————————————————————

test('ripgrep precheck: rg missing on PATH → tools row unavailable + note; guidance argv still planned (绑定不失败)', async () => {
  const booted = await bootProvider(join(REPO, 'plugins/provider-claude'));
  try {
    const sc = scenario('rg-missing');
    const bot = { id: 'rg-b1', provider: 'claude', providerConfig: { cwd: join(sc, 'cwd'), claudeConfigDir: join(sc, 'cfg') } };
    const prevPath = process.env.PATH;
    process.env.PATH = '/usr/bin:/bin'; // no rg here (verified: /usr/bin/rg absent)
    try {
      const r = await booted.impl.materializeAssets(bot, [{
        assetId: 'ast-rg1', type: 'tool', name: 'rg', mode: 'shared', content: { kind: 'ripgrep', options: { extraHints: '用 -t 过滤' } },
      }], { log: fakeLog().log });
      assert.ok(r.writes.some((w) => w.kind === 'argv' && w.flags[1].includes('rg（ripgrep）')), 'guidance argv still planned');
      assert.deepEqual(r.tools, [{ assetId: 'ast-rg1', kind: 'ripgrep', state: 'unavailable', version: null }], 'precheck row rides tools');
      assert.ok(r.notes.some((n) => /rg 未安装：ripgrep 指引已注入但本机无效（预检不失败）/.test(n.detail)), 'note explains the no-fail precheck');
    } finally {
      process.env.PATH = prevPath;
    }
    // and with rg reachable the row flips available
    const r2 = await booted.impl.materializeAssets(bot, [{
      assetId: 'ast-rg1', type: 'tool', name: 'rg', mode: 'shared', content: { kind: 'ripgrep' },
    }], { log: fakeLog().log });
    assert.equal(r2.tools[0].state, 'available');
    assert.match(r2.tools[0].version, /^ripgrep \d/);
  } finally {
    await booted.stop();
  }
});
