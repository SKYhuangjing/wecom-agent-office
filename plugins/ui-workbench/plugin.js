// ui-workbench (M3 T2): the built-in workbench page plugin — list (bot 实况
// 卡片) + bots (CRUD with schema-driven forms). The browser contract lives in
// ui/ (no-build ES Module, kernel-hosted at /api/ui/ui-workbench/); this file
// only puts the two pages on the ui port for registry visibility, mirroring
// the _template page shape. Later tasks add pages in the same ui/ dir.
import listPage from './ui/list.js';
import botsPage from './ui/bots.js';

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
    ctx.registerPage({ id: listPage.id, title: listPage.title, icon: listPage.icon, order: listPage.order });
    ctx.registerPage({ id: botsPage.id, title: botsPage.title, icon: botsPage.icon, order: botsPage.order });
  },
};
