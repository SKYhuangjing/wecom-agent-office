// 办公室页 — Magpie AgentOffice（2D / ISO / 3D WebGL）替换旧 ofscene。
// 契约：no-build ESM、window.WAO、useAgents。Harness: ?dim=2d|iso|3d、?scene=、?quality=
// 旧 ofscene 实现保留在 ui/legacy/（单测仍锁引擎数学）。

import { loadMagpie } from './load-vendor.js';
import {
  mapAgents, STATUS_LABEL, STATUS_DOT, elapsed, isOff, providerBrand,
} from './agents-map.js';

const CSS_ID = 'wao-ui-office3d-magpie';
const PAGE_CSS = `
.of-stage {
  position: relative; height: calc(100vh - 158px); min-height: 520px;
  border: 1px solid var(--line); border-radius: 10px; overflow: hidden;
  background: #0b1220; user-select: none; box-shadow: var(--shadow);
  display: grid; grid-template-columns: 1fr minmax(240px, 280px);
}
@media (max-width: 900px) {
  .of-stage { grid-template-columns: 1fr; grid-template-rows: minmax(360px, 1fr) minmax(200px, 40%); }
}
.of-viewport { position: relative; min-height: 0; overflow: hidden; background: #0b1220; }
.of-viewport canvas {
  position: absolute; inset: 0; width: 100%; height: 100%; display: block;
  touch-action: none; cursor: grab;
}
.of-viewport canvas[hidden] { display: none !important; }
.of-otags { position: absolute; inset: 0; overflow: hidden; pointer-events: none; z-index: 2; }
.of-tag {
  position: absolute; transform: translate(-50%, -120%);
  pointer-events: none; white-space: nowrap;
  padding: 4px 9px; border-radius: 999px; border: 1px solid #3f3f46;
  background: rgba(24, 24, 27, .88); color: #fff;
  font: 600 11px/1.3 -apple-system,"PingFang SC",sans-serif;
  box-shadow: 0 8px 20px rgb(0 0 0 / .25);
}
.of-tag i {
  display: inline-block; width: 7px; height: 7px; border-radius: 50%;
  margin-right: 6px; vertical-align: 0; background: #a1a1aa;
}
.of-hud {
  position: absolute; top: 12px; left: 12px; right: 12px; z-index: 4;
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center; pointer-events: none;
}
.of-hud > * { pointer-events: auto; }
.of-seg {
  display: inline-flex; gap: 2px; padding: 3px; border-radius: 8px;
  background: rgba(39, 39, 42, .92); border: 1px solid #3f3f46;
}
.of-seg button {
  border-radius: 6px;
  border: 0; background: transparent; color: #a1a1aa;
  font: 600 12px/1 -apple-system,"PingFang SC",sans-serif;
  padding: 6px 10px; border-radius: 8px; cursor: pointer;
}
.of-seg button.on { background: #3f3f46; color: #fff; }
.of-seg button:disabled { opacity: .35; cursor: not-allowed; }
.of-pill {
  font: 600 12px/1 -apple-system,"PingFang SC",sans-serif; color: #d4d4d8;
  background: rgba(39, 39, 42, .92); border: 1px solid #3f3f46;
  border-radius: 999px; padding: 6px 10px;
}
.of-pill em { font-style: normal; color: #fff; }
.of-grow { flex: 1; }
.of-hint {
  position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%);
  background: rgba(15,23,42,.82); color: #a1a1aa; font-size: 12px;
  border: 1px solid #3f3f46; border-radius: 999px; padding: 6px 12px;
  pointer-events: none; z-index: 3; white-space: nowrap;
}
.of-side {
  background: #18181b; border-left: 1px solid #27272a;
  padding: 12px; overflow: auto; color: #e4e4e7;
}
@media (max-width: 900px) { .of-side { border-left: 0; border-top: 1px solid #27272a; } }
.of-side h2 {
  margin: 0 0 10px; font-size: 11px; letter-spacing: .14em;
  text-transform: uppercase; color: #71717a;
}
.of-card {
  border: 1px solid #27272a; border-radius: 10px; padding: 10px 12px;
  margin-bottom: 8px; background: #18181b; cursor: pointer; color: inherit;
  text-align: left; width: 100%; font: inherit;
}
.of-card:hover, .of-card.on { border-color: #059669; }
.of-card .nm { font-weight: 700; font-size: 13.5px; }
.of-card .meta { color: #a1a1aa; font-size: 11px; margin-top: 2px; font-family: ui-monospace, monospace; }
.of-card .task { color: #d4d4d8; font-size: 12.5px; margin-top: 6px; overflow-wrap: anywhere; }
.of-st { float: right; font-size: 10px; font-weight: 700; padding: 3px 7px; border-radius: 999px; }
.of-st-w { background: #1d4ed833; color: #6ee7b7; }
.of-st-i { background: #3f3f46; color: #a1a1aa; }
.of-st-o { background: #7f1d1d55; color: #fca5a5; }
.of-empty {
  position: absolute; inset: 0; display: grid; place-items: center; z-index: 5; pointer-events: none;
}
.of-empty .card {
  background: #18181b; border: 1px dashed #3f3f46; padding: 22px 30px; border-radius: 12px;
  color: #e4e4e7; max-width: 360px; text-align: center;
}
.of-empty .muted { color: #a1a1aa; font-size: 13px; }
.of-pop {
  position: absolute; left: 12px; bottom: 48px; z-index: 6; max-width: min(420px, 92%);
  background: rgba(24, 24, 27, .95); border: 1px solid #3f3f46; border-radius: 10px;
  padding: 12px 14px; color: #e4e4e7; box-shadow: 0 16px 40px rgb(0 0 0 / .35);
}
.of-pop .head { display: flex; align-items: center; gap: 8px; }
.of-pop .head b { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.of-pop .line { font-size: 13px; overflow-wrap: anywhere; margin-top: 8px; }
.of-pop .sub { font-size: 12px; color: #a1a1aa; margin-top: 4px; }
.of-pop .close {
  border: 0; background: transparent; color: #a1a1aa; cursor: pointer; font-size: 14px; padding: 2px 6px;
}
.of-pop .close:hover { color: #fca5a5; }
.of-badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; border: 1px solid #3f3f46; }
.of-badge-w { color: #6ee7b7; border-color: #059669; }
.of-badge-i { color: #d4d4d8; border-color: #71717a; } /* 同族 zinc，深底对比 ~7:1 */
.of-badge-o { color: #f87171; border-color: #dc2626; }
.of-err { position: absolute; top: 56px; left: 12px; z-index: 5; max-width: 60%; }
.of-boot {
  position: absolute; inset: 0; display: grid; place-items: center;
  color: #a1a1aa; font-size: 13px; z-index: 1;
}
`;

function ensureStyle() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(CSS_ID)) return;
  const el = document.createElement('style');
  el.id = CSS_ID;
  el.textContent = PAGE_CSS;
  document.head.appendChild(el);
}

function parseDim(raw) {
  if (raw === '2d' || raw === 'iso' || raw === '3d') return raw;
  return 'iso'; // harness 默认 iso（兼容旧截图工作流无 dim 参数）
}

function stCls(status) {
  return status === 'working' ? 'of-st-w' : status === 'idle' ? 'of-st-i' : 'of-st-o';
}

function hintFor(dim) {
  if (dim === '3d') return '拖拽旋转 · 滚轮缩放 · 双击复位 · 点侧栏或小人选中';
  if (dim === 'iso') return '拖拽平移 · 滚轮缩放 · ISO 等距画布';
  return '拖拽平移 · 滚轮缩放 · 俯视 2D';
}

export default {
  id: 'office3d',
  title: '办公室',
  icon: 'building',
  order: 5,
  // v2 导航收敛：不再占导航位，由「总览」页通过 WAO.getPage('office3d')
  // 内嵌渲染；本插件保持独立注册（#/office3d 深链与自带 harness 仍可用）。
  hidden: true,
  component({ WAO }) {
    ensureStyle();
    // useRef 不在 WAO hook 表面 — 与 legacy office 一样从共享 React 取
    const { h, useState, useEffect, useAgents, React } = WAO;
    const useRef = React.useRef;
    const { agents, error } = useAgents();
    const params = typeof location !== 'undefined'
      ? new URLSearchParams(location.search)
      : new URLSearchParams();

    const [dim, setDim] = useState(() => parseDim(params.get('dim')));
    const [sceneId, setSceneId] = useState(() => params.get('scene') || 'office');
    const [quality, setQuality] = useState(() => params.get('quality') || 'high');
    const [sel, setSel] = useState(null);
    const [ready, setReady] = useState(false);
    const [bootErr, setBootErr] = useState(null);
    const [themes, setThemes] = useState([]);

    const canvas2Ref = useRef(null);
    const canvas3Ref = useRef(null);
    const tagsRef = useRef(null);
    const apiRef = useRef(null); // { scene2, scene3, active, Scene3D, scene3Failed }
    const agentsRef = useRef(agents);
    agentsRef.current = agents ?? [];
    const selRef = useRef(sel);
    selRef.current = sel;
    const dimRef = useRef(dim);
    dimRef.current = dim;
    const sceneIdRef = useRef(sceneId);
    sceneIdRef.current = sceneId;
    const qualityRef = useRef(quality);
    qualityRef.current = quality;

    const mapped = mapAgents(agents);
    const nWork = (agents ?? []).filter((a) => a.status === 'working').length;
    const nIdle = (agents ?? []).filter((a) => a.status === 'idle').length;
    const nOff = (agents ?? []).filter((a) => a.status === 'offline' || a.enabled === false).length;

    useEffect(() => {
      let dead = false;
      const api = {
        scene2: null, scene3: null, active: null, Scene3D: null, scene3Failed: false,
      };
      apiRef.current = api;

      const pushAgents = (target) => {
        if (!target?.setAgents) return;
        try { target.setAgents(mapAgents(agentsRef.current)); }
        catch (e) { console.error('setAgents failed', e); }
      };

      const onFrame = (anchors) => {
        const layer = tagsRef.current;
        if (!layer || !api.active) return;
        const byKey = Object.fromEntries((agentsRef.current ?? []).map((a) => [a.id, a]));
        const keep = new Set();
        for (const an of anchors || []) {
          if (an.visible === false) continue;
          keep.add(an.key);
          let el = layer.querySelector(`[data-k="${CSS.escape(an.key)}"]`);
          if (!el) {
            el = document.createElement('div');
            el.className = 'of-tag';
            el.dataset.k = an.key;
            layer.appendChild(el);
          }
          const a = byKey[an.key];
          const st = a?.status || 'offline';
          el.innerHTML = `<i style="background:${STATUS_DOT[st] || '#a1a1aa'}"></i>${a?.name || an.key}`;
          el.style.left = `${an.x}px`;
          el.style.top = `${an.y}px`;
        }
        for (const el of [...layer.children]) {
          if (el.classList.contains('of-tag') && !keep.has(el.dataset.k)) el.remove();
        }
      };

      const ensure2 = (Scene) => {
        if (api.scene2) return api.scene2;
        const canvas = canvas2Ref.current;
        if (!canvas || !Scene) return null;
        api.scene2 = new Scene(canvas, {
          dim: dimRef.current === '2d' ? '2d' : '3d',
          onFrame: (anchors) => { if (api.active === api.scene2) onFrame(anchors); },
        });
        pushAgents(api.scene2);
        return api.scene2;
      };

      const ensure3 = (Scene3D) => {
        if (api.scene3Failed) return null;
        if (api.scene3?.available) return api.scene3;
        const canvas = canvas3Ref.current;
        if (!canvas || !Scene3D?.isSupported?.()) {
          api.scene3Failed = true;
          return null;
        }
        try {
          api.scene3 = new Scene3D(canvas, {
            scene: sceneIdRef.current,
            quality: qualityRef.current,
            agents: mapAgents(agentsRef.current),
            onFrame: (anchors) => { if (api.active === api.scene3) onFrame(anchors); },
          });
          if (!api.scene3.available) {
            try { api.scene3.dispose(); } catch { /* */ }
            api.scene3 = null;
            api.scene3Failed = true;
            return null;
          }
        } catch {
          api.scene3 = null;
          api.scene3Failed = true;
          return null;
        }
        return api.scene3;
      };

      const activate = () => {
        const layer = tagsRef.current;
        if (layer) layer.innerHTML = '';
        const want3 = dimRef.current === '3d';
        const s3 = want3 ? ensure3(api.Scene3D) : null;

        if (s3) {
          try { api.scene2?.stop?.(); } catch { /* */ }
          if (canvas2Ref.current) canvas2Ref.current.hidden = true;
          if (canvas3Ref.current) {
            canvas3Ref.current.hidden = false;
            void canvas3Ref.current.offsetWidth;
          }
          try { s3.resize?.(); } catch { /* */ }
          try { s3.start?.(); } catch { /* */ }
          if (s3.id !== sceneIdRef.current) s3.setScene(sceneIdRef.current);
          pushAgents(s3);
          if (selRef.current && s3.setSelected) s3.setSelected(selRef.current);
          api.active = s3;
          return s3;
        }

        if (want3 && api.scene3Failed) {
          dimRef.current = 'iso';
          setDim('iso');
        }
        try { api.scene3?.stop?.(); } catch { /* */ }
        if (canvas2Ref.current) {
          canvas2Ref.current.hidden = false;
          void canvas2Ref.current.offsetWidth;
        }
        if (canvas3Ref.current) canvas3Ref.current.hidden = true;
        const s2 = ensure2(api.Scene);
        if (!s2) { api.active = null; return null; }
        s2.setDim(dimRef.current === '2d' ? '2d' : '3d');
        pushAgents(s2);
        s2.resize();
        s2.start();
        api.active = s2;
        requestAnimationFrame(() => { try { s2.resize(); } catch { /* */ } });
        return s2;
      };

      api.activate = activate;
      api.pushAgents = pushAgents;

      (async () => {
        try {
          const { Scene, Scene3D } = await loadMagpie();
          if (dead) return;
          api.Scene = Scene;
          api.Scene3D = Scene3D;
          const ids = Scene3D?.SCENE_IDS || ['office', 'station', 'cafe', 'castle', 'pirate', 'graveyard'];
          setThemes(ids.map((id) => ({
            id,
            label: Scene3D.THEMES?.[id]?.label || id,
          })));
          activate();
          setReady(true);
        } catch (e) {
          if (!dead) setBootErr(e?.message || String(e));
        }
      })();

      const onResize = () => {
        try { api.scene2?.resize?.(); } catch { /* */ }
        try { api.scene3?.resize?.(); } catch { /* */ }
      };
      addEventListener('resize', onResize);

      const bindHit = (canvas) => {
        if (!canvas) return () => {};
        const onUp = (e) => {
          if (!api.active?.hit || api.active.dragged) return;
          const rect = canvas.getBoundingClientRect();
          const key = api.active.hit(e.clientX - rect.left, e.clientY - rect.top);
          if (key) setSel((cur) => (cur === key ? null : key));
        };
        canvas.addEventListener('pointerup', onUp);
        return () => canvas.removeEventListener('pointerup', onUp);
      };
      const off2 = bindHit(canvas2Ref.current);
      const off3 = bindHit(canvas3Ref.current);

      return () => {
        dead = true;
        removeEventListener('resize', onResize);
        off2(); off3();
        try { api.scene2?.stop?.(); } catch { /* */ }
        try { api.scene3?.stop?.(); } catch { /* */ }
        try { api.scene3?.dispose?.(); } catch { /* */ }
        apiRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
      const api = apiRef.current;
      if (!api?.activate || !ready) return;
      api.pushAgents?.(api.active);
      if (api.active?.setSelected) api.active.setSelected(sel ?? null);
    }, [agents, sel, ready]);

    useEffect(() => {
      const api = apiRef.current;
      if (!api?.activate || !ready) return;
      api.activate();
    }, [dim, sceneId, ready]);

    useEffect(() => {
      const api = apiRef.current;
      if (!api?.scene3 || !ready || dim !== '3d') return;
      try { api.scene3.setQuality?.(quality); } catch { /* */ }
    }, [quality, ready, dim]);

    const selAgent = (agents ?? []).find((a) => a.id === sel);

    return h('div', { className: 'of-stage' },
      h('div', { className: 'of-viewport' },
        h('canvas', { ref: canvas2Ref, 'aria-label': 'ISO / 2D' }),
        h('canvas', { ref: canvas3Ref, hidden: true, 'aria-label': 'WebGL 3D' }),
        h('div', { className: 'of-otags', ref: tagsRef }),
        !ready && !bootErr ? h('div', { className: 'of-boot' }, '加载办公室引擎…') : null,
        bootErr ? h('div', { className: 'of-boot' }, `引擎加载失败：${bootErr}`) : null,
        error != null ? h('div', { className: 'error of-err' }, `加载同事列表失败：${error}`) : null,
        h('div', { className: 'of-hud' },
          h('div', { className: 'of-seg', role: 'tablist', 'aria-label': '视角' },
            ['2d', 'iso', '3d'].map((d) => h('button', {
              key: d, type: 'button',
              className: dim === d ? 'on' : '',
              onClick: () => setDim(d),
            }, d.toUpperCase()))),
          dim === '3d' && themes.length
            ? h('div', { className: 'of-seg', role: 'tablist', 'aria-label': '3D 场景' },
              themes.map((t) => h('button', {
                key: t.id, type: 'button',
                className: sceneId === t.id ? 'on' : '',
                onClick: () => setSceneId(t.id),
              }, t.label)))
            : null,
          dim === '3d'
            ? h('div', { className: 'of-seg', 'aria-label': '画质' },
              ['low', 'medium', 'high'].map((q) => h('button', {
                key: q, type: 'button',
                className: quality === q ? 'on' : '',
                onClick: () => setQuality(q),
              }, q === 'medium' ? 'Med' : q[0].toUpperCase() + q.slice(1))))
            : null,
          h('span', { className: 'of-grow' }),
          h('span', { className: 'of-pill' }, '在岗 ', h('em', null, nWork)),
          h('span', { className: 'of-pill' }, '待命 ', h('em', null, nIdle)),
          h('span', { className: 'of-pill' }, '休假 ', h('em', null, nOff)),
        ),
        h('div', { className: 'of-hint' }, hintFor(dim)),
        (agents ?? []).length === 0 && error == null
          ? h('div', { className: 'of-empty' },
            h('div', { className: 'card' },
              h('p', null, '空的办公室——第一位同事入职后就会搬进来'),
              h('p', { className: 'muted' }, '去「机器人」页办理入职，它将出现在工位上')))
          : null,
        selAgent ? (() => {
          const off = isOff(selAgent);
          const cls = selAgent.status === 'working' ? 'of-badge-w' : off ? 'of-badge-o' : 'of-badge-i';
          const pv = providerBrand(selAgent.provider);
          return h('aside', { className: 'of-pop', style: { borderColor: pv.color } },
            h('div', { className: 'head' },
              h('b', null, selAgent.name || selAgent.id),
              h('span', {
                className: 'badge of-badge ' + cls,
                title: `状态：${selAgent.status ?? 'offline'}${selAgent.reason ? `\n原因：${selAgent.reason}` : ''}`,
              }, STATUS_LABEL[selAgent.status] ?? selAgent.status),
              h('button', { className: 'close', type: 'button', onClick: () => setSel(null) }, '✕')),
            selAgent.progress?.line
              ? h('div', { className: 'line' }, selAgent.progress.line)
              : h('div', { className: 'sub' }, off && selAgent.reason ? `离岗原因：${selAgent.reason}` : '手上暂无进行中的工单'),
            selAgent.progress?.startedAt
              ? h('div', { className: 'sub' }, '⏱ 已进行 ' + elapsed(Date.now() - selAgent.progress.startedAt))
              : null,
            h('div', { className: 'sub' },
              `今日工单 ${selAgent.todayTurns ?? 0} · 服务同事 ${selAgent.users ?? 0} · 档案 ${selAgent.chats ?? 0}`),
            h('div', { className: 'sub' }, `${pv.name} · ${selAgent.id}`));
        })() : null,
      ),
      h('aside', { className: 'of-side' },
        h('h2', null, '花名册'),
        mapped.length === 0
          ? h('p', { style: { color: '#a1a1aa', fontSize: '13px' } }, '暂无同事')
          : mapped.map((m) => {
            const st = m.wao.status;
            return h('button', {
              key: m.key,
              type: 'button',
              className: 'of-card' + (sel === m.key ? ' on' : ''),
              onClick: () => setSel((cur) => (cur === m.key ? null : m.key)),
            },
            h('span', { className: 'of-st ' + stCls(st) }, STATUS_LABEL[st] ?? st),
            h('div', { className: 'nm' }, m.title),
            h('div', { className: 'meta' }, `${m.sub} · ${m.key}`),
            h('div', { className: 'task' }, m.step));
          }),
      ),
    );
  },
};
