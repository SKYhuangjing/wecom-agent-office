// 白棚办公室 — 成片层（自有 SVG / 可选自有循环片）+ 热区层 + useAgents。
// 规格：docs/OFFICE-STUDIO-SPEC.md。禁止第三方成片入仓。

import {
  assignSeats, STATUS_LABEL, providerColor, elapsed,
} from './seats.js';
import { StageFilm } from './stage-film.js';

const CSS_ID = 'wao-ui-office-studio-v2';
const ASSET_BASE = new URL('./assets/', import.meta.url).href;

const PAGE_CSS = `
.os-page { display: flex; flex-direction: column; gap: 14px; min-height: calc(100vh - 140px); }
.os-hero { text-align: center; padding: 4px 8px 0; }
.os-hero h1 {
  margin: 0; font-size: clamp(1.35rem, 2.6vw, 1.85rem);
  letter-spacing: -.04em; font-weight: 700; color: var(--ink); line-height: 1.15;
}
.os-hero p { margin: 6px 0 0; color: var(--muted); font-size: 13.5px; }
.os-pills { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; margin-top: 10px; }
.os-pill {
  font-size: 12px; font-weight: 600; color: var(--ink);
  background: var(--panel); border: 1px solid var(--line);
  border-radius: 999px; padding: 5px 11px;
}
.os-pill em { font-style: normal; }
.os-stage-wrap { max-width: 1100px; margin: 0 auto; width: 100%; overflow: visible; }
.os-stage {
  position: relative; background: #fff; border-radius: 24px; overflow: visible;
  box-shadow: 0 0 0 1px rgb(0 0 0 / .04), 0 40px 100px rgb(15 23 42 / .08);
  aspect-ratio: 3840 / 1330; min-height: 260px; border: 1px solid var(--line);
}
/* 成片裁圆角；热区层 overflow visible，避免第一排气泡被上边框裁切 */
.os-stage-media {
  position: absolute; inset: 0; overflow: hidden; border-radius: 24px; z-index: 0;
  background: #fff;
}
.os-stage-media .poster, .os-stage-media video,
.os-stage-media .proc {
  position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; background: #fff;
}
.os-hots { position: absolute; inset: 0; z-index: 2; overflow: visible; }
.os-hot {
  position: absolute; border: 0; padding: 0; background: transparent;
  cursor: pointer; border-radius: 12px; -webkit-tap-highlight-color: transparent;
  overflow: visible; z-index: 1;
}
.os-hot:hover, .os-hot.is-on { z-index: 6; }
.os-hot::before {
  content: ""; position: absolute; inset: -6%; border-radius: 18px;
  background: radial-gradient(circle at 50% 40%, transparent, transparent 70%);
  transition: background .2s ease, box-shadow .2s ease;
}
.os-hot:hover::before, .os-hot.is-on::before {
  background: radial-gradient(circle at 50% 45%, color-mix(in srgb, var(--pc, #3b82f6) 18%, transparent), transparent 68%);
  box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--pc, #3b82f6) 40%, transparent);
}
.os-hot.is-dim { opacity: .55; filter: grayscale(.12); }
.os-hot.is-dim:hover { opacity: 1; filter: none; }
.os-tip {
  position: absolute; left: 50%; bottom: calc(100% + 8px);
  transform: translateX(-50%) translateY(6px);
  opacity: 0; pointer-events: none;
  background: #0a0a0a; color: #fff;
  font-size: 12.5px; font-weight: 600; letter-spacing: -.015em;
  padding: 8px 12px; border-radius: 999px; white-space: nowrap;
  box-shadow: 0 14px 30px rgb(0 0 0 / .22);
  transition: opacity .18s ease, transform .18s ease; z-index: 5;
}
.os-tip small {
  display: block; margin-top: 2px; color: #9ca3af;
  font-family: ui-monospace, monospace; font-size: 10px; font-weight: 450;
}
.os-tip::after {
  content: ""; position: absolute; left: 50%; top: 100%;
  transform: translateX(-50%);
  border: 6px solid transparent; border-top-color: #0a0a0a;
}
/* 第一排：气泡改向下展开，避免贴顶被裁 */
.os-hot.os-hot-below .os-tip {
  bottom: auto; top: calc(100% + 8px);
  transform: translateX(-50%) translateY(-6px);
}
.os-hot.os-hot-below .os-tip::after {
  top: auto; bottom: 100%;
  border-top-color: transparent; border-bottom-color: #0a0a0a;
}
.os-hot:hover .os-tip, .os-hot.is-on .os-tip {
  opacity: 1; transform: translateX(-50%) translateY(0);
}
.os-dock {
  max-width: 1100px; margin: 0 auto; width: 100%;
  display: grid; grid-template-columns: 1.2fr .8fr; gap: 12px;
}
@media (max-width: 860px) { .os-dock { grid-template-columns: 1fr; } }
.os-panel {
  background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 14px 16px;
}
.os-panel h2 {
  margin: 0 0 10px; font-size: 11px; letter-spacing: .14em;
  text-transform: uppercase; color: var(--muted); font-weight: 700;
}
.os-row {
  display: grid; grid-template-columns: 12px 1fr auto; gap: 12px; align-items: center;
  padding: 10px 0; border-bottom: 1px solid color-mix(in srgb, var(--line) 80%, transparent);
  border: 0; background: transparent; width: 100%; text-align: left; cursor: pointer; font: inherit; color: inherit;
  border-bottom: 1px solid color-mix(in srgb, var(--line) 80%, transparent);
}
.os-row:last-child { border-bottom: 0; }
.os-row:hover .os-nm { color: var(--accent); }
.os-dot { width: 10px; height: 10px; border-radius: 50%; }
.os-nm { font-weight: 700; font-size: 14px; letter-spacing: -.02em; }
.os-meta { color: var(--muted); font-size: 12px; font-family: ui-monospace, monospace; margin-top: 2px; }
.os-st { font-size: 11px; font-weight: 700; padding: 4px 9px; border-radius: 999px; }
.os-st-w { background: #e7f8ef; color: #0f7a52; }
.os-st-i { background: #f3f4f6; color: #6b7280; }
.os-st-o { background: #feeeee; color: #b42318; }
.os-feed { display: flex; flex-direction: column; gap: 0; }
.os-feed-item {
  display: grid; grid-template-columns: 48px 1fr; gap: 10px;
  padding: 9px 0; border-bottom: 1px solid color-mix(in srgb, var(--line) 80%, transparent);
  font-size: 13px;
}
.os-feed-item:last-child { border-bottom: 0; }
.os-feed-item time { font-family: ui-monospace, monospace; font-size: 11px; color: var(--muted); }
.os-detail {
  margin-top: 8px; padding-top: 10px; border-top: 1px dashed var(--line);
  font-size: 13px; color: var(--ink);
}
.os-detail .sub { color: var(--muted); font-size: 12px; margin-top: 4px; }
.os-err { color: var(--bad); font-size: 13px; padding: 8px 0; }
.os-empty { color: var(--muted); font-size: 13px; padding: 8px 0; }
.os-film-note {
  max-width: 1100px; margin: -4px auto 0; width: 100%;
  color: var(--muted); font-size: 12px; line-height: 1.45;
}
.os-film-note code { font-family: ui-monospace, monospace; font-size: 11px; color: var(--ink); }
/* 成片微动：工作中敲击 / 待命呼吸 / 休假 zZZ 浮动 */
@keyframes os-tap { 0%,100% { transform: translateY(0); } 50% { transform: translateY(2px); } }
@keyframes os-breathe { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-2px); } }
@keyframes os-zzz { 0%,100% { opacity: .45; transform: translateY(0); } 50% { opacity: 1; transform: translateY(-4px); } }
.os-sil-work .os-hands { animation: os-tap 0.55s ease-in-out infinite; transform-origin: center; }
.os-sil:not(.os-sil-work):not(.os-sil-off) { animation: os-breathe 2.8s ease-in-out infinite; }
.os-sil-off .os-zzz { animation: os-zzz 2.2s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .os-sil-work .os-hands, .os-sil, .os-sil-off .os-zzz { animation: none; }
}
`;

function ensureStyle() {
  if (typeof document === 'undefined') return;
  let el = document.getElementById(CSS_ID);
  if (!el) {
    el = document.createElement('style');
    el.id = CSS_ID;
    document.head.appendChild(el);
  }
  el.textContent = PAGE_CSS;
}

function stCls(status) {
  return status === 'working' ? 'os-st-w' : status === 'idle' ? 'os-st-i' : 'os-st-o';
}

function tipFor(slot) {
  if (slot.overflow?.length > 1) {
    return { tip: `另有 ${slot.overflow.length - 1} 位同事`, sub: `+${slot.overflow.length}` };
  }
  const a = slot.agent;
  if (!a) return { tip: '空工位', sub: '去人事部入职' };
  if (a.status === 'working') {
    return { tip: a.progress?.line || '工作中…', sub: `${a.provider || '?'} · working` };
  }
  if (a.status === 'idle') return { tip: '待命 · 无进行中工单', sub: `${a.provider || '?'} · idle` };
  return { tip: a.reason || '休假中', sub: `${a.provider || '?'} · offline` };
}

export default {
  id: 'office-studio',
  title: '工位棚',
  icon: '▢',
  order: 6,
  hidden: true, // v2 导航收敛为 总览/机器人/设置 三项——全景页不再占导航位（深链 #/office-studio 仍可达）
  component({ WAO }) {
    ensureStyle();
    const { h, useState, useEffect, useAgents, useTimeline, React } = WAO;
    const useRef = React.useRef;
    const { agents, error } = useAgents();
    const timeline = typeof useTimeline === 'function' ? useTimeline() : { rows: [] };
    const rows = timeline?.rows ?? [];
    const [sel, setSel] = useState(null);
    // 有 assets/office-loop.mp4 时默认走成片；加载失败再回退 SVG
    const [film, setFilm] = useState(true);
    const videoRef = useRef(null);
    const loopSrc = new URL('office-loop.mp4', ASSET_BASE).href;
    const posterSrc = new URL('office-poster.jpg', ASSET_BASE).href;

    const slots = assignSeats(agents);
    const nWork = (agents ?? []).filter((a) => a.status === 'working').length;
    const nOff = (agents ?? []).filter((a) => a.status === 'offline' || a.enabled === false).length;
    const total = (agents ?? []).length;

    useEffect(() => {
      if (!film) return;
      const v = videoRef.current;
      if (!v) return;
      v.play?.().catch(() => {});
    }, [film]);

    const selAgent = (agents ?? []).find((a) => a.id === sel);
    const recent = [...rows].slice(-6).reverse();

    return h('div', { className: 'os-page' },
      h('header', { className: 'os-hero' },
        h('h1', null, '一家你独自经营的公司'),
        h('p', null, '白棚工位阵列 · hover 热区看汇报'),
        h('div', { className: 'os-pills' },
          h('span', { className: 'os-pill' }, '在岗 ', h('em', null, `${nWork}/${total || 0}`)),
          h('span', { className: 'os-pill' }, '休假 ', h('em', null, nOff)),
        )),

      h('div', { className: 'os-stage-wrap' },
        h('div', { className: 'os-stage', role: 'img', 'aria-label': '办公室工位棚' },
          h('div', { className: 'os-stage-media' },
            film
              ? [
                h('img', {
                  key: 'poster', className: 'poster', alt: '',
                  src: posterSrc,
                }),
                h('video', {
                  key: 'loop', ref: videoRef, muted: true, loop: true, playsInline: true,
                  autoPlay: true, preload: 'auto',
                  poster: posterSrc,
                  src: loopSrc,
                  onError: () => setFilm(false),
                }),
              ]
              : StageFilm({ h, slots })),
          h('div', { className: 'os-hots' },
          slots.map((slot, i) => {
            const s = slot.seat;
            const a = slot.agent;
            const tip = tipFor(slot);
            const pc = a ? providerColor(a.provider) : '#94A3B8';
            const on = sel != null && (a?.id === sel || (slot.overflow && slot.overflow.some((x) => x.id === sel)));
            const dim = sel != null && !on;
            const below = s.top < 35; // 第一排向下出泡
            return h('button', {
              key: i,
              type: 'button',
              className: 'os-hot'
                + (below ? ' os-hot-below' : '')
                + (on ? ' is-on' : '')
                + (dim ? ' is-dim' : ''),
              style: {
                left: `${s.left}%`, top: `${s.top}%`,
                width: `${s.w}%`, height: `${s.h}%`,
                '--pc': pc,
              },
              'aria-label': a?.name || '空工位',
              onClick: () => {
                if (slot.overflow?.length > 1) {
                  setSel(slot.overflow[0]?.id ?? null);
                  return;
                }
                setSel(a ? (sel === a.id ? null : a.id) : null);
              },
              onFocus: () => { if (a) setSel(a.id); },
            },
            h('div', { className: 'os-tip' }, tip.tip, h('small', null, tip.sub)));
          })),
        ),
      ),

      h('p', { className: 'os-film-note' },
        film
          ? ['成片预览中（Marvis 公开 loop，仅本地看效果，不定稿）。热区可 hover/点击。']
          : ['成片未加载，已回退自有 SVG 工位棚。']),

      error != null ? h('div', { className: 'os-err', style: { maxWidth: 1100, margin: '0 auto' } },
        `加载同事列表失败：${error}`) : null,

      h('div', { className: 'os-dock' },
        h('section', { className: 'os-panel' },
          h('h2', null, '花名册 · 映射到热区'),
          (agents ?? []).length === 0
            ? h('div', { className: 'os-empty' }, '空棚——去人事部办理入职')
            : (agents ?? []).map((a) => h('button', {
              key: a.id,
              type: 'button',
              className: 'os-row',
              onClick: () => setSel(sel === a.id ? null : a.id),
            },
            h('span', { className: 'os-dot', style: { background: providerColor(a.provider) } }),
            h('div', null,
              h('div', { className: 'os-nm' }, a.name || a.id),
              h('div', { className: 'os-meta' },
                a.status === 'working'
                  ? (a.progress?.line || `${a.provider} · working`)
                  : a.status === 'idle'
                    ? `${a.provider} · idle`
                    : (a.reason || `${a.provider} · offline`))),
            h('span', { className: 'os-st ' + stCls(a.status) }, STATUS_LABEL[a.status] ?? a.status))),
          selAgent ? h('div', { className: 'os-detail' },
            h('div', null, selAgent.name || selAgent.id),
            selAgent.progress?.line
              ? h('div', { className: 'sub' }, selAgent.progress.line)
              : h('div', { className: 'sub' },
                selAgent.reason || (STATUS_LABEL[selAgent.status] ?? selAgent.status)),
            selAgent.progress?.startedAt
              ? h('div', { className: 'sub' }, '已进行 ' + elapsed(Date.now() - selAgent.progress.startedAt))
              : null,
            h('div', { className: 'sub' },
              `今日工单 ${selAgent.todayTurns ?? 0} · ${selAgent.provider || '?'} · ${selAgent.id}`),
          ) : null,
        ),
        h('section', { className: 'os-panel' },
          h('h2', null, '近况'),
          recent.length === 0
            ? h('div', { className: 'os-empty' }, '暂无事件流')
            : h('div', { className: 'os-feed' },
              recent.map((r, i) => {
                const t = Number.isFinite(r.at) ? new Date(r.at) : null;
                const hh = t ? `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}` : '--:--';
                const name = (agents ?? []).find((a) => a.id === r.botId)?.name || r.botId || '—';
                const text = r.text || r.kind || '';
                return h('div', { key: i, className: 'os-feed-item' },
                  h('time', null, hh),
                  h('span', null, h('b', null, name), ' ', text));
              })),
        ),
      ),
    );
  },
};
