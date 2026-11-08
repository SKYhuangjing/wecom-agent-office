// 插件 (M3 T3): runtime plugin manager over the kernel-native API — the table
// (GET /api/plugins), per-plugin enable/disable (POST /api/plugins/:id/enable|
// disable) and the four-phase reload (POST /api/service/reload). Disabling a
// provider/channel goes through a confirm dialog that names the bots it takes
// offline (counted from live /api/agents data against /api/ports owners — a
// port id need not match its registering plugin's id); reload warns that
// in-flight turns are interrupted with the maintenance copy.
import { ensurePageStyle } from './style.js';

const STATUS_LABEL = { active: '运行中', disabled: '已停用', failed: '加载失败' };
const TYPE_LABEL = { core: '内核', channel: '渠道', provider: '引擎插件', ui: '页面', middleware: '中间件', progressor: '进度器' };

// pluginId → { channels: [portId], providers: [portId] } from /api/ports
// owners. A null owner falls back to the port id itself (older data).
const ownedPortsOf = (ports) => {
  const map = new Map();
  const add = (owner, kind, id) => {
    const key = owner ?? id;
    if (!map.has(key)) map.set(key, { channels: [], providers: [] });
    map.get(key)[kind].push(id);
  };
  for (const c of ports?.channels ?? []) add(c.owner, 'channels', c.id);
  for (const p of ports?.providers ?? []) add(p.owner, 'providers', p.id);
  return map;
};

// How many live bots depend on this plugin (a bot uses the plugin's registered
// channel/provider ports; a core/ui plugin never takes a bot offline).
const affectedBots = (plugin, agents, ownedPorts) => {
  const ids = ownedPorts.get(plugin.id);
  const chanIds = new Set(ids?.channels ?? []);
  const provIds = new Set(ids?.providers ?? []);
  if (chanIds.size === 0 && plugin.type === 'channel') chanIds.add(plugin.id); // owner-less fallback
  if (provIds.size === 0 && plugin.type === 'provider') provIds.add(plugin.id);
  return agents.filter((a) => chanIds.has(a.channel) || provIds.has(a.provider));
};

export default {
  id: 'plugins',
  title: '插件管理',
  icon: '🧰',
  order: 6,
  component({ WAO }) {
    const { h, useState, useEffect, api, useAgents } = WAO;
    ensurePageStyle();
    const { agents } = useAgents();

    const [plugins, setPlugins] = useState(null);
    const [ports, setPorts] = useState(null); // owner map source for impact calc
    const [error, setError] = useState(null);
    const [busyId, setBusyId] = useState(null);
    const [reloading, setReloading] = useState(false);
    const [confirm, setConfirm] = useState(null); // {kind:'disable'|'reload', plugin}

    const refresh = async () => {
      try {
        // /api/ports may 404 when core-engine is itself disabled mid-session —
        // the impact calc then degrades to owner-less matching, not a dead page.
        const [data, portsData] = await Promise.all([
          api('/api/plugins'),
          api('/api/ports').catch(() => null),
        ]);
        setPlugins(Array.isArray(data?.plugins) ? data.plugins : []);
        setPorts(portsData);
        setError(null);
      } catch (err) {
        setError(err?.message ?? String(err));
      }
    };

    useEffect(() => { void refresh(); }, []);

    // Harness deep-link (?disable=<id>): pre-open the confirm dialog so the
    // modal state is screenshot-deterministic (same pattern as bots.js ?select).
    useEffect(() => {
      const want = new URLSearchParams(location.search).get('disable');
      if (want == null || want === '' || plugins == null || confirm != null) return;
      const plugin = plugins.find((p) => p.id === want);
      if (plugin != null && plugin.status === 'active') setConfirm({ kind: 'disable', plugin });
    }, [plugins]);

    const act = async (plugin, action) => {
      setBusyId(plugin.id);
      setError(null);
      try {
        const data = await api(`/api/plugins/${encodeURIComponent(plugin.id)}/${action}`, {});
        if (Array.isArray(data?.plugins)) setPlugins(data.plugins);
        else await refresh();
      } catch (err) {
        setError(`${action === 'disable' ? '停用' : '启用'} ${plugin.id} 失败：${err?.message ?? err}`);
        await refresh(); // the four-phase reload may have half-applied: re-read truth
      } finally {
        setBusyId(null);
        setConfirm(null);
      }
    };

    const doReload = async () => {
      setReloading(true);
      setError(null);
      try {
        await api('/api/service/reload', {});
        await refresh();
      } catch (err) {
        setError(`重载失败：${err?.message ?? err}`);
        await refresh();
      } finally {
        setReloading(false);
        setConfirm(null);
      }
    };

    if (plugins == null && error == null) {
      return h('div', { className: 'page' }, h('h2', null, '插件管理'), h('p', { className: 'muted' }, '读取中…'));
    }

    const askDisable = (plugin) => setConfirm({ kind: 'disable', plugin });
    const ownedPorts = ownedPortsOf(ports);
    const affected = confirm?.kind === 'disable' ? affectedBots(confirm.plugin, agents, ownedPorts) : [];
    const modal = confirm == null ? null : h('div', { className: 'wb-modal-wrap', onClick: () => { if (!busyId && !reloading) setConfirm(null); } },
      h('div', { className: 'wb-modal', onClick: (e) => e.stopPropagation() },
        confirm.kind === 'disable'
          ? h('div', null,
              h('h3', null, `停用 ${confirm.plugin.id}${confirm.plugin.name ? `（${confirm.plugin.name}）` : ''}？`),
              affected.length > 0
                ? h('div', { className: 'wb-notice' },
                    `这个${TYPE_LABEL[confirm.plugin.type] ?? confirm.plugin.type}支撑着 ${affected.length} 个机器人（${affected.map((a) => a.name ?? a.id).join('、')}）——停用后它们会立即离线，手上在跑的活会以维护说明收尾。`)
                : h('p', { className: 'wb-hint' }, '停用会走四阶段重载：先让在跑的活收尾，再卸载这个插件。当前没有机器人直接依赖它。'))
          : h('div', null,
              h('h3', null, '重新加载全部插件？'),
              h('div', { className: 'wb-notice' }, '重载会中断正在运行的消息（用户会收到维护提示），随后全部插件按依赖顺序重新加载。')),
        h('div', { className: 'wb-toolbar' },
          h('button', {
            className: 'wb-btn wb-btn-primary',
            disabled: busyId != null || reloading,
            onClick: () => (confirm.kind === 'disable' ? void act(confirm.plugin, 'disable') : void doReload()),
          }, busyId != null || reloading ? '执行中…' : confirm.kind === 'disable' ? '确认停用' : '确认重载'),
          h('button', { className: 'wb-btn', disabled: busyId != null || reloading, onClick: () => setConfirm(null) }, '取消'))));

    const pluginRow = (p) => h('tr', { key: p.id },
      h('td', null,
        h('div', null, p.name ?? '（未命名）'),
        h('div', { className: 'wb-sub' }, p.id)),
      h('td', null, TYPE_LABEL[p.type] ?? p.type ?? '—'),
      h('td', null, p.version ?? '—'),
      h('td', null,
        h('span', {
          className: `badge wb-badge-${p.status}`,
          title: p.status === 'failed' && p.error ? `失败原因：${p.error}` : undefined,
        }, STATUS_LABEL[p.status] ?? p.status),
        p.status === 'failed' && p.error ? h('div', { className: 'wb-sub wb-field-error' }, p.error) : null),
      h('td', null,
        p.status === 'active'
          ? h('button', {
              className: 'wb-btn', disabled: busyId === p.id, onClick: () => setConfirm({ kind: 'disable', plugin: p }),
            }, busyId === p.id ? '处理中…' : '停用')
          : h('button', {
              className: 'wb-btn', disabled: busyId === p.id,
              onClick: () => void act(p, 'enable'),
              title: p.status === 'disabled' ? '重新启用并四阶段重载' : undefined,
            }, busyId === p.id ? '处理中…' : '启用')));

    const table = plugins == null || plugins.length === 0 ? null : h('table', { className: 'wb-table' },
      h('thead', null, h('tr', null,
        h('th', null, '插件'), h('th', null, '类型'), h('th', null, '版本'), h('th', null, '状态'), h('th', null, '操作'))),
      h('tbody', null, plugins.map(pluginRow)));

    return h('div', { className: 'page' },
      h('h2', null, '插件管理'),
      h('p', { className: 'muted' }, '系统的基础组件：渠道、引擎、页面都在这张表上'),
      h('div', { className: 'wb-toolbar' },
        h('button', { className: 'wb-btn', disabled: reloading, onClick: () => setConfirm({ kind: 'reload' }) },
          reloading ? '重载中…' : '重新加载'),
        h('button', { className: 'wb-btn', disabled: reloading, onClick: () => void refresh() }, '刷新')),
      h('p', { className: 'wb-hint' }, '启停即时生效（写 plugins.json 并触发四阶段重载）；停用引擎/渠道插件会带走依赖它的机器人。'),
      error != null ? h('div', { className: 'error', style: { marginTop: 12 } }, error) : null,
      table == null && error == null
        ? h('div', { className: 'wb-empty' }, h('p', null, '一个插件都没有——检查插件目录与 plugins.json 启停表。'))
        : table,
      modal);
  },
};
