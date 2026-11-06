# mcp-gateway

MCP 网关插件（W1 T1+T2）：把公司操作面以 MCP（Model Context Protocol）最小子集暴露在
`POST /mcp`，供 AI Agent CLI（claude / codex / ZCode 等）直连操作公司。零新依赖：
JSON-RPC 2.0 over HTTP 自研协议子集（计划见 docs/superpowers/plans/2026-11-07-wao-v2.md W1）。

## 端点

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| POST | `/mcp` | JSON-RPC 2.0：`initialize` / `tools/list` / `tools/call` / `notifications/*`（单个请求，或纯通知数组） |
| GET | `/mcp` | 405 + 说明体（SSE 服务端推送为二期能力） |
| DELETE | `/mcp` | 202，终结 `Mcp-Session-Id` 会话（幂等；未知/缺头同样 202） |

## 协议子集

- **initialize**：返回 `protocolVersion: "2025-06-18"`、`capabilities: {tools:{}}`、
  `serverInfo: {name:"wao-company", version}`；客户端版本不一致时回服务端版本（客户端自行决定去留）。
  响应头生成 `Mcp-Session-Id`（uuid）。
- **会话**：initialize 之后的请求必须携带 `Mcp-Session-Id`（响应回显同值）；缺失或未知/已终结 →
  JSON-RPC error `-32002`。会话不过期（单用户），仅 DELETE /mcp 显式终结、服务重启自然失效
  （客户端收到 -32002 后重新 initialize 即可）。
- **notifications/***（含 `notifications/initialized`）及通知数组 → HTTP 202 空体，永不回错误。
- **错误约定**：协议错误一律 HTTP 200 + JSON-RPC error 对象（`-32700` 解析失败 / `-32600` 请求形状
  无效 / `-32601` 方法未知 / `-32602` 工具名或参数形状无效 / `-32603` 内部错误 / `-32002` 会话缺失）；
  传输层错误用 HTTP 状态码（405 / 415 / 413 / 404）。
  **业务失败不是协议错误**：工具执行中遇到的 400 校验 / 404 查无 / 409 冲突等，以
  `result.isError:true` + 中文原因返回（Agent 可读），不抛 JSON-RPC error。
- **Content-Type**：POST 必须 `application/json`（带 charset 参数亦可），否则 415；不启用 CORS（同源/本地）。

## 工具面（T2，13 个；公司话命名，README §4.2 词表）

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `list_employees` | — | 在岗名册（状态/离线原因/进度行/今日工单/岗位） |
| `get_employee` | `botId` | 单员工详情（配置摘要无 secret，敏感值 `__MASKED__`） |
| `hire` | `bot` | 入职（全字段档案；校验错误逐字段透传，附在册端口清单） |
| `update_employee` | `botId`,`patch` | 档案更新（patch 语义；密码留空＝保留） |
| `offboard` | `botId` | ⚠️ 离职（结果带面谈后果：收尾/工位清理/档案留存/可重新入职） |
| `set_duty` | `botId` | 调休↔返岗（enabled 切换） |
| `probation_test` | `botId`,`sessionId?`,`prompt?` | 岗前测试（不进引擎链、不记台账） |
| `broadcast` | `botId`,`chatKey`,`content` | ⚠️ 广播（真实送达企微，无法撤回） |
| `list_departments` | — | 部门（插件）清单 id/type/version/status |
| `department_toggle` | `departmentId`,`enabled` | ⚠️ 部门启停（四阶段重组；结果带「影响 N 名员工下线」） |
| `work_log` | `botId`,`chatKey?` | 工作档案（台账轮次） |
| `work_timeline` | `botId?`,`windowMin?` | 工作日志（时间线事件流） |
| `company_state` | — | 公司状态摘要（运行时长/部门/员工） |

每工具输出双形态：`content[].text`（中文人类可读摘要）+ `structuredContent`（结构化数据）。
secret 红线：结果永不回显 secret（写路径入参可带，结果经 masked echo + sanitize 双保险剥离）。

实现复用规则：工具不 HTTP 自调用——员工/台账/推送走 core-engine api.js 的 `companyOps`
服务（与 /api 路由同一函数），部门启停走 src/index.js 的 `kernelOps` 服务（与内核原生
`/api/plugins/:id/enable|disable` 同一函数），均经 services 容器按次查找（reload 后即取新实例）。

## 二期说明

GET /mcp 的 SSE 服务端通知流、resources/prompts 能力、请求批量响应均不在本子集——
二期再评估（见计划 W1 后续）。
