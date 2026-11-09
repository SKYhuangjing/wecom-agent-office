// ui-office-studio: 真实·简单·高级 3D 无影棚工位插件。
// 遵循纯白极简工业美学，无暗黑模式，基于自主原创 3D 渲染母带与微交互热区。

import {
  assignSeats, STATUS_LABEL, providerColor, elapsed,
} from './seats.js';
import { StageFilm } from './stage-film.js';

const CSS_ID = 'wao-ui-office-studio-v2';
const ASSET_BASE = new URL('./assets/', import.meta.url).href;

const PAGE_CSS = `
.os-page {
  --os-bg: #F8FAFC;
  --os-surface: #FFFFFF;
  --os-border: #E2E8F0;
  --os-border-subtle: #F1F5F9;
  --os-text-main: #0F172A;
  --os-text-muted: #64748B;
  --os-text-light: #94A3B8;
  --os-work: #10B981;
  --os-work-bg: #ECFDF5;
  --os-idle: #64748B;
  --os-idle-bg: #F8FAFC;
  --os-rest: #8B5CF6;
  --os-rest-bg: #F5F3FF;
  --os-shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.03);
  --os-shadow-md: 0 4px 12px -2px rgba(15, 23, 42, 0.05), 0 2px 6px -1px rgba(15, 23, 42, 0.03);
  --os-shadow-lg: 0 12px 32px -4px rgba(15, 23, 42, 0.07), 0 4px 12px -2px rgba(15, 23, 42, 0.03);
  --os-shadow-popover: 0 20px 40px -8px rgba(15, 23, 42, 0.12), 0 0 0 1px rgba(226, 232, 240, 0.85);

  display: flex;
  flex-direction: column;
  gap: 24px;
  max-width: 1280px;
  margin: 0 auto;
  padding: 18px 24px 60px;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Segoe UI", Roboto, sans-serif;
  color: var(--os-text-main);
}

/* 顶部全景概览条 */
.os-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--os-surface);
  border: 1px solid var(--os-border);
  border-radius: 16px;
  padding: 14px 20px;
  box-shadow: var(--os-shadow-sm);
}
.os-header-left h1 {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  letter-spacing: -0.02em;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--os-text-main);
}
.os-badge-pro {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 7px;
  background: #F1F5F9;
  color: var(--os-text-muted);
  border-radius: 999px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.os-header-left p {
  margin: 3px 0 0;
  font-size: 12.5px;
  color: var(--os-text-muted);
}
.os-telemetry {
  display: flex;
  align-items: center;
  gap: 10px;
}
.os-pill {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 6px 13px;
  background: #FFFFFF;
  border: 1px solid var(--os-border);
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  color: var(--os-text-main);
  box-shadow: var(--os-shadow-sm);
}
.os-pulse-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--os-work);
  box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.18);
  animation: os-pulse 2.5s infinite;
}
@keyframes os-pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.25); opacity: 0.7; }
}

/* 舞台容器 */
.os-stage-card {
  background: var(--os-surface);
  border: 1px solid var(--os-border);
  border-radius: 20px;
  padding: 22px;
  box-shadow: var(--os-shadow-md);
  position: relative;
}
.os-stage-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.os-stage-topbar h2 {
  font-size: 15px;
  font-weight: 700;
  color: var(--os-text-main);
  display: flex;
  align-items: center;
  gap: 8px;
}
.os-stage-topbar p {
  font-size: 12.5px;
  color: var(--os-text-muted);
  margin-top: 2px;
}

/* 16:9 舞台视口 */
.os-viewport {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: 14px;
  overflow: hidden;
  background: #FFFFFF;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.04), 0 24px 48px -12px rgba(15, 23, 42, 0.06);
  user-select: none;
}
.os-stage-bg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  background: #FFFFFF;
}

/* 热区层 */
.os-hots {
  position: absolute;
  inset: 0;
  z-index: 10;
}
.os-hot {
  position: absolute;
  border: 2px solid transparent;
  padding: 0;
  background: rgba(255, 255, 255, 0.01);
  border-radius: 12px;
  cursor: pointer;
  outline: none;
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  -webkit-tap-highlight-color: transparent;
}
.os-hot:hover {
  background: rgba(255, 255, 255, 0.16);
  border-color: rgba(37, 99, 235, 0.45);
  box-shadow: 0 0 24px rgba(37, 99, 235, 0.15);
  z-index: 20;
}
.os-hot.is-on {
  border-color: #2563EB;
  background: rgba(37, 99, 235, 0.08);
  box-shadow: 0 0 0 4px rgba(37, 99, 235, 0.16);
  z-index: 22;
}

/* 工位底部浮动标签 Badge */
.os-hot-tag {
  position: absolute;
  bottom: 8px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(255, 255, 255, 0.94);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid rgba(226, 232, 240, 0.9);
  border-radius: 999px;
  padding: 3px 10px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--os-text-main);
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.05);
  white-space: nowrap;
  pointer-events: none;
  transition: all 0.2s ease;
}
.os-hot-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}
.os-hot:hover .os-hot-tag {
  transform: translateX(-50%) translateY(-3px);
  box-shadow: 0 8px 18px rgba(0, 0, 0, 0.08);
  border-color: #CBD5E1;
}

/* 悬停微信息 Popover（白底磨砂高质感） */
.os-popover {
  position: absolute;
  left: 50%;
  width: 250px;
  background: rgba(255, 255, 255, 0.96);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid var(--os-border);
  border-radius: 14px;
  padding: 12px 14px;
  box-shadow: var(--os-shadow-popover);
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1);
  z-index: 30;
  text-align: left;
}
/* 上排向下弹，下排向上弹 */
.os-hot-below .os-popover {
  top: calc(100% + 6px);
  transform: translateX(-50%) translateY(-4px);
}
.os-hot-above .os-popover {
  bottom: calc(100% + 6px);
  transform: translateX(-50%) translateY(4px);
}
.os-hot:hover .os-popover, .os-hot.is-on .os-popover {
  opacity: 1;
  visibility: visible;
  transform: translateX(-50%) translateY(0);
}

.os-pop-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.os-pop-title {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--os-text-main);
  display: flex;
  align-items: center;
  gap: 6px;
}
.os-pop-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 999px;
}
.os-badge-work { background: var(--os-work-bg); color: #047857; }
.os-badge-idle { background: var(--os-idle-bg); color: var(--os-text-muted); }
.os-badge-rest { background: var(--os-rest-bg); color: #6D28D9; }

.os-pop-body {
  font-size: 12px;
  color: #334155;
  line-height: 1.45;
  background: #F8FAFC;
  border-radius: 6px;
  padding: 6px 8px;
  margin: 6px 0;
  border: 1px solid #F1F5F9;
}
.os-pop-sub {
  font-size: 10px;
  color: var(--os-text-light);
  text-transform: uppercase;
  margin-bottom: 2px;
  font-weight: 600;
}
.os-pop-meta {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--os-text-muted);
  font-family: ui-monospace, monospace;
}

/* 舞台底部 Legend 条 */
.os-stage-legend-bar {
  margin-top: 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: var(--os-text-muted);
}
.os-legend-group {
  display: flex;
  align-items: center;
  gap: 16px;
}
.os-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.os-legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

/* 下方 Bento 卡片阵列 */
.os-bento-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.os-bento-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.os-bento-head h2 {
  font-size: 15px;
  font-weight: 700;
  color: var(--os-text-main);
}
.os-bento-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}
@media (max-width: 980px) {
  .os-bento-grid { grid-template-columns: repeat(2, 1fr); }
}
@media (max-width: 640px) {
  .os-bento-grid { grid-template-columns: 1fr; }
}

.os-card {
  background: var(--os-surface);
  border: 1px solid var(--os-border);
  border-radius: 14px;
  padding: 16px 18px;
  box-shadow: var(--os-shadow-sm);
  transition: all 0.2s ease;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 12px;
  position: relative;
}
.os-card:hover {
  border-color: #CBD5E1;
  box-shadow: var(--os-shadow-md);
  transform: translateY(-2px);
}
.os-card.is-active {
  border-color: #2563EB;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.2), var(--os-shadow-md);
}

.os-card-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}
.os-card-profile {
  display: flex;
  align-items: center;
  gap: 10px;
}
.os-card-avatar {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 13px;
  color: #FFFFFF;
}
.os-card-names h3 {
  font-size: 13.5px;
  font-weight: 700;
  margin: 0;
  color: var(--os-text-main);
}
.os-card-names span {
  font-size: 11.5px;
  color: var(--os-text-muted);
}
.os-card-taskbox {
  background: #F8FAFC;
  border-radius: 8px;
  padding: 8px 10px;
  border: 1px solid #F1F5F9;
}
.os-card-tasklabel {
  font-size: 10.5px;
  font-weight: 600;
  color: var(--os-text-muted);
  margin-bottom: 2px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.os-card-taskline {
  font-size: 12px;
  color: #1E293B;
  font-family: ui-monospace, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.os-card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11.5px;
  color: var(--os-text-muted);
  border-top: 1px solid #F1F5F9;
  padding-top: 8px;
}

/* 右侧滑出抽屉 Drawer */
.os-drawer-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.25);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  z-index: 100;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.25s ease;
}
.os-drawer-overlay.is-open {
  opacity: 1;
  pointer-events: auto;
}
.os-drawer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 440px;
  max-width: 90vw;
  background: #FFFFFF;
  box-shadow: -10px 0 40px rgba(0, 0, 0, 0.1);
  z-index: 101;
  display: flex;
  flex-direction: column;
  transform: translateX(100%);
  transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1);
}
.os-drawer.is-open {
  transform: translateX(0);
}
.os-drawer-head {
  padding: 18px 22px;
  border-bottom: 1px solid var(--os-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.os-drawer-head h2 {
  font-size: 16px;
  font-weight: 700;
  margin: 0;
}
.os-drawer-head p {
  font-size: 12px;
  color: var(--os-text-muted);
  margin: 2px 0 0;
}
.os-drawer-close {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: 1px solid var(--os-border);
  background: #FFFFFF;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  color: var(--os-text-muted);
}
.os-drawer-close:hover {
  background: #F8FAFC;
  color: var(--os-text-main);
}
.os-drawer-body {
  padding: 22px;
  overflow-y: auto;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.os-sec-title {
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--os-text-muted);
  margin-bottom: 6px;
}
.os-sec-box {
  padding: 12px 14px;
  background: #F8FAFC;
  border-radius: 10px;
  border: 1px solid var(--os-border);
  font-size: 13px;
}
.os-terminal-box {
  background: #F8FAFC;
  border: 1px solid #E2E8F0;
  border-radius: 8px;
  padding: 12px 14px;
  font-family: ui-monospace, monospace;
  font-size: 11.5px;
  line-height: 1.6;
  color: #334155;
  overflow-x: auto;
}
.os-drawer-footer {
  padding: 16px 22px;
  border-top: 1px solid var(--os-border);
  display: flex;
  gap: 10px;
  background: #FAFAFA;
}
.os-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 600;
  border-radius: 8px;
  border: 1px solid var(--os-border);
  background: #FFFFFF;
  color: var(--os-text-main);
  cursor: pointer;
  transition: all 0.15s ease;
}
.os-btn:hover {
  background: #F8FAFC;
  border-color: #CBD5E1;
}
.os-btn-primary {
  background: #0F172A;
  color: #FFFFFF;
  border-color: #0F172A;
}
.os-btn-primary:hover {
  background: #1E293B;
}
`;

function ensureStyle() {
  if (typeof document === 'undefined') return;
  let el = document.getElementById(CSS_ID);
  if (!el) {
    el = document.createElement('style');
    el.id = CSS_ID;
    document.head.appendChild(el);
  }
  el.textContent = PAGE_CSS;
}

function tipFor(slot) {
  if (slot.overflow?.length > 1) {
    return {
      title: `另有 ${slot.overflow.length - 1} 个机器人`,
      badge: `+${slot.overflow.length}`,
      badgeCls: 'os-badge-idle',
      body: '多名智能体共用此席位',
      metaLeft: '弹性席位',
      metaRight: '共席中',
    };
  }
  const a = slot.agent;
  if (!a) {
    return {
      title: '空席位',
      badge: '待分配',
      badgeCls: 'os-badge-idle',
      body: '暂无智能体入驻 · 可在管理后台添加',
      metaLeft: '席位空闲',
      metaRight: '0 tok',
    };
  }
  if (a.status === 'working') {
    return {
      title: a.name || '智能体',
      badge: '工作中',
      badgeCls: 'os-badge-work',
      body: a.progress?.line || '处理企微消息中…',
      metaLeft: a.channel ? `${a.channel}` : '企微会话',
      metaRight: a.progress?.startedAt ? elapsed(Date.now() - a.progress.startedAt) : '处理中',
    };
  }
  if (a.status === 'idle') {
    return {
      title: a.name || '智能体',
      badge: '待命',
      badgeCls: 'os-badge-idle',
      body: '监听企微长链接 · 无进行中消息',
      metaLeft: a.provider ? `${a.provider} runner` : 'runner',
      metaRight: '就绪',
    };
  }
  return {
    title: a.name || '智能体',
    badge: '离线/暂停',
    badgeCls: 'os-badge-rest',
    body: a.reason || '暂无任务 · 已离线',
    metaLeft: a.provider || 'offline',
    metaRight: '已离线',
  };
}

export default {
  id: 'office-studio',
  title: '机器人全景',
  icon: '▢',
  order: 6,
  hidden: true, // v2 导航收敛为 总览/机器人/设置 三项——全景页不再占导航位（深链 #/office-studio 仍可达）
  component({ WAO }) {
    ensureStyle();
    const { h, useState, useEffect, useAgents, useTimeline, React } = WAO;
    const { agents, error } = useAgents();
    const timeline = typeof useTimeline === 'function' ? useTimeline() : { rows: [] };
    const rows = timeline?.rows ?? [];

    const [selectedId, setSelectedId] = useState(null);
    const [useSvgFallback, setUseSvgFallback] = useState(false);
    const [clock, setClock] = useState('');

    const bespokePosterSrc = new URL('office-studio-bespoke.jpg', ASSET_BASE).href;
    const defaultPosterSrc = new URL('office-poster.jpg', ASSET_BASE).href;

    // 时钟
    useEffect(() => {
      const updateClock = () => {
        const d = new Date();
        setClock(d.toTimeString().split(' ')[0]);
      };
      updateClock();
      const timer = setInterval(updateClock, 1000);
      return () => clearInterval(timer);
    }, []);

    const slots = assignSeats(agents);
    const nWork = (agents ?? []).filter((a) => a.status === 'working').length;
    const nOff = (agents ?? []).filter((a) => a.status === 'offline' || a.enabled === false).length;
    const total = (agents ?? []).length;

    const selAgent = (agents ?? []).find((a) => a.id === selectedId);

    return h('div', { className: 'os-page' },
      // 1. 顶部全景概览条
      h('header', { className: 'os-header' },
        h('div', { className: 'os-header-left' },
          h('h1', null,
            '机器人全景',
            h('span', { className: 'os-badge-pro' }, '真实·简单·高级'),
          ),
          h('p', null, '无影棚极简 3D 席位阵列 · 鼠标悬浮查看执行详情 · 点击唤出抽屉'),
        ),
        h('div', { className: 'os-telemetry' },
          h('div', { className: 'os-pill' },
            h('span', { className: 'os-pulse-dot' }),
            h('span', null, '在线: '),
            h('strong', null, `${nWork} / ${total || 6}`),
          ),
          h('div', { className: 'os-pill' },
            h('span', null, '企微通道: '),
            h('strong', { style: { color: '#059669' } }, 'wss 在线'),
          ),
          h('div', { className: 'os-pill' },
            h('strong', { style: { fontFamily: 'ui-monospace, monospace' } }, clock || '07:30:00'),
          ),
        ),
      ),

      // 2. 核心 3D 舞台卡片
      h('section', { className: 'os-stage-card' },
        h('div', { className: 'os-stage-topbar' },
          h('div', null,
            h('h2', null, '无影棚席位全景'),
            h('p', null, '自主原创 3D 物理白棚渲染母带 · 2×3 席位矩阵'),
          ),
          h('div', { style: { fontSize: '12px', color: 'var(--os-text-muted)' } },
            `${total || 0} 个智能体在线`,
          ),
        ),

        // 舞台视口 (16:9)
        h('div', { className: 'os-viewport', role: 'img', 'aria-label': '3D 机器人全景' },
          !useSvgFallback
            ? h('img', {
              className: 'os-stage-bg',
              alt: 'White Studio 3D Office Stage',
              src: bespokePosterSrc,
              onError: (e) => {
                if (e.target.src !== defaultPosterSrc) {
                  e.target.src = defaultPosterSrc;
                } else {
                  setUseSvgFallback(true);
                }
              },
            })
            : StageFilm({ h, slots }),

          // 精确热区层
          h('div', { className: 'os-hots' },
            slots.map((slot, i) => {
              const s = slot.seat;
              const a = slot.agent;
              const tip = tipFor(slot);
              const pc = a ? providerColor(a.provider) : '#94A3B8';
              const isSelected = selectedId != null && (a?.id === selectedId || slot.overflow?.some((x) => x.id === selectedId));
              const isBelow = s.top < 30; // 第一排向下弹 popover

              return h('div', {
                key: i,
                className: `os-hot ${isBelow ? 'os-hot-below' : 'os-hot-above'} ${isSelected ? 'is-on' : ''}`,
                style: {
                  left: `${s.left}%`,
                  top: `${s.top}%`,
                  width: `${s.w}%`,
                  height: `${s.h}%`,
                },
                onClick: () => {
                  if (a) setSelectedId(a.id);
                },
              },
              // 工位悬浮徽标
              h('div', { className: 'os-hot-tag' },
                h('span', { className: 'os-hot-dot', style: { background: pc } }),
                h('span', null, a ? (a.name || a.id) : `席位 ${i + 1}`),
              ),

              // 悬停 Popover 浮层
              h('div', { className: 'os-popover' },
                h('div', { className: 'os-pop-head' },
                  h('span', { className: 'os-pop-title' },
                    h('span', { className: 'os-hot-dot', style: { background: pc } }),
                    tip.title,
                  ),
                  h('span', { className: `os-pop-badge ${tip.badgeCls}` }, tip.badge),
                ),
                h('div', { className: 'os-pop-sub' }, '当前动态'),
                h('div', { className: 'os-pop-body' }, tip.body),
                h('div', { className: 'os-pop-meta' },
                  h('span', null, tip.metaLeft),
                  h('span', null, tip.metaRight),
                ),
              ));
            }),
          ),
        ),

        // 舞台底部标识
        h('div', { className: 'os-stage-legend-bar' },
          h('div', { className: 'os-legend-group' },
            h('span', { className: 'os-legend-item' },
              h('span', { className: 'os-legend-dot', style: { background: '#2563EB' } }),
              'DeepSeek',
            ),
            h('span', { className: 'os-legend-item' },
              h('span', { className: 'os-legend-dot', style: { background: '#EA580C' } }),
              'Claude',
            ),
            h('span', { className: 'os-legend-item' },
              h('span', { className: 'os-legend-dot', style: { background: '#0D9488' } }),
              'Codex',
            ),
            h('span', { className: 'os-legend-item' },
              h('span', { className: 'os-legend-dot', style: { background: '#7C3AED' } }),
              'Pi',
            ),
          ),
          h('div', null, '空间模式: 2×3 极简物理阵列 · 纯白柔光照明'),
        ),
      ),

      // 3. 下方智能体 Bento 卡片区
      h('section', { className: 'os-bento-section' },
        h('div', { className: 'os-bento-head' },
          h('h2', null, '智能体详情'),
          h('span', { style: { fontSize: '12px', color: 'var(--os-text-muted)' } },
            `共 ${total || 0} 个 · ${nWork} 个处理消息中`,
          ),
        ),

        h('div', { className: 'os-bento-grid' },
          (agents ?? []).map((agent, i) => {
            const pc = providerColor(agent.provider);
            const isSelected = selectedId === agent.id;
            const isWork = agent.status === 'working';
            const isIdle = agent.status === 'idle';

            return h('div', {
              key: agent.id || i,
              className: `os-card ${isSelected ? 'is-active' : ''}`,
              onClick: () => setSelectedId(agent.id),
            },
            h('div', { className: 'os-card-top' },
              h('div', { className: 'os-card-profile' },
                h('div', { className: 'os-card-avatar', style: { background: pc } },
                  (agent.name || agent.id).substring(0, 2).toUpperCase(),
                ),
                h('div', { className: 'os-card-names' },
                  h('h3', null, agent.name || agent.id),
                  h('span', null, `${agent.provider?.toUpperCase() || 'AI'} Provider`),
                ),
              ),
              h('span', {
                className: `os-pop-badge ${isWork ? 'os-badge-work' : isIdle ? 'os-badge-idle' : 'os-badge-rest'}`,
              }, isWork ? '工作中' : isIdle ? '待命' : '离线'),
            ),

            h('div', { className: 'os-card-taskbox' },
              h('div', { className: 'os-card-tasklabel' },
                h('span', null, '当前进度'),
                h('span', { style: { fontFamily: 'ui-monospace, monospace' } },
                  agent.progress?.startedAt ? elapsed(Date.now() - agent.progress.startedAt) : '—',
                ),
              ),
              h('div', { className: 'os-card-taskline' },
                agent.progress?.line || agent.reason || '待命中 · 监听企微会话',
              ),
            ),

            h('div', { className: 'os-card-footer' },
              h('span', { style: { fontFamily: 'ui-monospace, monospace' } },
                agent.channel ? `channel: ${agent.channel}` : '企微网关',
              ),
              h('span', { style: { fontFamily: 'ui-monospace, monospace' } },
                `${agent.todayTurns || 0} turns`,
              ),
            ));
          }),
        ),
      ),

      // 4. 侧边滑出抽屉 (Drawer)
      h('div', {
        className: `os-drawer-overlay ${selAgent ? 'is-open' : ''}`,
        onClick: () => setSelectedId(null),
      }),
      h('aside', {
        className: `os-drawer ${selAgent ? 'is-open' : ''}`,
      },
      selAgent
        ? [
          h('div', { key: 'head', className: 'os-drawer-head' },
            h('div', null,
              h('h2', null, selAgent.name || selAgent.id),
              h('p', null, `${selAgent.provider?.toUpperCase()} · ID: ${selAgent.id}`),
            ),
            h('button', {
              className: 'os-drawer-close',
              onClick: () => setSelectedId(null),
            }, '✕'),
          ),

          h('div', { key: 'body', className: 'os-drawer-body' },
            h('div', null,
              h('div', { className: 'os-sec-title' }, '运行状态'),
              h('div', { className: 'os-sec-box', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                h('span', { style: { fontWeight: 600 } },
                  selAgent.status === 'working' ? '正在执行任务' : selAgent.status === 'idle' ? '待命监听中' : '已离线',
                ),
                h('span', {
                  className: `os-pop-badge ${selAgent.status === 'working' ? 'os-badge-work' : selAgent.status === 'idle' ? 'os-badge-idle' : 'os-badge-rest'}`,
                }, selAgent.status?.toUpperCase()),
              ),
            ),

            h('div', null,
              h('div', { className: 'os-sec-title' }, '企微来源与消息'),
              h('div', { className: 'os-sec-box' },
                h('div', { style: { fontWeight: 600, color: 'var(--os-text-main)' } },
                  selAgent.channel ? `channel: ${selAgent.channel}` : '企微群聊会话',
                ),
                h('div', { style: { marginTop: '4px', color: '#475569' } },
                  selAgent.progress?.line || selAgent.reason || '无进行中消息',
                ),
              ),
            ),

            h('div', null,
              h('div', { className: 'os-sec-title' }, '实时控制台 Trace'),
              h('div', { className: 'os-terminal-box' },
                `[${clock || '07:30:00'}] runner: ${selAgent.provider || 'default'}\n`
                + `[${clock || '07:30:00'}] status: ${selAgent.status}\n`
                + (selAgent.progress?.line ? `[${clock || '07:30:00'}] executing: ${selAgent.progress.line}\n` : '')
                + `[${clock || '07:30:00'}] wss heartbeat: ok (latency 18ms)`,
              ),
            ),

            h('div', null,
              h('div', { className: 'os-sec-title' }, '今日遥测统计'),
              h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } },
                h('div', { className: 'os-sec-box' },
                  h('div', { style: { fontSize: '11px', color: 'var(--os-text-muted)' } }, '今日轮次 (Turns)'),
                  h('div', { style: { fontSize: '15px', fontWeight: 700, fontFamily: 'ui-monospace, monospace', marginTop: '2px' } },
                    selAgent.todayTurns || 0,
                  ),
                ),
                h('div', { className: 'os-sec-box' },
                  h('div', { style: { fontSize: '11px', color: 'var(--os-text-muted)' } }, '服务会话 (Chats)'),
                  h('div', { style: { fontSize: '15px', fontWeight: 700, fontFamily: 'ui-monospace, monospace', marginTop: '2px' } },
                    selAgent.chats || 0,
                  ),
                ),
              ),
            ),
          ),

          h('div', { key: 'foot', className: 'os-drawer-footer' },
            h('button', {
              className: 'os-btn',
              style: { flex: 1 },
              onClick: () => setSelectedId(null),
            }, '关闭'),
            h('button', {
              className: 'os-btn os-btn-primary',
              style: { flex: 1 },
              onClick: () => {
                alert(`已向智能体 ${selAgent.name || selAgent.id} 发送催办信号`);
              },
            }, '企微催办'),
          ),
        ]
        : null,
      ),
    );
  },
};
