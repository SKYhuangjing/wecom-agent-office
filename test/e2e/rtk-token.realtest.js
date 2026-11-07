#!/usr/bin/env node
// W3 T3 真机冒烟（§7.1 装备效果验收硬门）：装/不装 rtk 的 claude bot 各跑一轮
// 同 prompt 岗前测试（Bash 跑 `git status` 并原样复述），对比 tool_result 的
// 字符量与估算 token——数字进 task 报告。NOT part of `npm test`（真 CLI + 真
// 模型网关 + 花钱）：`node test/e2e/rtk-token.realtest.js`（.realtest 后缀不进
// glob）。
//
// 装备路径本身就是被测面：armed 侧的 hook 由 WAO 物化管线真装（provider-
// claude + createMaterializer + rtk init 主路径），baseline 侧同目录形状但零
// rtk 绑定。两侧 settings.json 都从 ~/.claude/settings.json 抄网关 env（magpie
// 路由），差异只有 PreToolUse hook 一条——单变量对比。
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const have = (bin) => {
  try { return spawnSync(bin, ['--version'], { timeout: 20000 }).status === 0; } catch { return false; }
};
const GATEWAY_UP = (() => {
  try {
    const r = spawnSync('curl', ['-s', '-m', '3', '-o', '/dev/null', '-w', '%{http_code}', 'http://127.0.0.1:3425/v1/models']);
    return r.stdout?.toString().trim() === '200';
  } catch { return false; }
})();
const MISSING = ['claude', 'rtk'].filter((b) => !have(b));
if (MISSING.length > 0) {
  console.error(`skip: real CLIs not on PATH: ${MISSING.join(', ')}`);
  process.exit(0);
}
if (!GATEWAY_UP) {
  console.error('skip: magpie gateway 127.0.0.1:3425 not reachable');
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), 'wao-rtk-smoke-'));
const repo = join(root, 'repo');
mkdirSync(repo, { recursive: true });

// —— deterministic verbose repo: git status 输出要长（60 untracked + 10 modified）
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
git('init', '-q');
git('config', 'user.email', 'smoke@wao.local');
git('config', 'user.name', 'wao smoke');
for (let i = 0; i < 10; i++) writeFileSync(join(repo, `tracked-${i}.txt`), `tracked file ${i}\n`.repeat(50));
git('add', '.');
git('commit', '-q', '-m', 'init');
for (let i = 0; i < 10; i++) writeFileSync(join(repo, `tracked-${i}.txt`), `modified ${i}\n`.repeat(50)); // modified
for (let i = 0; i < 60; i++) writeFileSync(join(repo, `untracked-${i}.txt`), `untracked ${i}\n`); // untracked

// —— both config dirs carry the SAME gateway env; only the hook differs
const userEnv = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8')).env ?? {};
const mkCfg = (name) => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.json'), `${JSON.stringify({ env: userEnv }, null, 2)}\n`);
  return dir;
};
const cfgBaseline = mkCfg('cfg-baseline');
const cfgArmed = mkCfg('cfg-armed');

// —— arm the rtk side through the REAL WAO pipeline (provider + materializer)
const { createLifecycle } = await import(`${REPO}/src/kernel/lifecycle.js`);
const { createEventBus } = await import(`${REPO}/src/kernel/events.js`);
const { createServices } = await import(`${REPO}/src/kernel/services.js`);
const { createHttpShell } = await import(`${REPO}/src/kernel/http.js`);
const { importPlugin, validateManifest } = await import(`${REPO}/src/kernel/loader.js`);
const { createMaterializer } = await import(`${REPO}/plugins/core-engine/materializer.js`);

const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };
const rec = await importPlugin(join(REPO, 'plugins/provider-claude'));
if (validateManifest(rec.manifest).length > 0) throw new Error('provider-claude manifest invalid');
const lifecycle = createLifecycle({ events: createEventBus({ log }), services: createServices(), log, http: createHttpShell({ log }) });
const plugin = { dir: join(REPO, 'plugins/provider-claude'), manifest: rec.manifest, mod: rec.mod.default, status: 'enabled', config: {} };
await lifecycle.activate(plugin);
const impl = lifecycle.portRegistry.provider.get('claude').impl;
const dataDir = join(root, 'wao-data');
const mat = createMaterializer({ ports: { getProvider: () => impl }, dataDir, log });
const bot = { id: 'smoke-b1', provider: 'claude', providerConfig: { cwd: repo, claudeConfigDir: cfgArmed } };
const arm = await mat.materialize(bot, [{ assetId: 'ast-rtk-smoke', type: 'tool', name: 'rtk', mode: 'shared', content: { kind: 'rtk' } }]);
console.log('[arm] notes:', arm.notes.map((n) => n.detail).join(' | '));
await lifecycle.deactivate(plugin).catch(() => {});

// —— one real claude turn per side; capture RAW stream-json
const PROMPT = '请用 Bash 工具执行一次 git status（不要加任何参数），然后把工具输出的完整内容原样贴出，不要省略任何行。';
// rtk gain 是全局累计账——先读基线，跑完再读，差值=本轮节省（单轮口径）。
const gainSnapshot = () => {
  const r = spawnSync('rtk', ['gain'], { encoding: 'utf8', timeout: 10000 });
  if (r.status !== 0) return null;
  const num = (re) => Number(re.exec(String(r.stdout ?? ''))?.[1] ?? 0);
  return { commands: num(/Total commands:\s*(\d+)/), savedTokens: num(/Tokens saved:\s*(\d+)/), raw: String(r.stdout).trim() };
};
const gainBefore = gainSnapshot();
const runClaude = (cfgDir) => {
  const r = spawnSync('claude', ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions'], {
    cwd: repo,
    env: { ...process.env, CLAUDE_CONFIG_DIR: cfgDir },
    input: PROMPT,
    encoding: 'utf8',
    timeout: 300000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`claude exit ${r.status}: ${String(r.stderr ?? '').slice(0, 500)}`);
  return r.stdout;
};

const analyze = (raw) => {
  const out = { bashCommand: null, toolResultChars: 0, toolResultLines: 0, finalChars: 0, usage: null };
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const content = ev?.message?.content;
    if (!Array.isArray(content)) {
      if (ev?.type === 'result') out.usage = ev.usage ?? null;
      continue;
    }
    for (const block of content) {
      if (block?.type === 'tool_use' && block?.name === 'Bash') out.bashCommand = String(block.input?.command ?? '');
      if (block?.type === 'tool_result') {
        const text = Array.isArray(block.content)
          ? block.content.map((c) => c?.text ?? '').join('')
          : String(block.content ?? '');
        out.toolResultChars += text.length;
        out.toolResultLines += text.split('\n').length;
      }
      if (block?.type === 'text' && ev?.type === 'assistant') out.finalChars += String(block.text ?? '').length;
    }
  }
  return out;
};

console.log('\n[run] baseline (no rtk hook) …');
const base = analyze(runClaude(cfgBaseline));
console.log(`  bash command: ${base.bashCommand}`);
console.log(`  tool_result: ${base.toolResultChars} chars / ${base.toolResultLines} lines (~${Math.round(base.toolResultChars / 4)} tokens @4chars)`);

console.log('[run] armed (rtk hook via WAO materializer) …');
const armed = analyze(runClaude(cfgArmed));
console.log(`  bash command: ${armed.bashCommand}`);
console.log(`  tool_result: ${armed.toolResultChars} chars / ${armed.toolResultLines} lines (~${Math.round(armed.toolResultChars / 4)} tokens @4chars)`);

const saved = base.toolResultChars - armed.toolResultChars;
const gainAfter = gainSnapshot();
const gainDelta = gainBefore != null && gainAfter != null
  ? { commands: gainAfter.commands - gainBefore.commands, savedTokens: gainAfter.savedTokens - gainBefore.savedTokens }
  : null;
// 实证（2026-11-07）：stream-json 的 tool_use 事件回显的是 PreToolUse 改写前的
// 原始 input——改写是否生效以 rtk gain 的记账为准（本轮命令数>0 且节省量与
// tool_result 差值吻合）。
console.log('\n===== rtk token comparison (同 prompt 岗前测试, git status 复述) =====');
console.log(`baseline : ${base.toolResultChars} chars / ${base.toolResultLines} lines`);
console.log(`armed    : ${armed.toolResultChars} chars / ${armed.toolResultLines} lines`);
console.log(`delta    : ${saved >= 0 ? '-' : '+'}${Math.abs(saved)} chars (${base.toolResultChars > 0 ? Math.round((saved / base.toolResultChars) * 100) : 0}%), ~${Math.abs(Math.round(saved / 4))} tokens @4chars`);
if (gainDelta != null) console.log(`rtk gain (本轮): ${gainDelta.commands} 条命令改写, ${gainDelta.savedTokens} tokens saved`);
console.log(`rewritten: ${gainDelta != null && gainDelta.commands > 0 ? 'YES (rtk gain 记账——tool_use 事件回显改写前原文，判定源=rtk gain)' : 'NO — hook did not intercept!'}`);
if (base.usage || armed.usage) {
  const row = (u) => u ? `in=${u.input_tokens ?? '?'} out=${u.output_tokens ?? '?'} read=${u.cache_read_input_tokens ?? 0} write=${u.cache_creation_input_tokens ?? 0}` : 'n/a';
  console.log(`usage    : baseline ${row(base.usage)} | armed ${row(armed.usage)}`);
}
if (gainAfter != null) console.log(`\n[rtk gain 累计]\n${gainAfter.raw.split('\n').slice(0, 8).join('\n')}`);

// —— unload check: the armed dir must come back clean
const disarm = await mat.materialize(bot, []);
const hookLeft = (() => {
  try { return JSON.parse(readFileSync(join(cfgArmed, 'settings.json'), 'utf8')).hooks != null; } catch { return false; }
})();
console.log(`\n[unload] rtk notes: ${disarm.notes.map((n) => n.detail).join(' | ')}`);
console.log(`[unload] hook residue in cfg-armed: ${hookLeft ? 'PRESENT (bad)' : 'none (good)'}`);

rmSync(root, { recursive: true, force: true });
console.log('\nsmoke done.');
