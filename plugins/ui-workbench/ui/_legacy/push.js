// 推送 (M3 T3): server-initiated push (§8 POST /api/send). bot → chatKey (the
// SAME ledger-grouped chat list the session page uses) → content (4000-char
// cap with a live counter). Sending is refused while the bot is not connected
// (offline / disabled) — the button stays disabled with the reason inline.
// This page sends REAL messages: no dry-run, no confirmation shortcut.
import { ensurePageStyle } from '../style.js';
import { chatsOf } from './session.js';
import { bannerText } from './list.js';

const MAX_CHARS = 4000;

export default {
  id: 'push',
  title: '消息推送',
  icon: 'send',
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
        h('h2', null, '消息推送'),
        h('div', { className: 'error' }, bannerText('加载机器人列表失败：', agentsError)));
    }
    if (agents.length === 0) {
      return h('div', { className: 'page' },
        h('h2', null, '消息推送'),
        h('div', { className: 'wb-empty' }, h('p', null, '还没有机器人可推送——去机器人管理创建一个，它就能替你向企微群发消息。')));
    }

    const agent = agents.find((a) => a.id === botId) ?? null;
    const notConnected = agent != null && (agent.enabled === false || agent.status === 'offline');
    const overLimit = content.length > MAX_CHARS;
    const canSend = botId != null && chatKey !== '' && content.trim() !== '' && !overLimit
      && !notConnected && !sending && chatsError == null;
    const len = content.length;

    return h('div', { className: 'page' },
      h('h2', null, '消息推送'),
      h('p', { className: 'muted' }, '选一个机器人作为发送方，向群聊/单聊主动推送消息。内容会真实送达企微，请谨慎使用。'),
      h('div', { className: 'wb-form', style: { maxWidth: 660 } },
        h('div', { className: 'wb-field' },
          h('label', null, '发送方', h('span', { className: 'wb-hint', style: { marginLeft: 8 } }, '以哪个机器人的身份发送')),
          h('select', {
            className: 'wb-select', value: botId ?? '', onChange: (e) => setBotId(e.target.value),
          }, agents.map((a) => h('option', { key: a.id, value: a.id },
            `${a.name ?? a.id}（${a.status === 'working' ? '工作中' : a.status === 'idle' ? '待命' : '离线'}）`)))),
        h('div', { className: 'wb-field' },
          h('label', null, '发送到', h('span', { className: 'wb-hint', style: { marginLeft: 8 } }, '群聊/单聊，来自它的会话记录')),
          chatsError != null
            ? h('div', { className: 'wb-field-error' }, `加载发送目标失败：${chatsError}`)
            : chats.length === 0
              ? h('div', { className: 'wb-hint' }, '它还没有可发送的目标——群聊/单聊先来找过它一次，推送才有收件人。')
              : h('select', {
                className: 'wb-select', value: chatKey, onChange: (e) => setChatKey(e.target.value),
              }, chats.map((c) => h('option', { key: c.chatKey, value: c.chatKey }, c.chatKey)))),
        h('div', { className: 'wb-field' },
          h('label', null, '消息内容'),
          h('textarea', {
            className: 'wb-textarea', rows: 5, maxLength: MAX_CHARS + 100, value: content,
            placeholder: '要发送的文本内容（上限 4000 字）',
            onChange: (e) => setContent(e.target.value),
          }),
          h('span', { className: `wb-counter${overLimit ? ' over' : ''}` }, `${len} / ${MAX_CHARS}${overLimit ? ' — 超出上限，请删减' : ''}`)),
        notConnected ? h('div', { className: 'wb-notice' },
          `机器人当前不在线${agent?.reason ? `（原因：${agent.reason}）` : ''}——推送要求它在线（启用且渠道已连接）。`) : null,
        h('div', { className: 'wb-toolbar' },
          h('button', {
            className: 'wb-btn wb-btn-primary', disabled: !canSend, onClick: () => void send(),
            title: notConnected ? '机器人未连接，无法推送' : undefined,
          }, sending ? '发送中…' : '发送消息'))),
      result?.ok === true ? h('div', { className: 'wb-banner wb-banner-ok' },
        `${agent?.name ?? '机器人'} 已向 ${result.chatKey} 发送完毕。`) : null,
      result?.ok === false ? h('div', { className: 'wb-banner wb-banner-bad' },
        `发送失败：${result.message}`) : null);
  },
};
