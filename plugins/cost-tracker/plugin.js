// cost-tracker plugin (万物皆插件): a middleware-port plugin that appends a
// token-usage footer line to each final bot reply. Two faces:
//
//   1. MIDDLEWARE (PLUGIN-DEV §5.5): ctx.registerMiddleware(tracker) — the
//      engine passes the final reply as (text, {bot, usage, model,
//      durationMs}); the tracker gates on the bot's cost-tracker asset
//      binding, so bind/unbind IS the per-bot toggle. Registration is
//      global; per-bot filtering happens inside onOutbound.
//
//   2. ASSET: on activation the tool-type asset 'cost-tracker' is ensured in
//      data/assets.json (origin 'plugin') so operators bind/unbind through
//      the EXISTING asset API (POST/DELETE /api/bots/:id/assets). The write
//      happens during activate — BEFORE core-engine's afterAllActivated
//      loads assets.json — so the on-disk registry and core-engine's
//      in-memory one stay one world (a later write would diverge until the
//      next reload). Deleting the asset keeps working like any asset: shared
//      bindings go, exclusive snapshots survive; the plugin re-ensures the
//      asset on the next reload.
//
// NO pricing table, NO usage persistence — the footer is presentation only
// and the ledger row keeps the raw answer.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { atomicWrite } from '../../src/kernel/config.js';
import { createTracker, isBoundToCostTracker, ASSET_NAME } from './tracker.js';

const ASSET_ID = 'ast-cost-tracker';

// dataDir resolution mirrors core-engine's chain (kernel 'paths' service →
// config → env → cwd/data) so plugin and engine always agree on one registry.
const dataDirOf = (ctx) => ctx.services.get('paths')?.dataDir
  ?? ctx.config?.dataDir
  ?? process.env.WAO_HOME
  ?? join(process.cwd(), 'data');

const readRegistry = (file) => {
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    if (doc !== null && typeof doc === 'object' && Array.isArray(doc.assets)) return doc;
  } catch { /* missing/corrupt = empty registry (same tolerance as loadAssets) */ }
  return { assets: [] };
};

const isCostTrackerAsset = (a) => a?.type === 'tool'
  && (a?.content?.kind === ASSET_NAME || a?.name === ASSET_NAME);

// Ensure the tool asset exists; append-only so operator assets and key order
// survive byte-for-byte except for the one new entry.
const ensureAsset = (file, log) => {
  const doc = readRegistry(file);
  if (doc.assets.some(isCostTrackerAsset)) return false;
  const now = Date.now();
  doc.assets.push({
    id: ASSET_ID,
    type: 'tool',
    name: ASSET_NAME,
    description: '回复尾行播报本轮 Token 用量（输入/输出）——绑定即开启，解绑即关闭',
    content: { kind: ASSET_NAME },
    origin: 'plugin',
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  atomicWrite(file, `${JSON.stringify(doc, null, 2)}\n`);
  log.info?.(`cost-tracker: 工具资产 ${ASSET_NAME} 已注册（${file}）——绑定到 bot 即开启用量播报`);
  return true;
};

export default {
  manifest: {
    id: 'cost-tracker',
    name: 'Token 用量播报',
    type: 'middleware',
    version: '0.1.0',
    requires: { kernel: '^1' },
  },

  activate(ctx) {
    const log = ctx.log;
    const assetsFile = join(dataDirOf(ctx), 'assets.json');

    // Must run in activate (not afterAllActivated): core-engine loads its
    // in-memory registry at afterAllActivated, and that load is the bind
    // path's source of truth — the write has to be on disk before it.
    try {
      ensureAsset(assetsFile, log);
    } catch (err) {
      log.warn?.(`cost-tracker: 资产注册失败（绑定开关将不可用，其余功能不受影响）: ${err?.message ?? err}`);
    }

    // Registry lookup for SHARED bindings (exclusive snapshots are
    // self-describing). Cached on mtime: assets.json is tiny and written
    // only on asset CRUD, so a per-reply stat is cheap and always fresh.
    let cacheMtime = null;
    let cacheAssets = [];
    const resolveAsset = (id) => {
      try {
        const mtime = statSync(assetsFile).mtimeMs;
        if (mtime !== cacheMtime) {
          cacheAssets = readRegistry(assetsFile).assets;
          cacheMtime = mtime;
        }
      } catch { /* unreadable registry resolves nothing — the footer stays off */ }
      return cacheAssets.find((a) => a?.id === id) ?? null;
    };

    ctx.registerMiddleware(createTracker({
      isBound: (bot) => isBoundToCostTracker(bot, resolveAsset),
    }));
    // Registering the middleware twice would double the footer — the
    // lifecycle owns teardown, nothing to clean up here.
  },
};
