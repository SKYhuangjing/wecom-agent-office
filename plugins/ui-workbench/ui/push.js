// 推送 (M3 T3): server-initiated push (§8 POST /api/send). bot → chatKey (the
// SAME ledger-grouped chat list the session page uses) → content (4000-char
// cap with a live counter). Sending is refused while the bot is not connected
// (offline / disabled) — the button stays disabled with the reason inline.
// This page sends REAL messages: no dry-run, no confirmation shortcut.
import { ensurePageStyle } from './style.js';
import { chatsOf } from './session.js';
import { bannerText } from './list.js';

const MAX_CHARS = 4000;

export default {
  id: 'push',
  title: '广播站',
  icon: '📣',
  order: 5,
  component({ WAO }) {
    const { h, useState, useEffect, api, useAgents } = WAO;
    ensurePageStyle();
    const { agents, error: agentsError } = useAgents();

    const [botId, setBotId] = useState(null);
    const [chats, setChats] = useState([]); // ledger-grouped chat list of the bot
    const [chatKey, setChatKey] = useState('');
    const [chatsError, setChatsError] = useState(null);
    const [content, setContent] = useState('');
    const [sending, setSending] = useState(false);
    const [result, setResult] = useState(null); // { ok:true, chatKey } | { ok:false, message }

    useEffect(() => {
      if (botId == null && agents.length > 0) setBotId(agents[0].id);
    }, [agents, botId]);

    useEffect(() => {
      if (botId == null) return;
      let alive = true;
      setChatsError(null);
      (async () => {
        try {
          const data = await api(`/api/ledger?bot=${encodeURIComponent(botId)}`);
          if (!alive) return;
          const list = chatsOf(Array.isArray(data) ? data : []);
          setChats(list);
          setChatKey((cur) => (list.some((c) => c.chatKey === cur) || list.length === 0 ? cur : list[0].chatKey));
        } catch (err) {
          if (!alive) return;
          setChats([]);
          setChatsError(err?.message ?? String(err));
        }
      })();
      return () => { alive = false; };
    }, [botId]);

    const send = async () => {
      const text = content.trim();
      if (text === '' || chatKey === '') return;
      setSending(true);
      setResult(null);
      try {
        await api('/api/send', { botId, chatKey, content: text });
        setResult({ ok: true, chatKey });
        setContent('');
      } catch (err) {
        setResult({ ok: false, message: err?.message ?? String(err) });
      } finally {
        setSending(false);
      }
    };

    if (agentsError != null) {
      return h('div', { className: 'page' },
        h('h2', null, '广播站'),
        h('div', { className: 'error' }, bannerText('加载同事列表失败：', agentsError)));
    }
    if (agents.length === 0) {
      return h('div', { className: 'page' },
        h('h2', null, '广播站'),
        h('div', { className: 'wb-empty' }, h('p', null, '广播站还缺一位播音员——去人事部办一位同事入职，它就能替你向部门群喊话。')));
    }

    const agent = agents.find((a) => a.id === botId) ?? null;
    const notConnected = agent != null && (agent.enabled === false || agent.status === 'offline');
    const overLimit = content.length > MAX_CHARS;
    const canSend = botId != null && chatKey !== '' && content.trim() !== '' && !overLimit
      && !notConnected && !sending && chatsError == null;
    const len = content.length;

    return h('div', { className: 'page' },
      h('h2', null, '广播站'),
      h('p', { className: 'muted' }, '挑一位同事当播音员，向部门群/同事主动播报。内容会真实送达企微，请谨慎使用。'),
      h('div', { className: 'wb-form', style: { maxWidth: 660 } },
        h('div', { className: 'wb-field' },
          h('label', null, '播音员', h('span', { className: 'wb-hint', style: { marginLeft: 8 } }, '以哪位同事的身份播报')),
          h('select', {
            className: 'wb-select', value: botId ?? '', onChange: (e) => setBotId(e.target.value),
          }, agents.map((a) => h('option', { key: a.id, value: a.id },
            `${a.name ?? a.id}（${a.status === 'working' ? '工作中' : a.status === 'idle' ? '待命' : '休假'}）`)))),
        h('div', { className: 'wb-field' },
          h('label', null, '播给谁', h('span', { className: 'wb-hint', style: { marginLeft: 8 } }, '部门群/同事，来自它的往来档案')),
          chatsError != null
            ? h('div', { className: 'wb-field-error' }, `加载播报对象失败：${chatsError}`)
            : chats.length === 0
              ? h('div', { className: 'wb-hint' }, '它还没有可播报的对象——部门群/同事先来找过它一次，广播才有收件人。')
              : h('select', {
                className: 'wb-select', value: chatKey, onChange: (e) => setChatKey(e.target.value),
              }, chats.map((c) => h('option', { key: c.chatKey, value: c.chatKey }, c.chatKey)))),
        h('div', { className: 'wb-field' },
          h('label', null, '广播内容'),
          h('textarea', {
            className: 'wb-textarea', rows: 5, maxLength: MAX_CHARS + 100, value: content,
            placeholder: '要播报的文本内容（上限 4000 字）',
            onChange: (e) => setContent(e.target.value),
          }),
          h('span', { className: `wb-counter${overLimit ? ' over' : ''}` }, `${len} / ${MAX_CHARS}${overLimit ? ' — 超出上限，请删减' : ''}`)),
        notConnected ? h('div', { className: 'wb-notice' },
          `播音员当前不在岗${agent?.reason ? `（原因：${agent.reason}）` : ''}——广播要求它在岗（启用且渠道已连接）。`) : null,
        h('div', { className: 'wb-toolbar' },
          h('button', {
            className: 'wb-btn wb-btn-primary', disabled: !canSend, onClick: () => void send(),
            title: notConnected ? '机器人未连接，无法推送' : undefined,
          }, sending ? '播报中…' : '开始广播'))),
      result?.ok === true ? h('div', { className: 'wb-banner wb-banner-ok' },
        `${agent?.name ?? '同事'} 已向 ${result.chatKey} 播报完毕。`) : null,
      result?.ok === false ? h('div', { className: 'wb-banner wb-banner-bad' },
        `播报失败：${result.message}`) : null);
  },
};
