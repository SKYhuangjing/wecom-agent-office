#!/usr/bin/env node
// scripts/updater.js — Cross-platform detached updater for WAO (macOS / Linux / Windows).
// Runs detached from the main service. Steps:
// 1. Wait for the parent service process to exit (releasing port & data/.lock)
// 2. Safely overlay new code into targetDir (STRICTLY PRESERVING data/)
// 3. Compare package.json dependencies, run npm install --omit=dev if changed
// 4. Update data/version.json with the target commit SHA
// 5. Restart WAO (via launchd / systemd if managed, or by spawning a new detached process)
// 6. Probe /healthz, log outcome to data/logs/updater.log, and exit.

import process from 'node:process';
import { execFileSync, spawn } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const parseArgs = (argv) => {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (k === 'lan') {
        flags.lan = true;
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
  while (Date.now() < end) { /* busy wait fallback or Atomics.wait */ }
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

export function probeHealth(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      // Use curl if available for sync probe, or fallback
      const bin = process.platform === 'win32' ? 'curl.exe' : 'curl';
      const out = execFileSync(bin, ['-s', '-m', '2', url], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (out && out.includes('"ok":true')) return true;
    } catch { /* retry */ }
    sleepSync(500);
  }
  return false;
}

export function runUpdater(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  const parentPid = Number(flags['parent-pid'] || 0);
  const stageDir = flags['stage-dir'] ? resolve(flags['stage-dir']) : null;
  const targetDir = flags['target-dir'] ? resolve(flags['target-dir']) : null;
  const dataDir = flags['data-dir'] ? resolve(flags['data-dir']) : null;
  const targetCommit = flags['target-commit'] || '';
  const port = Number(flags.port || 8792);
  const host = flags.host || '127.0.0.1';
  const lan = flags.lan === true;
  const restartMode = flags['restart-mode'] || 'auto';

  if (!stageDir || !targetDir || !dataDir) {
    console.error('updater: missing required --stage-dir, --target-dir, or --data-dir');
    process.exit(1);
  }

  const logFile = join(dataDir, 'logs', 'updater.log');
  mkdirSync(join(dataDir, 'logs'), { recursive: true });
  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try { writeFileSync(logFile, line, { flag: 'a' }); } catch { /* ignore */ }
  };

  log(`updater started: parentPid=${parentPid}, restartMode=${restartMode}, targetCommit=${targetCommit}`);

  // Step 1: Wait for parent process to exit
  if (parentPid > 0) {
    log(`waiting for parent pid ${parentPid} to terminate...`);
    const exited = waitProcessExit(parentPid, 15000);
    log(`parent process terminated: exited=${exited}`);
  }

  // Clear stale lock if parent left one
  const lockPidFile = join(dataDir, '.lock', 'pid');
  try {
    if (existsSync(lockPidFile)) {
      const holder = Number(readFileSync(lockPidFile, 'utf8').trim());
      if (holder === parentPid) rmSync(lockPidFile, { force: true });
    }
  } catch { /* best effort */ }

  // Step 2: Overlay files into targetDir (preserving data/)
  const oldPkg = join(targetDir, 'package.json');
  const newPkg = join(stageDir, 'package.json');
  const shouldNpm = needNpmInstall(oldPkg, newPkg);

  log(`copying files from ${stageDir} to ${targetDir} (data/ protected)...`);
  copyOverlay(stageDir, targetDir);
  log('file overlay complete');

  // Step 3: Run npm install if dependencies changed
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

  // Step 4: Write version.json
  const versionFile = join(dataDir, 'version.json');
  let pkgVer = '0.1.0';
  try { pkgVer = JSON.parse(readFileSync(join(targetDir, 'package.json'), 'utf8')).version; } catch { /* fallback */ }
  const meta = {
    version: pkgVer,
    commit: targetCommit,
    updatedAt: Date.now(),
  };
  try {
    writeFileSync(versionFile, JSON.stringify(meta, null, 2));
    log(`version.json updated: commit=${targetCommit}, version=${pkgVer}`);
  } catch (err) {
    log(`failed to write version.json: ${err.message}`);
  }

  // Clean stage
  try { rmSync(stageDir, { recursive: true, force: true }); } catch { /* ignore */ }

  // Step 5: Restart WAO
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

  // Step 6: Probe health
  const probeHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  const probeUrl = `http://${probeHost}:${port}/healthz`;
  log(`probing health at ${probeUrl}...`);
  const healthy = probeHealth(probeUrl, 15000);
  log(`health probe result: healthy=${healthy}`);
  log('updater completed successfully');
}

// Direct invocation CLI
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  runUpdater();
}
