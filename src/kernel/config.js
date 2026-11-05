// Kernel persistence/config helpers: atomic write + exclusive data-dir lock.
// All JSON persistence in the project funnels through atomicWrite (tmp + rename)
// so a crash mid-write can never leave a truncated file for readers.
import { mkdirSync, writeFileSync, renameSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function atomicWrite(file, data) {
  // Self-sufficient on parent dirs: callers should persist paths, not manage trees.
  mkdirSync(dirname(file), { recursive: true });
  // pid suffix keeps two writers of the same file from clobbering each other's stage.
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, data, { mode: 0o600 }); // owner-only (DESIGN §3); the rename carries it onto the final path
  renameSync(tmp, file); // atomic on POSIX: readers see old or new content, never partial
}

export function readJson(file) {
  // Missing/corrupt JSON is a normal state here (first boot, pre-atomicWrite crash):
  // report null instead of throwing so callers can treat it as "no config yet".
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

export function writeJson(file, obj) {
  atomicWrite(file, `${JSON.stringify(obj, null, 2)}\n`);
}

// Lock = <dir>/.lock/ containing a pid file; mkdir is the atomic claim.
// Liveness mirrors the predecessor supervisor's _alive: process.kill(pid, 0) —
// ESRCH means dead (lock adoptable), EPERM or any other error means a live holder.
export function lockDataDir(dir) {
  mkdirSync(dir, { recursive: true }); // locking a not-yet-created data dir is normal first boot
  const lockDir = join(dir, '.lock');
  const pidFile = join(lockDir, 'pid');
  const claim = () => {
    mkdirSync(lockDir); // throws EEXIST iff someone got there first
    writeFileSync(pidFile, String(process.pid));
  };
  try {
    claim();
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let pid = NaN;
    try { pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10); } catch {}
    // Positive int only: kill(0, *) would signal our whole process group.
    let alive = Number.isInteger(pid) && pid > 0;
    if (alive) {
      try { process.kill(pid, 0); } catch (err) { alive = err.code !== 'ESRCH'; }
    }
    if (alive) throw new Error(`data dir locked by pid ${pid}`);
    rmSync(lockDir, { recursive: true, force: true }); // stale holder: clean up and take over
    claim(); // lost race here surfaces as EEXIST to the caller, which is correct
  }
  return {
    // Best-effort and idempotent: a failed unlock just leaves a stale lock for the adopt path.
    release: () => { try { rmSync(lockDir, { recursive: true, force: true }); } catch {} },
  };
}
