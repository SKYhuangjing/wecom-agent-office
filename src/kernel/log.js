// Kernel logger: stderr mirror + size-rotated file. Rotation is best-effort.
import { mkdirSync, openSync, writeSync, closeSync, statSync, renameSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger({ file = null, level = 'info', maxBytes = 10 * 1024 * 1024, keep = 5 } = {}) {
  let fd = null;
  if (file) { mkdirSync(dirname(file), { recursive: true }); fd = openSync(file, 'a'); }
  const rotate = () => {
    if (fd == null) return;
    try { closeSync(fd); } catch {}
    for (let i = keep - 1; i >= 1; i--) {
      const from = `${file}.${i}`, to = `${file}.${i + 1}`;
      if (existsSync(from)) try { renameSync(from, to); } catch {}
    }
    if (existsSync(file)) try { renameSync(file, `${file}.1`); } catch {}
    fd = openSync(file, 'a');
  };
  const fmt = (a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })());
  const write = (lvl, args) => {
    if (LEVELS[lvl] < LEVELS[level]) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase()} ${args.map(fmt).join(' ')}\n`;
    process.stderr.write(line);
    if (fd != null) {
      writeSync(fd, line);
      try { if (statSync(file).size > maxBytes) rotate(); } catch {}
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
