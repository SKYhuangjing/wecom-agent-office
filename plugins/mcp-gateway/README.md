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
| GET | `/api/mcp` | 控制台状态面（v2 AI-access discovery）：`{ok, endpoint:'/mcp', sessions, tools:[{name,description,dangerous}]}`——活跃会话数 + 19 工具清单（高危标记），总览引导卡与设置「AI 操作」section 的数据源 |
| GET | `/api/mcp/skill` | `{ok, filename:'wao-company.md', content}`：仓库 `docs/skills/wao-company.md` 全文（按请求读取；打包安装缺仓库 docs 树时诚实 404），设置页「下载 skill 文件」用 |

`/api/mcp*` 与其它 `/api/*` 同样走 `WAO_TOKEN` 鉴权（Web SDK 的 api() 自动带头）。
`toolRoster()`（tools.js）导出 name+dangerous 清单给状态面——MCP `tools/list` 描述符
形状不变，已接入的客户端零影响。

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
  **业务失败不是协议错误**：工具执行中遇到的 400 校验（如重复创建 `bot id already exists`）/
  404 查无 / 409 离线广播等，以 `result.isError:true` + 中文原因返回（Agent 可读），不抛 JSON-RPC error。
- **Content-Type**：POST 必须 `application/json`（带 charset 参数亦可），否则 415；不启用 CORS（同源/本地）。

## 工具面（T2 13 个 + W3 T1 资产面 6 个；标准术语命名，README §4.2 词表）

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `list_bots` | — | 机器人清单（状态/离线原因/进度行/今日消息/引擎） |
| `get_bot` | `botId` | 单机器人详情（配置摘要无 secret；敏感值不回显——secret 类键整体省略） |
| `create_bot` | `bot` | 创建机器人（全字段记录；校验错误逐字段透传，附在册端口清单） |
| `update_bot` | `botId`,`patch` | 配置更新（patch 语义；密码留空＝保留） |
| `delete_bot` | `botId` | ⚠️ 删除机器人（结果带后果清单：收尾/目录清理/台账留存/可重新创建） |
| `set_enabled` | `botId` | 暂停↔启用（enabled 切换） |
| `test_bot` | `botId`,`sessionId?`,`prompt?` | 测试运行（不进引擎链、不记台账；成功判据是结果 code 字段，勿只看 isError） |
| `broadcast` | `botId`,`chatKey`,`content` | ⚠️ 广播（真实送达企微，无法撤回） |
| `list_plugins` | — | 插件清单 id/type/version/status |
| `toggle_plugin` | `pluginId`,`enabled` | ⚠️ 插件启停（四阶段重载；结果带「影响 N 台机器人离线」，仅计在线机器人；引擎不可用时如实报「影响未知」） |
| `get_ledger` | `botId`,`chatKey?` | 会话历史（台账轮次） |
| `get_timeline` | `botId?`,`windowMin?` | 活动日志（时间线事件流） |
| `get_state` | — | 系统状态摘要（运行时长/插件/机器人） |
| `create_asset` | `asset` | 登记资产（五类 skill/memory/mcp/prompt/tool；强制 origin:mcp → 仅可私发绑定；mcp env/headers 回显按位置掩码） |
| `update_asset` | `assetId`,`patch` | 更新资产（version 自增；配发绑定扇出重物化）。分级：配发（shared 池）资产只读，指引走控制台/REST |
| `delete_asset` | `assetId` | 删除资产（配发绑定解绑+清理；私发副本保留生效）。分级：配发资产只读 |
| `bind_asset` | `botId`,`assetId`,`mode` | ⚠️ 绑定（配发/私发；后果：向 bot 磁盘写入文件并重建 runner，下一轮生效） |
| `unbind_asset` | `botId`,`assetId` | ⚠️ 解绑（后果：删除盘上产物；私发副本内容随卸载丢失） |
| `rematerialize` | `botId` | ⚠️ 强制重物化（确定性/幂等；漂移修复与扇出失败重试路径） |

每工具输出双形态：`content[].text`（中文人类可读摘要）+ `structuredContent`（结构化数据）。
secret 红线：结果永不回显 secret（写路径入参可带，结果经 masked echo + sanitize 双保险剥离）。

Agent 侧配套快捷 skill（触发词/意图配方/危险操作确认规范）在 `docs/skills/wao-company.md`；
三家 CLI（claude/codex/ZCode）接入配置样例见仓库 README §3.2「MCP 接入」。

实现复用规则：工具不 HTTP 自调用——机器人/台账/推送走 core-engine api.js 的 `companyOps`
服务（与 /api 路由同一函数），插件启停走 src/index.js 的 `kernelOps` 服务（与内核原生
`/api/plugins/:id/enable|disable` 同一函数），均经 services 容器按次查找（reload 后即取新实例）。

## 二期说明

GET /mcp 的 SSE 服务端通知流、resources/prompts 能力、请求批量响应均不在本子集——
二期再评估（见计划 W1 后续）。
