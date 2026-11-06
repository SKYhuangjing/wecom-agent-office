// UI page plugin template (Task 8 + M3): a page plugin whose manifest
// declares `ui: './ui'` gets that dir hosted by the kernel at
// /api/ui/template-page/ (DESIGN §9) and listed in /api/state.uiPlugins —
// the shell then dynamic-imports ui/index.js and renders its component.
// The no-build browser contract lives in ui/index.js; this file only
// registers the page on the ui port for registry visibility.
export default {
  manifest: {
    id: 'template-page',
    name: 'Template Page',
    type: 'ui',
    version: '0.1.0',
    requires: { kernel: '^1', ports: { ui: '^1' } },
    ui: './ui', // kernel hosting root for /api/ui/template-page/*
  },

  activate(ctx) {
    ctx.registerPage({
      id: 'template-page',
      title: '模板页',
      icon: '▤',
      order: 50, // nav position among pages (default 10; lower = earlier)
    });
  },
};
