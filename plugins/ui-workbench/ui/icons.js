// icons.js — 单色 SVG icon 系统 (monochrome redesign)。
//
// stroke-based（Lucide/Feather 风格）24×24 线框 path：`stroke="currentColor"`
// 继承文字颜色，零独立颜色——浅/深主题与激活态全部跟着文字走。
// 与 web/src/icons.js 保持同一份 ICON_PATHS（shell 导航渲染用；改这里
// 必须同步改那份，两处文件头都标了对应关系）。
//
// 用法：页面拿 WAO.h 渲染 IconEl（描述符 → 元素）；`icon(name)` 只返回
// 描述符（{__svg, name, size, paths}），不依赖 React，可直接序列化。

export const ICON_PATHS = {
  list: ['M3 5h.01M3 12h.01M3 19h.01M8 5h13M8 12h13M8 19h13'],
  bot: ['M12 2a3 3 0 0 1 3 3v1h1a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4v-8a4 4 0 0 1 4-4h1V5a3 3 0 0 1 3-3z'],
  package: ['M16.5 9.4L7.55 4.24', 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z', 'M3.27 6.11L12 12l8.73-5.89', 'M12 22.08V12'],
  database: ['M12 8c4.97 0 9-1.34 9-3s-4.03-3-9-3-9 1.34-9 3 4.03 3 9 3z', 'M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5'],
  send: ['M22 2L11 13', 'M22 2l-7 20-4-9-9-4 20-7z'],
  plug: ['M9 7V2a1 1 0 0 1 2 0v5', 'M15 7V2a1 1 0 0 1 2 0v5', 'M12 22v-9', 'M6 22V8h12v14'],
  clock: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 6v6l4 2'],
  building: ['M3 21h18', 'M5 21V7l8-4v18', 'M13 21V11l6 3v7'],
  book: ['M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z', 'M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z'],
  zap: ['M13 2L3 14h9l-1 8 10-12h-9l1-8z'],
  settings: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z'],
  brain: ['M21 8v13H3V8', 'M1 3h22v5H1z', 'M10 12h4'], // 记忆：简化用盒（archive box）
  check: ['M20 6L9 17l-5-5'],
  x: ['M18 6L6 18', 'M6 6l12 12'],
  alert: ['M12 9v4', 'M12 17h.01', 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z'],
  pause: ['M6 4h4v16H6z', 'M14 4h4v16h-4z'],
  play: ['M5 3l14 9-14 9V3z'],
};

// 描述符（不依赖 React，可放 state/props 里）：{__svg, name, size, paths}
export function icon(name, size = 20) {
  const paths = ICON_PATHS[name];
  if (!paths) return null;
  return { __svg: true, name, size, paths };
}

// 渲染件：WAO.h（React.createElement）风格的内联 SVG 元素。currentColor
// 描边——颜色完全继承宿主文字；className 'wic' 由 style.js 对齐基线。
export const IconEl = ({ h, name, size = 16, className = '', style }) => {
  const paths = ICON_PATHS[name];
  if (!paths || typeof h !== 'function') return null;
  return h('svg', {
    className: `wic${className ? ` ${className}` : ''}`,
    width: size, height: size, viewBox: '0 0 24 24',
    fill: 'none', stroke: 'currentColor', strokeWidth: 2,
    strokeLinecap: 'round', strokeLinejoin: 'round',
    'aria-hidden': 'true', ...(style != null ? { style } : {}),
  }, paths.map((d, i) => h('path', { key: i, d })));
};

export default ICON_PATHS;
