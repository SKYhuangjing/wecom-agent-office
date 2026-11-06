// 自有成片层：白棚 2×3 工位（OFFICE-STUDIO-SPEC §2）。
// 席位几何与 seats.js 百分比对齐；状态驱动剪影/屏光（非第三方成片）。

import { providerColor } from './seats.js';

const VB = { w: 3840, h: 1330 };

/** Hotspot box → desk unit origin in viewBox units. */
function seatOrigin(seat) {
  const cx = ((seat.left + seat.w / 2) / 100) * VB.w;
  const cy = ((seat.top + seat.h * 0.72) / 100) * VB.h;
  return { cx, cy, boxH: (seat.h / 100) * VB.h };
}

function DeskFurniture({ h, empty, screen }) {
  // Local coords: origin at floor contact under chair; scale ~1 unit = 1px at 520-tall unit
  return h('g', { className: 'os-desk-furn' },
    // contact shadow
    h('ellipse', { cx: 0, cy: 18, rx: 168, ry: 22, fill: '#0F172A', opacity: 0.07 }),
    // pedestal drawers (right)
    h('g', { transform: 'translate(78, -70)' },
      h('rect', { x: 0, y: 0, width: 72, height: 88, rx: 6, fill: '#F1F5F9', stroke: '#E2E8F0', 'stroke-width': 2 }),
      h('line', { x1: 8, y1: 28, x2: 64, y2: 28, stroke: '#E2E8F0', 'stroke-width': 2 }),
      h('line', { x1: 8, y1: 56, x2: 64, y2: 56, stroke: '#E2E8F0', 'stroke-width': 2 }),
      h('circle', { cx: 36, cy: 14, r: 2.5, fill: '#CBD5E1' }),
      h('circle', { cx: 36, cy: 42, r: 2.5, fill: '#CBD5E1' }),
      h('circle', { cx: 36, cy: 70, r: 2.5, fill: '#CBD5E1' }),
    ),
    // desk top + front edge (soft AO)
    h('rect', { x: -150, y: -52, width: 300, height: 16, rx: 5, fill: '#FFFFFF', stroke: '#E8ECF1', 'stroke-width': 2 }),
    h('rect', { x: -150, y: -36, width: 300, height: 10, rx: 2, fill: '#E8ECF1' }),
    h('rect', { x: -148, y: -34, width: 296, height: 3, fill: '#F8FAFC', opacity: 0.8 }),
    // keyboard strip
    h('rect', { x: -48, y: -48, width: 72, height: 7, rx: 2, fill: '#E2E8F0' }),
    // monitor stand + panel
    h('rect', { x: -8, y: -58, width: 16, height: 14, rx: 2, fill: '#94A3B8' }),
    h('rect', { x: -70, y: -158, width: 140, height: 100, rx: 8, fill: '#0B1220' }),
    h('rect', { x: -64, y: -152, width: 128, height: 88, rx: 4, fill: screen.fill }),
    ...screen.kids,
    // chair base + back (behind silhouette)
    h('ellipse', { cx: 0, cy: 8, rx: 34, ry: 8, fill: '#E2E8F0' }),
    h('path', {
      d: 'M-42 -8 Q0 -48 42 -8 L34 28 Q0 12 -34 28 Z',
      fill: '#F8FAFC', stroke: '#E2E8F0', 'stroke-width': 2,
    }),
    empty
      ? h('text', {
        x: 0, y: -100, textAnchor: 'middle', fill: '#94A3B8',
        'font-size': 48, 'font-weight': 700, 'font-family': 'system-ui,sans-serif',
      }, '+')
      : null,
  );
}

function ScreenContent({ h, status, provider }) {
  const pc = providerColor(provider);
  if (status === 'offline') {
    return {
      fill: '#111827',
      kids: [
        h('rect', { key: 'bar', x: -58, y: -118, width: 116, height: 14, rx: 3, fill: '#7F1D1D', opacity: 0.85 }),
      ],
    };
  }
  if (status === 'idle') {
    return {
      fill: '#1E293B',
      kids: [
        h('circle', { key: 'dot', cx: 0, cy: -108, r: 10, fill: pc, opacity: 0.55 }),
        h('rect', { key: 'a', x: -50, y: -90, width: 100, height: 8, rx: 2, fill: '#334155' }),
        h('rect', { key: 'b', x: -50, y: -74, width: 70, height: 8, rx: 2, fill: '#334155' }),
      ],
    };
  }
  // working — fake UI glow
  return {
    fill: '#0F172A',
    kids: [
      h('rect', { key: 'side', x: -58, y: -146, width: 28, height: 76, rx: 3, fill: '#1E293B' }),
      h('rect', { key: 'm1', x: -24, y: -146, width: 76, height: 10, rx: 2, fill: pc, opacity: 0.85 }),
      h('rect', { key: 'm2', x: -24, y: -128, width: 76, height: 8, rx: 2, fill: '#334155' }),
      h('rect', { key: 'm3', x: -24, y: -112, width: 56, height: 8, rx: 2, fill: '#334155' }),
      h('rect', { key: 'm4', x: -24, y: -96, width: 68, height: 8, rx: 2, fill: '#475569' }),
      h('rect', { key: 'm5', x: -24, y: -80, width: 48, height: 8, rx: 2, fill: '#334155' }),
    ],
  };
}

/** Back-facing mascot (short horns) + scarf = provider color. */
function Silhouette({ h, status, provider, overflowN }) {
  const pc = providerColor(provider);
  const offline = status === 'offline';
  const working = status === 'working';
  const opacity = offline ? 0.5 : 1;
  const bodyY = offline ? 12 : 0; // 趴桌微倾

  return h('g', {
    className: working ? 'os-sil os-sil-work' : offline ? 'os-sil os-sil-off' : 'os-sil',
    opacity,
    transform: `translate(0, ${bodyY})`,
  },
  // torso
  h('ellipse', { cx: 0, cy: -8, rx: 36, ry: 46, fill: '#0A0A0A' }),
  // head
  h('circle', { cx: 0, cy: -72, r: 28, fill: '#0A0A0A' }),
  // short horns (bull/rhino read)
  h('path', { d: 'M-18 -92 L-26 -112 L-8 -98 Z', fill: '#0A0A0A' }),
  h('path', { d: 'M18 -92 L26 -112 L8 -98 Z', fill: '#0A0A0A' }),
  // ears
  h('ellipse', { cx: -26, cy: -70, rx: 7, ry: 10, fill: '#0A0A0A' }),
  h('ellipse', { cx: 26, cy: -70, rx: 7, ry: 10, fill: '#0A0A0A' }),
  // scarf / collar — only accent
  h('path', {
    d: 'M-22 -48 Q0 -28 22 -48',
    stroke: pc, 'stroke-width': 9, fill: 'none', 'stroke-linecap': 'round',
  }),
  h('path', {
    d: 'M-6 -40 L-2 -18 L6 -36',
    stroke: pc, 'stroke-width': 7, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  }),
  // arms / typing
  working
    ? h('g', { className: 'os-hands' },
      h('ellipse', { cx: -28, cy: -42, rx: 10, ry: 7, fill: '#0A0A0A' }),
      h('ellipse', { cx: 28, cy: -42, rx: 10, ry: 7, fill: '#0A0A0A' }))
    : h('g', null,
      h('ellipse', { cx: -30, cy: -36, rx: 11, ry: 8, fill: '#0A0A0A' }),
      h('ellipse', { cx: 30, cy: -36, rx: 11, ry: 8, fill: '#0A0A0A' })),
  offline
    ? h('g', { className: 'os-zzz', fill: '#64748B', 'font-family': 'ui-monospace,monospace', 'font-weight': 700 },
      h('text', { x: 48, y: -110, 'font-size': 22 }, 'z'),
      h('text', { x: 62, y: -128, 'font-size': 28 }, 'Z'),
      h('text', { x: 80, y: -150, 'font-size': 34 }, 'Z'))
    : null,
  overflowN > 1
    ? h('g', null,
      h('circle', { cx: 52, cy: -118, r: 24, fill: pc }),
      h('text', {
        x: 52, y: -111, textAnchor: 'middle', fill: '#fff',
        'font-size': 20, 'font-weight': 700, 'font-family': 'system-ui,sans-serif',
      }, `+${overflowN}`))
    : null,
  );
}

function DeskUnit({ h, slot, index }) {
  const { seat, agent, overflow } = slot;
  const { cx, cy, boxH } = seatOrigin(seat);
  const scale = Math.max(0.85, Math.min(1.35, boxH / 280));
  const empty = !agent;
  const status = agent?.status || 'idle';
  const screen = empty
    ? { fill: '#F1F5F9', kids: [] }
    : ScreenContent({ h, status, provider: agent.provider });

  return h('g', {
    key: index,
    className: 'os-desk',
    transform: `translate(${cx}, ${cy}) scale(${scale})`,
  },
  DeskFurniture({ h, empty, screen }),
  !empty
    ? Silhouette({
      h,
      status,
      provider: agent.provider,
      overflowN: overflow?.length || 0,
    })
    : null,
  );
}

/** Runtime film: white studio + 6 desk units bound to slots. */
export function StageFilm({ h, slots }) {
  return h('svg', {
    className: 'proc',
    viewBox: `0 0 ${VB.w} ${VB.h}`,
    preserveAspectRatio: 'xMidYMid slice',
    'aria-hidden': true,
  },
  h('defs', null,
    h('radialGradient', { id: 'osFloor', cx: '50%', cy: '78%', r: '55%' },
      h('stop', { offset: '0%', 'stop-color': '#EEF1F5', 'stop-opacity': 0.55 }),
      h('stop', { offset: '55%', 'stop-color': '#F8FAFC', 'stop-opacity': 0.2 }),
      h('stop', { offset: '100%', 'stop-color': '#FFFFFF', 'stop-opacity': 0 })),
    h('filter', { id: 'osSoft', x: '-20%', y: '-20%', width: '140%', height: '140%' },
      h('feDropShadow', { dx: 0, dy: 10, stdDeviation: 14, 'flood-color': '#0F172A', 'flood-opacity': 0.06 })),
  ),
  h('rect', { width: VB.w, height: VB.h, fill: '#FFFFFF' }),
  h('rect', { width: VB.w, height: VB.h, fill: 'url(#osFloor)' }),
  // subtle horizon line for studio depth
  h('line', {
    x1: 200, y1: VB.h * 0.42, x2: VB.w - 200, y2: VB.h * 0.42,
    stroke: '#F1F5F9', 'stroke-width': 2,
  }),
  h('g', { filter: 'url(#osSoft)' },
    ...slots.map((slot, i) => DeskUnit({ h, slot, index: i }))),
  );
}
