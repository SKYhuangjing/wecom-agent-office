// Load Magpie classic scripts once (three → scene3d after scene.js).
// Paths resolve relative to this module (= /api/ui/ui-office3d/ when hosted).

const BASE = new URL('./vendor/', import.meta.url).href;
const SCRIPTS = ['three.min.js', 'scene.js', 'scene3d.js'];

let pending = null;

function inject(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-wao-magpie="${src}"]`);
    if (existing) {
      if (existing.dataset.ready === '1') return resolve();
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(`load ${src}`)), { once: true });
      return;
    }
    const el = document.createElement('script');
    el.src = new URL(src, BASE).href;
    el.async = false;
    el.dataset.waoMagpie = src;
    el.onload = () => { el.dataset.ready = '1'; resolve(); };
    el.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(el);
  });
}

/** @returns {Promise<{ Scene: any, Scene3D: any }>} */
export function loadMagpie() {
  if (globalThis.AgentOfficeScene?.Scene && globalThis.AgentOfficeScene3D) {
    return Promise.resolve({
      Scene: globalThis.AgentOfficeScene.Scene,
      Scene3D: globalThis.AgentOfficeScene3D,
    });
  }
  if (!pending) {
    pending = (async () => {
      // scene.js first (2d/iso), then three + scene3d
      await inject(SCRIPTS[1]);
      await inject(SCRIPTS[0]);
      await inject(SCRIPTS[2]);
      if (!globalThis.AgentOfficeScene?.Scene) throw new Error('AgentOfficeScene missing');
      return {
        Scene: globalThis.AgentOfficeScene.Scene,
        Scene3D: globalThis.AgentOfficeScene3D,
      };
    })().catch((e) => { pending = null; throw e; });
  }
  return pending;
}
