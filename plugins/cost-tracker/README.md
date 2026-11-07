# cost-tracker

Token 用量播报插件（middleware 端口，PLUGIN-DEV §5.5）：给每个 bot 的**最终回复**末尾追加一行用量播报。

```
fake 完成：你好

---
📊 Token：输入 1.2k · 输出 35
```

## 行为

- **只统计，不定价**：数字来自引擎按轮累计的 usage（输入/输出；
  累计口径为各 provider 上报的运行总量取最大值）。本插件只追加尾行，不落库——
  台账的 `tokens` 列由引擎 bookkeep 写入（见下），台账正文保持原样，不含播报行。
- **只挂在最终回复**：进度帧 / 心跳 / 超时与打断的维护文案永远不会带播报行。
- **开关 = 资产绑定**：插件激活时自动注册 `tool` 型资产 `cost-tracker`
  （`data/assets.json`，origin `plugin`）。绑定即开启，解绑即关闭：

  ```sh
  curl -X POST   http://127.0.0.1:8792/api/bots/<botId>/assets \
       -H 'content-type: application/json' \
       -d '{"assetId":"ast-cost-tracker","mode":"shared"}'
  curl -X DELETE http://127.0.0.1:8792/api/bots/<botId>/assets/ast-cost-tracker
  ```

  shared / exclusive 两种绑定方式均可（exclusive 的快照自带名称，卸载源资产后仍生效）。
- **禁用插件** = 全局关闭：`data/plugins.json` 里 `cost-tracker.enabled:false` 后
  中间件随端口注销，所有 bot 停止播报（绑定保留，重启用即恢复）。

## usage 数据来源（provider 现状）

引擎的累计器（`plugins/core-engine/engine.js` `createUsageAccumulator`）识别四种上报方言：

| provider | 事件形状 | 当前是否上报 |
| --- | --- | --- |
| dsh | `status{phase:'step_end', usage:{…camelCase}}` → 统一 `usage` 事件 | ✅ 已修（observability wave） |
| claude | `result{usage:{…snake_case}}` → 统一 `usage` 事件 | ✅ 已修 |
| codex | `result.reason.usage`（runner 已归一化，含 `cacheReadTokens`） | ✅ 全通（cacheRead 已补） |
| pi | `result.reason.usage`（runner 已归一化，含 `cacheReadTokens` + `cost` 透传） | ✅ 全通（cacheRead/cost 已补） |

即：四 provider 岗位均出真实数字（输入/输出/cacheRead），无待办。

台账联动（observability wave）：`defaultRunTurn` 的 bookkeep 对**每个结局**（completed /
aborted / timeout / error）落 `tokens` = 该轮累计 `totalTokens`（台账正文不含播报行不变）；
`cost` 恒为 null——不算价格（pi 上报的 `cost` 由 runner 透传在 `reason.usage` 上，不进台账）。

## 不做的事

- 不算价格（无价目表；台账 `cost` 恒 null）。
- 不新增持久化字段：台账复用既有 `tokens` 列落每轮累计 totalTokens（引擎侧写入，
  本插件不写文件）；正文永不带播报行。
- 不向进度帧注入任何内容。

## 注意事项

- 该资产由插件托管（origin `plugin`）：**不要在控制台资产编辑器里改它**——编辑器
  只认 rtk/ripgrep 两种工具 kind，保存会把 content 改写成 rtk。开关只需要
  绑定/解绑；要清理就删除资产，下次 reload 插件会自动重注册。
- 删除资产后：shared 绑定随资产一起移除（播报关）；exclusive 绑定的快照仍自描述，
  播报保持开。
- 禁用本插件（plugins.json `enabled:false`）= 全局关停播报（绑定保留）。
