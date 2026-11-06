// ui-office3d (M3 T4): the office 3D page plugin — bots as workers in an
// isometric office. The browser contract lives in ui/ (no-build ES Module,
// kernel-hosted at /api/ui/ui-office3d/): ofscene.js is the engine ported
// from the v1 office renderer, office.js is the page + redesigned visuals.
// This file only puts the page on the ui port for registry visibility,
// mirroring the ui-workbench plugin shape.
import officePage from './ui/office.js';

export default {
  manifest: {
    id: 'ui-office3d',
    name: 'UI Office 3D',
    type: 'ui',
    version: '0.1.0',
    requires: { kernel: '^1', ports: { ui: '^1' } },
    ui: './ui', // kernel hosting root for /api/ui/ui-office3d/*
  },

  activate(ctx) {
    // Port-registry visibility only — the shell renders the page from the
    // hosted ui/index.js entry, not from this registration.
    ctx.registerPage({ id: officePage.id, title: officePage.title, icon: officePage.icon, order: officePage.order });
  },
};
