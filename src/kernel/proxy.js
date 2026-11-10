// Service-level network proxy (settings → 网络代理): WAO's own outbound calls
// (update check / updater zip download / tool downloads / brew child) route
// through a user-configured HTTP(S) proxy — the root fix for mainland links
// where GitHub direct access stalls or silently truncates (2026-11-09 PC1).
//
// Scope is DELIBERATELY narrow: provider CLIs, the magpie gateway link and the
// WeCom WebSocket never go through this proxy (they talk to localhost magpie
// and domestic endpoints; the operator's own proxy env vars already pass
// through to CLI children via childEnv). NO_PROXY is a hard red line — a
// child that proxies 127.0.0.1 would break the updater's health probe and
// every magpie call.
//
// Node's built-in fetch ignores HTTP(S)_PROXY (node ≥22.15), hence the undici
// ProxyAgent dependency and this module's dispatcher injection.
import { readJson, writeJson } from './config.js';

// —— persisted config: data/service.json ———————————————————————————————————
// Generic service-settings doc (network is the first tenant):
//   { network: { proxyUrl: 'http://127.0.0.1:7890', enabled: true } }
export function loadServiceConfig(file) {
  const doc = readJson(file);
  if (doc != null && typeof doc === 'object' && !Array.isArray(doc)) {
    return { network: normalizeNetwork(doc.network) };
  }
  return { network: { proxyUrl: '', enabled: false } };
}
export function saveServiceConfig(file, doc) {
  writeJson(file, doc);
}
export function normalizeNetwork(n) {
  const url = typeof n?.proxyUrl === 'string' ? n.proxyUrl.trim() : '';
  return { proxyUrl: url, enabled: n?.enabled === true };
}

// —— validation ————————————————————————————————————————————————————————————
// v1 supports http:// and https:// proxies (with optional user:pass@host —
// undici's ProxyAgent takes auth from the URI). SOCKS needs a separate
// dispatcher package and is rejected with an actionable message.
export function validateProxyUrl(u) {
  if (typeof u !== 'string' || u === '') return { ok: false, reason: '代理地址不能为空' };
  let parsed;
  try { parsed = new URL(u); } catch { return { ok: false, reason: '不是合法的 URL' }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      reason: parsed.protocol === 'socks:' || parsed.protocol === 'socks5:' || parsed.protocol === 'socks4:'
        ? 'v1 仅支持 http/https 代理——请使用代理软件的 HTTP 端口（如 Clash 的 7890）'
        : `不支持的协议：${parsed.protocol}（v1 仅支持 http/https）`,
    };
  }
  if (!parsed.hostname) return { ok: false, reason: '缺少主机名' };
  return { ok: true, url: parsed.toString() };
}

// —— dispatcher ————————————————————————————————————————————————————————————
// One ProxyAgent per proxy URL, cached; a config change just points at a new
// key. Lazy import keeps this module loadable even if undici vanished.
// 版本配套红线（2026-11-10 实测）：npm undici 8 的 ProxyAgent 不能注入
// Node 内置 fetch——内置 undici 与 npm 版跨大版本，dispatcher 接口校验直接
// UND_ERR_INVALID_ARG。因此代理态连 fetch 一起用 npm undici 自家的（版本
// 配套），非代理态保持全局 fetch（零行为差异）。缓存的 {fetch, agent} 成对
// 取用，绝不混搭。
let cache = new Map(); // url → { fetch, agent }
export async function getProxyDispatcher(url, { importUndici } = {}) {
  const load = importUndici ?? (() => import('undici'));
  if (cache.has(url)) return cache.get(url);
  const { ProxyAgent, fetch: undiciFetch } = await load();
  const pair = { fetch: undiciFetch, agent: new ProxyAgent(url) };
  cache.set(url, pair);
  return pair;
}
// test seam: drop cached agents (the route rebuilds after a config change)
export function resetProxyDispatcherCache() { cache = new Map(); }

// —— the drop-in fetch ——————————————————————————————————————————————————————
// proxyFetch(url, opts, {proxy}) — proxied calls ride the MATCHED undici
// fetch+ProxyAgent pair; otherwise byte-identical to the global fetch.
export async function proxyFetch(url, opts = {}, { proxy, importUndici } = {}) {
  if (proxy?.enabled === true && typeof proxy.proxyUrl === 'string' && proxy.proxyUrl !== '') {
    const { fetch: undiciFetch, agent } = await getProxyDispatcher(proxy.proxyUrl, { importUndici });
    return undiciFetch(url, { ...opts, dispatcher: agent });
  }
  return fetch(url, opts);
}

// —— child-process env ——————————————————————————————————————————————————————
// For children that do their own networking (brew, updater's curl). NO_PROXY
// is NON-NEGOTIABLE: localhost must never ride the proxy.
export function proxyEnv(proxy, extraNoProxy = '') {
  if (proxy?.enabled !== true || typeof proxy.proxyUrl !== 'string' || proxy.proxyUrl === '') return {};
  const noProxy = ['localhost,127.0.0.1,::1', extraNoProxy].filter((s) => s !== '').join(',');
  return {
    HTTP_PROXY: proxy.proxyUrl,
    HTTPS_PROXY: proxy.proxyUrl,
    http_proxy: proxy.proxyUrl,
    https_proxy: proxy.proxyUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}

// —— effective-source resolution ———————————————————————————————————————————
// config wins; otherwise the service's own environment (operator-launched
// with HTTP(S)_PROXY already set) is reported so the UI can explain itself.
export function effectiveProxy(configNetwork, env = process.env) {
  if (configNetwork?.enabled === true && configNetwork.proxyUrl) {
    return { source: 'config', url: configNetwork.proxyUrl, enabled: true };
  }
  const envUrl = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || '';
  if (envUrl) return { source: 'env', url: envUrl, enabled: true };
  return { source: 'none', url: '', enabled: false };
}
