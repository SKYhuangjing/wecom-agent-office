// Kernel logger: size-rotated file, plus a stderr mirror ONLY when there is
// no file (pure stderr mode) or the file side has degraded — launchd log
// governance: a healthy file logger keeps stderr silent so launchd.err.log
// stops duplicating every line the file already carries.
import { mkdirSync, openSync, writeSync, closeSync, statSync, renameSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger({ file = null, level = 'info', maxBytes = 10 * 1024 * 1024, keep = 5 } = {}) {
  let fd = null;
  let stderrOnly = file == null; // no file → stderr is the sink; flips on degrade
  // Disk-full (ENOSPC) / permission failures must never throw into callers
  // (M1 minor #3, hardened M3-T9): on any file-side failure the logger
  // degrades to stderr-only and warns ONCE on stderr — the only channel left.
  const degrade = (err) => {
    if (fd != null) { try { closeSync(fd); } catch {} }
    fd = null;
    stderrOnly = true;
    process.stderr.write(`${new Date().toISOString()} WARN [log] file logging degraded to stderr-only (${err?.code ?? err?.message ?? err})\n`);
  };
  // mode applies at file CREATION only: the log carries secrets/turn content,
  // so it is born 0600 (DESIGN §3); rotated names inherit it via rename.
  if (file) {
    mkdirSync(dirname(file), { recursive: true });
    try { fd = openSync(file, 'a', 0o600); } catch (err) { degrade(err); }
  }
  let rotateFails = 0; // consecutive rotate passes with ≥1 failed rename
  let rotateDisabled = false; // 3 strikes → stop trying (Windows: file held)
  const rotate = () => {
    if (fd == null || rotateDisabled) return;
    try { closeSync(fd); } catch {}
    let failed = false;
    for (let i = keep - 1; i >= 1; i--) {
      const from = `${file}.${i}`, to = `${file}.${i + 1}`;
      if (existsSync(from)) try { renameSync(from, to); } catch { failed = true; }
    }
    if (existsSync(file)) { try { renameSync(file, `${file}.1`); } catch { failed = true; } }
    rotateFails = failed ? rotateFails + 1 : 0;
    if (rotateFails >= 3 && !rotateDisabled) {
      rotateDisabled = true;
      // Windows 空转修复 (P2): renames keep failing (log held by editor/AV)
      // while the file side still works — stop the futile close/reopen churn
      // per write and say so ONCE on stderr (same visibility class as the
      // degrade warn); logging keeps appending to the un-rotated file.
      process.stderr.write(`${new Date().toISOString()} WARN [log] log rotation disabled after ${rotateFails} consecutive failures — file keeps growing at ${file}\n`);
    }
    fd = openSync(file, 'a', 0o600);
  };
  const fmt = (a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })());
  const write = (lvl, args) => {
    if (LEVELS[lvl] < LEVELS[level]) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase()} ${args.map(fmt).join(' ')}\n`;
    if (stderrOnly) process.stderr.write(line);
    if (fd != null) {
      try {
        writeSync(fd, line);
        if (statSync(file).size > maxBytes) rotate();
      } catch (err) { degrade(err); }
    }
  };
  const api = {
    debug: (...a) => write('debug', a), info: (...a) => write('info', a),
    warn: (...a) => write('warn', a), error: (...a) => write('error', a),
    child: (prefix) => ({
      debug: (...a) => write('debug', [`[${prefix}]`, ...a]), info: (...a) => write('info', [`[${prefix}]`, ...a]),
      warn: (...a) => write('warn', [`[${prefix}]`, ...a]), error: (...a) => write('error', [`[${prefix}]`, ...a]),
      child: api.child,
    }),
  };
  return api;
}
