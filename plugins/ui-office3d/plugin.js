// ui-office3d: Magpie AgentOffice 页面插件（2D / ISO / 3D WebGL）。
// 浏览器契约在 ui/（no-build ESM，kernel 托管 /api/ui/ui-office3d/）。
// 旧 ofscene 软插画实现保留在 ui/legacy/ 供单测；生产页走 Magpie vendor。
import officePage from './ui/office.js';

export default {
  manifest: {
    id: 'ui-office3d',
    name: 'UI Office 3D',
    type: 'ui',
    version: '0.2.0',
    requires: { kernel: '^1', ports: { ui: '^1' } },
    ui: './ui',
  },

  activate(ctx) {
    ctx.registerPage({
      id: officePage.id,
      title: officePage.title,
      icon: officePage.icon,
      order: officePage.order,
    });
  },
};
