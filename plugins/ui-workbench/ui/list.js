// 今日工作 (company-metaphor redesign P3): live 同事卡片——化身头像(provider
// 色环)+岗位称呼+状态(工作中 provider 色脉动/待命/休假)+工作汇报(SSE 进度行)
// +今日统计。开关文案=调休/返岗。数据来自 useAgents（SSE+5s 轮询）；retry
// 重挂内层组件让硬失败可手动重试。
import { ensurePageStyle } from './style.js';
import { Avatar, STATUS_LABEL, statusTitle, providerMeta } from './hr.js';

// Cross-page handoff (shell routing is bare '#/<pageid>'): the sender stashes
// {action, id} here before flipping the hash; the bots page consumes it once.
export const HANDOFF_KEY = 'wao-workbench-handoff';

// P2-3: the SDK's SSE-disconnect error is a complete sentence
// （连接已断开——后台每 5 秒自动重试）— it must not get a「加载 X 失败」prefix
// on top. Request failures keep the prefixed「加载 X 失败：<原因>」shape.
export const bannerText = (prefix, error) =>
  (String(error ?? '').startsWith('连接已断开') ? String(error) : `${prefix}${error}`);

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
      setActionError(`办理「${agent.name ?? agent.id}」的调休/返岗失败：${err?.message ?? err}`);
    } finally {
      setBusyId(null);
    }
  };

  if (error != null) {
    return h('div', { className: 'page' },
      h('h2', null, '今日工作'),
      h('div', { className: 'error' }, bannerText('加载同事列表失败：', error)),
      h('div', { className: 'wb-toolbar' },
        h('button', { className: 'wb-btn wb-btn-primary', onClick: retry }, '重试'),
        h('span', { className: 'wb-hint' }, '后台仍会每 5 秒自动重试')),
    );
  }

  if (agents.length === 0) {
    return h('div', { className: 'page' },
      h('h2', null, '今日工作'),
      h('div', { className: 'wb-empty' },
        h('p', null, '公司今天静悄悄——还没有一位同事在岗。'),
        h('p', { className: 'wb-hint' }, '去人事部办一次入职，四步就好：名片、岗位、工位、工牌。'),
        h('button', { className: 'wb-btn wb-btn-primary', onClick: () => goBots('new', null) }, '去人事部办理入职')),
    );
  }

  const onDuty = agents.filter((a) => a.enabled !== false && (a.status === 'working' || a.status === 'idle'));
  return h('div', { className: 'page' },
    h('h2', null, '今日工作'),
    h('p', { className: 'muted' }, `${onDuty.length} 位同事在岗——谁在忙什么，这里实时可见`),
    actionError != null ? h('div', { className: 'error' }, actionError) : null,
    h('div', { className: 'wb-grid' },
      agents.map((a) => {
        const status = a.status ?? 'offline';
        const meta = providerMeta(a.provider);
        const working = status === 'working';
        const off = status === 'offline' || a.enabled === false;
        const badge = h('span', {
          className: `badge badge-${status}`,
          title: statusTitle(a),
        }, STATUS_LABEL[status] ?? status);
        return h('div', { key: a.id, className: 'wb-card', style: { '--pv': `var(${meta.varName})` } },
          h('div', { className: 'wb-card-head' },
            h(Avatar, {
              WAO, seed: a.id, size: 42, ring: meta.color, mood: off ? 'sleep' : 'neutral',
              title: `工牌号 ${a.id}\n${meta.tech}`,
            }),
            h('div', { style: { flex: '1', minWidth: '0' } },
              h('div', { className: 'wb-name' }, a.name ?? a.id),
              h('div', { className: 'wb-sub', title: `${meta.label}（provider ${a.provider ?? '?'}）· 渠道 ${a.channel ?? '?'} · 工牌号 ${a.id}` },
                `${meta.label} · ${a.id}`)),
            badge,
            // P2-4: 在岗同事带离岗原因，但 provider/渠道端口消失的调休同事此前
            // 毫无信号——橙点在灰色「休假」之外点名原因（title）。
            a.providerMissing === true ? h('span', {
              className: 'wb-dot-warn', title: '它的岗位部门已不存在（后勤部门里对应插件被停用）',
            }) : null,
            h('label', {
              className: 'wb-switch',
              title: a.enabled === false
                ? '调休中——点击返岗（在岗后立即连接企微开始接单）'
                : '在岗——点击办理调休（在跑的活会收完尾再断开，档案保留）',
            },
              h('input', {
                type: 'checkbox', checked: a.enabled !== false, disabled: busyId === a.id,
                onChange: () => toggle(a),
              }),
              h('span', { className: 'wb-track' })),
          ),
          working || a.progress?.line ? h('div', { className: 'wb-progress', title: '工作汇报（实时进度行）' },
            a.progress?.line ?? '运行中…') : null,
          status === 'offline' && a.reason ? h('div', { className: 'wb-reason', title: '离岗原因（技术原值见 tooltip）' }, `离岗原因：${a.reason}`) : null,
          h('div', { className: 'wb-stats' },
            h('span', null, '今日工单 ', h('b', null, a.todayTurns ?? 0)),
            h('span', null, '服务同事 ', h('b', null, a.users ?? 0)),
            h('span', null, '档案数 ', h('b', null, a.chats ?? 0))),
          h('div', { className: 'wb-actions' },
            h('button', { className: 'wb-btn', onClick: () => goBots('edit', a.id) }, '员工档案'),
            h('button', { className: 'wb-btn', onClick: () => goBots('test', a.id), title: '试跑：直接跑它的岗位配置，不进引擎链' }, '岗前测试')),
        );
      })),
  );
};

export default {
  id: 'workbench',
  title: '今日工作',
  icon: '📋',
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
