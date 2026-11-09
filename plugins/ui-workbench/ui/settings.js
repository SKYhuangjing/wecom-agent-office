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
  const port = status?.port ?? (typeof location !== 'undefined' ? location.port || '8792' : '8792');
  const lanIps = Array.isArray(status?.lanIps) ? status.lanIps : [];
  const hostname = status?.hostname ?? '';
  const lanMode = status?.lanMode === true;
  const [hostChoice, setHostChoice] = useState('origin');
  const [customHost, setCustomHost] = useState('');

  let effectiveOrigin = '';
  if (hostChoice === 'origin') {
    effectiveOrigin = typeof location !== 'undefined' ? location.origin : `http://127.0.0.1:${port}`;
  } else if (hostChoice === 'custom') {
    effectiveOrigin = customHost.trim() || `http://127.0.0.1:${port}`;
  } else if (hostChoice === 'hostname' && hostname) {
    effectiveOrigin = `http://${hostname}:${port}`;
  } else {
    effectiveOrigin = `http://${hostChoice}:${port}`;
  }
  const url = mcpUrl(effectiveOrigin);
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

    h('div', { className: 'wb-card', style: { padding: '12px 16px', margin: '0 0 16px' } },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 } },
        h('span', { style: { fontSize: 13, fontWeight: 600 } }, '接入端点网络地址'),
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
          h('button', {
            className: `wb-btn ${hostChoice === 'origin' ? 'wb-btn-primary' : ''}`,
            style: { padding: '3px 10px', fontSize: 12 },
            onClick: () => setHostChoice('origin'),
          }, `当前访问 (${typeof location !== 'undefined' ? (location.hostname || '127.0.0.1') : '127.0.0.1'})`),
          lanIps.map((ip) => h('button', {
            key: ip,
            className: `wb-btn ${hostChoice === ip ? 'wb-btn-primary' : ''}`,
            style: { padding: '3px 10px', fontSize: 12 },
            title: '从局域网其他机器配置 AI Agent 时点此切换',
            onClick: () => setHostChoice(ip),
          }, `局域网 IP (${ip})`)),
          hostname && hostname !== 'localhost' ? h('button', {
            className: `wb-btn ${hostChoice === 'hostname' ? 'wb-btn-primary' : ''}`,
            style: { padding: '3px 10px', fontSize: 12 },
            onClick: () => setHostChoice('hostname'),
          }, `主机名 (${hostname})`) : null,
          h('button', {
            className: `wb-btn ${hostChoice === 'custom' ? 'wb-btn-primary' : ''}`,
            style: { padding: '3px 10px', fontSize: 12 },
            onClick: () => setHostChoice('custom'),
          }, '自定义…'),
        )),
      hostChoice === 'custom' ? h('div', { style: { marginTop: 8 } },
        h('input', {
          className: 'wb-input',
          style: { width: '100%', maxWidth: 360, fontSize: 12 },
          placeholder: `例如 10.10.127.243:${port} 或 my-domain.com:${port}`,
          value: customHost,
          onChange: (e) => setCustomHost(e.target.value),
        })) : null,
      !lanMode && typeof location !== 'undefined' && (location.hostname === '127.0.0.1' || location.hostname === 'localhost')
        ? h('p', { className: 'wb-hint', style: { margin: '8px 0 0' } },
            '💡 跨电脑使用 AI 操作此服务？当前服务仅监听在 127.0.0.1。请在启动时加 --lan（或环境变量 WAO_LAN=1）以开放局域网连接。')
        : lanMode
          ? h('p', { className: 'wb-hint', style: { margin: '8px 0 0', color: 'var(--ok, #16a34a)' } },
              '✓ 局域网模式已开启（允许私网 IP 与主机名访问），从外部机器连接请选择上方的「局域网 IP」。')
          : null),

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
          : '放到 ~/.zcode/skills/wao-company/SKILL.md（ZCode）或对应 Agent 的技能目录，即可用「看看机器人状态」「帮我暂停 main」这类快捷词操作。')),

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
  // 开机自启动（/api/service/autostart）：读系统真实配置，永不预选
  const [autostart, setAutostart] = useState(null);
  const [asBusy, setAsBusy] = useState(false);
  // 在线检查更新与平滑升级（/api/service/update）
  const [updateInfo, setUpdateInfo] = useState(null);
  const [checkBusy, setCheckBusy] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateMsg, setUpdateMsg] = useState(null);
  // 工具装备（/api/service/tools，P1-A）：rtk/rg/git-bash 装备态 + 一键安装
  const [tools, setTools] = useState(null);
  const [toolsBusy, setToolsBusy] = useState(null); // id of the installing tool
  const [toolsMsg, setToolsMsg] = useState(null);
  const [restarting, setRestarting] = useState(false);

  const checkUpdate = async () => {
    if (checkBusy) return;
    setCheckBusy(true);
    setUpdateMsg(null);
    try {
      const info = await api('/api/service/update');
      setUpdateInfo(info);
    } catch (err) {
      setUpdateInfo({ error: err?.message ?? String(err) });
    } finally {
      setCheckBusy(false);
    }
  };

  const triggerUpdate = async () => {
    if (updating) return;
    const target = updateInfo?.remoteCommit || '最新版本';
    if (!window.confirm(`确认立即将 WAO 平滑升级至 ${target}？\n\n所有机器人凭证、对话台账及资产文件将完整保留；更新完成后服务将自动重启。`)) {
      return;
    }
    setUpdating(true);
    setUpdateMsg('正在启动下载并移交独立更新器，请稍候…');
    try {
      const res = await api('/api/service/update', {});
      setUpdateMsg(res?.message || '更新已触发，服务正在平滑重启，页面将在服务就绪后自动刷新…');
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        try {
          const hz = await fetch('/healthz', { cache: 'no-store' });
          if (hz.ok) {
            clearInterval(poll);
            setUpdateMsg('✓ 升级成功，服务已恢复！正在刷新控制台…');
            setTimeout(() => { window.location.reload(); }, 1200);
            return;
          }
        } catch { /* waiting for reboot */ }
        if (attempts > 30) {
          clearInterval(poll);
          setUpdateMsg('等待服务重启超时，请确认服务已启动后手动刷新页面。');
          setUpdating(false);
        }
      }, 1500);
    } catch (err) {
      setUpdateMsg(`触发升级失败：${err?.message ?? String(err)}`);
      setUpdating(false);
    }
  };

  useEffect(() => {
    let alive = true;
    api('/api/service/autostart')
      .then((d) => { if (alive) setAutostart(d); })
      .catch((err) => { if (alive) setAutostart({ error: err?.message ?? String(err) }); });
    return () => { alive = false; };
  }, []);
  const toggleAutostart = async (next) => {
    if (asBusy) return;
    setAsBusy(true);
    try {
      setAutostart(await api('/api/service/autostart', { enabled: next }));
    } catch (err) {
      setAutostart({ ...(autostart ?? {}), error: err?.message ?? String(err) });
    } finally {
      setAsBusy(false);
    }
  };

  const installTool = async (id) => {
    if (toolsBusy != null) return;
    setToolsBusy(id);
    setToolsMsg(null);
    try {
      const res = await api('/api/service/tools', { id });
      setToolsMsg(res?.message || `${id} 安装中…`);
      // 后台安装：轮询装备态直到 installing 消失（最多 15 分钟）
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        try {
          const t = await api('/api/service/tools');
          setTools(t);
          const row = (t?.tools ?? []).find((x) => x.id === id);
          if (row?.install?.state === 'installed' || row?.install?.state === 'failed') {
            clearInterval(poll);
            setToolsBusy(null);
            if (row.install.state === 'failed') setToolsMsg(`安装失败：${row.install.error ?? '详见服务日志'}`);
          }
        } catch { /* transient */ }
        if (attempts > 300) { clearInterval(poll); setToolsBusy(null); setToolsMsg('安装仍在后台进行，稍后刷新查看。'); }
      }, 3000);
    } catch (err) {
      setToolsMsg(`触发安装失败：${err?.message ?? String(err)}`);
      setToolsBusy(null);
    }
  };

  const restartService = async () => {
    if (restarting) return;
    if (!window.confirm('确认重启 WAO 服务？\n\n所有机器人将短暂离线十几秒，页面就绪后自动刷新（用于安装工具后刷新 PATH 等场景）。')) return;
    setRestarting(true);
    setToolsMsg('服务重启中…页面将在就绪后自动刷新。');
    try {
      await api('/api/service/restart', {});
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        try {
          const hz = await fetch('/healthz', { cache: 'no-store' });
          if (hz.ok) {
            clearInterval(poll);
            setToolsMsg('✓ 服务已恢复，正在刷新控制台…');
            setTimeout(() => { window.location.reload(); }, 1200);
            return;
          }
        } catch { /* rebooting */ }
        if (attempts > 40) {
          clearInterval(poll);
          setToolsMsg('等待服务重启超时，请确认服务已启动后手动刷新页面。');
          setRestarting(false);
        }
      }, 1500);
    } catch (err) {
      setToolsMsg(`触发重启失败：${err?.message ?? String(err)}`);
      setRestarting(false);
    }
  };

  const refreshTools = async () => {
    try { setTools(await api('/api/service/tools')); } catch { setTools({ error: '工具装备态不可用' }); }
  };
  useEffect(() => { void refreshTools(); }, []);

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
        row('版本',
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
              h('span', { className: 'wb-mono', style: { fontWeight: 600 } },
                `${health?.version ? `wao v${health.version}` : 'wao'}${updateInfo?.currentCommit ? ` (${updateInfo.currentCommit})` : ''}`),
              h('button', {
                className: 'wb-btn wb-btn-sm',
                disabled: checkBusy || updating,
                onClick: () => void checkUpdate(),
              }, checkBusy ? '正在检查…' : '检查更新'),
              updateInfo?.hasUpdate === false && !updateInfo.error
                ? h('span', { className: 'wb-hint', style: { color: 'var(--ok, #16a34a)' } }, '✓ 已是最新版本') : null,
              updateInfo?.error
                ? h('span', { className: 'wb-hint', style: { color: 'var(--warn, #eab308)' } }, `检查提示：${updateInfo.error}`) : null,
            ),
            updateInfo?.hasUpdate ? h('div', {
              className: 'wb-card',
              style: {
                padding: '8px 12px', background: 'color-mix(in srgb, var(--accent) 6%, transparent)',
                border: '1px solid color-mix(in srgb, var(--accent) 25%, transparent)',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
              },
            },
              h('div', { style: { fontSize: 13 } },
                h('div', { style: { fontWeight: 600, color: 'var(--ink)' } }, `发现新版本：commit ${updateInfo.remoteCommit}`),
                updateInfo.commitMessage ? h('div', { className: 'muted', style: { fontSize: 12, marginTop: 2 } }, updateInfo.commitMessage) : null,
              ),
              h('button', {
                className: 'wb-btn wb-btn-primary wb-btn-sm',
                disabled: updating,
                onClick: () => void triggerUpdate(),
              }, updating ? '升级中…' : '一键升级'),
            ) : null,
            updateMsg ? h('div', {
              className: updating ? 'wb-notice' : 'wb-hint',
              style: { marginTop: 4, padding: '6px 10px', fontSize: 12 },
            }, updateMsg) : null),
          '/healthz & GitHub main'),
        row('工具装备',
          tools == null ? h('span', { className: 'wb-hint' }, '读取中…')
          : tools.error != null ? h('span', { className: 'wb-hint' }, tools.error)
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            ...(tools.tools ?? []).map((t) => h('div', {
              key: t.id, style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
            },
              h('span', { className: 'wb-mono', style: { fontWeight: 600, minWidth: 64 } }, t.label),
              t.state === 'available'
                ? h('span', { className: 'wb-hint', style: { color: 'var(--ok, #16a34a)' } },
                    `✓ 已装备${t.detectedVersion ? `（${t.detectedVersion}）` : ''}`)
                : t.state === 'installing'
                  ? h('span', { className: 'wb-hint', style: { color: 'var(--warn, #eab308)' } }, '⏳ 后台安装中…')
                  : h('span', { className: 'wb-hint', style: { color: 'var(--warn, #eab308)' } },
                      `✗ 未安装${t.install?.state === 'failed' ? `（上次失败：${(t.install.error ?? '').slice(0, 60)}）` : ''}`),
              t.state === 'available' ? null : h('button', {
                className: 'wb-btn wb-btn-sm',
                disabled: toolsBusy != null || t.state === 'installing',
                onClick: () => void installTool(t.id),
                title: '下载→SHA256 校验→解压→用户 PATH（后台进行，慢网络可能需要数分钟）',
              }, toolsBusy === t.id ? '安装中…' : '一键安装'),
              h('span', { className: 'wb-hint', style: { fontSize: 12 } }, t.description),
            )),
            // 任一工具经安装器装上后，当前进程的 PATH 不含新目录——重启服务才生效
            (tools.tools ?? []).some((t) => t.install?.state === 'installed') ? h('button', {
              className: 'wb-btn wb-btn-primary wb-btn-sm',
              disabled: restarting,
              onClick: () => void restartService(),
            }, restarting ? '重启中…' : '重启服务使装备生效') : null,
            toolsMsg ? h('div', { className: 'wb-hint', style: { fontSize: 12, padding: '4px 0' } }, toolsMsg) : null),
          'rtk/ripgrep/git-bash——省 token 与检索的装备前提；win 的 claude hook 依赖 bash'),
        row('运行时间', h('span', { className: 'wb-mono' }, uptime), '自服务启动起（实时走秒）'),
        row('进程', state?.pid != null ? h('span', { className: 'wb-mono' }, `pid ${state.pid}`) : '—'),
        row('数据目录', state?.dataDir != null
          ? h('span', { className: 'wb-mono', title: '机器人配置、台账与插件启停表都落在这里' }, state.dataDir)
          : h('span', { className: 'wb-hint' }, '（当前服务版本未通过 API 暴露——升级服务后可见）'), '/api/state'),
        row('插件', `${counts.active ?? 0} 运行中 · ${counts.disabled ?? 0} 已停用 · ${counts.failed ?? 0} 加载失败（共 ${plugins.length}）`, '启停去「插件」标签页'),
        row('开机自启动',
          autostart == null ? h('span', { className: 'wb-hint' }, '读取中…')
          : autostart.error != null ? h('span', { className: 'wb-field-error' }, `读取失败：${autostart.error}`)
          : !autostart.supported || (!autostart.installed && autostart.mechanism !== 'registry Run (user)')
            ? h('span', { className: 'wb-hint' }, autostart.detail)
            : h('label', {
                className: 'wb-switch',
                title: autostart.enabled
                  ? '已开启：系统启动（用户登录）时自动运行 WAO——点击关闭。不影响当前运行，崩溃自愈不受此控'
                  : '已关闭：系统启动时不会自动运行——点击开启（当前运行不受影响）',
              },
              h('input', {
                type: 'checkbox', checked: autostart.enabled === true, disabled: asBusy,
                onChange: (e) => void toggleAutostart(e.target.checked),
              }),
              h('span', { className: 'wb-track' })),
          autostart?.mechanism ?? undefined),
        row('页面插件', uiPlugins.length > 0
          ? uiPlugins.map((p) => p?.id).filter(Boolean).join('、')
          : '（无）', '本控制台的页面来源，内核托管于 /api/ui/<id>/')))) : null,
    h('p', { className: 'wb-hint', style: { marginTop: 8 } },
      '开机自启动只控制系统启动（用户登录）时是否自动运行 WAO——不影响当前运行，崩溃自动拉活（KeepAlive）也不受此开关控制；状态以系统里的真实配置为准，不做默认选择。'));
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
