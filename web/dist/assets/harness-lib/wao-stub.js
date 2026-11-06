// WAO harness stub (DESIGN §9 截图工作流): the whole browser contract a page
// plugin needs, driven by FAKE data instead of the kernel. harness.html
// loads the vendored React UMD first, then imports this module same-origin
// (the kernel hosts it at /assets/harness-lib/wao-stub.js), then imports the
// page module under test — no build step, no server state, opaque-origin
// file:// pitfalls avoided. This is what makes "render a page, screenshot
// it, blind-review it" possible per plugin.
//
//   const stub = makeWAOStub({ agents: [ { id: 'bot-1', status: 'working',
//     progress: { line: '🔧 修复测试' } } ] });
//   const mod = await import('./index.js');
//   stub.render(mod.default, document.getElementById('root'));
//
// avatar/avatarUrl (redesign P1) come from the esbuild-bundled DiceBear lib
// (./avatar-lib.js, built by web/build.mjs) so harness faces == production
// faces, offline.
import { avatar, avatarUrl } from './avatar-lib.js';

export function makeWAOStub(fakeData = {}) {
  const React = globalThis.React;
  if (React == null) throw new Error('wao-stub: load /vendor/react.umd.js before the stub');

  const pages = [];

  // api(): deterministic fake responder. fakeData.api[path] may be a value or
  // a (body) => value function; returning a rejected promise exercises error
  // states. Lookup is exact-path first, then path-without-query — pages build
  // real query strings (bot=/chat=/session=), and a faked page state should
  // not have to enumerate every encoding of them. Unknown paths reject —
  // silence would hide a typo'd path.
  const api = (path, body) => {
    const table = fakeData.api ?? {};
    const stubbed = table[path] ?? table[String(path).split('?')[0]];
    if (stubbed !== undefined) {
      return typeof stubbed === 'function' ? Promise.resolve().then(() => stubbed(body)) : Promise.resolve(stubbed);
    }
    if (path === '/api/agents') return Promise.resolve({ agents: fakeData.agents ?? [] });
    if (path.startsWith('/api/timeline')) return Promise.resolve(fakeData.timeline ?? []);
    if (path === '/api/state') return Promise.resolve({ uiPlugins: fakeData.uiPlugins ?? [] });
    return Promise.reject(new Error(`harness stub: no fake data for ${path}`));
  };

  const useAgents = () => ({ agents: fakeData.agents ?? [], error: fakeData.agentsError ?? null });
  const useTimeline = () => ({ rows: fakeData.timeline ?? [], error: fakeData.timelineError ?? null });
  const useSSE = () => {}; // no live events under the stub — by design

  const WAO = {
    React, h: React.createElement,
    useState: React.useState, useEffect: React.useEffect, useCallback: React.useCallback,
    useRef: React.useRef, React,
    api, useAgents, useTimeline, useSSE,
    avatar, avatarUrl,
    registerPage: (desc) => { pages.push(desc); },
  };
  globalThis.window.WAO = WAO;

  // Same render contract as the shell: component({WAO}) is called inside a
  // wrapper component's render (hooks land legally), a throw becomes an
  // on-screen error instead of a blank screenshot.
  const render = (pageMod, mount) => {
    if (pageMod == null || typeof pageMod.component !== 'function') {
      throw new Error('wao-stub: page module default export needs a component({WAO})');
    }
    const Page = () => {
      try {
        return pageMod.component({ WAO });
      } catch (err) {
        return React.createElement('p', { className: 'error' }, `页面渲染失败：${err?.message ?? err}`);
      }
    };
    globalThis.window.ReactDOM.createRoot(mount).render(React.createElement(Page));
  };

  return { WAO, pages, render };
}
