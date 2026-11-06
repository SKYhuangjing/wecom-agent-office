// avatar.js — 「头像即化身」签名 (company-metaphor redesign P1).
//
// DiceBear notionists (CC0 style collection), bundled fully offline into the
// shell by web/build.mjs — zero CDN. The seed IS the botId: the same face
// greets you in the office, the cards, the side lists, the timeline rows and
// the 工牌 detail. Exposed to page plugins on the WAO contract as
// WAO.avatar(seed, {size, mood}) → inline SVG string; WAO.avatarUrl adds the
// data:-URL form the office canvas needs (Image.src for canvas drawing).
import { createAvatar } from '@dicebear/core';
import * as notionists from '@dicebear/notionists';

// mood overrides — only what was verified against the style's actual art:
// 'sleep' pins eyes to variant03, the flat-line closed eyes (confirmed by
// path-geometry analysis: height 2.7 over width 154.5 = a horizontal stroke,
// where every other variant is a 30-46 tall open shape). Unknown moods fall
// back to the style defaults — never a guessed variant.
const MOOD_OVERRIDES = {
  sleep: { eyes: ['variant03'] },
};

export function avatar(seed, { size = 48, mood = 'neutral' } = {}) {
  const opts = {
    seed: String(seed ?? 'wao'),
    size: Number.isFinite(size) && size > 0 ? Math.round(size) : 48,
    ...(MOOD_OVERRIDES[mood] ?? {}),
  };
  return createAvatar(notionists, opts).toString();
}

export function avatarUrl(seed, opts) {
  return `data:image/svg+xml;utf8,${encodeURIComponent(avatar(seed, opts))}`;
}
