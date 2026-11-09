// 机器人 (v2 导航收敛): bot 列表 + 创建向导（_legacy/wizard.js）+ 详情视图。
// 详情四个 tab——会话（_legacy/session.js 按 bot 过滤）/ 日志（_legacy/
// timeline.js 按 bot 过滤）/ 工具（_legacy/assets.js 装备台精简为 per-bot）/
// 设置（_legacy/bots.js 的编辑表单：schema 驱动 + 测试运行）——外加「发送
// 消息」按钮（_legacy/push.js 精简为 dialog：选会话→填内容→发送）。
// 跨页交接沿用 sessionStorage handoff（overview/PunchClock 跳入）；深链
// ?select=new&step=N（向导）/ ?select=<botId>&tab=session|logs|tools|settings
// 供 harness 截图。
import { ensurePageStyle } from './style.js';
import { fieldsFromSchema, SchemaFields, serializeSchema } from './form.js';
import { Avatar, STATUS_LABEL, statusTitle, providerMeta, fmtDate } from './hr.js';
import { Wizard } from './wizard.js';
import { Offboard } from './offboard.js';
import { MdText } from './md.js';
import { IconEl } from './icons.js';
import { bannerText } from './_legacy/list.js';
import { chatsOf, TurnCard, humanizeWarning } from './_legacy/session.js';
import { TYPE_LABEL, MODE_LABEL, MODE_HINT, TypeBadge, ModeBadge, ToolBadge, Receipt } from './_legacy/assets.js';
import { Group } from './_legacy/bots.js';
import { KIND_LABEL, KIND_ICON, fmtClock } from './_legacy/timeline.js';
import { goSettingsAi } from './ai-access.js';

const NAME_MAX = 30;
const HANDOFF_KEY = 'wao-robots-handoff';
const TAB_IDS = ['session', 'logs', 'tools', 'settings'];
const TAB_LABEL = { session: '会话', logs: '日志', tools: '工具', settings: '设置' };
const WINDOWS = [5, 15, 30]; // minutes
const PUSH_MAX = 4000;
const errorLines = (message) => String(message ?? '').split('; ').filter((s) => s.trim() !== '');
const PROVIDER_LABEL = { dsh: 'DSH 引擎', claude: 'Claude 引擎', codex: 'Codex 引擎', pi: 'pi 引擎', cursor: 'Cursor 引擎' };

// 跨页交接（shell 路由是裸 '#/<pageid>'）：发起方先把 {id, tab, test} 塞进
// sessionStorage 再翻 hash；本页 mount 时消费一次。
export const goRobots = (id, tab = null, extra = {}) => {
  try {
    sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ id, tab, ...extra }));
    location.hash = '#/robots';
  } catch { /* storage 不可用：裸导航仍生效（落在列表） */ }
};

// —— 会话 tab（_legacy/session.js 固定 bot 版：台账按 chatKey 归档 + 引擎会话钻取）——
const DetailSession = ({ WAO, botId, agent }) => {
  const { h, useState, useEffect, api } = WAO;
  const [view, setView] = useState('ledger'); // 'ledger' 台账 | 'native' 引擎会话
  const [rows, setRows] = useState(null);
  const [chatKey, setChatKey] = useState('');
  const [loadError, setLoadError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState('');
  const [native, setNative] = useState(null);
  const [nativeError, setNativeError] = useState(null);
  const [nativeLoading, setNativeLoading] = useState(false);

  const reload = async () => {
    setLoading(true);
    try {
      const data = await api(`/api/ledger?bot=${encodeURIComponent(botId)}`);
      setRows(Array.isArray(data) ? data : []);
      setLoadError(null);
    } catch (err) {
      setRows([]);
      setLoadError(err?.message ?? String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void reload(); }, [botId]);

  const chats = rows == null ? [] : chatsOf(rows);
  useEffect(() => {
    if (rows == null || chats.length === 0) { if (chatKey !== '') setChatKey(''); return; }
    if (!chats.some((c) => c.chatKey === chatKey)) setChatKey(chats[0].chatKey);
  }, [rows, chats.map((c) => c.chatKey).join('\n')]);

  const loadNative = async (sid) => {
    if (!sid) return;
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
  const openNative = (sid) => { setView('native'); setSessionId(sid); void loadNative(sid); };

  const chatRows = (rows ?? []).filter((r) => r.chatKey === chatKey);
  const nativeTurn = (t, i) => h('div', { key: i, className: 'wb-turn' },
    h('div', { className: 'wb-turn-head' }, h('time', null, fmtClock(t.at))),
    t.user ? h('div', null,
      h('span', { className: 'wb-turn-role' }, '用户：'),
      h('div', { className: 'wb-turn-user' }, t.user)) : null,
    h('div', null,
      h('span', { className: 'wb-turn-role' }, '助手：'),
      h('div', { className: 'wb-turn-assistant' }, h(MdText, { h, text: t.assistant || '（无文本输出）' }))));

  let body = null;
  if (view === 'ledger') {
    body = h('div', null,
      h('div', { className: 'wb-field', style: { maxWidth: 560 } },
        h('label', null, '与谁的往来', h('span', { className: 'wb-hint', style: { marginLeft: 8 } }, '群聊/单聊 chatKey，按最近活跃排序')),
        chats.length === 0
          ? h('div', { className: 'wb-hint' }, loading ? '读取中…' : '这个机器人还没有会话记录——群里来过第一句话后才会产生记录。')
          : h('select', {
            className: 'wb-select', value: chatKey, onChange: (e) => setChatKey(e.target.value),
          }, chats.map((c) => h('option', { key: c.chatKey, value: c.chatKey }, `${c.chatKey}（${c.count} 轮）`)))),
      chatRows.length === 0
        ? (chats.length === 0 ? null : h('div', { className: 'wb-empty' }, h('p', null, '这个会话还没有消息记录。')))
        : h('div', { className: 'wb-turns' }, chatRows.map((r) => h(TurnCard, { key: r.seq, h, row: r, onSession: openNative }))));
  } else {
    body = h('div', null,
      h('div', { className: 'wb-toolbar' },
        h('input', {
          className: 'wb-input', style: { maxWidth: 420, fontFamily: 'var(--mono)' },
          value: sessionId, placeholder: '引擎会话编号（provider session id）',
          onChange: (e) => setSessionId(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') void loadNative(sessionId.trim()); },
        }),
        h('button', {
          className: 'wb-btn wb-btn-primary', disabled: nativeLoading || sessionId.trim() === '',
          onClick: () => void loadNative(sessionId.trim()),
        }, nativeLoading ? '读取中…' : '查看会话')),
      h('p', { className: 'wb-hint' }, '编号可在会话列表里点某条消息的「引擎会话」带入；查看的是 provider 本地会话文件（最近若干轮）。'),
      nativeError != null ? h('div', { className: 'error', style: { marginTop: 12 } }, `查看引擎会话失败：${nativeError}`) : null,
      native != null ? h('div', { className: 'wb-turns' },
        native.truncated ? h('div', { className: 'wb-truncated-note' }, '这份会话较长，只展示了最近的部分。') : null,
        native.warnings.map((w, i) => h('div', { key: i, className: 'wb-truncated-note' }, `警告：${humanizeWarning(w)}`)),
        native.turns.length === 0 && native.warnings.length === 0
          ? h('div', { className: 'wb-empty' }, h('p', null, '这份会话里没有可读的记录。'))
          : native.turns.map(nativeTurn)) : null);
  }

  return h('div', null,
    h('div', { className: 'wb-toolbar' },
      h('div', { className: 'wb-tabs' },
        h('button', { className: `wb-tab${view === 'ledger' ? ' active' : ''}`, onClick: () => setView('ledger') }, '会话历史'),
        h('button', { className: `wb-tab${view === 'native' ? ' active' : ''}`, onClick: () => setView('native') }, '引擎会话')),
      h('a', {
        className: 'wb-btn', href: `/api/export?bot=${encodeURIComponent(botId)}`,
        download: `${botId}-ledger.md`, title: '下载这个机器人的全部会话历史（台账 Markdown）',
      }, '导出会话历史')),
    agent?.provider != null ? h('p', { className: 'wb-hint' }, `当前引擎：${agent.provider}（更换引擎后，同一会话的引擎会话按各自引擎分开保存）`) : null,
    loadError != null ? h('div', { className: 'error', style: { marginTop: 12 } },
      `读取失败：${loadError} `,
      h('button', { className: 'wb-btn', onClick: () => void reload() }, '重试')) : null,
    body);
};

// —— 日志 tab（_legacy/timeline.js 固定 bot 版：窗口选择 + newest-on-top 流）——
const DetailLogs = ({ WAO, botId }) => {
  const { h, useState, useTimeline } = WAO;
  const [windowMin, setWindowMin] = useState(15);
  const { rows, error } = useTimeline(botId, windowMin);
  const newestFirst = [...rows].reverse();
  return h('div', null,
    h('div', { className: 'wb-toolbar' },
      h('select', {
        className: 'wb-select', style: { width: 'auto' }, value: String(windowMin),
        onChange: (e) => setWindowMin(Number(e.target.value)),
      }, WINDOWS.map((w) => h('option', { key: w, value: String(w) }, `最近 ${w} 分钟`))),
      h('span', { className: 'wb-hint' }, `${rows.length} 条记录，每 5 秒自动刷新`)),
    error != null ? h('div', { className: 'error', style: { marginTop: 12 } }, bannerText('加载活动日志失败：', error)) : null,
    newestFirst.length === 0 && error == null
      ? h('div', { className: 'wb-empty' },
          h('p', null, '这个时间窗里没有活动——机器人可能在待命，或者新的记录已滑出所选窗口。'),
          h('p', null, '日志从服务启动时记起（重启后从零开始）——更早的消息去「会话」tab 查。'))
      : h('ul', { className: 'wb-tl' }, newestFirst.map((r, i) => h('li', {
          key: `${r.at}-${i}`,
          className: 'wb-tl-row',
          title: `${r.botId ?? ''}\n${r.chatKey ?? ''}\n${r.text ?? ''}`,
        },
        h('span', { className: 'wb-tl-time' }, fmtClock(r.at)),
        h('span', { className: `wb-tl-kind wb-tl-kind-${r.kind}`, title: `kind：${r.kind}` },
          KIND_ICON[r.kind] ? h(IconEl, { h, name: KIND_ICON[r.kind], size: 11 }) : null,
          KIND_LABEL[r.kind] ?? r.kind),
        r.chatKey ? h('span', { className: 'wb-tl-chat', title: '会话对象（群聊/单聊 chatKey）' }, r.chatKey) : null,
        h('span', { className: 'wb-tl-text' }, r.text || '（无文本）')))));
};

// —— 工具 tab（_legacy/assets.js 装备台精简为固定 bot：绑定表 + 配置 + 解绑/重物化）——
const DetailTools = ({ WAO, botId }) => {
  const { h, useState, useEffect, api, useAgents } = WAO;
  const { agents } = useAgents(); // assetWarnings 警示条 + manifest.tools 装备态
  const [assets, setAssets] = useState(null);
  const [bots, setBots] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [bindAssetId, setBindAssetId] = useState('');
  const [bindMode, setBindMode] = useState('shared');
  const [unbindFor, setUnbindFor] = useState(null);
  const [rematOpen, setRematOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [receipt, setReceipt] = useState(null); // {title, data}

  const reload = async () => {
    try {
      const [a, b] = await Promise.all([api('/api/assets'), api('/api/bots')]);
      setAssets(Array.isArray(a?.assets) ? a.assets : []);
      setBots(Array.isArray(b?.bots) ? b.bots : []);
      setLoadError(null);
    } catch (err) {
      setLoadError(err?.message ?? String(err));
    }
  };
  useEffect(() => { void reload(); }, [botId]);

  if (assets == null || bots == null) {
    return h('p', { className: 'muted' },
      loadError != null ? `读取失败：${loadError}` : '读取工具绑定中…',
      loadError != null ? h('button', { className: 'wb-btn', style: { marginLeft: 8 }, onClick: () => void reload() }, '重试') : null);
  }

  const bot = bots.find((b) => b.id === botId);
  const agent = agents.find((a) => a.id === botId) ?? null;
  const bindings = Array.isArray(bot?.assets) ? bot.assets : [];
  const boundIds = new Set(bindings.map((x) => x?.assetId));
  const available = assets.filter((a) => !boundIds.has(a.id));
  const warnings = Array.isArray(agent?.assetWarnings) ? agent.assetWarnings : [];
  const toolStateOf = (assetId) => (Array.isArray(agent?.assetTools)
    ? agent.assetTools.find((t) => t?.assetId === assetId) : undefined);

  const doBind = async () => {
    if (bindAssetId === '') return;
    setBusy(true);
    setActionError(null);
    setReceipt(null);
    try {
      const resp = await api(`/api/bots/${encodeURIComponent(botId)}/assets`, {
        assetId: bindAssetId, mode: bindMode,
      });
      setReceipt({
        title: `已配置「${resp?.binding?.name ?? bindAssetId}」（${MODE_LABEL[resp?.binding?.mode ?? bindMode]}）给 ${bot?.name ?? botId}`,
        data: resp,
      });
      setBindAssetId('');
      await reload();
    } catch (err) {
      setActionError(String(err?.message ?? err));
    } finally {
      setBusy(false);
    }
  };
  const doUnbind = async () => {
    if (unbindFor == null) return;
    setBusy(true);
    setActionError(null);
    setReceipt(null);
    try {
      const resp = await api(`/api/bots/${encodeURIComponent(botId)}/assets/${encodeURIComponent(unbindFor.assetId)}`,
        undefined, { method: 'DELETE' });
      setReceipt({ title: `已从 ${bot?.name ?? botId} 移除工具`, data: resp });
      setUnbindFor(null);
      await reload();
    } catch (err) {
      setActionError(String(err?.message ?? err));
    } finally {
      setBusy(false);
    }
  };
  const doRemat = async () => {
    setBusy(true);
    setActionError(null);
    setReceipt(null);
    try {
      const resp = await api(`/api/bots/${encodeURIComponent(botId)}/rematerialize-assets`, {});
      setReceipt({ title: `重新物化完成：${bot?.name ?? botId}`, data: resp });
      setRematOpen(false);
    } catch (err) {
      setActionError(String(err?.message ?? err));
      setRematOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const unbindModal = unbindFor == null ? null : h('div', { className: 'wb-modal-wrap', onClick: () => { if (!busy) setUnbindFor(null); } },
    h('div', { className: 'wb-modal', onClick: (e) => e.stopPropagation() },
      h('h3', null, `移除工具「${unbindFor.name ?? unbindFor.assetId}」？`),
      h('p', { className: 'wb-hint' },
        `${bot?.name ?? botId} · `, h('span', { className: 'wb-mono' }, unbindFor.assetId),
        ` · ${MODE_LABEL[unbindFor.mode] ?? unbindFor.mode}`),
      unbindFor.mode === 'shared'
        ? h('div', { className: 'wb-notice' }, '将删除它盘上由这个工具生成的文件；工具仍在清单，随时可以重新绑定。')
        : h('div', { className: 'wb-notice' },
            '独立副本的内容随移除丢失', unbindFor.sourceDeleted === true ? '——且源工具已删除，这份快照是最后一份，移除后无法找回。' : '——源工具仍在清单，重新绑定（独立）可拿到最新版。'),
      h('div', { className: 'wb-toolbar' },
        h('button', { className: 'wb-btn wb-btn-danger', disabled: busy, onClick: () => void doUnbind() },
          busy ? '移除中…' : '确认移除'),
        h('button', { className: 'wb-btn', disabled: busy, onClick: () => setUnbindFor(null) }, '再想想'))));

  const rematModal = !rematOpen ? null : h('div', { className: 'wb-modal-wrap', onClick: () => { if (!busy) setRematOpen(false); } },
    h('div', { className: 'wb-modal', onClick: (e) => e.stopPropagation() },
      h('h3', null, `重新物化 ${bot?.name ?? botId} 的工具？`),
      h('div', { className: 'wb-notice' },
        '将按当前绑定重写这个机器人的全部工具产物文件——用于修复漂移或补跑失败的物化；期间它会以上一轮的好配置继续工作。'),
      h('div', { className: 'wb-toolbar' },
        h('button', { className: 'wb-btn wb-btn-danger', disabled: busy, onClick: () => void doRemat() },
          busy ? '执行中…' : '确认重物化'),
        h('button', { className: 'wb-btn', disabled: busy, onClick: () => setRematOpen(false) }, '再想想'))));

  return h('div', null,
    h('div', { className: 'wb-toolbar' },
      h('button', {
        className: 'wb-btn', disabled: busy || bindings.length === 0,
        title: bindings.length === 0 ? '还没有绑定任何工具' : '按当前绑定重写这个机器人的全部工具产物文件（修复漂移/失败的安全路径）',
        onClick: () => setRematOpen(true),
      }, busy ? '执行中…' : '重新物化'),
      h('span', { className: 'wb-hint' }, '工具清单的增删改在「设置 → 工具库」')),
    warnings.length > 0 ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 } },
      warnings.map((w, i) => h('div', { key: i, className: 'wb-notice', title: 'assetWarnings——工具配置面常驻警示' }, w))) : null,
    h('h3', { style: { margin: '16px 0 0', fontSize: 14 } }, `已配置 ${bindings.length} 件`),
    bindings.length === 0
      ? h('div', { className: 'wb-empty' },
          h('p', null, '这个机器人还没有配置工具——从下面挑一个给它绑上，技能和工具都会落到它的工作目录。'))
      : h('div', { className: 'wb-table-scroll' }, h('table', { className: 'wb-table' },
          h('thead', null, h('tr', null,
            h('th', null, '工具'), h('th', null, '类型'), h('th', null, '模式'),
            h('th', null, '版本/快照'), h('th', null, '配置态'), h('th', null, '操作'))),
          h('tbody', null, bindings.map((x) => h('tr', { key: x.assetId },
            h('td', null,
              h('div', { className: 'wb-mono' }, x.name ?? x.assetId),
              h('div', { className: 'wb-sub' }, x.assetId)),
            h('td', null, h(TypeBadge, { h, type: x.type })),
            h('td', null, h(ModeBadge, { h, mode: x.mode })),
            h('td', null,
              x.mode !== 'exclusive'
                ? h('span', { className: 'wb-hint', title: MODE_HINT.shared }, '跟源更新')
                : x.sourceDeleted === true
                  ? h('span', { className: 'badge wb-srcdel', title: '源工具已删除，这份独立快照继续生效（不跟源更新）' }, '源已删·快照隔离')
                  : h('span', {
                      className: (x.exclusiveBehind ?? 0) > 0 ? 'wb-field-error' : 'wb-sub',
                      title: `快照 v${x.snapshotVersion ?? '?'}，源工具当前 v+${x.exclusiveBehind ?? 0}`,
                    }, (x.exclusiveBehind ?? 0) > 0 ? `落后源 ${x.exclusiveBehind} 版` : `快照 v${x.snapshotVersion ?? '?'}`)),
            h('td', null, x.type === 'tool'
              ? h(ToolBadge, { h, entry: toolStateOf(x.assetId) })
              : h('span', { className: 'wb-hint', title: '配置态只对工具类有意义（技能/记忆/MCP/提示词随物化直接落盘）' }, '—')),
            h('td', null, h('button', {
              className: 'wb-btn wb-btn-danger', disabled: busy, onClick: () => setUnbindFor(x),
            }, '移除')))))),
    h('h3', { style: { margin: '20px 0 0', fontSize: 14 } }, '配置工具'),
    available.length === 0
      ? h('p', { className: 'wb-hint', style: { marginTop: 8 } },
          assets.length === 0
            ? '工具清单还是空的——先到「设置 → 工具库」添加第一个工具。'
            : '清单里的工具都已绑定给这个机器人了。')
      : h('div', { className: 'wb-toolbar', style: { marginTop: 8 } },
          h('select', {
            className: 'wb-select', style: { width: 'auto' }, value: bindAssetId,
            onChange: (e) => {
              setBindAssetId(e.target.value);
              const pick = available.find((a) => a.id === e.target.value);
              if (pick?.origin === 'mcp') setBindMode('exclusive'); // Agent 自建资产仅可私发
            },
          }, [h('option', { value: '' }, '（选择工具）'),
            ...available.map((a) => h('option', { key: a.id, value: a.id },
              `${TYPE_LABEL[a.type] ?? a.type} · ${a.name}${a.origin === 'mcp' ? '（Agent 自建·仅可独立）' : ''}`))]),
          h('select', {
            className: 'wb-select', style: { width: 'auto' }, value: bindMode,
            onChange: (e) => setBindMode(e.target.value),
          },
            h('option', { value: 'shared' }, '共享（跟源更新）'),
            h('option', { value: 'exclusive' }, '独立（快照隔离）')),
          h('button', {
            className: 'wb-btn wb-btn-primary', disabled: busy || bindAssetId === '',
            title: '绑定即写盘生效：向这个机器人的工作目录写入工具文件并重建 runner，下一轮对话就能用',
            onClick: () => void doBind(),
          }, busy ? '配置中…' : '配置')),
    actionError != null ? h('div', { className: 'error', style: { marginTop: 12 } }, actionError) : null,
    receipt != null ? h(Receipt, { h, title: receipt.title, receipt: receipt.data }) : null,
    unbindModal,
    rematModal));
};

// —— 设置 tab（_legacy/bots.js 的编辑表单原样搬移：分组折叠 + sticky 保存栏 +
// 测试运行；只把「选择谁」从外部传入固定）——
const DetailSettings = ({ WAO, bot, ports, onSaved, onDeleted, focusTest }) => {
  const { h, useState, useEffect, api } = WAO;
  const [draft, setDraft] = useState(null);
  const [saveErrors, setSaveErrors] = useState(null);
  const [saving, setSaving] = useState(false);
  const [offboardFor, setOffboardFor] = useState(null);
  const [testPrompt, setTestPrompt] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testError, setTestError] = useState(null);
  const [groups, setGroups] = useState({ basic: true, badge: true, dept: true, adv: false });

  useEffect(() => {
    setDraft(bot == null ? null : {
      id: bot.id, name: bot.name ?? '', enabled: bot.enabled !== false,
      channel: bot.channel ?? '', provider: bot.provider ?? '',
      account: fieldsFromSchema(ports?.channels?.find((c) => c.id === bot.channel)?.accountSchema, bot.account),
      providerConfig: fieldsFromSchema(ports?.providers?.find((p) => p.id === bot.provider)?.configSchema, bot.providerConfig),
      allowedUsers: Array.isArray(bot.allowedUsers) ? bot.allowedUsers.join('\n') : '',
    });
    setSaveErrors(null);
    setTestResult(null);
    setTestError(null);
    if (focusTest) setGroups((g) => ({ ...g, adv: true }));
  }, [bot?.id, bot?.updatedAt ?? bot?.createdAt]);

  if (draft == null) return h('p', { className: 'muted' }, '读取机器人配置…');

  const channelSchema = ports.channels.find((c) => c.id === draft.channel)?.accountSchema ?? [];
  const providerSchema = ports.providers.find((p) => p.id === draft.provider)?.configSchema ?? [];
  const storedBot = bot;
  const providerSwitched = draft.provider !== storedBot?.provider;
  const noPorts = ports.channels.length === 0 || ports.providers.length === 0;
  const meta = providerMeta(draft.provider);
  const joined = fmtDate(storedBot?.createdAt);
  const dutyOn = draft.enabled !== false;

  const switchProvider = (next) => {
    const fromRecord = storedBot != null && storedBot.provider === next;
    setDraft((d) => ({
      ...d,
      provider: next,
      providerConfig: fieldsFromSchema(
        ports.providers.find((p) => p.id === next)?.configSchema,
        fromRecord ? storedBot.providerConfig : undefined,
      ),
    }));
  };

  const save = async () => {
    setSaveErrors(null);
    const { values: account, errors: accountErrors } = serializeSchema(channelSchema, draft.account);
    const { values: providerConfig, errors: configErrors } = serializeSchema(providerSchema, draft.providerConfig);
    const local = [...accountErrors, ...configErrors];
    if (draft.name.trim() === '') local.push('姓名为必填项');
    if (local.length > 0) { setSaveErrors(local); return; }
    const allowed = draft.allowedUsers.split('\n').map((s) => s.trim()).filter(Boolean);
    const body = {
      id: draft.id, name: draft.name.trim(), enabled: draft.enabled !== false,
      channel: draft.channel, account, provider: draft.provider, providerConfig,
      allowedUsers: allowed,
    };
    setSaving(true);
    try {
      await api(`/api/bots/${encodeURIComponent(draft.id)}`, body, { method: 'PATCH' });
      await onSaved(body.name);
    } catch (err) {
      setSaveErrors(errorLines(err?.message).length > 0 ? errorLines(err.message) : [String(err?.message ?? err)]);
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    setTestError(null);
    try {
      const prompt = testPrompt.trim();
      const result = await api(`/api/bots/${encodeURIComponent(draft.id)}/test`, prompt === '' ? {} : { prompt });
      setTestResult(result);
    } catch (err) {
      setTestError(err?.message ?? String(err));
    } finally {
      setTesting(false);
    }
  };

  return h('div', { className: 'wb-editor' },
    h('div', { className: 'wb-file-head' },
      h(Avatar, { WAO, seed: draft.id, size: 52, ring: meta.color }),
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('h3', null, draft.name || draft.id),
        h('div', { className: 'wb-sub' },
          `${meta.label} · 机器人 ID `, h('span', { className: 'wb-mono' }, draft.id),
          joined != null ? ` · ${joined} 创建` : ' · 早期创建（无日期记录）'))),
    noPorts ? h('div', { className: 'wb-notice' },
      '没有可用的渠道/引擎插件——请先到「设置 → 插件」启用 channel-wecom 与 provider 再保存。') : null,

    h(Group, {
      WAO, title: '基础', sub: '名称与启用状态', open: groups.basic,
      onToggle: () => setGroups((g) => ({ ...g, basic: !g.basic })),
    },
      h('div', { className: 'wb-field' },
        h('label', null, '机器人 ID（bot id）'),
        h('input', { className: 'wb-input wb-mono', value: draft.id, readOnly: true }),
        h('span', { className: 'wb-hint' }, '创建后不可修改；会话历史与会话文件都归属它，也决定化身长相')),
      h('div', { className: 'wb-field' },
        h('label', null, '姓名', h('span', { className: 'wb-req' }, ' *')),
        h('input', {
          className: 'wb-input', value: draft.name, maxLength: NAME_MAX,
          placeholder: '给它起个名字',
          onChange: (e) => setDraft({ ...draft, name: e.target.value }),
        }),
        h('span', { className: `wb-counter${draft.name.length > NAME_MAX ? ' over' : ''}` },
          `${draft.name.length} / ${NAME_MAX}`)),
      h('div', { className: 'wb-check' },
        h('label', { className: 'wb-switch', title: dutyOn ? '启用——保存后立即连接企微开始工作' : '暂停——只保留配置不连接；随时可再启用' },
          h('input', {
            type: 'checkbox', checked: dutyOn,
            onChange: (e) => setDraft({ ...draft, enabled: e.target.checked }),
          }),
          h('span', { className: 'wb-track' })),
        h('span', null, dutyOn ? '启用（连接企微，随时响应）' : '已暂停（只保留配置，不连接企微）')),
      h('div', { className: 'wb-field' },
        h('label', null, '工作渠道', h('span', { className: 'wb-hint', style: { marginLeft: 8 } }, '渠道 channel，当前只有企微')),
        h('select', {
          className: 'wb-select', value: draft.channel,
          onChange: (e) => setDraft({
            ...draft, channel: e.target.value,
            account: fieldsFromSchema(ports.channels.find((c) => c.id === e.target.value)?.accountSchema),
          }),
        }, ports.channels.length === 0
          ? [h('option', { value: '' }, '（无可用渠道）')]
          : ports.channels.map((c) => h('option', { key: c.id, value: c.id }, c.id))))),

    h(Group, {
      WAO, title: '连接配置', sub: '企微机器人账号（channel account）', open: groups.badge,
      onToggle: () => setGroups((g) => ({ ...g, badge: !g.badge })),
    },
      h(SchemaFields, {
        WAO, schema: channelSchema, state: draft.account, editingExisting: true,
        onChange: (account) => setDraft({ ...draft, account }),
      })),

    h(Group, {
      WAO, title: '引擎配置', sub: `${meta.label}（provider ${draft.provider || '—'}）`, open: groups.dept,
      onToggle: () => setGroups((g) => ({ ...g, dept: !g.dept })),
    },
      h('div', { className: 'wb-field' },
        h('label', null, 'Agent 引擎'),
        h('select', {
          className: 'wb-select', value: draft.provider,
          onChange: (e) => switchProvider(e.target.value),
        }, ports.providers.length === 0
          ? [h('option', { value: '' }, '（无可用引擎）')]
          : ports.providers.map((p) => h('option', { key: p.id, value: p.id },
            `${PROVIDER_LABEL[p.id] ?? p.id}（${p.id}）`))),
        h('span', { className: 'wb-hint' }, 'dsh=DeepSeek Harness / claude=Claude Code / codex=OpenAI Codex CLI / pi=pi coding agent / cursor=Cursor CLI')),
      providerSwitched ? h('div', { className: 'wb-notice' },
        `更换引擎 ${storedBot?.provider} → ${draft.provider}：保存后首轮将携带近期对话摘要续接上下文（仅文本问答对，工具/思考/压缩状态不迁移）。`) : null,
      h(SchemaFields, {
        WAO, schema: providerSchema, state: draft.providerConfig, editingExisting: true,
        onChange: (providerConfig) => setDraft({ ...draft, providerConfig }),
      })),

    h(Group, {
      WAO, title: '高级', sub: '允许用户 · 测试运行', open: groups.adv,
      onToggle: () => setGroups((g) => ({ ...g, adv: !g.adv })),
    },
      h('div', { className: 'wb-field' },
        h('label', null, '允许用户（allowedUsers）', h('span', { className: 'wb-hint', style: { marginLeft: 8 } }, '每行一个企微 userid；留空＝所有人可找它')),
        h('textarea', {
          className: 'wb-textarea', rows: 3, value: draft.allowedUsers,
          placeholder: '每行一个 userid，如\nzhangsan\nlisi',
          onChange: (e) => setDraft({ ...draft, allowedUsers: e.target.value }),
        })),
      h('div', { className: 'wb-result' },
        h('strong', null, '测试运行（试跑）'),
        h('span', { className: 'wb-hint' },
          '直接跑它已保存的引擎配置（不进引擎链、不记台账、不发企微）。默认探针「回复：收到」，可自定义提问。最长等待 60 秒。'),
        h('div', { className: 'wb-toolbar' },
          h('input', {
            className: 'wb-input', style: { flex: '1' }, value: testPrompt,
            placeholder: '自定义提问（留空 = 固定探针「回复：收到」）',
            onChange: (e) => setTestPrompt(e.target.value),
          }),
          h('button', { className: 'wb-btn', disabled: testing, onClick: runTest },
            testing ? '运行中…' : '测试运行')),
        testError != null ? h('div', { className: 'wb-error-box' }, `试跑失败：${testError}`) : null,
        testResult != null ? h('div', { className: 'wb-result', style: { marginTop: '4px' } },
          h('div', { className: 'wb-toolbar' },
            h('span', {
              className: `badge ${testResult.code === 'completed' ? 'wb-code-ok' : 'wb-code-bad'}`,
            }, testResult.code === 'completed' ? 'completed 成功' : `${testResult.code} 失败`),
            h('span', { className: 'wb-kv' }, `sessionId：${testResult.sessionId ?? '（无）'}`)),
          testResult.finalText ? h('div', { className: 'wb-result-text' }, testResult.finalText) : null,
          testResult.errorText ? h('div', { className: 'wb-field-error' }, testResult.errorText) : null) : null)),

    saveErrors != null && saveErrors.length > 0 ? h('div', { className: 'wb-error-box' },
      h('div', null, '保存未通过：'),
      h('ul', null, saveErrors.map((e, i) => h('li', { key: i }, e)))) : null,

    h('div', { className: 'wb-stickybar' },
      h('div', { className: 'wb-toolbar' },
        h('button', { className: 'wb-btn wb-btn-primary', disabled: saving || noPorts, onClick: save },
          saving ? '保存中…' : '保存配置'),
        h('span', { style: { flex: 1 } }),
        h('button', {
          className: 'wb-btn wb-btn-danger', onClick: () => setOffboardFor(storedBot ?? draft),
          title: '删除机器人——会话历史保留，可重新创建',
        }, '删除'))),

    offboardFor != null ? h(Offboard, {
      WAO, bot: offboardFor,
      onClose: () => setOffboardFor(null),
      onDone: async (deleted) => { setOffboardFor(null); await onDeleted(deleted); },
    }) : null);
};

// —— 发送消息 dialog（_legacy/push.js 精简为固定 bot 的弹层）——
const PushDialog = ({ WAO, botId, agent, onClose }) => {
  const { h, useState, useEffect, api } = WAO;
  const [chats, setChats] = useState([]);
  const [chatKey, setChatKey] = useState('');
  const [chatsError, setChatsError] = useState(null);
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null); // { ok:true, chatKey } | { ok:false, message }

  useEffect(() => {
    let alive = true;
    setChatsError(null);
    (async () => {
      try {
        const data = await api(`/api/ledger?bot=${encodeURIComponent(botId)}`);
        if (!alive) return;
        const list = chatsOf(Array.isArray(data) ? data : []);
        setChats(list);
        setChatKey(list.length > 0 ? list[0].chatKey : '');
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

  const notConnected = agent != null && (agent.enabled === false || agent.status === 'offline');
  const overLimit = content.length > PUSH_MAX;
  const canSend = chatKey !== '' && content.trim() !== '' && !overLimit && !notConnected && !sending && chatsError == null;

  return h('div', { className: 'wb-modal-wrap', onClick: () => { if (!sending) onClose(); } },
    h('div', { className: 'wb-modal', onClick: (e) => e.stopPropagation() },
      h('h3', null, `发送消息——以 ${agent?.name ?? botId} 的身份`),
      h('p', { className: 'wb-hint' }, '内容会真实送达企微，请谨慎使用。'),
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
          className: 'wb-textarea', rows: 5, maxLength: PUSH_MAX + 100, value: content,
          placeholder: '要发送的文本内容（上限 4000 字）',
          onChange: (e) => setContent(e.target.value),
        }),
        h('span', { className: `wb-counter${overLimit ? ' over' : ''}` },
          `${content.length} / ${PUSH_MAX}${overLimit ? ' — 超出上限，请删减' : ''}`)),
      notConnected ? h('div', { className: 'wb-notice' },
        `机器人当前不在线${agent?.reason ? `（原因：${agent.reason}）` : ''}——推送要求它在线（启用且渠道已连接）。`) : null,
      result?.ok === true ? h('div', { className: 'wb-banner wb-banner-ok' }, `已向 ${result.chatKey} 发送完毕。`) : null,
      result?.ok === false ? h('div', { className: 'wb-banner wb-banner-bad' }, `发送失败：${result.message}`) : null,
      h('div', { className: 'wb-toolbar' },
        h('button', {
          className: 'wb-btn wb-btn-primary', disabled: !canSend, onClick: () => void send(),
          title: notConnected ? '机器人未连接，无法推送' : undefined,
        }, sending ? '发送中…' : '发送消息'),
        h('button', { className: 'wb-btn', disabled: sending, onClick: onClose }, '关闭'))));
};

export default {
  id: 'robots',
  title: '机器人',
  icon: 'bot',
  order: 2,
  component({ WAO }) {
    const { h, useState, useEffect, api, useAgents } = WAO;
    ensurePageStyle();
    const { agents, error: agentsError } = useAgents();

    const [ports, setPorts] = useState(null);
    const [bots, setBots] = useState(null);
    const [loadError, setLoadError] = useState(null);
    const [selected, setSelected] = useState(null); // null | 'new' | botId
    const [tab, setTab] = useState('session');
    const [pushOpen, setPushOpen] = useState(false);
    const [toast, setToast] = useState(null);
    const [testFocus, setTestFocus] = useState(false); // handoff test:true → 设置 tab 展开高级组

    const reload = async () => {
      try {
        const [p, b] = await Promise.all([api('/api/ports'), api('/api/bots')]);
        setPorts(p);
        setBots(Array.isArray(b?.bots) ? b.bots : []);
        setLoadError(null);
        return p;
      } catch (err) {
        setLoadError(err?.message ?? String(err));
        return null;
      }
    };
    useEffect(() => { void reload(); }, []);

    // 跨页交接（overview 的详情/测试运行跳入）+ ?select=/&tab= 深链（截图用）
    useEffect(() => {
      let handoff = null;
      try { handoff = JSON.parse(sessionStorage.getItem(HANDOFF_KEY) ?? 'null'); } catch { handoff = null; }
      if (handoff != null) {
        sessionStorage.removeItem(HANDOFF_KEY);
        setSelected(handoff.id ?? null);
        if (TAB_IDS.includes(handoff.tab)) setTab(handoff.tab);
        if (handoff.test === true) setTestFocus(true);
        return;
      }
      const q = new URLSearchParams(location.search);
      const sel = q.get('select');
      if (sel === 'new') setSelected('new');
      else if (sel != null && sel !== '') setSelected(sel);
      const t = q.get('tab');
      if (TAB_IDS.includes(t)) setTab(t);
    }, []);

    // 选中的人从名册上消失（删除/改名）→ 回列表
    useEffect(() => {
      if (selected != null && selected !== 'new' && bots != null && !bots.some((b) => b.id === selected)) {
        setSelected(null);
      }
    }, [bots, selected]);

    useEffect(() => {
      if (toast == null) return;
      const timer = setTimeout(() => setToast(null), 4200);
      return () => clearTimeout(timer);
    }, [toast]);

    if (loadError != null && ports == null) {
      return h('div', { className: 'page' },
        h('h2', null, '机器人'),
        h('div', { className: 'error' }, `加载机器人列表失败：${loadError}`),
        h('div', { className: 'wb-toolbar' },
          h('button', { className: 'wb-btn wb-btn-primary', onClick: () => void reload() }, '重试')));
    }
    if (ports == null || bots == null) {
      return h('div', { className: 'page' }, h('h2', null, '机器人'), h('p', { className: 'muted' }, '读取机器人列表…'));
    }

    const rosterRow = (bot) => {
      const agent = agents.find((a) => a.id === bot.id);
      const status = agent?.status ?? (bot.enabled === false ? 'offline' : 'idle');
      const meta = providerMeta(bot.provider);
      const off = status === 'offline' || bot.enabled === false;
      return h('button', {
        key: bot.id,
        className: `wb-side-item${selected === bot.id ? ' active' : ''}`,
        onClick: () => { setSelected(bot.id); setTab('session'); setTestFocus(false); },
        title: statusTitle({ ...agent, status, enabled: bot.enabled }),
      },
        h(Avatar, { WAO, seed: bot.id, size: 28, ring: meta.color, mood: off ? 'sleep' : 'neutral' }),
        h('span', { className: 'wb-side-name' }, bot.name ?? bot.id),
        h('span', { className: `badge badge-${status}`, title: statusTitle({ ...agent, status }) },
          STATUS_LABEL[status] ?? status));
    };

    let editor = null;
    // ?select=new&step=N 直达创建向导第 N 步（1-5，截图基线用；越界回第 1 步）
    const initialStep = (() => {
      const n = Number(new URLSearchParams(location.search).get('step'));
      return Number.isInteger(n) && n >= 1 && n <= 5 ? n - 1 : 0;
    })();
    if (selected === 'new') {
      editor = h(Wizard, {
        WAO, ports, existingIds: new Set(bots.map((b) => b.id)), initialStep,
        onDone: () => { setSelected(null); void reload(); },
        onCreated: () => { void reload(); }, // roster refreshes behind the success page
        onOpenFile: (id) => { void reload().then(() => setSelected(id)); },
      });
    } else if (selected == null || !bots.some((b) => b.id === selected)) {
      editor = h('div', { className: 'wb-editor' },
        h('h3', null, bots.length === 0 ? '还没有机器人' : '从列表选一个，或创建一个新机器人'),
        h('p', { className: 'muted' },
          bots.length === 0
            ? '创建第一个机器人——五步就好：基本信息、引擎、工具、工作目录、连接配置。'
            : '左侧选一个机器人进入详情（会话/日志/工具/设置）；「＋ 创建机器人」新增。'),
        (ports.channels.length === 0 || ports.providers.length === 0) ? h('div', { className: 'wb-notice' },
          '还没有可用的渠道/引擎插件（channel/provider）——请先到「设置 → 插件」启用 channel-wecom 与至少一个 provider。') : null,
        h('div', { className: 'wb-toolbar' },
          h('button', { className: 'wb-btn wb-btn-primary', onClick: () => setSelected('new') }, '＋ 创建机器人')));
    } else {
      const bot = bots.find((b) => b.id === selected);
      const agent = agents.find((a) => a.id === selected) ?? null;
      const status = agent?.status ?? (bot.enabled === false ? 'offline' : 'idle');
      const meta = providerMeta(bot.provider);
      editor = h('div', { className: 'wb-editor' },
        h('div', { className: 'wb-file-head' },
          h(Avatar, { WAO, seed: bot.id, size: 52, ring: meta.color, mood: status === 'offline' || bot.enabled === false ? 'sleep' : 'neutral' }),
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('h3', null, bot.name || bot.id),
            h('div', { className: 'wb-sub' },
              `${meta.label} · 机器人 ID `, h('span', { className: 'wb-mono' }, bot.id),
              ' · ', h('span', { className: `badge badge-${status}`, title: statusTitle({ ...agent, status, enabled: bot.enabled }) },
                STATUS_LABEL[status] ?? status))),
          h('button', {
            className: 'wb-btn', onClick: () => setPushOpen(true),
            title: '以它的身份向群聊/单聊主动推送消息（真实送达）',
          }, '发送消息'),
          h('button', { className: 'wb-btn', onClick: () => setSelected(null), title: '回到机器人列表' }, '← 返回列表')),
        agentsError != null ? h('div', { className: 'error', style: { marginTop: 8 } },
          bannerText('加载实时状态失败：', agentsError)) : null,
        // AI 操作提示行（v2）：一行点到为止——这个 bot 的启停/推送/配置都能
        // 让 AI 经 MCP 直接做，完整接入去设置 → AI 操作。
        h('div', {
          className: 'wb-hint wb-bot-ai-hint',
          title: '经 MCP 网关（wao-company server）对话式操作；工具：set_enabled 暂停/启用、broadcast 推送、update_bot 改配置',
        },
          '💡 你的 AI 可以直接操作这个机器人：',
          h('code', null, `"帮我暂停 ${bot.name ?? bot.id}"`), ' → set_enabled · ',
          h('code', null, `"给 ${bot.name ?? bot.id} 发一条推送"`), ' → broadcast · 接入方法见',
          h('button', { className: 'wb-linklike', onClick: () => goSettingsAi() }, '设置 → AI 操作')),
        h('div', { className: 'wb-tabs', style: { margin: '14px 0 0' } },
          TAB_IDS.map((t) => h('button', {
            key: t,
            className: `wb-tab${tab === t ? ' active' : ''}`,
            onClick: () => setTab(t),
          }, TAB_LABEL[t]))),
        // key=selected：切机器人时整块重挂载——否则引擎会话子视图会残留上一
        // 台的 session 编号与警告，被误读成新机器人的会话缺失（走查 L14）
        h('div', { key: selected, style: { marginTop: 14 } },
          tab === 'session' ? h(DetailSession, { WAO, botId: selected, agent: agent ?? { provider: bot.provider } })
          : tab === 'logs' ? h(DetailLogs, { WAO, botId: selected })
          : tab === 'tools' ? h(DetailTools, { WAO, botId: selected })
          : h(DetailSettings, {
            WAO, bot, ports, focusTest: testFocus,
            onSaved: async (name) => {
              await reload();
              setTestFocus(false);
              setToast(`已保存「${name}」的机器人配置`);
            },
            onDeleted: async (deleted) => {
              setSelected(null);
              await reload();
              setToast(`${deleted.name ?? deleted.id} 已删除——会话历史保留，可随时重新创建`);
            },
          })));
    }

    return h('div', { className: 'page' },
      h('h2', null, '机器人'),
      h('p', { className: 'muted' }, '创建与管理机器人：会话历史、日志、工具配置、引擎与推送，都在每个机器人的详情里'),
      loadError != null ? h('div', { className: 'error' }, `刷新机器人列表失败：${loadError}（可先编辑，保存时仍会校验）`) : null,
      h('div', { className: 'wb-crud' },
        h('div', { className: 'wb-side' },
          h('button', {
            className: `wb-side-item wb-side-new${selected === 'new' ? ' active' : ''}`,
            onClick: () => setSelected('new'),
          }, h('span', { className: 'wb-side-name' }, '＋ 创建机器人')),
          bots.length === 0
            ? h('div', { className: 'wb-side-id', style: { padding: '4px 10px' } }, '机器人列表还是空的')
            : bots.map(rosterRow)),
        editor),
      selected != null && selected !== 'new' && pushOpen ? h(PushDialog, {
        WAO, botId: selected, agent: agents.find((a) => a.id === selected) ?? null,
        onClose: () => setPushOpen(false),
      }) : null,
      toast != null ? h('div', { className: 'wb-toast', role: 'status' }, toast) : null);
  },
};
