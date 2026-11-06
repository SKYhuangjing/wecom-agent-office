// ui-office-studio: 白棚工位（成片层 + 热区层），对齐 docs/OFFICE-STUDIO-SPEC.md。
// 成片首期用自有 SVG 工位阵列；可把自有循环片放到 ui/assets/office-loop.mp4 覆盖。
import studioPage from './ui/studio.js';

export default {
  manifest: {
    id: 'ui-office-studio',
    name: 'UI Office Studio',
    type: 'ui',
    version: '0.1.0',
    requires: { kernel: '^1', ports: { ui: '^1' } },
    ui: './ui',
  },

  activate(ctx) {
    ctx.registerPage({
      id: studioPage.id,
      title: studioPage.title,
      icon: studioPage.icon,
      order: studioPage.order,
    });
  },
};
