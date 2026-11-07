// cost-tracker outbound middleware (PLUGIN-DEV §5.5 chain port): appends a
// token-usage footer line to the bot's FINAL WeCom reply. Presentation only —
// NO pricing table, NO persistence; the counts come from the engine's run
// ctx (usage accumulated per run, engine.js createUsageAccumulator).
//
// The per-bot toggle is an ASSET BINDING: plugin.js registers the tool-type
// asset 'cost-tracker' and injects `isBound(bot)` here, so bind/unbind via
// the existing asset API flips the footer per bot.
const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export const ASSET_NAME = 'cost-tracker';

// Pure binding test over a bot record's raw `assets` bindings:
//   - exclusive bindings are self-describing (bindAsset snapshots type/name/
//     content), so they need no registry;
//   - shared bindings carry only an assetId and resolve through the injected
//     registry lookup (plugin.js reads data/assets.json).
// A match requires type 'tool' AND kind/name 'cost-tracker' — a skill that
// merely shares the name must never flip the toggle.
export function isBoundToCostTracker(bot, resolveAsset = null) {
  const bindings = Array.isArray(bot?.assets) ? bot.assets : [];
  for (const b of bindings) {
    if (b == null || typeof b !== 'object') continue;
    if (b.snapshotType === 'tool' && (b.snapshotName === ASSET_NAME || b.snapshot?.kind === ASSET_NAME)) {
      return true;
    }
    if (typeof resolveAsset === 'function' && typeof b.assetId === 'string') {
      const asset = resolveAsset(b.assetId);
      if (asset != null && asset.type === 'tool'
        && (asset.content?.kind === ASSET_NAME || asset.name === ASSET_NAME)) return true;
    }
  }
  return false;
}

// createTracker({ isBound }) → { onOutbound(text, ctx) }. `isBound` defaults
// to off: a tracker constructed bare never rewrites text (tests embed it
// with explicit stubs; plugin.js wires the registry-aware one).
export function createTracker({ isBound = () => false } = {}) {
  return {
    onOutbound(text, ctx) {
      if (!ctx?.usage) return text; // engine gave no run usage → nothing to report
      if (!isBound(ctx.bot)) return text; // bot-level toggle: unbound → unchanged
      const u = ctx.usage;
      const line = `\n\n---\n📊 Token：输入 ${fmt(u.inputTokens || 0)} · 输出 ${fmt(u.outputTokens || 0)}`;
      return text + line;
    },
  };
}
