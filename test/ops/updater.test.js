import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { copyOverlay, needNpmInstall } from '../../scripts/updater.js';
import { getCurrentCommit, checkRemoteUpdate } from '../../src/index.js';

test('copyOverlay strictly preserves protected directories (data, .git, logs, .lock)', () => {
  const tmp = join(tmpdir(), `wao-test-overlay-${Date.now()}`);
  const src = join(tmp, 'src');
  const dest = join(tmp, 'dest');

  mkdirSync(src, { recursive: true });
  mkdirSync(dest, { recursive: true });

  // Destination has crucial user data in data/ and git repo
  mkdirSync(join(dest, 'data', 'bots'), { recursive: true });
  writeFileSync(join(dest, 'data', 'bots.json'), '{"bots":["my-secret"]}');
  mkdirSync(join(dest, '.git'));
  writeFileSync(join(dest, '.git', 'HEAD'), 'ref: refs/heads/main');
  writeFileSync(join(dest, 'package.json'), '{"version":"0.1.0"}');

  // Source stage attempts to have data/ or other files
  mkdirSync(join(src, 'data'), { recursive: true });
  writeFileSync(join(src, 'data', 'bots.json'), 'OVERWRITTEN_BAD');
  mkdirSync(join(src, 'src'), { recursive: true });
  writeFileSync(join(src, 'src', 'index.js'), '// new code');
  writeFileSync(join(src, 'package.json'), '{"version":"0.2.0"}');

  copyOverlay(src, dest);

  // Assert user data is 100% UNTOUCHED
  const preserved = readFileSync(join(dest, 'data', 'bots.json'), 'utf8');
  assert.equal(preserved, '{"bots":["my-secret"]}', 'data/bots.json must never be overwritten');
  assert.equal(readFileSync(join(dest, '.git', 'HEAD'), 'utf8'), 'ref: refs/heads/main');

  // Assert code files were successfully updated
  assert.equal(readFileSync(join(dest, 'src', 'index.js'), 'utf8'), '// new code');
  assert.equal(readFileSync(join(dest, 'package.json'), 'utf8'), '{"version":"0.2.0"}');

  rmSync(tmp, { recursive: true, force: true });
});

test('needNpmInstall detects dependency changes accurately', () => {
  const tmp = join(tmpdir(), `wao-test-pkg-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  const p1 = join(tmp, 'pkg1.json');
  const p2 = join(tmp, 'pkg2.json');
  const p3 = join(tmp, 'pkg3.json');

  writeFileSync(p1, JSON.stringify({ dependencies: { ws: '^8.18.0' } }));
  writeFileSync(p2, JSON.stringify({ dependencies: { ws: '^8.18.0' } }));
  writeFileSync(p3, JSON.stringify({ dependencies: { ws: '^8.18.0', newdep: '^1.0.0' } }));

  assert.equal(needNpmInstall(p1, p2), false, 'identical deps do not need install');
  assert.equal(needNpmInstall(p1, p3), true, 'changed deps trigger npm install');

  rmSync(tmp, { recursive: true, force: true });
});

test('getCurrentCommit prioritizes version.json over fallback', () => {
  const tmp = join(tmpdir(), `wao-test-commit-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });

  writeFileSync(join(tmp, 'version.json'), JSON.stringify({ commit: 'c3b4a5d6e7f8' }));
  const commit = getCurrentCommit(tmp);
  assert.equal(commit, 'c3b4a5d', 'commit from version.json takes precedence and trims to 7 chars');

  rmSync(tmp, { recursive: true, force: true });
});

test('checkRemoteUpdate returns structured contract', async () => {
  const info = await checkRemoteUpdate('b1f39ba');
  assert.ok(typeof info === 'object');
  assert.equal(info.currentCommit, 'b1f39ba');
  assert.ok(typeof info.currentVersion === 'string');
  assert.ok(typeof info.hasUpdate === 'boolean');
  assert.ok(typeof info.checkedAt === 'number');
});
