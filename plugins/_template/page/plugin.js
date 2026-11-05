// UI page plugin template (Task 8): registers a demo page on the ui port.
// Page SERVING lands in M3 — lifecycle does not expose ctx.serveUI yet, so
// entry stays null today and the template still loads (that is the point of
// the guard). When M3 adds serveUI(dirURL), this same expression starts
// hosting ./ui at /api/ui/template-page/ with no plugin change.
export default {
  manifest: {
    id: 'template-page',
    name: 'Template Page',
    type: 'ui',
    version: '0.1.0',
    requires: { kernel: '^1', ports: { ui: '^1' } },
  },

  activate(ctx) {
    ctx.registerPage({
      id: 'template-page',
      title: '模板页',
      icon: '▤',
      order: 50, // nav position among pages (default 10; lower = earlier)
      // M3: serveUI is not in the ctx surface yet — guarded so the template
      // loads today and lights up unchanged when page serving ships.
      entry: ctx.serveUI ? ctx.serveUI(new URL('./ui', import.meta.url)) : null,
    });
  },
};
