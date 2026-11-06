# mcp-gateway

MCP 网关插件（W1 T1）：把公司操作面以 MCP（Model Context Protocol）最小子集暴露在
`POST /mcp`，供 AI Agent CLI（claude / codex / ZCode 等）直连操作公司。零新依赖：
JSON-RPC 2.0 over HTTP 自研协议子集（计划见 docs/superpowers/plans/2026-11-07-wao-v2.md W1）。

## 端点

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| POST | `/mcp` | JSON-RPC 2.0：`initialize` / `tools/list` / `tools/call` / `notifications/*`（单个请求，或纯通知数组） |
| GET | `/mcp` | 405 + 说明体（SSE 服务端推送为二期能力） |
| DELETE | `/mcp` | 202，终结 `Mcp-Session-Id` 会话（幂等；未知/缺头同样 202） |

## 协议子集（T1 范围）

- **initialize**：返回 `protocolVersion: "2025-06-18"`、`capabilities: {tools:{}}`、
  `serverInfo: {name:"wao-company", version}`；客户端版本不一致时回服务端版本（客户端自行决定去留）。
  响应头生成 `Mcp-Session-Id`（uuid）。
- **会话**：initialize 之后的请求必须携带 `Mcp-Session-Id`（响应回显同值）；缺失或未知/已终结 →
  JSON-RPC error `-32002`。会话不过期（单用户），仅 DELETE /mcp 显式终结、服务重启自然失效
  （客户端收到 -32002 后重新 initialize 即可）。
- **tools/list**：T1 返回空 `{tools:[]}` 占位（T2 填实为 `{name,description,inputSchema}` 全集）；
  **tools/call**：T2 之前返回 `-32601`。
- **notifications/***（含 `notifications/initialized`）及通知数组 → HTTP 202 空体，永不回错误。
- **错误约定**：协议错误一律 HTTP 200 + JSON-RPC error 对象（`-32700` 解析失败 / `-32600` 请求形状
  无效 / `-32601` 方法未知 / `-32603` 内部错误 / `-32002` 会话缺失）；传输层错误用 HTTP 状态码
  （405 / 415 / 413 / 404）。
- **Content-Type**：POST 必须 `application/json`（带 charset 参数亦可），否则 415；不启用 CORS（同源/本地）。

## 二期说明

GET /mcp 的 SSE 服务端通知流、resources/prompts 能力、请求批量响应均不在本子集——
二期再评估（见计划 W1 后续）。
