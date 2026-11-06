// WAO web SDK (DESIGN §9): the only data layer pages are allowed to use.
// Pure functions + React hooks, no JSX — it is bundled into the shell AND
// exposed on window.WAO for page plugins. Pages never invent their own
// fetching.
//
// React is NOT imported here: the shell and every page share the ONE UMD
// instance index.html loads (hooks crash across two React copies), so the
// shell calls initSdk(window.React) before rendering. Until then the hooks
// are inert (the harness stub replaces them wholesale anyway).

let R = null; // { useState, useEffect, useCallback } — injected via initSdk

export function initSdk(react) {
  R = { useState: react.useState, useEffect: react.useEffect, useCallback: react.useCallback };
}

// api(): JSON fetch with the kernel's error convention — !ok bodies carry
// {error}, and that message (not a bare status code) is what callers see.
export async function api(path, body, { method } = {}) {
  const init = body !== undefined || method !== undefined
    ? {
      method: method ?? (body !== undefined ? 'POST' : 'GET'),
      ...(body !== undefined
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    }
    : undefined;
  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    throw new Error(`网络请求失败：${err?.message ?? err}`);
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body (proxy error page) */ }
  if (!res.ok) {
    throw new Error(data?.error ?? `HTTP ${res.status}`);
  }
  return data;
}

// —— shared SSE backbone ————————————————————————————————————————————————
// One EventSource per origin no matter how many hooks subscribe; the browser
// caps SSE connections per domain, so per-hook sources would strand pages.
// Topics the kernel bridge forwards (DESIGN §8 /api/events) — listeners are
// registered for exactly these names.
const SSE_TOPICS = ['agent/progress', 'agent/status', 'run/start', 'run/end',
  'ledger/turn', 'service/state', 'plugin/lifecycle'];

const subscribers = new Set(); // { match(name), cb(name, data) }
let source = null;
let connectRef = 0;

const ensureSSE = () => {
  connectRef++;
  if (source != null) return;
  source = new EventSource('/api/events');
  const dispatch = (ev) => {
    let data = ev.data;
    try { data = JSON.parse(ev.data); } catch { /* forward raw */ }
    for (const s of [...subscribers]) {
      if (s.match(ev.type)) {
        try { s.cb(ev.type, data); } catch { /* a broken page must not kill the pipe */ }
      }
    }
  };
  for (const topic of SSE_TOPICS) source.addEventListener(topic, dispatch);
};

const releaseSSE = () => {
  if (--connectRef > 0) return;
  source?.close();
  source = null;
};

// useSSE(topics, cb): subscribe to named kernel events. `topics` entries are
// exact names or prefixes ending in '/' (agent/* style); null = everything.
// One subscription per mount: keep `cb` stable (useCallback) or accept the
// captured closure — the SSE pipe itself is never rewired by rerenders.
export function useSSE(topics, cb) {
  if (R == null) return;
  R.useEffect(() => {
    const list = Array.isArray(topics) ? topics : topics != null ? [topics] : null;
    const sub = {
      match: (name) => list == null || list.some((t) => (t.endsWith('/') ? name.startsWith(t) : name === t)),
      cb,
    };
    subscribers.add(sub);
    ensureSSE();
    return () => { subscribers.delete(sub); releaseSSE(); };
  }, []);
}

// useAgents(): live bot list — SSE agent/* nudges a refetch, a 5s poll is the
// safety net (missed frames, reconnect windows). Returns {agents, error};
// never throws.
export function useAgents() {
  const [agents, setAgents] = R.useState([]);
  const [error, setError] = R.useState(null);
  const refresh = R.useCallback(async () => {
    try {
      const data = await api('/api/agents');
      setAgents(Array.isArray(data?.agents) ? data.agents : []);
      setError(null);
    } catch (err) {
      setError(err?.message ?? String(err));
    }
  }, []);
  R.useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  useSSE(['agent/progress', 'agent/status', 'plugin/lifecycle'], refresh);
  return { agents, error };
}

// useTimeline(botId, windowMin): recent activity rows (run/step/tool/thinking/
// turn), newest last. SSE run/* + agent/* nudge a refresh; 5s poll fallback.
export function useTimeline(botId = null, windowMin = 30) {
  const [rows, setRows] = R.useState([]);
  const [error, setError] = R.useState(null);
  const refresh = R.useCallback(async () => {
    const q = new URLSearchParams({ window: String(windowMin * 60 * 1000) });
    if (botId) q.set('bot', botId);
    try {
      const data = await api(`/api/timeline?${q.toString()}`);
      setRows(Array.isArray(data) ? data : []);
      setError(null);
    } catch (err) {
      setError(err?.message ?? String(err));
    }
  }, [botId, windowMin]);
  R.useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  useSSE(['run/start', 'run/end', 'agent/progress'], refresh);
  return { rows, error };
}
