// 资产科 (W3 T4, DESIGN-ASSETS §2/§8): one registry, two views. 资产清单 =
// GET/POST/PATCH/DELETE /api/assets（mcp 位置掩码 __MASKED__ 的「留掩码=不改」
// 回写语义）；装备台 = per-bot 绑定面（GET /api/bots 的 assets 摘要 +
// POST/DELETE /api/bots/:id/assets + POST /api/bots/:id/rematerialize-assets，
// 警示条与工具装备态徽章来自 /api/agents assetWarnings/assetTools——后者经
// manifest.tools 回显，§7.1/§7.2）。公司话词表（§8.1 P2 裁定 rev.2）：
// 徽章与文案只用「配发」(mode:'shared') /「私发」(mode:'exclusive')；卸下装备
// =unbind，重新物化=rematerialize，下架=DELETE 资产；技术词（type/mode 原值、
// 落盘路径）收进 tooltip/副标题——双层语言，运维不歧义。
import { ensurePageStyle } from './style.js';
import { IconEl } from './icons.js';

// （词表：skill=技能…；wizard 第 3.5 步复用同一张类型标签表）
export const TYPE_LABEL = { skill: '技能', memory: '记忆', mcp: 'MCP', prompt: '提示词', tool: '工具' };
const TYPE_BLURB = {
  skill: '一份可复用的技能说明，物化成机器人工作目录里的技能文件',
  memory: '长期记事本：随工具统一更新的团队笔记（每行一条）',
  mcp: 'MCP server 桩子（stdio/http 两形态；env/headers 是机密位，保存后不回显）',
  prompt: '一段可复用的提示词文案',
  tool: '白名单工具：rtk（token 瘦身钩子）/ ripgrep（代码检索指引）',
};
const MODE_LABEL = { shared: '共享', exclusive: '独立' };
const MODE_HINT = {
  shared: '跟源更新：工具改动即时同步到它（shared）',
  exclusive: '快照隔离：绑定时定格一份独立副本，源更新不跟版（exclusive）',
};
const ORIGIN_LABEL = { operator: '控制台', mcp: 'Agent 自建' };
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DESC_MAX = 200;
const errorLines = (message) => String(message ?? '').split('; ').filter((s) => s.trim() !== '');
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fmtTime = (at) => (Number.isFinite(at) && at > 0 ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '—');

// —— 新建/编辑表单：per-type 内容形状（§4 闭合 schema 的 UI 面）————————————————

const blankForm = (type = 'skill') => ({
  type, name: '', description: '',
  skillName: '', skillDescription: '', body: '',
  servers: '', text: '', notes: '', kind: 'rtk', extraHints: '',
});

// 从（已剥敏的）清单行回填表单：mcp 的 env/headers 值已是 __MASKED__ 位置掩码。
const formFromAsset = (a) => ({
  type: a.type ?? 'skill', name: a.name ?? '', description: a.description ?? '',
  skillName: a.content?.name ?? '', skillDescription: a.content?.description ?? '', body: a.content?.body ?? '',
  servers: isObject(a.content?.servers) ? `${JSON.stringify(a.content.servers, null, 2)}\n` : '',
  text: a.content?.text ?? '',
  notes: Array.isArray(a.content?.notes) ? a.content.notes.join('\n') : '',
  kind: a.content?.kind === 'ripgrep' ? 'ripgrep' : 'rtk',
  extraHints: a.content?.options?.extraHints ?? '',
});

// 表单 → POST/PATCH body。本地只挡「必填缺失/JSON 不解析/slug 不合法」这类
// 一眼错；字段级细则（serverId 形态、条数上限、wao 标记行……）由服务端 400
// 的 errors 文案照实转达——拒绝优于静默纠正，两边不重抄规则。
const serializeForm = (f) => {
  const errors = [];
  const name = f.name.trim();
  if (name === '') errors.push('工具名为必填项');
  else if (!SLUG_RE.test(name)) errors.push('工具名必须符合命名规则：小写字母/数字开头，可含连字符，禁点号与路径分隔符（≤64 字符）');
  const content = {};
  if (f.type === 'skill') {
    const sn = f.skillName.trim();
    if (sn === '') errors.push('技能名（content.name）为必填项');
    else if (!SLUG_RE.test(sn)) errors.push('技能名不符合命名规则（同工具名：小写/数字/连字符，禁点号）');
    else content.name = sn;
    if (f.skillDescription.trim() !== '') content.description = f.skillDescription;
    if (f.body.trim() === '') errors.push('技能正文（content.body）为必填项');
    else content.body = f.body;
  } else if (f.type === 'mcp') {
    const trimmed = f.servers.trim();
    if (trimmed === '') errors.push('servers JSON 为必填项');
    else {
      try {
        const parsed = JSON.parse(trimmed);
        if (!isObject(parsed)) errors.push('servers 必须是 JSON 对象（{ "serverId": {…} }），不是数组或 null');
        else content.servers = parsed;
      } catch (err) {
        errors.push(`servers JSON 解析失败：${err?.message ?? err}`);
      }
    }
  } else if (f.type === 'prompt') {
    if (f.text.trim() === '') errors.push('提示词正文（content.text）为必填项');
    else content.text = f.text;
  } else if (f.type === 'memory') {
    content.notes = f.notes.split('\n').map((s) => s.trim()).filter(Boolean);
  } else if (f.type === 'tool') {
    content.kind = f.kind;
    if (f.kind === 'ripgrep' && f.extraHints.trim() !== '') content.options = { extraHints: f.extraHints };
  }
  const body = { type: f.type, name, content };
  if (f.description.trim() !== '') body.description = f.description.trim();
  return { body, errors };
};

// —— 小件 ————————————————————————————————————————————————————————————

const TypeBadge = ({ h, type }) => h('span', {
  className: `badge wb-atype-${type}`, title: `type: ${type}`,
}, TYPE_LABEL[type] ?? type);

const ModeBadge = ({ h, mode }) => h('span', {
  className: `badge wb-bmode-${mode}`, title: `mode: ${mode} —— ${MODE_HINT[mode] ?? ''}`,
}, MODE_LABEL[mode] ?? mode);

// 工具装备态徽章（§7.1/§7.2 manifest.tools 经 /api/agents assetTools 回显）：
// armed/available → ✓ 已配置 <kind> <version>；unavailable → ⚠ 未安装（绑定
// 在册、盘面未装备——装好二进制后「重新物化」即可）；无清单条目 → 未物化。
// 徽章配色单色收敛：ok/warn 语义色 + 内联 SVG icon。
const TOOL_OK_STATES = new Set(['armed', 'available']);
const ToolBadge = ({ h, entry }) => {
  if (entry == null) {
    return h('span', {
      className: 'wb-hint',
      title: '物化清单（manifest.tools）暂无此工具的记录——绑定已记录但尚未物化，点「重新物化」补跑',
    }, '未物化');
  }
  if (TOOL_OK_STATES.has(entry.state)) {
    return h('span', {
      className: 'badge wb-tool-ok',
      title: `manifest.tools state: ${entry.state}——工具已落到工作目录生效`,
    }, h(IconEl, { h, name: 'check', size: 11 }), `已配置 ${entry.version ?? entry.kind}`);
  }
  return h('span', {
    className: 'badge wb-srcdel',
    title: `manifest.tools state: ${entry.state ?? 'unavailable'}（unavailable）——${entry.kind} 二进制不在本机，绑定保留但盘面未配置；安装 ${entry.kind} 后点「重新物化」即可配置`,
  }, h(IconEl, { h, name: 'alert', size: 11 }), '未安装');
};

// 操作回执（bind/unbind/rematerialize 共用形状 §3.2）：rematerialized/failed/
// writes + notes/skipped；bind 另带 warnings/suppressed。落盘路径逐条照实展示
// ——「写到哪里」是装备面的后果说明，一个字不减。
const Receipt = ({ h, title, receipt }) => {
  if (receipt == null) return null;
  const writes = Array.isArray(receipt.writes) ? receipt.writes : [];
  const failed = Array.isArray(receipt.failed) ? receipt.failed : [];
  const notes = [...(Array.isArray(receipt.notes) ? receipt.notes : []),
    ...(Array.isArray(receipt.warnings) ? receipt.warnings : [])];
  return h('div', { className: 'wb-result' },
    h('strong', null, title),
    receipt.removed != null
      ? h('div', { className: 'wb-kv' },
        `已移除：${receipt.removed.name ?? receipt.removed.assetId}（${MODE_LABEL[receipt.removed.mode] ?? receipt.removed.mode}）`,
        receipt.removed.exclusiveContentLost === true
          ? h('span', { className: 'wb-field-error' }, '——独立副本内容已随移除丢失') : null)
      : null,
    h('div', { className: 'wb-kv' },
      `重物化：${(Array.isArray(receipt.rematerialized) ? receipt.rematerialized : []).join('、') || '（无）'}`),
    receipt.skipped === 'not-equipped'
      ? h('div', { className: 'wb-notice' }, '当前引擎暂不支持工具物化（not-equipped）——绑定已记录，盘面未写文件。')
      : null,
    writes.length > 0
      ? h('div', null,
        h('span', { className: 'wb-hint' }, `落盘 ${writes.length} 项：`),
        h('ul', { className: 'wb-writes' },
          writes.map((w, i) => h('li', { key: i, className: 'wb-mono' }, `${w.action ?? '?'} ${w.path ?? ''}`))))
      : (failed.length === 0 && receipt.skipped == null
        ? h('div', { className: 'wb-hint' }, '本次没有写盘动作。') : null),
    failed.map((f, i) => h('div', { key: `f${i}`, className: 'wb-field-error' },
      `bot ${f.botId} 物化失败：${f.error}`)),
    notes.map((n, i) => h('div', { key: `n${i}`, className: 'wb-notice' }, n)),
    receipt.suppressedNote != null ? h('div', { className: 'wb-notice' }, receipt.suppressedNote) : null);
};

export default {
  id: 'assets',
  title: '工具库',
  icon: 'package',
  order: 3,
  component({ WAO }) {
    const { h, useState, useEffect, api, useAgents } = WAO;
    ensurePageStyle();
    const { agents } = useAgents(); // 装备警示条（assetWarnings）与同事名

    const [assets, setAssets] = useState(null);
    const [bots, setBots] = useState(null);
    const [loadError, setLoadError] = useState(null);
    const [view, setView] = useState('registry'); // 'registry' 清单 | 'equip' 装备台
    const [editor, setEditor] = useState(null); // null | {mode:'new'} | {mode:'edit', id, name}
    const [form, setForm] = useState(blankForm());
    const [formErrors, setFormErrors] = useState(null);
    const [saving, setSaving] = useState(false);
    const [deleteFor, setDeleteFor] = useState(null); // asset row
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState(null); // 下架弹层内联错误
    const [actionError, setActionError] = useState(null);
    const [toast, setToast] = useState(null);
    // 装备台
    const [botId, setBotId] = useState(null);
    const [bindAssetId, setBindAssetId] = useState('');
    const [bindMode, setBindMode] = useState('shared');
    const [unbindFor, setUnbindFor] = useState(null); // binding summary row
    const [rematOpen, setRematOpen] = useState(false);
    const [busy, setBusy] = useState(false);
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

    useEffect(() => { void reload(); }, []);

    // 深链（截图确定性，同 bots.js ?select / session.js ?view 模式）：
    // ?view=equip[&bot=<id>] 直达装备台；?new=1 / ?edit=<id> 预开清单编辑器
    // （edit 要等清单到位，走 pendingEdit）。
    const [pendingEdit, setPendingEdit] = useState(null);
    useEffect(() => {
      const q = new URLSearchParams(location.search);
      if (q.get('view') === 'equip') setView('equip');
      const b = q.get('bot');
      if (b != null && b !== '') setBotId(b);
      if (q.get('new') === '1') { setEditor({ mode: 'new' }); setForm(blankForm()); }
      const e = q.get('edit');
      if (e != null && e !== '') setPendingEdit(e);
    }, []);

    useEffect(() => {
      if (pendingEdit == null || assets == null) return;
      const a = assets.find((x) => x.id === pendingEdit);
      setPendingEdit(null);
      if (a != null) {
        setEditor({ mode: 'edit', id: a.id, name: a.name });
        setForm(formFromAsset(a));
        setFormErrors(null);
      }
    }, [pendingEdit, assets]);

    // 装备台默认选中第一位同事（选定后不随列表漂移）
    useEffect(() => {
      if (view === 'equip' && botId == null && bots != null && bots.length > 0) setBotId(bots[0].id);
    }, [view, botId, bots]);

    useEffect(() => {
      if (toast == null) return;
      const timer = setTimeout(() => setToast(null), 4200);
      return () => clearTimeout(timer);
    }, [toast]);

    if (assets == null || bots == null) {
      return h('div', { className: 'page' },
        h('h2', null, '工具库'),
        loadError != null
          ? h('div', null,
            h('div', { className: 'error' }, `读取失败：${loadError}`),
            h('div', { className: 'wb-toolbar', style: { marginTop: 12 } },
              h('button', { className: 'wb-btn wb-btn-primary', onClick: () => void reload() }, '重试')))
          : h('p', { className: 'muted' }, '读取工具清单中…'));
    }

    // —— 清单视图：登记/编辑/下架 ——————————————————————————————————————

    const openNew = () => { setEditor({ mode: 'new' }); setForm(blankForm()); setFormErrors(null); };
    const openEdit = (a) => {
      setEditor({ mode: 'edit', id: a.id, name: a.name });
      setForm(formFromAsset(a));
      setFormErrors(null);
    };

    const saveForm = async () => {
      setFormErrors(null);
      const { body, errors } = serializeForm(form);
      if (errors.length > 0) { setFormErrors(errors); return; }
      setSaving(true);
      setActionError(null);
      try {
        const resp = editor.mode === 'edit'
          ? await api(`/api/assets/${encodeURIComponent(editor.id)}`, body, { method: 'PATCH' })
          : await api('/api/assets', body);
        const name = resp?.asset?.name ?? body.name;
        const fan = Array.isArray(resp?.rematerialized) ? resp.rematerialized : [];
        const failed = Array.isArray(resp?.failed) ? resp.failed : [];
        if (failed.length > 0) {
          setActionError(`工具已保存，但 ${failed.length} 个机器人的共享副本重物化失败：${failed.map((f) => `bot ${f.botId}：${f.error}`).join('；')}——可在工具配置「重新物化」重试。`);
        } else {
          setToast(editor.mode === 'edit'
            ? `已保存「${name}」（v${resp?.asset?.version ?? '?'}）${fan.length > 0 ? `——${fan.length} 个机器人的共享副本已同步` : ''}`
            : `已添加工具「${name}」，可以到工具配置共享给机器人了`);
        }
        setEditor(null);
        await reload();
      } catch (err) {
        const lines = errorLines(err?.message);
        setFormErrors(lines.length > 0 ? lines : [String(err?.message ?? err)]);
      } finally {
        setSaving(false);
      }
    };

    const doDelete = async () => {
      if (deleteFor == null) return;
      setDeleting(true);
      setDeleteError(null);
      setActionError(null);
      try {
        const resp = await api(`/api/assets/${encodeURIComponent(deleteFor.id)}`, undefined, { method: 'DELETE' });
        const failed = Array.isArray(resp?.failed) ? resp.failed : [];
        if (failed.length > 0) {
          setActionError(`工具已删除，但 ${failed.length} 个机器人的清理重物化失败：${failed.map((f) => `bot ${f.botId}：${f.error}`).join('；')}——可在工具配置「重新物化」重试。`);
        } else {
          setToast(`已删除「${deleteFor.name}」：解绑 ${resp?.removedBindings ?? 0} 件共享绑定${(resp?.keptExclusive ?? 0) > 0 ? `，保留 ${resp.keptExclusive} 件独立快照继续生效` : ''}`);
        }
        setDeleteFor(null);
        await reload();
      } catch (err) {
        setDeleteError(String(err?.message ?? err));
      } finally {
        setDeleting(false);
      }
    };

    // 哪些同事绑着这件资产（下架确认层与绑定数 tooltip 共用）
    const holdersOf = (assetId) => bots.flatMap((b) => (Array.isArray(b.assets) ? b.assets : [])
      .filter((x) => x?.assetId === assetId)
      .map((x) => ({ bot: b, mode: x.mode })));

    const contentEditor = () => {
      const f = form;
      const set = (patch) => setForm({ ...f, ...patch });
      if (f.type === 'skill') {
        return [h('div', { className: 'wb-field', key: 'name' },
          h('label', null, '技能名', h('span', { className: 'wb-req' }, ' *'),
            h('span', { className: 'wb-hint', style: { marginLeft: 8 } }, 'content.name——落到工作目录后的技能标识，同工具名规则')),
          h('input', {
            className: 'wb-input wb-mono', value: f.skillName, spellCheck: false,
            placeholder: '如 deploy-checklist',
            onChange: (e) => set({ skillName: e.target.value }),
          })),
        h('div', { className: 'wb-field', key: 'desc' },
          h('label', null, '技能描述', h('span', { className: 'wb-hint', style: { marginLeft: 8 } }, 'content.description，≤1536 字，可空')),
          h('textarea', {
            className: 'wb-textarea', rows: 2, value: f.skillDescription,
            placeholder: '一句话说明这份技能什么时候用',
            onChange: (e) => set({ skillDescription: e.target.value }),
          })),
        h('div', { className: 'wb-field', key: 'body' },
          h('label', null, '技能正文', h('span', { className: 'wb-req' }, ' *'),
            h('span', { className: 'wb-hint', style: { marginLeft: 8 } }, 'content.body，Markdown，≤60KB')),
          h('textarea', {
            className: 'wb-textarea', rows: 10, value: f.body,
            placeholder: '# 技能标题\n\n步骤……',
            onChange: (e) => set({ body: e.target.value }),
          }))];
      }
      if (f.type === 'mcp') {
        const masked = f.servers.includes('__MASKED__');
        return [h('div', { className: 'wb-field', key: 'servers' },
          h('label', null, 'servers JSON', h('span', { className: 'wb-req' }, ' *'),
            h('span', { className: 'wb-hint', style: { marginLeft: 8 } }, '每台 server 恰一形态：stdio {command,args?,env?} 或 http {type:"http",url,headers?}')),
          h('textarea', {
            className: 'wb-textarea', rows: 10, value: f.servers, spellCheck: false,
            placeholder: '{\n  "company": { "command": "node", "args": ["server.js"], "env": { "TOKEN": "…" } },\n  "docs": { "type": "http", "url": "https://example.com/mcp", "headers": { "X-K": "…" } }\n}',
            onChange: (e) => set({ servers: e.target.value }),
          }),
          h('span', { className: 'wb-hint' }, '机密位（servers.*.env 与 servers.*.headers 的值）保存后不回显——登记新值在这里填明文，入库即受保护。'),
          masked ? h('span', { className: 'wb-notice' }, '回显为 __MASKED__ 的值：保持原样保存即不改动，填入新值才会替换（留掩码=不改）。') : null)];
      }
      if (f.type === 'prompt') {
        return [h('div', { className: 'wb-field', key: 'text' },
          h('label', null, '提示词正文', h('span', { className: 'wb-req' }, ' *'),
            h('span', { className: 'wb-hint', style: { marginLeft: 8 } }, 'content.text，≤8KB')),
          h('textarea', {
            className: 'wb-textarea', rows: 8, value: f.text,
            placeholder: '一段可复用的提示词文案……',
            onChange: (e) => set({ text: e.target.value }),
          }))];
      }
      if (f.type === 'memory') {
        return [h('div', { className: 'wb-field', key: 'notes' },
          h('label', null, '记事条目', h('span', { className: 'wb-hint', style: { marginLeft: 8 } }, 'content.notes，每行一条，≤50 条、每条 ≤2KB')),
          h('textarea', {
            className: 'wb-textarea', rows: 6, value: f.notes,
            placeholder: '周报模板：本周完成 / 下周计划 / 风险\n发版窗口：周四 14:00',
            onChange: (e) => set({ notes: e.target.value }),
          }),
          h('span', { className: 'wb-hint' }, '共享（shared）给多个机器人时大家共用同一份笔记；落盘走共享工作目录的见工具配置警示。'))];
      }
      // tool
      return [h('div', { className: 'wb-field', key: 'kind' },
        h('label', null, '工具种类', h('span', { className: 'wb-req' }, ' *')),
        h('select', {
          className: 'wb-select', value: f.kind,
          onChange: (e) => set({ kind: e.target.value }),
        },
          h('option', { value: 'rtk' }, 'rtk（token 瘦身钩子——要求机器人配了专属配置目录）'),
          h('option', { value: 'ripgrep' }, 'ripgrep（代码检索指引）')),
        f.kind === 'ripgrep'
          ? h('div', { className: 'wb-field', style: { marginTop: 10 } },
              h('label', null, '额外指引', h('span', { className: 'wb-hint', style: { marginLeft: 8 } }, 'options.extraHints，≤1KB，可空')),
              h('textarea', {
                className: 'wb-textarea', rows: 3, value: f.extraHints,
                placeholder: '追加到检索指引末尾的提示（如本仓库的目录约定）',
                onChange: (e) => set({ extraHints: e.target.value }),
              }))
          : h('span', { className: 'wb-hint' }, 'rtk v1 无可调参数（options 仅空占位）；配置态与瘦身收益见绑定回执与工具配置警示。'))];
    };

    const editorPanel = editor == null ? null : h('div', { className: 'wb-editor', style: { marginBottom: 16 } },
      h('h3', null, editor.mode === 'edit' ? `编辑工具：${editor.name}` : '添加新工具'),
      h('div', { className: 'wb-form' },
        h('div', { className: 'wb-field' },
          h('label', null, '工具类型', editor.mode === 'edit' ? h('span', { className: 'wb-hint', style: { marginLeft: 8 } }, '类型创建后不可变更') : null),
          h('select', {
            className: 'wb-select', value: form.type, disabled: editor.mode === 'edit',
            title: editor.mode === 'edit' ? 'type immutable——类型是绑定契约（引擎支持面与物化目标），改型请删除重建' : undefined,
            onChange: (e) => setForm({ ...blankForm(e.target.value), name: form.name, description: form.description }),
          }, ['skill', 'memory', 'mcp', 'prompt', 'tool'].map((t) =>
            h('option', { key: t, value: t }, `${TYPE_LABEL[t]}（${t}）`))),
          h('span', { className: 'wb-hint' }, TYPE_BLURB[form.type] ?? '')),
        h('div', { className: 'wb-field' },
          h('label', null, '工具名', h('span', { className: 'wb-req' }, ' *'),
            h('span', { className: 'wb-hint', style: { marginLeft: 8 } }, '类型内唯一；小写字母/数字/连字符，禁点号')),
          h('input', {
            className: 'wb-input wb-mono', value: form.name, spellCheck: false,
            placeholder: `如 ${form.type === 'mcp' ? 'code-gateway' : 'deploy-checklist'}`,
            onChange: (e) => setForm({ ...form, name: e.target.value }),
          })),
        h('div', { className: 'wb-field' },
          h('label', null, '备注', h('span', { className: 'wb-hint', style: { marginLeft: 8 } }, '给管理员看的一句话说明，可空')),
          h('input', {
            className: 'wb-input', value: form.description, maxLength: DESC_MAX,
            placeholder: '这个工具是干什么的',
            onChange: (e) => setForm({ ...form, description: e.target.value }),
          }),
          h('span', { className: `wb-counter${form.description.length > DESC_MAX ? ' over' : ''}` }, `${form.description.length} / ${DESC_MAX}`)),
        ...contentEditor(),
        formErrors != null && formErrors.length > 0 ? h('div', { className: 'wb-error-box' },
          h('div', null, editor.mode === 'edit' ? '保存未通过：' : '添加未通过：'),
          h('ul', null, formErrors.map((e, i) => h('li', { key: i }, e)))) : null,
        h('div', { className: 'wb-toolbar' },
          h('button', { className: 'wb-btn wb-btn-primary', disabled: saving, onClick: () => void saveForm() },
            saving ? '保存中…' : editor.mode === 'edit' ? '保存工具' : '添加工具'),
          h('button', { className: 'wb-btn', disabled: saving, onClick: () => { setEditor(null); setFormErrors(null); } }, '取消'),
          editor.mode === 'edit' && (form.servers.includes('__MASKED__'))
            ? h('span', { className: 'wb-hint' }, '机密位留掩码保存=不改动') : null)));

    const deleteModal = deleteFor == null ? null : (() => {
      const holders = holdersOf(deleteFor.id);
      const shared = holders.filter((x) => x.mode === 'shared');
      const exclusive = holders.filter((x) => x.mode === 'exclusive');
      return h('div', { className: 'wb-modal-wrap', onClick: () => { if (!deleting) setDeleteFor(null); } },
        h('div', { className: 'wb-modal', onClick: (e) => e.stopPropagation() },
          h('h3', null, `删除工具「${deleteFor.name}」？`),
          h('p', { className: 'wb-hint' },
            `${TYPE_LABEL[deleteFor.type] ?? deleteFor.type} · `, h('span', { className: 'wb-mono' }, deleteFor.id),
            ` · v${deleteFor.version ?? '?'}`),
          shared.length > 0
            ? h('div', { className: 'wb-notice' },
                `将解绑 ${shared.length} 个机器人的共享副本并清理其盘上产物：${shared.map((x) => x.bot.name ?? x.bot.id).join('、')}。`)
            : h('p', { className: 'wb-hint' }, '当前没有机器人共享（shared）这个工具。'),
          exclusive.length > 0
            ? h('div', { className: 'wb-notice' },
                `${exclusive.length} 件独立副本保留生效（${exclusive.map((x) => x.bot.name ?? x.bot.id).join('、')}）——快照存在各自机器人的记录里，源删除后不再跟版。`)
            : null,
          h('p', { className: 'wb-field-error' }, '此操作不可撤销：清单里的这条工具记录与正文将一并删除。'),
          deleteError != null ? h('div', { className: 'wb-error-box' }, `删除失败：${deleteError}`) : null,
          h('div', { className: 'wb-toolbar' },
            h('button', { className: 'wb-btn wb-btn-danger', disabled: deleting, onClick: () => void doDelete() },
              deleting ? '删除中…' : '确认删除'),
            h('button', { className: 'wb-btn', disabled: deleting, onClick: () => setDeleteFor(null) }, '再想想'))));
    })();

    const registryBody = h('div', null,
      editorPanel,
      assets.length === 0
        ? h('div', { className: 'wb-empty' },
            h('p', null, '工具库还是空的——第一个工具可以从一份技能或一句提示词开始。'),
            h('p', { className: 'wb-hint' }, '添加好之后，到工具配置把它共享给机器人。'),
            editor == null ? h('button', { className: 'wb-btn wb-btn-primary', onClick: openNew }, '＋ 添加工具') : null)
        : h('table', { className: 'wb-table' },
            h('thead', null, h('tr', null,
              h('th', null, '类型'), h('th', null, '工具'), h('th', null, '绑定'),
              h('th', null, '来源'), h('th', null, '更新时间'), h('th', null, '操作'))),
            h('tbody', null, assets.map((a) => {
              const holders = holdersOf(a.id);
              return h('tr', { key: a.id },
                h('td', null, h(TypeBadge, { h, type: a.type })),
                h('td', null,
                  h('div', { className: 'wb-mono' }, a.name),
                  a.description ? h('div', { className: 'wb-sub' }, a.description) : null,
                  h('div', { className: 'wb-sub' }, `v${a.version ?? '?'} · `, h('span', { className: 'wb-mono' }, a.id))),
                h('td', null, a.bindings > 0
                  ? h('span', {
                      title: holders.map((x) => `${x.bot.name ?? x.bot.id}（${MODE_LABEL[x.mode]}）`).join('\n') || '—',
                    }, `${a.bindings} 个机器人`)
                  : h('span', { className: 'wb-hint' }, '未共享')),
                h('td', null, h('span', {
                  title: `origin: ${a.origin}（控制台=REST 写面 / Agent 自建=MCP 写面，仅可独立）`,
                }, ORIGIN_LABEL[a.origin] ?? a.origin ?? '—')),
                h('td', null, fmtTime(a.updatedAt)),
                h('td', null, h('div', { className: 'wb-toolbar' },
                  h('button', { className: 'wb-btn', onClick: () => openEdit(a) }, '编辑'),
                  h('button', { className: 'wb-btn wb-btn-danger', onClick: () => setDeleteFor(a) }, '删除'))));
            }))));

    // —— 装备台：per-bot 绑定面 ————————————————————————————————————————

    const doBind = async () => {
      if (botId == null || bindAssetId === '') return;
      setBusy(true);
      setActionError(null);
      setReceipt(null);
      try {
        const resp = await api(`/api/bots/${encodeURIComponent(botId)}/assets`, {
          assetId: bindAssetId, mode: bindMode,
        });
        setReceipt({
          title: `已配置「${resp?.binding?.name ?? bindAssetId}」（${MODE_LABEL[resp?.binding?.mode ?? bindMode]}）给 ${bots.find((b) => b.id === botId)?.name ?? botId}`,
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
      if (unbindFor == null || botId == null) return;
      setBusy(true);
      setActionError(null);
      setReceipt(null);
      try {
        const resp = await api(`/api/bots/${encodeURIComponent(botId)}/assets/${encodeURIComponent(unbindFor.assetId)}`,
          undefined, { method: 'DELETE' });
        setReceipt({ title: `已从 ${bots.find((b) => b.id === botId)?.name ?? botId} 移除工具`, data: resp });
        setUnbindFor(null);
        await reload();
      } catch (err) {
        setActionError(String(err?.message ?? err));
      } finally {
        setBusy(false);
      }
    };

    const doRemat = async () => {
      if (botId == null) return;
      setBusy(true);
      setActionError(null);
      setReceipt(null);
      try {
        const resp = await api(`/api/bots/${encodeURIComponent(botId)}/rematerialize-assets`, {});
        setReceipt({ title: `重新物化完成：${bots.find((b) => b.id === botId)?.name ?? botId}`, data: resp });
        setRematOpen(false);
      } catch (err) {
        setActionError(String(err?.message ?? err));
        setRematOpen(false);
      } finally {
        setBusy(false);
      }
    };

    const unbindModal = unbindFor == null || botId == null ? null : h('div', { className: 'wb-modal-wrap', onClick: () => { if (!busy) setUnbindFor(null); } },
      h('div', { className: 'wb-modal', onClick: (e) => e.stopPropagation() },
        h('h3', null, `移除工具「${unbindFor.name ?? unbindFor.assetId}」？`),
        h('p', { className: 'wb-hint' },
          `${bots.find((b) => b.id === botId)?.name ?? botId} · `,
          h('span', { className: 'wb-mono' }, unbindFor.assetId),
          ` · ${MODE_LABEL[unbindFor.mode] ?? unbindFor.mode}`),
        unbindFor.mode === 'shared'
          ? h('div', { className: 'wb-notice' }, '将删除它盘上由这个工具生成的文件；工具仍在清单，随时可以重新绑定。')
          : h('div', { className: 'wb-notice' },
              '独立副本的内容随移除丢失', unbindFor.sourceDeleted === true ? '——且源工具已删除，这份快照是最后一份，移除后无法找回。' : '——源工具仍在清单，重新绑定（独立）可拿到最新版。'),
        h('div', { className: 'wb-toolbar' },
          h('button', { className: 'wb-btn wb-btn-danger', disabled: busy, onClick: () => void doUnbind() },
            busy ? '移除中…' : '确认移除'),
          h('button', { className: 'wb-btn', disabled: busy, onClick: () => setUnbindFor(null) }, '再想想'))));

    const rematModal = !rematOpen || botId == null ? null : h('div', { className: 'wb-modal-wrap', onClick: () => { if (!busy) setRematOpen(false); } },
      h('div', { className: 'wb-modal', onClick: (e) => e.stopPropagation() },
        h('h3', null, `重新物化 ${bots.find((b) => b.id === botId)?.name ?? botId} 的工具？`),
        h('div', { className: 'wb-notice' },
          '将按当前绑定重写这个机器人的全部工具产物文件——用于修复漂移或补跑失败的物化；期间它会以上一轮的好配置继续工作。'),
        h('div', { className: 'wb-toolbar' },
          h('button', { className: 'wb-btn wb-btn-danger', disabled: busy, onClick: () => void doRemat() },
            busy ? '执行中…' : '确认重物化'),
          h('button', { className: 'wb-btn', disabled: busy, onClick: () => setRematOpen(false) }, '再想想'))));

    let equipBody = null;
    if (bots.length === 0) {
      equipBody = h('div', { className: 'wb-empty' },
        h('p', null, '还没有机器人——先去机器人管理创建一个，回来给它配置工具。'));
    } else {
      const bot = bots.find((b) => b.id === botId) ?? bots[0];
      const agent = agents.find((a) => a.id === bot.id) ?? null;
      const bindings = Array.isArray(bot?.assets) ? bot.assets : [];
      const boundIds = new Set(bindings.map((x) => x?.assetId));
      const available = (assets ?? []).filter((a) => !boundIds.has(a.id));
      const warnings = Array.isArray(agent?.assetWarnings) ? agent.assetWarnings : [];
      // manifest.tools 装备态（/api/agents assetTools）：按 assetId 对到绑定行。
      const toolStateOf = (assetId) => (Array.isArray(agent?.assetTools)
        ? agent.assetTools.find((t) => t?.assetId === assetId) : undefined);
      equipBody = h('div', null,
        h('div', { className: 'wb-toolbar' },
          h('select', {
            className: 'wb-select', style: { width: 'auto' }, value: bot?.id ?? '',
            onChange: (e) => { setBotId(e.target.value); setReceipt(null); setBindAssetId(''); },
          }, bots.map((b) => h('option', { key: b.id, value: b.id }, `${b.name ?? b.id}（${b.id}）`))),
          h('button', {
            className: 'wb-btn', disabled: busy || bindings.length === 0,
            title: bindings.length === 0 ? '还没有绑定任何工具' : '按当前绑定重写这个机器人的全部工具产物文件（修复漂移/失败的安全路径）',
            onClick: () => setRematOpen(true),
          }, busy ? '执行中…' : '重新物化')),
        warnings.length > 0 ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 } },
          warnings.map((w, i) => h('div', { key: i, className: 'wb-notice', title: 'assetWarnings——工具配置面常驻警示' }, w))) : null,
        h('h3', { style: { margin: '16px 0 0', fontSize: 14 } }, `已配置 ${bindings.length} 件`),
        bindings.length === 0
          ? h('div', { className: 'wb-empty' },
              h('p', null, '这个机器人还没有配置工具——从下面挑一个给它绑上，技能和工具都会落到它的工作目录。'))
          : h('table', { className: 'wb-table' },
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
                ? '工具清单还是空的——先到「工具清单」页添加第一个工具。'
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
        receipt != null ? h(Receipt, { h, title: receipt.title, receipt: receipt.data }) : null);
    }

    // —— 页骨架 ————————————————————————————————————————————————————————

    return h('div', { className: 'page' },
      h('h2', null, '工具库'),
      h('p', { className: 'muted' }, '共享的工具库：技能、记忆、提示词、MCP 与工具——添加一次，共享给需要的机器人'),
      h('div', { className: 'wb-toolbar' },
        h('div', { className: 'wb-tabs' },
          h('button', {
            className: `wb-tab${view === 'registry' ? ' active' : ''}`,
            onClick: () => { setView('registry'); setReceipt(null); },
          }, '工具清单'),
          h('button', {
            className: `wb-tab${view === 'equip' ? ' active' : ''}`,
            onClick: () => { setView('equip'); setReceipt(null); },
          }, '工具配置')),
        view === 'registry' && assets.length > 0 && editor == null
          ? h('button', { className: 'wb-btn wb-btn-primary', onClick: openNew }, '＋ 添加工具') : null),
      actionError != null ? h('div', { className: 'error', style: { marginTop: 12 } }, actionError) : null,
      view === 'registry' ? registryBody : equipBody,
      deleteModal,
      unbindModal,
      rematModal,
      toast != null ? h('div', { className: 'wb-toast', role: 'status' }, toast) : null);
  },
};
