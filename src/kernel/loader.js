// Kernel plugin loader (spec §2.1/§2.4/§2.5): the only place the kernel
// dynamically imports plugin code. Before any activate() runs, four version
// layers are negotiated (§2.4): ① manifest.version format, ② requires.kernel
// vs KERNEL_API, ③ requires.ports vs PORT_VERSIONS, ④ requires.plugins vs
// the live plugin set. Ordering is Kahn-based with cycle quarantine, imports
// are cache-busted by mtime so a reload of a rewritten plugin.js can never
// silently serve the stale module, and every failure (import, validation,
// cycle, missing dependency, activate throw/timeout) is isolated: the plugin
// is recorded in `failed` with an id-prefixed message and the batch continues.
// The loader never imports any plugin directory statically — dirs arrive as
// data and are only ever dynamic-imported through importPlugin().
import { readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Layer ② — the kernel API version this build speaks.
export const KERNEL_API = 1;
// Layer ③ — per-port contract versions, versioned independently so a
// breaking port change bumps its major without touching the others. `ui` is
// the port name; ui implementations land in the registry's `page` map.
export const PORT_VERSIONS = { channel: 1, provider: 1, ui: 1, middleware: 1, progressor: 1 };

const PLUGIN_TYPES = ['core', 'channel', 'provider', 'ui', 'middleware', 'progressor'];

// --- mini-semver (inline on purpose: three range shapes are the entire
// semver the kernel is allowed to understand, §2.4 — no dependency, no
// loose semver grammar) -----------------------------------------------

// '1.2.0' → [1,2,0]; '1'/'1.2' → zero-filled; number 1 → [1,0,0] because
// KERNEL_API and port versions are plain integers at the call sites.
// Garbage becomes NaN components, and NaN comparisons never satisfy —
// exactly the outcome an unparseable range deserves.
const parseVersion = (v) => {
  if (typeof v === 'number' && Number.isInteger(v)) return [v, 0, 0];
  const parts = String(v).split('.').map((p) => Number.parseInt(p, 10));
  while (parts.length < 3) parts.push(0);
  return parts;
};

const caret = (spec, [a0, a1, a2]) => {
  const [r0, r1, r2] = parseVersion(spec);
  return a0 === r0 && (a1 > r1 || (a1 === r1 && a2 >= r2));
};

// Range grammar: '^1.2.0' (same major, at least the given minor/patch),
// bare '1' (≡ ^1.0.0), anything else is exact ('1.2.0'). `actual` may be a
// version string or a plain integer (kernel/port versions).
export function satisfies(range, actual) {
  if (typeof range !== 'string' || range === '') return false;
  if (range.startsWith('^')) return caret(range.slice(1), parseVersion(actual));
  if (/^\d+$/.test(range)) return caret(`${range}.0.0`, parseVersion(actual));
  const [r0, r1, r2] = parseVersion(range);
  const [a0, a1, a2] = parseVersion(actual);
  return r0 === a0 && r1 === a1 && r2 === a2;
}

// --- manifest validation (layers ①-③; layer ④ needs the live set) --------

// Returns a list of error strings (empty = valid) instead of throwing: one
// pass should surface ALL of a manifest's problems so an operator fixes
// everything at once, and activateAll treats a non-empty list as
// skip-and-record rather than an abort.
export function validateManifest(m, { ids = [], kernelApi = KERNEL_API, portVersions } = {}) {
  if (m == null || typeof m !== 'object' || Array.isArray(m)) return ['manifest must be a plain object'];
  // Destructuring defaults do not cover an explicit null — normalize once
  // instead of defending each use site below.
  const portContract = portVersions ?? PORT_VERSIONS;
  const errors = [];
  const known = ids instanceof Set ? ids : new Set(ids ?? []);

  if (typeof m.id !== 'string' || m.id === '') errors.push('manifest.id is required');
  else if (!/^[a-z0-9-]+$/.test(m.id)) errors.push(`manifest.id '${m.id}' must match ^[a-z0-9-]+$`);
  else if (known.has(m.id)) errors.push(`manifest.id '${m.id}' is already registered`);

  if (!PLUGIN_TYPES.includes(m.type)) {
    errors.push(`manifest.type ${JSON.stringify(m.type) ?? 'undefined'} must be one of ${PLUGIN_TYPES.join(', ')}`);
  }
  if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(m.version)) {
    errors.push(`manifest.version ${JSON.stringify(m.version) ?? 'undefined'} must be three numeric segments X.Y.Z`);
  }

  if (m.requires?.kernel != null && !satisfies(m.requires.kernel, kernelApi)) {
    errors.push(`requires kernel ${m.requires.kernel} but kernel API is ${kernelApi}`);
  }

  if (m.requires?.ports != null) {
    const ports = m.requires.ports;
    if (typeof ports !== 'object' || Array.isArray(ports)) {
      errors.push('requires.ports must be an object of port type → semver range');
    } else {
      for (const [port, range] of Object.entries(ports)) {
        if (!(port in portContract)) {
          errors.push(`requires unknown port '${port}' (known ports: ${Object.keys(portContract).join(', ')})`);
        } else if (!satisfies(range, portContract[port])) {
          errors.push(`requires port ${port} ${range} but port version is ${portContract[port]}`);
        }
      }
    }
  }

  // requires.plugins is shape-checked only: whether a target id actually
  // exists is a question about the live plugin set (answered by ordering +
  // activation gating), not about this manifest in isolation.
  if (m.requires?.plugins != null && (typeof m.requires.plugins !== 'object' || Array.isArray(m.requires.plugins))) {
    errors.push('requires.plugins must be an object of plugin id → semver range');
  }
  return errors;
}

// --- ordering (Kahn with cycle quarantine, §2.5) ---------------------------

// Ordering rule, in precedence order:
//   1. Hard dependency edges (A requires B → B strictly before A). A declared
//      dependency outranks every soft preference below — otherwise we would
//      mis-order dependents ourselves and then false-fail them at gating.
//      Even a core plugin that depends on a provider loads after it.
//   2. Type layer (core first) among topo-layer peers — the engine core must
//      be up before anything that might use it.
//   3. manifest.order (default 10) — operator-tunable within the peers.
//   4. id lexicographic — full determinism when everything else ties.
// Nodes whose in-degree never reaches zero are cycle members AND their
// transitive dependents (which can never satisfy their prerequisites): both
// belong in `cycles` — activating a cycle in any order would false-blame an
// innocent member with "dependency unavailable". Dependencies on ids not in
// the list are ignored here (they may be external/disabled); activation
// gating reports them precisely.
export function orderPlugins(list) {
  const manifests = [...list];
  const byId = new Map(manifests.map((x) => [x.id, x]));
  const depsOf = (x) => Object.keys(x.requires?.plugins ?? {}).filter((id) => byId.has(id));

  const inDeg = new Map(manifests.map((x) => [x.id, depsOf(x).length]));
  const dependents = new Map(manifests.map((x) => [x.id, []]));
  for (const x of manifests) for (const dep of depsOf(x)) dependents.get(dep).push(x.id);

  const layers = [];
  let frontier = manifests.filter((x) => inDeg.get(x.id) === 0).map((x) => x.id);
  while (frontier.length > 0) {
    layers.push(frontier);
    const next = [];
    for (const done of frontier) {
      for (const dep of dependents.get(done)) {
        inDeg.set(dep, inDeg.get(dep) - 1);
        if (inDeg.get(dep) === 0) next.push(dep);
      }
    }
    frontier = next;
  }

  const typeRank = (x) => (x.type === 'core' ? 0 : 1);
  const byPeerRule = (a, b) =>
    (typeRank(a) - typeRank(b)) || ((a.order ?? 10) - (b.order ?? 10)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const order = layers.flatMap((layer) => layer.map((id) => byId.get(id)).sort(byPeerRule));
  const cycles = manifests.filter((x) => inDeg.get(x.id) > 0).sort((a, b) => (a.id < b.id ? -1 : 1));
  return { order, cycles };
}

// --- import (cache-busted) -------------------------------------------------

// The only dynamic import of plugin code in the kernel. The URL carries the
// file's mtime as a query (?t=…) — the ESM loader keys its module cache by
// full URL, so a rewritten plugin.js with a new mtime resolves as a fresh
// module and a reload can never silently run the old code (§2.5). Known
// limit: a rewrite landing on the exact same millisecond aliases the cache;
// real reloads are orders of magnitude slower, tests bump mtime explicitly.
// A missing plugin.js throws here (ENOENT from statSync) — i.e. it surfaces
// as an import failure, which is what it is.
//
// Best-effort diagnosis for the Node 20 engines floor: below 22.7 a bare .js
// file outside any type:module scope parses as CommonJS, so every ESM plugin
// dir without its own package.json "fails to import" with a baffling syntax
// error. DESIGN §2.3 mandates a per-plugin package.json; when the dir has
// none we say so instead of leaving the operator to reverse-engineer V8's
// CJS parser message. One cheap guarded read; never throws.
export function esmHint(dir, err, nodeVersion = process.versions.node) {
  const msg = err?.message ?? String(err);
  const [major, minor] = String(nodeVersion).split('.').map(Number);
  if (major > 22 || (major === 22 && minor >= 7)) return msg; // module syntax detection is on by default
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (pkg?.type === 'module') return msg; // dir already opts into ESM: the hint would be noise
  } catch { /* no or unreadable package.json → hint below */ }
  return `${msg} (plugin dir needs package.json {"type":"module"} on Node <22.7)`;
}

export async function importPlugin(dir) {
  const file = join(dir, 'plugin.js');
  const url = pathToFileURL(file);
  url.search = `t=${statSync(file).mtimeMs}`;
  try {
    const mod = await import(url.href);
    return { mod, manifest: mod.default?.manifest, dir };
  } catch (err) {
    // Re-throw enriched (cause chained) so every caller of importPlugin gets
    // the diagnosis, not just activateAll's formatting.
    throw new Error(esmHint(dir, err), { cause: err });
  }
}

// --- batch activation ------------------------------------------------------

// Import → validate → order → dependency-gate → activate a list of plugin
// directories. Failure isolation is the contract (§2.5): a plugin failing at
// any stage lands in `failed` with an id-prefixed message and the batch
// moves on — one broken plugin never takes the working ones down with it.
export async function activateAll({
  dirs,
  lifecycle,
  pluginConfig = {},
  log = console, // zero-config callers still get readable output; console covers info/debug/warn/error
  kernelApi = KERNEL_API,
  portVersions = PORT_VERSIONS,
  portRegistry = null, // optional; lifecycle.portRegistry is the source of truth
  activateTimeoutMs = 10_000,
} = {}) {
  if (!Array.isArray(dirs)) throw new TypeError('activateAll: dirs must be an array of plugin directories');
  const registry = portRegistry ?? lifecycle.portRegistry;
  const active = [];
  const failed = [];
  const loaded = []; // { mod, manifest, dir } — imported AND validated
  const ids = new Set(); // accumulated across the batch: a duplicate id fails its late-comer

  // Stage 1+2: cache-busted import, then manifest validation. Both failures
  // identify the dir; without a readable manifest the only honest id is the
  // directory basename.
  for (const dir of dirs) {
    const fallbackId = basename(String(dir));
    let rec;
    try {
      rec = await importPlugin(dir);
    } catch (err) {
      failed.push({ id: fallbackId, error: `${fallbackId}: import failed: ${err?.message ?? err}` });
      continue;
    }
    const id = typeof rec.manifest?.id === 'string' && rec.manifest.id !== '' ? rec.manifest.id : fallbackId;
    const errors = validateManifest(rec.manifest, { ids, kernelApi, portVersions });
    if (errors.length > 0) {
      failed.push({ id, error: `${id}: ${errors.join('; ')}` });
      continue;
    }
    // lifecycle.activate silently no-ops on a plugin without a callable
    // activate — "loaded but permanently inert" is the worst possible state,
    // so the loader rejects it loudly at the validation stage instead.
    if (typeof rec.mod.default?.activate !== 'function') {
      failed.push({ id, error: `${id}: activate is not a function` });
      continue;
    }
    ids.add(id);
    loaded.push(rec);
  }

  // Stage 3: ordering with cycle quarantine.
  const { order, cycles } = orderPlugins(loaded.map((r) => r.manifest));
  for (const x of cycles) failed.push({ id: x.id, error: `${x.id}: dependency cycle detected` });
  const byId = new Map(loaded.map((r) => [r.manifest.id, r]));
  const activeIds = new Set();

  // Stage 4: gated sequential activation with a per-plugin timeout.
  for (const manifest of order) {
    // Dependencies were ordered before us, so by now every requires.plugins
    // target is either already active or provably failed/absent — the error
    // can name the culprit exactly.
    const missing = Object.keys(manifest.requires?.plugins ?? {}).find((target) => !activeIds.has(target));
    if (missing != null) {
      failed.push({ id: manifest.id, error: `${manifest.id}: dependency ${missing} unavailable` });
      continue;
    }
    const rec = byId.get(manifest.id);
    // lifecycle's plugin record expects the default export as `mod` (it calls
    // plugin.mod.activate), not the raw module namespace — activate() lives
    // one level down, at mod.default.activate. default + callable activate
    // are guaranteed here: both were checked at the validation stage above.
    const plugin = { dir: rec.dir, manifest, mod: rec.mod.default, status: 'enabled', config: pluginConfig[manifest.id] ?? {} };
    // Hoisted out of the try: on the timeout path the catch must still reach
    // the losing promise to watch (and log) its eventual late outcome.
    let activation = null;
    let timedOut = false;
    try {
      activation = lifecycle.activate(plugin); // async fn: sync throws arrive as rejections
      // Bounded waiting. Honest limit: this can only bound *awaiting* — a
      // plugin hanging synchronously (loop before its first await) blocks
      // the event loop and cannot be cancelled from inside the same thread;
      // that failure class belongs to a process-level watchdog.
      let timer = null;
      try {
        await Promise.race([
          activation,
          new Promise((_, reject) => {
            timer = setTimeout(() => { timedOut = true; reject(new Error(`${manifest.id}: activate timeout`)); }, activateTimeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer); // the losing branch's timer must not linger
      }
      plugin.status = 'active';
      activeIds.add(manifest.id);
      active.push({ id: manifest.id, name: manifest.name ?? null, type: manifest.type, version: manifest.version, status: 'active' });
    } catch (err) {
      failed.push({
        id: manifest.id,
        error: timedOut ? `${manifest.id}: activate timeout` : `${manifest.id}: activate failed: ${err?.message ?? err}`,
      });
      if (timedOut && activation != null) {
        // The race lost, but the activation is still running and will settle
        // someday (a plugin's own 30s network timeout vs our 10s, say). That
        // late outcome must not be swallowed silently — attach watchers now
        // so whichever way it settles is attributed in the log.
        activation.then(
          () => log.warn(`loader: ${manifest.id} activate settled after timeout`),
          (late) => log.warn(`loader: ${manifest.id} activate failed after timeout`, late),
        );
      }
      // lifecycle.activate registers the plugin BEFORE invoking mod.activate,
      // so a failure leaves a half-activated record behind. Roll it back so
      // ports, routes and subscriptions never outlive the failed plugin
      // (deactivate is non-throwing by lifecycle's contract).
      try { await lifecycle.deactivate(plugin); } catch { /* unreachable by contract; never let rollback throw */ }
    }
  }

  log.info(`loader: ${active.length} active, ${failed.length} failed`);
  log.debug(`loader: ports — ${registry?.channel?.size ?? 0} channel, ${registry?.provider?.size ?? 0} provider, `
    + `${registry?.page?.size ?? 0} page, ${registry?.middleware?.length ?? 0} middleware, ${registry?.progressor?.length ?? 0} progressor`);
  return { active, failed };
}
