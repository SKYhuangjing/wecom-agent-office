// 设置 (v2 导航收敛): 低频操作聚合页，四个 section——AI 操作（MCP/Skill
// 接入引导：端点/三家 CLI 配置/工具清单/skill 文件/连通性测试，v2 新增）
// / 工具库（_legacy/assets.js 整页内嵌：完整 CRUD + 绑定管理，深链
// ?view=equip&bot= 仍有效）/ 插件（_legacy/plugins.js 整页内嵌：启用/禁用/
// 重载）/ 系统信息（/healthz 版本 + /api/state 运行时间/PID/数据目录/插件
// 与页面清单）。?section= 深链供截图；overview 引导卡的「查看完整指南」经
// sessionStorage handoff（wao-settings-handoff，ai-access.js）跳进 AI
// section。
import { ensurePageStyle } from './style.js';
import assetsPage from './_legacy/assets.js';
import pluginsPage from './_legacy/plugins.js';
import {
  apiErrText, claudeMcpJson, codexConfigToml, consumeSettingsHandoff, copyText,
  downloadText, mcpAuth, mcpUrl, probeMcp, useMcpStatus, zcodeConfigJson,
} from './ai-access.js';

const SECTION_IDS = ['ai', 'assets', 'plugins', 'system'];
const SECTION_LABEL = { ai: 'AI 操作', assets: '工具库', plugins: '插件', system: '系统信息' };

const fmtUptime = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400);
  const hh = String(Math.floor((s % 86400) / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return d > 0 ? `${d} 天 ${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`;
};

// 复制按钮：成功/失败就地变文案 1.8 秒（每块各持一份 copied，互不牵连）。
// getText 可为同步字符串或异步（如 skill 文件按需拉取）。
const CopyBtn = ({ WAO, getText, label = '复制', title = '' }) => {
  const { h, useState } = WAO;
  const [copied, setCopied] = useState(null); // 'ok' | 'fail' | null
  const [busy, setBusy] = useState(false);
  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    let ok = false;
    try {
      ok = await copyText(await getText());
    } catch {
      ok = false;
    } finally {
      setBusy(false);
    }
    setCopied(ok ? 'ok' : 'fail');
    setTimeout(() => setCopied(null), 1800);
  };
  return h('button', {
    className: 'wb-btn wb-btn-sm', title,
    onClick: () => void onClick(),
  }, copied === 'ok' ? '✓ 已复制' : copied === 'fail' ? '复制失败' : busy ? '获取中…' : label);
};

// 配置块：标题（+按钮排：复制/下载）+ 等宽代码体（+可选 hint）。
const ConfigBox = ({ WAO, title, hint, code, extraButtons = [] }) => {
  const { h } = WAO;
  return h('div', { className: 'ai-box' },
    h('div', { className: 'ai-box-head' },
      h('span', { className: 'ai-box-title' }, title),
      h('span', { className: 'ai-box-actions' },
        h(CopyBtn, { WAO, getText: () => code, title: `复制${title}文本` }),
        extraButtons.map((b) => h('button', {
          key: b.label, className: 'wb-btn wb-btn-sm', title: b.title ?? '', onClick: b.onClick,
        }, b.label)))),
    hint != null ? h('div', { className: 'wb-hint', style: { margin: '6px 0 0' } }, hint) : null,
    h('pre', { className: 'ai-code' }, code));
};

// AI 操作 section：Web UI 适合浏览状态；日常操作推荐通过 AI 完成。数据面
// 是 mcp-gateway 的 /api/mcp（工具清单）与 /api/mcp/skill（Agent 技能文件，
// 点按需拉取）——插件停用时各块给出诚实的不可用说明，不装作有数据。
const AiSection = ({ WAO }) => {
  const { h, useState, api } = WAO;
  const { status, error } = useMcpStatus(WAO);
  const [toolsOpen, setToolsOpen] = useState(() => {
    try { return new URLSearchParams(location.search).get('ai-tools') === '1'; } catch { return false; }
  });
  const [skill, setSkill] = useState(null); // { content, filename } | { error }
  const [skillBusy, setSkillBusy] = useState(false);
  const [probe, setProbe] = useState(null); // { ok, note } | { ok: false, error }
  const [probeBusy, setProbeBusy] = useState(false);
  const url = mcpUrl();
  const tokened = mcpAuth();

  // skill 拉取（点按需、不轮询）：失败就地显示原因，不装作有数据。
  const peekSkill = async () => {
    try {
      const data = await api('/api/mcp/skill');
      return data?.ok === true && typeof data.content === 'string' ? data : null;
    } catch { return null; }
  };

  const runProbe = async () => {
    setProbeBusy(true);
    setProbe(null);
    try {
      const r = await probeMcp(api);
      setProbe(r);
    } catch (err) {
      setProbe({ ok: false, error: err?.message ?? String(err) });
    } finally {
      setProbeBusy(false);
    }
  };

  const tools = status?.tools ?? null;

  return h('div', { className: 'ai-section' },
    h('p', { className: 'muted', style: { margin: '0 0 4px' } },
      'Web 控制台适合浏览状态；日常操作推荐通过 AI 完成——连接你的 Claude / Codex / ZCode，直接对话式管理机器人、查日志、配工具。'),
    tokened ? h('p', { className: 'wb-hint', style: { margin: '0 0 12px' } },
      '检测到本控制台已存有访问令牌：下方三家配置已自动附上 X-WAO-Token 头。')
      : h('p', { className: 'wb-hint', style: { margin: '0 0 12px' } },
        '服务设置了 WAO_TOKEN 时，配置会自动附上访问头（令牌以你在控制台输入过的为准）。'),

    h(ConfigBox, {
      WAO, title: 'MCP 端点', code: url,
      hint: '所有 AI Agent 接入的唯一入口（POST /mcp，JSON-RPC 2.0 over HTTP）',
    }),
    h(ConfigBox, {
      WAO, title: 'Claude 配置', code: claudeMcpJson(url),
      hint: '存成 wao.mcp.json 后：claude --mcp-config wao.mcp.json "列出所有机器人"',
      extraButtons: [{
        label: '下载 .json', title: '下载 wao.mcp.json',
        onClick: () => downloadText('wao.mcp.json', claudeMcpJson(url), 'application/json'),
      }],
    }),
    h(ConfigBox, {
      WAO, title: 'Codex 配置', code: codexConfigToml(url),
      hint: '追加到 ~/.codex/config.toml（或：codex mcp add wao-company --url …）',
      extraButtons: [{
        label: '下载 .toml', title: '下载 config.toml 片段',
        onClick: () => downloadText('config.toml', codexConfigToml(url), 'text/plain;charset=utf-8'),
      }],
    }),
    h(ConfigBox, {
      WAO, title: 'ZCode / 其他', code: zcodeConfigJson(url),
      hint: '工作区级 <repo>/.zcode/config.json（用户级 ~/.zcode/cli/config.json 同形）；其他支持 streamable HTTP 的 Agent 直接用上方端点',
      extraButtons: [{
        label: '下载 .json', title: '下载 config.json',
        onClick: () => downloadText('config.json', zcodeConfigJson(url), 'application/json'),
      }],
    }),

    h('div', { className: 'ai-tools' },
      h('div', { className: 'ai-tools-head' },
        h('span', null,
          '可用工具: ',
          tools != null
            ? h('b', null, `${tools.length} 个`)
            : h('span', { className: 'wb-hint' }, '清单不可用'),
          h('span', { className: 'wb-hint' }, '（查看机器人/创建/删除/推送/暂停启用/工具管理/插件/日志）')),
        h('button', {
          className: 'wb-btn wb-btn-sm',
          onClick: () => setToolsOpen((v) => !v),
        }, toolsOpen ? '收起工具列表 ▴' : '查看完整工具列表 ▾')),
      toolsOpen ? (tools != null
        ? h('ul', { className: 'ai-tool-list' }, tools.map((t) => h('li', { key: t.name },
          h('code', { className: 'wb-mono' }, t.name),
          t.dangerous ? h('span', { className: 'ai-tool-danger', title: '危险工具：调用前 Agent 会复述后果并确认' }, '高危') : null,
          h('span', { className: 'ai-tool-desc' }, t.description ?? ''))))
        : h('p', { className: 'wb-hint', style: { margin: '8px 0 0' } },
          `工具清单来自 /api/mcp（mcp-gateway）——启用 mcp-gateway 插件后可见${error != null ? `（原因：${apiErrText(error)}）` : ''}`))
        : null,
      tools != null && tools.some((t) => t.dangerous) && toolsOpen
        ? h('p', { className: 'wb-hint', style: { margin: '8px 0 0' } },
          '标「高危」的工具（删除/推送/插件启停/工具变更）的执行后果会由 Agent 复述确认；管理员可在 mcp-gateway 插件选项（dangerousTools=false）一键禁用。')
        : null),

    h('div', { className: 'ai-skill' },
      h('div', { className: 'ai-tools-head' },
        h('span', null, 'Skill 文件',
          h('span', { className: 'wb-hint' }, '——快捷词触发词 + 意图→工具配方，放进 Agent 技能目录即用')),
        h('span', { className: 'ai-box-actions' },
          h(CopyBtn, {
            WAO, label: '复制内容', title: '复制 wao-company.md 全文',
            getText: async () => {
              const d = await peekSkill();
              if (d == null) throw new Error('skill 文件不可用');
              return d.content;
            },
          }),
          h('button', {
            className: 'wb-btn wb-btn-sm', title: '下载 wao-company.md',
            onClick: () => {
              void (async () => {
                setSkillBusy(true);
                const d = await peekSkill();
                setSkillBusy(false);
                if (d == null) { setSkill({ error: 'skill 文件不可用（/api/mcp/skill 无应答）' }); return; }
                setSkill({ content: d.content, filename: d.filename });
                downloadText(d.filename ?? 'wao-company.md', d.content, 'text/markdown;charset=utf-8');
              })();
            },
          }, skillBusy ? '获取中…' : skill?.content != null ? '再次下载' : '下载 wao-company.md'))),
      h('p', { className: 'wb-hint', style: { margin: '6px 0 0' } },
        skill?.error != null ? `读取失败：${skill.error}`
          : '放到 ~/.zcode/skills/wao-company/SKILL.md（ZCode）或对应 Agent 的技能目录，即可用「看看机器人在岗情况」「帮我暂停 main」这类快捷词操作。')),

    h('div', { className: 'ai-probe' },
      h('button', {
        className: 'wb-btn', disabled: probeBusy, onClick: () => void runProbe(),
        title: '向 /mcp 发一个不带会话的 tools/list——应答 -32002 即协议面活着（不制造会话）',
      }, probeBusy ? '探测中…' : '测试 MCP 连通性'),
      probe == null ? h('span', { className: 'wb-hint' }, '探测不占用会话名额') : null,
      probe?.ok === true ? h('span', { className: 'ai-probe-ok' }, `✓ 可达——${probe.note}`) : null,
      probe?.ok === false ? h('span', { className: 'ai-probe-bad' }, `✗ 不可达：${probe.error}`) : null),

    status == null ? h('p', { className: 'wb-hint', style: { marginTop: 12 } },
      `MCP 网关控制台端点不可用（${apiErrText(error)}）——请到「插件」标签页确认 mcp-gateway 已启用；若它已在运行，重启 wao 服务后即可恢复。`) : null);
};

const SystemInfo = ({ WAO }) => {
  const { h, useState, useEffect, api } = WAO;
  const [health, setHealth] = useState(null);
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [loadedAt, setLoadedAt] = useState(null); // uptimeSec 快照时刻 → 活表走秒
  const [, setTick] = useState(0); // 每秒强制重渲染，驱动运行时间活表

  const refresh = async () => {
    setError(null);
    try {
      const [hz, st] = await Promise.all([
        api('/healthz').catch((err) => { throw err; }),
        api('/api/state'),
      ]);
      setHealth(hz);
      setState(st);
      setLoadedAt(Date.now());
    } catch (err) {
      setError(err?.message ?? String(err));
    }
  };
  useEffect(() => { void refresh(); }, []);

  // 运行时间活表：快照 uptimeSec + 本地流逝秒，每秒一跳（服务端值随下次刷新对齐）
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const row = (label, valueNode, hint) => h('tr', null,
    h('th', { scope: 'row' }, label, hint ? h('span', { className: 'wb-hint', style: { marginLeft: 8 } }, hint) : null),
    h('td', null, valueNode));

  const plugins = Array.isArray(state?.plugins) ? state.plugins : [];
  const counts = plugins.reduce((acc, p) => {
    acc[p.status] = (acc[p.status] ?? 0) + 1;
    return acc;
  }, {});
  const uiPlugins = Array.isArray(state?.uiPlugins) ? state.uiPlugins : [];
  const uptime = state?.uptimeSec != null && loadedAt != null
    ? fmtUptime(state.uptimeSec + (Date.now() - loadedAt) / 1000)
    : '—';

  return h('div', null,
    h('div', { className: 'wb-toolbar' },
      h('button', { className: 'wb-btn', onClick: () => void refresh() }, '刷新'),
      h('span', { className: 'wb-hint' }, '数据来自 /healthz 与 /api/state（只读）')),
    error != null ? h('div', { className: 'error', style: { marginTop: 12 } }, `读取系统信息失败：${error}`) : null,
    state == null && error == null ? h('p', { className: 'muted' }, '读取系统信息…') : null,
    state != null ? h('div', { className: 'wb-table-scroll' }, h('table', { className: 'wb-table' },
      h('tbody', null,
        row('版本', health?.version != null ? `wao v${health.version}` : '—', '/healthz'),
        row('运行时间', h('span', { className: 'wb-mono' }, uptime), '自服务启动起（实时走秒）'),
        row('进程', state?.pid != null ? h('span', { className: 'wb-mono' }, `pid ${state.pid}`) : '—'),
        row('数据目录', state?.dataDir != null
          ? h('span', { className: 'wb-mono', title: '机器人配置、台账与插件启停表都落在这里' }, state.dataDir)
          : h('span', { className: 'wb-hint' }, '（当前服务版本未通过 API 暴露——升级服务后可见）'), '/api/state'),
        row('插件', `${counts.active ?? 0} 运行中 · ${counts.disabled ?? 0} 已停用 · ${counts.failed ?? 0} 加载失败（共 ${plugins.length}）`, '启停去「插件」标签页'),
        row('页面插件', uiPlugins.length > 0
          ? uiPlugins.map((p) => p?.id).filter(Boolean).join('、')
          : '（无）', '本控制台的页面来源，内核托管于 /api/ui/<id>/')))) : null);
};

export default {
  id: 'settings',
  title: '设置',
  icon: 'settings',
  order: 3,
  component({ WAO }) {
    const { h, useState, useEffect } = WAO;
    ensurePageStyle();
    const [section, setSection] = useState('assets'); // 'ai' | 'assets' | 'plugins' | 'system'

    // ?section= 深链（截图基线用）优先；否则消费 overview 引导卡的
    // sessionStorage handoff（「查看完整指南」→ AI section）。
    useEffect(() => {
      let wanted = null;
      try {
        const s = new URLSearchParams(location.search).get('section');
        if (SECTION_IDS.includes(s)) wanted = s;
      } catch { /* 非浏览器宿主：无深链 */ }
      if (wanted == null) wanted = consumeSettingsHandoff();
      if (wanted != null && SECTION_IDS.includes(wanted)) setSection(wanted);
    }, []);

    return h('div', { className: 'page' },
      h('h2', null, '设置'),
      h('p', { className: 'muted' }, '低频操作：AI 接入引导、工具库管理、插件启停与系统信息'),
      h('div', { className: 'wb-toolbar' },
        h('div', { className: 'wb-tabs' },
          SECTION_IDS.map((s) => h('button', {
            key: s,
            className: `wb-tab${section === s ? ' active' : ''}`,
            onClick: () => setSection(s),
          }, SECTION_LABEL[s]))),
        section === 'assets' ? h('span', { className: 'wb-hint' }, '清单增删改 + 按机器人配置（装备台）') : null),
      h('div', { key: section, style: { marginTop: 14 } },
        section === 'ai' ? h(AiSection, { WAO })
        : section === 'assets' ? h(assetsPage.component, { WAO })
        : section === 'plugins' ? h(pluginsPage.component, { WAO })
        : h(SystemInfo, { WAO })));
  },
};
