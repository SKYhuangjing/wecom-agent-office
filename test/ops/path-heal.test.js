// win32 PATH 自愈（PC2 2026-11-10 实测缺陷回归）：REST 重启链继承旧进程
// env，注册表 User PATH 的新目录进不来——启动时自读自补。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _healProcessPathFromRegistry } from '../../src/index.js';

test('heals missing registry dirs into process PATH (win32 shape, injected probe)', () => {
  const env = { PATH: 'C:\\Windows;C:\\Windows\\System32' };
  const fakeReg = '    Path    REG_EXPAND_SZ    C:\\Users\\x\\tools\\rtk;C:\\Users\\x\\tools\\rg;C:\\Windows';
  const changed = _healProcessPathFromRegistry({ platform: 'win32', regQuery: () => fakeReg, env });
  assert.equal(changed, true);
  assert.match(env.PATH, /^C:\\Users\\x\\tools\\rg;/, 'missing dirs prepended');
  const dirs = env.PATH.split(';').map((d) => d.replace(/\\/g, '/').toLowerCase());
  assert.equal(dirs.filter((d) => d === 'c:/windows').length, 1, 'already-present dirs not duplicated');
  // idempotent second pass
  assert.equal(_healProcessPathFromRegistry({ platform: 'win32', regQuery: () => fakeReg, env }), false);
  assert.equal(env.PATH.split(';').filter((d) => d.toLowerCase().includes('tools\\rg')).length, 1);
});

test('no-op off win32 / unreadable registry / junk value', () => {
  const env = { PATH: 'x' };
  assert.equal(_healProcessPathFromRegistry({ platform: 'darwin', regQuery: () => 'whatever', env }), false);
  assert.equal(_healProcessPathFromRegistry({ platform: 'win32', regQuery: () => '', env }), false);
  assert.equal(_healProcessPathFromRegistry({ platform: 'win32', regQuery: () => 'ERROR: The system was unable to find the specified registry key', env }), false);
  assert.equal(env.PATH, 'x');
});
