// ofscene.js — the office 3D engine (M3 T4).
//
// PORTED from ../wecom-bots/client.js lines 691-1573 (the OfScene renderer of
// the v1 office). What was inherited verbatim is the *mechanism* the old scene
// proved in production: the P(x,y,z) isometric/top-down projection with a
// pan/zoom camera, the shade() three-face lighting trick, the box/onFront/
// onRight painter primitives, the BFS navigation grid with corner-cutting +
// line-of-sight smoothing, the worker slot-assignment state machine (used-slot
// tracking, seed rotation, door spawn) and the onFrame(anchors) callback that
// lets DOM nameplates ride on canvas heads. What was DROPPED is everything
// visual (palette, furniture, worker art, sky) and every React coupling —
// those are redrawn in office.js, which subclasses OfScene and implements the
// paint* hooks. Engine changes vs the port, all marked [change] below:
//   1. De-Reactified: pure class, no JSX/closure over app state.
//   2. Layout data (desks/sofas/spots/blockers) moved out of the module into
//      constructor opts — the engine is room-agnostic.
//   3. buildNav() exported standalone and parameterized (blockers/frees/docks)
//      so the BFS machinery is unit-testable without a canvas.
//   4. Day phase is no longer wall-clock bound: a slow phase clock (default
//      240s per full day, seeded from the local hour) drives phaseAt(); it can
//      also be locked to one phase for deterministic screenshots.
//   5. draw() orchestrates via subclass hooks (paint/collect/paintOver/
//      ambient) instead of hardcoded scenery; sorting + anchors stay here.
//   6. syncWorkers() takes a layout table and a fallback chain, so the office
//      can queue over-quota working bots near the door instead of wandering.

// —— color math (ported verbatim; cache keeps per-frame shading free) ————
export function ofRgb(c) {
  if (c.startsWith('hsl')) {
    const m = c.match(/[\d.]+/g).map(Number);
    const [h, sat, l] = m;
    const a = (sat / 100) * Math.min(l / 100, 1 - l / 100);
    const f = (n) => { const k = (n + h / 30) % 12; return Math.round(255 * (l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
    return [f(0), f(8), f(4)];
  }
  const h = c.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const ofShadeCache = new Map();
// shade(color, f): f<0 darkens toward black, f>0 lightens toward white.
export function ofShade(c, f) {
  const k = c + '\u0000' + f;
  let v = ofShadeCache.get(k);
  if (v) return v;
  const [r, g, b] = ofRgb(c);
  const m = (x) => Math.max(0, Math.min(255, Math.round(f < 0 ? x * (1 + f) : x + (255 - x) * f)));
  v = `rgb(${m(r)},${m(g)},${m(b)})`;
  ofShadeCache.set(k, v);
  return v;
}

// mix(a, b, t): linear hex blend — offline workers are desaturated with this.
export function ofMix(a, b, t) {
  const A = ofRgb(a), B = ofRgb(b);
  const m = (i) => Math.round(A[i] + (B[i] - A[i]) * t);
  return `rgb(${m(0)},${m(1)},${m(2)})`;
}

// Deterministic per-id seeds (ported): appearance derivation + slot rotation.
export function ofSeed(id) {
  let x = 0;
  for (const c of String(id)) x = (Math.imul(x, 31) + c.charCodeAt(0)) >>> 0;
  return x >>> 0;
}
export function ofHue(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

// —— day/night phase clock ————————————————————————————————————————————————
// [change] The port read the wall clock (ofDayPhase). Here the day is a slow
// loop: clock∈[0,1) advances over dayLengthMs (default 4 real minutes), so a
// viewer sees dawn→day→dusk→night within one sitting. Bands (fractions of the
// cycle, aligned so 0 = midnight): dawn 04:20-06:40, day 07:40-16:50,
// dusk 17:45-20:00, night 21:00-03:20 (wrapping); the gaps are smooth
// cross-fades. phaseAt returns the blend {a, b, mix} the palette lerps on.
const PHASE_SPANS = [
  ['dawn', 'dawn', 0.18, 0.28], ['dawn', 'day', 0.28, 0.32],
  ['day', 'day', 0.32, 0.70], ['day', 'dusk', 0.70, 0.74],
  ['dusk', 'dusk', 0.74, 0.84], ['dusk', 'night', 0.84, 0.88],
  ['night', 'night', 0.88, 1.14], ['night', 'dawn', 1.14, 1.18],
];
export function phaseAt(c) {
  const cc = ((c % 1) + 1) % 1;
  const s = cc < 0.18 ? cc + 1 : cc; // night wraps midnight: shift into one frame
  for (const [a, b, lo, hi] of PHASE_SPANS) {
    if (s >= lo && s < hi) {
      const mix = a === b ? 0 : (s - lo) / (hi - lo);
      return { a, b, mix, phase: mix < 0.5 ? a : b };
    }
  }
  return { a: 'night', b: 'night', mix: 0, phase: 'night' }; // unreachable band math guard
}
const PHASE_LOCK_MID = { night: 0.95, dawn: 0.23, day: 0.51, dusk: 0.79 };

// —— BFS navigation grid (ported verbatim in mechanics, parameterized) ————
// cell: grid resolution in tiles; radius: worker body radius padded around
// blockers; wallPad: keep-off distance from walls; blockers: [x,y,w,d] rects;
// frees: points forced walkable (desk seats etc. sit inside desk rects);
// docks: destinations reached only through an approach point (sofa seats —
// workers step to the approach, then slide into the seat, mirroring people).
export function buildNav({ W, D, cell = 0.3, radius = 0.17, wallPad = 0.42, blockers = [], frees = [], docks = [] }) {
  const R = radius;
  const w = Math.ceil(W / cell), h = Math.ceil(D / cell);
  const blocked = new Uint8Array(w * h);
  const near = (x, y, x0, y0, x1, y1, pad) => x >= x0 - pad && x <= x1 + pad && y >= y0 - pad && y <= y1 + pad;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const x = i * cell + cell / 2, y = j * cell + cell / 2;
      let b = x < wallPad + R || y < wallPad + R || x > W - wallPad - R || y > D - wallPad - R ? 1 : 0;
      for (const [bx, by, bw, bd] of blockers) if (near(x, y, bx, by, bx + bw, by + bd, R)) b = 1;
      for (const [fx, fy] of frees) if (near(x, y, fx, fy, fx, fy, 0.2)) b = 0;
      blocked[j * w + i] = b;
    }
  }
  const inside = (i, j) => i >= 0 && j >= 0 && i < w && j < h;
  const free = (i, j) => inside(i, j) && !blocked[j * w + i];
  const freeAt = (x, y) => free(Math.floor(x / cell), Math.floor(y / cell));
  const open = (x, y) => {
    const i0 = Math.floor(x / cell), j0 = Math.floor(y / cell);
    if (free(i0, j0)) return [i0, j0];
    for (let r = 1; r < 30; r++) {
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        if (free(i0 + di, j0 + dj)) return [i0 + di, j0 + dj];
      }
    }
    return [i0, j0];
  };
  // line-of-sight check with corner-cut rejection (diagonal through two walls
  // is a wall — ported)
  const clear = (a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const cuts = [0, 1];
    for (const [st, dlt] of [[a[0], dx], [a[1], dy]]) {
      if (Math.abs(dlt) < 1e-10) continue;
      const lo = Math.min(st, st + dlt), hi = Math.max(st, st + dlt);
      for (let n = Math.floor(lo / cell) + 1; n * cell < hi; n++) cuts.push((n * cell - st) / dlt);
    }
    cuts.sort((p, q) => p - q);
    let prev = null;
    for (let k = 0; k < cuts.length - 1; k++) {
      if (cuts[k + 1] - cuts[k] < 1e-10) continue;
      const t = (cuts[k] + cuts[k + 1]) / 2;
      const i = Math.floor((a[0] + dx * t) / cell), j = Math.floor((a[1] + dy * t) / cell);
      if (!free(i, j)) return false;
      if (prev && i !== prev[0] && j !== prev[1] && (!free(i, prev[1]) || !free(prev[0], j))) return false;
      prev = [i, j];
    }
    return freeAt(...a) && freeAt(...b);
  };
  function corridor(from, to) {
    if (!freeAt(...from) || !freeAt(...to)) return [];
    const [si, sj] = open(from[0], from[1]);
    const [gi, gj] = open(to[0], to[1]);
    const start = sj * w + si, goal = gj * w + gi;
    if (start === goal) return [[to[0], to[1]]];
    const prev = new Int32Array(w * h).fill(-1);
    prev[start] = start;
    const q = [start];
    for (let head = 0; head < q.length; head++) {
      const c = q[head];
      if (c === goal) break;
      const ci = c % w, cj = (c - ci) / w;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = ci + di, nj = cj + dj;
        if (!free(ni, nj)) continue;
        if (di && dj && (!free(ci + di, cj) || !free(ci, cj + dj))) continue;
        const n = nj * w + ni;
        if (prev[n] !== -1) continue;
        prev[n] = c;
        q.push(n);
      }
    }
    if (prev[goal] === -1) return [];
    const cells = [];
    for (let c = goal; c !== start; c = prev[c]) cells.push(c);
    cells.push(start);
    cells.reverse();
    const pts = cells.map((c) => { const i = c % w; return [i * cell + cell / 2, ((c - i) / w) * cell + cell / 2]; });
    pts[0] = [from[0], from[1]];
    pts[pts.length - 1] = [to[0], to[1]];
    // string-pull smoothing: keep only turning points visible from each other
    const out = [];
    let i = 0;
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      while (j > i + 1 && !clear(pts[i], pts[j])) j--;
      out.push(pts[j]);
      i = j;
    }
    if (!out.length) out.push(pts[pts.length - 1]);
    return out;
  }
  const dockAt = (p) => docks.findIndex((dk) => Math.hypot(dk.to[0] - p[0], dk.to[1] - p[1]) < 0.04);
  const path = (from, to) => {
    if (Math.hypot(to[0] - from[0], to[1] - from[1]) < 0.001) return [];
    const entry = dockAt(to), exit = dockAt(from);
    const a = exit >= 0 ? docks[exit].via : from;
    const b = entry >= 0 ? docks[entry].via : to;
    const middle = corridor(a, b);
    if (!middle.length) return [];
    return [...(exit >= 0 ? [a] : []), ...middle, ...(entry >= 0 ? [to] : [])];
  };
  return { freeAt, clear, path };
}

const CAM_LIMITS = { minZoom: 1, maxZoom: 3.5, panMargin: 0.12 };

export class OfScene {
  // opts: { room:{W,D,WALL}, nav, layout:{kindOf,spots,fallback,makeWorker},
  //         onPick, onFrame, reduced, dayLengthMs, phaseLock, dim, seedClock }
  constructor(canvas, opts = {}) {
    this.c = canvas;
    this.g = canvas.getContext('2d');
    this.opts = opts;
    this.room = opts.room ?? { W: 16, D: 12, WALL: 3.1 };
    this.nav = opts.nav;
    this.layout = opts.layout ?? {};
    this.onPick = opts.onPick || null;
    this.onFrame = opts.onFrame || null;
    this.dim = opts.dim === '2d' ? '2d' : '3d';
    this.workers = new Map();
    this.t = 0; this.last = 0; this.running = false; this.first = true;
    this.cam = { x: 0, y: 0, z: 1 };
    this.selected = null; this.hover = null;
    this.reduced = opts.reduced ?? (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false);
    this.stars = Array.from({ length: 120 }, (_, i) => [ofSeed('s' + i) % 997 / 997, ofSeed('t' + i) % 991 / 991, ofSeed('u' + i) % 983 / 983]);
    // phase clock [change]: seeded from the local hour, then a slow loop
    const dayMs = opts.dayLengthMs ?? 240_000;
    this.clock = opts.seedClock ?? ((new Date().getHours() + new Date().getMinutes() / 60) / 24);
    this.clockRate = 1 / (dayMs / 1000);
    this.phaseLock = opts.phaseLock ?? null;
    this.resize();
    this.bindInput();
  }

  // —— projection (ported verbatim) ————————————————————————————————————
  rawP(x, y, z = 0) {
    if (this.dim === '2d') return [this.ox + x * this.s, this.oy + y * this.s * 0.82 - z * this.s * 0.5];
    return [this.ox + (x - y) * this.s * 0.866, this.oy + (x + y) * this.s * 0.5 - z * this.s];
  }
  P(x, y, z = 0) {
    const p = this.rawP(x, y, z);
    const cx = this.W / 2, cy = this.H / 2;
    return [cx + (p[0] - cx) * this.cam.z + this.cam.x, cy + (p[1] - cy) * this.cam.z + this.cam.y];
  }
  depth(x, y) { return x + y; }
  setDim(d) { this.dim = d === '2d' ? '2d' : '3d'; this.resize(); }
  resetCam() { this.cam = { x: 0, y: 0, z: 1 }; }
  setPhaseLock(k) { this.phaseLock = PHASE_LOCK_MID[k] != null ? k : null; }
  phaseInfo() { return phaseAt(this.phaseLock != null ? PHASE_LOCK_MID[this.phaseLock] : this.clock); }

  roomOutline() {
    const pts = [];
    for (const [x, y] of [[0, 0], [this.room.W, 0], [0, this.room.D], [this.room.W, this.room.D]]) {
      pts.push([x, y, 0]);
      if (x === 0 || y === 0) pts.push([x, y, this.room.WALL]);
    }
    return pts;
  }
  resize() {
    const r = this.c.getBoundingClientRect();
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    this.W = Math.max(200, r.width); this.H = Math.max(160, r.height);
    this.c.width = Math.round(this.W * dpr); this.c.height = Math.round(this.H * dpr);
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.fit();
  }
  fit() {
    this.s = 1; this.ox = 0; this.oy = 0;
    const pts = this.roomOutline().map(([x, y, z]) => this.rawP(x, y, z));
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const bw = Math.max(...xs) - Math.min(...xs), bh = Math.max(...ys) - Math.min(...ys);
    this.s = Math.min((this.W * 0.92) / bw, (this.H * 0.94) / bh);
    this.ox = (this.W - bw * this.s) / 2 - Math.min(...xs) * this.s;
    this.oy = (this.H - bh * this.s) / 2 - Math.min(...ys) * this.s + this.H * 0.02;
  }
  clampCam() {
    const cam = this.cam;
    cam.z = Math.min(CAM_LIMITS.maxZoom, Math.max(CAM_LIMITS.minZoom, cam.z));
    cam.x = Math.max(-this.W * CAM_LIMITS.panMargin, Math.min(this.W * CAM_LIMITS.panMargin, cam.x));
    cam.y = Math.max(-this.H * CAM_LIMITS.panMargin, Math.min(this.H * CAM_LIMITS.panMargin, cam.y));
  }

  // —— pointer input (ported verbatim: pan-drag/wheel-zoom/pick) —————————
  bindInput() {
    const c = this.c;
    if (!c?.addEventListener) return;
    this._ptrs = new Map(); this._drag = null; this._suppress = false;
    if (c.style) c.style.touchAction = 'none';
    const pt = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const down = (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const [x, y] = pt(e);
      this._ptrs.set(e.pointerId, { x, y });
      c.setPointerCapture?.(e.pointerId);
      this._drag = { x, y, sx: x, sy: y, moved: false };
      this._suppress = false;
    };
    const move = (e) => {
      if (!this._ptrs.has(e.pointerId)) return;
      const [x, y] = pt(e);
      this._ptrs.set(e.pointerId, { x, y });
      const d = this._drag;
      if (!d) { this.hover = this.hitAt(x, y); return; }
      if (!d.moved && Math.hypot(x - d.sx, y - d.sy) > 3) d.moved = true;
      if (d.moved) {
        this.cam.x += x - d.x; this.cam.y += y - d.y;
        this.clampCam();
        this._suppress = true;
        if (c.style) c.style.cursor = 'grabbing';
      }
      d.x = x; d.y = y;
    };
    const up = (e) => {
      this._ptrs.delete(e.pointerId);
      if (!this._ptrs.size) {
        this._drag = null;
        if (c.style) c.style.cursor = '';
        if (this._suppress) setTimeout(() => { this._suppress = false; }, 0);
      }
    };
    c.addEventListener('pointerdown', down);
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', (e) => {
      const f = Math.exp(-(Number(e.deltaY) || 0) * 0.0016);
      const z0 = this.cam.z;
      this.cam.z = Math.min(CAM_LIMITS.maxZoom, Math.max(CAM_LIMITS.minZoom, z0 * f));
      if (this.cam.z !== z0) e.preventDefault?.();
    }, { passive: false });
    c.addEventListener('click', (e) => {
      if (this._suppress) { this._suppress = false; e.stopImmediatePropagation?.(); return; }
      const [x, y] = pt(e);
      const key = this.hitAt(x, y);
      if (key && this.onPick) this.onPick(key);
    });
  }
  hitAt(px, py) {
    let best = '', bd = Infinity;
    for (const w of this.workers.values()) {
      if (!w.screen) continue;
      const cx = w.screen.x;
      const cy = (w.screen.y + w.screen.foot[1]) / 2;
      const hh = (w.screen.foot[1] - w.screen.y) / 2 + 5;
      const dx = Math.abs(px - cx), dy = Math.abs(py - cy);
      if (dx < this.s * 0.5 && dy < hh) {
        const d = dx + dy;
        if (d < bd) { bd = d; best = w.key; }
      }
    }
    return best;
  }

  // —— painter primitives (ported verbatim) ———————————————————————————
  poly(pts, fill, stroke, lw) {
    const g = this.g;
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw || 1; g.stroke(); }
  }
  box(x, y, z, w, d, h, color, o = {}) {
    const P = (a, b, c) => this.P(a, b, c);
    const line = o.line === false ? null : 'rgba(0,0,0,.18)';
    this.poly([P(x, y + d, z), P(x + w, y + d, z), P(x + w, y + d, z + h), P(x, y + d, z + h)], o.left || ofShade(color, -0.18), line);
    if (this.dim === '3d') this.poly([P(x + w, y, z), P(x + w, y + d, z), P(x + w, y + d, z + h), P(x + w, y, z + h)], o.right || ofShade(color, -0.36), line);
    this.poly([P(x, y, z + h), P(x + w, y, z + h), P(x + w, y + d, z + h), P(x, y + d, z + h)], o.top || color, line);
  }
  onFront(x, y, z, w, d, h, u0, v0, u1, v1, color) {
    const P = (a, c) => this.P(x + a * w, y + d, z + c * h);
    this.poly([P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)], color);
  }
  onRight(x, y, z, w, d, h, u0, v0, u1, v1, color) {
    const P = (a, c) => this.P(x + w, y + a * d, z + c * h);
    this.poly([P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)], color);
  }
  text(s, x, y, size, color, weight) {
    const g = this.g;
    g.font = `${weight || 600} ${size}px system-ui,"PingFang SC",sans-serif`;
    g.fillStyle = color;
    g.textAlign = 'center';
    g.fillText(s, x, y);
    g.textAlign = 'left';
  }

  // —— worker sync (ported slot machine; layout supplied by the subclass) —
  // layout: kindOf(agent)→kind, spots[kind]=[[x,y,facing]...],
  //         fallback[kind]→next kind when this one is full,
  //         makeWorker(agent, seed)→appearance fields for a fresh worker.
  // opts.reshuffle(worker)→true forces a worker to give up its slot this pass
  // (the office uses it to keep idle bots strolling between venues).
  setAgents(agents, opts = {}) {
    const { kindOf, spots, fallback = {}, makeWorker } = this.layout;
    const seen = new Set();
    const used = {};
    for (const k of Object.keys(spots)) used[k] = new Set();
    for (const a of agents) {
      const w = this.workers.get(a.id);
      if (w && w.kind === kindOf(a) && w.slot >= 0 && !opts.reshuffle?.(w)) used[w.kind].add(w.slot);
    }
    for (const a of agents) {
      seen.add(a.id);
      let w = this.workers.get(a.id);
      const seed = ofSeed(a.id);
      if (!w) {
        // first bots materialize at their spot; later joiners walk in the door
        const [sx, sy] = this.first ? [null, null] : [this.layout.door?.[0] ?? 1, (this.layout.door?.[1] ?? 2) + (((seed >>> 3) % 7) - 3) * 0.3];
        w = { key: a.id, x: sx, y: sy, kind: '', slot: -1, phase: ((seed % 97) / 97) * 6, ...(makeWorker?.(a, seed) ?? {}) };
        this.workers.set(a.id, w);
      }
      w.a = a;
      const wantKind = kindOf(a);
      if (w.kind !== wantKind || w.slot < 0 || opts.reshuffle?.(w)) {
        let kind = wantKind, slot = -1;
        while (kind && slot < 0) {
          const n = spots[kind]?.length ?? 0;
          for (let i = 0; i < n; i++) {
            const j = (seed + i) % n;
            if (!used[kind].has(j)) { slot = j; break; }
          }
          if (slot < 0) kind = fallback[kind] ?? 'wander';
        }
        if (slot < 0) { kind = 'wander'; slot = seed % spots.wander.length; }
        used[kind].add(slot);
        w.kind = kind; w.slot = slot;
      }
      const [tx, ty, facing] = spots[w.kind][w.slot];
      const to = tx + ',' + ty;
      if (w.pathTo !== to) { w.pathTo = to; w.path = null; }
      w.tx = tx; w.ty = ty;
      w.facing = facing || 's';
      if (w.x == null) { w.x = tx; w.y = ty; }
    }
    for (const k of [...this.workers.keys()]) if (!seen.has(k)) this.workers.delete(k);
    this.first = false;
    this.atDesk = {};
    for (const w of this.workers.values()) if (w.kind === 'seat') this.atDesk[w.slot] = w.key;
  }

  // —— movement (ported: path following at constant speed) ————————————
  step(dt) {
    const v = 2.4 * dt;
    for (const w of this.workers.values()) {
      if (w.x == null) continue;
      if (!w.path) w.path = this.nav.path([w.x, w.y], [w.tx, w.ty]);
      let left = v;
      while (left > 1e-6 && w.path.length) {
        const [px, py] = w.path[0];
        const dx = px - w.x, dy = py - w.y;
        const d = Math.hypot(dx, dy);
        if (d <= left) { w.x = px; w.y = py; w.path.shift(); left -= d; }
        else {
          w.x += (dx / d) * left; w.y += (dy / d) * left; left = 0;
        }
      }
      w.walking = w.path.length > 0;
    }
  }

  // —— frame loop ——————————————————————————————————————————————————————
  frame(now) {
    if (!this.running) return;
    const dt = Math.min(0.05, (now - (this.last || now)) / 1000);
    this.last = now;
    if (!this.reduced) this.t += dt;
    this.clock = (this.clock + dt * this.clockRate) % 1;
    this.step(dt);
    this.draw();
    this.raf = requestAnimationFrame((n) => this.frame(n));
  }
  // Orchestration only — every visible thing comes from the subclass hooks:
  // paint(ph) backdrop+floor+walls, collect(ph) depth-ordered draw list,
  // paintOver(ph) labels/bubbles/cards, ambient(ph) full-scene tint color.
  draw() {
    const ph = this.phaseInfo();
    this.g.clearRect(0, 0, this.W, this.H);
    this.paint?.(ph);
    const items = this.collect?.(ph) ?? [];
    items.sort((a, b) => a.k - b.k);
    for (const it of items) it.fn();
    this.paintOver?.(ph);
    const amb = this.ambient?.(ph);
    if (amb) { this.g.fillStyle = amb; this.g.fillRect(0, 0, this.W, this.H); }
    if (this.onFrame) {
      const anchors = [];
      const zoom = this.cam.z || 1;
      for (const w of this.workers.values()) {
        if (!w.screen || !w.a) continue;
        anchors.push({ key: w.key, x: w.screen.x, y: w.screen.y - this.s * 0.25 * zoom });
      }
      this.onFrame(anchors, { phase: ph.phase, dim: this.dim });
    }
  }
  start() {
    if (this.running) return;
    this.running = true;
    this.last = 0;
    this.raf = requestAnimationFrame((n) => this.frame(n));
  }
  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }
}
