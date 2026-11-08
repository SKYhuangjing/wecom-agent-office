// 人事部 (company-metaphor redesign P2): 花名册（化身头像+状态）+ 入职向导
// + 员工档案编辑（分组折叠+sticky 保存栏+岗前测试）+ 离职面谈 + 调休/返岗。
// 数据面不变：GET /api/ports（schema）+ GET /api/bots（脱敏记录）；表单仍由
// schema 驱动（form.js）。双层语言：主层公司话，技术词（bot id、provider
// 名、schema 字段）收进 tooltip/副标题。
import { ensurePageStyle } from './style.js';
import { fieldsFromSchema, SchemaFields, serializeSchema } from './form.js';
import { HANDOFF_KEY } from './list.js';
import { Avatar, STATUS_LABEL, statusTitle, providerMeta, fmtDate } from './hr.js';
import { Wizard } from './wizard.js';
import { Offboard } from './offboard.js';

const NAME_MAX = 30;
const errorLines = (message) => String(message ?? '').split('; ').filter((s) => s.trim() !== '');

const blankDraft = (ports) => ({
  id: '', name: '', enabled: true,
  channel: ports?.channels?.[0]?.id ?? '', provider: ports?.providers?.[0]?.id ?? '',
  account: fieldsFromSchema(ports?.channels?.[0]?.accountSchema),
  providerConfig: fieldsFromSchema(ports?.providers?.[0]?.configSchema),
  allowedUsers: '',
});

const draftFromRecord = (bot, ports) => ({
  id: bot.id, name: bot.name ?? '', enabled: bot.enabled !== false,
  channel: bot.channel ?? '', provider: bot.provider ?? '',
  account: fieldsFromSchema(ports?.channels?.find((c) => c.id === bot.channel)?.accountSchema, bot.account),
  providerConfig: fieldsFromSchema(ports?.providers?.find((p) => p.id === bot.provider)?.configSchema, bot.providerConfig),
  allowedUsers: Array.isArray(bot.allowedUsers) ? bot.allowedUsers.join('\n') : '',
});

// 员工档案的分组折叠（基础/工牌凭证/岗位配置/高级）
const Group = ({ WAO, title, sub, open, onToggle, children }) => {
  const { h } = WAO;
  return h('section', { className: `wb-group${open ? ' open' : ''}` },
    h('button', { className: 'wb-group-head', onClick: onToggle, 'aria-expanded': open ? 'true' : 'false' },
      h('span', { className: 'wb-group-caret' }, open ? '▾' : '▸'),
      h('span', { className: 'wb-group-title' }, title),
      sub != null ? h('span', { className: 'wb-hint' }, sub) : null),
    open ? h('div', { className: 'wb-group-body' }, children) : null);
};

export default {
  id: 'bots',
  title: '机器人管理',
  icon: 'bot',
  order: 2,
  component({ WAO }) {
    const { h, useState, useEffect, api, useAgents } = WAO;
    ensurePageStyle();
    const { agents } = useAgents(); // roster 状态徽标

    const [ports, setPorts] = useState(null);
    const [bots, setBots] = useState(null);
    const [loadError, setLoadError] = useState(null);
    const [selected, setSelected] = useState(null); // null | 'new' | botId
    const [draft, setDraft] = useState(null);
    const [saveErrors, setSaveErrors] = useState(null);
    const [saving, setSaving] = useState(false);
    const [offboardFor, setOffboardFor] = useState(null); // bot record
    const [toast, setToast] = useState(null); // 办结送别 / 保存成功
    const [testPrompt, setTestPrompt] = useState('');
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState(null);
    const [testError, setTestError] = useState(null);
    const [groups, setGroups] = useState({ basic: true, badge: true, dept: true, adv: false });

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

    useEffect(() => { reload(); }, []);

    // 工作台交接（编辑/试跑/去入职）+ ?select= 直达（截图用）
    useEffect(() => {
      let handoff = null;
      try { handoff = JSON.parse(sessionStorage.getItem(HANDOFF_KEY) ?? 'null'); } catch { handoff = null; }
      if (handoff == null) {
        const param = new URLSearchParams(location.search).get('select');
        if (param === 'new') setSelected('new');
        else if (param != null && param !== '') setSelected(param);
        return;
      }
      sessionStorage.removeItem(HANDOFF_KEY);
      if (handoff.action === 'new') setSelected('new');
      else if (handoff.action === 'test') { setSelected(handoff.id); setTestPrompt(''); setGroups((g) => ({ ...g, adv: true })); }
      else if (handoff.action === 'edit') setSelected(handoff.id);
    }, []);

    useEffect(() => {
      setSaveErrors(null);
      setTestResult(null);
      setTestError(null);
      if (bots == null || ports == null) return;
      if (selected === 'new' || selected == null) { setDraft(null); return; }
      const bot = bots.find((b) => b.id === selected) ?? null;
      setDraft(bot == null ? null : draftFromRecord(bot, ports));
    }, [selected, bots, ports]);

    useEffect(() => {
      if (toast == null) return;
      const timer = setTimeout(() => setToast(null), 4200);
      return () => clearTimeout(timer);
    }, [toast]);

    if (loadError != null && ports == null) {
      return h('div', { className: 'page' },
        h('h2', null, '机器人管理'),
        h('div', { className: 'error' }, `加载机器人列表失败：${loadError}`),
        h('div', { className: 'wb-toolbar' },
          h('button', { className: 'wb-btn wb-btn-primary', onClick: () => reload() }, '重试')));
    }
    if (ports == null || bots == null) {
      return h('div', { className: 'page' }, h('h2', null, '机器人管理'), h('p', { className: 'muted' }, '读取机器人列表…'));
    }

    const channelSchema = ports.channels.find((c) => c.id === draft?.channel)?.accountSchema ?? [];
    const providerSchema = ports.providers.find((p) => p.id === draft?.provider)?.configSchema ?? [];
    const editingExisting = selected != null && selected !== 'new';
    const storedBot = editingExisting ? bots.find((b) => b.id === selected) : null;
    const providerSwitched = editingExisting && draft != null
      && draft.provider !== storedBot?.provider;
    const noPorts = ports.channels.length === 0 || ports.providers.length === 0;
    const roster = new Set(bots.map((b) => b.id));

    const switchProvider = (next) => {
      const stored = editingExisting ? storedBot : null;
      const fromRecord = stored != null && stored.provider === next;
      setDraft((d) => ({
        ...d,
        provider: next,
        providerConfig: fieldsFromSchema(
          ports.providers.find((p) => p.id === next)?.configSchema,
          fromRecord ? stored.providerConfig : undefined,
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
        const resp = editingExisting
          ? await api(`/api/bots/${encodeURIComponent(selected)}`, body, { method: 'PATCH' })
          : await api('/api/bots', body);
        await reload();
        setSelected(resp?.bot?.id ?? body.id);
        setToast(`已保存「${body.name}」的机器人配置`);
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
        const result = await api(`/api/bots/${encodeURIComponent(selected)}/test`, prompt === '' ? {} : { prompt });
        setTestResult(result);
      } catch (err) {
        setTestError(err?.message ?? String(err));
      } finally {
        setTesting(false);
      }
    };

    const rosterRow = (bot) => {
      const agent = agents.find((a) => a.id === bot.id);
      const status = agent?.status ?? (bot.enabled === false ? 'offline' : 'idle');
      const meta = providerMeta(bot.provider);
      const off = status === 'offline' || bot.enabled === false;
      return h('button', {
        key: bot.id,
        className: `wb-side-item${selected === bot.id ? ' active' : ''}`,
        onClick: () => setSelected(bot.id),
        title: statusTitle({ ...agent, status, enabled: bot.enabled }),
      },
        h(Avatar, { WAO, seed: bot.id, size: 28, ring: meta.color, mood: off ? 'sleep' : 'neutral' }),
        h('span', { className: 'wb-side-name' }, bot.name ?? bot.id),
        h('span', { className: `badge badge-${status}`, title: statusTitle({ ...agent, status }) },
          STATUS_LABEL[status] ?? status));
    };

    let editor = null;
    // ?select=new&step=N 直达入职向导第 N 步（1-5，截图基线用；越界回第 1 步）
    const initialStep = (() => {
      const n = Number(new URLSearchParams(location.search).get('step'));
      return Number.isInteger(n) && n >= 1 && n <= 5 ? n - 1 : 0;
    })();
    if (selected === 'new') {
      editor = h(Wizard, {
        WAO, ports, existingIds: roster, initialStep,
        onDone: () => { setSelected(null); void reload(); },
        onCreated: () => { void reload(); }, // roster refreshes behind the success page
        onOpenFile: (id) => { void reload().then(() => setSelected(id)); },
      });
    } else if (draft == null) {
      editor = h('div', { className: 'wb-editor' },
        h('h3', null, bots.length === 0 ? '还没有机器人' : '从列表选一个，或创建一个新机器人'),
        h('p', { className: 'muted' },
          bots.length === 0
            ? '创建第一个机器人——五步就好：基本信息、引擎、工具、工作目录、连接配置。'
            : '左侧选一个机器人查看/编辑配置；「＋ 创建机器人」新增。'),
        noPorts ? h('div', { className: 'wb-notice' },
          '还没有可用的渠道/引擎插件（channel/provider）——请先到插件管理启用 channel-wecom 与至少一个 provider。') : null,
        h('div', { className: 'wb-toolbar' },
          h('button', { className: 'wb-btn wb-btn-primary', onClick: () => setSelected('new') }, '＋ 创建机器人')));
    } else {
      const meta = providerMeta(draft.provider);
      const joined = fmtDate(storedBot?.createdAt);
      const dutyOn = draft.enabled !== false;
      editor = h('div', { className: 'wb-editor' },
        h('div', { className: 'wb-file-head' },
          h(Avatar, { WAO, seed: draft.id, size: 52, ring: meta.color }),
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('h3', null, draft.name || draft.id),
            h('div', { className: 'wb-sub' },
              `${meta.label} · 机器人 ID `, h('span', { className: 'wb-mono' }, draft.id),
              joined != null ? ` · ${joined} 创建` : ' · 早期创建（无日期记录）'))),
        noPorts ? h('div', { className: 'wb-notice' },
          '没有可用的渠道/引擎插件——请先到插件管理启用 channel-wecom 与 provider 再保存。') : null,

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
            WAO, schema: channelSchema, state: draft.account, editingExisting,
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
            h('span', { className: 'wb-hint' }, 'dsh=DeepSeek Harness / claude=Claude Code / codex=OpenAI Codex CLI / pi=pi coding agent')),
          providerSwitched ? h('div', { className: 'wb-notice' },
            `更换引擎 ${storedBot?.provider} → ${draft.provider}：保存后首轮将携带近期对话摘要续接上下文（仅文本问答对，工具/思考/压缩状态不迁移）。`) : null,
          h(SchemaFields, {
            WAO, schema: providerSchema, state: draft.providerConfig, editingExisting,
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
            h('button', { className: 'wb-btn', disabled: saving, onClick: () => setSelected(null) }, '关闭'),
            h('span', { style: { flex: 1 } }),
            h('button', {
              className: 'wb-btn wb-btn-danger', onClick: () => setOffboardFor(storedBot ?? draft),
              title: '删除机器人——会话历史保留，可重新创建',
            }, '删除'))));
    }

    return h('div', { className: 'page' },
      h('h2', null, '机器人管理'),
      h('p', { className: 'muted' }, '创建机器人、维护机器人配置、暂停/启用、删除'),
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
      offboardFor != null ? h(Offboard, {
        WAO, bot: offboardFor,
        onClose: () => setOffboardFor(null),
        onDone: async (bot) => {
          setOffboardFor(null);
          setSelected(null);
          setDraft(null);
          await reload();
          setToast(`${bot.name ?? bot.id} 已删除——会话历史保留，可随时重新创建`);
        },
      }) : null,
      toast != null ? h('div', { className: 'wb-toast', role: 'status' }, toast) : null);
  },
};

// 引擎下拉的展示名（provider id → 引擎称呼）
const PROVIDER_LABEL = { dsh: 'DSH 引擎', claude: 'Claude 引擎', codex: 'Codex 引擎', pi: 'pi 引擎' };
