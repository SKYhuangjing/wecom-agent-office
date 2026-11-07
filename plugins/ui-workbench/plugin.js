// ui-workbench (M3 T2/T3, W3 T4): the built-in workbench page plugin — list (bot
// 实况卡片), bots (CRUD with schema-driven forms), assets (资产科：资产清单 +
// per-bot 装备台), session (台账/原生会话钻取), push (服务端主动推送),
// plugins (运行时插件管理), timeline (事件流). The browser contract lives in
// ui/ (no-build ES Module, kernel-hosted at /api/ui/ui-workbench/); this file
// only puts the pages on the ui port for registry visibility, mirroring the
// _template page shape.
import listPage from './ui/list.js';
import botsPage from './ui/bots.js';
import assetsPage from './ui/assets.js';
import sessionPage from './ui/session.js';
import pushPage from './ui/push.js';
import pluginsPage from './ui/plugins.js';
import timelinePage from './ui/timeline.js';

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
    for (const page of [listPage, botsPage, assetsPage, sessionPage, pushPage, pluginsPage, timelinePage]) {
      ctx.registerPage({ id: page.id, title: page.title, icon: page.icon, order: page.order });
    }
  },
};
