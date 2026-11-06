// WAO console shell (DESIGN §9): navigation/routing/theme + the window.WAO
// contract injection. Deliberately NO React import — index.html loads the
// single vendored UMD instance the shell AND every page plugin share (hooks
// crash across two React copies); esbuild only transforms JSX (factory h)
// and bundles sdk.js alongside.
const React = globalThis.React;
const { useState, useEffect, useCallback } = React;
const h = React.createElement; // JSX factory (build.mjs --jsx-factory=h)
import { api, initSdk, useAgents, useTimeline, useSSE } from './sdk.js';

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
  useState, useEffect, useCallback,
  api, useAgents, useTimeline, useSSE,
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

const EmptyState = () => h('div', { className: 'page' },
  h('h2', null, '无页面插件'),
  h('p', { className: 'muted' }, '当前内核没有声明 ui 目录的活跃插件。装一个页面插件或检查 plugins.json 启停表。'),
);

const Shell = () => {
  const [list, setList] = useState(() => [...pages.values()]);
  const [error, setError] = useState(null);
  const [active, setActive] = useState(() => location.hash.slice(2) || null);

  pushPage = useCallback((desc) => {
    setList((prev) => (prev.some((p) => p.id === desc.id) ? prev : [...prev, desc]));
  }, []);

  useEffect(() => {
    const onHash = () => setActive(location.hash.slice(2) || null);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const state = await api('/api/state');
        const plugins = Array.isArray(state?.uiPlugins) ? state.uiPlugins : [];
        await Promise.all(plugins.map(async ({ id, entry }) => {
          try {
            const mod = (await import(entry))?.default; // runtime URL: not bundled
            if (mod == null || typeof mod !== 'object') throw new Error('模块无 default 导出');
            registerPage({ ...mod, id: mod.id ?? id });
          } catch (err) {
            setError(`加载页面插件 ${id} 失败：${err?.message ?? err}`);
          }
        }));
      } catch (err) {
        setError(err?.message ?? String(err)); // state itself unreachable: say it once, loudly
      }
    })();
    // Bootstrap runs once: a reload-nudged refresh is a later task's concern.
  }, []);

  const sorted = [...list].sort((a, b) => ((a.order ?? 10) - (b.order ?? 10)) || (a.id < b.id ? -1 : 1));
  const current = sorted.find((p) => p.id === active) ?? sorted[0] ?? null;
  const nav = (p) => h('a', {
    key: p.id,
    href: `#/${p.id}`,
    className: `nav-item${current?.id === p.id ? ' active' : ''}`,
  }, h('span', { className: 'nav-icon' }, p.icon ?? '▪'), h('span', null, p.title ?? p.id));

  return h('div', { className: 'shell' },
    h('nav', { className: 'sidebar' },
      h('div', { className: 'brand' }, 'WAO Console'),
      sorted.length > 0 ? sorted.map(nav) : h('div', { className: 'nav-item muted' }, '（无页面）'),
    ),
    h('main', { className: 'main' },
      error != null ? h('p', { className: 'error' }, error) : null,
      current != null ? h(PageView, { key: current.id, mod: current }) : h(EmptyState),
    ),
  );
};

initSdk(React);
globalThis.window.ReactDOM.createRoot(document.getElementById('root')).render(h(Shell));
