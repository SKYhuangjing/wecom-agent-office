#!/usr/bin/env node
// scripts/updater.js — Cross-platform detached updater for WAO (macOS / Linux / Windows).
// Runs detached from the main service. Two modes:
//
//   A. --zip-url mode (recommended): download the release zip FIRST (parent keeps
//      serving — zero downtime during download), then kill parent, overlay, restart.
//   B. --stage-dir mode: the stage is already prepared by the caller; wait for
//      parent exit, overlay, restart.
//   C. --restart-only mode (P1-A): NO download, NO overlay — kill the parent
//      and restart it with its own args (PATH refreshes, config reloads).
//
// Steps (zip-url mode):
// 1. Download the zip from --zip-url into data/.update-stage/ (no HTTP timeout
//    pressure — slow networks can take minutes; the old service stays up)
// 2. Extract + validate (package.json & src/index.js must exist)
// 3. Kill the parent service process (it keeps serving until THIS point)
// 4. Safely overlay new code into targetDir (STRICTLY PRESERVING data/)
// 5. Compare package.json dependencies, run npm install --omit=dev if changed
// 6. Update data/version.json with the target commit SHA
// 7. Restart WAO (via launchd / systemd if managed, or by spawning a new detached process)
// 8. Probe /healthz, log outcome to data/logs/updater.log, and exit.

import process from 'node:process';
import { execFileSync, spawn } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const parseArgs = (argv) => {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (k === 'lan' || k === 'restart-only') {
        flags[k] = true;
        continue;
      }
      flags[k] = argv[i + 1];
      i++;
    }
  }
  return flags;
};

const sleepSync = (ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy wait */ }
};

export function copyOverlay(srcDir, destDir) {
  // Directories and files that must NEVER be overwritten from the stage
  const PROTECTED = new Set(['data', '.git', 'logs', '.lock']);
  const entries = readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (PROTECTED.has(entry.name)) continue;
    const src = join(srcDir, entry.name);
    const dest = join(destDir, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(dest, { recursive: true });
      copyOverlay(src, dest);
    } else {
      cpSync(src, dest, { force: true });
    }
  }
}

export function needNpmInstall(oldPkgPath, newPkgPath) {
  if (!existsSync(oldPkgPath) || !existsSync(newPkgPath)) return true;
  try {
    const oldDeps = JSON.stringify(JSON.parse(readFileSync(oldPkgPath, 'utf8')).dependencies ?? {});
    const newDeps = JSON.stringify(JSON.parse(readFileSync(newPkgPath, 'utf8')).dependencies ?? {});
    return oldDeps !== newDeps;
  } catch {
    return true;
  }
}

export function waitProcessExit(pid, timeoutMs = 15000) {
  if (!pid || pid <= 0) return true;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0);
      sleepSync(200);
    } catch (err) {
      if (err?.code === 'ESRCH') return true;
      throw err;
    }
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
  return false;
}

export function killProcess(pid) {
  if (!pid || pid <= 0) return;
  try {
    // Node 原生 kill = TerminateProcess 单进程——绝不能用 taskkill /T：/T 走
    // 进程树会把派生本更新器的自己一并杀掉（真机实测踩坑：日志止于
    // "stopping parent"，updater 自尽，服务停机无人接管）。
    process.kill(pid);
  } catch { /* already gone or access denied — waitProcessExit handles the rest */ }
}

// Download a zip with generous patience (slow networks: no caller waiting on us).
// proxyFetch（--proxy 传入时）：动态 import 仓库 node_modules 的 undici 拿
// ProxyAgent——失败静默回退直连（更新器保零依赖韧性：undici 缺席/损坏不致命，
// 只是慢网直连），日志留痕。
let cachedProxy = null; // { fetch, agent } — 版本配套成对缓存，绝不与全局 fetch 混搭
let cachedProxyUrl = '';
async function proxyFetchWith(url, opts, proxyUrl) {
  if (!proxyUrl) return fetch(url, opts);
  try {
    if (cachedProxyUrl !== proxyUrl || cachedProxy == null) {
      const { ProxyAgent, fetch: undiciFetch } = await import('undici');
      cachedProxy = { fetch: undiciFetch, agent: new ProxyAgent(proxyUrl) };
      cachedProxyUrl = proxyUrl;
    }
    return cachedProxy.fetch(url, { ...opts, dispatcher: cachedProxy.agent });
  } catch (err) {
    log2(`proxy agent unavailable (${err?.message ?? err}) — falling back to direct`);
    return fetch(url, opts);
  }
}
function log2(msg) { try { console.error(`[updater] ${msg}`); } catch { /* ignore */ } }

export async function downloadZip(url, outFile, log, timeoutMs = 600000, proxyUrl = '') {
  const res = await proxyFetchWith(url, {
    headers: { 'User-Agent': 'WAO-Updater/1.0' },
    signal: AbortSignal.timeout(timeoutMs),
  }, proxyUrl);
  if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(outFile, buf);
  log(`zip downloaded: ${buf.length} bytes from ${url}`);
  return outFile;
}

export function extractZip(zipPath, extDir, log) {
  rmSync(extDir, { recursive: true, force: true });
  mkdirSync(extDir, { recursive: true });
  if (process.platform === 'win32') {
    try {
      execFileSync('tar.exe', ['-xf', zipPath, '-C', extDir], { stdio: 'ignore', timeout: 60000 });
    } catch {
      execFileSync('powershell', ['-NoProfile', '-Command',
        `Expand-Archive -Path '${zipPath}' -DestinationPath '${extDir}' -Force`], { stdio: 'ignore', timeout: 120000 });
    }
  } else {
    try {
      execFileSync('tar', ['-xf', zipPath, '-C', extDir], { stdio: 'ignore', timeout: 60000 });
    } catch {
      execFileSync('unzip', ['-q', zipPath, '-d', extDir], { stdio: 'ignore', timeout: 60000 });
    }
  }
  // codeload zips wrap in <repo>-<branch>/; git archive zips are at root.
  const subdirs = readdirSync(extDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  const realSrc = subdirs.length === 1 ? join(extDir, subdirs[0].name) : extDir;
  if (!existsSync(join(realSrc, 'package.json')) || !existsSync(join(realSrc, 'src', 'index.js'))) {
    throw new Error('zip integrity check failed: package.json or src/index.js missing');
  }
  log(`zip extracted and validated: ${realSrc}`);
  return realSrc;
}

export function probeHealth(url, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const bin = process.platform === 'win32' ? 'curl.exe' : 'curl';
      const out = execFileSync(bin, ['-s', '-m', '2', url], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (out && out.includes('"ok":true')) return true;
    } catch { /* retry */ }
    sleepSync(500);
  }
  return false;
}

export async function runUpdater(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  const parentPid = Number(flags['parent-pid'] || 0);
  const restartOnly = flags['restart-only'] === true;
  const stageDir = flags['stage-dir'] ? resolve(flags['stage-dir']) : null;
  const zipUrl = flags['zip-url'] || '';
  const targetDir = flags['target-dir'] ? resolve(flags['target-dir']) : null;
  const dataDir = flags['data-dir'] ? resolve(flags['data-dir']) : null;
  const targetCommit = flags['target-commit'] || '';
  const port = Number(flags.port || 8792);
  const host = flags.host || '127.0.0.1';
  const lan = flags.lan === true;
  const restartMode = flags['restart-mode'] || 'auto';
  const proxyUrl = typeof flags.proxy === 'string' ? flags.proxy : '';

  if ((!restartOnly && !stageDir && !zipUrl) || !targetDir || !dataDir) {
    console.error('updater: missing required --stage-dir/--zip-url/--restart-only, --target-dir, or --data-dir');
    process.exit(1);
  }

  const logFile = join(dataDir, 'logs', 'updater.log');
  mkdirSync(join(dataDir, 'logs'), { recursive: true });
  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try { writeFileSync(logFile, line, { flag: 'a' }); } catch { /* ignore */ }
  };

  log(`updater started: parentPid=${parentPid}, restartMode=${restartMode}, targetCommit=${targetCommit}, mode=${restartOnly ? 'restart-only' : zipUrl ? 'zip-url' : 'stage-dir'}${proxyUrl ? `, proxy=${proxyUrl}` : ''}`);

  try {
    // —— Phase 1: prepare the stage (parent keeps serving — zero downtime here) ——

    let src = stageDir;
    if (restartOnly) {
      src = null; // nothing to prepare
    } else if (zipUrl) {
      const stage = join(dataDir, '.update-stage');
      mkdirSync(stage, { recursive: true });
      const zipPath = join(stage, 'wao-update.zip');
      log(`downloading ${zipUrl} (parent ${parentPid} stays up during download)...`);
      await downloadZip(zipUrl, zipPath, log, 600000, proxyUrl);
      src = extractZip(zipPath, join(stage, 'ext'), log);
    }

    // —— Phase 2: take the old service down (only after the stage is ready) ——

    if (parentPid > 0) {
      log(`stage ready — stopping parent pid ${parentPid}...`);
      killProcess(parentPid);
      waitProcessExit(parentPid, 15000);
      log('parent stopped');
    }

    // Clear stale lock if parent left one
    const lockPidFile = join(dataDir, '.lock', 'pid');
    try {
      if (existsSync(lockPidFile)) {
        const holder = Number(readFileSync(lockPidFile, 'utf8').trim());
        if (holder === parentPid) rmSync(lockPidFile, { force: true });
      }
    } catch { /* best effort */ }

    // —— Phase 3: overlay + deps + version ——

    if (restartOnly) {
      log('restart-only: skipping overlay/deps/version phases');
    }
    const oldPkg = restartOnly ? null : join(targetDir, 'package.json');
    const newPkg = restartOnly ? null : join(src, 'package.json');
    const shouldNpm = !restartOnly && needNpmInstall(oldPkg, newPkg);

    if (!restartOnly) {
      log(`copying files from ${src} to ${targetDir} (data/ protected)...`);
      copyOverlay(src, targetDir);
      log('file overlay complete');
    }

    if (shouldNpm) {
      log('package.json dependencies changed; running npm install --omit=dev...');
      const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      try {
        execFileSync(npmBin, ['install', '--omit=dev', '--no-audit', '--no-fund'], {
          cwd: targetDir,
          stdio: 'ignore',
        });
        log('npm install complete');
      } catch (err) {
        log(`npm install failed: ${err.message}`);
      }
    }

    if (!restartOnly) {
      const versionFile = join(dataDir, 'version.json');
      let pkgVer = '0.1.0';
      try { pkgVer = JSON.parse(readFileSync(join(targetDir, 'package.json'), 'utf8')).version; } catch { /* fallback */ }
      try {
        writeFileSync(versionFile, JSON.stringify({ version: pkgVer, commit: targetCommit, updatedAt: Date.now() }, null, 2));
        log(`version.json updated: commit=${targetCommit}, version=${pkgVer}`);
      } catch (err) {
        log(`failed to write version.json: ${err.message}`);
      }
    }

    // Clean stage
    try { rmSync(join(dataDir, '.update-stage'), { recursive: true, force: true }); } catch { /* ignore */ }

    // —— Phase 4: restart WAO ——

    log(`restarting WAO (mode=${restartMode})...`);
    let restarted = false;

    if (restartMode === 'launchd' && process.platform === 'darwin') {
      try {
        const uid = process.getuid();
        execFileSync('launchctl', ['kickstart', '-k', `gui/${uid}/com.wecom-agent-office`], { stdio: 'ignore' });
        log('launchctl kickstart executed');
        restarted = true;
      } catch (err) {
        log(`launchctl kickstart failed: ${err.message}; falling back to detached spawn`);
      }
    } else if (restartMode === 'systemd' && process.platform === 'linux') {
      try {
        execFileSync('systemctl', ['--user', 'restart', 'wao'], { stdio: 'ignore' });
        log('systemctl --user restart executed');
        restarted = true;
      } catch (err) {
        log(`systemctl restart failed: ${err.message}; falling back to detached spawn`);
      }
    }

    if (!restarted) {
      const entry = join(targetDir, 'src', 'index.js');
      const startArgs = [entry, 'start', '--port', String(port), '--host', host, '--data-dir', dataDir];
      if (lan) startArgs.push('--lan');
      log(`spawning detached process: ${process.execPath} ${startArgs.join(' ')}`);
      const child = spawn(process.execPath, startArgs, {
        detached: true,
        stdio: 'ignore',
        cwd: targetDir,
        env: process.env,
      });
      child.unref();
      log(`detached child spawned: pid=${child.pid}`);
    }

    const probeHost = host === '0.0.0.0' ? '127.0.0.1' : host;
    const probeUrl = `http://${probeHost}:${port}/healthz`;
    log(`probing health at ${probeUrl}...`);
    const healthy = probeHealth(probeUrl, 20000);
    log(`health probe result: healthy=${healthy}`);
    log(healthy ? 'updater completed successfully' : 'updater finished but service health NOT confirmed — check wao.log');
  } catch (err) {
    log(`updater FAILED: ${err?.message ?? err}`);
    process.exit(1);
  }
}

// Direct invocation CLI（fileURLToPath：Windows 下 URL pathname 是 /C:/… 编码形
// 式，与 argv[1] 的 C:\… 永不相等——fileURLToPath 才是跨平台正解）
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runUpdater().catch((err) => { console.error(err); process.exit(1); });
}
