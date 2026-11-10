// Tool provisioning specs (DESIGN-TOKEN-OPT P1-A) — PURE data + plan builders:
// no fs, no network, no spawn; everything side-effecting lives in
// src/tools-installer.js and the /api/service/tools routes.
//
// Why pinned versions + sha256 (2026-11-09 lesson): PC1's direct GitHub
// downloads were silently TRUNCATED by the slow link (rtk zip arrived as
// 1.5MB of a 6.9MB file, curl -s hid the error) — a checksum gate is the
// difference between "installed" and "installed a corrupt binary".
// Win installs land in %USERPROFILE%\tools\<dirName> (the layout verified on
// PC1); PATH appends go through PowerShell [Environment]::SetEnvironmentVariable
// (read-modify-write + WM_SETTINGCHANGE broadcast; setx truncates at 1024).
import { createHash } from 'node:crypto';
import { basename } from 'node:path';

export const TOOLS_INSTALL_ROOT_DIRNAME = 'tools';

// win32 layout notes:
//  - rtk zip extracts rtk.exe at the archive root  → extract into <root>/rtk
//  - ripgrep zip wraps one nested dir with rg.exe  → locate + flatten into <root>/rg
//  - PortableGit is a 7z SFX; self-extracts with -o<dir> -y into <root>/git
//    (brings bash.exe — REQUIRED on win32: claude-code executes PreToolUse
//    hooks through bash; without it hooks silently never run and the Bash
//    tool degrades to cmd. Verified live on PC1, 2026-11-09).
export const TOOL_SPECS = {
  rtk: {
    id: 'rtk', label: 'rtk', bin: 'rtk', version: '1.2.0',
    description: 'Token 瘦身 hook：PreToolUse 拦截 Bash 命令输出过滤（实测单轮 -18%）',
    platforms: ['win32', 'darwin', 'linux'],
    install: {
      win32: {
        method: 'zip', dirName: 'rtk', exe: 'rtk.exe',
        url: 'https://github.com/rtk-ai/rtk/releases/download/v1.2.0/rtk-x86_64-pc-windows-msvc.zip',
        sha256: 'b291b4e53d37f84b7f1696bc20559207396fb0190f20ed3c949db1b7e1c0c378',
      },
      darwin: { method: 'brew', formula: 'rtk' },
      linux: { method: 'brew', formula: 'rtk', hint: 'brew install rtk（无 Homebrew 时从 github.com/rtk-ai/rtk/releases 手动安装）' },
    },
  },
  ripgrep: {
    id: 'ripgrep', label: 'ripgrep', bin: 'rg', version: '15.2.0',
    description: '代码检索：rg 关键词定位（Bash/Grep 工具的底层引擎）',
    platforms: ['win32', 'darwin', 'linux'],
    install: {
      win32: {
        method: 'zip', dirName: 'rg', exe: 'rg.exe', flattenNested: true,
        url: 'https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-pc-windows-msvc.zip',
        sha256: '71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5',
      },
      darwin: { method: 'brew', formula: 'ripgrep' },
      linux: { method: 'brew', formula: 'ripgrep', hint: 'brew install ripgrep（无 Homebrew 时用发行版包管理器装 ripgrep）' },
    },
  },
  'git-bash': {
    id: 'git-bash', label: 'Git Bash', bin: 'bash', version: '2.56.0.4',
    description: 'claude hook 执行依赖的 bash + git（win32 专属；缺失时 rtk hook 静默不生效）',
    platforms: ['win32'],
    install: {
      win32: {
        method: 'sfx', dirName: 'git', exe: 'bin\\bash.exe',
        url: 'https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.4/PortableGit-2.56.0.4-64-bit.7z.exe',
        sha256: 'b1f3e52216e2ed6882d1bebfd4d3fdf319bec40d2edbbf9fd26ec4fd3fce7ed1',
        // PortableGit extracts BOTH cmd\ (git.exe) and bin\ (bash.exe/sh.exe)
        pathSuffixes: ['cmd', 'bin'],
      },
    },
  },
  // uv（B 产品化 2026-11-10）：scope-recall 工具资产的运行时供给——materializer
  // 首次装备时 `uv tool install hermes-scope-recall`（自动落托管 Python≥3.11，
  // 免管理员；scope-recall 本体不进本表）。sha256 按实下载文件算出钉死
  // （2026-11-10，astral-sh/uv v0.6.8——与本机实测版本一致）。
  uv: {
    id: 'uv', label: 'uv', bin: 'uv', version: '0.6.8',
    description: 'Python 工具链管理器：scope-recall 记忆工具的安装前提（uv tool install 自动落托管 Python，免管理员）',
    platforms: ['win32', 'darwin', 'linux'],
    install: {
      win32: {
        method: 'zip', dirName: 'uv', exe: 'uv.exe',
        url: 'https://github.com/astral-sh/uv/releases/download/0.6.8/uv-x86_64-pc-windows-msvc.zip',
        sha256: 'd31c3d01ca3e1a75e15ed9514c135239770b6b40a99cae716661e28e433aa495',
      },
      darwin: { method: 'brew', formula: 'uv' },
      linux: { method: 'brew', formula: 'uv', hint: 'brew install uv（无 Homebrew 时从 github.com/astral-sh/uv/releases 手动安装）' },
    },
  },
};

// planInstall(id, platform, { mirror }) → { ok, reason?, plan? }
// mirror semantics copy win-install.ps1's -Mirror: the mirror serves the SAME
// FILENAME at its root (`${mirror}/${basename(url)}`) — the direct URL stays
// first, the mirror is the fallback for slow/blocked links.
export function planInstall(id, platform, { mirror } = {}) {
  const spec = TOOL_SPECS[id];
  if (spec == null) return { ok: false, reason: `未知工具：${id}（可选：${Object.keys(TOOL_SPECS).join(', ')}）` };
  if (!spec.platforms.includes(platform)) {
    return { ok: false, reason: `${spec.label} 不支持 ${platform}（支持：${spec.platforms.join(', ')}）` };
  }
  const ins = spec.install[platform];
  if (ins == null) return { ok: false, reason: `${spec.label} 在 ${platform} 无安装方案` };
  const plan = { id, bin: spec.bin, version: spec.version, ...ins };
  if (ins.method === 'zip' || ins.method === 'sfx') {
    plan.mirrorUrl = typeof mirror === 'string' && mirror !== ''
      ? `${mirror.replace(/\/+$/, '')}/${basename(ins.url)}`
      : null;
  }
  return { ok: true, plan };
}

// sha256(buf) hex digest + constant-ish compare against the pinned value.
export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}
export function verifyChecksum(buf, expected) {
  if (typeof expected !== 'string' || expected.length !== 64) return false;
  const actual = sha256Hex(buf);
  return actual.length === expected.length && actual === expected;
}

// buildPathAppendCommand(dirs) → the PowerShell one-liner that appends each
// dir to the USER Path (registry, not setx — no 1024 truncation, and the
// .NET API broadcasts WM_SETTINGCHANGE so new processes see it). Idempotent:
// a dir already present (substring match, same tolerance as tonight's manual
// run) is not appended twice.
export function buildPathAppendCommand(dirs) {
  if (dirs == null) return null;
  const list = (Array.isArray(dirs) ? dirs : [dirs]).map(String).filter((d) => d !== '');
  if (list.length === 0) return null;
  const psDirs = list.map((d) => `'${d.replace(/'/g, "''")}'`).join(',');
  return `$u=[Environment]::GetEnvironmentVariable('Path','User'); $add=@(${psDirs}) | Where-Object { $u -notlike "*$_*" }; if($add.Count -gt 0){ [Environment]::SetEnvironmentVariable('Path', ($u.TrimEnd(';') + ';' + ($add -join ';')), 'User') }`;
}
