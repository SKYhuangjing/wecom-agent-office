// Cross-platform correctness grid (P1+P2): the behaviors that only differ on
// Windows/Linux but must be pinned HERE, on macOS, as pure functions or
// injectable seams — a real Windows CI is not available, so the guards are
// tested with hand-built Windows-style path strings and injected delimiters,
// exactly the shapes the platform branches will see there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// —— P1-1: static-root containment uses the platform separator ———————————————
// On Windows resolve() yields backslash-joined paths, so a '/' prefix check
// never matches and every console route 404s (web 控制台全灭). isUnderRoot is
// the extracted guard; tests feed it hand-built Windows strings.
import { fileUnder, isUnderRoot } from '../../src/kernel/http.js';

test('isUnderRoot: Windows backslash paths match root, sibling prefix and escape do not', () => {
  const root = 'C:\\www\\dist';
  const win = '\\'; // inject the Windows separator (on this POSIX host sep is '/')
  assert.equal(isUnderRoot(root, root, win), true, 'root itself is under root');
  assert.equal(isUnderRoot(root, 'C:\\www\\dist\\assets\\app.js', win), true, 'backslash child matches');
  // sibling sharing the textual prefix must NOT pass (C:\www\dist-extra)
  assert.equal(isUnderRoot(root, 'C:\\www\\dist-extra', win), false, 'sibling with shared prefix rejected');
  assert.equal(isUnderRoot(root, 'C:\\www\\other\\x', win), false, 'escape rejected');
  assert.equal(isUnderRoot(root, 'D:\\www\\dist\\x', win), false, 'other drive rejected');
  // and the POSIX separator does NOT accept backslash children (the old bug
  // inverted: on Windows the '/' check never matched backslash paths)
  assert.equal(isUnderRoot(root, 'C:\\www\\dist\\assets\\app.js', '/'), false);
});

test('isUnderRoot: POSIX separator behavior unchanged (sep is / here)', () => {
  const root = '/srv/www';
  assert.equal(isUnderRoot(root, '/srv/www/a.js'), true);
  assert.equal(isUnderRoot(root, '/srv/www-x/a.js'), false, 'sibling prefix trap');
  assert.equal(isUnderRoot(root, '/srv'), false);
});

test('fileUnder: POSIX resolve/guard behavior unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-fu-'));
  assert.equal(fileUnder(dir, 'a/b.txt'), join(dir, 'a', 'b.txt'));
  assert.equal(fileUnder(dir, 'a.txt'), join(dir, 'a.txt'));
  assert.equal(fileUnder(dir, '../escape.txt'), null);
  assert.equal(fileUnder(dir, '%2e%2e/escape'), null);
  assert.equal(fileUnder(dir, 'bad%zz'), null); // malformed % never reaches the FS
  assert.equal(fileUnder(dir, 42), null); // non-string input
});

// —— P1-2: Windows spawn shim (cmd.exe escaping + POSIX passthrough) —————————
import { winArg, spawnCli, isWindows } from '../../src/kernel/spawn.js';

// cmd.exe pass: every ^ introduced by winArg is consumed, next char verbatim.
const cmdStrip = (line) => line.replace(/\^(.)/g, '$1');

// MSVCRT argv parse (what node.exe does with the line cmd hands it): "
// toggles quoting; backslashes are special only before a quote (2n → n
// backslashes + toggle, 2n+1 → n backslashes + literal "). Simulating BOTH
// parses proves winArg's output survives cmd.exe AND the target's argv split.
function argvOf(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  let i = 0;
  const push = () => { out.push(cur); cur = ''; };
  while (i < line.length) {
    const c = line[i];
    if (c === '\\') {
      let n = 0;
      while (line[i + n] === '\\') n++;
      if (line[i + n] === '"') {
        const backslashes = Math.floor(n / 2);
        cur += '\\'.repeat(backslashes);
        if (n % 2 === 1) { cur += '"'; i += n + 1; continue; }
        i += n; continue;
      }
      cur += '\\'.repeat(n);
      i += n;
      continue;
    }
    if (c === '"') { quoted = !quoted; i++; continue; }
    if (c === ' ' && !quoted) { push(); i++; continue; }
    cur += c;
    i++;
  }
  if (cur !== '' || quoted) push();
  return out;
}

test('winArg: cmd.exe double-parse round-trips adversarial argv tokens', () => {
  const cases = [
    'hello world',
    'say "hi" politely',
    'a&b|c>d<e',
    'C:\\Program Files\\nodejs\\dsh.cmd',
    'path\\ending\\backslash\\',
    '100% ^ crazy! (really)? `bt` ; , *',
    'quotes "at" "" end"',
    'plain',
  ];
  for (const arg of cases) {
    const line = ['node.exe', arg].map(winArg).join(' ');
    // cmd.exe consumes the carets; the target's argv parser then sees clean
    // quoted tokens. If either pass went wrong the round-trip breaks.
    assert.deepEqual(argvOf(cmdStrip(line)), ['node.exe', arg], `round-trip broke for ${JSON.stringify(arg)} → ${JSON.stringify(line)}`);
  }
});

test('winArg: exact output shape — quoted, every metachar (incl. spaces) caret-escaped', () => {
  // pin the algorithm's shape so an accidental escape-change is caught by
  // diff, not just by the round-trip (cross-spawn's escape, byte for byte)
  assert.equal(winArg('plain'), '^"plain^"');
  assert.equal(winArg('a b'), '^"a^ b^"');
  assert.equal(winArg('x&y'), '^"x^&y^"');
  // a literal caret in the input doubles (cmd eats one)
  assert.equal(winArg('a^b'), '^"a^^b^"');
});

test('spawnCli: POSIX branch is a plain passthrough spawn (real child, real stdio)', async () => {
  if (isWindows) return; // on Windows this needs a real .cmd; not our CI
  const child = spawnCli(process.execPath, ['-e', 'process.stdout.write("wao-spawn-ok")'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  assert.equal(code, 0);
  assert.equal(out, 'wao-spawn-ok');
});

// —— P1-3: atomicWrite rename retry ————————————————————————————————————————
import { renameWithRetry } from '../../src/kernel/config.js';

const errOf = (code) => Object.assign(new Error(code), { code });

test('renameWithRetry: EPERM twice then success — third attempt wins', () => {
  let calls = 0;
  const rename = (from, to) => { calls++; if (calls < 3) throw errOf('EPERM'); };
  renameWithRetry(rename, 'a', 'b');
  assert.equal(calls, 3);
});

test('renameWithRetry: EBUSY/EACCES retried, non-retryable codes are not', () => {
  for (const code of ['EBUSY', 'EACCES']) {
    let calls = 0;
    const rename = () => { calls++; throw errOf(code); };
    assert.throws(() => renameWithRetry(rename, 'a', 'b'), (e) => e.code === code, code);
    assert.equal(calls, 3, `${code}: exactly 3 attempts`);
  }
  let calls = 0;
  const rename = () => { calls++; throw errOf('ENOENT'); };
  assert.throws(() => renameWithRetry(rename, 'a', 'b'), (e) => e.code === 'ENOENT');
  assert.equal(calls, 1, 'ENOENT: no retry — only Windows target-held codes retry');
});

test('renameWithRetry: success on first attempt is a single call', () => {
  let calls = 0;
  renameWithRetry(() => { calls++; }, 'a', 'b');
  assert.equal(calls, 1);
});

// —— P2-6/P2-11: entry-level PATH handling (index.js) ———————————————————————
import { whichBin, defaultPluginsDirs } from '../../src/index.js';

test('whichBin: POSIX delimiter scan unchanged; first executable wins', () => {
  const dirA = mkdtempSync(join(tmpdir(), 'wao-wb-a-'));
  const dirB = mkdtempSync(join(tmpdir(), 'wao-wb-b-'));
  writeFileSync(join(dirA, 'wao-tool'), '#!/bin/sh\n');
  chmodSync(join(dirA, 'wao-tool'), 0o755);
  assert.equal(whichBin('wao-tool', { pathEnv: `${dirA}:${dirB}` }), join(dirA, 'wao-tool'));
  assert.equal(whichBin('wao-tool', { pathEnv: dirB }), null, 'dir without the bin is skipped');
  assert.equal(whichBin('missing', { pathEnv: dirA }), null);
});

test('whichBin: injected ";"-delimiter + PATHEXT probing finds .CMD shims', () => {
  // Windows shape: npm bin shims are .cmd; an extensionless probe must try
  // PATHEXT extensions, and the separator is ';'.
  const dir = mkdtempSync(join(tmpdir(), 'wao-wb-win-'));
  writeFileSync(join(dir, 'dsh.CMD'), '@echo off\n');
  chmodSync(join(dir, 'dsh.CMD'), 0o755);
  const exts = ['.COM', '.EXE', '.BAT', '.CMD'];
  assert.equal(whichBin('dsh', { pathEnv: `C:\\nothing;${dir}`, delim: ';', exts }), join(dir, 'dsh.CMD'));
  assert.equal(whichBin('dsh', { pathEnv: 'C:\\nothing', delim: ';', exts }), null);
});

test('defaultPluginsDirs: WAO_PLUGINS_PATH splits on the platform delimiter, empty segments dropped', () => {
  const prev = process.env.WAO_PLUGINS_PATH;
  try {
    process.env.WAO_PLUGINS_PATH = '/opt/p1::/opt/p2';
    const dirs = defaultPluginsDirs();
    assert.ok(dirs[0].endsWith(join('plugins')) || dirs[0].endsWith('plugins'), 'repo plugins first');
    assert.deepEqual(dirs.slice(1), ['/opt/p1', '/opt/p2'], `empty segments dropped: ${JSON.stringify(dirs)}`);
    delete process.env.WAO_PLUGINS_PATH;
    assert.equal(defaultPluginsDirs().length, 1);
  } finally {
    if (prev === undefined) delete process.env.WAO_PLUGINS_PATH;
    else process.env.WAO_PLUGINS_PATH = prev;
  }
});

// —— P2-7: TUI browser open dispatch ————————————————————————————————————————
import { browserOpenSpec } from '../../src/tui/attach.js';

test('browserOpenSpec: per-platform command dispatch', () => {
  assert.equal(browserOpenSpec('darwin').cmd, 'open');
  assert.deepEqual(browserOpenSpec('darwin').args('http://x'), ['http://x']);
  // Windows: `start` is a cmd.exe builtin; '' is its title placeholder so a
  // quoted URL is not swallowed as the window title.
  const win = browserOpenSpec('win32');
  assert.equal(win.cmd, 'cmd');
  assert.deepEqual(win.args('http://127.0.0.1:8792'), ['/c', 'start', '', 'http://127.0.0.1:8792']);
  assert.equal(browserOpenSpec('linux').cmd, 'xdg-open');
  assert.deepEqual(browserOpenSpec('linux').args('http://x'), ['http://x']);
});

// —— P2-10: log rotation stops after repeated rename failures ————————————————
import { createLogger } from '../../src/kernel/log.js';

test('log rotate: 3 consecutive rename failures disable rotation with ONE warn; logging continues', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-log-rot-'));
  const file = join(dir, 'wao.log');
  // keep=1 → rotate only renames wao.log → wao.log.1; a DIRECTORY at that
  // name makes the rename throw every time (the Windows "file held by AV /
  // editor" shape, provoked deterministically on POSIX).
  mkdirSync(`${file}.1`);
  const log = createLogger({ file, level: 'debug', maxBytes: 10, keep: 1 });
  const lines = [];
  const m = mock.method(process.stderr, 'write', (s) => { lines.push(String(s)); return true; });
  try {
    for (let i = 0; i < 8; i++) log.info(`rotfail-${i}`);
  } finally { m.mock.restore(); }
  const warns = lines.filter((l) => l.includes('rotation disabled'));
  assert.equal(warns.length, 1, `exactly one disable warn (got ${JSON.stringify(lines)})`);
  const cur = readFileSync(file, 'utf8');
  assert.match(cur, /rotfail-7/, 'appends continue into the un-rotated file');
  assert.ok(!readdirSync(dir).some((n) => n === 'wao.log.2'), 'no rotation side effects after disable');
});
