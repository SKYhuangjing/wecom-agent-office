// 工作台 (M3 T2): live bot cards — status badge (working/idle/offline + reason
// tooltip), SSE-driven progress line, today stats, enable switch and edit /
// test-run shortcuts. Data comes from useAgents (SSE nudge + 5s poll); the
// retry button remounts the inner component so a hard failure (server down)
// can be re-armed manually instead of waiting for the next poll.
import { ensurePageStyle } from './style.js';

const STATUS_LABEL = { working: '工作中', idle: '空闲', offline: '离线' };
// Cross-page handoff (shell routing is bare '#/<pageid>'): the sender stashes
// {action, id} here before flipping the hash; the bots page consumes it once.
export const HANDOFF_KEY = 'wao-workbench-handoff';

export const goBots = (action, id) => {
  try {
    sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ action, id }));
    location.hash = '#/bots';
  } catch { /* storage disabled: plain navigation still works */ }
};

const WorkbenchInner = ({ WAO, retry }) => {
  const { h, useAgents, api, useState } = WAO;
  const { agents, error } = useAgents();
  const [busyId, setBusyId] = useState(null);
  const [actionError, setActionError] = useState(null);

  const toggle = async (agent) => {
    setBusyId(agent.id);
    setActionError(null);
    try {
      await api(`/api/bots/${encodeURIComponent(agent.id)}/toggle`, {});
    } catch (err) {
      setActionError(`启停「${agent.name ?? agent.id}」失败：${err?.message ?? err}`);
    } finally {
      setBusyId(null);
    }
  };

  if (error != null) {
    return h('div', { className: 'page' },
      h('h2', null, '工作台'),
      h('div', { className: 'error' }, `加载机器人列表失败：${error}`),
      h('div', { className: 'wb-toolbar' },
        h('button', { className: 'wb-btn wb-btn-primary', onClick: retry }, '重试'),
        h('span', { className: 'wb-hint' }, '后台仍会每 5 秒自动重试')),
    );
  }

  if (agents.length === 0) {
    return h('div', { className: 'page' },
      h('h2', null, '工作台'),
      h('div', { className: 'wb-empty' },
        h('p', null, '还没有机器人——去 Bot 管理创建'),
        h('button', { className: 'wb-btn wb-btn-primary', onClick: () => goBots('new', null) }, '去 Bot 管理'),
      ),
    );
  }

  return h('div', { className: 'page' },
    h('h2', null, '工作台'),
    h('p', { className: 'muted' }, '机器人实况——状态与进度自动刷新'),
    actionError != null ? h('div', { className: 'error' }, actionError) : null,
    h('div', { className: 'wb-grid' },
      agents.map((a) => {
        const status = a.status ?? 'offline';
        const badge = h('span', {
          className: `badge badge-${status}`,
          title: status === 'offline' && a.reason ? `离线原因：${a.reason}` : undefined,
        }, STATUS_LABEL[status] ?? status);
        const working = status === 'working';
        return h('div', { key: a.id, className: 'wb-card' },
          h('div', { className: 'wb-card-head' },
            h('div', { style: { flex: '1', minWidth: '0' } },
              h('div', { className: 'wb-name' }, a.name ?? a.id),
              h('div', { className: 'wb-sub' }, `${a.provider ?? '?'} · ${a.channel ?? '?'} · ${a.id}`)),
            badge,
            h('label', {
              className: 'wb-switch',
              title: a.enabled === false ? '已停用——点击启用（保存后立即连接）' : '已启用——点击停用（在跑任务补完终帧后断开）',
            },
              h('input', {
                type: 'checkbox', checked: a.enabled !== false, disabled: busyId === a.id,
                onChange: () => toggle(a),
              }),
              h('span', { className: 'wb-track' })),
          ),
          h('div', { className: 'wb-progress' },
            a.progress?.line ?? (working ? '运行中…' : '')),
          status === 'offline' && a.reason ? h('div', { className: 'wb-reason' }, `离线原因：${a.reason}`) : null,
          h('div', { className: 'wb-stats' },
            h('span', null, '今日轮次 ', h('b', null, a.todayTurns ?? 0)),
            h('span', null, '用户 ', h('b', null, a.users ?? 0)),
            h('span', null, '会话 ', h('b', null, a.chats ?? 0))),
          h('div', { className: 'wb-actions' },
            h('button', { className: 'wb-btn', onClick: () => goBots('edit', a.id) }, '编辑'),
            h('button', { className: 'wb-btn', onClick: () => goBots('test', a.id) }, '试跑')),
        );
      })),
  );
};

export default {
  id: 'workbench',
  title: '工作台',
  icon: '▦',
  order: 1,
  component({ WAO }) {
    const { h, useState } = WAO;
    ensurePageStyle();
    const [nonce, setNonce] = useState(0);
    return h(WorkbenchInner, {
      key: nonce,
      WAO,
      retry: () => setNonce((n) => n + 1), // remount → fresh useAgents fetch
    });
  },
};
