// Task 18 unit grid: plugins/provider-dsh/profiles.js — the port of the
// production-proven wecom-bots/lib/profiles.js, with the two contractual
// changes (atomicWrite + last-good on throw). DSH_HOME is pointed at a temp
// dir so nothing here touches the real ~/.dsh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeBotProfile, ensureProfileExists, removeProfile, profilePatchPath } from '../../plugins/provider-dsh/profiles.js';

const withHome = async (fn) => {
  const home = mkdtempSync(join(tmpdir(), 'wao-dsh-home-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
};

// A synthetic headless source profile carrying the borrowed provider table
// (the block readProviderBlock extracts), plus a pre-created target profile
// dir so ensureProfileExists short-circuits without spawning dsh.
const seedHome = (home, targetProfile) => {
  const headlessDir = join(home, 'profiles', 'headless');
  mkdirSync(headlessDir, { recursive: true });
  writeFileSync(join(headlessDir, 'cordis.patch.yml'), [
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '  config:',
    '    providers:',
    '      magpie:',
    '        displayName: magpie',
    '        apiKeyEnv: MAGPIE_API_KEY',
    '        models:',
    '          - id: workbuddy/deepseek-v4.1-flash',
    '- id: some-other-row',
    '  config: {}',
    '',
  ].join('\n'));
  const target = join(home, 'profiles', targetProfile);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'cordis.patch.yml'), ''); // placeholder: ensureProfileExists skips spawn
  return join(headlessDir, 'cordis.patch.yml');
};

test('profiles: writeBotProfile borrowed route — all sections written', async () => {
  await withHome(async (home) => {
    seedHome(home, 'wecom-b1');
    const res = writeBotProfile({
      profile: 'wecom-b1',
      model: { provider: 'magpie', model: 'workbuddy/deepseek-v4.1-flash' },
      permission: 'read-only',
      prompt: '你是严谨的助手。\n回答保持简短。',
      writableDirs: ['/data/logs', '/data/cache'],
      workspaceRoot: '/ws/b1',
      dshBin: 'dsh',
      nodeBin: process.execPath,
      compaction: { enabled: true, thresholdRatio: 0.7 },
    });
    assert.equal(res.profile, 'wecom-b1');
    assert.equal(res.permission, 'read-only');
    assert.equal(res.customProvider, false);
    assert.equal(res.writableDirs.length, 2);
    const text = readFileSync(profilePatchPath('wecom-b1'), 'utf8');
    assert.match(text, /- id: llm-pi-ai\n/, 'borrowed provider table present');
    assert.ok(!text.includes('some-other-row'), 'only the llm-pi-ai block is borrowed');
    assert.match(text, /- id: agent-default-model\n[\s\S]*?provider: magpie\n\s+model: workbuddy\/deepseek-v4\.1-flash/);
    assert.match(text, /- id: permission-presets\n[\s\S]*?defaultPreset: read-only/);
    assert.match(text, /- id: compaction-basic\n[\s\S]*?thresholdRatio: 0\.7\n\s+headroomTokens: 65536\n\s+retainRatio: 0\.16/);
    assert.match(text, /- id: system-prompt\n[\s\S]*?personaPrefix: \|-\n\s+你是严谨的助手。\n\s+回答保持简短。/);
    assert.match(text, /- id: sandbox-policy\n[\s\S]*?mode: read-only\n\s+workspaceRoot: "\/ws\/b1"\n\s+additionalWritableRoots:\n\s+- "\/data\/logs"\n\s+- "\/data\/cache"/);
    assert.ok(!existsSync(`${profilePatchPath('wecom-b1')}.tmp.${process.pid}`), 'no tmp residue after atomic write');
  });
});

test('profiles: custom provider route — slug, apiKeyEnv, contextWindow', async () => {
  await withHome(async (home) => {
    seedHome(home, 'wecom-b2');
    const res = writeBotProfile({
      profile: 'wecom-b2',
      model: { provider: 'My Prov!', model: 'big-model', baseURL: '{{BASEURL_3c80cb}}', api: 'pi-ai', apiKeyEnv: 'BOT_KEY', contextWindow: 200000, maxTokens: 8192 },
      permission: 'workspace-write',
      workspaceRoot: '/ws/b2',
      dshBin: 'dsh',
      nodeBin: process.execPath,
    });
    assert.equal(res.customProvider, true);
    assert.equal(res.model.provider, 'my-prov', 'provider id slugified');
    const text = readFileSync(profilePatchPath('wecom-b2'), 'utf8');
    assert.match(text, /my-prov:\n\s+displayName: "Bot wecom-b2"\n\s+apiKeyEnv: BOT_KEY\n\s+api: pi-ai\n\s+baseURL: "\{\{BASEURL_3c80cb\}\}"/);
    assert.match(text, /contextWindow: 200000\n\s+maxTokens: 8192/);
    assert.match(text, /- id: agent-default-model\n[\s\S]*?provider: my-prov\n\s+model: big-model/);
    assert.match(text, /- id: sandbox-policy\n[\s\S]*?mode: workspace-write\n\s+workspaceRoot: "\/ws\/b2"/);
  });
});

test('profiles: missing model falls back to the 前身 default; permission junk coerces', async () => {
  await withHome(async (home) => {
    seedHome(home, 'wecom-b3');
    const res = writeBotProfile({ profile: 'wecom-b3', model: null, permission: 'yolo', dshBin: 'dsh', nodeBin: process.execPath });
    assert.deepEqual(res.model.provider, 'magpie');
    assert.equal(res.model.model, 'workbuddy/deepseek-v4.1-flash');
    assert.equal(res.permission, 'workspace-write');
    assert.match(readFileSync(profilePatchPath('wecom-b3'), 'utf8'), /defaultPreset: workspace-write/);
  });
});

test('profiles: last-good — a throw leaves the previous file untouched', async () => {
  await withHome(async (home) => {
    seedHome(home, 'wecom-b4');
    writeBotProfile({
      profile: 'wecom-b4', model: { provider: 'magpie', model: 'm1' },
      dshBin: 'dsh', nodeBin: process.execPath,
    });
    const before = readFileSync(profilePatchPath('wecom-b4'), 'utf8');
    // borrowed route against a source profile with no provider block → throws
    assert.throws(
      () => writeBotProfile({ profile: 'wecom-b4', sourceProfile: 'no-such-source', dshBin: 'dsh', nodeBin: process.execPath }),
      /cannot read provider table from profile "no-such-source"/,
    );
    assert.equal(readFileSync(profilePatchPath('wecom-b4'), 'utf8'), before, 'last-good file untouched');
    assert.ok(!existsSync(join(home, 'profiles', 'wecom-b4', `cordis.patch.yml.tmp.${process.pid}`)), 'no tmp residue on throw');
  });
});

test('profiles: ensureProfileExists — existing short-circuits; spawn status honored', async () => {
  await withHome(async (home) => {
    const dir = join(home, 'profiles', 'wecom-b5');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cordis.patch.yml'), 'x');
    const have = ensureProfileExists('wecom-b5', { dshBin: 'dsh', nodeBin: process.execPath });
    assert.equal(have.created, false);
    // /bin/true exits 0 → "created"; /bin/false exits 1 → not created
    const ok = ensureProfileExists('wecom-b6', { dshBin: '/usr/bin/true', nodeBin: process.execPath });
    assert.equal(ok.created, true);
    const bad = ensureProfileExists('wecom-b7', { dshBin: '/usr/bin/false', nodeBin: process.execPath });
    assert.equal(bad.created, false);
    assert.equal(bad.status, 1);
  });
});

test('profiles: removeProfile removes when present, false when absent', async () => {
  await withHome(async (home) => {
    const dir = join(home, 'profiles', 'wecom-b8');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cordis.patch.yml'), 'x');
    assert.equal(removeProfile('wecom-b8'), true);
    assert.ok(!existsSync(dir));
    assert.equal(removeProfile('wecom-b8'), false);
  });
});
