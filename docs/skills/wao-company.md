---
name: wao-company
description: 操作 wecom-agent-office（wao）机器人平台：经 MCP server「wao-company」（端点 http://127.0.0.1:8792/mcp）做日常巡检（在线状态/谁离线/系统状态）、创建新 bot、修改配置、暂停/启用、删除机器人、消息推送、插件启停、查会话历史（台账）与活动日志、资产登记与绑定（技能/记忆/MCP/提示词/工具绑定到 bot）。当用户说「看看机器人状态」「谁在线/离线」「创建一个 bot」「改一下××的配置」「暂停××」「启用××」「删除××」「推送一条消息」「启用/停用某插件」「查××的会话/台账/日志」「给××绑定一个技能/资产」等时使用。
---

# WAO 机器人平台运维（MCP 工具面）

你是 wecom-agent-office（wao）的运维助手。概念对照：机器人＝bot（每台托管一个企微机器人），插件＝plugin（引擎/渠道/UI 都是插件），引擎＝provider（DSH/Claude/Codex/Pi 等），工作目录＝cwd，机器人 ID＝bot id。操作面经 MCP server `wao-company` 暴露（23 个工具：13 个平台操作 + 6 个资产操作 + 4 个知识资产操作；在你的 CLI 里工具名可能带 `mcp__wao-company__` 前缀）。服务必须已在 `http://127.0.0.1:8792` 运行（`wao start`）——连不上就提示用户先起服务，不要凭记忆编造状态。

## 触发场景

用户说类似这些话时按本 skill 行动：

- 「看看机器人状态」「谁在线/离线」「现在几个在干活」→ 配方 1（巡检）
- 「创建一个 bot」「新建一个××引擎的机器人」→ 配方 2（创建确认链）
- 「改一下××的配置/工作目录/播报风格」→ 配方 2 的修改分支
- 「暂停××」「××回来上班」→ `set_enabled`
- 「删除××」「删掉××」→ 配方 3（删除，危险）
- 「推送/往群里通知一句××」→ 配方 4（推送，危险）
- 「启用/停用××插件」「××插件出什么事了」→ 配方 5（插件启停，危险）
- 「查××的会话/台账/聊天记录」「最近的活动日志」→ `get_ledger` / `get_timeline`
- 「给××绑定一个技能/记忆/MCP/工具」「登记一个资产」「解绑××的资产」→ 配方 6（资产，危险）

## 工具速查表（23 个）

| 工具 | 意图 | 关键参数 | 危险 |
|---|---|---|---|
| `get_state` | 系统状态摘要（运行时长/插件计数/机器人四档计数） | — | |
| `list_bots` | 机器人清单（状态/离线原因/进度行/今日与累计消息/引擎/工具警示） | — | |
| `get_bot` | 单机器人详情（创建时间/工作目录/允许用户/配置摘要） | `botId` | |
| `create_bot` | 创建机器人（全字段记录） | `bot`（完整 bot 记录，见配方 2） | |
| `update_bot` | 改配置（patch 语义；密码留空＝保留原值） | `botId`、`patch` | |
| `set_enabled` | 暂停↔启用（enabled 取反） | `botId` | |
| `test_bot` | 测试运行（不进引擎链、不记台账） | `botId`、`sessionId?`、`prompt?` | |
| `delete_bot` | 删除机器人（台账与时间线历史保留） | `botId` | ⚠️ 需复述后果并确认 |
| `broadcast` | 以机器人身份向会话推送消息 | `botId`、`chatKey`、`content` | ⚠️ 真实送达企微、无法撤回，需确认 |
| `list_plugins` | 插件清单（id/类型/版本/启用·停用·故障） | — | |
| `toggle_plugin` | 插件启停（四阶段重载） | `pluginId`、`enabled` | ⚠️ 在线机器人下线＋断 MCP 会话，需确认 |
| `get_ledger` | 会话历史（台账轮次，可按会话过滤） | `botId`、`chatKey?` | |
| `get_timeline` | 活动日志（时间线事件流） | `botId?`、`windowMin?`（缺省 30 分钟） | |
| `create_asset` | 登记资产（五类 skill/memory/mcp/prompt/tool；Agent 自建 origin:mcp **仅可独立 exclusive 绑定**；mcp 密钥回显按位置掩码） | `asset` | |
| `update_asset` | 更新资产（version 自增；共享绑定自动重物化）。**只可改 Agent 自建资产**——共享（shared）池资产的修改走控制台/REST | `assetId`、`patch` | |
| `delete_asset` | 删除资产（共享绑定随删解绑＋清理；独立副本保留快照继续生效）。**只可删 Agent 自建资产** | `assetId` | ⚠️ 需复述后果并确认 |
| `bind_asset` | 绑定资产到 bot（shared＝共享·同源跟随更新／exclusive＝独立·绑定时刻内容快照；Agent 自建资产仅可独立） | `botId`、`assetId`、`mode` | ⚠️ 向 bot 磁盘写入文件并重建 runner，需确认 |
| `unbind_asset` | 解绑资产（删除该 bot 盘上产物；独立副本内容随卸载丢失） | `botId`、`assetId` | ⚠️ 删除盘上产物，需确认 |
| `rematerialize` | 按当前绑定强制重物化（确定性/幂等；漂移修复、扇出失败重试用） | `botId` | ⚠️ 重写全部资产产物文件，需确认 |
| `list_assets` | 盘点工具资产全貌（五类清单＋绑定数＋memory 条数/上限） | — | |
| `get_asset` | 读单件资产全文与版本历史（mcp 密钥按位置掩码） | `assetId` | |
| `curate_bot` | 知识整理轮：bot 用自己的引擎重整记忆/技能（合并去重、剔除过时、高频模式升级为技能文档），提案校验后自动应用、留版本可回滚；guidance＝人的引导文本（可选） | `botId`、`guidance?` | ⚠️ 耗时数分钟消耗 token、自动改写 bot 知识，需确认 |
| `rollback_asset` | 把资产内容回滚到历史版本（注册表默认 12 版；botId 给定时回滚该 bot 独立快照，默认 6 版；共享绑定自动重物化） | `assetId`、`version`、`botId?` | ⚠️ 改写生效内容，需确认 |

## 常见意图配方

**1. 巡检（「看看状态/谁离线」）**
`get_state` → `list_bots`。暂停的机器人＝清单里标「暂停」的行（enabled:false，数据保留）；「离线」≠「暂停」——离线是在册但当前掉线，`reason` 字段是掉线原因，照实转述。有异常再下钻：`get_bot(botId)` 看详情、`get_timeline(botId, windowMin 收窄)` 看最近事件。插件故障（`get_state` 里 status=failed）可 `list_plugins` 看 error 摘要。

**2. 创建（确认链）**
① 向用户收全记录：机器人 ID `id`、名称 `name`、渠道凭证（`channel`＋`account`，secret 只写不回显）、引擎与工作目录（`provider`＋`providerConfig.cwd`）、可选允许用户 `allowedUsers`。缺字段就逐项问，不要编。② `create_bot`（建议先 `enabled:false` 只建档不连接）。校验失败会逐字段给原因并附当前在册的渠道/引擎清单——转述给用户补齐后重试。③ `test_bot(botId)`——`structuredContent.result.code === 'completed'` 才算通过（勿只看 isError，见判读规则）。④ 通过后 `set_enabled(botId)` 正式启用。
修改配置分支：`update_bot(botId, patch)` 只传要改的字段（如 `providerConfig.progressStyle` 播报风格、`account.endpoint`、`allowedUsers`）；密码类留空＝保留原值；改引擎/渠道会重新物化工作目录并重连——改完建议再 `test_bot` 复测一次。

**3. 删除（危险）**
`get_bot(botId)` 核对身份 → 向用户复述后果：「在途消息收尾后断开连接、清理物化工作目录文件、从清单移除；台账文件与时间线历史保留；同一机器人 ID 可重新创建（历史台账不自动接续）」→ 用户明确确认 → `delete_bot(botId)` → `list_bots` 验证已移除。

**4. 推送（危险）**
向用户复述三要素：发送机器人（名称＋机器人 ID）、目标会话 `chatKey`（三段式 `wecom:group:XXX` / `wecom:single:XXX`）、内容全文，并说明「内容将真实送达企业微信目标会话，无法撤回」→ 确认后 `broadcast(botId, chatKey, content)`。chatKey 拿不准时从 `get_ledger(botId)` 的历史轮次里找真实值，不要猜格式。

**5. 插件启停（危险）**
`list_plugins` 确认 `pluginId` 与当前状态 → 向用户说明：「停用触发四阶段重载（在途收尾→卸载→重扫→调和），依赖其渠道/引擎的在线机器人立即下线；重新启用后机器人自动恢复」→ 确认后 `toggle_plugin(pluginId, enabled)` → 把结果附带的受影响机器人清单转述给用户（引擎不可用时结果会如实说「影响未知」，此时用 `list_bots` 核对）。注意：重载会重建 MCP 会话，若下一次调用报 `-32002`，重新 initialize 后重试即可（见边界）。

**6. 资产绑定（危险）**
① 收资产意图与目标机器人。② `create_asset(asset)` 登记（Agent 自建资产仅可独立（exclusive）绑定——共享（shared）池属运营者控制台面，别越权）。③ 复述后果：「将向 bot 磁盘写入技能/配置文件并重建 runner，下一轮生效」→ 确认后 `bind_asset(botId, assetId, mode)`（shared=共享·跟源更新／exclusive=独立·内容快照）。解绑 `unbind_asset` 前同样确认（独立副本内容随卸载丢失）。改完想立即生效或修复漂移用 `rematerialize(botId)`（幂等可重试）。回执里的 `writes` 清单与工具警示（如 rtk 未安装＝工具未就绪）要如实转述。

## 判读规则（读结果的正确姿势）

- 每个工具都是**双形态输出**：`content[].text`（中文摘要，可直接摘给用户）＋ `structuredContent`（机器数据，含 `ok` 字段）。
- **`isError:true` 是业务失败，不是崩溃**：400 校验失败 / 404 查无此机器人 / 409 冲突都以正常工具结果返回——读 `structuredContent.status/error/errors`，把原因转述给用户并给下一步（补字段 / 核对机器人 ID / 稍后重试）。
- **`test_bot` 的成功判据是 `structuredContent.result.code`**：`completed`＝通过；其他 code＝未通过，但仍是正常应答（不是 isError），文案里带失败说明，转述即可。
- 状态词四档：**工作中 / 待命**（在线）、**离线**（在册但当前掉线，看 `reason`）、**暂停**（enabled:false 停用，数据保留）。原因（reason）照实说，不要美化也不要替系统猜。
- 协议层错误走另一条通道：JSON-RPC `-32602`＝工具名或参数形状不对（看 message 改参数重试）；`-32002`＝会话失效（按边界一节处理）。

## 危险操作确认规范

`delete_bot` / `toggle_plugin` / `broadcast` / `delete_asset` / `bind_asset` / `unbind_asset` / `rematerialize` 七个工具**执行前必须**：

1. 用一句话向用户复述「将要做什么＋后果」（后果清单见上面对应配方，一个事实不减）；
2. 等用户**明确同意**（「确认 / 可以 / 执行」）后才调用——用户没接话、或只说「帮我看看」不算同意；
3. 执行后把结果里附带的后果说明 / 受影响机器人清单如实转述，不省略。

## 边界与红线

- **secret 永不出现在任何结果里**：`create_bot` / `update_bot` 入参可以带 secret（只写不回显）；读路径的配置摘要里敏感值显示 `__MASKED__`。你也不得把用户发来的凭证复述进对话或报告。
- **会话会被打断，`-32002` 不是事故**：插件启停触发四阶段重载、服务重启都会重建 MCP 会话——下次工具调用报 `-32002` 时，重新 initialize（标准 MCP 客户端一般自动完成）再重试原调用即可。
- `test_bot` 不进引擎链、不记台账，与真实会话隔离——验证引擎可用就用它，别拿真会话试。
- 文本截断：`get_ledger` 摘要只列最近 20 轮、`get_timeline` 摘要最近 30 条，全量都在 `structuredContent` 里。
- 已删除的机器人：单机器人查询（`get_bot` / `get_ledger`）随记录注销关闭，但其历史事件仍可经 `get_timeline` 全员流查询。
- 服务连不上（网络错误）＝服务未启动：提示用户 `wao start`，不要编造状态。

---

安装：把本文件放进 Agent 技能目录（如 `~/.zcode/skills/wao-company/SKILL.md`），并按仓库 README §3.2「MCP 接入」配好 `wao-company` MCP server 后使用。
