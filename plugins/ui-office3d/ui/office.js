// 办公室 (company-metaphor redesign P4) — the soft-illustration visual layer
// over the UNCHANGED ofscene engine (BFS/pan-zoom/slot machine/onFrame stay;
// its unit tests are the contract).
//
// 重绘要点（软插画 2.5D 拟人）：
//   · 画布层全换：渐变地板+大地毯、圆角家具+单层柔影、无像素格无硬方块；
//   · 小人＝头像脸(DiceBear，同 botId 同脸)+胶囊身(provider 色)+简腿：
//     working 打字微动 / idle 呼吸(引擎的踱步照旧) / 休假 灰暗+Zz；
//   · 入职走门：引擎机制（新 joiner 从门口 BFS 走到工位）；
//     离职走出门口淡出：子类 setAgents 差集把离场小人送去门口渐隐；
//   · 昼夜＝色温柔变（相位钟 lerp，暖色天光/灯光）。
//
// Page contract: no build, no JSX, SDK from window.WAO; imports stay inside
// this ui/ directory. Harness params: ?dim=2d, ?phase=day|dawn|dusk|night.
import { OfScene, buildNav, ofShade, ofMix, ofSeed, ofHue, PHASE_LOCK_MID } from './ofscene.js';

// —— layout (ported coordinates — proven collision-free; engine mechanics
// and walkable furniture positions are inherited, only the paint is new) ————
const ROOM = { W: 16, D: 12, WALL: 3.1 };
const DESKS = [
  { x: 3.2, y: 0.55, w: 1.7, d: 0.9, seat: [4.05, 1.95], face: 'n' },
  { x: 5.9, y: 0.55, w: 1.7, d: 0.9, seat: [6.75, 1.95], face: 'n' },
  { x: 8.6, y: 0.55, w: 1.7, d: 0.9, seat: [9.45, 1.95], face: 'n' },
  { x: 11.3, y: 0.55, w: 1.7, d: 0.9, seat: [12.15, 1.95], face: 'n' },
  { x: 10.6, y: 4.6, w: 1.6, d: 0.8, seat: [11.4, 4.0], face: 's' },
  { x: 12.4, y: 4.6, w: 1.6, d: 0.8, seat: [13.2, 4.0], face: 's' },
  { x: 10.6, y: 5.4, w: 1.6, d: 0.8, seat: [11.4, 6.75], face: 'n' },
  { x: 12.4, y: 5.4, w: 1.6, d: 0.8, seat: [13.2, 6.75], face: 'n' },
];
const SOFA = [[1.1, 4.84], [1.1, 5.72], [1.1, 6.6], [1.1, 7.48], [1.1, 8.36], [3.1, 10.95], [4.3, 10.95]];
const SOFA_FACE = ['e', 'e', 'e', 'e', 'e', 'n', 'n'];
const SOFA_APPROACH = SOFA.map(([x, y], i) => (i < 5 ? [2.05, y] : [x, 10.0]));
const FACE = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };
const ACTS = [
  { id: 'bookshelf', label: '📖 书架', x: 1.45, y: 0.5, w: 1.6, d: 0.55, ax: 2.25, ay: 1.65, face: 'n', lz: 2.4, color: '#c98d64' },
  { id: 'pingpong', label: '🏓 乒乓', x: 9.55, y: 7.15, w: 1.9, d: 1.05, ax: 10.5, ay: 8.85, face: 'n', lz: 1.15, color: '#57b394' },
  { id: 'coffee', label: '☕ 咖啡角', x: 14.35, y: 2.15, w: 1.35, d: 0.85, ax: 14.9, ay: 3.4, face: 'n', lz: 1.55, color: '#d99a62' },
];
const NAP = [[13.0, 9.9], [14.5, 9.3], [12.6, 10.6]]; // 休假同事在这里打盹
const WANDER = [[7.0, 4.4], [8.6, 5.7], [6.0, 5.8], [9.0, 8.0], [4.9, 4.8], [5.0, 3.4], [2.4, 6.0]];
const QUEUE = [[1.0, 2.0, 'e'], [1.7, 2.0, 'e'], [1.0, 3.1, 'e'], [1.7, 3.1, 'e']]; // >8 在岗：门口排队
const DOOR = [0.6, 2.6];
const BLOCKERS = [
  ...ACTS.map((a) => [a.x, a.y, a.w, a.d]),
  ...DESKS.map((d) => [d.x, d.y, d.w, d.d]),
  [0, 4.1, 1.5, 5.0],   // west sofa run
  [2.5, 10.55, 2.4, 1.45], // south sofa pair
  [12.4, 9.2, 1.5, 1.7],   // nap corner rug
  [14.9, 4.6, 0.7, 0.7],   // plant
];

const NAV = buildNav({
  W: ROOM.W, D: ROOM.D, cell: 0.3, radius: 0.17, wallPad: 0.42,
  blockers: BLOCKERS,
  frees: [...DESKS.map((d) => d.seat), ...SOFA_APPROACH, ...NAP, ...WANDER,
    ...ACTS.map((a) => [a.ax, a.ay]), DOOR, ...QUEUE.map(([x, y]) => [x, y])],
  docks: SOFA.map(([x, y], i) => ({ to: [x, y], via: SOFA_APPROACH[i] })),
});

// —— provider identities：唯一 accent 家族 ————————————————————————————————
const PROVIDERS = {
  dsh: { color: '#3d5a80', mark: 'bolt', label: 'DSH 工程师' },
  claude: { color: '#e07856', mark: 'asterisk', label: 'Claude 工程师' },
  codex: { color: '#2e9e8f', mark: 'brackets', label: 'Codex 工程师' },
};
const providerOf = (p) => PROVIDERS[p] ?? { color: '#8fa39b', mark: 'diamond', label: `${p ?? '?'} 工程师` };

// timeline kind → ticker hue
const KIND_TICK = {
  run_start: '#7fb3ff', step: '#9aa7b8', tool: '#c9a4ff', thinking: '#7fd9e8',
  turn: '#7ce3a4', run_end: '#8fa0b5',
};

// —— palettes：暖色软插画 ——————————————————————————————————————————————————
// PHASE-VARYING colors keyed by phase, per UI mode. 色温柔变：dawn/day/dusk/
// night 四档，相邻档之间 lerp。floor 是渐变的两端色。
const PAL = {
  light: {
    sky: { night: ['#43507a', '#8d90ad'], dawn: ['#e5c1a4', '#f7e8d6'], day: ['#c9e0ea', '#f3efe4'], dusk: ['#d9a184', '#f2ddc8'] },
    floor: { night: ['#6b7183', '#5d6376'], dawn: ['#ecdfc9', '#e3d2b6'], day: ['#efe7d8', '#e5d9c2'], dusk: ['#ecd9bf', '#e0c9a9'] },
    star: { night: 0.8, dawn: 0.15, day: 0, dusk: 0.3 },
    glass: { night: ['#9db4e8', 0.45], dawn: ['#ecc39a', 0.6], day: ['#d8ecf6', 0.85], dusk: ['#eab49a', 0.6] },
    amb: { night: ['#2c3a66', 0.22], dawn: ['#ff9d6e', 0.06], day: ['#fff8ec', 0.05], dusk: ['#f08a64', 0.10] },
    shaft: { night: 0, dawn: 0.05, day: 0.12, dusk: 0.06 },
    lamp: { night: 0.16, dawn: 0.07, day: 0, dusk: 0.10 },
    ink: { night: '#e9eef8', dawn: '#3a2f3f', day: '#3c4658', dusk: '#463250' },
  },
  dark: {
    sky: { night: ['#0d1424', '#1c2740'], dawn: ['#2a2438', '#4a3242'], day: ['#16324a', '#2c4a66'], dusk: ['#2e1f33', '#503043'] },
    floor: { night: ['#2c3340', '#262c38'], dawn: ['#3f3830', '#37312a'], day: ['#3a4240', '#323a37'], dusk: ['#433632', '#3a2f2b'] },
    star: { night: 1, dawn: 0.3, day: 0.05, dusk: 0.4 },
    glass: { night: ['#8fb0ff', 0.14], dawn: ['#fb923c', 0.22], day: ['#93c5fd', 0.26], dusk: ['#f472b6', 0.22] },
    amb: { night: ['#0a1228', 0.28], dawn: ['#fb923c', 0.06], day: ['#93c5fd', 0.06], dusk: ['#f472b6', 0.07] },
    shaft: { night: 0, dawn: 0.03, day: 0.08, dusk: 0.04 },
    lamp: { night: 0.20, dawn: 0.09, day: 0.02, dusk: 0.11 },
    ink: { night: '#e6edf8', dawn: '#e4d9dc', day: '#d6e4f2', dusk: '#e6d9e2' },
  },
};
// STATIC surfaces per UI mode (phase lighting comes from amb/shaft/lamp on top)
const SURF = {
  light: {
    wallL: '#f1ebdd', wallR: '#e9e2d1', wallEdge: '#d6cdb8', base: 'rgba(90,80,60,.25)',
    rug: 'rgba(158,180,166,.55)', rugEdge: 'rgba(112,138,124,.5)',
    desk: '#dbbc90', deskLeg: '#c2a276', chair: '#7d8a97',
    sofa: '#7d9d92', sofaSeat: '#95b3a7', pillow: '#d9a066',
    shelf: '#b98d63', books: ['#c97b6d', '#7d9ec4', '#cbb076', '#8fb98c', '#ad8fc0'],
    counter: '#c99f74', machine: '#5d6670',
    plant: '#6aa66f', pot: '#c98d64',
    board: '#f8f6ef', boardFrame: '#b9b1a0',
    door: '#c99f74', doorFrame: '#a9855c',
    screenOff: '#39424d', screenIdle: '#2c3540',
    shadow: 'rgba(60,50,35,.20)',
  },
  dark: {
    wallL: '#333c37', wallR: '#2c342f', wallEdge: '#46505a', base: 'rgba(4,8,14,.45)',
    rug: 'rgba(72,92,84,.45)', rugEdge: 'rgba(110,140,130,.3)',
    desk: '#8a6f4d', deskLeg: '#75603f', chair: '#4c5a66',
    sofa: '#41605a', sofaSeat: '#4d7068', pillow: '#a97a4e',
    shelf: '#6b4f35', books: ['#8d5049', '#48698a', '#967f49', '#5f8a63', '#7a5f8a'],
    counter: '#6d553c', machine: '#3a434e',
    plant: '#41764c', pot: '#7d5238',
    board: '#c9cdd4', boardFrame: '#5d6675',
    door: '#6f5638', doorFrame: '#5c4529',
    screenOff: '#171e28', screenIdle: '#101a24',
    shadow: 'rgba(0,0,0,.38)',
  },
};

const lerpEntry = (entry, ph) => {
  const A = entry[ph.a], B = entry[ph.b];
  if (Array.isArray(A)) return [ofMix(A[0], B[0], ph.mix), A[1] + (B[1] - A[1]) * ph.mix];
  if (typeof A === 'number') return A + (B - A) * ph.mix;
  return ofMix(A, B, ph.mix);
};
// two-color gradient pair entry {day: [c1, c2], ...}
const lerpPair = (entry, ph) => [
  ofMix(entry[ph.a][0], entry[ph.b][0], ph.mix),
  ofMix(entry[ph.a][1], entry[ph.b][1], ph.mix),
];

const roundRect = (g, x, y, w, h, r) => {
  if (w < 0 || h < 0) return;
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
};
// rounded quad through 4 screen points (软圆角 iso 面)
const rQuad = (g, pts, r) => {
  const n = pts.length;
  const edge = (i) => {
    const a = pts[i], b = pts[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    return { a, b, ux: dx / len, uy: dy / len };
  };
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const e0 = edge((i - 1 + n) % n), e1 = edge(i);
    const rr = Math.min(r, Math.hypot(e1.b[0] - e1.a[0], e1.b[1] - e1.a[1]) / 3);
    const start = [e1.a[0] - e1.ux * rr, e1.a[1] - e1.uy * rr];
    if (i === 0) g.moveTo(start[0], start[1]);
    else g.lineTo(start[0], start[1]);
    g.quadraticCurveTo(e1.a[0], e1.a[1], e1.a[0] + e1.ux * rr, e1.a[1] + e1.uy * rr);
    void e0;
  }
  g.closePath();
};
const shortTxt = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const elapsed = (ms) => {
  const sec = Math.max(0, Math.round(ms / 1000));
  return sec >= 60 ? `${Math.floor(sec / 60)}m${sec % 60}s` : `${sec}s`;
};

// —— the scene: OfScene engine + soft-illustration paint hooks ————————————
export class OfficeScene extends OfScene {
  constructor(canvas, opts = {}) {
    super(canvas, {
      room: ROOM,
      nav: NAV,
      reduced: opts.reduced,
      dayLengthMs: opts.dayLengthMs,
      phaseLock: opts.phaseLock,
      dim: opts.dim,
      onPick: opts.onPick,
      onFrame: opts.onFrame,
      layout: {
        kindOf: (a) => (a.status === 'working' ? 'seat'
          : isOff(a) ? 'nap' : 'act'),
        spots: {
          seat: DESKS.map((d) => [d.seat[0], d.seat[1], d.face]),
          queue: QUEUE,
          act: [...ACTS.map((a) => [a.ax, a.ay, a.face]), ...SOFA.map(([x, y], i) => [x, y, SOFA_FACE[i]])],
          nap: NAP.map(([x, y]) => [x, y, 's']),
          wander: WANDER.map(([x, y]) => [x, y, 's']),
        },
        fallback: { seat: 'queue', queue: 'wander', act: 'wander', nap: 'wander' },
        door: DOOR,
        makeWorker: () => ({}), // appearance now lives in the avatar face
      },
    });
    this.dark = opts.dark ?? false;
    this.screens = new Map(); // botId → {text, color} latest timeline event
    this.faceImgs = new Map(); // botId → HTMLImageElement (avatar, preloaded)
    this.avatarUrl = opts.avatarUrl ?? null; // (botId) => data: URL
    this.leaving = []; // 离职走门口淡出: {key, x, y, path, alpha, a}
  }
  setDark(d) { this.dark = !!d; }
  setScreens(map) { this.screens = map instanceof Map ? map : new Map(); }
  pal() { return PAL[this.dark ? 'dark' : 'light']; }
  surf() { return SURF[this.dark ? 'dark' : 'light']; }

  // —— 离职走出门口淡出：setAgents 差集捕获，step() 走门渐隐 ——————————
  setAgents(agents, opts = {}) {
    const before = new Map([...this.workers.entries()]);
    super.setAgents(agents, opts);
    for (const [key, w] of before) {
      if (this.workers.has(key) || w.x == null) continue;
      this.leaving.push({
        key, x: w.x, y: w.y, alpha: 1, a: w.a,
        path: this.nav.path([w.x, w.y], [DOOR[0], DOOR[1]]),
      });
    }
    // 入职走门是引擎自己的机制（later joiner spawn 在门口）；这里只负责
    // 为新脸预载化身位图。
    if (this.avatarUrl != null) {
      for (const a of agents) {
        if (this.faceImgs.has(a.id)) continue;
        const img = new Image();
        img.onload = () => { this.faceImgs.set(a.id, img); };
        img.onerror = () => { this.faceImgs.delete(a.id); };
        this.faceImgs.set(a.id, img);
        img.src = this.avatarUrl(a.id);
      }
    }
  }
  step(dt) {
    super.step(dt);
    // leaving workers walk to the door at a slightly brisker pace, then fade
    const v = 2.2 * dt;
    for (const L of this.leaving) {
      if (L.path == null || L.path.length === 0) { L.alpha -= dt * 0.55; continue; }
      let left = v;
      while (left > 1e-6 && L.path.length) {
        const [px, py] = L.path[0];
        const dx = px - L.x, dy = py - L.y;
        const d = Math.hypot(dx, dy);
        if (d <= left) { L.x = px; L.y = py; L.path.shift(); left -= d; }
        else { L.x += (dx / d) * left; L.y += (dy / d) * left; left = 0; }
      }
      if (L.path.length === 0) L.alpha -= dt * 0.3;
    }
    this.leaving = this.leaving.filter((L) => L.alpha > 0);
  }

  // —— backdrop ————————————————————————————————————————————————————————————
  paint(ph) {
    this.paintSky(ph);
    this.paintFloor(ph);
    this.paintShafts(ph);
    this.paintLamps(ph);
    this.paintWalls(ph);
  }
  paintSky(ph) {
    const g = this.g, pal = this.pal();
    const [top, bot] = lerpPair(pal.sky, ph);
    const grd = g.createLinearGradient(0, 0, 0, this.H);
    grd.addColorStop(0, top); grd.addColorStop(1, bot);
    g.fillStyle = grd; g.fillRect(0, 0, this.W, this.H);
    const star = lerpEntry(pal.star, ph);
    if (star > 0.04) {
      g.fillStyle = `rgba(225,235,255,${0.9 * star})`;
      for (const [a, b2, tw] of this.stars) {
        const x = a * this.W, y = b2 * this.H * 0.6;
        const al = 0.5 + 0.5 * Math.sin(this.t * (0.5 + tw) + a * 20);
        g.globalAlpha = al * star;
        g.beginPath(); g.arc(x, y, 1.1, 0, Math.PI * 2); g.fill();
      }
      g.globalAlpha = 1;
    }
    this.paintSunMoon(ph);
  }
  paintSunMoon(ph) {
    const g = this.g;
    const c = this.phaseLock != null ? PHASE_LOCK_MID[this.phaseLock] : this.clock;
    const dayness = ph.phase === 'day' ? 1 : ph.phase === 'night' ? 0 : 0.5;
    if (dayness > 0.15) {
      const t = Math.min(1, Math.max(0, (c - 0.25) / 0.5));
      const x = this.W * (0.12 + 0.76 * t);
      const y = this.H * (0.34 - 0.22 * Math.sin(Math.PI * t));
      const r = Math.max(10, this.H * 0.032);
      const glow = g.createRadialGradient(x, y, 0, x, y, r * 5);
      glow.addColorStop(0, 'rgba(255,224,170,.5)');
      glow.addColorStop(1, 'rgba(255,224,170,0)');
      g.fillStyle = glow; g.fillRect(x - r * 5, y - r * 5, r * 10, r * 10);
      g.fillStyle = '#ffd98f';
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    if (dayness < 0.85) {
      const t = c > 0.75 ? (c - 0.75) / 0.5 : (c + 0.25) / 0.5;
      const x = this.W * (0.16 + 0.68 * t);
      const y = this.H * (0.30 - 0.2 * Math.sin(Math.PI * t));
      const r = Math.max(7, this.H * 0.024);
      g.fillStyle = 'rgba(232,238,250,.92)';
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      g.fillStyle = ofMix(ofMix('#141d33', '#2c4a66', 0.5), '#101828', 0.4);
      g.beginPath(); g.arc(x + r * 0.38, y - r * 0.22, r * 0.86, 0, Math.PI * 2); g.fill();
    }
  }
  // —— floor：渐变 + 大地毯，无格无缝 ————————————————————————————————————
  paintFloor(ph) {
    const g = this.g, s = this.surf();
    const [c1, c2] = lerpPair(this.pal().floor, ph);
    const p0 = this.P(0, 0), p1 = this.P(ROOM.W, 0), p2 = this.P(ROOM.W, ROOM.D), p3 = this.P(0, ROOM.D);
    const grd = g.createLinearGradient(p0[0], p0[1], p2[0], p2[1]);
    grd.addColorStop(0, c1); grd.addColorStop(1, c2);
    this.poly([p0, p1, p2, p3], grd);
    // lounge rug under the sofa corner + ping-pong area (圆角软地毯)
    this.softQuad([this.P(2.1, 9.6), this.P(6.5, 9.6), this.P(6.5, 11.75), this.P(2.1, 11.75)], 18, s.rug, s.rugEdge, 1.4);
    this.softQuad([this.P(2.45, 9.95), this.P(6.15, 9.95), this.P(6.15, 11.4), this.P(2.45, 11.4)], 14, null, s.rugEdge, 1);
    // nap corner rug
    this.softQuad([this.P(12.2, 9.05), this.P(15.45, 9.05), this.P(15.45, 11.25), this.P(12.2, 11.25)], 16,
      this.dark ? 'rgba(96,78,66,.5)' : 'rgba(214,190,168,.6)', 'rgba(120,96,76,.35)', 1.2);
  }
  paintShafts(ph) {
    const a = lerpEntry(this.pal().shaft, ph);
    if (a < 0.02) return;
    for (const [t0, t1] of [[0.16, 0.36], [0.46, 0.66], [0.68, 0.82]]) {
      const x0 = t0 * ROOM.W + 0.1, x1 = t1 * ROOM.W - 0.1;
      this.poly([this.P(x0, 0.02, ROOM.WALL * 0.34), this.P(x1, 0.02, ROOM.WALL * 0.34),
        this.P(x1 + 1.1, 3.1, 0), this.P(x0 + 1.1, 3.1, 0)], `rgba(255,240,205,${a})`);
    }
  }
  paintLamps(ph) {
    const a = lerpEntry(this.pal().lamp, ph);
    if (a < 0.02) return;
    const g = this.g;
    for (const [x, y] of [[7.4, 1.3], [11.5, 5.2], [1.9, 6.6], [14.8, 2.8], [5.0, 10.9]]) {
      const [px, py] = this.P(x, y, 0);
      const r = this.s * 1.7;
      const grd = g.createRadialGradient(px, py - this.s * 0.4, 0, px, py - this.s * 0.4, r);
      grd.addColorStop(0, `rgba(249,183,112,${a})`);
      grd.addColorStop(1, 'rgba(249,183,112,0)');
      g.fillStyle = grd;
      g.fillRect(px - r, py - r, r * 2, r * 2);
    }
  }
  // —— walls：暖色两面 + 圆角窗/门/挂钟/白板 ————————————————————————————
  paintWalls(ph) {
    const g = this.g, s = this.surf(), W = ROOM.WALL;
    this.poly([this.P(0, 0), this.P(0, ROOM.D), this.P(0, ROOM.D, W), this.P(0, 0, W)], s.wallL);
    this.poly([this.P(0, 0), this.P(ROOM.W, 0), this.P(ROOM.W, 0, W), this.P(0, 0, W)], s.wallR);
    // wainscot line (soft)
    g.strokeStyle = s.wallEdge; g.lineWidth = 1; g.globalAlpha = 0.6;
    for (const [a, b] of [[this.P(0, 0, 0.95), this.P(0, ROOM.D, 0.95)], [this.P(0, 0, 0.95), this.P(ROOM.W, 0, 0.95)]]) {
      g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
    }
    g.globalAlpha = 1;
    // windows (rounded, glass tinted by phase)
    const glass = lerpEntry(this.pal().glass, ph);
    const [gr, gg2, gb] = hexRgb(glass[0]);
    const glassFill = `rgba(${gr},${gg2},${gb},${glass[1]})`;
    for (const [t0, t1] of [[0.16, 0.36], [0.46, 0.66], [0.68, 0.82]]) {
      const x0 = t0 * ROOM.W, x1 = t1 * ROOM.W;
      this.softQuad([this.P(x0, 0.01, W * 0.34), this.P(x1, 0.01, W * 0.34),
        this.P(x1, 0.01, W * 0.8), this.P(x0, 0.01, W * 0.8)], 8, glassFill, s.wallEdge, 1.4);
      const mid = this.P((x0 + x1) / 2, 0.01, W * 0.57);
      g.strokeStyle = s.wallEdge; g.lineWidth = 1.4;
      g.beginPath();
      g.moveTo(mid[0], mid[1] - W * 0.23 * this.s);
      g.lineTo(mid[0], mid[1] + W * 0.23 * this.s);
      g.stroke();
    }
    // door on the west wall (新同事从这里进来)
    this.softQuad([this.P(0.01, 2.0, 0), this.P(0.01, 3.2, 0), this.P(0.01, 3.2, 2.2), this.P(0.01, 2.0, 2.2)], 6, s.doorFrame);
    this.softQuad([this.P(0.015, 2.08, 0.06), this.P(0.015, 3.12, 0.06), this.P(0.015, 3.12, 2.12), this.P(0.015, 2.08, 2.12)], 6, s.door);
    const knob = this.P(0.02, 2.24, 1.05);
    g.fillStyle = '#e8c14d'; g.beginPath(); g.arc(knob[0], knob[1], Math.max(1.5, this.s * 0.045), 0, Math.PI * 2); g.fill();
    this.softQuad([this.P(0.02, 2.42, 2.32), this.P(0.02, 2.78, 2.32), this.P(0.02, 2.78, 2.52), this.P(0.02, 2.42, 2.52)], 3, 'rgba(70,140,96,.9)');
    this.wallClock();
    this.whiteboard();
    // wall/floor seam shadow
    g.strokeStyle = s.base; g.lineWidth = 4;
    const w1 = this.P(0, 0), w2 = this.P(0, ROOM.D), w3 = this.P(ROOM.W, 0);
    g.beginPath(); g.moveTo(w1[0], w1[1]); g.lineTo(w2[0], w2[1]); g.stroke();
    g.beginPath(); g.moveTo(w1[0], w1[1]); g.lineTo(w3[0], w3[1]); g.stroke();
    g.lineWidth = 1;
  }
  wallClock() {
    const g = this.g, s = this.surf();
    const [cx, cy] = this.P(8.05, 0.02, 2.5);
    const r = this.s * 0.3;
    g.fillStyle = s.boardFrame; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
    g.fillStyle = this.dark ? '#d9dde3' : '#faf8f2'; g.beginPath(); g.arc(cx, cy, r * 0.86, 0, Math.PI * 2); g.fill();
    const d = new Date();
    const hand = (frac, len, wid, color) => {
      const a = frac * Math.PI * 2;
      g.strokeStyle = color; g.lineWidth = wid; g.lineCap = 'round';
      g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.sin(a) * r * len, cy - Math.cos(a) * r * len); g.stroke();
    };
    hand(((d.getHours() % 12) + d.getMinutes() / 60) / 12, 0.5, Math.max(1.2, r * 0.09), '#3a4250');
    hand(d.getMinutes() / 60, 0.74, Math.max(1, r * 0.07), '#3a4250');
    g.fillStyle = '#c46a6a'; g.beginPath(); g.arc(cx, cy, Math.max(1, r * 0.06), 0, Math.PI * 2); g.fill();
  }
  whiteboard() {
    const g = this.g, s = this.surf();
    this.softQuad([this.P(13.4, 0.02, 1.5), this.P(15.4, 0.02, 1.5), this.P(15.4, 0.02, 2.62), this.P(13.4, 0.02, 2.62)], 8, s.boardFrame);
    this.softQuad([this.P(13.48, 0.025, 1.58), this.P(15.32, 0.025, 1.58), this.P(15.32, 0.025, 2.54), this.P(13.48, 0.025, 2.54)], 6, s.board);
    const p = (x, z) => this.P(13.4 + x, 0.03, 1.75 + z);
    g.strokeStyle = '#5d7fb0'; g.lineWidth = 1.8; g.lineCap = 'round'; g.beginPath();
    let q = p(0.12, 0.05); g.moveTo(q[0], q[1]);
    for (const [x, z] of [[0.45, 0.24], [0.8, 0.1], [1.15, 0.34], [1.5, 0.52]]) { q = p(x, z); g.lineTo(q[0], q[1]); }
    g.stroke();
    g.strokeStyle = '#d08a68'; g.lineWidth = 1.4; g.beginPath();
    q = p(0.12, 0.46); g.moveTo(q[0], q[1]); q = p(1.5, 0.22); g.lineTo(q[0], q[1]); g.stroke();
    const bars = ['#57a08c', '#5d7fb0', '#d9a066'];
    for (let i = 0; i < 3; i++) {
      const h = 0.1 + i * 0.06;
      const b0 = p(0.18 + i * 0.26, 0.62 - h), b1 = p(0.18 + i * 0.26, 0.62), b2 = p(0.3 + i * 0.26, 0.62), b3 = p(0.3 + i * 0.26, 0.62 - h);
      this.softQuad([b0, b1, b2, b3], 2, bars[i]);
    }
  }

  // —— soft-draw helpers ———————————————————————————————————————————————————
  // 圆角 iso 面 painters（无描边默认）
  softQuad(pts, r, fill, stroke, lw) {
    rQuad(this.g, pts, r);
    if (fill) { this.g.fillStyle = fill; this.g.fill(); }
    if (stroke) { this.g.strokeStyle = stroke; this.g.lineWidth = lw || 1; this.g.stroke(); }
  }
  groundShadow(x, y, rx, ry, alpha = 1) {
    const g = this.g;
    const [px, py] = this.P(x, y, 0);
    g.fillStyle = this.surf().shadow;
    g.globalAlpha = alpha;
    g.beginPath(); g.ellipse(px, py, rx * this.s, ry * this.s, 0, 0, Math.PI * 2); g.fill();
    g.globalAlpha = 1;
  }

  // —— furniture + workers, depth-ordered ———————————————————————————————
  collect() {
    const out = [];
    const add = (x, y, fn) => out.push({ k: this.depth(x, y), fn: fn.bind(this) });
    DESKS.forEach((d, i) => add(d.x + d.w, d.y + d.d, () => this.desk(d, i)));
    add(3.7, 11.7, () => {
      for (let i = 0; i < 2; i++) {
        const x = 2.5 + i * 1.2;
        this.sofaUnit(x, 11.35, 1.2, 0.35, x, 10.55, 'n');
      }
      this.seatedWorkers(1);
    });
    add(1.1, 9.1, () => {
      for (let i = 0; i < 5; i++) this.sofaUnit(0.35, 4.4 + i * 0.88, 0.4, 0.88, 0.7, 4.4 + i * 0.88, 'e');
      this.cushion(0.95, 4.35, 0.35, 0.75);
      this.cushion(0.95, 8.95, 0.35, 0.75);
      this.seatedWorkers(0);
    });
    const bs = ACTS[0];
    add(bs.x + bs.w, bs.y + bs.d, () => { this.bookshelf(bs); this.cat(); });
    const pp = ACTS[1];
    add(pp.x + pp.w, pp.y + pp.d, () => this.pingpong(pp));
    const cof = ACTS[2];
    add(cof.x + cof.w, cof.y + cof.d, () => this.coffee(cof));
    add(15.0, 4.7, () => this.plant(14.95, 4.65, 0.5, 0.9));
    add(6.9, 11.4, () => this.plant(6.65, 11.25, 0.42, 0.7));
    add(9.2, 2.1, () => this.plant(9.0, 1.95, 0.36, 0.6));
    // nap corner: nap rug drawn in paintFloor; napping workers sorted with it
    add(13.7, 10.2, () => {
      const napping = [...this.workers.values()].filter((w) => w.kind === 'nap')
        .sort((a, b) => this.depth(a.x, a.y) - this.depth(b.x, b.y));
      for (const w of napping) this.worker(w);
    });
    for (const w of this.workers.values()) {
      if (this.sofaGroup(w) >= 0 || w.kind === 'nap') continue;
      out.push({ k: this.depth(w.x, w.y) + 0.02, fn: () => this.worker(w) });
    }
    // 离场小人：按其最后深度插入，走门渐隐
    for (const L of this.leaving) {
      out.push({ k: this.depth(L.x, L.y) + 0.02, fn: () => this.leaver(L) });
    }
    return out;
  }
  cushion(x, y, w, d) { // sofa armrest cushion (rounded, soft)
    const s = this.surf();
    this.groundShadow(x + w / 2, y + d / 2, w * 0.7, d * 0.45, 0.7);
    this.softQuad([this.P(x, y, 0), this.P(x + w, y, 0), this.P(x + w, y + d, 0.42), this.P(x, y + d, 0.42)], 10, s.sofa);
  }
  sofaUnit(x, y, w, d, cx, cy, face) {
    const s = this.surf();
    // backrest (rounded soft block) + seat cushion
    this.groundShadow(x + w / 2, y + d / 2 + 0.4, w * 0.8, d * 1.1, 0.7);
    this.softQuad([this.P(x, y, 0), this.P(x + w, y, 0), this.P(x + w, y + d, 0.95), this.P(x, y + d, 0.95)], 12, s.sofa);
    if (face === 'e') this.softQuad([this.P(cx, cy, 0), this.P(cx + 0.8, cy, 0), this.P(cx + 0.8, cy + d, 0.42), this.P(cx, cy + d, 0.42)], 10, s.sofaSeat);
    else this.softQuad([this.P(cx, cy, 0), this.P(cx + w, cy, 0), this.P(cx + w, cy + 0.8, 0.42), this.P(cx, cy + 0.8, 0.42)], 10, s.sofaSeat);
    // a pillow on every other unit
    if ((Math.round(x * 7 + y) & 1) === 0) {
      this.softQuad([this.P(x + 0.08, y + d * 0.2, 0.5), this.P(x + 0.34, y + d * 0.1, 0.5), this.P(x + 0.34, y + d * 0.75, 0.72), this.P(x + 0.08, y + d * 0.85, 0.72)], 6, s.pillow);
    }
  }
  sofaSlot(w) {
    if (w.kind === 'act' && w.slot >= ACTS.length) return w.slot - ACTS.length;
    return -1;
  }
  sofaGroup(w) {
    const slot = this.sofaSlot(w);
    if (slot >= 0 && !w.walking) return slot >= 5 ? 1 : 0;
    if (w.x >= 1.5 && w.x <= 2.5 && w.y >= 4.1 && w.y <= 9.1) return 0;
    if (w.x >= 2.5 && w.x <= 4.9 && w.y >= 9.8 && w.y <= 10.55) return 1;
    return -1;
  }
  seatedWorkers(group) {
    const seated = [...this.workers.values()].filter((w) => this.sofaGroup(w) === group)
      .sort((a, b) => this.depth(a.x, a.y) - this.depth(b.x, b.y));
    for (const w of seated) this.worker(w);
  }
  desk(d, i) {
    const s = this.surf();
    const wkey = this.atDesk?.[i];
    const w = wkey != null ? this.workers.get(wkey) : null;
    const a = w?.a;
    // soft ground shadow + rounded top
    this.groundShadow(d.x + d.w / 2, d.y + d.d / 2 + 0.25, d.w * 0.62, d.d * 1.1, 0.8);
    // legs (two soft rounded columns)
    for (const lx of [d.x + 0.12, d.x + d.w - 0.3]) {
      const [px0, py0] = this.P(lx, d.y + d.d - 0.12, 0);
      const [px1, py1] = this.P(lx, d.y + d.d - 0.12, 0.68);
      const g = this.g;
      g.strokeStyle = s.deskLeg; g.lineCap = 'round';
      g.lineWidth = Math.max(2.5, this.s * 0.09);
      g.beginPath(); g.moveTo(px0, py0); g.lineTo(px1, py1); g.stroke();
    }
    // desktop (rounded iso quad)
    this.softQuad([this.P(d.x, d.y, 0.68), this.P(d.x + d.w, d.y, 0.68), this.P(d.x + d.w, d.y + d.d, 0.68), this.P(d.x, d.y + d.d, 0.68)], 9, s.desk);
    this.softQuad([this.P(d.x + 0.08, d.y + 0.07, 0.76), this.P(d.x + d.w - 0.08, d.y + 0.07, 0.76), this.P(d.x + d.w - 0.08, d.y + d.d - 0.07, 0.76), this.P(d.x + 0.08, d.y + d.d - 0.07, 0.76)], 7, ofShade(s.desk, 0.16));
    // monitor + stand; screen faces the sitter
    const mx = d.x + d.w / 2 - 0.55, my = d.y + d.d / 2 - 0.34;
    this.box(d.x + d.w / 2 - 0.06, d.y + d.d / 2 - 0.05, 0.76, 0.12, 0.12, 0.14, s.machine, { line: false });
    this.softQuad([this.P(mx, my, 0.9), this.P(mx + 1.1, my, 0.9), this.P(mx + 1.1, my + 0.68, 0.9), this.P(mx, my + 0.68, 0.9)], 5, ofShade(s.machine, -0.05));
    this.screen(d, i, w, a);
    // keyboard (rounded) + mug
    const ky = d.face === 'n' ? d.y + d.d - 0.3 : d.y + 0.12;
    this.softQuad([this.P(d.x + d.w / 2 - 0.28, ky, 0.76), this.P(d.x + d.w / 2 + 0.28, ky, 0.76), this.P(d.x + d.w / 2 + 0.28, ky + 0.17, 0.8), this.P(d.x + d.w / 2 - 0.28, ky + 0.17, 0.8)], 4, '#4a525d');
    this.mug(d.x + d.w - 0.24, d.y + d.d / 2 + 0.12, a?.status === 'working' ? '#e8c14d' : '#c98d64');
    this.plaque(d, a);
  }
  mug(x, y, color) {
    const [px, py] = this.P(x, y, 0.78);
    const g = this.g, r = Math.max(2.2, this.s * 0.06);
    g.fillStyle = color;
    g.beginPath(); g.arc(px, py, r, 0, Math.PI * 2); g.fill();
    g.fillStyle = this.dark ? '#22282e' : '#f4f1ea';
    g.beginPath(); g.arc(px, py, r * 0.55, 0, Math.PI * 2); g.fill();
  }
  // monitor screen: lit ticker for working, standby mark for idle, dark glass
  screen(d, i, w, a) {
    const s = this.surf();
    const mx = d.x + d.w / 2 - 0.55;
    const my = d.y + d.d / 2 - 0.34;
    const south = d.face !== 's';
    const yPlane = south ? my + 0.68 : my - 0.005;
    const quad = [this.P(mx + 0.05, yPlane, 0.97), this.P(mx + 1.05, yPlane, 0.97),
      this.P(mx + 1.05, yPlane, 1.5), this.P(mx + 0.05, yPlane, 1.5)];
    const working = a?.status === 'working';
    const feed = w != null ? this.screens.get(w.key) : null;
    const body = working ? '#14301f' : a ? s.screenIdle : s.screenOff;
    rQuad(this.g, quad, 4);
    this.g.fillStyle = body; this.g.fill();
    this.g.strokeStyle = working ? 'rgba(140,240,180,.4)' : 'rgba(255,255,255,.08)';
    this.g.lineWidth = 1; this.g.stroke();
    const g = this.g;
    g.save();
    rQuad(g, quad, 4);
    g.clip();
    const qh = Math.hypot(quad[3][0] - quad[0][0], quad[3][1] - quad[0][1]);
    if (working) {
      const text = shortTxt(feed?.text || a?.progress?.line || '正在工作…', 46);
      const color = feed?.color || '#7ce3a4';
      const fs = Math.max(6.5, qh * 0.34);
      g.font = `600 ${fs}px system-ui,"PingFang SC",sans-serif`;
      const tw = Math.max(40, g.measureText(text).width);
      const span = tw + 26;
      const off = (this.t * 22) % span;
      const by = (quad[0][1] + quad[3][1]) / 2 + fs * 0.36;
      const x0 = quad[0][0] + 4;
      for (const dx of [off, off - span]) {
        g.fillStyle = color;
        g.beginPath(); g.arc(x0 + dx + 3, by - fs * 0.32, Math.max(1.2, fs * 0.14), 0, Math.PI * 2); g.fill();
        g.fillStyle = '#d7efe0';
        g.fillText(text, x0 + dx + 9, by);
      }
    } else if (a) {
      const pv = providerOf(a.provider);
      const pulse = 0.35 + 0.25 * Math.sin(this.t * 1.4 + ofSeed(a.id) % 10);
      const cx = (quad[0][0] + quad[1][0]) / 2, cy = (quad[0][1] + quad[3][1]) / 2;
      this.mark(pv.mark, cx, cy, Math.max(3, qh * 0.22), `rgba(255,255,255,${pulse})`);
    } else {
      const cx = (quad[0][0] + quad[1][0]) / 2, cy = (quad[0][1] + quad[3][1]) / 2;
      g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(cx - 6, cy + 4); g.lineTo(cx + 2, cy - 5); g.stroke();
    }
    g.restore();
  }
  plaque(d, a) {
    const pv = providerOf(a?.provider);
    const x = d.x + 0.1, y = d.y + d.d / 2 - 0.12, z = 0.76;
    const south = d.face !== 's';
    const yPlane = south ? y + 0.07 : y - 0.005;
    const q = [this.P(x, yPlane, z + 0.03), this.P(x + 0.36, yPlane, z + 0.03), this.P(x + 0.36, yPlane, z + 0.27), this.P(x, yPlane, z + 0.27)];
    rQuad(this.g, q, 5);
    this.g.fillStyle = pv.color; this.g.fill();
    const cx = (q[0][0] + q[1][0]) / 2, cy = (q[0][1] + q[3][1]) / 2;
    this.mark(pv.mark, cx, cy, Math.max(2.4, this.s * 0.09), 'rgba(255,255,255,.95)');
  }
  mark(kind, cx, cy, r, color) {
    const g = this.g;
    g.save();
    g.strokeStyle = color; g.fillStyle = color;
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.lineWidth = Math.max(1, r * 0.26);
    if (kind === 'bolt') {
      g.beginPath();
      g.moveTo(cx + r * 0.14, cy - r);
      g.lineTo(cx - r * 0.52, cy + r * 0.14);
      g.lineTo(cx + r * 0.04, cy + r * 0.14);
      g.lineTo(cx - r * 0.14, cy + r);
      g.lineTo(cx + r * 0.52, cy - r * 0.14);
      g.lineTo(cx - r * 0.04, cy - r * 0.14);
      g.closePath(); g.fill();
    } else if (kind === 'asterisk') {
      for (let i = 0; i < 3; i++) {
        const a = (i * Math.PI) / 3;
        g.beginPath();
        g.moveTo(cx - Math.cos(a) * r, cy - Math.sin(a) * r);
        g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
        g.stroke();
      }
    } else if (kind === 'brackets') {
      g.beginPath();
      g.moveTo(cx - r * 0.34, cy - r * 0.6); g.lineTo(cx - r * 0.8, cy); g.lineTo(cx - r * 0.34, cy + r * 0.6);
      g.stroke();
      g.beginPath();
      g.moveTo(cx + r * 0.34, cy - r * 0.6); g.lineTo(cx + r * 0.8, cy); g.lineTo(cx + r * 0.34, cy + r * 0.6);
      g.stroke();
    } else {
      g.beginPath();
      g.moveTo(cx, cy - r); g.lineTo(cx + r, cy); g.lineTo(cx, cy + r); g.lineTo(cx - r, cy);
      g.closePath(); g.stroke();
    }
    g.restore();
  }
  bookshelf(bs) {
    const s = this.surf();
    this.groundShadow(bs.x + bs.w / 2, bs.y + bs.d + 0.3, bs.w * 0.7, 0.35, 0.8);
    this.softQuad([this.P(bs.x, bs.y, 0), this.P(bs.x + bs.w, bs.y, 0), this.P(bs.x + bs.w, bs.y + bs.d, 2.1), this.P(bs.x, bs.y + bs.d, 2.1)], 10, s.shelf);
    const g = this.g;
    // soft book spines (rounded) on the front face
    for (let shelf = 0; shelf < 3; shelf++) {
      for (let k = 0; k < 5; k++) {
        const u0 = 0.07 + k * 0.18, u1 = u0 + 0.13;
        const p = (u, v) => this.P(bs.x + u * bs.w, bs.y + bs.d, 0.12 + shelf * 0.62 + v * 0.66);
        const a = p(u0, 0.12), b = p(u1, 0.1), c = p(u1, 0.62), d2 = p(u0, 0.64);
        this.softQuad([a, b, c, d2], 3, s.books[(k + shelf) % 5]);
      }
    }
  }
  cat() {
    // the shelf cat: pink blanket, cream body, pacing + tail + blinking
    const bs = ACTS[0];
    const t = this.reduced ? 0 : this.t;
    const pace = 0.5 + 0.5 * Math.sin(t * 0.22);
    const x = bs.x + 0.34 + pace * (bs.w - 0.68);
    const y = bs.y + bs.d / 2;
    const z = 1.55;
    const awake = !this.reduced && Math.sin(t * 0.31) > -0.35;
    const tail = Math.sin(t * (awake ? 1.5 : 0.4));
    const P = (dx, dy, dz) => this.P(x + dx, y + dy, z + dz);
    this.softQuad([P(-0.3, -0.2, -0.03), P(0.3, -0.2, -0.03), P(0.3, 0.2, 0.02), P(-0.3, 0.2, 0.02)], 8, '#e8879e');
    this.softQuad([P(-0.18, -0.11, 0), P(0.16, -0.11, 0), P(0.16, 0.11, 0.12), P(-0.18, 0.11, 0.12)], 6, '#f2e3c8');
    this.softQuad([P(0.1, -0.08, 0.06), P(0.28, -0.08, 0.06), P(0.28, 0.08, 0.19), P(0.1, 0.08, 0.19)], 5, '#f7ecd9');
    const g = this.g;
    // ears (two little dots) + tail
    g.fillStyle = '#d99a4e';
    for (const ey of [-0.07, 0.07]) {
      const e = P(0.24, ey, 0.19);
      g.beginPath(); g.arc(e[0], e[1], 1.8, 0, Math.PI * 2); g.fill();
    }
    const t0 = P(-0.2, 0.05 + tail * 0.04, 0.06), t1 = P(-0.34, 0.12 + tail * 0.06, 0.1);
    g.strokeStyle = '#d99a4e'; g.lineWidth = 2; g.lineCap = 'round';
    g.beginPath(); g.moveTo(t0[0], t0[1]); g.lineTo(t1[0], t1[1]); g.stroke();
    // eyes
    const eye = (u) => {
      const p = P(0.2, u, 0.13);
      g.fillStyle = '#2a2320';
      g.beginPath(); g.arc(p[0], p[1], awake ? 1.2 : 0.5, 0, Math.PI * 2); g.fill();
    };
    eye(-0.05); eye(0.05);
  }
  pingpong(pp) {
    const s = this.surf();
    this.groundShadow(pp.x + pp.w / 2, pp.y + pp.d / 2 + 0.3, pp.w * 0.62, pp.d * 0.75, 0.8);
    const g = this.g;
    for (const [lx, ly] of [[0.1, 0.1], [pp.w - 0.18, 0.1], [0.1, pp.d - 0.18], [pp.w - 0.18, pp.d - 0.18]]) {
      const [px0, py0] = this.P(pp.x + lx, pp.y + ly, 0);
      const [px1, py1] = this.P(pp.x + lx, pp.y + ly, 0.66);
      g.strokeStyle = s.machine; g.lineCap = 'round'; g.lineWidth = Math.max(2.5, this.s * 0.09);
      g.beginPath(); g.moveTo(px0, py0); g.lineTo(px1, py1); g.stroke();
    }
    this.softQuad([this.P(pp.x, pp.y, 0.66), this.P(pp.x + pp.w, pp.y, 0.66), this.P(pp.x + pp.w, pp.y + pp.d, 0.66), this.P(pp.x, pp.y + pp.d, 0.66)], 10, '#2c7a5b');
    this.softQuad([this.P(pp.x + 0.05, pp.y + 0.05, 0.75), this.P(pp.x + pp.w - 0.05, pp.y + 0.05, 0.75), this.P(pp.x + pp.w - 0.05, pp.y + pp.d - 0.05, 0.75), this.P(pp.x + 0.05, pp.y + pp.d - 0.05, 0.75)], 8, '#3f9e73');
    // net + paddles + ball
    this.softQuad([this.P(pp.x - 0.02, pp.y + pp.d / 2 - 0.02, 0.75), this.P(pp.x + pp.w + 0.02, pp.y + pp.d / 2 - 0.02, 0.75), this.P(pp.x + pp.w + 0.02, pp.y + pp.d / 2 + 0.04, 0.95), this.P(pp.x - 0.02, pp.y + pp.d / 2 + 0.04, 0.95)], 2, '#eef2f5');
    const bt = this.reduced ? 0 : this.t;
    const ball = this.P(pp.x + 0.95 + Math.sin(bt * 2.1) * 0.3, pp.y + 0.42 + Math.cos(bt * 1.7) * 0.12, 0.82);
    g.fillStyle = '#f5d76e';
    g.beginPath(); g.arc(ball[0], ball[1], Math.max(1.6, this.s * 0.05), 0, Math.PI * 2); g.fill();
  }
  coffee(cof) {
    const s = this.surf();
    this.groundShadow(cof.x + cof.w / 2, cof.y + cof.d / 2 + 0.3, cof.w * 0.66, cof.d * 0.7, 0.8);
    this.softQuad([this.P(cof.x, cof.y, 0), this.P(cof.x + cof.w, cof.y, 0), this.P(cof.x + cof.w, cof.y + cof.d, 0.92), this.P(cof.x, cof.y + cof.d, 0.92)], 12, s.counter);
    this.softQuad([this.P(cof.x + 0.05, cof.y + 0.05, 0.92), this.P(cof.x + cof.w - 0.05, cof.y + 0.05, 0.92), this.P(cof.x + cof.w - 0.05, cof.y + cof.d - 0.05, 0.99), this.P(cof.x + 0.05, cof.y + cof.d - 0.05, 0.99)], 9, ofShade(s.counter, 0.22));
    this.softQuad([this.P(cof.x + 0.14, cof.y + 0.1, 0.99), this.P(cof.x + 0.6, cof.y + 0.1, 0.99), this.P(cof.x + 0.6, cof.y + 0.44, 1.5), this.P(cof.x + 0.14, cof.y + 0.44, 1.5)], 6, s.machine);
    const g = this.g;
    // cups row
    for (let i = 0; i < 3; i++) {
      const p = this.P(cof.x + 0.86 + i * 0.14, cof.y + 0.4, 1.0);
      g.fillStyle = ['#eef2f5', '#e8c14d', '#e8879e'][i];
      g.beginPath(); g.arc(p[0], p[1], Math.max(1.8, this.s * 0.055), 0, Math.PI * 2); g.fill();
    }
    // beans jars
    for (let i = 0; i < 4; i++) {
      const p0 = this.P(cof.x + 0.16 + i * 0.26, cof.y + 0.05, 1.0);
      const p1 = this.P(cof.x + 0.16 + i * 0.26, cof.y + 0.05, 1.18);
      g.strokeStyle = ['#c05a52', '#4a8a5c', '#c89040', '#4a6a9a'][i];
      g.lineWidth = Math.max(3, this.s * 0.1); g.lineCap = 'round';
      g.beginPath(); g.moveTo(p0[0], p0[1]); g.lineTo(p1[0], p1[1]); g.stroke();
    }
    // steam
    if (!this.reduced) {
      const [sx, sy] = this.P(cof.x + 0.37, cof.y + 0.28, 1.55);
      for (let i = 0; i < 2; i++) {
        const p = ((this.t * 0.35 + i * 0.5) % 1);
        g.strokeStyle = `rgba(240,244,248,${0.4 * (1 - p)})`;
        g.lineWidth = 1.4;
        g.beginPath();
        g.arc(sx + Math.sin((p + i) * 6.3) * 4, sy - p * this.s * 0.5, 3 + p * 3, Math.PI * 0.9, Math.PI * 1.9);
        g.stroke();
      }
    }
  }
  plant(x, y, size, h) {
    const s = this.surf();
    const g = this.g;
    this.groundShadow(x + size / 2, y + size / 2, size * 0.8, size * 0.4, 0.7);
    const [px, py] = this.P(x + size / 2, y + size / 2, size * 0.5);
    const sway = this.reduced ? 0 : Math.sin(this.t * 0.8 + x * 3) * 2;
    g.strokeStyle = ofShade(s.pot, -0.25); g.lineWidth = Math.max(1.5, size * this.s * 0.07); g.lineCap = 'round';
    const [tx, ty] = this.P(x + size / 2, y + size / 2, size * 0.8 + h * 0.4);
    g.beginPath(); g.moveTo(px, py); g.lineTo(tx, ty); g.stroke();
    for (const [dx, dy, r] of [[-5, -3, size * this.s * 0.17], [5, -7, size * this.s * 0.15], [0, -13, size * this.s * 0.16]]) {
      g.fillStyle = dx < 0 ? s.plant : ofShade(s.plant, 0.2);
      g.beginPath(); g.arc(px + dx + sway, py + dy - h * this.s * 0.25, Math.max(3, r), 0, Math.PI * 2); g.fill();
    }
    const [bx, by] = this.P(x + size / 2, y + size / 2, size * 0.42);
    g.fillStyle = s.pot;
    roundRect(g, bx - size * this.s * 0.28, by - size * this.s * 0.16, size * this.s * 0.56, size * this.s * 0.42, size * this.s * 0.16);
    g.fill();
  }

  // —— worker art：头像脸 + 胶囊身 + 简腿（screen-space，锚在脚点）——————
  worker(w, opts = {}) {
    const g = this.g;
    const a = w.a || {};
    const off = isOff(a) || opts.leaving;
    const status = a.status ?? 'offline';
    const working = status === 'working';
    const t = this.t + (w.phase ?? 0);
    const alpha = opts.alpha ?? 1;
    const pv = providerOf(a.provider);
    const bodyColor = off ? ofMix(pv.color, this.dark ? '#5c6663' : '#a8b0ac', 0.55) : pv.color;
    const [fx, fy] = this.P(w.x, w.y, 0);
    const k = this.s; // scale
    const zoom = this.cam.z || 1;
    const bw = Math.max(10, k * 0.4 * zoom);
    const bodyH = Math.max(14, k * 0.52 * zoom);
    const legH = Math.max(5, k * 0.16 * zoom);
    const headR = Math.max(7, k * 0.23 * zoom);
    const sitting = !w.walking && (w.kind === 'seat' || this.sofaSlot(w) >= 0);
    // 打字微动 / 呼吸 / 行走摆动
    const typing = working && sitting;
    const bob = typing ? Math.sin(t * 10) * k * 0.012 : 0;
    const breath = (!working && !off && !w.walking) ? 1 + Math.sin(t * 2) * 0.02 : 1;
    const step2 = w.walking ? Math.sin(t * 9) * legH * 0.55 : 0;
    g.save();
    g.globalAlpha = alpha;
    // ground shadow
    g.fillStyle = this.surf().shadow;
    g.beginPath(); g.ellipse(fx, fy, bw * 0.55, bw * 0.3, 0, 0, Math.PI * 2); g.fill();
    if (this.selected === w.key || this.hover === w.key) {
      g.strokeStyle = this.selected === w.key ? 'rgba(255,196,80,.95)' : 'rgba(255,255,255,.55)';
      g.lineWidth = this.selected === w.key ? 2.5 : 1.5;
      g.beginPath(); g.ellipse(fx, fy, bw * 0.8, bw * 0.42, 0, 0, Math.PI * 2); g.stroke();
    }
    const bodyBottom = fy - legH * (sitting ? 0.35 : 1);
    // 简腿：两根圆头短线
    g.strokeStyle = ofShade(bodyColor, -0.35);
    g.lineWidth = Math.max(2, bw * 0.16);
    g.lineCap = 'round';
    const legSpread = bw * 0.2;
    g.beginPath();
    g.moveTo(fx - legSpread, bodyBottom);
    g.lineTo(fx - legSpread + step2 * 0.6, fy - (w.walking ? Math.abs(step2) * 0.4 : 0));
    g.stroke();
    g.beginPath();
    g.moveTo(fx + legSpread, bodyBottom);
    g.lineTo(fx + legSpread - step2 * 0.6, fy - (w.walking ? Math.abs(step2) * 0.4 : 0));
    g.stroke();
    // 胶囊身（provider 色，浅浅的高光）
    const bodyW = bw * breath;
    const bodyTop = bodyBottom - bodyH + bob;
    const grad = g.createLinearGradient(fx - bodyW / 2, bodyTop, fx + bodyW / 2, bodyBottom);
    grad.addColorStop(0, ofShade(bodyColor, 0.18));
    grad.addColorStop(1, bodyColor);
    roundRect(g, fx - bodyW / 2, bodyTop, bodyW, bodyH, bodyW / 2);
    g.fillStyle = grad; g.fill();
    // 胸前小工牌点
    g.fillStyle = 'rgba(255,255,255,.85)';
    g.beginPath(); g.arc(fx, bodyTop + bodyH * 0.55, Math.max(1.2, bw * 0.07), 0, Math.PI * 2); g.fill();
    // 头像脸（DiceBear，同 botId 同脸）+ provider 描边环
    const headCx = fx;
    const headCy = bodyTop - headR * 0.9 + bob;
    const img = this.faceImgs.get(w.key);
    if (off) g.filter = 'grayscale(0.8) opacity(0.85)';
    g.save();
    g.beginPath(); g.arc(headCx, headCy, headR, 0, Math.PI * 2); g.clip();
    if (img != null && img.complete && img.naturalWidth > 0) {
      g.drawImage(img, headCx - headR, headCy - headR, headR * 2, headR * 2);
    } else {
      g.fillStyle = ofShade(bodyColor, 0.35);
      g.fillRect(headCx - headR, headCy - headR, headR * 2, headR * 2);
    }
    g.restore();
    g.filter = 'none';
    g.strokeStyle = pv.color;
    g.lineWidth = Math.max(1.5, headR * 0.14);
    g.beginPath(); g.arc(headCx, headCy, headR + g.lineWidth * 0.4, 0, Math.PI * 2); g.stroke();
    // 状态标识：working provider 色脉动点；休假 Zz
    if (working) {
      const pulse = 0.5 + 0.5 * Math.sin(t * 3);
      g.fillStyle = pv.color;
      g.globalAlpha = alpha * (0.55 + 0.45 * pulse);
      g.beginPath(); g.arc(headCx + headR * 0.85, headCy - headR * 0.85, Math.max(1.6, headR * 0.16 + pulse * headR * 0.08), 0, Math.PI * 2); g.fill();
      g.globalAlpha = alpha;
    } else if (off) {
      for (let i = 0; i < 2; i++) {
        const p = (t * 0.5 + i * 0.5) % 1;
        g.font = `800 ${Math.max(7, headR * (0.4 + 0.25 * i))}px system-ui`;
        g.fillStyle = `rgba(200,208,214,${(1 - p) * 0.9})`;
        g.fillText('z', headCx + headR * (0.6 + p * 0.7), headCy - headR * (0.4 + p * 1.1));
      }
    }
    g.restore();
    w.screen = { x: headCx, y: headCy - headR, foot: [fx, fy] };
  }
  leaver(L) {
    // 离职小人：向门口走+淡出；w.a 保留最后状态（休假样式）
    this.worker({
      key: L.key, a: L.a ?? { status: 'offline' }, x: L.x, y: L.y,
      walking: (L.path?.length ?? 0) > 0, kind: '', slot: -1, phase: 0.5,
    }, { alpha: Math.max(0, Math.min(1, L.alpha)), leaving: true });
  }

  // —— overlays: venue labels, status bubbles, task cards —————————————
  paintOver(ph) {
    const ink = lerpEntry(this.pal().ink, ph);
    const g = this.g;
    for (const a of ACTS) {
      const [x, y] = this.P(a.x + a.w / 2, a.y + a.d / 2, a.lz);
      g.font = '700 10.5px system-ui,"PingFang SC",sans-serif';
      const tw = g.measureText(a.label).width;
      g.fillStyle = this.dark ? 'rgba(10,16,26,.62)' : 'rgba(255,252,246,.78)';
      roundRect(g, x - tw / 2 - 7, y - 12, tw + 14, 18, 9); g.fill();
      this.text(a.label, x, y + 1, 10.5, a.color, '700');
    }
    for (const w of this.workers.values()) this.card(w, ink);
  }
  ambient(ph) {
    const [hex, alpha] = lerpEntry(this.pal().amb, ph);
    const [r, gg, b] = hexRgb(hex);
    return `rgba(${r},${gg},${b},${alpha})`;
  }
  // floating task card: the bot's live progress.line (工作汇报)
  card(w, ink) {
    const a = w.a, g = this.g;
    if (!w.screen || a.status !== 'working') return;
    const dark = this.dark;
    const pv = providerOf(a.provider);
    const sx = w.screen.x;
    const headY = w.screen.y - 6;
    const prog = a.progress?.line || '工作中';
    const el = a.progress?.startedAt ? elapsed(Date.now() - a.progress.startedAt) : '';
    g.font = '700 10px system-ui,"PingFang SC",sans-serif';
    const name = shortTxt(a.name || w.key, 9);
    g.font = '9.5px system-ui,"PingFang SC",sans-serif';
    const line1 = shortTxt(prog, 20);
    const w2 = Math.max(g.measureText(line1).width, g.measureText(name).width * 0.95) + 34;
    const ch = 40;
    const float = this.reduced ? 0 : Math.sin(this.t * 1.8 + ofHue(w.key) / 40) * 2.2;
    const x = sx - w2 / 2;
    const y = headY - ch - 12 + float;
    g.strokeStyle = dark ? 'rgba(120,160,220,.35)' : 'rgba(90,120,180,.4)';
    g.beginPath(); g.moveTo(sx, headY); g.lineTo(sx, y + ch); g.stroke();
    g.fillStyle = dark ? 'rgba(15,21,33,.93)' : 'rgba(255,255,255,.97)';
    roundRect(g, x, y, w2, ch, 10); g.fill();
    g.strokeStyle = dark ? 'rgba(255,255,255,.14)' : 'rgba(20,30,50,.12)'; g.stroke();
    g.fillStyle = pv.color;
    roundRect(g, x + 3, y + 6, 3, ch - 12, 2); g.fill();
    g.font = '700 10px system-ui,"PingFang SC",sans-serif';
    g.fillStyle = dark ? '#eaf2fb' : '#1d2735';
    g.fillText(name, x + 12, y + 15);
    g.fillStyle = '#22a45d';
    g.beginPath(); g.arc(x + w2 - 10, y + 11.5, 2.6, 0, 7); g.fill();
    g.font = '9.5px system-ui,"PingFang SC",sans-serif';
    g.fillStyle = dark ? '#aec2da' : '#4d5b6e';
    g.fillText(line1, x + 12, y + 28);
    if (el) {
      g.font = '8.5px system-ui';
      const ew = g.measureText(el).width + 10;
      g.fillStyle = 'rgba(57,217,138,.16)';
      roundRect(g, x + w2 - ew - 8, y + ch - 14, ew, 11, 5); g.fill();
      g.fillStyle = '#2fa365';
      g.fillText(el, x + w2 - ew - 3, y + ch - 5.5);
    }
    void ink;
  }
}
const hexRgb = (c) => {
  // lerpEntry emits ofMix() output, which is 'rgb(r,g,b)' — parse both forms
  if (c.startsWith('rgb')) {
    const m = c.match(/[\d.]+/g).map(Number);
    return [m[0], m[1], m[2]];
  }
  const h = c.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

// —— page styles ——————————————————————————————————————————————————————————
const CSS = `
.of-stage {
  position: relative; height: calc(100vh - 158px); min-height: 520px;
  border: 1px solid var(--line); border-radius: 14px; overflow: hidden;
  background: var(--bg); user-select: none;
  box-shadow: var(--shadow);
}
.of-stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; cursor: grab; }
.of-otags { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.of-tag {
  position: absolute; left: 0; top: 0; pointer-events: auto; cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
  padding: 2px 10px 2px 3px; border-radius: 999px; border: 1px solid var(--line);
  background: color-mix(in srgb, var(--panel) 90%, transparent);
  color: var(--ink); font: 600 11px/1.4 -apple-system,"PingFang SC",sans-serif;
  box-shadow: var(--shadow);
}
.of-tag:hover { border-color: var(--accent); }
.of-tag .face {
  width: 18px; height: 18px; border-radius: 50%; flex: none;
  border: 1.5px solid var(--pc, var(--line)); background: var(--panel-2); overflow: hidden;
}
.of-tag .face svg { width: 100%; height: 100%; display: block; }
.of-tag .d { width: 7px; height: 7px; border-radius: 50%; background: var(--st-idle); flex: none; }
.of-tag[data-st="work"] .d { background: var(--pc, var(--accent)); animation: of-pulse 1.6s ease-in-out infinite; }
.of-tag[data-st="idle"] .d { background: var(--st-idle); }
.of-tag[data-st="off"] .d { background: var(--st-offline); }
.of-tag[data-st="off"] { opacity: .82; }
.of-tag[data-st="off"] .face { filter: grayscale(0.8); }
@keyframes of-pulse { 0%,100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--pc, var(--accent)) 45%, transparent); } 50% { box-shadow: 0 0 0 3px transparent; } }
@media (prefers-reduced-motion: reduce) { .of-tag[data-st="work"] .d { animation: none; } }
.of-hud {
  position: absolute; top: 12px; right: 12px; display: flex; gap: 8px; align-items: center;
  pointer-events: auto; z-index: 4;
}
.of-chip, .of-btn {
  border: 1px solid var(--line); border-radius: 9px; padding: 5px 12px;
  background: color-mix(in srgb, var(--panel) 88%, transparent); color: var(--ink);
  font: 600 12px/1 -apple-system,"PingFang SC",sans-serif; cursor: pointer;
  backdrop-filter: blur(4px);
}
.of-chip { cursor: default; }
.of-btn:hover { border-color: var(--accent); color: var(--accent); }
.of-hint {
  position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%);
  padding: 4px 14px; border-radius: 999px; font-size: 12px; color: var(--muted);
  background: color-mix(in srgb, var(--panel) 78%, transparent);
  border: 1px solid var(--line); white-space: nowrap; pointer-events: none; z-index: 4;
}
.of-queue {
  position: absolute; bottom: 10px; left: 12px; padding: 4px 12px; border-radius: 999px;
  font-size: 12px; color: var(--warn); border: 1px dashed var(--warn); z-index: 4;
  background: color-mix(in srgb, var(--panel) 78%, transparent);
}
.of-empty {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  flex-direction: column; gap: 8px; z-index: 3; pointer-events: none;
  color: var(--ink); text-align: center;
}
.of-empty .card { background: var(--panel); border: 1px dashed var(--line); padding: 22px 30px; border-radius: 12px; box-shadow: var(--shadow); }
.of-pop {
  position: absolute; top: 52px; right: 12px; width: 264px; z-index: 5;
  background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
  padding: 12px 14px; box-shadow: var(--shadow-lift);
  display: flex; flex-direction: column; gap: 8px;
}
.of-pop .head { display: flex; align-items: center; gap: 8px; }
.of-pop .head .face { width: 30px; height: 30px; border-radius: 50%; flex: none; border: 2px solid var(--pc, var(--line)); overflow: hidden; }
.of-pop .head .face svg { width: 100%; height: 100%; display: block; }
.of-pop .head b { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.of-pop .line { font-size: 13px; overflow-wrap: anywhere; color: var(--ink); }
.of-pop .sub { font-size: 12px; color: var(--muted); }
.of-pop .close {
  border: none; background: none; color: var(--muted); cursor: pointer; font-size: 14px; padding: 0 2px;
}
.of-pop .close:hover { color: var(--bad); }
.of-badge { font-size: 12px; padding: 2px 10px; border-radius: 999px; border: 1px solid var(--line); }
.of-badge-w { color: var(--pc, var(--accent)); border-color: var(--pc, var(--accent)); }
.of-badge-i { color: var(--st-idle); border-color: var(--st-idle); }
.of-badge-o { color: var(--st-offline); border-color: var(--st-offline); }
.of-err { position: absolute; top: 12px; left: 12px; z-index: 5; }
`;

export function ensurePageStyle() {
  if (typeof document === 'undefined' || document.getElementById('wao-ui-office3d-style') != null) return;
  const el = document.createElement('style');
  el.id = 'wao-ui-office3d-style';
  el.textContent = CSS;
  document.head.appendChild(el);
}

// latest timeline row per bot → screen ticker feed (rows arrive oldest-first)
const groupTimeline = (rows) => {
  const map = new Map();
  for (const r of rows ?? []) {
    if (!r?.botId) continue;
    map.set(r.botId, { text: r.text || '', color: KIND_TICK[r.kind] || '#7ce3a4' });
  }
  return map;
};

const STATUS_LABEL = { working: '工作中', idle: '待命', offline: '休假' };
// This repo's /api/agents carries no `connected` flag — status alone is
// authoritative; anything not working/idle reads as offline (休假).
const isOff = (a) => a.status !== 'working' && a.status !== 'idle';

export default {
  id: 'office3d',
  title: '办公室',
  icon: '🏢',
  order: 2,
  component({ WAO }) {
    // useRef isn't on the WAO hook surface — pull it from the shared React
    // instance (same single copy the shell/stub mounts, so refs stay legal).
    const { h, useState, useEffect, useAgents, useTimeline, React, avatar, avatarUrl } = WAO;
    const useRef = React.useRef;
    ensurePageStyle();
    const { agents, error } = useAgents();
    const { rows } = useTimeline(null, 30);
    const [dim, setDim] = useState(() => (typeof location !== 'undefined'
      && new URLSearchParams(location.search).get('dim') === '2d') ? '2d' : '3d');
    const [sel, setSel] = useState(null);
    const canvasRef = useRef(null);
    const tagsRef = useRef(null);
    const phaseRef = useRef(null);
    const sceneRef = useRef(null);
    const tagMap = useRef(new Map());
    const agentsRef = useRef(agents); agentsRef.current = agents ?? [];
    const selRef = useRef(null);
    selRef.current = sel;
    const hasAvatar = typeof avatarUrl === 'function';

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const params = new URLSearchParams(location.search);
      const scene = new OfficeScene(canvas, {
        dim: params.get('dim') === '2d' ? '2d' : '3d',
        phaseLock: ['day', 'dawn', 'dusk', 'night'].includes(params.get('phase')) ? params.get('phase') : null,
        dark: globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false,
        avatarUrl: hasAvatar ? (id) => avatarUrl(id, { size: 64 }) : null,
        onPick: (id) => setSel((cur) => (cur === id ? null : id)),
        onFrame: (anchors, info) => {
          const layer = tagsRef.current;
          if (layer) {
            const seen = new Set();
            for (const an of anchors) {
              seen.add(an.key);
              let el = tagMap.current.get(an.key);
              const a = agentsRef.current.find((x) => x.id === an.key) || {};
              const st = a.status === 'working' ? 'work' : isOff(a) ? 'off' : 'idle';
              if (!el) {
                el = document.createElement('button');
                el.type = 'button';
                el.className = 'of-tag';
                const d = document.createElement('i'); d.className = 'd';
                const sp = document.createElement('span');
                el.appendChild(d); el.appendChild(sp);
                if (hasAvatar) {
                  const face = document.createElement('span');
                  face.className = 'face';
                  face.innerHTML = avatar(an.key, { size: 36 });
                  el.insertBefore(face, d);
                }
                el.addEventListener('click', () => setSel((cur) => (cur === an.key ? null : an.key)));
                layer.appendChild(el);
                tagMap.current.set(an.key, el);
              }
              if (el.dataset.st !== st || el.dataset.name !== (a.name ?? an.key)) {
                el.dataset.st = st;
                el.dataset.name = a.name ?? an.key;
                const label = el.lastChild;
                if (label.nodeType === 3 || label.tagName === 'SPAN') label.textContent = shortTxt(a.name || an.key, 12);
                el.style.setProperty('--pc', providerOf(a.provider).color);
              }
              const lift = st === 'work' ? 40 : 0;
              el.style.transform = `translate(${Math.round(an.x)}px, ${Math.round(an.y - lift - 4)}px) translate(-50%, -100%)`;
            }
            for (const [k, el] of tagMap.current) if (!seen.has(k)) { el.remove(); tagMap.current.delete(k); }
          }
          if (phaseRef.current && phaseRef.current.dataset.ph !== info.phase) {
            phaseRef.current.dataset.ph = info.phase;
            phaseRef.current.textContent = { day: '☀ 白昼', dawn: '🌅 清晨', dusk: '🌆 黄昏', night: '🌙 夜晚' }[info.phase] ?? info.phase;
          }
        },
      });
      sceneRef.current = scene;
      // deterministic camera for screenshots: ?zoom=2.6 centers the room at a
      // fixed zoom (same spirit as ?phase/?dim harness knobs)
      const zoom = Number(params.get('zoom'));
      if (Number.isFinite(zoom) && zoom >= 1 && zoom <= 3.5) scene.cam.z = zoom;
      scene.setAgents(agentsRef.current);
      scene.setScreens(groupTimeline(rows));
      const ro = new ResizeObserver(() => scene.resize());
      ro.observe(canvas);
      scene.start();
      const onKey = (e) => { if (e.key === '0' || e.key === 'Home') scene.resetCam(); };
      document.addEventListener('keydown', onKey);
      const mq = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
      const onScheme = (e) => scene.setDark(e.matches);
      mq?.addEventListener?.('change', onScheme);
      // idle workers occasionally change lounge venue — keeps the room alive
      let tick = 0;
      const stroll = setInterval(() => {
        tick++;
        scene.setAgents(agentsRef.current, {
          reshuffle: (w) => w.kind === 'act' && ofSeed(w.key + ':' + tick) % 3 === 0,
        });
      }, 15_000);
      return () => {
        scene.stop(); ro.disconnect();
        document.removeEventListener('keydown', onKey);
        mq?.removeEventListener?.('change', onScheme);
        clearInterval(stroll);
        for (const [, el] of tagMap.current) el.remove();
        tagMap.current.clear();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
      const scene = sceneRef.current;
      if (!scene) return;
      scene.setAgents(agents ?? []);
      scene.setScreens(groupTimeline(rows));
      scene.selected = sel ?? null;
    }, [agents, rows, sel]);

    useEffect(() => { sceneRef.current?.setDim(dim); }, [dim]);

    const selAgent = (agents ?? []).find((a) => a.id === sel);
    const overflow = Math.max(0, (agents ?? []).filter((a) => a.status === 'working').length - DESKS.length);
    return h('div', { className: 'of-stage' },
      h('canvas', { ref: canvasRef }),
      h('div', { className: 'of-otags', ref: tagsRef }),
      error != null ? h('div', { className: 'error of-err' }, `加载同事列表失败：${error}`) : null,
      h('div', { className: 'of-hud' },
        h('span', { className: 'of-chip', ref: phaseRef }, '…'),
        h('button', {
          className: 'of-btn',
          onClick: () => setDim((d) => (d === '3d' ? '2d' : '3d')),
        }, dim === '3d' ? '◧ 切换平面' : '⬚ 切换立体')),
      (agents ?? []).length === 0 && error == null
        ? h('div', { className: 'of-empty' },
            h('div', { className: 'card' },
              h('p', null, '空的办公室——第一位同事入职后就会搬进来'),
              h('p', { className: 'muted' }, '去人事部办理入职，它将从门口走到自己的工位'))) : null,
      overflow > 0
        ? h('div', { className: 'of-queue' }, `ⓘ 工位共 ${DESKS.length} 个，${overflow} 位工作中的同事在门口排队/室内走动`) : null,
      h('div', { className: 'of-hint' }, '拖拽平移 · 滚轮缩放 · 按 0 复位 · 点小人看工作汇报'),
      selAgent ? (() => {
        const off = isOff(selAgent);
        const cls = selAgent.status === 'working' ? 'of-badge-w' : off ? 'of-badge-o' : 'of-badge-i';
        const pv = providerOf(selAgent.provider);
        return h('aside', { className: 'of-pop', style: { '--pc': pv.color } },
          h('div', { className: 'head' },
            hasAvatar ? h('span', {
              className: 'face',
              dangerouslySetInnerHTML: { __html: avatar(selAgent.id, { size: 30, mood: off ? 'sleep' : 'neutral' }) },
            }) : null,
            h('b', null, selAgent.name || selAgent.id),
            h('span', { className: 'badge of-badge ' + cls, title: `状态：${selAgent.status ?? 'offline'}${selAgent.reason ? `\n原因：${selAgent.reason}` : ''}` },
              STATUS_LABEL[selAgent.status] ?? selAgent.status),
            h('button', { className: 'close', onClick: () => setSel(null) }, '✕')),
          selAgent.progress?.line
            ? h('div', { className: 'line', title: '工作汇报（实时进度行）' }, selAgent.progress.line)
            : h('div', { className: 'sub' }, off && selAgent.reason ? `离岗原因：${selAgent.reason}` : '手上暂无进行中的工单'),
          selAgent.progress?.startedAt
            ? h('div', { className: 'sub' }, '⏱ 已进行 ' + elapsed(Date.now() - selAgent.progress.startedAt)) : null,
          h('div', { className: 'sub' }, `今日工单 ${selAgent.todayTurns ?? 0} · 服务同事 ${selAgent.users ?? 0} · 档案 ${selAgent.chats ?? 0}`),
          h('div', { className: 'sub' }, `${pv.label ?? selAgent.provider ?? '?'} · ${selAgent.id}`));
      })() : null,
    );
  },
};
