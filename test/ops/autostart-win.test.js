// win32 autostart launcher content lock (install-wave iteration 2026-11-09):
// the registry Run key fires at logon with cwd=System32 and a PATH that may
// not contain node — enable-time must bake absolute paths for everything:
// repo root cd, execPath, --data-dir and the log append target. CRLF is a
// cmd interpreter requirement. Pure function — platform-independent test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWinAutostartCmd } from '../../src/index.js';

const CASE = {
  execPath: 'C:\\Users\\1data\\tools\\node-v22.23.4-win-x64\\node.exe',
  repoRoot: 'C:\\Users\\1data\\wao',
  dataDir: 'C:\\Users\\1data\\wao\\data',
};

test('launcher bakes absolute paths and pins --data-dir (System32 cwd, logon PATH)', () => {
  const cmd = buildWinAutostartCmd(CASE);
  const lines = cmd.split('\r\n');
  assert.equal(lines[0], '@echo off', 'first line silences echo');
  assert.ok(cmd.includes('cd /d "C:\\Users\\1data\\wao"'), 'cd to absolute repo root');
  assert.ok(cmd.includes(`"${CASE.execPath}"`), 'absolute node.exe, not PATH lookup');
  assert.ok(cmd.includes('"C:\\Users\\1data\\wao\\src\\index.js"'), 'absolute entry file');
  assert.ok(cmd.includes('start --data-dir "C:\\Users\\1data\\wao\\data"'), '--data-dir pinned: logon cwd must not leak the data dir to System32');
  assert.ok(cmd.includes('>> "C:\\Users\\1data\\wao\\data\\logs\\autostart.log" 2>&1'), 'stdout+stderr appended into the data dir log');
  assert.ok(cmd.includes('mkdir "C:\\Users\\1data\\wao\\data\\logs"'), 'log dir created before first append');
});

test('launcher uses CRLF line endings and trailing newline (cmd interpreter requirement)', () => {
  const cmd = buildWinAutostartCmd(CASE);
  assert.ok(!/(?<!\r)\n/.test(cmd), 'every LF is preceded by CR');
  assert.ok(cmd.endsWith('\r\n'), 'trailing CRLF');
});

test('paths with spaces stay quoted', () => {
  const cmd = buildWinAutostartCmd({
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    repoRoot: 'C:\\Users\\1 data\\wao',
    dataDir: 'D:\\wao data\\data',
  });
  assert.ok(cmd.includes('cd /d "C:\\Users\\1 data\\wao"'));
  assert.ok(cmd.includes('--data-dir "D:\\wao data\\data"'));
});
