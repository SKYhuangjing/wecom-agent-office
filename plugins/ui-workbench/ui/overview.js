// 总览 (v2 导航收敛): landing page——AI 操作引导卡（Web 是看的，MCP/Skill
// 是操作的）+ 办公室 3D 为主视觉（ui-office3d 保留为独立插件、hidden 不占
// 导航，这里通过 WAO.getPage('office3d') 内嵌渲染；未注册时兜底同源动态
// import，harness 与注册竞态都吃得下），可切到 bot 状态卡片（_legacy/
// list.js 精简版：名称/状态/进度/暂停启用/测试运行），底部是最近活动摘要
// （最近 5 条，点击跳机器人详情的日志 tab）。Node 顶层安全：无
// document/location 顶层访问（plugin.js 的 manifest 发现会在裸 Node import）。
import { ensurePageStyle } from './style.js';
import { Avatar, STATUS_LABEL, statusTitle, providerMeta } from './hr.js';
import { IconEl } from './icons.js';
import { bannerText } from './_legacy/list.js';
import { goRobots } from './robots.js';
import { KIND_LABEL, KIND_ICON, fmtClock } from './_legacy/timeline.js';
import { claudeMcpJson, copyText, goSettingsAi, mcpUrl, useMcpStatus } from './ai-access.js';

// 办公室 3D 页面模块（方案 A 内嵌）：先查注册表（shell 会 import 全部 ui 插件
// entry，office3d hidden 注册在表里），查不到再拉同源模块——import 模块缓存
// 幂等，重复触发只是多一次已解析的 promise。
const OFFICE_ENTRY = new URL('../ui-office3d/index.js', import.meta.url).href;

const OfficeEmbed = ({ WAO }) => {
  const { h, useState, useEffect } = WAO;
  const [page, setPage] = useState(() => WAO.getPage?.('office3d') ?? null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (page != null) return;
    let alive = true;
    (async () => {
      try {
        const mod = await import(OFFICE_ENTRY);
        const found = WAO.getPage?.('office3d') ?? mod?.default ?? null;
        if (!alive) return;
        if (found == null || typeof found.component !== 'function') {
          throw new Error('office3d 页面未注册或缺少 component');
        }
        setPage(found);
      } catch (err) {
        if (alive) setError(err?.message ?? String(err));
      }
    })();
    return () => { alive = false; };
  }, [page]);

  if (error != null) {
    return h('div', { className: 'wb-notice' },
      `办公室 3D 视图不可用：${error}——可在「设置 → 插件」启用 ui-office3d 后回到这里。`);
  }
  if (page == null) {
    return h('div', { className: 'wb-notice' }, '正在加载办公室 3D 视图…');
  }
  // 直接调其 component（同一份 WAO 契约），不是 portal——整棵子树共享 hooks。
  return h('div', { className: 'ov-embed' }, h(page.component, { WAO }));
};

// AI 操作引导卡：Web 是看的，MCP/Skill 是操作的——落地页主动铺路。数据来自
// mcp-gateway 的 /api/mcp（5 秒轮询）：有活跃会话报「✓ N 个 AI 会话活跃」，
// 网关在但没有连接推「把配置贴进你的 CLI」，插件停用/断联则给未检测到文案。
// 低调但可见：细条 + accent 左边框，不抢 3D 主视觉的焦点。
const AiGuideCard = ({ WAO }) => {
  const { h, useState } = WAO;
  const { status, error } = useMcpStatus(WAO);
  const [copied, setCopied] = useState(null); // 'ok' | 'fail' | null

  const onCopy = async () => {
    const ok = await copyText(claudeMcpJson(mcpUrl()));
    setCopied(ok ? 'ok' : 'fail');
    setTimeout(() => setCopied(null), 1800);
  };

  const statusLine = status != null
    ? (status.sessions > 0
      ? { cls: 'ov-ai-on', text: `✓ ${status.sessions} 个 AI 会话活跃（MCP 网关在线，共 ${status.tools.length} 个工具）` }
      : { cls: 'ov-ai-idle', text: 'MCP 网关在线，还没有 AI 连接——把配置贴进你的 CLI 即可' })
    : { cls: 'ov-ai-off', text: '状态：未检测到 AI 连接（MCP 网关未启用或不可达——接入方法见「查看完整指南」）' };

  return h('section', {
    className: 'ov-ai-card',
    'aria-label': '用 AI 操作 WAO',
  },
  h('span', { className: 'ov-ai-icon' }, h(IconEl, { h, name: 'plug', size: 16 })),
  h('div', { className: 'ov-ai-main' },
    h('span', { className: 'ov-ai-title' }, '用 AI 操作 WAO'),
    h('span', { className: 'ov-ai-copy' },
      '连接你的 Claude / Codex / ZCode 到 WAO，直接对话式管理机器人、查日志、配工具。')),
  h('div', { className: 'ov-ai-actions' },
    h('button', {
      className: 'wb-btn', title: `复制 MCP 配置 JSON（${mcpUrl()}）`,
      onClick: () => void onCopy(),
    }, copied === 'ok' ? '✓ 已复制' : copied === 'fail' ? '复制失败，请手动选择' : '复制 MCP 配置'),
    h('button', {
      className: 'wb-btn', title: '查看三家 CLI 的完整接入指南（设置 → AI 操作）',
      onClick: () => goSettingsAi(),
    }, '查看完整指南')),
  h('span', {
    className: `ov-ai-status ${statusLine.cls}`,
    title: `${mcpUrl()}${error != null ? `\n探测原因：${error}` : ''}`,
  }, statusLine.text));
};

// 状态卡片叠加视图：_legacy/list.js 的精简版——名称/状态/进度行/暂停启用开关
// + 详情/测试运行两个快捷按钮；标题点击进机器人详情。
const BotCards = ({ WAO, agents, busyId, onToggle, actionError }) => {
  const { h } = WAO;
  if (agents.length === 0) {
    return h('div', { className: 'wb-empty' },
      h('p', null, '还没有机器人在线。'),
      h('p', { className: 'wb-hint' }, '去「机器人」创建一个，五步就好：基本信息、引擎、工具、工作目录、连接配置。'),
      h('button', { className: 'wb-btn wb-btn-primary', onClick: () => goRobots('new') }, '去创建机器人'));
  }
  return h('div', { className: 'wb-grid' },
    actionError != null ? h('div', { className: 'error', style: { gridColumn: '1 / -1' } }, actionError) : null,
    agents.map((a) => {
      const status = a.status ?? 'offline';
      const meta = providerMeta(a.provider);
      const working = status === 'working';
      const off = status === 'offline' || a.enabled === false;
      return h('div', { key: a.id, className: 'wb-card' },
        h('div', { className: 'wb-card-head' },
          h(Avatar, {
            WAO, seed: a.id, size: 42, ring: meta.color, mood: off ? 'sleep' : 'neutral',
            title: `机器人 ID ${a.id}\n${meta.tech}`,
          }),
          h('div', { style: { flex: '1', minWidth: '0' } },
            h('button', {
              className: 'wb-name wb-name-btn', title: '进入机器人详情（会话/日志/工具/设置）',
              onClick: () => goRobots(a.id, 'session'),
            }, a.name ?? a.id),
            h('div', { className: 'wb-sub', title: `${meta.label}（provider ${a.provider ?? '?'}）· 渠道 ${a.channel ?? '?'} · 机器人 ID ${a.id}` },
              `${meta.label} · ${a.id}`)),
          h('span', { className: `badge badge-${status}`, title: statusTitle(a) },
            STATUS_LABEL[status] ?? status),
          a.providerMissing === true ? h('span', {
            className: 'wb-dot-warn', title: '它的引擎插件已不存在（设置 → 插件里对应插件被停用）',
          }) : null,
          h('label', {
            className: 'wb-switch',
            title: a.enabled === false
              ? '已暂停——点击启用（启用后立即连接企微开始工作）'
              : '在线——点击暂停（在跑的活会收完尾再断开，配置保留）',
          },
            h('input', {
              type: 'checkbox', checked: a.enabled !== false, disabled: busyId === a.id,
              onChange: () => onToggle(a),
            }),
            h('span', { className: 'wb-track' }))),
        working || a.progress?.line ? h('div', { className: 'wb-progress', title: '运行进度（实时进度行）' },
          a.progress?.line ?? '运行中…') : null,
        status === 'offline' && a.reason ? h('div', { className: 'wb-reason', title: '离线原因（技术原值见 tooltip）' }, `离线原因：${a.reason}`) : null,
        h('div', { className: 'wb-actions' },
          h('button', { className: 'wb-btn', onClick: () => goRobots(a.id, 'settings') }, '机器人配置'),
          h('button', {
            className: 'wb-btn', title: '测试运行：直接跑它的引擎配置，不进引擎链',
            onClick: () => goRobots(a.id, 'settings', { test: true }),
          }, '测试运行')));
    }));
};

// 最近活动摘要：最近 5 条（15 分钟窗），点击行跳机器人详情的日志 tab。
const ActivityStrip = ({ WAO, agents }) => {
  const { h, useTimeline } = WAO;
  const { rows, error } = useTimeline(null, 15);
  const newest = [...rows].reverse().slice(0, 5);
  return h('section', { className: 'ov-act' },
    h('div', { className: 'ov-act-head' },
      h('h3', null, '最近活动'),
      h('span', { className: 'wb-hint' }, '最近 15 分钟 · 每 5 秒刷新 · 点击查看该机器人的日志')),
    error != null ? h('div', { className: 'error' }, bannerText('加载活动失败：', error)) : null,
    newest.length === 0 && error == null
      ? h('p', { className: 'wb-hint' }, '这个时间窗里没有活动——机器人可能在待命，或者新的记录已滑出窗口。')
      : h('ul', { className: 'ov-act-list' }, newest.map((r, i) => {
        const a = agents.find((x) => x.id === r.botId);
        const meta = providerMeta(a?.provider ?? r.botId);
        const head = a != null
          ? h(Avatar, { WAO, seed: r.botId, size: 20, ring: meta.color, title: `${a.name ?? r.botId} · ${meta.label}` })
          : h('span', { className: 'wb-mono', style: { fontSize: 10, flex: 'none' } }, (r.botId ?? '?').slice(0, 6));
        return h('li', {
          key: `${r.at}-${i}`,
          className: 'ov-act-row',
          title: `${r.botId ?? ''}\n${r.chatKey ?? ''}\n${r.text ?? ''}\n点击进入日志 tab`,
          onClick: () => goRobots(r.botId, 'logs'),
        },
        head,
        h('span', { className: 'wb-tl-time' }, fmtClock(r.at)),
        h('span', { className: `wb-tl-kind wb-tl-kind-${r.kind}`, title: `kind：${r.kind}` },
          KIND_ICON[r.kind] ? h(IconEl, { h, name: KIND_ICON[r.kind], size: 11 }) : null,
          KIND_LABEL[r.kind] ?? r.kind),
        r.chatKey ? h('span', { className: 'wb-tl-chat', title: '会话对象（群聊/单聊 chatKey）' }, r.chatKey) : null,
        h('span', { className: 'wb-tl-text' }, r.text || '（无文本）'));
      })));
};

export default {
  id: 'overview',
  title: '总览',
  icon: 'building',
  order: 1,
  component({ WAO }) {
    const { h, useState, useEffect, api, useAgents } = WAO;
    ensurePageStyle();
    const { agents, error } = useAgents();
    // ?view=cards 深链（截图基线用）：默认 3D 主视觉
    const [view, setView] = useState(() => {
      try {
        return new URLSearchParams(location.search).get('view') === 'cards' ? 'cards' : 'office';
      } catch { return 'office'; }
    });
    const [busyId, setBusyId] = useState(null);
    const [actionError, setActionError] = useState(null);

    const toggle = async (agent) => {
      setBusyId(agent.id);
      setActionError(null);
      try {
        await api(`/api/bots/${encodeURIComponent(agent.id)}/toggle`, {});
      } catch (err) {
        setActionError(`暂停/启用「${agent.name ?? agent.id}」失败：${err?.message ?? err}`);
      } finally {
        setBusyId(null);
      }
    };

    const onDuty = agents.filter((a) => a.enabled !== false && (a.status === 'working' || a.status === 'idle'));
    return h('div', { className: 'page' },
      h('h2', null, '总览'),
      h('p', { className: 'muted' }, `${onDuty.length} 个机器人在线——办公室实时实景，谁在忙什么一眼可见`),
      h('div', { className: 'wb-toolbar' },
        h('div', { className: 'wb-tabs' },
          h('button', {
            className: `wb-tab${view === 'office' ? ' active' : ''}`,
            title: '办公室 3D 实景（Magpie 引擎）',
            onClick: () => setView('office'),
          }, '办公室 3D'),
          h('button', {
            className: `wb-tab${view === 'cards' ? ' active' : ''}`,
            title: '切换到机器人状态卡片列表',
            onClick: () => setView('cards'),
          }, '状态卡片')),
        view === 'cards' ? h('button', {
          className: 'wb-btn wb-btn-primary', onClick: () => goRobots('new'),
        }, '＋ 创建机器人') : null),
      error != null ? h('div', { className: 'error', style: { marginTop: 12 } },
        bannerText('加载机器人列表失败：', error)) : null,
      h(AiGuideCard, { WAO }),
      view === 'office' && error == null ? h(OfficeEmbed, { WAO }) : null,
      view === 'office' && error == null ? null : h('div', { style: { marginTop: 14 } },
        h(BotCards, { WAO, agents, busyId, onToggle: toggle, actionError })),
      h(ActivityStrip, { WAO, agents }));
  },
};
