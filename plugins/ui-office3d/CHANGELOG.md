# Changelog

本插件版本史（Keep a Changelog 1.1 格式；版本号与 `manifest.version` 同步）。

## [0.2.0] - 2026-11-07

### Changed

- 办公室页替换为 Magpie AgentOffice（`vendor/scene.js` + `scene3d.js` + three r169）：**2D / ISO / 3D** 三视角，接 `useAgents()`；状态映射 working→executing · idle→done · offline→error。
- Harness 查询参数改为 `?dim=2d|iso|3d`、`?scene=`、`?quality=`（默认 iso，兼容旧截图无 dim）。

### Added

- 侧栏花名册、3D 主题切换（`setScene`，禁止同 canvas dispose 重建）、画质档位。

### Notes

- 旧 ofscene 软插画实现移至 `ui/legacy/`；`test/ui/ofscene.test.js` 仍锁引擎数学。

## [0.1.0] - 2026-11-06

初始发布（ofscene 软插画）。
