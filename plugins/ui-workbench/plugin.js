// ui-workbench (v2 导航收敛): the built-in workbench page plugin — three
// pages: overview (落地页：办公室 3D 内嵌 + bot 状态卡片 + 最近活动), robots
// (列表 + 详情 tabs：会话/日志/工具/设置 + 推送 dialog), settings (工具库 +
// 插件 + 系统信息). 旧七页（list/bots/assets/session/push/plugins/timeline）
// 移入 ui/_legacy/ 作组件库复用，不再独立注册。The browser contract lives in
// ui/ (no-build ES Module, kernel-hosted at /api/ui/ui-workbench/); this file
// only puts the pages on the ui port for registry visibility, mirroring the
// _template page shape.
import overviewPage from './ui/overview.js';
import robotsPage from './ui/robots.js';
import settingsPage from './ui/settings.js';

export default {
  manifest: {
    id: 'ui-workbench',
    name: 'UI Workbench',
    type: 'ui',
    version: '0.1.0',
    requires: { kernel: '^1', ports: { ui: '^1' } },
    ui: './ui', // kernel hosting root for /api/ui/ui-workbench/*
  },

  activate(ctx) {
    // Port-registry visibility only — the shell renders these pages from the
    // hosted ui/index.js aggregation, not from this registration.
    for (const page of [overviewPage, robotsPage, settingsPage]) {
      ctx.registerPage({ id: page.id, title: page.title, icon: page.icon, order: page.order });
    }
  },
};
