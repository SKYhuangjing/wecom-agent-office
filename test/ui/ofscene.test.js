// ofscene engine unit tests (M3 T4): lock the PORTED mechanics — projection,
// shading math, phase bands, BFS navigation, worker slot assignment — against
// regressions while the visual layer is free to change. Pure and fast: the
// scene runs on a stub canvas (no DOM), nav on a synthetic room.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ofShade, ofMix, ofSeed, phaseAt, buildNav, OfScene }
  from '../../plugins/ui-office3d/ui/legacy/ofscene.js';

const stubCanvas = (w = 1280, h = 800) => ({
  width: 0, height: 0, style: {},
  getBoundingClientRect: () => ({ width: w, height: h }),
  getContext: () => new Proxy({}, { get: () => () => {} }), // every ctx call is a no-op
  addEventListener: () => {},
});

const stubScene = (opts = {}) => new OfScene(stubCanvas(), {
  room: { W: 16, D: 12, WALL: 3.1 },
  nav: { path: () => [] },
  layout: {},
  ...opts,
});

test('P with identity camera equals rawP; zoom scales distance from center', () => {
  const s = stubScene();
  for (const [x, y, z] of [[0, 0, 0], [16, 12, 3.1], [8, 6, 1.5], [3.2, 0.55, 0.68]]) {
    assert.deepEqual(s.P(x, y, z), s.rawP(x, y, z));
  }
  s.cam = { x: 0, y: 0, z: 2 };
  const p = s.P(8, 6, 0);
  assert.ok(Math.abs(p[0] - s.W / 2) < 1e-6); // room center stays pinned under zoom
  const q0 = s.rawP(0, 0, 0), q = s.P(0, 0, 0);
  assert.equal(q[0] - s.W / 2, 2 * (q0[0] - s.W / 2));
  s.clampCam(); // zoom 2 is in range; pan untouched
  assert.equal(s.cam.z, 2);
});

test('z lifts the projection up in both dims; 2d mode maps x linearly', () => {
  const s3 = stubScene();
  assert.ok(s3.P(8, 6, 1)[1] < s3.P(8, 6, 0)[1]);
  const s2 = stubScene({ dim: '2d' });
  const a = s2.rawP(0, 0, 0), b = s2.rawP(4, 0, 0);
  assert.equal(b[0] - a[0], 4 * s2.s);
  assert.ok(s2.rawP(0, 0, 1)[1] < s2.rawP(0, 0, 0)[1]);
});

test('shade darkens/lightens hex and hsl; mix blends; seeds are stable', () => {
  assert.equal(ofShade('#808080', -0.5), 'rgb(64,64,64)');
  assert.equal(ofShade('#000000', 0.5), 'rgb(128,128,128)');
  assert.equal(ofShade('hsl(0,100%,50%)', 0), 'rgb(255,0,0)');
  assert.equal(ofMix('#000000', '#ffffff', 0.25), 'rgb(64,64,64)');
  assert.equal(ofSeed('bot-1'), ofSeed('bot-1'));
  assert.notEqual(ofSeed('bot-1'), ofSeed('bot-2'));
});

test('phaseAt: band cores are pure, gaps cross-fade, midnight wraps to night', () => {
  assert.deepEqual({ ...phaseAt(0.5) }, { a: 'day', b: 'day', mix: 0, phase: 'day' });
  assert.equal(phaseAt(0.23).phase, 'dawn');
  assert.equal(phaseAt(0.76).phase, 'dusk');
  assert.equal(phaseAt(0).phase, 'night'); // wrap
  assert.equal(phaseAt(0.1).phase, 'night');
  const t = phaseAt(0.30); // dawn→day transition midpoint
  assert.equal(t.a, 'dawn'); assert.equal(t.b, 'day');
  assert.ok(t.mix > 0.4 && t.mix < 0.6);
});

test('BFS nav: routes around a wall, respects docks via their approach point', () => {
  const nav = buildNav({
    W: 8, D: 6,
    blockers: [[3, 0, 1, 6]], // full-height wall splitting the room at x=3..4
    frees: [], // except a gap? none: crossing must be impossible
    docks: [{ to: [1.0, 1.0], via: [1.6, 1.6] }],
  });
  assert.equal(nav.path([1, 1], [6, 1]).length, 0); // walled off: no path
  const nav2 = buildNav({
    W: 8, D: 6,
    blockers: [[3, 0, 1, 4]], // wall with a southern gap
    frees: [],
    docks: [{ to: [1.0, 1.0], via: [1.6, 1.6] }],
  });
  const p = nav2.path([1, 1], [6, 1]);
  assert.notEqual(p.length, 0);
  for (const [x, y] of p) assert.ok(nav2.freeAt(x, y), `waypoint ${x},${y} inside a wall`);
  assert.ok(p.every(([x, y]) => x < 3 || x > 4 || y > 4), 'path crosses through the gap only');
  // docked destination: corridor runs to the APPROACH, final leg steps into
  // the dock; starting FROM a dock walks out through the approach first
  const q = nav2.path([6, 5], [1, 1]);
  assert.deepEqual(q[q.length - 1], [1, 1]);
  assert.deepEqual(q[q.length - 2], [1.6, 1.6]);
  const r = nav2.path([1, 1], [6, 5]);
  assert.deepEqual(r[0], [1.6, 1.6]);
  assert.equal(nav2.clear([1, 1], [1.6, 1.6]), true);
});

test('slot machine: seats exhaust into the fallback kind and stay stable', () => {
  const spots = {
    seat: [[2, 2, 'n']],
    queue: [[1, 3, 's'], [1.5, 3, 's']],
    wander: [[5, 5, 's']],
  };
  const layout = {
    kindOf: (a) => 'seat',
    spots,
    fallback: { seat: 'queue' },
    door: [0.6, 2.6],
    makeWorker: () => ({}),
  };
  const s = stubScene({ layout });
  const agents = [{ id: 'a', status: 'working' }, { id: 'b', status: 'working' }];
  s.setAgents(agents);
  const wa = s.workers.get('a'), wb = s.workers.get('b');
  assert.equal(wa.kind, 'seat');
  assert.equal(wb.kind, 'queue'); // seat full → fallback chain
  s.setAgents(agents); // refresh keeps both placements (no reshuffling churn)
  assert.equal(s.workers.get('a').slot, wa.slot);
  assert.equal(s.workers.get('b').slot, wb.slot);
  s.setAgents([{ id: 'b', status: 'working' }]); // a leaves: b upgrades into the freed seat
  assert.equal(s.workers.get('b').kind, 'seat');
});
