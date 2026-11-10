#!/usr/bin/env node
// Programmable fake `uv` CLI — the §7.4 uv-fallback leg. Real uv 0.6.8 faces
// used by the materializer: `--version` (probe) and `tool install <pkg>`
// (installs executable shims into ~/.local/bin). The fake "installs" the
// scope-recall shim by COPYING test/fake-bin/fake-scope-recall.js into
// $HOME/.local/bin/scope-recall — exactly where resolveScopeRecall's candidate
// #2 looks, so the unit suite exercises the real install→re-probe→setup chain
// hermetically (tests point $HOME at a tmp dir first).
import { appendFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const log = process.env.FAKE_UV_LOG;
const note = (line) => { if (log) appendFileSync(log, `${line}\n`); };

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('fake-uv 0.6.8 (c1ef48276 2025-03-18)');
  process.exit(0);
}
if (args[0] === 'tool' && args[1] === 'install') {
  const spec = args[2];
  note(`tool install ${spec}`);
  // 代理透传断言面（2026-11-10 PC1 真机：uv 下托管 Python 直连 GitHub 超时
  // 10060）——materializer 必须把服务代理带进 uv 子进程。
  if (log) {
    appendFileSync(`${log}.env`,
      `HTTPS_PROXY=${process.env.HTTPS_PROXY ?? ''}\nNO_PROXY=${process.env.NO_PROXY ?? ''}\n`);
  }
  // P1-2（盲评）：真 uv 收到的必须是钉版 spec（hermes-scope-recall==<版本>）——
  // 裸包名=浮动 latest，直接拒绝，钉版回归由这个断言锁定。
  if (spec !== 'hermes-scope-recall==4.0.3') {
    console.error(`fake-uv: expected pinned spec hermes-scope-recall==4.0.3, got ${spec}`);
    process.exit(1);
  }
  const binDir = join(process.env.HOME, '.local', 'bin');
  mkdirSync(binDir, { recursive: true });
  copyFileSync(join(REPO, 'test', 'fake-bin', 'fake-scope-recall.js'), join(binDir, 'scope-recall'));
  console.log(`Installed 1 executable: scope-recall (${spec})`);
  process.exit(0);
}
console.error(`fake-uv: unknown command ${JSON.stringify(args.join(' '))}`);
process.exit(1);
