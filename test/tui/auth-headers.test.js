// TUI WAO_TOKEN support (P1): with $WAO_TOKEN in the environment, every
// fetch attachTUI makes — the 2s roster poll AND every keypress effect —
// carries X-WAO-Token; without it, requests are unchanged (no stray header).
// Same double-fetch pattern as keys.test.js, no TTY needed.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachTUI } from '../../src/tui/attach.js';

const TOKEN = 'wao-test-token-1';
const agentsBody = { agents: [{ id: 'b1', name: 'bot', status: 'idle', enabled: true }] };
const okJson = (body) => ({ status: 200, ok: true, json: async () => body });

let calls;

beforeEach(() => {
  calls = [];
});

const attach = () => {
  const input = new EventEmitter();
  input.setRawMode = () => {};
  const tui = attachTUI({
    stream: { write() {}, isTTY: false, on() {}, off() {} },
    input,
    base: 'http://127.0.0.1:8792',
    fetchFn: async (u, init) => {
      calls.push({ url: u, headers: init?.headers ?? {} });
      return okJson(agentsBody);
    },
    now: () => 0,
    intervalMs: 3_600_000, // no ticks during the test
    onQuit: null,
  });
  return { tui, input };
};

test('$WAO_TOKEN set: roster poll and keypress effect both carry X-WAO-Token', async () => {
  process.env.WAO_TOKEN = TOKEN;
  try {
    const { tui, input } = attach();
    await new Promise((r) => setTimeout(r, 20)); // roster poll resolves, selection exists
    assert.ok(calls.length >= 1, 'roster poll fired on the first tick');
    assert.equal(calls[0].url, 'http://127.0.0.1:8792/api/agents');
    assert.equal(calls[0].headers['x-wao-token'], TOKEN);
    // 'b' on the selected bot → ledger effect through runApi's jsonFetch
    calls.length = 0;
    input.emit('keypress', 'b', { name: 'b' });
    await new Promise((r) => setTimeout(r, 30));
    const ledger = calls.find((c) => c.url.includes('/api/ledger'));
    assert.ok(ledger, `ledger effect fired: ${JSON.stringify(calls.map((c) => c.url))}`);
    assert.equal(ledger.headers['x-wao-token'], TOKEN);
    tui.quit(0);
  } finally {
    delete process.env.WAO_TOKEN;
  }
});

test('$WAO_TOKEN unset: no token header on any request', async () => {
  const { tui } = attach();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(calls.length >= 1);
  for (const c of calls) {
    assert.equal(c.headers['x-wao-token'], undefined, `no stray token header: ${c.url}`);
  }
  tui.quit(0);
});
