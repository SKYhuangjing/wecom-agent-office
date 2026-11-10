#!/usr/bin/env node
// Programmable fake `scope-recall` CLI — the actor half of the §7.4 unit suite
// (plugins/core-engine/materializer.js scope-recall executor). Mirrors the REAL
// hermes-scope-recall 4.0.3 faces empirically verified 2026-11-10
// (/private/tmp/wao-scope-recall-p0*, Phase 0):
//   --help                                      → exit 0（探测面——真 CLI 无
//                                                 --version 旗标，argparse 非零）
//   setup --host claude-code --home <dir>
//         --store <dir> --yes                   → 写 claude-code 插件 bundle
//     <home>/skills/scope-recall/{.claude-plugin/plugin.json, hooks/hooks.json,
//     .mcp.json, skills/scope-recall-memory/SKILL.md}（hooks 走插件面，不碰
//     settings.json——与 rtk 的 PreToolUse 条目零冲突）+ 安装收据
//     <home>/.scope-recall-install-receipt.json（package_version 4.0.3）+
//     记忆留存面 <home>/scope-recall/{attachment.json,runtime-config.json} +
//     <home>/scope-recall-attachment.lock + 记忆库 <store>/memory.sqlite3
//   apply-uninstall --instance-root <home>      → 删插件四件套（记忆留存面
//                                                 留给 WAO 清扫——真 CLI 同款）
// Behavior modes via $FAKE_SR_MODE: ok (default) | fail (setup exit 1 + stderr
// 带真 CLI 的 symlink 拒绝文案，零写盘) | drift (写插件面但漏安装收据——回读
// 断言失败) | halffail (真实半装形状：插件面+收据全写盘后再 exit 1——盲评
// P2-3 的「首次 setup 失败残片」演员)。
// Every invocation appends to $FAKE_SR_LOG for call-order assertions.
import { appendFileSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.env.FAKE_SR_MODE || 'ok';
const log = process.env.FAKE_SR_LOG;
const note = (line) => { if (log) appendFileSync(log, `${line}\n`); };

const args = process.argv.slice(2);
if (args[0] === '--help') {
  note(`help ${mode}`);
  console.log('usage: fake-scope-recall {setup,apply-uninstall} …');
  process.exit(0);
}

const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};

// ok 形状的写盘（halffail 复用后再非零退出）。
const writeProducts = (home, store) => {
  const plugin = join(home, 'skills', 'scope-recall');
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
  mkdirSync(join(plugin, 'hooks'), { recursive: true });
  mkdirSync(join(plugin, 'skills', 'scope-recall-memory'), { recursive: true });
  mkdirSync(join(home, 'scope-recall'), { recursive: true });
  mkdirSync(store, { recursive: true });
  writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), `${JSON.stringify({ name: 'scope-recall', version: '4.0.3' }, null, 2)}\n`);
  writeFileSync(join(plugin, 'hooks', 'hooks.json'), `${JSON.stringify({ hooks: { SessionStart: [], UserPromptSubmit: [], Stop: [], SessionEnd: [] } }, null, 2)}\n`);
  writeFileSync(join(plugin, '.mcp.json'), `${JSON.stringify({ mcpServers: { 'scope-recall': { type: 'stdio', command: 'python' } } }, null, 2)}\n`);
  writeFileSync(join(plugin, 'skills', 'scope-recall-memory', 'SKILL.md'), '# fake scope-recall memory skill\n');
  writeFileSync(join(home, '.scope-recall-install-receipt.json'), `${JSON.stringify({
    package_version: '4.0.3', host: 'claude-code', instance_root: home, target_plugin_dir: plugin,
    files: ['plugin.json', 'hooks.json', '.mcp.json', 'SKILL.md'].map((f) => ({ path: join(plugin, f), sha256: 'fake' })),
  }, null, 2)}\n`);
  writeFileSync(join(home, 'scope-recall', 'attachment.json'), `${JSON.stringify({ root: store, host: 'claude-code' }, null, 2)}\n`);
  writeFileSync(join(home, 'scope-recall', 'runtime-config.json'), '{}\n');
  writeFileSync(join(home, 'scope-recall-attachment.lock'), '');
  writeFileSync(join(store, 'memory.sqlite3'), 'fake-scope-recall-store\n');
  writeFileSync(join(store, 'installation.json'), '{}\n');
};

if (args[0] === 'setup') {
  note(`setup ${mode}`);
  const home = flag('--home');
  const store = flag('--store');
  if (home == null || store == null) {
    console.error('fake-scope-recall: --home/--store required');
    process.exit(1);
  }
  if (mode === 'fail') {
    console.error('fake-scope-recall setup boom: InstallError: symlink or reparse paths are not allowed: /tmp');
    process.exit(1);
  }
  if (mode === 'halffail') {
    writeProducts(home, store);
    console.error('fake-scope-recall setup half-installed then boom');
    process.exit(1);
  }
  const plugin = join(home, 'skills', 'scope-recall');
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
  mkdirSync(join(plugin, 'hooks'), { recursive: true });
  mkdirSync(join(plugin, 'skills', 'scope-recall-memory'), { recursive: true });
  mkdirSync(join(home, 'scope-recall'), { recursive: true });
  mkdirSync(store, { recursive: true });
  writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), `${JSON.stringify({ name: 'scope-recall', version: '4.0.3' }, null, 2)}\n`);
  writeFileSync(join(plugin, 'hooks', 'hooks.json'), `${JSON.stringify({ hooks: { SessionStart: [], UserPromptSubmit: [], Stop: [], SessionEnd: [] } }, null, 2)}\n`);
  writeFileSync(join(plugin, '.mcp.json'), `${JSON.stringify({ mcpServers: { 'scope-recall': { type: 'stdio', command: 'python' } } }, null, 2)}\n`);
  writeFileSync(join(plugin, 'skills', 'scope-recall-memory', 'SKILL.md'), '# fake scope-recall memory skill\n');
  if (mode !== 'drift') {
    writeFileSync(join(home, '.scope-recall-install-receipt.json'), `${JSON.stringify({
      package_version: '4.0.3', host: 'claude-code', instance_root: home, target_plugin_dir: plugin,
      files: ['plugin.json', 'hooks.json', '.mcp.json', 'SKILL.md'].map((f) => ({ path: join(plugin, f), sha256: 'fake' })),
    }, null, 2)}\n`);
  }
  writeFileSync(join(home, 'scope-recall', 'attachment.json'), `${JSON.stringify({ root: store, host: 'claude-code' }, null, 2)}\n`);
  writeFileSync(join(home, 'scope-recall', 'runtime-config.json'), '{}\n');
  writeFileSync(join(home, 'scope-recall-attachment.lock'), '');
  writeFileSync(join(store, 'memory.sqlite3'), 'fake-scope-recall-store\n');
  writeFileSync(join(store, 'installation.json'), '{}\n');
  console.log(JSON.stringify({ ok: true, store }));
  process.exit(0);
}

if (args[0] === 'apply-uninstall') {
  note(`apply-uninstall ${mode}`);
  const home = flag('--instance-root');
  if (home == null) {
    console.error('fake-scope-recall: --instance-root required');
    process.exit(1);
  }
  const plugin = join(home, 'skills', 'scope-recall');
  for (const f of [join(plugin, '.claude-plugin', 'plugin.json'), join(plugin, 'hooks', 'hooks.json'),
    join(plugin, '.mcp.json'), join(plugin, 'skills', 'scope-recall-memory', 'SKILL.md')]) {
    try { unlinkSync(f); } catch { /* already gone (idempotent, real CLI same) */ }
  }
  console.log(JSON.stringify({ files_removed: 4, memory_retained: true }));
  process.exit(0);
}

console.error(`fake-scope-recall: unknown command ${JSON.stringify(args[0] ?? null)}`);
process.exit(1);
