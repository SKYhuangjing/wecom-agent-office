# cost-tracker

## 0.1.0 (2026-11-07)

- 初始版本：middleware 端口插件，最终回复末尾追加 📊 Token 用量行（输入/输出）。
- 按 bot 开关：激活时自动注册 `tool` 型资产 `cost-tracker`，绑定/解绑即开/关。
- 引擎侧配套：`defaultRunTurn` 的最终回复经 `middleware.onOutbound(text, ctx)`，
  ctx 携带 `{bot, usage, model, durationMs}`；usage 累计器识别 dsh/claude/codex
  三种上报方言（`createUsageAccumulator`）。
- 不定价、不持久化。
