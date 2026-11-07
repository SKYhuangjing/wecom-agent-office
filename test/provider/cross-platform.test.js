// Provider-side cross-platform pins (P1-4, P2-8, P2-9): dsh home resolution
// (os.homedir, not $HOME — Windows services have no HOME), PATH building with
// the platform delimiter, and the per-platform ripgrep install hint baked
// into the four providers' guidance (复制即契约: all four must agree).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { isAbsolute, join, delimiter } from 'node:path';

import { profilePatchPath, withDirOnPath } from '../../plugins/provider-dsh/profiles.js';
import { dshHomeOf } from '../../plugins/provider-dsh/history.js';
import { RIPGREP_GUIDANCE as dshRg, rgInstallHint as dshHint } from '../../plugins/provider-dsh/plugin.js';
import { RIPGREP_GUIDANCE as claudeRg, rgInstallHint as claudeHint } from '../../plugins/provider-claude/plugin.js';
import { RIPGREP_GUIDANCE as codexRg, rgInstallHint as codexHint } from '../../plugins/provider-codex/plugin.js';
import { RIPGREP_GUIDANCE as piRg, rgInstallHint as piHint } from '../../plugins/provider-pi/plugin.js';

test('dsh home: resolves under os.homedir() even with HOME unset (Windows service shape)', () => {
  const prevHome = process.env.HOME;
  const prevDsh = process.env.DSH_HOME;
  try {
    delete process.env.HOME; // the Windows-service condition: no HOME at all
    delete process.env.DSH_HOME;
    // OLD bug: join(process.env.HOME || '', '.dsh') collapsed to a RELATIVE
    // '.dsh/...' — history read a different tree than the jail roots allowed.
    const patch = profilePatchPath('wecom-b1');
    assert.ok(isAbsolute(patch), `profile path must stay absolute without $HOME (got ${patch})`);
    assert.ok(patch.startsWith(join(homedir(), '.dsh')), `under os.homedir()/.dsh (got ${patch})`);
    const home = dshHomeOf(undefined);
    assert.ok(isAbsolute(home), `history home absolute without $HOME (got ${home})`);
    assert.ok(home.startsWith(join(homedir(), '.dsh')), `history reads the same tree as profiles (${home})`);
  } finally {
    if (prevHome === undefined) process.env.HOME = homedir(); // never leave HOME empty
    else process.env.HOME = prevHome;
    if (prevDsh !== undefined) process.env.DSH_HOME = prevDsh;
    else delete process.env.DSH_HOME;
  }
});

test('dsh home: $DSH_HOME override still wins (unchanged)', () => {
  const prevDsh = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = '/opt/wao-dsh';
    assert.equal(dshHomeOf(undefined), '/opt/wao-dsh');
    assert.equal(profilePatchPath('p'), join('/opt/wao-dsh', 'profiles', 'p', 'cordis.patch.yml'));
  } finally {
    if (prevDsh === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevDsh;
  }
});

test('withDirOnPath: prepends with the platform delimiter, tolerates empty PATH', () => {
  assert.equal(withDirOnPath({ PATH: '/usr/bin' }, '/n/bin').PATH, `/n/bin${delimiter}/usr/bin`);
  assert.equal(withDirOnPath({}, '/n/bin').PATH, `/n/bin${delimiter}`);
});

test('rgInstallHint: per-platform install commands, identical across the four providers', () => {
  const hints = [dshHint, claudeHint, codexHint, piHint];
  for (const hint of hints) {
    assert.match(hint('darwin'), /brew install ripgrep/, 'macOS → brew');
    assert.match(hint('linux'), /apt(-get)? install ripgrep/, 'Linux → apt');
    assert.match(hint('win32'), /(winget|scoop)/, 'Windows → winget/scoop');
    assert.match(hint('win32'), /ripgrep/, 'names the package');
  }
  // all four agree on every platform (复制即契约)
  for (const platform of ['darwin', 'linux', 'win32', 'freebsd']) {
    assert.equal(dshHint(platform), claudeHint(platform), `claude matches on ${platform}`);
    assert.equal(dshHint(platform), codexHint(platform), `codex matches on ${platform}`);
    assert.equal(dshHint(platform), piHint(platform), `pi matches on ${platform}`);
  }
});

test('RIPGREP_GUIDANCE: carries the current platform install hint (all four)', () => {
  const expected = `rg 未安装时先执行：${dshHint()}。`;
  for (const g of [dshRg, claudeRg, codexRg, piRg]) {
    assert.ok(g.includes(expected), `guidance carries the platform hint (got ${JSON.stringify(g)})`);
    assert.ok(g.includes('rg（ripgrep）'), 'usage line unchanged');
  }
});
