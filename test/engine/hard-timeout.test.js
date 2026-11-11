// hardTimeoutMsOf (per-bot hard-timeout override) units — the 2026-11-11
// incident knob (engine.js header comment has the story). Pure-function
// layer; the wiring (defaultRunTurn reads it) is covered by run tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hardTimeoutMsOf } from '../../plugins/core-engine/engine.js';

const L = { hardTimeoutMs: 1_800_000 };

test('hardTimeoutMsOf: absent/garbage → engine default; minutes → ms', () => {
  assert.equal(hardTimeoutMsOf({}, L), 1_800_000);
  assert.equal(hardTimeoutMsOf({ providerConfig: {} }, L), 1_800_000);
  assert.equal(hardTimeoutMsOf({ providerConfig: { hardTimeoutMin: 'x' } }, L), 1_800_000);
  assert.equal(hardTimeoutMsOf({ providerConfig: { hardTimeoutMin: 0 } }, L), 1_800_000, 'non-positive is not a cap');
  assert.equal(hardTimeoutMsOf({ providerConfig: { hardTimeoutMin: -5 } }, L), 1_800_000);
  assert.equal(hardTimeoutMsOf({ providerConfig: { hardTimeoutMin: 10 } }, L), 600_000);
  assert.equal(hardTimeoutMsOf({ providerConfig: { hardTimeoutMin: 2.5 } }, L), 150_000, 'fractional minutes floor to ms precision');
});

test('hardTimeoutMsOf: survives missing limits and missing bot', () => {
  assert.equal(hardTimeoutMsOf({ providerConfig: { hardTimeoutMin: 1 } }, undefined), 60_000);
  assert.equal(hardTimeoutMsOf(null, L), 1_800_000);
});
