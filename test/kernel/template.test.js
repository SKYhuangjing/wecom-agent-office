// Template scaffold tests (Task 8): the three plugins under plugins/_template
// must load for real through createKernel when the _template dir itself is
// passed as a plugins root (the scan skips `_`-prefixed entries INSIDE a root,
// so provider/channel/page below it are fair game). The provider port id is
// 'template' (manifest id 'template-provider'), its runner echoes, the channel
// adapter is a loadable no-op, the page declares ui:'./ui' (M3 kernel
// hosting), and plugins.json enabled:false takes the whole set offline.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKernel } from '../../src/index.js';

const templateRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', '_template');

// File-wide safety net (boot.test.js convention): stop every kernel before
// any tmpdir is removed, even when an assertion fails mid-test.
const kernels = [];
const dirs = [];
after(async () => {
  for (const k of kernels.reverse()) await k.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const start = async (pluginsJson) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wao-tpl-data-'));
  dirs.push(dataDir);
  if (pluginsJson != null) writeFileSync(join(dataDir, 'plugins.json'), JSON.stringify(pluginsJson));
  const k = await createKernel({ port: 0, dataDir, pluginsDirs: [templateRoot] });
  kernels.push(k);
  return k;
};

test('_template scaffolds boot active through createKernel: provider, channel, page', async () => {
  const k = await start(null);
  const url = (p) => `http://127.0.0.1:${k.http.port}${p}`;
  const list = (await (await fetch(url('/api/plugins'))).json()).plugins;
  // Ordering: non-core peers, no deps, default order 10 → id lexicographic.
  assert.deepEqual(list, [
    { id: 'template-channel', name: 'Template Channel', type: 'channel', version: '0.1.0', status: 'active' },
    { id: 'template-page', name: 'Template Page', type: 'ui', version: '0.1.0', status: 'active' },
    { id: 'template-provider', name: 'Template Provider', type: 'provider', version: '0.1.0', status: 'active' },
  ]);
  const state = await (await fetch(url('/api/state'))).json();
  assert.equal(state.plugins.filter((p) => p.status === 'active').length, 3);
  assert.equal(k.status().plugins.length, 3);
});

test('provider port: template runner echoes, validates cwd, resumes sessionId', async () => {
  const k = await start(null);
  const provider = k.portRegistry.getProvider('template');
  assert.ok(provider, "port id is 'template' (not the manifest id)");
  assert.deepEqual(provider.configSchema, [
    { key: 'cwd', label: 'Working directory', type: 'string', required: true },
  ]);
  assert.deepEqual(provider.validate({}), ['cwd is required']);
  assert.deepEqual(provider.validate({ cwd: '/tmp' }), []);
  assert.equal(provider.materializeConfig({}, { log: console }), null, 'demo materialization is a null no-op');
  assert.equal(provider.describeError({ error: new Error('boom') }), 'Error: boom');

  const runner = provider.createRunner({ bot: null, providerConfig: { cwd: '/tmp' }, log: console });
  const result = await runner.run({ prompt: '你好 template', sessionId: undefined, signal: undefined, timeoutMs: 1000, onEvent: () => {} });
  assert.deepEqual(result, {
    ok: true,
    code: 'completed',
    finalText: 'template echo: 你好 template',
    aborted: false,
    sessionId: 'session-template-demo',
    reason: null,
    detail: { exitCode: 0, stderrTail: '' },
  });
  // Session continuation contract: a passed sessionId comes back unchanged.
  const resumed = await runner.run({ prompt: 'again', sessionId: 'sess-1' });
  assert.equal(resumed.sessionId, 'sess-1');
  assert.deepEqual(await runner.readHistory({ cwd: '/tmp' }, 'sess-1'), { turns: [], truncated: false, warnings: [] });
});

test('channel port: template adapter is a loadable no-op with declared capabilities', async () => {
  const k = await start(null);
  const channel = k.portRegistry.getChannel('template');
  assert.ok(channel, "port id is 'template'");
  assert.deepEqual(channel.capabilities, {
    stream: true, push: false, group: false, welcome: false,
    maxContentChars: 3500, minIntervalMs: 2200, streamDeadlineMs: 600000,
  });
  assert.deepEqual(channel.accountSchema, [
    { key: 'endpoint', label: 'Endpoint', type: 'string', required: true },
  ]);
  const adapter = channel.createAdapter({ account: { endpoint: 'http://example.invalid' }, bot: {}, log: console, engine: null });
  adapter.start();
  assert.deepEqual(adapter.status(), { state: 'online', lastError: null, callbacks: 0, lastCallbackAt: 0 });
  // The five outbound primitives exist and never throw.
  adapter.ack('r', 's', 'text');
  adapter.progress('r', 's', 'text', false);
  adapter.reply('r', 'text');
  adapter.welcome('r', 'text');
  adapter.push('chatRef', 'text');
  adapter.stop();
});

test('ui port: page registers nav metadata (entry is kernel-derived from manifest.ui)', async () => {
  const k = await start(null);
  const page = k.portRegistry.page.get('template-page')?.impl;
  assert.ok(page, 'page port id is the manifest id');
  assert.deepEqual(page, { id: 'template-page', title: '模板页', icon: '▤', order: 50 });
  // M3: the manifest `ui` declaration (not the port desc) drives kernel
  // hosting — /api/state lists the entry the shell imports.
  const state = await (await fetch(`http://127.0.0.1:${k.http.port}/api/state`)).json();
  assert.deepEqual(state.uiPlugins, [{ id: 'template-page', entry: '/api/ui/template-page/index.js' }]);
});

test('plugins.json enabled:false on all three ids: 0 active, ports unregistered', async () => {
  const k = await start({
    plugins: {
      'template-provider': { enabled: false },
      'template-channel': { enabled: false },
      'template-page': { enabled: false },
    },
  });
  const body = await (await fetch(`http://127.0.0.1:${k.http.port}/api/plugins`)).json();
  // Disabled plugins are LISTED with status 'disabled' (they stay re-enableable)
  assert.deepEqual(body.plugins, [
    { id: 'template-channel', name: 'Template Channel', type: 'channel', version: '0.1.0', status: 'disabled' },
    { id: 'template-page', name: 'Template Page', type: 'ui', version: '0.1.0', status: 'disabled' },
    { id: 'template-provider', name: 'Template Provider', type: 'provider', version: '0.1.0', status: 'disabled' },
  ]);
  assert.equal(k.portRegistry.getProvider('template'), undefined);
  assert.equal(k.portRegistry.getChannel('template'), undefined);
  assert.equal(k.portRegistry.page.get('template-page'), undefined);
});
