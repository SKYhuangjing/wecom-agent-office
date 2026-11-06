// 时间线 (M3 T3): recent activity stream over the SDK hook useTimeline(botId,
// windowMin) — SSE run/* nudges the refresh, a 5s poll is the fallback. Rows
// arrive oldest-first; the list renders newest-on-top. kind drives the color
// coding (run_start 蓝 / step 灰 / tool 紫 / thinking 青 / turn 绿 / run_end
// 蓝灰), the bot picker an 全部+per-bot choice, the window 5/15/30 minutes.
import { ensurePageStyle } from './style.js';
import { bannerText } from './list.js';

const KIND_LABEL = { run_start: 'run 开始', step: '步骤', tool: '工具', thinking: '思考', turn: '轮次', run_end: 'run 结束' };
const WINDOWS = [5, 15, 30]; // minutes

const fmtClock = (at) => (Number.isFinite(at) && at > 0
  ? new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
  : '--:--:--');

export default {
  id: 'timeline',
  title: '时间线',
  icon: '≫',
  order: 6,
  component({ WAO }) {
    const { h, useState, useEffect, useAgents, useTimeline } = WAO;
    ensurePageStyle();
    const { agents, error: agentsError } = useAgents();

    const [botId, setBotId] = useState(''); // '' = 全部机器人
    const [windowMin, setWindowMin] = useState(15);
    const { rows, error } = useTimeline(botId === '' ? null : botId, windowMin);

    // Keep the selection honest when the agent list shifts under us.
    useEffect(() => {
      if (botId !== '' && agents.length > 0 && !agents.some((a) => a.id === botId)) setBotId('');
    }, [agents, botId]);

    const newestFirst = [...rows].reverse();

    return h('div', { className: 'page' },
      h('h2', null, '时间线'),
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
        h('span', { className: 'wb-hint' }, `${rows.length} 条事件，每 5 秒自动刷新`)),
      agentsError != null ? h('div', { className: 'error', style: { marginTop: 12 } }, bannerText('加载机器人列表失败：', agentsError)) : null,
      error != null ? h('div', { className: 'error', style: { marginTop: 12 } }, bannerText('加载时间线失败：', error)) : null,
      newestFirst.length === 0 && error == null
        ? h('div', { className: 'wb-empty' },
            h('p', null, '窗口内暂无事件——机器人空闲，或最近的活动已超出所选时间窗。'),
            h('p', null, '重启后时间线从零开始（内存环形缓冲）——历史轮次请看台账。'))
        : h('ul', { className: 'wb-tl' }, newestFirst.map((r, i) => h('li', {
            key: `${r.at}-${i}`,
            className: 'wb-tl-row',
            title: `${r.chatKey ?? ''}\n${r.text ?? ''}`,
          },
            h('span', { className: 'wb-tl-time' }, fmtClock(r.at)),
            h('span', { className: `wb-tl-kind wb-tl-kind-${r.kind}` }, KIND_LABEL[r.kind] ?? r.kind),
            r.botId ? h('span', { className: 'wb-tl-chat' }, r.botId) : null,
            r.chatKey ? h('span', { className: 'wb-tl-chat' }, r.chatKey) : null,
            h('span', { className: 'wb-tl-text' }, r.text || '（无文本）')))));
  },
};
