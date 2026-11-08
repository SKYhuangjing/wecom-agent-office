// 工作日志 (company-metaphor redesign P3): recent activity stream over the SDK
// hook useTimeline(botId, windowMin) — SSE run/* nudges the refresh, a 5s poll
// is the fallback. Rows arrive oldest-first; the list renders newest-on-top.
// 每行带上同事的化身（头像即化身——日志里也是那张脸）；kind 用公司话
// （开工/步骤/工具/思考/工单/收工），技术原值收进 title。bot picker 是
// 全部同事+单人，窗口 5/15/30 分钟。
import { ensurePageStyle } from './style.js';
import { bannerText } from './list.js';
import { Avatar, providerMeta } from './hr.js';
import { IconEl } from './icons.js';

const KIND_LABEL = { run_start: '开始', step: '步骤', tool: '工具', thinking: '思考', turn: '消息', run_end: '结束' };
// 单色收敛：kind 不再分色，差异靠 icon 形状（无自然映射的 kind 纯文字）。
const KIND_ICON = { run_start: 'play', tool: 'zap', turn: 'send', run_end: 'check' };
const WINDOWS = [5, 15, 30]; // minutes

const fmtClock = (at) => (Number.isFinite(at) && at > 0
  ? new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
  : '--:--:--');

export default {
  id: 'timeline',
  title: '活动日志',
  icon: 'clock',
  order: 7,
  component({ WAO }) {
    const { h, useState, useEffect, useAgents, useTimeline } = WAO;
    ensurePageStyle();
    const { agents, error: agentsError } = useAgents();
    const [botId, setBotId] = useState(''); // '' = 全部同事
    const [windowMin, setWindowMin] = useState(15);
    const { rows, error } = useTimeline(botId === '' ? null : botId, windowMin);

    // Keep the selection honest when the roster shifts under us.
    useEffect(() => {
      if (botId !== '' && agents.length > 0 && !agents.some((a) => a.id === botId)) setBotId('');
    }, [agents, botId]);

    const newestFirst = [...rows].reverse();

    return h('div', { className: 'page' },
      h('h2', null, '活动日志'),
      h('div', { className: 'wb-toolbar' },
        h('select', {
          className: 'wb-select', style: { width: 'auto' }, value: botId,
          onChange: (e) => setBotId(e.target.value),
        },
          h('option', { value: '' }, '全部机器人'),
          agents.map((a) => h('option', { key: a.id, value: a.id }, a.name ?? a.id))),
        h('select', {
          className: 'wb-select', style: { width: 'auto' }, value: String(windowMin),
          onChange: (e) => setWindowMin(Number(e.target.value)),
        }, WINDOWS.map((w) => h('option', { key: w, value: String(w) }, `最近 ${w} 分钟`))),
        h('span', { className: 'wb-hint' }, `${rows.length} 条记录，每 5 秒自动刷新`)),
      agentsError != null ? h('div', { className: 'error', style: { marginTop: 12 } }, bannerText('加载机器人列表失败：', agentsError)) : null,
      error != null ? h('div', { className: 'error', style: { marginTop: 12 } }, bannerText('加载活动日志失败：', error)) : null,
      newestFirst.length === 0 && error == null
        ? h('div', { className: 'wb-empty' },
            h('p', null, '这个时间窗里没有活动——机器人可能在待命，或者新的记录已滑出所选窗口。'),
            h('p', null, '日志从服务启动时记起（重启后从零开始）——更早的消息去会话历史查。'))
        : h('ul', { className: 'wb-tl' }, newestFirst.map((r, i) => {
            const a = agents.find((x) => x.id === r.botId);
            const meta = providerMeta(a?.provider ?? r.botId);
            return h('li', {
              key: `${r.at}-${i}`,
              className: 'wb-tl-row',
              title: `${r.botId ?? ''}\n${r.chatKey ?? ''}\n${r.text ?? ''}`,
            },
              a != null ? h(Avatar, {
                WAO, seed: r.botId, size: 20, ring: meta.color,
                title: `${a.name ?? r.botId} · ${meta.label}`,
              }) : h('span', { className: 'wb-mono', style: { fontSize: 10, flex: 'none' } }, (r.botId ?? '?').slice(0, 6)),
              h('span', { className: 'wb-tl-time' }, fmtClock(r.at)),
              h('span', {
                className: `wb-tl-kind wb-tl-kind-${r.kind}`,
                title: `kind：${r.kind}`,
              }, KIND_ICON[r.kind] ? h(IconEl, { h, name: KIND_ICON[r.kind], size: 11 }) : null,
                KIND_LABEL[r.kind] ?? r.kind),
              r.chatKey ? h('span', { className: 'wb-tl-chat', title: '会话对象（群聊/单聊 chatKey）' }, r.chatKey) : null,
              h('span', { className: 'wb-tl-text' }, r.text || '（无文本）'));
          })));
  },
};
