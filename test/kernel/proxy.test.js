// Network proxy (设置 → 网络代理): pure validation/env/precedence + dispatcher
// injection + the /api/service/network routes over a temp kernel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateProxyUrl, proxyEnv, effectiveProxy, proxyFetch,
  loadServiceConfig, saveServiceConfig,
} from '../../src/kernel/proxy.js';
import { createKernel } from '../../src/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// —— validation ————————————————————————————————————————————————————————————
test('validateProxyUrl: http/https (with auth) pass; socks and junk refused with actionable copy', () => {
  assert.deepEqual(validateProxyUrl('http://127.0.0.1:7890'), { ok: true, url: 'http://127.0.0.1:7890/' });
  assert.equal(validateProxyUrl('https://proxy.corp.local:8443').ok, true);
  assert.equal(validateProxyUrl('http://user:pass@10.0.0.2:7890').ok, true, 'userinfo allowed');
  const socks = validateProxyUrl('socks5://127.0.0.1:7891');
  assert.equal(socks.ok, false);
  assert.match(socks.reason, /v1 仅支持 http\/https/);
  assert.equal(validateProxyUrl('ftp://x').ok, false);
  assert.equal(validateProxyUrl('not a url').ok, false);
  assert.equal(validateProxyUrl('').ok, false);
});

// —— child env ——————————————————————————————————————————————————————————————
test('proxyEnv: proxy vars + the NO_PROXY red line; disabled → empty (never leaks)', () => {
  const env = proxyEnv({ enabled: true, proxyUrl: 'http://127.0.0.1:7890' });
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890');
  assert.equal(env.https_proxy, 'http://127.0.0.1:7890');
  assert.ok(env.NO_PROXY.includes('localhost') && env.NO_PROXY.includes('127.0.0.1'),
    'localhost must NEVER ride the proxy (updater health probe / magpie)');
  assert.deepEqual(proxyEnv({ enabled: false, proxyUrl: 'http://x' }), {});
  assert.deepEqual(proxyEnv(null), {});
  assert.deepEqual(proxyEnv({ enabled: true, proxyUrl: '' }), {});
});

// —— precedence —————————————————————————————————————————————————————————————
test('effectiveProxy: config > env > none', () => {
  assert.deepEqual(
    effectiveProxy({ enabled: true, proxyUrl: 'http://cfg:1' }, { HTTPS_PROXY: 'http://env:2' }),
    { source: 'config', url: 'http://cfg:1', enabled: true },
  );
  assert.deepEqual(
    effectiveProxy({ enabled: false, proxyUrl: '' }, { HTTPS_PROXY: 'http://env:2' }),
    { source: 'env', url: 'http://env:2', enabled: true },
  );
  assert.deepEqual(
    effectiveProxy({ enabled: false, proxyUrl: '' }, {}),
    { source: 'none', url: '', enabled: false },
  );
});

// —— dispatcher injection ———————————————————————————————————————————————————
test('proxyFetch: proxied calls ride the MATCHED undici pair; disabled → global fetch', async () => {
  // 版本配套契约：代理态用 undici 自家 fetch+ProxyAgent（与内置 fetch 混搭会
  // UND_ERR_INVALID_ARG——2026-11-10 实测），注入的 fake 模块两者都要提供。
  const proxied = [];
  const direct = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { direct.push({ url, opts }); return { ok: true, via: 'global' }; };
  try {
    const out = await proxyFetch('https://api.github.com/x', { headers: { a: 1 } }, {
      proxy: { enabled: true, proxyUrl: 'http://127.0.0.1:7890' },
      importUndici: async () => ({
        ProxyAgent: class { constructor(u) { this.url = u; } },
        fetch: async (url, opts) => { proxied.push({ url, opts }); return { ok: true, via: 'undici' }; },
      }),
    });
    assert.equal(out.via, 'undici');
    assert.equal(proxied.length, 1);
    assert.equal(proxied[0].opts.dispatcher.url, 'http://127.0.0.1:7890', 'matched agent injected');
    assert.equal(proxied[0].opts.headers.a, 1, 'caller opts preserved');
    assert.equal(direct.length, 0, 'proxied call never touches the global fetch');

    const out2 = await proxyFetch('https://api.github.com/x', {}, { proxy: { enabled: false, proxyUrl: '' } });
    assert.equal(out2.via, 'global', 'disabled → plain global fetch');
    assert.equal(direct.length, 1);
    assert.equal(direct[0].opts.dispatcher, undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// —— config persistence ————————————————————————————————————————————————————
test('service config: load/save roundtrip; missing/corrupt → defaults; junk normalized', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wao-netcfg-'));
  try {
    const f = join(dir, 'service.json');
    assert.deepEqual(loadServiceConfig(f), { network: { proxyUrl: '', enabled: false } });
    saveServiceConfig(f, { network: { proxyUrl: 'http://127.0.0.1:7890', enabled: true } });
    assert.deepEqual(loadServiceConfig(f).network, { proxyUrl: 'http://127.0.0.1:7890', enabled: true });
    writeFileSync(f, '{corrupt');
    assert.deepEqual(loadServiceConfig(f), { network: { proxyUrl: '', enabled: false } }, 'corrupt → defaults, no crash');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// —— routes over a temp kernel ——————————————————————————————————————————————
const FAKE_CHANNEL = `
export default {
  manifest: { id: 'channel-fake', name: 'Fake Channel', type: 'channel', version: '0.1.0', requires: { kernel: '^1' } },
  activate(ctx) {
    ctx.registerChannel('fakechan', {
      accountSchema: [{ key: 'endpoint', label: 'Endpoint', type: 'string', required: true }],
      capabilities: { stream: false, push: false, group: false },
      createAdapter({ engine }) { return { engine, start() {}, stop() {}, status: () => ({ state: 'online', lastError: null }) }; },
    });
  },
};`;

test('GET/POST /api/service/network: shape, validation refusals, persist + immediate effect', async () => {
  const fakes = mkdtempSync(join(tmpdir(), 'wao-net-fakes-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'wao-net-data-'));
  mkdirSync(join(fakes, 'channel-fake'), { recursive: true });
  writeFileSync(join(fakes, 'channel-fake', 'plugin.js'), FAKE_CHANNEL);
  writeFileSync(join(fakes, 'channel-fake', 'package.json'), '{"type":"module"}\n');
  const kernel = await createKernel({ port: 0, dataDir, pluginsDirs: [fakes, join(repoRoot, 'plugins')] });
  try {
    const url = (p) => `http://127.0.0.1:${kernel.http.port}${p}`;
    const req = (p, method = 'GET', body) => fetch(url(p), {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // GET initial shape
    const init = await (await req('/api/service/network')).json();
    assert.equal(init.ok, true);
    assert.deepEqual(init.proxy, { proxyUrl: '', enabled: false });
    assert.ok(['none', 'env'].includes(init.effective.source));

    // validation refusals (reject over silently correcting)
    assert.equal((await req('/api/service/network', 'POST', { enabled: true, url: 'socks5://127.0.0.1:7891' })).status, 400);
    assert.equal((await req('/api/service/network', 'POST', { enabled: true, url: 'garbage' })).status, 400);
    assert.equal((await req('/api/service/network', 'POST', { enabled: true, url: '' })).status, 400);
    assert.equal((await req('/api/service/network', 'POST', { enabled: true })).status, 400, 'enabling without a URL refused');

    // save → 200 + persisted + effective flips to config
    const saved = await (await req('/api/service/network', 'POST', { enabled: true, url: 'http://127.0.0.1:7890' })).json();
    assert.equal(saved.ok, true);
    assert.equal(saved.effective.source, 'config');
    assert.deepEqual(loadServiceConfig(join(dataDir, 'service.json')).network,
      { proxyUrl: 'http://127.0.0.1:7890/', enabled: true }, 'persisted atomically to data/service.json');
    const reread = await (await req('/api/service/network')).json();
    assert.equal(reread.proxy.enabled, true, 'in-memory state updated without a restart');

    // disable → direct again, config retained on disk
    const off = await (await req('/api/service/network', 'POST', { enabled: false })).json();
    assert.equal(off.proxy.enabled, false);
    assert.equal(off.proxy.proxyUrl, 'http://127.0.0.1:7890/', 'URL remembered for one-click re-enable');

    // /test endpoint answers a structured verdict (real network NOT asserted here)
    const t = await (await req('/api/service/network/test', 'POST', {})).json();
    assert.ok(typeof t.ok === 'boolean' && (t.ok || typeof t.error === 'string'));
  } finally {
    await kernel.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(fakes, { recursive: true, force: true });
  }
});


test('proxyFetch: undici ABSENT degrades to direct with a trace, never kills the call (PC1 2026-11-10 lesson)', async () => {
  const notes = [];
  const out = await proxyFetch('https://api.github.com/rate_limit', {}, {
    proxy: { enabled: true, proxyUrl: 'http://127.0.0.1:7890' },
    importUndici: async () => { throw new Error("Cannot find package 'undici'"); },
    onFallback: (m) => notes.push(m),
  });
  assert.equal(out.ok, true, 'the call itself survives on the direct path');
  assert.equal(notes.length, 1);
  assert.match(notes[0], /undici unavailable/);
});
