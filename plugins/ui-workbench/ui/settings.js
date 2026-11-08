// 设置 (v2 导航收敛): 低频操作聚合页，三个 section——工具库（_legacy/assets.js
// 整页内嵌：完整 CRUD + 绑定管理，深链 ?view=equip&bot= 仍有效）/ 插件
// （_legacy/plugins.js 整页内嵌：启用/禁用/重载）/ 系统信息（/healthz 版本 +
// /api/state 运行时间/PID/数据目录/插件与页面清单）。?section= 深链供截图。
import { ensurePageStyle } from './style.js';
import assetsPage from './_legacy/assets.js';
import pluginsPage from './_legacy/plugins.js';

const SECTION_IDS = ['assets', 'plugins', 'system'];
const SECTION_LABEL = { assets: '工具库', plugins: '插件', system: '系统信息' };

const fmtUptime = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400);
  const hh = String(Math.floor((s % 86400) / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return d > 0 ? `${d} 天 ${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`;
};

const SystemInfo = ({ WAO }) => {
  const { h, useState, useEffect, api } = WAO;
  const [health, setHealth] = useState(null);
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [loadedAt, setLoadedAt] = useState(null); // uptimeSec 快照时刻 → 活表走秒
  const [, setTick] = useState(0); // 每秒强制重渲染，驱动运行时间活表

  const refresh = async () => {
    setError(null);
    try {
      const [hz, st] = await Promise.all([
        api('/healthz').catch((err) => { throw err; }),
        api('/api/state'),
      ]);
      setHealth(hz);
      setState(st);
      setLoadedAt(Date.now());
    } catch (err) {
      setError(err?.message ?? String(err));
    }
  };
  useEffect(() => { void refresh(); }, []);

  // 运行时间活表：快照 uptimeSec + 本地流逝秒，每秒一跳（服务端值随下次刷新对齐）
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const row = (label, valueNode, hint) => h('tr', null,
    h('th', { scope: 'row' }, label, hint ? h('span', { className: 'wb-hint', style: { marginLeft: 8 } }, hint) : null),
    h('td', null, valueNode));

  const plugins = Array.isArray(state?.plugins) ? state.plugins : [];
  const counts = plugins.reduce((acc, p) => {
    acc[p.status] = (acc[p.status] ?? 0) + 1;
    return acc;
  }, {});
  const uiPlugins = Array.isArray(state?.uiPlugins) ? state.uiPlugins : [];
  const uptime = state?.uptimeSec != null && loadedAt != null
    ? fmtUptime(state.uptimeSec + (Date.now() - loadedAt) / 1000)
    : '—';

  return h('div', null,
    h('div', { className: 'wb-toolbar' },
      h('button', { className: 'wb-btn', onClick: () => void refresh() }, '刷新'),
      h('span', { className: 'wb-hint' }, '数据来自 /healthz 与 /api/state（只读）')),
    error != null ? h('div', { className: 'error', style: { marginTop: 12 } }, `读取系统信息失败：${error}`) : null,
    state == null && error == null ? h('p', { className: 'muted' }, '读取系统信息…') : null,
    state != null ? h('table', { className: 'wb-table' },
      h('tbody', null,
        row('版本', health?.version != null ? `wao v${health.version}` : '—', '/healthz'),
        row('运行时间', h('span', { className: 'wb-mono' }, uptime), '自服务启动起（实时走秒）'),
        row('进程', state?.pid != null ? h('span', { className: 'wb-mono' }, `pid ${state.pid}`) : '—'),
        row('数据目录', state?.dataDir != null
          ? h('span', { className: 'wb-mono', title: '机器人配置、台账与插件启停表都落在这里' }, state.dataDir)
          : h('span', { className: 'wb-hint' }, '（当前服务版本未通过 API 暴露——升级服务后可见）'), '/api/state'),
        row('插件', `${counts.active ?? 0} 运行中 · ${counts.disabled ?? 0} 已停用 · ${counts.failed ?? 0} 加载失败（共 ${plugins.length}）`, '启停去「插件」section'),
        row('页面插件', uiPlugins.length > 0
          ? uiPlugins.map((p) => p?.id).filter(Boolean).join('、')
          : '（无）', '本控制台的页面来源，内核托管于 /api/ui/<id>/'))) : null);
};

export default {
  id: 'settings',
  title: '设置',
  icon: 'settings',
  order: 3,
  component({ WAO }) {
    const { h, useState, useEffect } = WAO;
    ensurePageStyle();
    const [section, setSection] = useState('assets'); // 'assets' | 'plugins' | 'system'

    // ?section= 深链（截图基线用）
    useEffect(() => {
      const s = new URLSearchParams(location.search).get('section');
      if (SECTION_IDS.includes(s)) setSection(s);
    }, []);

    return h('div', { className: 'page' },
      h('h2', null, '设置'),
      h('p', { className: 'muted' }, '低频操作：工具库管理、插件启停与系统信息'),
      h('div', { className: 'wb-toolbar' },
        h('div', { className: 'wb-tabs' },
          SECTION_IDS.map((s) => h('button', {
            key: s,
            className: `wb-tab${section === s ? ' active' : ''}`,
            onClick: () => setSection(s),
          }, SECTION_LABEL[s]))),
        section === 'assets' ? h('span', { className: 'wb-hint' }, '清单增删改 + 按机器人配置（装备台）') : null),
      h('div', { key: section, style: { marginTop: 14 } },
        section === 'assets' ? h(assetsPage.component, { WAO })
        : section === 'plugins' ? h(pluginsPage.component, { WAO })
        : h(SystemInfo, { WAO })));
  },
};
