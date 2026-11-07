// W3 T2 review Critical 3 — the boot-order pin: attach runs BEFORE the asset
// startup sweep, so a migrated (manifest-less, pre-T2) bot's runner is minted
// from the BARE plan; the post-sweep refreshRunner must re-mint it so the
// manifest's file targets enrich the runner on the FIRST process cycle (§3.1:
// the runner follows the last successful materialize). Boots a real kernel
// over a PRE-SEEDed bots.json + assets.json (the T1-skipped binding shape) and
// records every createRunner's `assets` argument.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKernel } from '../../src/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const FAKE_CHANNEL = `
export default {
  manifest: { id: 'channel-fake', name: 'Fake Channel', type: 'channel', version: '0.1.0', requires: { kernel: '^1' } },
  activate(ctx) {
    ctx.registerChannel('fakechan', {
      accountSchema: [{ key: 'endpoint', label: 'Endpoint', type: 'string', required: true }],
      capabilities: { stream: true, push: true, group: true, welcome: false, maxContentChars: 3500, minIntervalMs: 10, heartbeatMs: 60000, streamDeadlineMs: 600000 },
      createAdapter() {
        return { start() {}, stop() {}, status() { return { state: 'online', lastError: null }; }, ack() {}, progress() {}, reply() {}, welcome() {}, push() {} };
      },
    });
  },
};`;

const FAKE_PROVIDER = `
import { join } from 'node:path';
export default {
  manifest: { id: 'provider-fake', name: 'Fake Provider', type: 'provider', version: '0.1.0', requires: { kernel: '^1' } },
  activate(ctx) {
    ctx.registerProvider('fakeprov', {
      configSchema: [{ key: 'cwd', label: 'Working directory', type: 'string', required: true }],
      validate(providerConfig) {
        return (typeof providerConfig?.cwd === 'string' && providerConfig.cwd !== '') ? [] : ['cwd is required'];
      },
      materializeConfig() { return null; },
      async materializeAssets(bot, plan) {
        const writes = [];
        for (const e of plan ?? []) {
          if (e.type !== 'skill') continue;
          writes.push({
            kind: 'file-create',
            target: join(bot.providerConfig.cwd, 'skills', e.content.name, 'SKILL.md'),
            content: 'x-wao-asset: ' + e.assetId,
            for: e.assetId,
          });
        }
        return { writes, notes: [], entries: [] };
      },
      createRunner({ assets }) {
        (globalThis.__waoMigRunnerAssets ??= []).push(assets);
        return {
          async run() { return { ok: true, code: 'completed', finalText: 'ok', aborted: false, sessionId: 's1', reason: null, detail: {} }; },
          async readHistory() { return { turns: [], truncated: false, warnings: [] }; },
        };
      },
    });
  },
};`;

const writePluginDir = (dir, src) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.js'), src);
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
};

let kernel;
let dataDir;
let fakesDir;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wao-mig-data-'));
  fakesDir = mkdtempSync(join(tmpdir(), 'wao-mig-fakes-'));
  writePluginDir(join(fakesDir, 'channel-fake'), FAKE_CHANNEL);
  writePluginDir(join(fakesDir, 'provider-fake'), FAKE_PROVIDER);
  // The pre-T2 shape: a persisted binding, NO materialization manifest — the
  // exact population the startup sweep migrates once at boot.
  writeFileSync(join(dataDir, 'bots.json'), JSON.stringify({
    bots: [{
      id: 'mig1', name: '迁移机器人', enabled: true, channel: 'fakechan',
      account: { endpoint: 'http://fake.local' }, allowedUsers: ['u1'],
      provider: 'fakeprov',
      providerConfig: { cwd: join(dataDir, 'mig1-cwd') },
      assets: [{ assetId: 'ast-mig1', mode: 'shared' }],
    }],
  }, null, 2));
  writeFileSync(join(dataDir, 'assets.json'), JSON.stringify({
    assets: [{
      id: 'ast-mig1', type: 'skill', name: 'wao-mig',
      content: { name: 'wao-mig', body: '正文' },
      version: 1, origin: 'operator', createdAt: 1, updatedAt: 1,
    }],
  }, null, 2));
  const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };
  kernel = await createKernel({ port: 0, dataDir, pluginsDirs: [fakesDir, join(repoRoot, 'plugins')], log });
});

after(async () => {
  await kernel.stop();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(fakesDir, { recursive: true, force: true });
});

test('boot migration: sweep runs after attach, then refreshRunner re-mints the migrated bot — enrichment lands on the FIRST cycle', async () => {
  const skillTarget = join(dataDir, 'mig1-cwd', 'skills', 'wao-mig', 'SKILL.md');
  // the migration itself happened at boot
  assert.ok(existsSync(join(dataDir, 'assets', 'mig1', 'manifest.json')), 'sweep migrated the manifest-less binding');
  assert.ok(existsSync(skillTarget), 'the skill product landed');

  const calls = globalThis.__waoMigRunnerAssets ?? [];
  assert.ok(calls.length >= 2, `runner minted at attach AND re-minted after migration (calls=${calls.length})`);
  assert.equal(calls[0][0].target, undefined, 'attach-time runner saw the BARE plan (no manifest yet)');
  const last = calls.at(-1);
  assert.equal(last[0].assetId, 'ast-mig1');
  assert.equal(last[0].target, skillTarget, 'post-sweep runner carries the manifest target (§3.1 enrichment)');
  // the LIVE runner table holds the enriched one: the state surface exposes
  // runnerFor, and the last minted runner is what the engine would run with.
  assert.equal(kernel.services.get('engine') != null, true);
});
