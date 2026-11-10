// 跨页导航（shell 路由是裸 '#/<pageid>'）：发起方先把 {id, tab, test} 塞进
// sessionStorage 再翻 hash；robots 页 mount 时消费一次。从 robots.js 抽出
// （2026-11-11 知识总览矩阵跳转复用；_legacy/assets.js 反向 import robots.js
// 会成环，落独立模块）。
const HANDOFF_KEY = 'wao-robots-handoff';

export const goRobots = (id, tab = null, extra = {}) => {
  try {
    sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ id, tab, ...extra }));
    location.hash = '#/robots';
  } catch { /* storage 不可用：裸导航仍生效（落在列表） */ }
};
