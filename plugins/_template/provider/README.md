# template-provider（provider 插件模板）

这是一个**可装载、可运行**的 provider 端口最小实现：runner 把 prompt 原样回显
（`template echo: <prompt>`），用于验证内核装载链路与演示端口契约。
完整契约说明见 [docs/PLUGIN-DEV.md](../../../docs/PLUGIN-DEV.md)。

## 复制三步（改名清单）

1. **复制目录**：`cp -r plugins/_template/provider plugins/<你的插件名>/`
   （目录名建议与 manifest.id 一致，如 `provider-myagent`）。
2. **改三处名字**：
   - `plugin.js` → `manifest.id`（`^[a-z0-9-]+$`，如 `provider-myagent`）与 `manifest.name`；
   - `plugin.js` → 顶部 `PORT_ID` 常量（bots.json 里 `provider` 字段引用的就是它，如 `myagent`）；
   - `package.json` → `name` 改为 `wao-plugin-<你的插件名>`，`version` 从 `0.1.0` 起步。
3. **替换实现**：把 `run()` 的回显换成真实 Agent CLI 调用
   （成功判据、事件映射、abort 升级 SIGKILL、`readHistory` 容错——见 PLUGIN-DEV.md §端口契约）。

## 装载验证

```bash
# 内核默认跳过 _ 前缀目录；复制改名后即被扫描
node src/index.js doctor          # 应列出你的插件目录
node src/index.js start           # 日志出现 "wao up: N plugins"
curl -s http://127.0.0.1:8792/api/plugins   # status: active
```

## 注意

- `package.json` 的 `"type": "module"` **不可删**：Node < 22.7 下没有它，
  `plugin.js` 会被按 CommonJS 解析而装载失败（loader 会附提示，但别依赖提示）。
- 插件**零 npm 依赖**：WebSocket 请用 `ctx.ws.WebSocket`，定时器请用
  `ctx.setTimeout/setInterval`（deactivate 自动清理）。
- 共享代码政策是**复制即契约**：不要 import 其他插件目录，也不要建影子公共库。
