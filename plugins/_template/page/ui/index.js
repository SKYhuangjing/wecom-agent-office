// No-build page entry (DESIGN §9): the shell (and every harness) dynamic-
// imports this module and renders `component({WAO})` — a plain function
// returning an h() tree, no JSX, no bare imports, React/SDK only via the
// injected WAO. This demo renders the live agent list, so the same code
// runs against the real kernel (via the shell) and against fake data (via
// ui/harness.html + the WAO stub).
const STATUS_LABEL = { working: '工作中', idle: '空闲', offline: '离线' };

export default {
  id: 'template-page',
  title: '模板页',
  icon: '▤',
  order: 50,
  component({ WAO }) {
    const { h, useAgents } = WAO;
    const { agents, error } = useAgents();
    return h('div', { className: 'page' },
      h('h2', null, '模板页'),
      h('p', { className: 'muted' }, '页面插件示例：读取 /api/agents 的实况列表（harness 下为假数据）。'),
      error != null
        ? h('p', { className: 'error' }, `加载失败：${error}`)
        : agents.length === 0
          ? h('p', { className: 'muted' }, '暂无 bot')
          : h('ul', { className: 'card-list' }, agents.map((a) => h('li', { key: a.id, className: 'card' },
            h('span', { className: `badge badge-${a.status ?? 'offline'}` }, STATUS_LABEL[a.status] ?? a.status ?? '未知'),
            h('strong', null, a.name ?? a.id),
            a.progress?.line ? h('span', { className: 'muted' }, a.progress.line) : null,
          ))),
    );
  },
};
