# Changelog

本插件版本史（Keep a Changelog 1.1 格式；版本号与 `manifest.version` 同步）。

## [0.1.0] - 2026-11-06

初始发布。

### Added

- dsh runner：SIGTERM→SIGKILL 升级杀链、原子化 profile 落盘、zstd 历史压缩。
- removeConfig 钩子：bot 删除时清理落盘 profile。

### Fixed

- 历史截断改为最新在前，续会话恢复不再丢失近段上下文。
