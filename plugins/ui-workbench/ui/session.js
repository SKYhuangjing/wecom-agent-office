// 会话 (M3 T3): per-bot drill-down with two views. 台账 = ledger turns grouped
// by chatKey (GET /api/ledger?bot= — the unfiltered shape IS the chat list
// source: distinct chatKeys ordered by last activity); 原生会话 = provider
// session history (GET /api/session?bot=&session= → {turns,truncated,warnings}),
// reachable by typing a sessionId or clicking one on a ledger turn. Export
// hands the whole bot ledger to the browser as Markdown (GET /api/export).
import { ensurePageStyle } from './style.js';

const REASON_LABEL = { completed: '完成', interrupted: '被打断', timeout: '超时', error: '错误' };

const fmtTime = (at) => (Number.isFinite(at) && at > 0 ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '—');

// Distinct chats from the bot's rows, most recent activity first — the
// selection source for both this page and the push page's chatKey picker.
export const chatsOf = (rows) => {
  const byChat = new Map(); // chatKey → { chatKey, count, lastAt }
  for (const r of rows) {
    if (typeof r?.chatKey !== 'string' || r.chatKey === '') continue;
    const cur = byChat.get(r.chatKey);
    if (cur == null) byChat.set(r.chatKey, { chatKey: r.chatKey, count: 1, lastAt: r.at ?? 0 });
    else { cur.count++; cur.lastAt = Math.max(cur.lastAt, r.at ?? 0); }
  }
  return [...byChat.values()].sort((a, b) => b.lastAt - a.lastAt);
};

const TurnCard = ({ h, row, onSession }) => h('div', { key: row.seq, className: 'wb-turn' },
  h('div', { className: 'wb-turn-head' },
    h('time', null, fmtTime(row.at)),
    h('span', {
      className: `badge wb-badge-${row.reason ?? 'error'}`,
      title: `reason：${row.reason ?? '?'}${row.ok === false ? '（未正常完成）' : ''}`,
    }, REASON_LABEL[row.reason] ?? row.reason ?? '未知'),
    row.provider ? h('span', null, row.provider) : null,
    row.sessionId ? h('button', {
      className: 'wb-chip',
      title: '查看该轮所属的 provider 原生会话',
      onClick: () => onSession(row.sessionId),
    }, `会话 ${row.sessionId}`) : null),
  h('div', null,
    h('span', { className: 'wb-turn-role' }, '用户：'),
    h('div', { className: 'wb-turn-user' }, row.user || '（空）')),
  h('div', null,
    h('span', { className: 'wb-turn-role' }, '助手：'),
    h('div', { className: 'wb-turn-assistant' }, row.assistant || '（未完成）')));

export default {
  id: 'session',
  title: '会话',
  icon: '☰',
  order: 3,
  component({ WAO }) {
    const { h, useState, useEffect, api, useAgents } = WAO;
    ensurePageStyle();
    const { agents, error: agentsError } = useAgents();

    const [botId, setBotId] = useState(null);
    const [view, setView] = useState('ledger'); // 'ledger' | 'native'
    const [rows, setRows] = useState(null); // all ledger turns of the bot
    const [chatKey, setChatKey] = useState('');
    const [loadError, setLoadError] = useState(null);
    const [loading, setLoading] = useState(false);
    // native view
    const [sessionId, setSessionId] = useState('');
    const [native, setNative] = useState(null); // {turns,truncated,warnings}
    const [nativeError, setNativeError] = useState(null);
    const [nativeLoading, setNativeLoading] = useState(false);
    const [pendingSession, setPendingSession] = useState(null); // deep-link awaiting botId

    // Default to the first bot once agents arrive (botId stays stable after a
    // manual pick — the effect guards on null only).
    useEffect(() => {
      if (botId == null && agents.length > 0) setBotId(agents[0].id);
    }, [agents, botId]);

    // Initial deep-link (?view=native&session=…): deterministic harness
    // screenshots of the native view, same pattern as bots.js ?select=.
    useEffect(() => {
      const q = new URLSearchParams(location.search);
      const sid = q.get('session');
      if (q.get('view') === 'native') setView('native');
      if (sid != null && sid !== '') {
        setSessionId(sid);
        setPendingSession(sid);
      }
    }, []);

    const reload = async (id = botId) => {
      if (id == null) return;
      setLoading(true);
      try {
        const data = await api(`/api/ledger?bot=${encodeURIComponent(id)}`);
        setRows(Array.isArray(data) ? data : []);
        setLoadError(null);
      } catch (err) {
        setRows([]);
        setLoadError(err?.message ?? String(err));
      } finally {
        setLoading(false);
      }
    };

    useEffect(() => { setRows(null); setChatKey(''); setLoadError(null); if (botId != null) reload(botId); }, [botId]);

    // Keep the chat selection valid against the freshly loaded rows.
    const chats = rows == null ? [] : chatsOf(rows);
    useEffect(() => {
      if (rows == null || chats.length === 0) { if (chatKey !== '') setChatKey(''); return; }
      if (!chats.some((c) => c.chatKey === chatKey)) setChatKey(chats[0].chatKey);
    }, [rows, chats.map((c) => c.chatKey).join('\n')]);

    const loadNative = async (sid) => {
      if (botId == null || !sid) return;
      setNativeLoading(true);
      setNativeError(null);
      setNative(null);
      try {
        const data = await api(`/api/session?bot=${encodeURIComponent(botId)}&session=${encodeURIComponent(sid)}`);
        setNative({ turns: Array.isArray(data?.turns) ? data.turns : [], truncated: data?.truncated === true, warnings: Array.isArray(data?.warnings) ? data.warnings : [] });
      } catch (err) {
        setNativeError(err?.message ?? String(err));
      } finally {
        setNativeLoading(false);
      }
    };

    // A ledger turn's 会话 chip jumps to the native view with that session.
    const openNative = (sid) => {
      setView('native');
      setSessionId(sid);
      void loadNative(sid);
    };

    // Deep-linked session fires its fetch once the bot selection resolved.
    useEffect(() => {
      if (pendingSession != null && botId != null) {
        const sid = pendingSession;
        setPendingSession(null);
        void loadNative(sid);
      }
    }, [pendingSession, botId]);

    if (agentsError != null) {
      return h('div', { className: 'page' },
        h('h2', null, '会话'),
        h('div', { className: 'error' }, `加载机器人列表失败：${agentsError}`));
    }
    if (agents.length === 0) {
      return h('div', { className: 'page' },
        h('h2', null, '会话'),
        h('div', { className: 'wb-empty' }, h('p', null, '还没有机器人——先到 Bot 管理创建，才有台账与会话可看。')));
    }

    const agent = agents.find((a) => a.id === botId) ?? null;
    const chatRows = (rows ?? []).filter((r) => r.chatKey === chatKey);
    const nativeTurn = (t, i) => h('div', { key: i, className: 'wb-turn' },
      h('div', { className: 'wb-turn-head' }, h('time', null, fmtTime(t.at))),
      t.user ? h('div', null,
        h('span', { className: 'wb-turn-role' }, '用户：'),
        h('div', { className: 'wb-turn-user' }, t.user)) : null,
      h('div', null,
        h('span', { className: 'wb-turn-role' }, '助手：'),
        h('div', { className: 'wb-turn-assistant' }, t.assistant || '（无文本输出）')));

    let body = null;
    if (view === 'ledger') {
      body = h('div', null,
        h('div', { className: 'wb-field', style: { maxWidth: 560 } },
          h('label', null, '会话（chatKey，来自台账，按最近活跃排序）'),
          chats.length === 0
            ? h('div', { className: 'wb-hint' }, loading ? '加载台账中…' : '该机器人还没有台账记录——收到第一条消息后才会产生。')
            : h('select', {
              className: 'wb-select', value: chatKey, onChange: (e) => setChatKey(e.target.value),
            }, chats.map((c) => h('option', { key: c.chatKey, value: c.chatKey },
              `${c.chatKey}（${c.count} 轮）`)))),
        chatRows.length === 0
          ? (chats.length === 0 ? null : h('div', { className: 'wb-empty' }, h('p', null, '该会话暂无台账轮次。')))
          : h('div', { className: 'wb-turns' }, chatRows.map((r) => h(TurnCard, { key: r.seq, h, row: r, onSession: openNative }))));
    } else {
      body = h('div', null,
        h('div', { className: 'wb-toolbar' },
          h('input', {
            className: 'wb-input', style: { maxWidth: 420, fontFamily: 'ui-monospace, Menlo, Consolas, monospace' },
            value: sessionId, placeholder: 'provider 原生会话 id，如 sess-a1b2c3d4',
            onChange: (e) => setSessionId(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') void loadNative(sessionId.trim()); },
          }),
          h('button', {
            className: 'wb-btn wb-btn-primary', disabled: nativeLoading || sessionId.trim() === '',
            onClick: () => void loadNative(sessionId.trim()),
          }, nativeLoading ? '读取中…' : '查看会话')),
        h('p', { className: 'wb-hint' }, '会话 id 可在台账视图里点某轮的「会话 …」带入；读取的是 provider 本地会话文件（最近若干轮）。'),
        nativeError != null ? h('div', { className: 'error', style: { marginTop: 12 } }, `读取原生会话失败：${nativeError}`) : null,
        native != null ? h('div', { className: 'wb-turns' },
          native.truncated ? h('div', { className: 'wb-truncated-note' }, '会话较长，仅显示最近部分轮次。') : null,
          native.warnings.map((w, i) => h('div', { key: i, className: 'wb-truncated-note' }, `警告：${w}`)),
          native.turns.length === 0 && native.warnings.length === 0
            ? h('div', { className: 'wb-empty' }, h('p', null, '该会话没有可读的轮次记录。'))
            : native.turns.map(nativeTurn)) : null);
    }

    return h('div', { className: 'page' },
      h('h2', null, '会话'),
      h('div', { className: 'wb-toolbar' },
        h('select', {
          className: 'wb-select', style: { width: 'auto' }, value: botId ?? '',
          onChange: (e) => setBotId(e.target.value),
        }, agents.map((a) => h('option', { key: a.id, value: a.id },
          `${a.name ?? a.id}（${a.id}）`))),
        h('div', { className: 'wb-tabs' },
          h('button', {
            className: `wb-tab${view === 'ledger' ? ' active' : ''}`, onClick: () => setView('ledger'),
          }, '台账'),
          h('button', {
            className: `wb-tab${view === 'native' ? ' active' : ''}`, onClick: () => setView('native'),
          }, '原生会话')),
        agent != null ? h('a', {
          className: 'wb-btn', href: `/api/export?bot=${encodeURIComponent(botId)}`,
          download: `${botId}-ledger.md`, title: '下载该机器人全部台账（Markdown）',
        }, '导出台账 Markdown') : null),
      agent?.provider != null ? h('p', { className: 'wb-hint' }, `当前 provider：${agent.provider}（切换 provider 后同一会话的原生记录按各自 provider 保存）`) : null,
      loadError != null ? h('div', { className: 'error', style: { marginTop: 12 } },
        `加载台账失败：${loadError} `,
        h('button', { className: 'wb-btn', onClick: () => void reload() }, '重试')) : null,
      body);
  },
};
