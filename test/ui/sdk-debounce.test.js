// SDK SSE-refetch debounce (known-boundaries wave 2026-11-06): useSSERefetch
// must collapse a frame burst into ONE trailing refetch 500ms after the last
// frame, with no fetch per frame. Runs web/src/sdk.js directly under Node
// with a minimal hooks runtime (effects run once, immediately) and a stub
// EventSource whose captured dispatch handler lets the test INJECT frames.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initSdk, useSSERefetch } from '../../web/src/sdk.js';

// Captures the one dispatch handler ensureSSE registers per topic — calling
// it is exactly "a named SSE frame arrived".
let dispatchFrame = null;
const cleanups = [];

test.before(() => {
  globalThis.EventSource = class {
    addEventListener(topic, fn) { dispatchFrame = fn; }
    close() { dispatchFrame = null; }
  };
});

test.after(() => {
  for (const fn of cleanups.splice(0)) {
    try { fn(); } catch { /* best effort */ }
  }
  delete globalThis.EventSource;
});

test('useSSERefetch: a frame burst collapses into one trailing refetch', async () => {
  // Minimal hooks runtime: useState initializes once (setter unused here),
  // useEffect registers AND runs immediately — the subscription therefore
  // exists as soon as the hook call returns, like a real mount.
  const effects = [];
  initSdk({
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: (fn) => { effects.push(fn); },
    useCallback: (fn) => fn,
  });

  let fetches = 0;
  useSSERefetch(['agent/progress'], () => { fetches++; });
  cleanups.push(...effects.map((fn) => fn())); // mount effects (subscribe + unmount cancel)

  // 10 frames in a tight loop — well inside one 500ms window
  for (let i = 0; i < 10; i++) dispatchFrame({ type: 'agent/progress', data: '{}' });
  assert.equal(fetches, 0, 'trailing only: no fetch fires while frames keep arriving');

  await new Promise((r) => setTimeout(r, 650));
  assert.equal(fetches, 1, 'the burst produced exactly one refetch');

  // A second burst after the quiet gap fetches again (debounce, not kill)
  for (let i = 0; i < 3; i++) dispatchFrame({ type: 'agent/progress', data: '{}' });
  await new Promise((r) => setTimeout(r, 650));
  assert.equal(fetches, 2, 'a later burst still refetches');
});
