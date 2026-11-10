// Tool provisioning executor (DESIGN-TOKEN-OPT P1-A) — the side-effecting
// half of src/tools-spec.js: download (mirror fallback) → sha256 gate →
// extract/flatten → PATH (PowerShell, user registry) → data/tools.json
// registry. Every exec/spawn/fs primitive is injectable so the orchestration
// is unit-testable without touching the network or the real PATH.
import { execFile, execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { planInstall, verifyChecksum, buildPathAppendCommand, TOOLS_INSTALL_ROOT_DIRNAME } from './tools-spec.js';
import { proxyEnv, proxyFetch } from '../src/kernel/proxy.js';

const installRoot = () => join(homedir(), TOOLS_INSTALL_ROOT_DIRNAME);

// —— data/tools.json registry (state machine of background installs) —————————
// shape: { [id]: { state: 'installing'|'installed'|'failed', version?, path?,
//                  installedAt?, startedAt?, error? } }
export function readToolsRegistry(file) {
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    if (doc != null && typeof doc === 'object' && !Array.isArray(doc)) return doc;
  } catch { /* missing/corrupt → empty */ }
  return {};
}
export function writeToolsRegistry(file, doc) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
}

// Probe one tool: which-injected lookup + `--version` first line (3s cap).
export function probeTool(spec, which) {
  const found = which(spec.bin);
  if (found == null) return { state: 'missing', path: null, version: null };
  let version = null;
  try {
    const out = execFileSync(found, ['--version'], {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    version = String(out).split('\n')[0].trim() || null;
  } catch { /* a binary that cannot --version still counts as installed */ }
  return { state: 'available', path: found, version };
}

// download(urls, log) — try each URL in order (direct → mirror); buffers the
// whole body (updater.downloadZip discipline: AbortSignal timeout, generous
// patience — background job, nobody waits on us). Throws the LAST error.
export async function downloadWithFallback(urls, log, { timeoutMs = 600_000, fetchImpl = null, proxy } = {}) {
  // 默认走 proxyFetch（设置的网络代理即时生效）；测试可注入 fetchImpl 旁路。
  const doFetch = fetchImpl ?? ((url, opts) => proxyFetch(url, opts, { proxy }));
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await doFetch(url, {
        headers: { 'User-Agent': 'WAO-Tools/1.0' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new Error('empty body');
      log?.(`downloaded ${buf.length} bytes from ${url}`);
      return buf;
    } catch (err) {
      lastErr = err;
      log?.(`download failed (${url}): ${err?.message ?? err}`);
    }
  }
  throw lastErr ?? new Error('no download URLs');
}

// locate <exe> under dir (rtk zip = root, ripgrep zip = one nested dir).
export function locateExe(dir, exe) {
  const direct = join(dir, exe);
  if (existsSync(direct)) return direct;
  const name = exe.split(/[\\/]/).pop();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const hit = locateExe(join(dir, entry.name), name);
    if (hit != null) return hit;
  }
  return null;
}

// win32 zip install: stage → verify → extract → flatten exe into installDir.
async function installZip(plan, { stageDir, log, fetchImpl, proxy }) {
  const urls = [plan.url, ...(plan.mirrorUrl ? [plan.mirrorUrl] : [])];
  const buf = await downloadWithFallback(urls, log, { fetchImpl, proxy });
  if (!verifyChecksum(buf, plan.sha256)) {
    throw new Error(`SHA256 校验失败（期望 ${plan.sha256}，实得 ${buf.length} 字节——网络截断或文件被换，拒绝安装）`);
  }
  const zipPath = join(stageDir, `${plan.id}.zip`);
  writeFileSync(zipPath, buf);
  const extDir = join(stageDir, 'ext');
  rmSync(extDir, { recursive: true, force: true });
  mkdirSync(extDir, { recursive: true });
  execFileSync('tar.exe', ['-xf', zipPath, '-C', extDir], { stdio: 'ignore', timeout: 120_000 });
  const exeName = plan.exe.split(/[\\/]/).pop();
  const found = locateExe(extDir, exeName);
  if (found == null) throw new Error(`解压后未找到 ${plan.exe}`);
  const installDir = join(installRoot(), plan.dirName);
  mkdirSync(installDir, { recursive: true });
  cpSync(found, join(installDir, exeName), { force: true });
  log?.(`installed ${exeName} → ${installDir}`);
  return { installDir, pathEntries: [installDir] };
}

// win32 7z-SFX install (PortableGit): run the self-extractor with -o<dir> -y.
async function installSfx(plan, { stageDir, log, fetchImpl, proxy }) {
  const urls = [plan.url, ...(plan.mirrorUrl ? [plan.mirrorUrl] : [])];
  const buf = await downloadWithFallback(urls, log, { fetchImpl, proxy });
  if (!verifyChecksum(buf, plan.sha256)) {
    throw new Error(`SHA256 校验失败（期望 ${plan.sha256.slice(0, 16)}…，实得 ${buf.length} 字节——拒绝执行未知二进制）`);
  }
  const sfxPath = join(stageDir, `${plan.id}.7z.exe`);
  writeFileSync(sfxPath, buf);
  const installDir = join(installRoot(), plan.dirName);
  rmSync(installDir, { recursive: true, force: true }); // SFX merges; a clean dir avoids stale mixes
  execFileSync(sfxPath, [`-o${installDir}`, '-y'], { stdio: 'ignore', timeout: 600_000 });
  if (!existsSync(join(installDir, plan.exe))) {
    throw new Error(`自解压后未找到 ${plan.exe}——SFX 输出布局变化？`);
  }
  log?.(`self-extracted → ${installDir}`);
  const pathEntries = (plan.pathSuffixes ?? []).map((s) => join(installDir, s));
  return { installDir, pathEntries };
}

// Append to the user PATH via PowerShell (registry + WM_SETTINGCHANGE).
export function appendUserPath(dirs) {
  const cmd = buildPathAppendCommand(dirs);
  if (cmd == null) return false;
  execFileSync('powershell', ['-NoProfile', '-Command', cmd], { stdio: 'ignore', timeout: 30_000 });
  return true;
}

// brew install (darwin/linux) — Homebrew owns PATH; no manual PATH edits.
// MUST stay awaited-async（盲评 P0-1 二次确认）：同步 execFileSync 会冻结整个
// 事件循环（所有 bot/SSE/healthz）数分钟，连 POST 应答都出不去；installTool
// 也必须 await 本函数，否则会在安装完成前就写 installed 状态。
const execFileAsync = (bin, args, opts) => new Promise((resolve, reject) => {
  execFile(bin, args, opts, (err) => (err ? reject(err) : resolve()));
});
async function installBrew(plan, { log, spawnCliImpl, proxy }) {
  // 代理环境（含 NO_PROXY=localhost,127.0.0.1 红线）合入子进程——brew 自己
  // 的 GHCR/Homebrew 拉取走用户代理；注入式 spawnCliImpl（测试）不带 env 面。
  const run = spawnCliImpl ?? ((bin, args) => execFileAsync(bin, args, {
    stdio: 'ignore', timeout: 900_000, // generous cap — brew can compile from source
    env: { ...process.env, ...proxyEnv(proxy) },
  }));
  log?.(`brew install ${plan.formula}（可能需要数分钟）`);
  await run('brew', ['install', '-q', plan.formula]);
  return { installDir: null, pathEntries: [] };
}

// installTool(id, { platform, mirror, registryFile, stageDir, log, which,
//   fetchImpl, spawnCliImpl, appendPathImpl }) → final registry entry. The
// CALLER owns the installing→installed/failed transitions in tools.json.
export async function installTool(id, opts) {
  const {
    platform = process.platform, mirror = process.env.WAO_DOWNLOAD_MIRROR,
    registryFile, stageDir, log = () => {}, which,
    fetchImpl, spawnCliImpl, appendPathImpl = appendUserPath,
    proxy, // {enabled, proxyUrl}——设置页网络代理；download/brew 全走它
  } = opts;
  const { ok, reason, plan } = planInstall(id, platform, { mirror });
  if (!ok) throw new Error(reason);
  mkdirSync(stageDir, { recursive: true });
  let result;
  if (plan.method === 'zip') result = await installZip(plan, { stageDir, log, fetchImpl, proxy });
  else if (plan.method === 'sfx') result = await installSfx(plan, { stageDir, log, fetchImpl, proxy });
  else if (plan.method === 'brew') result = await installBrew(plan, { log, spawnCliImpl, proxy });
  else throw new Error(`未知安装方式：${plan.method}`);
  if (result.pathEntries.length > 0) appendPathImpl(result.pathEntries);
  // post-verify with the freshly appended PATH when we can
  let verified = null;
  if (typeof which === 'function') verified = which(plan.bin);
  const entry = {
    state: 'installed', version: plan.version, path: verified ?? result.installDir ?? null,
    installedAt: Date.now(),
  };
  if (registryFile != null) {
    const doc = readToolsRegistry(registryFile);
    doc[id] = entry;
    writeToolsRegistry(registryFile, doc);
  }
  rmSync(stageDir, { recursive: true, force: true });
  return entry;
}
