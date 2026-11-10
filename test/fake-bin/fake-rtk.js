#!/usr/bin/env node
// Programmable fake `rtk` CLI — the actor half of the W3 T3 §7.1 unit suite
// (plugins/core-engine/materializer.js rtk executor). Mirrors the REAL rtk
// 1.1.0 faces empirically verified 2026-11-07 (probe /tmp/wao-t3-v5*):
//   --version                     → "fake-rtk 9.9.9"
//   init -g [--codex|--agent pi] --dry-run
//     → "[dry-run] …: /abs/path" lines (paths under the redirected
//       CLAUDE_CONFIG_DIR / CODEX_HOME / PI_CODING_AGENT_DIR)
//   init -g … [--auto-patch …]    → writes RTK.md + CLAUDE.md|AGENTS.md
//       @RTK.md ref + PreToolUse JSON hook entry {matcher:'Bash', …
//       command:'rtk hook <flavor>'} into settings.json|hooks.json, plus a
//       <hookfile>.bak residue (real rtk leaves one; WAO sweeps it); pi →
//       extensions/rtk.ts
//   init -g … --uninstall         → removes those products + a fresh .bak
// Behavior modes via $FAKE_RTK_MODE: ok (default) | dryfail (dry-run exit 1)
// | outside (dry-run lists a path OUTSIDE the bot dirs → fallback path)
// | initfail (real init exit 1 + stderr). Every invocation appends to
// $FAKE_RTK_LOG for call-order assertions. $FAKE_RTK_SLEEP_MS delays every
// invocation (the R2 async-spawn test: a slow rtk must not block the loop).
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.env.FAKE_RTK_MODE || 'ok';
const log = process.env.FAKE_RTK_LOG;
const note = (line) => { if (log) appendFileSync(log, `${line}\n`); };

const sleepMs = Number(process.env.FAKE_RTK_SLEEP_MS || 0);
if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));

const args = process.argv.slice(2);
if (args[0] === '--version') {
  // 探针慢响应（仅 --version）：模拟 Windows 升级后二进制首执被 Defender 扫描
  // 冷启动 >3s。回归钉 rtk 探测超时须容得下（RTK_PROBE_TIMEOUT_MS=15s）。
  const vSleep = Number(process.env.FAKE_RTK_VERSION_SLEEP_MS || 0);
  if (vSleep > 0) await new Promise((r) => setTimeout(r, vSleep));
  console.log('fake-rtk 9.9.9');
  process.exit(0);
}
if (args[0] !== 'init') process.exit(0);

const flavor = args.includes('--codex') ? 'codex' : args.includes('--agent') ? 'pi' : 'claude';
const dir = flavor === 'codex' ? process.env.CODEX_HOME
  : flavor === 'pi' ? process.env.PI_CODING_AGENT_DIR
    : process.env.CLAUDE_CONFIG_DIR;
if (!dir) {
  console.error('fake-rtk: no redirect env for flavor ' + flavor);
  process.exit(1);
}
const hookFile = flavor === 'codex' ? join(dir, 'hooks.json') : join(dir, 'settings.json');
const mdFile = join(dir, flavor === 'codex' ? 'AGENTS.md' : 'CLAUDE.md');
const entry = { matcher: 'Bash', hooks: [{ type: 'command', command: `rtk hook ${flavor}` }] };
const dry = args.includes('--dry-run');
const uninstall = args.includes('--uninstall');
note([flavor, dry ? 'dry-run' : uninstall ? 'uninstall' : 'init', mode].join(' '));

const dryLines = flavor === 'pi'
  ? [`[dry-run] would create Pi extension: ${join(dir, 'extensions', 'rtk.ts')}`]
  : [
    `[dry-run] would create RTK.md: ${join(dir, 'RTK.md')}`,
    `[dry-run] would add @RTK.md reference to ${flavor === 'codex' ? 'AGENTS.md' : 'CLAUDE.md'}: ${mdFile}`,
    `[dry-run] would patch ${flavor === 'codex' ? 'Codex hooks' : 'settings.json'} (PreToolUse, matcher "Bash"): ${hookFile}`,
  ];
if (mode === 'outside') dryLines.push('[dry-run] would create global filters template: /tmp/wao-rtk-outside-evil/filters.toml');

if (dry) {
  if (mode === 'dryfail') {
    console.error('fake-rtk dry-run boom');
    process.exit(1);
  }
  for (const line of dryLines) console.log(line);
  console.log('[dry-run] Nothing written.');
  process.exit(0);
}

const readJson = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
};
const writeHookDoc = (doc) => writeFileSync(hookFile, `${JSON.stringify(doc, null, 2)}\n`);
const stripRef = (text) => text.split('\n').filter((l) => l.trim() !== '@RTK.md').join('\n').replace(/\n+$/, '\n');

if (uninstall) {
  if (flavor === 'pi') {
    try { writeFileSync(join(dir, 'extensions', 'rtk.ts.bak'), '// gone\n'); } catch { /* best effort */ }
    try { unlinkSync(join(dir, 'extensions', 'rtk.ts')); } catch { /* best effort */ }
    process.exit(0);
  }
  const doc = readJson(hookFile) ?? {};
  writeFileSync(`${hookFile}.bak`, `${JSON.stringify(doc, null, 2)}\n`); // residue (real rtk does this)
  doc.hooks ??= {};
  if (Array.isArray(doc.hooks.PreToolUse)) {
    doc.hooks.PreToolUse = doc.hooks.PreToolUse.filter((e) => JSON.stringify(e) !== JSON.stringify(entry));
  }
  writeHookDoc(doc);
  try { unlinkSync(join(dir, 'RTK.md')); } catch { /* best effort */ }
  if (existsSync(mdFile)) writeFileSync(mdFile, stripRef(readFileSync(mdFile, 'utf8')));
  process.exit(0);
}

if (mode === 'initfail') {
  console.error('fake-rtk init boom: stderr detail');
  process.exit(1);
}

mkdirSync(dir, { recursive: true });
if (flavor === 'pi') {
  mkdirSync(join(dir, 'extensions'), { recursive: true });
  writeFileSync(join(dir, 'extensions', 'rtk.ts'), '// fake rtk pi extension\n');
  process.exit(0);
}
writeFileSync(join(dir, 'RTK.md'), '# fake RTK guidance\n');
const cur = existsSync(mdFile) ? readFileSync(mdFile, 'utf8') : '';
if (!cur.includes('@RTK.md')) writeFileSync(mdFile, `${cur}${cur === '' || cur.endsWith('\n') ? '' : '\n'}@RTK.md\n`);
const doc = readJson(hookFile) ?? {};
writeFileSync(`${hookFile}.bak`, `${JSON.stringify(doc, null, 2)}\n`); // residue — WAO must sweep
doc.hooks ??= {};
doc.hooks.PreToolUse ??= [];
if (!doc.hooks.PreToolUse.some((e) => JSON.stringify(e) === JSON.stringify(entry))) {
  doc.hooks.PreToolUse.push(structuredClone(entry));
}
writeHookDoc(doc);
process.exit(0);
