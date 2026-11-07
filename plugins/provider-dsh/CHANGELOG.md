# Changelog

本插件版本史（Keep a Changelog 1.1 格式；版本号与 `manifest.version` 同步）。

## [Unreleased]

### Added

- 资产面（W3 T2，§3.3 dsh 列）：`materializeAssets` 纯计划钩子 + personaPrefix 单一组合器
  `combinePersonaPrefix`（运营者人设永远在前，资产节按绑定序；materializeConfig 与
  materializeAssets 同过组合器，「改模型丢资产节」结构性不可达）+ `.wao/skills/` 技能树；
  profiles.js 拆出纯构建 `buildBotPatch`。
## [0.1.0] - 2026-11-06

初始发布。

### Added

- dsh runner：SIGTERM→SIGKILL 升级杀链、原子化 profile 落盘、zstd 历史压缩。
- removeConfig 钩子：bot 删除时清理落盘 profile。

### Fixed

- 历史截断改为最新在前，续会话恢复不再丢失近段上下文。
