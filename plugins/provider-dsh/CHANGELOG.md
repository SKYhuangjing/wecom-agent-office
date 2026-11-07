# Changelog

本插件版本史（Keep a Changelog 1.1 格式；版本号与 `manifest.version` 同步）。

## [Unreleased]

### Added

- MCP 资产面（W3 T6）：dsh bot 绑定 MCP 资产不再拒绑——每 server 一条
  `mcp-<serverId>` profile 行（`@deepseek-ai/dsh-mcp-client`；stdio=
  command/args/env，http=transport `streamable-http`+url/headers；形状按已装包
  README+lib 实证）。行由 `profiles.js` 新增纯构建 `mcpClientRows` 生成，经
  `buildBotPatch` 新参数 `assetsPlan` 随**整文件重建**写入；materializeConfig 与
  materializeAssets 都传同一生效计划，bot PATCH（如改模型）重物化不掉 MCP 行
  （P0-4 同型防线）。**env/headers 值明文落 patch**（dsh profile 无引用语义、
  也不做 `${VAR}` 展开；防线=文件本身经 atomicWrite 恒 0600——明文的暴露边界即
  该文件属主）。serverId 超
  32 字符（dsh-mcp-client `SERVER_NAME_PATTERN ^[A-Za-z0-9_-]{1,32}$`，实证超长
  行被其配置校验拒绝、failOnStartupError=false 下 MCP 工具静默不出现）在绑定面
  与行构建面双拒——拒绝优于静默失败。
- ripgrep 预检（W3 T3，§7.2）：materializeAssets 对 ripgrep 资产做 rg spawn 3s 探测，结论随
  计划返回值 `tools` 进 manifest；缺失=note 指引安装（personaPrefix 指引节仍注入，预检不失败）。
  rtk 无面不变（绑定面拒绑，F27）。
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
