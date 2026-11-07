// SDK WAO_TOKEN support (P1): api() attaches the stored token as X-WAO-Token,
// prompts ONCE on 401 (storing the answer) and retries; a cancelled prompt
// surfaces the 401 error. SSE wiring passes the token as ?wao_token= because
// EventSource cannot set headers. Runs web/src/sdk.js under Node with stubbed
// fetch/localStorage/prompt — same harness style as sdk-debounce.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, useSSE } from '../../web/src/sdk.js';
import { initSdk } from '../../web/src/sdk.js';

// Minimal hooks runtime: effects register AND run immediately (a real mount).
const effects = [];
initSdk({
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: (fn) => { effects.push(fn); },
  useCallback: (fn) => fn,
});

// localStorage stub (the browser SDK reads/writes 'wao-token').
const store = new Map();
const localStorageStub = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
};

// fetch double: queue of responses; records every call's headers.
let calls = [];
let queue = [];
const fetchStub = async (path, init) => {
  calls.push({ path, headers: { ...(init?.headers ?? {}) } });
  const next = queue.shift();
  if (next instanceof Error) throw next;
  return {
    status: next.status,
    ok: next.status >= 200 && next.status < 300,
    headers: new Map(),
    json: async () => next.body,
  };
};

// prompt double: returns queued answers.
let promptAnswers = [];
let promptCalls = 0;

let sseUrls = [];
class EventSourceStub {
  constructor(url) { sseUrls.push(url); }
  addEventListener() {}
  close() {}
}

before(() => {
  globalThis.localStorage = localStorageStub;
  globalThis.fetch = fetchStub;
  globalThis.prompt = () => {
    promptCalls++;
    const a = promptAnswers.shift();
    return a === undefined ? null : a;
  };
  globalThis.EventSource = EventSourceStub;
});

after(() => {
  delete globalThis.localStorage;
  delete globalThis.fetch;
  delete globalThis.prompt;
  delete globalThis.EventSource;
});

test('api() attaches X-WAO-Token from localStorage on every call', async () => {
  store.set('wao-token', 'tok-1');
  calls = [];
  queue = [{ status: 200, body: { ok: true } }];
  await api('/api/agents');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers['x-wao-token'], 'tok-1');

  // POST keeps its content-type beside the token.
  queue = [{ status: 200, body: { ok: true } }];
  await api('/api/send', { botId: 'b', chatKey: 'k', content: 'c' });
  assert.equal(calls[1].headers['content-type'], 'application/json');
  assert.equal(calls[1].headers['x-wao-token'], 'tok-1');
  store.delete('wao-token');
});

test('api() on 401: prompts once, stores the token, retries with it and returns the data', async () => {
  store.delete('wao-token');
  calls = [];
  promptCalls = 0;
  promptAnswers = ['tok-fresh'];
  queue = [
    { status: 401, body: { error: 'unauthorized: provide WAO_TOKEN via Authorization Bearer or X-WAO-Token header' } },
    { status: 200, body: { agents: [] } },
  ];
  const data = await api('/api/agents');
  assert.deepEqual(data, { agents: [] });
  assert.equal(promptCalls, 1, 'exactly one prompt');
  assert.equal(store.get('wao-token'), 'tok-fresh', 'token persisted to localStorage');
  assert.equal(calls.length, 2, 'one retry');
  assert.equal(calls[0].headers['x-wao-token'], undefined);
  assert.equal(calls[1].headers['x-wao-token'], 'tok-fresh');
});

test('api() on 401 with a cancelled prompt surfaces the 401 error', async () => {
  store.delete('wao-token');
  promptCalls = 0;
  promptAnswers = []; // prompt() → null (cancel)
  queue = [{ status: 401, body: { error: 'unauthorized: provide WAO_TOKEN via Authorization Bearer or X-WAO-Token header' } }];
  await assert.rejects(api('/api/agents'), /unauthorized: provide WAO_TOKEN/);
  assert.equal(promptCalls, 1);
});

test('api() on 401 with a stale stored token: prompt replaces it and the retry wins', async () => {
  store.set('wao-token', 'tok-stale');
  promptCalls = 0;
  promptAnswers = ['tok-new'];
  queue = [
    { status: 401, body: { error: 'unauthorized' } },
    { status: 200, body: { ok: true } },
  ];
  const data = await api('/api/state');
  assert.equal(data.ok, true);
  assert.equal(store.get('wao-token'), 'tok-new');
  assert.equal(calls[calls.length - 1].headers['x-wao-token'], 'tok-new');
});

test('SSE passes the stored token as ?wao_token= (EventSource cannot send headers)', async () => {
  store.set('wao-token', 'tok-1');
  sseUrls = [];
  useSSE(['agent/progress'], () => {});
  const cleanups = effects.splice(0).map((fn) => fn());
  assert.equal(sseUrls.length, 1);
  assert.equal(sseUrls[0], '/api/events?wao_token=tok-1');
  for (const c of cleanups) c?.();
  // Without a token the plain URL is used (no-auth servers see no query).
  store.delete('wao-token');
  sseUrls = [];
  useSSE(['agent/progress'], () => {});
  const cleanups2 = effects.splice(0).map((fn) => fn());
  assert.equal(sseUrls[0], '/api/events');
  for (const c of cleanups2) c?.();
});
