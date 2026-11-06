// Bot 管理 (M3 T2): left-side bot list + right-side editor. Forms are
// schema-driven from GET /api/ports (channel accountSchema / provider
// configSchema); records load via GET /api/bots (sanitized — secrets are
// write-only, blank password on PATCH keeps the stored value server-side).
// Cross-provider switch keeps id/name/channel/account, resets providerConfig
// to the new schema's defaults and shows the DESIGN §7 handoff notice.
import { ensurePageStyle } from './style.js';
import { fieldsFromSchema, SchemaFields, serializeSchema } from './form.js';
import { HANDOFF_KEY } from './list.js';

const STATUS_LABEL = { working: '工作中', idle: '空闲', offline: '离线' };

// The kernel joins validation errors with '; ' and api() surfaces exactly
// that message — split it back into bullet lines for the inline error box.
const errorLines = (message) => String(message ?? '').split('; ').filter((s) => s.trim() !== '');

const blankDraft = (ports) => {
  const channel = ports?.channels?.[0]?.id ?? '';
  const provider = ports?.providers?.[0]?.id ?? '';
  return {
    id: '', name: '', enabled: true, channel, provider,
    account: fieldsFromSchema(ports?.channels?.[0]?.accountSchema),
    providerConfig: fieldsFromSchema(ports?.providers?.[0]?.configSchema),
  };
};

const draftFromRecord = (bot, ports) => ({
  id: bot.id, name: bot.name ?? '', enabled: bot.enabled !== false,
  channel: bot.channel ?? '', provider: bot.provider ?? '',
  account: fieldsFromSchema(ports?.channels?.find((c) => c.id === bot.channel)?.accountSchema, bot.account),
  providerConfig: fieldsFromSchema(ports?.providers?.find((p) => p.id === bot.provider)?.configSchema, bot.providerConfig),
});

export default {
  id: 'bots',
  title: 'Bot 管理',
  icon: '⚙',
  order: 2,
  component({ WAO }) {
    const { h, useState, useEffect, api, useAgents } = WAO;
    ensurePageStyle();
    const { agents } = useAgents(); // status badges in the side list

    const [ports, setPorts] = useState(null);   // {channels:[{id,accountSchema}], providers:[{id,configSchema}]}
    const [bots, setBots] = useState(null);     // sanitized records
    const [loadError, setLoadError] = useState(null);
    const [selected, setSelected] = useState(null); // saved record behind the editor (null = new draft)
    const [draft, setDraft] = useState(null);
    const [saveErrors, setSaveErrors] = useState(null);
    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [deleteText, setDeleteText] = useState('');
    const [testPrompt, setTestPrompt] = useState('');
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState(null);
    const [testError, setTestError] = useState(null);

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

    // Consume the workbench handoff (list 编辑/试跑/去创建 shortcuts) once, and
    // honor an initial ?select=<id|new> for harness screenshots of a state.
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
      else if (handoff.action === 'test') { setSelected(handoff.id); setTestPrompt(''); }
      else if (handoff.action === 'edit') setSelected(handoff.id);
    }, []);

    // Selection → draft (fresh from the last loaded records).
    useEffect(() => {
      setSaveErrors(null);
      setTestResult(null);
      setTestError(null);
      setDeleteText('');
      if (bots == null || ports == null) return;
      if (selected === 'new') { setDraft(blankDraft(ports)); return; }
      const bot = bots.find((b) => b.id === selected) ?? null;
      setDraft(bot == null ? null : draftFromRecord(bot, ports));
    }, [selected, bots, ports]);

    if (loadError != null && ports == null) {
      return h('div', { className: 'page' },
        h('h2', null, 'Bot 管理'),
        h('div', { className: 'error' }, `加载配置面失败：${loadError}`),
        h('div', { className: 'wb-toolbar' },
          h('button', { className: 'wb-btn wb-btn-primary', onClick: () => reload() }, '重试')),
      );
    }
    if (ports == null || bots == null) {
      return h('div', { className: 'page' }, h('h2', null, 'Bot 管理'), h('p', { className: 'muted' }, '加载中…'));
    }

    const channelSchema = ports.channels.find((c) => c.id === draft?.channel)?.accountSchema ?? [];
    const providerSchema = ports.providers.find((p) => p.id === draft?.provider)?.configSchema ?? [];
    const editingExisting = selected != null && selected !== 'new';
    const providerSwitched = editingExisting && draft != null
      && draft.provider !== bots.find((b) => b.id === selected)?.provider;
    const noPorts = ports.channels.length === 0 || ports.providers.length === 0;

    const switchProvider = (next) => {
      // Switching back to the STORED provider restores its saved config (not
      // schema defaults) — an accidental detour must not read as a re-config.
      const stored = editingExisting ? bots.find((b) => b.id === selected) : null;
      const fromRecord = stored != null && stored.provider === next;
      setDraft((d) => ({
        ...d,
        provider: next,
        // Keep id/name/channel/account; providerConfig restarts from the new
        // schema's defaults (DESIGN §7 跨 provider 切换 → 交接) — or from the
        // stored record when next IS the stored provider.
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
      if (!editingExisting && (draft.id.trim() === '' || draft.name.trim() === '')) {
        local.push('id 与名称为必填项（id 创建后不可修改，建议小写字母-数字-连字符）');
      } else if (editingExisting && draft.name.trim() === '') {
        local.push('名称为必填项');
      }
      if (local.length > 0) { setSaveErrors(local); return; }
      const body = {
        id: draft.id.trim(), name: draft.name.trim(), enabled: draft.enabled !== false,
        channel: draft.channel, account, provider: draft.provider, providerConfig,
      };
      setSaving(true);
      try {
        const resp = editingExisting
          ? await api(`/api/bots/${encodeURIComponent(selected)}`, body, { method: 'PATCH' })
          : await api('/api/bots', body);
        await reload();
        setSelected(resp?.bot?.id ?? body.id);
      } catch (err) {
        setSaveErrors(errorLines(err?.message).length > 0 ? errorLines(err.message) : [String(err?.message ?? err)]);
      } finally {
        setSaving(false);
      }
    };

    const del = async () => {
      setDeleting(true);
      setSaveErrors(null);
      try {
        await api(`/api/bots/${encodeURIComponent(selected)}`, undefined, { method: 'DELETE' });
        await reload();
        setSelected(null);
        setDraft(null);
      } catch (err) {
        setSaveErrors(errorLines(err?.message ?? String(err)));
      } finally {
        setDeleting(false);
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

    const sideItem = (bot) => {
      const agent = agents.find((a) => a.id === bot.id);
      const status = agent?.status ?? (bot.enabled === false ? 'offline' : 'idle');
      return h('button', {
        key: bot.id,
        className: `wb-side-item${selected === bot.id ? ' active' : ''}`,
        onClick: () => setSelected(bot.id),
      },
        h('span', { className: 'wb-side-name' }, bot.name ?? bot.id),
        h('span', { className: `badge badge-${status}`, title: agent?.reason ?? undefined },
          STATUS_LABEL[status] ?? status));
    };

    let editor = null;
    if (draft == null) {
      editor = h('div', { className: 'wb-editor' },
        h('h3', null, bots.length === 0 ? '还没有机器人' : '选择或创建一个机器人'),
        h('p', { className: 'muted' },
          bots.length === 0
            ? '创建第一个 bot：填好企微机器人凭证和一个 provider 的工作目录即可。'
            : '左侧选择一个 bot 查看/编辑，或新建一个。'),
        noPorts ? h('div', { className: 'wb-notice' },
          '没有可用的 channel/provider 插件——请先在插件管理中启用 channel-wecom 与至少一个 provider。') : null,
        h('div', { className: 'wb-toolbar' },
          h('button', { className: 'wb-btn wb-btn-primary', onClick: () => setSelected('new') }, '新建机器人')),
      );
    } else {
      editor = h('div', { className: 'wb-editor' },
        h('h3', null, editingExisting ? `编辑：${draft.name || draft.id}` : '新建机器人'),
        noPorts ? h('div', { className: 'wb-notice' },
          '没有可用的 channel/provider 插件——请先启用 channel-wecom 与至少一个 provider 再保存。') : null,

        h('div', { className: 'wb-field' },
          h('label', null, 'id', editingExisting ? null : h('span', { className: 'wb-req' }, ' *')),
          h('input', {
            className: 'wb-input', value: draft.id, readOnly: editingExisting,
            placeholder: '如 main-bot（创建后不可修改）',
            onChange: (e) => setDraft({ ...draft, id: e.target.value }),
          }),
          editingExisting ? h('span', { className: 'wb-hint' }, 'id 是台账/会话文件的归属，创建后不可修改') : null),
        h('div', { className: 'wb-field' },
          h('label', null, '名称', h('span', { className: 'wb-req' }, ' *')),
          h('input', {
            className: 'wb-input', value: draft.name, placeholder: '展示名，如「主号机器人」',
            onChange: (e) => setDraft({ ...draft, name: e.target.value }),
          })),
        h('div', { className: 'wb-check' },
          h('input', {
            type: 'checkbox', checked: draft.enabled !== false,
            onChange: (e) => setDraft({ ...draft, enabled: e.target.checked }),
          }),
          h('span', null, '启用（保存后立即连接企微；取消勾选则只存配置不连接）')),
        h('div', { className: 'wb-field' },
          h('label', null, '渠道'),
          h('select', {
            className: 'wb-select', value: draft.channel,
            onChange: (e) => setDraft({
              ...draft, channel: e.target.value,
              account: fieldsFromSchema(ports.channels.find((c) => c.id === e.target.value)?.accountSchema),
            }),
          }, ports.channels.length === 0
            ? [h('option', { value: '' }, '（无可用渠道）')]
            : ports.channels.map((c) => h('option', { key: c.id, value: c.id }, c.id)))),

        h('div', { className: 'wb-section-title' }, '渠道账号'),
        h(SchemaFields, {
          WAO, schema: channelSchema, state: draft.account, editingExisting,
          onChange: (account) => setDraft({ ...draft, account }),
        }),

        h('div', { className: 'wb-section-title' }, 'Provider'),
        h('div', { className: 'wb-field' },
          h('select', {
            className: 'wb-select', value: draft.provider,
            onChange: (e) => switchProvider(e.target.value),
          }, ports.providers.length === 0
            ? [h('option', { value: '' }, '（无可用 provider）')]
            : ports.providers.map((p) => h('option', { key: p.id, value: p.id }, p.id))),
          h('span', { className: 'wb-hint' }, 'dsh=DeepSeek Harness / claude=Claude Code / codex=OpenAI Codex CLI')),
        providerSwitched ? h('div', { className: 'wb-notice' },
          `已从 ${bots.find((b) => b.id === selected)?.provider} 切到 ${draft.provider}：保存后首轮将携带近期对话摘要续接上下文（仅文本问答对，工具/思考/压缩状态不迁移）。`) : null,
        h(SchemaFields, {
          WAO, schema: providerSchema, state: draft.providerConfig, editingExisting,
          onChange: (providerConfig) => setDraft({ ...draft, providerConfig }),
        }),

        saveErrors != null && saveErrors.length > 0 ? h('div', { className: 'wb-error-box' },
          h('div', null, '保存未通过：'),
          h('ul', null, saveErrors.map((e, i) => h('li', { key: i }, e)))) : null,
        h('div', { className: 'wb-toolbar' },
          h('button', { className: 'wb-btn wb-btn-primary', disabled: saving || noPorts, onClick: save },
            saving ? '保存中…' : editingExisting ? '保存修改' : '创建'),
          h('button', { className: 'wb-btn', disabled: saving, onClick: () => setSelected(null) }, '取消')),

        editingExisting ? h('div', { className: 'wb-danger' },
          h('strong', null, '删除机器人'),
          h('span', { className: 'wb-hint' },
            `删除 ${selected} 会停掉它的连接、清空注册表记录，并连带清理 provider 物化的配置（如 dsh profile）。台账与会话文件保留。此操作不可撤销。`),
          h('div', { className: 'wb-field' },
            h('label', null, `输入 bot id「${selected}」确认`),
            h('input', {
              className: 'wb-input', value: deleteText,
              placeholder: selected, onChange: (e) => setDeleteText(e.target.value),
            })),
          h('div', null,
            h('button', {
              className: 'wb-btn wb-btn-danger', disabled: deleting || deleteText !== selected, onClick: del,
            }, deleting ? '删除中…' : '确认删除'))) : null,

        editingExisting ? h('div', { className: 'wb-result' },
          h('strong', null, '试跑'),
          h('span', { className: 'wb-hint' },
            '直接跑该 bot 已保存的 provider 配置（不进引擎链、不记台账、不发企微）。默认探针「回复：收到」，可自定义提问。最长等待 60 秒。'),
          h('div', { className: 'wb-toolbar' },
            h('input', {
              className: 'wb-input', style: { flex: '1' }, value: testPrompt,
              placeholder: '自定义提问（留空 = 固定探针「回复：收到」）',
              onChange: (e) => setTestPrompt(e.target.value),
            }),
            h('button', { className: 'wb-btn', disabled: testing, onClick: runTest },
              testing ? '试跑中…' : '试跑')),
          testError != null ? h('div', { className: 'wb-error-box' }, `试跑失败：${testError}`) : null,
          testResult != null ? h('div', { className: 'wb-result', style: { marginTop: '4px' } },
            h('div', { className: 'wb-toolbar' },
              h('span', {
                className: `badge ${testResult.code === 'completed' ? 'wb-code-ok' : 'wb-code-bad'}`,
              }, testResult.code === 'completed' ? 'completed 成功' : `${testResult.code} 失败`),
              h('span', { className: 'wb-kv' }, `sessionId：${testResult.sessionId ?? '（无）'}`)),
            testResult.finalText ? h('div', { className: 'wb-result-text' }, testResult.finalText) : null,
            testResult.errorText ? h('div', { className: 'wb-field-error' }, testResult.errorText) : null,
          ) : null) : null,
      );
    }

    return h('div', { className: 'page' },
      h('h2', null, 'Bot 管理'),
      loadError != null ? h('div', { className: 'error' }, `刷新列表失败：${loadError}（可先编辑，保存时仍会校验）`) : null,
      h('div', { className: 'wb-crud' },
        h('div', { className: 'wb-side' },
          h('button', {
            className: `wb-side-item${selected === 'new' ? ' active' : ''}`,
            onClick: () => setSelected('new'),
          }, h('span', { className: 'wb-side-name' }, '＋ 新建机器人')),
          bots.length === 0
            ? h('div', { className: 'wb-side-id', style: { padding: '4px 10px' } }, '还没有机器人')
            : bots.map(sideItem)),
        editor));
  },
};
