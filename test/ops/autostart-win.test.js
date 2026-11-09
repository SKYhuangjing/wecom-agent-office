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

test('launcher receives an ABSOLUTE dataDir (setAutostart resolves relative cwd/data)', () => {
  const cmd = buildWinAutostartCmd({
    execPath: 'C:\\tools\\node.exe',
    repoRoot: 'C:\\wao',
    dataDir: 'C:\\wao\\data',
  });
  assert.ok(cmd.includes('start --data-dir "C:\\wao\\data"'), 'absolute --data-dir baked');
  assert.ok(!cmd.includes('--data-dir "data"'), 'never a bare relative data dir');
});

test('launcher preserves --lan flag when lan=true', () => {
  const cmd = buildWinAutostartCmd({ ...CASE, lan: true });
  assert.ok(cmd.includes('start --data-dir "C:\\Users\\1data\\wao\\data" --lan'), 'launcher retains --lan flag in cmd');
});

// start 时启动器刷新（参数漂移修复，2026-11-09）：启用一刻烘焙的参数会随
// 运行形态漂移（先启用自启、后开 --lan → 旧 cmd 无 --lan，重启登录即丢
// LAN）。planAutostartRefresh 是 start 流程的决策面：只在 win32 且已启用时
// 重写，内容用当前 lan 重烘焙。
import { planAutostartRefresh } from '../../src/index.js';

test('planAutostartRefresh: win32+enabled writes launcher with CURRENT lan', () => {
  const plan = planAutostartRefresh({ platform: 'win32', enabled: true, dataDir: 'C:\\wao\\data', lan: true });
  assert.equal(plan.write, true, 'refresh planned');
  assert.equal(plan.path, 'C:\\wao\\data\\win-autostart.cmd', 'launcher path pinned in data dir');
  assert.ok(plan.content.includes('start --data-dir "C:\\wao\\data" --lan'), 'current lan re-baked (drift fixed)');
});

test('planAutostartRefresh: enabled but lan now off — old --lan must NOT survive', () => {
  const plan = planAutostartRefresh({ platform: 'win32', enabled: true, dataDir: 'C:\\wao\\data', lan: false });
  assert.equal(plan.write, true);
  assert.ok(!plan.content.includes('--lan'), 'launcher regenerated without --lan');
});

test('planAutostartRefresh: skips when autostart not enabled (never creates a stray cmd)', () => {
  const plan = planAutostartRefresh({ platform: 'win32', enabled: false, dataDir: 'C:\\wao\\data', lan: true });
  assert.equal(plan.write, false);
  assert.equal(plan.path, undefined);
});

test('planAutostartRefresh: non-win32 platforms never write', () => {
  for (const platform of ['darwin', 'linux']) {
    const plan = planAutostartRefresh({ platform, enabled: true, dataDir: '/tmp/wao/data', lan: false });
    assert.equal(plan.write, false, `${platform} skipped`);
  }
});

test('planAutostartRefresh: dataDir passes through verbatim (absolute by contract)', () => {
  const plan = planAutostartRefresh({ platform: 'win32', enabled: true, dataDir: 'C:\\wao\\data', lan: false });
  assert.equal(plan.write, true);
  assert.equal(plan.path, 'C:\\wao\\data\\win-autostart.cmd', 'no host-platform path.join (POSIX test host would emit forward slashes)');
});
