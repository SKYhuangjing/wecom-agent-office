// AI 操作引导共用面（v2）：overview 引导卡 / settings「AI 操作」section /
// robots 详情提示行共享的数据面与小工具。核心理念——Web 是看的，MCP/Skill
// 是操作的：控制台主动把「把你的 AI Agent 接进来」的路铺好（配置生成、
// 剪贴板、下载、连通性探测）。
//
// 数据源是 mcp-gateway 插件的 GET /api/mcp（sessions + 工具清单）与
// GET /api/mcp/skill（docs/skills/wao-company.md 全文）；插件停用时端点
// 404，useMcpStatus 以 error 形态给出「未检测到」引导文案——不猜。
//
// Node 顶层安全：无 document/location 顶层访问（plugin.js 的 manifest
// 发现会在裸 Node import 本目录）。配置文本与 README §3.2「MCP 接入」
// 同款；设置了 WAO_TOKEN（SDK 已提示输入并存下）时自动带 X-WAO-Token 头。

export const MCP_SERVER_ID = 'wao-company';

// 同源拼端点绝对地址（harness/截图也无假——origin 就是当前服务）。
export const mcpUrl = () => {
  try { return `${location.origin}/mcp`; } catch { return 'http://127.0.0.1:8792/mcp'; }
};

// SDK 的 token 存储（web/src/sdk.js 同一 key）：非空 = 服务开了鉴权，
// 三家配置都要带头（值即真实令牌，由操作者自己输入过）。
const storedWaoToken = () => {
  try { return localStorage.getItem('wao-token') ?? ''; } catch { return ''; }
};

export const mcpAuth = () => storedWaoToken() !== '';

// API 错误文案的保守本地化（走查 L12）：裸 "not found" 对非技术用户没有
// 信息量，映射成可行动的说法；其余原样保留（技术原值约定放 tooltip）。
export const apiErrText = (err) => {
  const raw = String(err ?? '未知原因');
  if (/^not found$/i.test(raw)) return 'HTTP 404（端点未注册）';
  return raw;
};

// —— 三家 CLI 配置文本（README §3.2 同款）———————————————————————————————

export const claudeMcpJson = (url) => JSON.stringify({
  mcpServers: {
    [MCP_SERVER_ID]: {
      type: 'http', url,
      ...(mcpAuth() ? { headers: { 'X-WAO-Token': storedWaoToken() } } : {}),
    },
  },
}, null, 2);

export const codexConfigToml = (url) => [
  '# ~/.codex/config.toml',
  `[mcp_servers.${MCP_SERVER_ID}]`,
  `url = "${url}"`,
  ...(mcpAuth() ? [`http_headers = { "X-WAO-Token" = "${storedWaoToken()}" }`] : []),
  '',
].join('\n');

export const zcodeConfigJson = (url) => JSON.stringify({
  mcp: {
    servers: {
      [MCP_SERVER_ID]: {
        type: 'http', url,
        ...(mcpAuth() ? { headers: { 'X-WAO-Token': storedWaoToken() } } : {}),
      },
    },
  },
}, null, 2);

// —— 剪贴板 / 下载 ——————————————————————————————————————————————————————

// clipboard API 优先；不可用或被拒（非安全上下文/无焦点）退回隐藏 textarea
// + execCommand。返回是否成功，调用方据此切换按钮文案。
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok === true;
  } catch {
    return false;
  }
}

// Blob + object URL 下载（MCP 配置 json/toml 与 skill md 共用）。
export const downloadText = (filename, text, mime = 'text/plain;charset=utf-8') => {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

// —— MCP 状态轮询（mcp-gateway 的 /api/mcp）———————————————————————————————

// useMcpStatus(WAO, pollMs): { status, error } —— status 即 /api/mcp 响应体
// （ok/endpoint/sessions/tools），插件停用/断联时 status=null 且 error 带原因。
// 页面版 hook（非 SDK 面）：overview 卡与 settings section 各自持有一份。
export const useMcpStatus = (WAO, pollMs = 5000) => {
  const { useState, useEffect, api } = WAO;
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const data = await api('/api/mcp');
        if (!alive) return;
        if (data?.ok !== true || !Array.isArray(data.tools)) throw new Error('响应形状异常');
        setStatus(data);
        setError(null);
      } catch (err) {
        if (!alive) return;
        setStatus(null);
        setError(err?.message ?? String(err));
      }
    };
    void tick();
    const timer = setInterval(tick, pollMs);
    return () => { alive = false; clearInterval(timer); };
  }, [pollMs]);
  return { status, error };
};

// —— 连通性探测 ————————————————————————————————————————————————————————

// probeMcp(api): 向 /mcp 发一个「无会话头的 tools/list」——活着的网关必答
// HTTP 200 + JSON-RPC error -32002（会话缺失是预期，证明协议面在应答），
// 刻意不 initialize，不制造悬空会话去污染「N 个 AI 会话活跃」的计数。
// 5 秒无应答判超时（SDK api 无 AbortSignal，用 race 兜底）。
export const probeMcp = async (api, timeoutMs = 5000) => {
  const call = api('/mcp', {
    jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
  });
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`超时（${Math.round(timeoutMs / 1000)} 秒无应答）`)), timeoutMs);
  });
  const body = await Promise.race([call, timeout]);
  if (body?.error != null) {
    if (body.error.code === -32002) return { ok: true, note: 'MCP 协议应答正常（JSON-RPC -32002：探测不带会话，属预期）' };
    throw new Error(`协议错误 ${body.error.code}：${body.error.message ?? ''}`);
  }
  if (body?.result != null) return { ok: true, note: 'MCP 协议应答正常' };
  throw new Error('应答形状异常（非 JSON-RPC 帧）');
};

// —— 跨页交接：跳到设置页的 AI section（沿用 robots 的 sessionStorage handoff
// 模式；settings mount 时消费一次，?section= 深链仍优先级最高——截图基线用）。

const SETTINGS_HANDOFF = 'wao-settings-handoff';

export const goSettingsAi = () => {
  try {
    sessionStorage.setItem(SETTINGS_HANDOFF, JSON.stringify({ section: 'ai' }));
  } catch { /* storage 不可用：裸导航仍落在设置页默认 section */ }
  try {
    location.hash = '#/settings';
  } catch { /* 非浏览器宿主：无操作 */ }
};

export const consumeSettingsHandoff = () => {
  try {
    const raw = sessionStorage.getItem(SETTINGS_HANDOFF);
    if (raw == null) return null;
    sessionStorage.removeItem(SETTINGS_HANDOFF);
    const v = JSON.parse(raw);
    return typeof v?.section === 'string' ? v.section : null;
  } catch {
    return null;
  }
};
