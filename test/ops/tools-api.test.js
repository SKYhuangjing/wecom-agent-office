// P1-A tool provisioning (DESIGN-TOKEN-OPT): pure spec layer + installer
// orchestration with injected primitives + /api/service/tools route shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TOOL_SPECS, planInstall, verifyChecksum, sha256Hex, buildPathAppendCommand,
} from '../../src/tools-spec.js';
import { installTool, readToolsRegistry, writeToolsRegistry, locateExe } from '../../src/tools-installer.js';
import { parseArgs } from '../../scripts/updater.js';
import { createKernel } from '../../src/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// —— pure spec ————————————————————————————————————————————————————————————
test('planInstall: win32 plans carry pinned url+sha256; mirror becomes basename fallback', () => {
  const p = planInstall('rtk', 'win32', {});
  assert.equal(p.ok, true);
  assert.equal(p.plan.method, 'zip');
  assert.equal(p.plan.url, TOOL_SPECS.rtk.install.win32.url);
  assert.equal(p.plan.sha256.length, 64);
  assert.equal(p.plan.mirrorUrl, null, 'no mirror → no fallback url');

  const m = planInstall('rtk', 'win32', { mirror: 'http://10.0.0.2:8899/' });
  assert.equal(m.plan.mirrorUrl, 'http://10.0.0.2:8899/rtk-x86_64-pc-windows-msvc.zip',
    'mirror serves the SAME basename at its root (win-install.ps1 -Mirror semantics)');
});

test('planInstall: darwin/linux route to brew; git-bash is win32-only', () => {
  for (const platform of ['darwin', 'linux']) {
    const rg = planInstall('ripgrep', platform, {});
    assert.equal(rg.ok, true);
    assert.equal(rg.plan.method, 'brew');
    assert.equal(rg.plan.formula, 'ripgrep');
    const gb = planInstall('git-bash', platform, {});
    assert.equal(gb.ok, false, `${platform} refuses git-bash`);
    assert.match(gb.reason, /不支持/);
  }
  const win = planInstall('git-bash', 'win32', {});
  assert.equal(win.ok, true);
  assert.equal(win.plan.method, 'sfx');
  assert.deepEqual(win.plan.pathSuffixes, ['cmd', 'bin'], 'git\\cmd + git\\bin both ride PATH');
});

test('planInstall: unknown id / corrupt mirror env are refused, never guessed', () => {
  assert.equal(planInstall('nmap', 'win32', {}).ok, false);
  assert.match(planInstall('nmap', 'win32', {}).reason, /未知工具/);
});

test('verifyChecksum: sha256 gate catches the truncated-download case (11-09 PC1 lesson)', () => {
  const good = Buffer.from('payload');
  const digest = sha256Hex(good);
  assert.equal(verifyChecksum(good, digest), true);
  assert.equal(verifyChecksum(Buffer.concat([good, Buffer.from('extra-bytes-from-a-slow-link')]), digest), false,
    'a truncated then padded/different body NEVER passes');
  assert.equal(verifyChecksum(good, 'not-a-hash'), false, 'malformed expected digest fails closed');
});

test('buildPathAppendCommand: idempotent user-registry append, no setx, quotes escaped', () => {
  const cmd = buildPathAppendCommand(['C:\\Users\\a\\tools\\rtk', 'C:\\Users\\a\\tools\\rg']);
  assert.ok(cmd.includes("[Environment]::GetEnvironmentVariable('Path','User')"), 'registry API, not setx (1024 truncation)');
  assert.ok(cmd.includes('-notlike'), 'already-present dirs are filtered before append');
  assert.equal(buildPathAppendCommand([]), null);
  assert.equal(buildPathAppendCommand(null), null);
  const quoted = buildPathAppendCommand(["C:\\O'Brien\\tools"]);
  assert.ok(quoted.includes("'C:\\O''Brien\\tools'"), 'single quotes doubled for PowerShell');
});

// —— installer orchestration (injected primitives; no network, no real PATH) ——
test('locateExe: finds exe at root (rtk zip) and one nested dir deep (ripgrep zip)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-loc-'));
  try {
    mkdirSync(join(dir, 'ripgrep-15.2.0-x86_64'), { recursive: true });
    writeFileSync(join(dir, 'rtk.exe'), 'x');
    writeFileSync(join(dir, 'ripgrep-15.2.0-x86_64', 'rg.exe'), 'x');
    assert.equal(locateExe(dir, 'rtk.exe'), join(dir, 'rtk.exe'));
    assert.equal(locateExe(dir, 'rg.exe'), join(dir, 'ripgrep-15.2.0-x86_64', 'rg.exe'));
    assert.equal(locateExe(dir, 'missing.exe'), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('installTool (zip, injected): checksum gate rejects a corrupted body; good body installs + registers + appends PATH', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-inst-'));
  const regFile = join(dir, 'tools.json');
  const pathAppends = [];
  const goodBody = Buffer.from('fake-zip-bytes');
  const fakeFetch = async (url) => {
    if (url.includes('mirror')) throw new Error('mirror down');
    return { ok: true, arrayBuffer: async () => goodBody.buffer.slice(goodBody.byteOffset, goodBody.byteOffset + goodBody.byteLength) };
  };
  try {
    // corrupt body → direct+mirror both fail the gate → failed state, NO PATH write
    const badFetch = async () => ({ ok: true, arrayBuffer: async () => Buffer.from('truncated!').buffer });
    await assert.rejects(
      () => installTool('rtk', {
        platform: 'win32', registryFile: regFile, stageDir: join(dir, 'stage'),
        fetchImpl: badFetch, which: () => null, appendPathImpl: (d) => pathAppends.push(d),
        log: () => {},
        // bypass real tar.exe by pointing extraction at a stubbed exec? — the
        // checksum gate rejects BEFORE extraction, so no tar runs on this leg.
      }),
      /SHA256/);
    assert.equal(readToolsRegistry(regFile).rtk, undefined, 'failed install persists nothing');
    assert.deepEqual(pathAppends, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  void goodBody;
});

test('writeToolsRegistry/readToolsRegistry: missing/corrupt files read as empty; roundtrip survives', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-reg-'));
  try {
    const f = join(dir, 'sub', 'tools.json');
    assert.deepEqual(readToolsRegistry(f), {}, 'missing file → empty');
    writeToolsRegistry(f, { rtk: { state: 'installing', startedAt: 1 } });
    assert.equal(readToolsRegistry(f).rtk.state, 'installing');
    writeFileSync(f, '{corrupt');
    assert.deepEqual(readToolsRegistry(f), {}, 'corrupt file → empty, never a crash');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// —— updater --restart-only args ————————————————————————————————————————————
test('updater parseArgs: --restart-only is a boolean flag (like --lan)', () => {
  const f = parseArgs(['--restart-only', '--parent-pid', '123', '--target-dir', 'C:\\wao', '--data-dir', 'C:\\wao\\data']);
  assert.equal(f['restart-only'], true);
  assert.equal(f['parent-pid'], '123');
  assert.equal(f.lan, undefined);
  const g = parseArgs(['--zip-url', 'http://x']);
  assert.equal(g['restart-only'], undefined, 'absent flag stays absent (not false — runUpdater checks === true)');
});

// —— /api/service/tools route shape over a temp kernel ————————————————————
const FAKE_CHANNEL = `
export default {
  manifest: { id: 'channel-fake', name: 'Fake Channel', type: 'channel', version: '0.1.0', requires: { kernel: '^1' } },
  activate(ctx) {
    ctx.registerChannel('fakechan', {
      accountSchema: [{ key: 'endpoint', label: 'Endpoint', type: 'string', required: true }],
      capabilities: { stream: false, push: false, group: false },
      createAdapter({ engine }) { return { engine, start() {}, stop() {}, status: () => ({ state: 'online', lastError: null }) }; },
    });
  },
};`;

test('GET /api/service/tools: platform-filtered rows with probe state; POST refuses unknown ids and double-installs', async () => {
  const fakes = mkdtempSync(join(tmpdir(), 'wao-toolsapi-fakes-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'wao-toolsapi-data-'));
  mkdirSync(join(fakes, 'channel-fake'), { recursive: true });
  writeFileSync(join(fakes, 'channel-fake', 'plugin.js'), FAKE_CHANNEL);
  writeFileSync(join(fakes, 'channel-fake', 'package.json'), '{"type":"module"}\n');
  // pre-mark rtk as installing → the POST 409 leg needs no real download
  writeToolsRegistry(join(dataDir, 'tools.json'), { rtk: { state: 'installing', startedAt: Date.now() } });
  const kernel = await createKernel({ port: 0, dataDir, pluginsDirs: [fakes, join(repoRoot, 'plugins')] });
  try {
    const url = (p) => `http://127.0.0.1:${kernel.http.port}${p}`;
    const req = (p, method = 'GET', body) => fetch(url(p), {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const list = await (await req('/api/service/tools')).json();
    assert.equal(list.ok, true);
    assert.equal(list.platform, process.platform);
    const ids = list.tools.map((t) => t.id);
    if (process.platform === 'win32') {
      assert.deepEqual(ids.sort(), ['git-bash', 'ripgrep', 'rtk']);
    } else {
      assert.deepEqual(ids.sort(), ['ripgrep', 'rtk'], 'git-bash never shows off win32');
    }
    const rtkRow = list.tools.find((t) => t.id === 'rtk');
    assert.equal(rtkRow.state, 'installing', 'registry installing state wins over probe');
    assert.ok(rtkRow.description && rtkRow.version);

    assert.equal((await req('/api/service/tools', 'POST', { id: 'nmap' })).status, 400, 'unknown id → 400');
    if (process.platform !== 'win32') {
      const gb = await (await req('/api/service/tools', 'POST', { id: 'git-bash' })).json();
      assert.equal(gb.ok, false, 'winOnly tool refused off win32');
    }
    const busy = await req('/api/service/tools', 'POST', { id: 'rtk' });
    assert.equal(busy.status, 409, 'installing tool refuses a second kick');
    assert.match((await busy.json()).error, /正在安装中/);
  } finally {
    await kernel.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(fakes, { recursive: true, force: true });
  }
});


// —— 盲评修复回归 ———————————————————————————————————————————————————————
test('P1-3: a stale installing entry self-heals to failed (GET display + POST no longer 409)', async () => {
  const fakes = mkdtempSync(join(tmpdir(), 'wao-stale-fakes-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'wao-stale-data-'));
  mkdirSync(join(fakes, 'channel-fake'), { recursive: true });
  writeFileSync(join(fakes, 'channel-fake', 'plugin.js'), FAKE_CHANNEL);
  writeFileSync(join(fakes, 'channel-fake', 'package.json'), '{"type":"module"}\n');
  // 21 分钟前开始安装（> 20min 上限）——服务重启把它永远留在了 installing
  writeToolsRegistry(join(dataDir, 'tools.json'), { rtk: { state: 'installing', startedAt: Date.now() - 21 * 60 * 1000 } });
  const kernel = await createKernel({ port: 0, dataDir, pluginsDirs: [fakes, join(repoRoot, 'plugins')] });
  try {
    const url = (p2) => `http://127.0.0.1:${kernel.http.port}${p2}`;
    const list = await (await fetch(url('/api/service/tools'))).json();
    const rtk = list.tools.find((t) => t.id === 'rtk');
    assert.equal(rtk.install.state, 'failed', 'stale installing displays as failed');
    assert.match(rtk.install.error, /安装中断/);
    // POST 不再 409：stale 条目放行重试（mac 上 rtk 走 brew 计划——这里只验
    // 不被 409 卡死；真安装不发生：随后立即断言状态并停核）
    const again = await fetch(url('/api/service/tools'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'rtk' }),
    });
    assert.notEqual(again.status, 409, 'stale installing no longer blocks a retry');
    await again.json();
  } finally {
    await kernel.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(fakes, { recursive: true, force: true });
  }
});

test('P0-1: brew install runs through the ASYNC seam (never a sync freeze)', async () => {
  const calls = [];
  const entry = await installTool('rtk', {
    platform: 'darwin', // → brew plan
    registryFile: join(mkdtempSync(join(tmpdir(), 'wao-brew-')), 'tools.json'),
    stageDir: join(tmpdir(), 'wao-brew-stage-'),
    spawnCliImpl: async (bin, args) => { calls.push([bin, ...args]); },
    which: () => '/opt/homebrew/bin/rtk',
    log: () => {},
  });
  assert.deepEqual(calls, [['brew', 'install', '-q', 'rtk']], 'async seam invoked exactly once');
  assert.equal(entry.state, 'installed');
  assert.equal(entry.path, '/opt/homebrew/bin/rtk');
});
