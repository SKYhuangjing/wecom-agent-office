// WAO console shell (DESIGN §9): navigation/routing/theme + the window.WAO
// contract injection. Deliberately NO React import — index.html loads the
// single vendored UMD instance the shell AND every page plugin share (hooks
// crash across two React copies); esbuild only transforms JSX (factory h)
// and bundles sdk.js alongside.
const React = globalThis.React;
const { useState, useEffect, useCallback, useRef } = React;
const h = React.createElement; // JSX factory (build.mjs --jsx-factory=h)
import { api, initSdk, useAgents, useTimeline, useSSE } from './sdk.js';
import { avatar, avatarUrl } from './avatar.js';
import { navIcon } from './icons.js';

// Page registry: discovered uiPlugins (dynamic import) + runtime
// registerPage() callers (harness/dynamic pages). One shape for both.
const pages = new Map(); // id → {id,title,icon,order,component}
let pushPage = null; // set by <Shell/> once state exists
const registerPage = (desc) => {
  if (desc == null || typeof desc.id !== 'string' || desc.id === '') return;
  pages.set(desc.id, desc);
  pushPage?.(desc);
};

// The browser contract every page plugin codes against (DESIGN §9). Mounted
// before any page module import so a module reading window.WAO at top level
// (not the contract, but cheap to survive) still sees it.
const WAO = {
  React, h,
  useState, useEffect, useCallback, useRef,
  api, useAgents, useTimeline, useSSE,
  avatar, avatarUrl,
  registerPage,
};
globalThis.WAO = WAO;
window.WAO = WAO;

// A broken page must not take the shell down: render through a guard so the
// failure becomes an attributed card, and every OTHER page stays reachable.
const PageView = ({ mod }) => {
  try {
    if (typeof mod.component !== 'function') {
      return h('p', { className: 'error' }, `页面 ${mod.id} 未提供 component`);
    }
    return mod.component({ WAO });
  } catch (err) {
    return h('p', { className: 'error' }, `页面 ${mod.id} 渲染失败：${err?.message ?? err}`);
  }
};

const EmptyState = () => h('div', {
  className: 'page',
  style: {
    background: 'var(--panel)',
    border: '1px solid var(--line)',
    borderRadius: 'var(--r-card)',
    padding: '48px 32px',
    textAlign: 'center',
    boxShadow: 'var(--shadow)',
  },
},
h('h2', { style: { fontSize: '18px', fontWeight: 700, margin: '0 0 8px' } }, '欢迎来到企微智能体工坊'),
h('p', { className: 'muted', style: { maxWidth: '440px', margin: '0 auto', fontSize: '13.5px' } },
  '系统正在同步长链接通道与加载智能体，请从左侧选择页面开始。'),
);

const pad2 = (n) => String(n).padStart(2, '0');
const PunchClock = () => {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  const { agents } = useAgents();
  const enabled = agents.filter((a) => a.enabled !== false);
  const onDuty = enabled.filter((a) => a.status === 'working' || a.status === 'idle');
  const todayOrders = agents.reduce((sum, a) => sum + (a.todayTurns ?? 0), 0);
  const clock = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  const link = (hash, title, ...children) => h('a', { className: 'clock-item', href: `#/${hash}`, title }, ...children);

  return h('div', { className: 'clockbar', role: 'status' },
    h('div', { className: 'clock-group-left' },
      link('workbench', `${onDuty.length} 个机器人在线（共 ${enabled.length} 个）`,
        h('span', { className: 'clock-pulse-dot' }),
        h('span', { className: 'clock-label' }, '在线:'),
        h('span', { className: 'clock-num' }, `${onDuty.length} / ${enabled.length || 6}`)),
      h('div', { className: 'clock-item' },
        h('span', { className: 'clock-label' }, '企微通道:'),
        h('span', { className: 'clock-num', style: { color: 'var(--ok)' } }, 'wss 在线')),
      link('workbench', `今天累计 ${todayOrders} 条消息`,
        h('span', { className: 'clock-label' }, '今日消息:'),
        h('span', { className: 'clock-num clock-capsule' }, todayOrders)),
    ),
    link('timeline', '查看今日活动',
      h('span', { className: 'clock-label' }, '实时时刻:'),
      h('span', { className: 'clock-num', style: { fontFamily: 'var(--mono)' } }, clock)),
  );
};

const Shell = () => {
  const [list, setList] = useState(() => [...pages.values()]);
  const [error, setError] = useState(null);
  const [loadErrors, setLoadErrors] = useState(() => new Map());
  const [sources, setSources] = useState([]);
  const [active, setActive] = useState(() => location.hash.slice(2) || null);

  pushPage = useCallback((desc) => {
    setList((prev) => (prev.some((p) => p.id === desc.id) ? prev : [...prev, desc]));
  }, []);

  useEffect(() => {
    const onHash = () => setActive(location.hash.slice(2) || null);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const loadPlugin = useCallback(async ({ id, entry }) => {
    try {
      const mod = (await import(entry))?.default;
      if (mod == null || typeof mod !== 'object') throw new Error('模块无 default 导出');
      registerPage({ ...mod, id: mod.id ?? id });
      setLoadErrors((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    } catch (err) {
      setLoadErrors((prev) => {
        const next = new Map(prev);
        next.set(id, err?.message ?? String(err));
        return next;
      });
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const state = await api('/api/state');
        const plugins = Array.isArray(state?.uiPlugins) ? state.uiPlugins : [];
        setSources(plugins);
        await Promise.all(plugins.map(loadPlugin));
      } catch (err) {
        setError(err?.message ?? String(err));
      }
    })();
  }, [loadPlugin]);

  const retry = (id) => {
    const src = sources.find((p) => p?.id === id);
    if (src != null) void loadPlugin(src);
  };

  const sorted = [...list].sort((a, b) => ((a.order ?? 10) - (b.order ?? 10)) || (a.id < b.id ? -1 : 1));
  const current = sorted.find((p) => p.id === active) ?? sorted[0] ?? null;
  const nav = (p) => h('a', {
    key: p.id,
    href: `#/${p.id}`,
    className: `nav-item${current?.id === p.id ? ' active' : ''}`,
  },
  h('span', { className: 'nav-icon' }, navIcon(h, p.icon)),
  h('span', null, p.title ?? p.id));

  return h('div', { className: 'shell' },
    h('nav', { className: 'sidebar' },
      h('div', { className: 'brand', title: 'WAO Console · WeCom Agent Office' },
        h('div', { className: 'brand-logo-glyph' },
          h('svg', { viewBox: '0 0 24 24' },
            h('path', { d: 'M3 21h18M3 7v14M21 7v14M9 21v-4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v4M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3M9 11h.01M15 11h.01M9 15h.01M15 15h.01' }),
          ),
        ),
        h('div', { className: 'brand-text' },
          h('div', { className: 'brand-name' },
            'WAO Console',
            h('span', { className: 'brand-badge' }, 'PRO'),
          ),
          h('div', { className: 'brand-sub' }, 'WeCom Agent Office'),
        ),
      ),
      sorted.length > 0 ? sorted.map(nav) : h('div', { className: 'nav-item muted' }, '（加载中…）'),
    ),
    h('main', { className: 'main' },
      h(PunchClock),
      error != null ? h('p', { className: 'error' }, error) : null,
      [...loadErrors.entries()].map(([id, msg]) => h('p', { key: id, className: 'error shell-error' },
        `加载页面插件 ${id} 失败：${msg} `,
        h('button', { className: 'shell-retry', onClick: () => retry(id) }, '重试'))),
      current != null ? h(PageView, { key: current.id, mod: current }) : h(EmptyState),
    ),
  );
};

initSdk(React);
globalThis.window.ReactDOM.createRoot(document.getElementById('root')).render(h(Shell));
