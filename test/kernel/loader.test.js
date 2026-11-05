// Kernel loader tests (spec §2.1/§2.4/§2.5): manifest validation across the
// four version layers (kernel API, port versions, plugin version format,
// plugin-id dependencies), the inline mini-semver, Kahn ordering with cycle
// quarantine, mtime cache-busting, and failure isolation through import /
// validate / dependency-gating / activate-timeout. activateAll runs against
// real plugin directories in a tmpdir — cache-busting and import-failure
// isolation can only be proven against the real ESM module registry, not
// with object doubles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEventBus } from '../../src/kernel/events.js';
import { createServices } from '../../src/kernel/services.js';
import { createHttpShell } from '../../src/kernel/http.js';
import { createLifecycle } from '../../src/kernel/lifecycle.js';
import {
  KERNEL_API, PORT_VERSIONS, activateAll, importPlugin, orderPlugins, satisfies, validateManifest,
} from '../../src/kernel/loader.js';

// Collecting fake logger mirroring the real child() shape: attribution is
// assertable without touching stderr (same pattern as lifecycle.test.js).
const fakeLog = () => {
  const errors = []; const warns = [];
  const make = (prefix) => ({
    debug() {}, info() {},
    warn: (...a) => warns.push(prefix ? [`[${prefix}]`, ...a] : a),
    error: (...a) => errors.push(prefix ? [`[${prefix}]`, ...a] : a),
    child: make,
  });
  return { errors, warns, log: make(null) };
};

const setup = () => {
  const { errors, warns, log } = fakeLog();
  const services = createServices();
  const lifecycle = createLifecycle({ events: createEventBus({ log }), services, log, http: createHttpShell({ log }) });
  return { errors, warns, log, lifecycle, services };
};

const writePlugin = (dir, code) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'plugin.js'), code); };
// Mini plugin generator (brief's pattern): activate is always async so sync
// throws surface as rejections exactly like real-world module code can.
const pluginJs = (manifestSrc, activateSrc = '') =>
  `export default { manifest: ${manifestSrc}, activate: async (ctx) => { ${activateSrc} } };`;
const m = (over = {}) => ({ id: 'p-x', type: 'core', version: '1.0.0', ...over });

test('version contract constants: kernel API 1, five port types at version 1', () => {
  assert.equal(KERNEL_API, 1);
  assert.deepEqual(PORT_VERSIONS, { channel: 1, provider: 1, ui: 1, middleware: 1, progressor: 1 });
});

test('satisfies: ^ ranges, bare major (≡ ^N.0.0), exact fallback, numeric actuals', () => {
  assert.equal(satisfies('^1.2.0', '1.2.0'), true);
  assert.equal(satisfies('^1.2.0', '1.9.9'), true); // same major, higher minor
  assert.equal(satisfies('^1.2.0', '2.0.0'), false); // major bump breaks
  assert.equal(satisfies('^1.2.0', '1.1.0'), false); // below the floor
  assert.equal(satisfies('1', '1.0.0'), true); // bare '1' ≡ ^1.0.0
  assert.equal(satisfies('1', '1.9.9'), true);
  assert.equal(satisfies('1', '2.0.0'), false);
  assert.equal(satisfies('1.2.0', '1.2.0'), true); // exact
  assert.equal(satisfies('1.2.0', '1.2.1'), false);
  assert.equal(satisfies('^1.0.0', 1), true); // KERNEL_API / port versions arrive as numbers
  assert.equal(satisfies('garbage', 1), false); // a garbage range never satisfies anything
});

test('validateManifest: happy paths — bare manifest, full requires all satisfied', () => {
  assert.deepEqual(validateManifest(m()), []);
  const full = m({
    id: 'wecom-chan', type: 'channel', version: '1.2.3',
    requires: { kernel: '^1', ports: { provider: '^1' }, plugins: { 'core-engine': '^1' } },
  });
  assert.deepEqual(validateManifest(full), []);
  assert.deepEqual(validateManifest(m({ requires: { kernel: '1' } })), []); // bare major kernel range
  assert.deepEqual(validateManifest(m({ requires: { kernel: '1.0.0' } })), []); // exact vs numeric 1
  assert.deepEqual(validateManifest(m({ requires: { ports: { channel: '1', ui: '^1' } } })), []);
  // requires.plugins unknown-ness is deliberately NOT validated here (loader gates on the live set)
  assert.deepEqual(validateManifest(m({ requires: { plugins: { 'not-installed': '^9' } } })), []);
});

test('validateManifest: id/type/version field errors, duplicate id', () => {
  assert.deepEqual(validateManifest(null), ['manifest must be a plain object']);
  assert.ok(validateManifest(m({ id: undefined })).includes('manifest.id is required'));
  assert.ok(validateManifest(m({ id: 'Bad_ID' })).some((e) => /must match/.test(e)));
  assert.ok(validateManifest(m({ id: 'dup' }), { ids: ['other', 'dup'] }).some((e) => /already registered/.test(e)));
  assert.ok(validateManifest(m({ type: undefined })).some((e) => /manifest\.type/.test(e)));
  assert.ok(validateManifest(m({ type: 'widget' })).some((e) => /must be one of/.test(e)));
  assert.ok(validateManifest(m({ version: undefined })).some((e) => /manifest\.version/.test(e)));
  assert.ok(validateManifest(m({ version: '1.0' })).some((e) => /manifest\.version/.test(e)));
  assert.ok(validateManifest(m({ version: 1 })).some((e) => /manifest\.version/.test(e)));
});

test('validateManifest: kernel/port negotiation errors name range and actual; kernelApi is injectable', () => {
  assert.deepEqual(
    validateManifest(m({ requires: { kernel: '^2' } })),
    ['requires kernel ^2 but kernel API is 1'],
  );
  assert.deepEqual(
    validateManifest(m({ requires: { kernel: '^1' } }), { kernelApi: 2 }),
    ['requires kernel ^1 but kernel API is 2'],
  );
  assert.deepEqual(
    validateManifest(m({ type: 'provider', requires: { ports: { provider: '^2' } } })),
    ['requires port provider ^2 but port version is 1'],
  );
  assert.ok(
    validateManifest(m({ requires: { ports: { teleport: '^1' } } })).some((e) => /unknown port/.test(e)),
  );
});

test('orderPlugins: core-first beats order field among dependency-free peers', () => {
  const core = { id: 'z-core', type: 'core', order: 99 };
  const mid = { id: 'a-mid', type: 'middleware', order: 1 };
  const res = orderPlugins([mid, core]);
  assert.deepEqual(res.order.map((x) => x.id), ['z-core', 'a-mid']);
  assert.deepEqual(res.cycles, []);
});

test('orderPlugins: order field then id lexicographic within a type layer', () => {
  const a = { id: 'b-provider', type: 'provider', order: 1 };
  const b = { id: 'a-provider', type: 'provider', order: 1 };
  const c = { id: 'c-provider', type: 'provider' }; // default order 10 → after both
  assert.deepEqual(orderPlugins([c, a, b]).order.map((x) => x.id), ['a-provider', 'b-provider', 'c-provider']);
});

test('orderPlugins: A requires B → B first; a hard edge outranks the core-type preference', () => {
  const a = { id: 'a', type: 'provider', requires: { plugins: { b: '^1' } } };
  const b = { id: 'b', type: 'provider' };
  assert.deepEqual(orderPlugins([a, b]).order.map((x) => x.id), ['b', 'a']);
  const core = { id: 'a-core', type: 'core', requires: { plugins: { 'b-provider': '^1' } } };
  const prov = { id: 'b-provider', type: 'provider' };
  assert.deepEqual(orderPlugins([core, prov]).order.map((x) => x.id), ['b-provider', 'a-core']);
});

test('orderPlugins: cycle members and their transitive dependents quarantined; external deps are not cycles', () => {
  const a = { id: 'a', type: 'core', requires: { plugins: { b: '^1' } } };
  const b = { id: 'b', type: 'core', requires: { plugins: { a: '^1' } } };
  const c = { id: 'c', type: 'provider', requires: { plugins: { a: '^1' } } }; // depends on the cycle
  const d = { id: 'd', type: 'provider', requires: { plugins: { ghost: '^1' } } }; // external id: not our problem here
  const e = { id: 'e', type: 'middleware' };
  const res = orderPlugins([a, b, c, d, e]);
  assert.deepEqual(res.cycles.map((x) => x.id), ['a', 'b', 'c']);
  assert.deepEqual(res.order.map((x) => x.id), ['d', 'e']);
});

test('importPlugin: returns mod/manifest/dir; same mtime serves cache, bumped mtime imports fresh', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'wao-loader-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'p1');
  writePlugin(dir, pluginJs("{ id: 'p1', type: 'core', version: '1.0.0' }"));
  const first = await importPlugin(dir);
  assert.equal(first.dir, dir);
  assert.equal(first.manifest.version, '1.0.0');
  const cached = await importPlugin(dir);
  assert.equal(cached.manifest.version, '1.0.0');
  assert.equal(cached.mod, first.mod); // same URL → the ESM cache served the very same namespace
  writePlugin(dir, pluginJs("{ id: 'p1', type: 'core', version: '1.0.1' }"));
  const later = new Date(Date.now() + 10_000); // deterministic bump: a same-ms rewrite would alias the cache
  utimesSync(join(dir, 'plugin.js'), later, later);
  const fresh = await importPlugin(dir);
  assert.equal(fresh.manifest.version, '1.0.1'); // fresh module, not the cached one
  assert.notEqual(fresh.mod, first.mod); // provably a different module instance
});

test('activateAll: failure isolation across import/validate/dependency-gate; satisfied deps activate in order; config flows', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'wao-loader-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const core = join(root, 'ok-core');
  writePlugin(core, pluginJs("{ id: 'ok-core', type: 'core', version: '1.0.0' }", "ctx.services.register('svc-core', ctx.config);"));
  const chan = join(root, 'ok-chan'); // dep on ok-core (present) → activates after it
  writePlugin(chan, pluginJs("{ id: 'ok-chan', type: 'channel', version: '1.0.0', requires: { plugins: { 'ok-core': '^1' } } }"));
  const prov = join(root, 'ok-provider'); // dep on core-engine (absent) → gated out with the exact culprit
  writePlugin(prov, pluginJs("{ id: 'ok-provider', type: 'provider', version: '1.0.0', requires: { plugins: { 'core-engine': '^1' } } }"));
  const bad = join(root, 'bad'); // manifest missing type → validation failure
  writePlugin(bad, pluginJs("{ id: 'bad', version: '1.0.0' }"));
  const broken = join(root, 'broken-import'); // syntax error → import failure
  writePlugin(broken, 'export default { this is not js');

  const s = setup();
  const res = await activateAll({
    dirs: [broken, core, bad, prov, chan],
    lifecycle: s.lifecycle,
    pluginConfig: { 'ok-core': { tag: 't1' } },
    log: s.log,
  });
  assert.deepEqual(res.active, [
    { id: 'ok-core', type: 'core', version: '1.0.0', status: 'active' },
    { id: 'ok-chan', type: 'channel', version: '1.0.0', status: 'active' },
  ]);
  const byId = Object.fromEntries(res.failed.map((f) => [f.id, f.error]));
  assert.match(byId['broken-import'], /^broken-import: import failed: /);
  assert.match(byId.bad, /^bad: manifest\.type /);
  assert.match(byId['ok-provider'], /^ok-provider: dependency core-engine unavailable$/);
  assert.deepEqual(s.services.get('svc-core'), { tag: 't1' }); // pluginConfig[id] reached ctx.config
  assert.deepEqual(s.lifecycle.debugState().active, ['ok-core', 'ok-chan']);
});

test('activateAll: duplicate id across dirs — first stays active, duplicate fails validation', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'wao-loader-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const one = join(root, 'dup-one');
  const two = join(root, 'dup-two');
  writePlugin(one, pluginJs("{ id: 'dup', type: 'core', version: '1.0.0' }"));
  writePlugin(two, pluginJs("{ id: 'dup', type: 'core', version: '2.0.0' }"));
  const s = setup();
  const res = await activateAll({ dirs: [one, two], lifecycle: s.lifecycle, log: s.log });
  assert.deepEqual(res.active, [{ id: 'dup', type: 'core', version: '1.0.0', status: 'active' }]);
  assert.equal(res.failed.length, 1);
  assert.equal(res.failed[0].id, 'dup');
  assert.match(res.failed[0].error, /already registered/);
});

test('activateAll: rewritten plugin.js with bumped mtime re-imports fresh across runs (cache-busting)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'wao-loader-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'p');
  writePlugin(dir, pluginJs("{ id: 'p', type: 'core', version: '1.0.0' }"));
  const s1 = setup();
  assert.equal((await activateAll({ dirs: [dir], lifecycle: s1.lifecycle, log: s1.log })).active[0].version, '1.0.0');
  writePlugin(dir, pluginJs("{ id: 'p', type: 'core', version: '1.0.1' }"));
  const later = new Date(Date.now() + 10_000);
  utimesSync(join(dir, 'plugin.js'), later, later);
  const s2 = setup();
  const res = await activateAll({ dirs: [dir], lifecycle: s2.lifecycle, log: s2.log });
  assert.deepEqual(res.active, [{ id: 'p', type: 'core', version: '1.0.1', status: 'active' }]);
});

test('activateAll: dependency cycle quarantines every member with an explicit error', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'wao-loader-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const a = join(root, 'a');
  const b = join(root, 'b');
  writePlugin(a, pluginJs("{ id: 'a', type: 'core', version: '1.0.0', requires: { plugins: { b: '^1' } } }"));
  writePlugin(b, pluginJs("{ id: 'b', type: 'core', version: '1.0.0', requires: { plugins: { a: '^1' } } }"));
  const s = setup();
  const res = await activateAll({ dirs: [a, b], lifecycle: s.lifecycle, log: s.log });
  assert.deepEqual(res.active, []);
  assert.deepEqual(res.failed.map((f) => f.error).sort(), [
    'a: dependency cycle detected',
    'b: dependency cycle detected',
  ]);
});

test('activateAll: sync throw and async rejection in activate are isolated; later plugins proceed; halves rolled back', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'wao-loader-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const boom = join(root, 'boom'); // id sorts first
  const reject = join(root, 'reject'); // id sorts last
  const fine = join(root, 'fine');
  writePlugin(boom, pluginJs(
    "{ id: 'boom', type: 'core', version: '1.0.0' }",
    "ctx.registerProvider('boom-port', { x: 1 }); throw new Error('sync boom');", // half-registered before dying
  ));
  writePlugin(reject, pluginJs("{ id: 'reject', type: 'core', version: '1.0.0' }", "await Promise.reject(new Error('async boom'));"));
  writePlugin(fine, pluginJs("{ id: 'fine', type: 'core', version: '1.0.0' }", "ctx.services.register('svc-fine', {});"));
  const s = setup();
  const res = await activateAll({ dirs: [boom, reject, fine], lifecycle: s.lifecycle, log: s.log });
  assert.deepEqual(res.failed.map((f) => f.error), [
    'boom: activate failed: sync boom',
    'reject: activate failed: async boom',
  ]);
  assert.deepEqual(res.active.map((a) => a.id), ['fine']);
  assert.ok(s.services.get('svc-fine'));
  assert.deepEqual(s.lifecycle.debugState().active, ['fine']); // failed half-activations are not left live
  assert.equal(s.lifecycle.portRegistry.provider.size, 0); // boom's pre-throw port registration was rolled back
});

test('activateAll: hung activate fails after activateTimeoutMs; the rest of the batch continues', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'wao-loader-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hang = join(root, 'hang'); // id sorts before z-fine
  const fine = join(root, 'z-fine');
  writePlugin(hang, pluginJs("{ id: 'hang', type: 'core', version: '1.0.0' }", "await new Promise(() => {}); ctx.services.register('never', {});"));
  writePlugin(fine, pluginJs("{ id: 'z-fine', type: 'core', version: '1.0.0' }", "ctx.services.register('svc-fine', {});"));
  const s = setup();
  const started = Date.now();
  const res = await activateAll({ dirs: [hang, fine], lifecycle: s.lifecycle, log: s.log, activateTimeoutMs: 50 });
  assert.ok(Date.now() - started < 5000, 'a hung activate must not wedge the batch');
  assert.deepEqual(res.failed, [{ id: 'hang', error: 'hang: activate timeout' }]);
  assert.deepEqual(res.active.map((a) => a.id), ['z-fine']);
  assert.ok(s.services.get('svc-fine'));
  assert.deepEqual(s.lifecycle.debugState().active, ['z-fine']); // timed-out half-activation rolled back
});

test('activateAll: module without a manifest → validation failure, id falls back to dir basename', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'wao-loader-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'no-manifest');
  writePlugin(dir, 'export default {};');
  const s = setup();
  const res = await activateAll({ dirs: [dir], lifecycle: s.lifecycle, log: s.log });
  assert.deepEqual(res.active, []);
  assert.deepEqual(res.failed, [{ id: 'no-manifest', error: 'no-manifest: manifest must be a plain object' }]);
});
