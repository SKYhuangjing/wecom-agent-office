// 办公室 3D v2 (M3 T4) — the visual layer over the ported ofscene engine.
//
// 视觉重做 (the v1 art was deliberately NOT carried over): a calmer, layered
// palette with light/dark UI variants (canvas can't read CSS vars mid-frame,
// so two JS palettes follow prefers-color-scheme instead — see PAL/SURF and
// OfficeScene.setDark), sun/moon + window shafts + night lamp pools for the
// day phase lighting, a rug + whiteboard + wall clock + door for room depth,
// per-provider desk plaques & shirts (dsh indigo bolt / claude coral asterisk
// / codex green brackets), monitors that ticker each bot's latest timeline
// event, floating task cards driven by progress.line, and DOM nameplates
// riding canvas heads via onFrame anchors. Layout GEOMETRY (desks/sofa/
// venues/blockers) is the ported,穿模-free arrangement from v1 — engine
// mechanics and walkable furniture positions are inherited, only repaint.
//
// Page contract: no build, no JSX, SDK from window.WAO; imports stay inside
// this ui/ directory. Harness params: ?dim=2d, ?phase=day|dawn|dusk|night.
import { OfScene, buildNav, ofShade, ofMix, ofSeed, ofHue, PHASE_LOCK_MID } from './ofscene.js';

// —— layout (ported coordinates — proven collision-free) —————————————————
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
  { id: 'bookshelf', label: '📖 书架', x: 1.45, y: 0.5, w: 1.6, d: 0.55, ax: 2.25, ay: 1.65, face: 'n', lz: 2.4, color: '#d9a96a' },
  { id: 'pingpong', label: '🏓 乒乓', x: 9.55, y: 7.15, w: 1.9, d: 1.05, ax: 10.5, ay: 8.85, face: 'n', lz: 1.15, color: '#4ecb9a' },
  { id: 'coffee', label: '☕ 咖啡', x: 14.35, y: 2.15, w: 1.35, d: 0.85, ax: 14.9, ay: 3.4, face: 'n', lz: 1.55, color: '#f0a35e' },
];
const NAP = [[13.0, 9.9], [14.5, 9.3], [12.6, 10.6]]; // offline bots lie here
const WANDER = [[7.0, 4.4], [8.6, 5.7], [6.0, 5.8], [9.0, 8.0], [4.9, 4.8], [5.0, 3.4], [2.4, 6.0]];
const QUEUE = [[1.0, 2.0, 'e'], [1.7, 2.0, 'e'], [1.0, 3.1, 'e'], [1.7, 3.1, 'e']]; // >8 working: stand by the door
const DOOR = [0.6, 2.6];
const BLOCKERS = [
  ...ACTS.map((a) => [a.x, a.y, a.w, a.d]),
  ...DESKS.map((d) => [d.x, d.y, d.w, d.d]),
  [0, 4.1, 1.5, 5.0],   // west sofa run
  [2.5, 10.55, 2.4, 1.45], // south sofa pair
  [12.4, 9.2, 1.5, 1.7],   // nap corner rug/dog bed
  [14.9, 4.6, 0.7, 0.7],   // plant
];

const NAV = buildNav({
  W: ROOM.W, D: ROOM.D, cell: 0.3, radius: 0.17, wallPad: 0.42,
  blockers: BLOCKERS,
  frees: [...DESKS.map((d) => d.seat), ...SOFA_APPROACH, ...NAP, ...WANDER,
    ...ACTS.map((a) => [a.ax, a.ay]), DOOR, ...QUEUE.map(([x, y]) => [x, y])],
  docks: SOFA.map(([x, y], i) => ({ to: [x, y], via: SOFA_APPROACH[i] })),
});

// —— provider identities (克制配色: one hue + one mark each) ————————————
const PROVIDERS = {
  dsh: { color: '#4f6df5', mark: 'bolt' },
  claude: { color: '#d97757', mark: 'asterisk' },
  codex: { color: '#10a37f', mark: 'brackets' },
};
const providerOf = (p) => PROVIDERS[p] ?? { color: '#64748b', mark: 'diamond' };

// timeline kind → ticker hue (same coding as the workbench timeline page)
const KIND_TICK = {
  run_start: '#7fb3ff', step: '#9aa7b8', tool: '#c9a4ff', thinking: '#7fd9e8',
  turn: '#7ce3a4', run_end: '#8fa0b5',
};

// —— palettes ———————————————————————————————————————————————————————————
// PHASE-VARYING colors keyed by phase, per UI mode. Entries are hex strings
// (lerped with ofMix) or [hex, alpha] pairs. Night in dark mode stays
// contrasted (deep blues, not blacks) so the scene never 糊成一片.
const PAL = {
  light: {
    sky: { night: ['#1c2440', '#3b4a74'], dawn: ['#5a5178', '#d9a184'], day: ['#a5c8ea', '#eef1f4'], dusk: ['#523f63', '#d18a6d'] },
    star: { night: 0.85, dawn: 0.3, day: 0, dusk: 0.4 },
    glass: { night: ['#9db4e8', 0.5], dawn: ['#eab488', 0.6], day: ['#d6eafc', 0.85], dusk: ['#eaa4b2', 0.6] },
    amb: { night: ['#1a2650', 0.26], dawn: ['#ff9d6e', 0.08], day: ['#fff8ec', 0.04], dusk: ['#f08a64', 0.10] },
    shaft: { night: 0, dawn: 0.05, day: 0.12, dusk: 0.06 },
    lamp: { night: 0.16, dawn: 0.07, day: 0, dusk: 0.09 },
    ink: { night: '#e9eef8', dawn: '#3a2f3f', day: '#3c4658', dusk: '#463250' },
  },
  dark: {
    sky: { night: ['#05070f', '#0e1526'], dawn: ['#171628', '#3a2438'], day: ['#0f1d30', '#1f3a5c'], dusk: ['#20122b', '#43233e'] },
    star: { night: 1, dawn: 0.35, day: 0.06, dusk: 0.45 },
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
    floor: ['#dcc7a6', '#d1bb97'], plank: 'rgba(110,78,44,.22)', seam: 'rgba(120,88,52,.30)',
    wallL: '#e9e4d9', wallR: '#ddd7cb', wallEdge: '#b6afa0', base: 'rgba(70,60,45,.30)',
    rug: 'rgba(206,222,216,.8)', rugEdge: 'rgba(105,138,130,.55)',
    desk: '#c99a68', deskLeg: '#48525f', chair: '#46536b', chairSeat: '#5b6d8f',
    sofa: '#45777e', sofaSeat: '#578e96', sofaArm: '#3b686e', pillow: '#d9a066',
    shelf: '#8a5f3c', books: ['#b56a5e', '#5f87ac', '#c2a35e', '#7fae7d', '#a07fb0'],
    counter: '#6f5138', machine: '#39424e',
    plant: '#4d9455', pot: '#b06a4a',
    board: '#f4f2ec', boardFrame: '#8d867a',
    clockFace: '#f8f7f3', clockRim: '#5a5348',
    door: '#a97c50', doorFrame: '#8d643c',
    screenOff: '#232c39', screenIdle: '#16212c',
    shadow: 'rgba(30,25,15,.25)',
  },
  dark: {
    floor: ['#8a7157', '#7f684f'], plank: 'rgba(20,14,8,.30)', seam: 'rgba(15,10,6,.38)',
    wallL: '#39404f', wallR: '#313847', wallEdge: '#4d5769', base: 'rgba(5,8,15,.5)',
    rug: 'rgba(56,74,74,.55)', rugEdge: 'rgba(110,150,145,.35)',
    desk: '#9a7048', deskLeg: '#333c48', chair: '#374359', chairSeat: '#42536f',
    sofa: '#31565c', sofaSeat: '#3d6a72', sofaArm: '#2a4b50', pillow: '#a97a4e',
    shelf: '#6b4a2e', books: ['#8d5049', '#48698a', '#967f49', '#5f8a63', '#7a5f8a'],
    counter: '#57402e', machine: '#2c343f',
    plant: '#3c7247', pot: '#8d543c',
    board: '#c9cdd4', boardFrame: '#5d6675',
    clockFace: '#d9dde3', clockRim: '#454e5c',
    door: '#7d5b3a', doorFrame: '#64492c',
    screenOff: '#171e28', screenIdle: '#101a24',
    shadow: 'rgba(0,0,0,.4)',
  },
};
// Worker appearance pools (ported idea: derive from botId hash)
const SKIN = ['#f2c7a5', '#e8b48a', '#c98d62', '#8d5a3b', '#f5d6bf'];
const HAIR = ['#2b2118', '#5a3825', '#a0522d', '#1f2937', '#d4a24c', '#7c2d12', '#111111', '#c2410c'];
const PANTS = ['#334155', '#1e3a8a', '#374151', '#3f3f46', '#78350f'];

const lerpEntry = (entry, ph) => {
  const A = entry[ph.a], B = entry[ph.b];
  if (Array.isArray(A)) return [ofMix(A[0], B[0], ph.mix), A[1] + (B[1] - A[1]) * ph.mix];
  if (typeof A === 'number') return A + (B - A) * ph.mix;
  return ofMix(A, B, ph.mix);
};

const roundRect = (g, x, y, w, h, r) => {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
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

// —— the scene: OfScene engine + this office's paint hooks ——————————————
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
        makeWorker: (a, seed) => ({
          skin: SKIN[seed % SKIN.length],
          hair: HAIR[(seed >>> 5) % HAIR.length],
          pants: PANTS[(seed >>> 9) % PANTS.length],
          long: (seed >>> 13) % 3 === 0,
          shirt: providerOf(a.provider).color,
        }),
      },
    });
    this.dark = opts.dark ?? false;
    this.screens = new Map(); // botId → {text, color} latest timeline event
  }
  setDark(d) { this.dark = !!d; }
  setScreens(map) { this.screens = map instanceof Map ? map : new Map(); }
  pal() { return PAL[this.dark ? 'dark' : 'light']; }
  surf() { return SURF[this.dark ? 'dark' : 'light']; }

  // —— backdrop: sky gradient + stars + sun/moon (new vs port) —————————
  paint(ph) {
    this.paintSky(ph);
    this.paintFloor();
    this.paintShafts(ph);
    this.paintLamps(ph);
    this.paintWalls(ph);
  }
  paintSky(ph) {
    const g = this.g, pal = this.pal();
    const S = pal.sky;
    const top = ofMix(S[ph.a][0], S[ph.b][0], ph.mix);
    const bot = ofMix(S[ph.a][1], S[ph.b][1], ph.mix);
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
        g.fillRect(x, y, 1.4, 1.4);
      }
      g.globalAlpha = 1;
    }
    this.paintSunMoon(ph);
  }
  paintSunMoon(ph) {
    const g = this.g;
    // same clock phaseInfo() reports — read the engine's table, never a copy
    const c = this.phaseLock != null ? PHASE_LOCK_MID[this.phaseLock] : this.clock;
    const dayness = ph.phase === 'day' ? 1 : ph.phase === 'night' ? 0 : 0.5;
    if (dayness > 0.15) { // sun rides an arc across the day band
      const t = Math.min(1, Math.max(0, (c - 0.25) / 0.5));
      const x = this.W * (0.12 + 0.76 * t);
      const y = this.H * (0.34 - 0.22 * Math.sin(Math.PI * t));
      const r = Math.max(10, this.H * 0.03);
      const glow = g.createRadialGradient(x, y, 0, x, y, r * 5);
      glow.addColorStop(0, 'rgba(255,236,180,.55)');
      glow.addColorStop(1, 'rgba(255,236,180,0)');
      g.fillStyle = glow; g.fillRect(x - r * 5, y - r * 5, r * 10, r * 10);
      g.fillStyle = '#ffe9a8';
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    if (dayness < 0.85) { // moon in the complementary arc
      const t = c > 0.75 ? (c - 0.75) / 0.5 : (c + 0.25) / 0.5;
      const x = this.W * (0.16 + 0.68 * t);
      const y = this.H * (0.30 - 0.2 * Math.sin(Math.PI * t));
      const r = Math.max(7, this.H * 0.022);
      g.fillStyle = 'rgba(226,233,248,.9)';
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      g.fillStyle = ofMix(ofMix('#05070f', '#1f3a5c', 0.5), '#0b1020', 0.4);
      g.beginPath(); g.arc(x + r * 0.38, y - r * 0.22, r * 0.86, 0, Math.PI * 2); g.fill();
    }
  }
  // —— floor: planks + a lounge rug (repainted) ————————————————————————
  paintFloor() {
    const s = this.surf();
    for (let j = 0; j < ROOM.D; j += 0.5) {
      this.poly([this.P(0, j), this.P(ROOM.W, j), this.P(ROOM.W, j + 0.5), this.P(0, j + 0.5)],
        s.floor[Math.round(j * 2) % 2], s.plank, 0.6);
    }
    this.g.strokeStyle = s.seam; this.g.lineWidth = 0.6;
    for (let i = 0.5; i < ROOM.W; i += 0.5) {
      for (let j = 0; j < ROOM.D; j += 1) {
        const off = Math.round(j) % 2 ? 0.25 : 0;
        const a = this.P(i + off, j), b = this.P(i + off, j + 1);
        this.g.beginPath(); this.g.moveTo(a[0], a[1]); this.g.lineTo(b[0], b[1]); this.g.stroke();
      }
    }
    // lounge rug under the sofa corner + ping-pong area
    this.poly([this.P(2.2, 9.7), this.P(6.4, 9.7), this.P(6.4, 11.7), this.P(2.2, 11.7)],
      s.rug, s.rugEdge, 1.2);
    this.poly([this.P(2.55, 10.05), this.P(6.05, 10.05), this.P(6.05, 11.35), this.P(2.55, 11.35)],
      null, s.rugEdge, 0.8);
  }
  paintShafts(ph) {
    const a = lerpEntry(this.pal().shaft, ph);
    if (a < 0.02) return;
    for (const [t0, t1] of [[0.16, 0.36], [0.46, 0.66], [0.68, 0.82]]) {
      const x0 = t0 * ROOM.W + 0.1, x1 = t1 * ROOM.W - 0.1;
      this.poly([this.P(x0, 0.02, ROOM.WALL * 0.34), this.P(x1, 0.02, ROOM.WALL * 0.34),
        this.P(x1 + 1.1, 3.1, 0), this.P(x0 + 1.1, 3.1, 0)], `rgba(255,243,205,${a})`);
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
      grd.addColorStop(0, `rgba(246,178,107,${a})`);
      grd.addColorStop(1, 'rgba(246,178,107,0)');
      g.fillStyle = grd;
      g.fillRect(px - r, py - r, r * 2, r * 2);
    }
  }
  // —— walls: two-tone + wainscot, windows, door, clock, whiteboard ————
  paintWalls(ph) {
    const g = this.g, s = this.surf(), W = ROOM.WALL;
    this.poly([this.P(0, 0), this.P(0, ROOM.D), this.P(0, ROOM.D, W), this.P(0, 0, W)], s.wallL, s.wallEdge, 1.2);
    this.poly([this.P(0, 0), this.P(ROOM.W, 0), this.P(ROOM.W, 0, W), this.P(0, 0, W)], s.wallR, s.wallEdge, 1.2);
    // wainscot line + baseboard
    g.strokeStyle = s.wallEdge; g.lineWidth = 1;
    for (const [a, b] of [[this.P(0, 0, 0.95), this.P(0, ROOM.D, 0.95)], [this.P(0, 0, 0.95), this.P(ROOM.W, 0, 0.95)]]) {
      g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
    }
    // windows on the back wall (y=0), glass tinted by phase; the third is
    // narrower and stops clear of the whiteboard (13.4+) on the same wall
    const glass = lerpEntry(this.pal().glass, ph);
    const [gr, gg2, gb] = hexRgb(glass[0]);
    const glassFill = `rgba(${gr},${gg2},${gb},${glass[1]})`;
    for (const [t0, t1] of [[0.16, 0.36], [0.46, 0.66], [0.68, 0.82]]) {
      const x0 = t0 * ROOM.W, x1 = t1 * ROOM.W;
      this.poly([this.P(x0, 0.01, W * 0.34), this.P(x1, 0.01, W * 0.34), this.P(x1, 0.01, W * 0.8), this.P(x0, 0.01, W * 0.8)],
        glassFill, s.wallEdge, 1.4);
      const mid = this.P((x0 + x1) / 2, 0.01, W * 0.57);
      g.strokeStyle = s.wallEdge; g.lineWidth = 1.4;
      g.beginPath();
      g.moveTo(mid[0], mid[1] - W * 0.23 * this.s);
      g.lineTo(mid[0], mid[1] + W * 0.23 * this.s);
      g.stroke();
    }
    // door on the west wall (where new workers walk in)
    this.poly([this.P(0.01, 2.0, 0), this.P(0.01, 3.2, 0), this.P(0.01, 3.2, 2.2), this.P(0.01, 2.0, 2.2)], s.doorFrame);
    this.poly([this.P(0.015, 2.08, 0.06), this.P(0.015, 3.12, 0.06), this.P(0.015, 3.12, 2.12), this.P(0.015, 2.08, 2.12)], s.door);
    const knob = this.P(0.02, 2.24, 1.05);
    g.fillStyle = '#e8c14d'; g.beginPath(); g.arc(knob[0], knob[1], Math.max(1.5, this.s * 0.045), 0, Math.PI * 2); g.fill();
    // exit sign above the door
    this.poly([this.P(0.02, 2.42, 2.32), this.P(0.02, 2.78, 2.32), this.P(0.02, 2.78, 2.52), this.P(0.02, 2.42, 2.52)], 'rgba(22,101,52,.9)');
    // wall clock (back wall center) — real local time
    this.wallClock();
    // whiteboard (back wall, right side, above the coffee corner)
    this.whiteboard();
    // baseboard shadow at the wall/floor seam
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
    g.fillStyle = s.clockRim; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
    g.fillStyle = s.clockFace; g.beginPath(); g.arc(cx, cy, r * 0.86, 0, Math.PI * 2); g.fill();
    const d = new Date();
    const hand = (frac, len, wid, color) => {
      const a = frac * Math.PI * 2;
      g.strokeStyle = color; g.lineWidth = wid; g.lineCap = 'round';
      g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.sin(a) * r * len, cy - Math.cos(a) * r * len); g.stroke();
    };
    hand(((d.getHours() % 12) + d.getMinutes() / 60) / 12, 0.5, Math.max(1.2, r * 0.09), '#3a4250');
    hand(d.getMinutes() / 60, 0.74, Math.max(1, r * 0.07), '#3a4250');
    g.fillStyle = '#d9534f'; g.beginPath(); g.arc(cx, cy, Math.max(1, r * 0.06), 0, Math.PI * 2); g.fill();
  }
  whiteboard() {
    const g = this.g, s = this.surf();
    this.poly([this.P(13.4, 0.02, 1.5), this.P(15.4, 0.02, 1.5), this.P(15.4, 0.02, 2.62), this.P(13.4, 0.02, 2.62)], s.boardFrame);
    this.poly([this.P(13.48, 0.025, 1.58), this.P(15.32, 0.025, 1.58), this.P(15.32, 0.025, 2.54), this.P(13.48, 0.025, 2.54)], s.board);
    // scribbles: a trend line and a tiny bar chart — a workplace that thinks
    const p = (x, z) => this.P(13.4 + x, 0.03, 1.75 + z);
    g.strokeStyle = '#4f6df5'; g.lineWidth = 1.6; g.beginPath();
    let q = p(0, 0); g.moveTo(q[0], q[1]);
    for (const [x, z] of [[0.35, 0.18], [0.7, 0.05], [1.05, 0.3], [1.4, 0.5]]) { q = p(x, z); g.lineTo(q[0], q[1]); }
    g.stroke();
    g.strokeStyle = '#d97757'; g.lineWidth = 1.2; g.beginPath();
    q = p(0, 0.42); g.moveTo(q[0], q[1]); q = p(1.4, 0.2); g.lineTo(q[0], q[1]); g.stroke();
    const bars = ['#10a37f', '#4f6df5', '#d9a066'];
    for (let i = 0; i < 3; i++) {
      const b0 = p(0.1 + i * 0.22, 0), b1 = p(0.1 + i * 0.22, 0.1 + i * 0.05), b2 = p(0.2 + i * 0.22, 0), b3 = p(0.2 + i * 0.22, 0.1 + i * 0.05);
      this.poly([b0, b2, b3, b1], bars[i]);
    }
  }

  // —— furniture + workers, depth-ordered ———————————————————————————————
  collect() {
    const out = [];
    const add = (x, y, fn) => out.push({ k: this.depth(x, y), fn: fn.bind(this) });
    DESKS.forEach((d, i) => add(d.x + d.w, d.y + d.d, () => this.desk(d, i)));
    add(3.7, 11.7, () => { // south sofa pair (seated workers drawn into it)
      const s = this.surf();
      for (let i = 0; i < 2; i++) {
        const x = 2.5 + i * 1.2;
        this.sofaUnit(x, 11.35, 1.2, 0.35, x, 10.55, 'n', s);
      }
      this.seatedWorkers(1);
    });
    add(1.1, 9.1, () => { // west sofa run
      const s = this.surf();
      for (let i = 0; i < 5; i++) this.sofaUnit(0.35, 4.4 + i * 0.88, 0.4, 0.88, 0.7, 4.4 + i * 0.88, 'e', s);
      this.box(0.7, 4.1, 0, 0.8, 0.3, 0.7, this.surf().sofaArm);
      this.box(0.7, 8.8, 0, 0.8, 0.3, 0.7, this.surf().sofaArm);
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
    add(9.2, 2.1, () => this.plant(9.0, 1.95, 0.36, 0.6)); // desk row end plant
    // nap corner: a dog bed under the sleeping bots
    add(13.7, 10.2, () => {
      const s = this.surf();
      this.poly([this.P(12.3, 9.1), this.P(15.4, 9.1), this.P(15.4, 11.2), this.P(12.3, 11.2)],
        this.dark ? 'rgba(90,70,60,.5)' : 'rgba(196,170,150,.65)', 'rgba(80,60,45,.4)', 1);
      const napping = [...this.workers.values()].filter((w) => w.kind === 'nap')
        .sort((a, b) => this.depth(a.x, a.y) - this.depth(b.x, b.y));
      for (const w of napping) this.worker(w);
    });
    // free-roaming workers sorted with furniture
    for (const w of this.workers.values()) {
      if (this.sofaGroup(w) >= 0 || w.kind === 'nap') continue;
      const sits = !w.walking && (w.kind === 'seat' || this.sofaSlot(w) >= 0);
      out.push({ k: this.depth(w.x, w.y + (sits ? 0.34 : 0)) + 0.02, fn: () => this.worker(w) });
    }
    return out;
  }
  // One sofa unit = backrest shell + seat cushion. (x,y,w,d) is the
  // backrest rect; (cx,cy) is the cushion origin — the cushion extends 0.8
  // toward the sitter from it (v1 geometry: south cushions sit at y=10.55 in
  // front of the y=11.35 backrest; west cushions at x=0.7 east of the x=0.35
  // backrest). Params were originally mis-wired (dead bx/by) — T4 review fix.
  sofaUnit(x, y, w, d, cx, cy, face, s) {
    this.box(x, y, 0, w, d, 0.95, s.sofaArm); // backrest against the wall
    if (face === 'e') this.box(cx, cy, 0, 0.8, d, 0.42, s.sofaSeat);
    else this.box(cx, cy, 0, w, 0.8, 0.42, s.sofaSeat);
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
    // chair (seat + backrest), oriented toward the desk
    this.box(d.seat[0] - 0.28, d.seat[1] - 0.22, 0, 0.56, 0.12, 0.52, s.chair);
    this.box(d.seat[0] - 0.3, d.seat[1] - (d.face === 'n' ? 0.34 : -0.12), 0.4, 0.6, 0.12, 0.5, ofShade(s.chair, -0.15));
    // legs + top
    for (const [lx, ly] of [[0.06, 0.06], [d.w - 0.16, 0.06], [0.06, d.d - 0.16], [d.w - 0.16, d.d - 0.16]]) {
      this.box(d.x + lx, d.y + ly, 0, 0.1, 0.1, 0.68, s.deskLeg, { line: false });
    }
    this.box(d.x, d.y, 0.68, d.w, d.d, 0.08, s.desk);
    // monitor + stand; the panel faces the sitter
    const mx = d.x + d.w / 2 - 0.55, my = d.y + d.d / 2 - 0.34;
    this.box(d.x + d.w / 2 - 0.06, d.y + d.d / 2 - 0.05, 0.76, 0.12, 0.12, 0.14, s.machine, { line: false });
    this.box(mx, my, 0.9, 1.1, 0.68, 0.06, ofShade(s.machine, -0.1));
    this.screen(d, i, w, a);
    // keyboard toward the sitter + a mug
    const ky = d.face === 'n' ? d.y + d.d - 0.3 : d.y + 0.12;
    this.box(d.x + d.w / 2 - 0.28, ky, 0.76, 0.56, 0.17, 0.035, '#2c343f', { line: false });
    this.onFront(d.x + d.w / 2 - 0.28, ky - 0.01, 0.76, 0.56, 0.17, 0.035, 0.12, 0.5, 0.88, 0.62, 'rgba(160,175,195,.5)');
    this.box(d.x + d.w - 0.24, d.y + d.d / 2 + 0.08, 0.76, 0.1, 0.1, 0.12, a?.status === 'working' ? '#e8c14d' : '#b06a4a', { line: false });
    // provider plaque standing at the desk's left
    this.plaque(d, a);
  }
  // monitor screen: lit ticker for working bots, standby mark for idle,
  // dark glass when offline/empty
  screen(d, i, w, a) {
    const s = this.surf();
    const mx = d.x + d.w / 2 - 0.55;
    const my = d.y + d.d / 2 - 0.34;
    const south = d.face !== 's'; // panel faces the sitter
    const yPlane = south ? my + 0.68 : my - 0.005;
    const quad = [this.P(mx + 0.05, yPlane, 0.97), this.P(mx + 1.05, yPlane, 0.97),
      this.P(mx + 1.05, yPlane, 1.5), this.P(mx + 0.05, yPlane, 1.5)];
    const working = a?.status === 'working';
    const feed = w != null ? this.screens.get(w.key) : null;
    const body = working ? '#12291d' : a ? s.screenIdle : s.screenOff;
    this.poly(quad, body, working ? 'rgba(140,240,180,.4)' : 'rgba(255,255,255,.08)', 1);
    const g = this.g;
    g.save();
    g.beginPath();
    quad.forEach(([x, y], idx) => (idx ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    g.clip();
    const qh = Math.hypot(quad[3][0] - quad[0][0], quad[3][1] - quad[0][1]);
    if (working) {
      // faint scanlines + a scrolling latest-event ticker
      g.fillStyle = 'rgba(120,230,170,.05)';
      for (let z = 0.1; z < 1; z += 0.22) {
        this.poly([this.P(mx + 0.05, yPlane, 0.97 + z), this.P(mx + 1.05, yPlane, 0.97 + z), this.P(mx + 1.05, yPlane, 0.97 + z + 0.05), this.P(mx + 0.05, yPlane, 0.97 + z + 0.05)], 'rgba(140,235,180,.06)');
      }
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
      // standby: provider mark breathing in the dark glass
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
    this.box(x, y, z, 0.36, 0.07, 0.3, pv.color);
    const south = d.face !== 's';
    const yPlane = south ? y + 0.07 : y - 0.005;
    const q = [this.P(x, yPlane, z + 0.03), this.P(x + 0.36, yPlane, z + 0.03), this.P(x + 0.36, yPlane, z + 0.27), this.P(x, yPlane, z + 0.27)];
    this.poly(q, ofShade(pv.color, 0.12));
    const cx = (q[0][0] + q[1][0]) / 2, cy = (q[0][1] + q[3][1]) / 2;
    const r = Math.max(2.4, this.s * 0.09);
    this.mark(pv.mark, cx, cy, r, 'rgba(255,255,255,.95)');
  }
  // provider marks drawn in pixel space (vector, not emoji — crisp at any zoom)
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
    this.box(bs.x, bs.y, 0, bs.w, bs.d, 2.1, s.shelf);
    for (let shelf = 0; shelf < 3; shelf++) {
      for (let k = 0; k < 5; k++) {
        this.onFront(bs.x, bs.y, 0.12 + shelf * 0.62, bs.w, bs.d, 2.1,
          0.06 + k * 0.18, 0.1, 0.06 + k * 0.18 + 0.14, 0.82, s.books[(k + shelf) % 5]);
      }
    }
  }
  cat() {
    // the shelf cat (ported beloved resident): pink blanket, cream body,
    // pacing + tail + blinking
    const bs = ACTS[0];
    const t = this.reduced ? 0 : this.t;
    const pace = 0.5 + 0.5 * Math.sin(t * 0.22);
    const x = bs.x + 0.34 + pace * (bs.w - 0.68);
    const y = bs.y + bs.d / 2;
    const z = 1.55;
    const awake = !this.reduced && Math.sin(t * 0.31) > -0.35;
    const tail = Math.sin(t * (awake ? 1.5 : 0.4));
    this.box(x - 0.27, y - 0.17, z - 0.03, 0.54, 0.34, 0.05, '#e8879e');
    this.box(x - 0.17, y - 0.1, z, 0.34, 0.2, 0.12, '#f2e3c8');
    this.box(x + 0.12, y - 0.07, z + 0.06, 0.17, 0.15, 0.13, '#f7ecd9');
    this.box(x - 0.12, y - 0.1, z + 0.1, 0.06, 0.2, 0.025, '#d99a4e', { line: false });
    this.box(x - 0.02, y - 0.1, z + 0.1, 0.05, 0.2, 0.025, '#d99a4e', { line: false });
    this.box(x - 0.28, y + 0.02 + tail * 0.04, z + 0.05, 0.13, 0.05, 0.05, '#d99a4e', { line: false });
    this.onFront(x + 0.12, y - 0.07, z + 0.06, 0.17, 0.15, 0.13, 0.2, awake ? 0.44 : 0.46, 0.36, awake ? 0.58 : 0.48, '#2a2320');
    this.onFront(x + 0.12, y - 0.07, z + 0.06, 0.17, 0.15, 0.13, 0.64, awake ? 0.44 : 0.46, 0.8, awake ? 0.58 : 0.48, '#2a2320');
  }
  pingpong(pp) {
    const s = this.surf();
    for (const [lx, ly] of [[0.1, 0.1], [pp.w - 0.18, 0.1], [0.1, pp.d - 0.18], [pp.w - 0.18, pp.d - 0.18]]) {
      this.box(pp.x + lx, pp.y + ly, 0, 0.1, 0.1, 0.66, s.machine, { line: false });
    }
    this.box(pp.x, pp.y, 0.66, pp.w, pp.d, 0.09, '#1f6e50');
    this.box(pp.x + 0.02, pp.y + 0.02, 0.75, pp.w - 0.04, pp.d - 0.04, 0.02, '#2e9a6d', { line: false });
    this.box(pp.x - 0.03, pp.y + pp.d / 2 - 0.03, 0.75, pp.w + 0.06, 0.06, 0.2, '#eef2f5');
    this.box(pp.x + 0.28, pp.y + 0.3, 0.78, 0.2, 0.14, 0.03, '#d9534f');
    this.box(pp.x + 1.42, pp.y + 0.62, 0.78, 0.2, 0.14, 0.03, '#3f6df5');
    const bt = this.reduced ? 0 : this.t;
    this.box(pp.x + 0.95 + Math.sin(bt * 2.1) * 0.3, pp.y + 0.42 + Math.cos(bt * 1.7) * 0.12, 0.8, 0.05, 0.05, 0.05, '#f5d76e', { line: false });
  }
  coffee(cof) {
    const s = this.surf();
    this.box(cof.x, cof.y, 0, cof.w, cof.d, 0.92, s.counter);
    this.box(cof.x + 0.04, cof.y + 0.04, 0.92, cof.w - 0.08, cof.d - 0.08, 0.06, ofShade(s.counter, 0.3));
    this.box(cof.x + 0.14, cof.y + 0.1, 0.98, 0.46, 0.34, 0.5, s.machine);
    this.box(cof.x + 0.2, cof.y + 0.1, 1.14, 0.34, 0.02, 0.2, '#e8874e', { line: false });
    for (let i = 0; i < 3; i++) this.box(cof.x + 0.86 + i * 0.14, cof.y + 0.34, 0.98, 0.09, 0.09, 0.13, ['#eef2f5', '#e8c14d', '#e8879e'][i], { line: false });
    this.box(cof.x + 0.06, cof.y + 0.02, 1.7, cof.w - 0.12, 0.16, 0.06, '#5a3e28');
    for (let i = 0; i < 4; i++) this.box(cof.x + 0.16 + i * 0.26, cof.y + 0.05, 1.76, 0.16, 0.12, 0.18, ['#c05a52', '#4a8a5c', '#c89040', '#4a6a9a'][i], { line: false });
    // steam over the machine (new: gentle ambience)
    if (!this.reduced) {
      const g = this.g;
      const [sx, sy] = this.P(cof.x + 0.37, cof.y + 0.28, 1.5);
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
    this.box(x, y, 0, size, size, size * 0.8, s.pot);
    const g = this.g;
    const [px, py] = this.P(x + size / 2, y + size / 2, size * 0.8 + h * 0.5);
    const sway = this.reduced ? 0 : Math.sin(this.t * 0.8 + x * 3) * 2;
    for (const [dx, dy, r] of [[-5, -2, size * this.s * 0.16], [5, -6, size * this.s * 0.14], [0, -12, size * this.s * 0.15]]) {
      g.fillStyle = dx < 0 ? s.plant : ofShade(s.plant, 0.18);
      g.beginPath(); g.arc(px + dx + sway, py + dy, Math.max(3, r), 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = ofShade(s.pot, -0.2);
    g.fillRect(px - size * this.s * 0.06, py + size * this.s * 0.1, size * this.s * 0.12, h * this.s * 0.3);
  }

  // —— worker art (ported poses, repainted + provider shirts) ———————————
  worker(w) {
    const t = this.t + w.phase;
    const a = w.a || {};
    const off = isOff(a);
    const shirt = off ? ofMix(w.shirt, '#6b7280', 0.55) : w.shirt;
    const pants = off ? ofMix(w.pants, '#6b7280', 0.4) : w.pants;
    const skin = off ? ofMix(w.skin, '#8b8b93', 0.35) : w.skin;
    const sitting = !w.walking && (w.kind === 'seat' || this.sofaSlot(w) >= 0);
    const sleeping = !w.walking && (w.kind === 'nap' || (this.sofaSlot(w) >= 0 && a.status === 'idle'));
    const { x, y } = w;
    let z = 0;
    if (w.walking) z = Math.abs(Math.sin(t * 9)) * 0.06;
    const bw = 0.44, bd = 0.3;
    const bx = x - bw / 2, by = y - bd / 2;
    const [shx, shy] = this.P(x, y, 0);
    const g = this.g;
    // soft two-layer ground shadow
    g.fillStyle = this.surf().shadow;
    g.beginPath(); g.ellipse(shx, shy, this.s * 0.32, this.s * 0.17, 0, 0, Math.PI * 2); g.fill();
    if (this.selected === w.key || this.hover === w.key) {
      g.save();
      g.strokeStyle = this.selected === w.key ? 'rgba(255,196,80,.95)' : 'rgba(255,255,255,.55)';
      g.lineWidth = this.selected === w.key ? 2.5 : 1.5;
      g.beginPath(); g.ellipse(shx, shy, this.s * 0.46, this.s * 0.24, 0, 0, Math.PI * 2); g.stroke();
      g.restore();
    }
    let hip = 0.34;
    const dir = FACE[w.facing] || FACE.s;
    if (sitting) {
      hip = 0.4;
      const thigh = 0.4, legW = 0.16;
      if (dir[1] !== 0) {
        const ty = dir[1] > 0 ? by + bd - 0.1 : by - thigh + 0.1;
        this.box(bx + 0.04, ty, hip - 0.02, legW, thigh, 0.13, pants);
        this.box(bx + bw - legW - 0.04, ty, hip - 0.02, legW, thigh, 0.13, pants);
        const sy = dir[1] > 0 ? ty + thigh - 0.14 : ty;
        this.box(bx + 0.04, sy, 0, legW, 0.14, hip, pants);
        this.box(bx + bw - legW - 0.04, sy, 0, legW, 0.14, hip, pants);
      } else {
        const tx = dir[0] > 0 ? bx + bw - 0.1 : bx - thigh + 0.1;
        this.box(tx, by + 0.05, hip - 0.02, thigh, 0.16, 0.13, pants);
        this.box(tx, by + bd - 0.21, hip - 0.02, thigh, 0.16, 0.13, pants);
        const sx = dir[0] > 0 ? tx + thigh - 0.14 : tx;
        this.box(sx, by + 0.05, 0, 0.14, 0.16, hip, pants);
        this.box(sx, by + bd - 0.21, 0, 0.14, 0.16, hip, pants);
      }
    } else {
      const step2 = w.walking ? Math.sin(t * 9) * 0.08 : 0;
      this.box(bx + 0.04, by + 0.07 + step2, z, 0.16, 0.16, hip, pants);
      this.box(bx + bw - 0.2, by + 0.07 - step2, z, 0.16, 0.16, hip, pants);
    }
    const zb = (sitting ? hip + 0.08 : hip) + z;
    this.box(bx, by, zb, bw, bd, 0.42, shirt);
    // provider chest patch: a light badge with the provider mark
    this.onFront(bx, by, zb, bw, bd, 0.42, 0.36, 0.58, 0.64, 0.97, 'rgba(255,255,255,.88)');
    const badgeX = this.P(bx + bw * 0.5, by + bd, zb + 0.42 * 0.775);
    this.mark(off ? 'diamond' : providerOf(a.provider).mark, badgeX[0], badgeX[1], Math.max(1.6, this.s * 0.055), off ? 'rgba(90,98,110,.9)' : providerOf(a.provider).color);
    // arms: typing at desks, swinging on walks
    const typing = sitting && w.kind === 'seat' && a.status === 'working';
    const ay = typing ? Math.sin(t * 18) * 0.03 : w.walking ? Math.sin(t * 9) * 0.02 : 0;
    this.box(bx - 0.12, by + 0.06 + ay, zb + 0.08, 0.12, 0.16, 0.32, ofShade(shirt, -0.1));
    this.box(bx + bw, by + 0.06 - ay, zb + 0.08, 0.12, 0.16, 0.32, ofShade(shirt, -0.1));
    // head + hair + face
    const hs = 0.46;
    const hx = x - hs / 2 + (sleeping ? 0.06 : 0), hy = y - hs / 2 + (sleeping ? 0.04 : 0);
    const hz = zb + 0.42 - (sleeping ? 0.1 : 0) + (typing ? Math.sin(t * 3.1) * 0.008 : 0);
    this.box(hx, hy, hz, hs, hs, hs, skin);
    const f = w.facing === 'n' ? 'n' : w.facing === 'e' ? 'e' : 's';
    const hair = off ? ofMix(w.hair, '#8b8b93', 0.3) : w.hair;
    const eyes = (c0, c1) => {
      if (sleeping) {
        this.onFront(hx, hy, hz, hs, hs, hs, c0, 0.5, c0 + 0.2, 0.56, '#33302c');
        this.onFront(hx, hy, hz, hs, hs, hs, c1, 0.5, c1 + 0.2, 0.56, '#33302c');
        return;
      }
      const blink = Math.sin(t * 1.3) > 0.97 ? 0.03 : 0.14;
      const draw = f === 'e' ? 'onRight' : 'onFront';
      this[draw](hx, hy, hz, hs, hs, hs, c0, 0.45, c0 + 0.12, 0.45 + blink, '#2c2a28');
      this[draw](hx, hy, hz, hs, hs, hs, c1, 0.45, c1 + 0.12, 0.45 + blink, '#2c2a28');
    };
    if (f === 's') {
      this.onFront(hx, hy, hz, hs, hs, hs, 0, 0.78, 1, 1, hair);
      this.onRight(hx, hy, hz, hs, hs, hs, 0, 0.45, 1, 1, hair);
      eyes(0.22, 0.66);
      this.onFront(hx, hy, hz, hs, hs, hs, 0.36, 0.66, 0.64, 0.72, 'rgba(60,40,30,.55)'); // gentle smile
    } else if (f === 'e') {
      this.onFront(hx, hy, hz, hs, hs, hs, 0, 0.2, 1, 1, hair);
      this.onRight(hx, hy, hz, hs, hs, hs, 0, 0.72, 1, 1, hair);
      eyes(0.3, 0.62);
    } else {
      this.onFront(hx, hy, hz, hs, hs, hs, 0, 0.15, 1, 1, hair);
      this.onRight(hx, hy, hz, hs, hs, hs, 0, 0.15, 1, 1, hair);
    }
    if (w.long) this.onRight(hx, hy, hz, hs, hs, hs, 0, 0, 1, 0.5, hair);
    this.box(hx - 0.03, hy - 0.03, hz + hs, hs + 0.06, hs + 0.06, 0.1, hair);
    const top = this.P(x, y, (sitting ? 0.48 : 0.34) + 0.42 + hs + 0.1);
    w.screen = { x: top[0], y: top[1], foot: this.P(x, y, 0) };
  }

  // —— overlays: venue labels, status bubbles, task cards —————————————
  paintOver(ph) {
    const ink = lerpEntry(this.pal().ink, ph);
    const g = this.g;
    for (const a of ACTS) {
      const [x, y] = this.P(a.x + a.w / 2, a.y + a.d / 2, a.lz);
      g.font = '700 10.5px system-ui,"PingFang SC",sans-serif';
      const tw = g.measureText(a.label).width;
      g.fillStyle = this.dark ? 'rgba(10,16,26,.62)' : 'rgba(255,252,246,.72)';
      roundRect(g, x - tw / 2 - 7, y - 12, tw + 14, 18, 9); g.fill();
      this.text(a.label, x, y + 1, 10.5, a.color, '700');
    }
    for (const w of this.workers.values()) this.bubble(w);
    for (const w of this.workers.values()) this.card(w, ink);
  }
  ambient(ph) {
    const [hex, alpha] = lerpEntry(this.pal().amb, ph);
    const [r, gg, b] = hexRgb(hex);
    return `rgba(${r},${gg},${b},${alpha})`;
  }
  bubble(w) {
    const a = w.a, g = this.g;
    if (!w.screen) return;
    const { x, y } = w.screen;
    const r = Math.max(7, this.s * 0.2);
    const bx = x + this.s * 0.42, by = y - this.s * 0.1;
    const t = this.t + w.phase;
    const pill = (fill, draw) => {
      g.save();
      g.fillStyle = fill;
      g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = 5;
      g.beginPath(); g.arc(bx, by, r, 0, Math.PI * 2); g.fill();
      g.restore();
      draw();
    };
    if (a.status === 'working') {
      pill('rgba(255,255,255,.95)', () => {
        g.save(); g.translate(bx, by); g.rotate(t * 3);
        g.strokeStyle = '#3b82f6'; g.lineWidth = Math.max(1.5, r * 0.22);
        g.beginPath(); g.arc(0, 0, r * 0.5, 0, Math.PI * 1.4); g.stroke();
        g.restore();
      });
    } else if (isOff(a)) {
      pill('rgba(255,255,255,.9)', () => this.text('💤', bx, by + r * 0.4, r * 1.1, '#64748b', '600'));
    } else if (!w.walking && this.sofaSlot(w) >= 0) {
      for (let i = 0; i < 2; i++) {
        const p = (t * 0.6 + i * 0.5) % 1;
        this.text('z', x + this.s * (0.2 + p * 0.35), y - this.s * (0.1 + p * 0.6), Math.max(8, this.s * (0.2 + 0.1 * i)), `rgba(226,232,240,${1 - p})`, '800');
      }
    }
  }
  // floating task card: the bot's live progress.line (semantic progress)
  card(w, ink) {
    const a = w.a, g = this.g;
    if (!w.screen || a.status !== 'working') return;
    const dark = this.dark;
    const pv = providerOf(a.provider);
    const sx = w.screen.x;
    const headY = w.screen.y - this.s * 0.45;
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
    roundRect(g, x, y, w2, ch, 9); g.fill();
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

// —— page styles (same var(--*) tokens as the shell; light/dark via the
// media query the shell already defines) ———————————————————————————————
const CSS = `
.of-stage {
  position: relative; height: calc(100vh - 108px); min-height: 520px;
  border: 1px solid var(--line); border-radius: 14px; overflow: hidden;
  background: var(--bg); user-select: none;
}
.of-stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; cursor: grab; }
.of-otags { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.of-tag {
  position: absolute; left: 0; top: 0; pointer-events: auto; cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
  padding: 3px 10px 3px 8px; border-radius: 999px; border: 1px solid var(--line);
  background: color-mix(in srgb, var(--panel) 88%, transparent);
  color: var(--ink); font: 600 11px/1.4 -apple-system,"PingFang SC",sans-serif;
  box-shadow: 0 2px 8px rgb(9 14 22 / .18);
}
.of-tag:hover { border-color: var(--accent); }
.of-tag .d { width: 7px; height: 7px; border-radius: 50%; background: #94a3b8; flex: none; }
.of-tag .pv { width: 7px; height: 7px; border-radius: 2px; background: var(--pc, #64748b); flex: none; }
.of-tag[data-st="work"] .d { background: var(--ok); animation: of-pulse 1.6s ease-in-out infinite; }
.of-tag[data-st="idle"] .d { background: #d9a00e; }
.of-tag[data-st="off"] .d { background: #8a93a5; }
.of-tag[data-st="off"] { opacity: .82; }
@keyframes of-pulse { 0%,100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--ok) 45%, transparent); } 50% { box-shadow: 0 0 0 3px transparent; } }
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
.of-empty .card { background: var(--panel); border: 1px dashed var(--line); padding: 22px 30px; border-radius: 12px; }
.of-pop {
  position: absolute; top: 52px; right: 12px; width: 264px; z-index: 5;
  background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
  padding: 12px 14px; box-shadow: 0 12px 40px rgb(0 0 0 / .25);
  display: flex; flex-direction: column; gap: 8px;
}
.of-pop .head { display: flex; align-items: center; gap: 8px; }
.of-pop .head b { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.of-pop .head .pv { width: 10px; height: 10px; border-radius: 3px; flex: none; }
.of-pop .line { font-size: 13px; overflow-wrap: anywhere; color: var(--ink); }
.of-pop .sub { font-size: 12px; color: var(--muted); }
.of-pop .close {
  border: none; background: none; color: var(--muted); cursor: pointer; font-size: 14px; padding: 0 2px;
}
.of-pop .close:hover { color: var(--bad); }
.of-badge { font-size: 12px; padding: 2px 10px; border-radius: 999px; border: 1px solid var(--line); }
.of-badge-w { color: var(--ok); border-color: var(--ok); }
.of-badge-i { color: var(--muted); }
.of-badge-o { color: var(--bad); border-color: var(--bad); }
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

const STATUS_LABEL = { working: '工作中', idle: '空闲', offline: '离线' };
// This repo's /api/agents carries no `connected` flag (v1's client.js had one) —
// status alone is authoritative; anything not working/idle reads as offline.
const isOff = (a) => a.status !== 'working' && a.status !== 'idle';

export default {
  id: 'office3d',
  title: '办公室 3D',
  icon: '⌂',
  order: 2,
  component({ WAO }) {
    // useRef isn't on the WAO hook surface — pull it from the shared React
    // instance (same single copy the shell/stub mounts, so refs stay legal).
    const { h, useState, useEffect, useAgents, useTimeline, React } = WAO;
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

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const params = new URLSearchParams(location.search);
      const scene = new OfficeScene(canvas, {
        dim: params.get('dim') === '2d' ? '2d' : '3d',
        phaseLock: ['day', 'dawn', 'dusk', 'night'].includes(params.get('phase')) ? params.get('phase') : null,
        dark: globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false,
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
                const pv = document.createElement('b'); pv.className = 'pv';
                const sp = document.createElement('span');
                el.appendChild(d); el.appendChild(pv); el.appendChild(sp);
                el.addEventListener('click', () => setSel((cur) => (cur === an.key ? null : an.key)));
                layer.appendChild(el);
                tagMap.current.set(an.key, el);
              }
              if (el.dataset.st !== st || el.dataset.name !== (a.name ?? an.key)) {
                el.dataset.st = st;
                el.dataset.name = a.name ?? an.key;
                el.lastChild.textContent = shortTxt(a.name || an.key, 12);
                el.children[1].style.setProperty('--pc', providerOf(a.provider).color);
                el.children[1].style.background = providerOf(a.provider).color;
              }
              // working bots carry a canvas task card above the head — lift
              // the nameplate clear of it
              const lift = st === 'work' ? 36 : 0;
              el.style.transform = `translate(${Math.round(an.x)}px, ${Math.round(an.y - lift)}px) translate(-50%, -100%)`;
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
      error != null ? h('div', { className: 'error of-err' }, `加载机器人列表失败：${error}`) : null,
      h('div', { className: 'of-hud' },
        h('span', { className: 'of-chip', ref: phaseRef }, '…'),
        h('button', {
          className: 'of-btn',
          onClick: () => setDim((d) => (d === '3d' ? '2d' : '3d')),
        }, dim === '3d' ? '◧ 切换平面' : '⬚ 切换立体')),
      (agents ?? []).length === 0 && error == null
        ? h('div', { className: 'of-empty' },
            h('div', { className: 'card' },
              h('p', null, '空的办公室 — 去 Bot 管理创建一个机器人，它就会搬进来 🤖')))
        : null,
      overflow > 0
        ? h('div', { className: 'of-queue' }, `ⓘ 工位共 ${DESKS.length} 个，${overflow} 位工作中的机器人在门口排队/室内走动`)
        : null,
      h('div', { className: 'of-hint' }, '拖拽平移 · 滚轮缩放 · 按 0 复位 · 点击小人查看详情'),
      selAgent ? (() => {
        const off = isOff(selAgent);
        const cls = selAgent.status === 'working' ? 'of-badge-w' : off ? 'of-badge-o' : 'of-badge-i';
        const pv = providerOf(selAgent.provider);
        return h('aside', { className: 'of-pop' },
          h('div', { className: 'head' },
            h('b', { className: 'pv', style: { background: pv.color }, title: selAgent.provider ?? '' }),
            h('b', null, selAgent.name || selAgent.id),
            h('span', { className: 'badge ' + cls.replace('of-badge', 'of-badge') }, STATUS_LABEL[selAgent.status] ?? selAgent.status),
            h('button', { className: 'close', onClick: () => setSel(null) }, '✕')),
          selAgent.progress?.line
            ? h('div', { className: 'line' }, selAgent.progress.line)
            : h('div', { className: 'sub' }, off && selAgent.reason ? `离线原因：${selAgent.reason}` : '暂无进行中的任务'),
          selAgent.progress?.startedAt
            ? h('div', { className: 'sub' }, '⏱ 已运行 ' + elapsed(Date.now() - selAgent.progress.startedAt)) : null,
          h('div', { className: 'sub' }, `今日 ${selAgent.todayTurns ?? 0} 轮 · 用户 ${selAgent.users ?? 0} · 会话 ${selAgent.chats ?? 0}`),
          h('div', { className: 'sub' }, `${selAgent.provider ?? '?'} · ${selAgent.id}`));
      })() : null,
    );
  },
};
