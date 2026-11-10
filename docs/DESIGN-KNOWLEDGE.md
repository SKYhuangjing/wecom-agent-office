# DESIGN-KNOWLEDGE — 知识资产模块（呈现 + AI 自主整理）

> 2026-11-11 立项。目标一句话：把 bot 的记忆/文档/提示词从黑盒变成平台一等公民资产——
> **看得见**（bot 维度 + 平台维度）、**理得动**（AI 自主再整理，人只补充引导）、**可回滚**（版本历史）。

## 1. 背景与用户口径（已对齐）

- 资产三件套：**初始提示词**（bot.providerConfig.prompt + 平台组装面）、**记忆**（L2 蒸馏 memory 资产）、
  **文档/技能**（skill 资产，如 sls-usage）。它们物理存在但全是黑盒——上次要知道「初始消息组装成啥样」
  得去 PC1 抓真实 stdin。
- **整理是 AI 自己做，人只负责补充引导**（用户明确裁定）。整理结果不需要人审核后生效，
  但必须可回滚、可观测。
- 交付口径：一个可用模块，含 UI 呈现 + 整理闭环 + MCP 操作面 + 测试与盲评。

## 2. 现状盘点（2026-11-11 探索结论，行号见当时快照）

**可直接复用**：
- L2 蒸馏闭环：`MEMORY_DISTILL_FOOTER`（四家 provider）→ `extractMemoryUpdates`（distill.js）→
  `mergeMemoryNotes`（LRU 50 条 ×2KB）→ `updateAssetOp` → `rematerializeBots`。
- 资产系统：五 type（skill/memory/mcp/prompt/tool），shared/exclusive 绑定 + 快照，manifest +
  jail/原子性物化，`/api/assets` 全 CRUD。
- `testBotOp`（POST /api/bots/:id/test）：直跑 runner、以装备态运行、settle 看门狗——整理轮的执行通道参考。
- `companyOps(state)` 一源双面：REST 与 MCP 调同一批 `*Op` 函数。
- 台账 usage 细分（inputTokens/cacheReadTokens/outputTokens/totalTokens）。
- UI 底座：robots 详情四 tab、Group 折叠块、wb-modal、TypeBadge/ModeBadge、MdText、fake-data + ui-shot 回路。

**缺口（本模块要填）**：
1. bot 维度无知识内容视图（绑定行只有摘要，无记忆条目/技能正文/提示词组装预览）。
2. 平台维度无 bot×资产矩阵总览。
3. 无整理入口：没有任何「让 bot 重整自己知识」的通道。
4. 资产无版本历史/回滚——updateAssetOp 只 bump version 不留快照。
5. MCP 无 list_assets/get_asset（AI 盲态，盘点不了资产）；也无整理触发工具。
6. 提示词组装散在 engine（任务面）+ 各 runner（system 面）+ 盘面文件，无预览函数。
7. **既有 bug**：exclusive 绑定的 memory 收不到蒸馏写回（updateAssetOp 只扇出 shared，快照永不更新）。
8. **既有 bug**：cost-tracker 的 tool kind 不在白名单（assets.js kind 校验），经 PATCH 改它会 400。

## 3. 方案选型

### 3.1 谁来整理（已由用户裁定：AI 自己做）

| 方案 | 说明 | 取舍 |
| --- | --- | --- |
| A. 纯呈现+手工编辑 | 只做可视化，人手工改 | 不满足「自我进化」，否 |
| B. 平台策展 agent | 中心 AI 替所有 bot 整理 | 需要独立模型/凭证；与「bot 自我进化」语义不符，否 |
| **C. bot 自我整理（采纳）** | 用目标 bot 自己的引擎跑一轮「整理轮」，读自己的知识、产出提案、平台原子应用 | 零新增凭证；进化主体=bot 本身；复用 testBotOp 通道 |

### 3.2 提案怎么传出（模型→平台）

- **主通道**：模型用 Write 工具把提案写到 `<cwd>/.wao/curation/proposal.json`（claude/codex/pi 有工具面）。
- **回退通道**：dsh 无工具面 → 最终回复里 ```json 围栏包裹同构提案，引擎解析。
- 两条都解析，优先文件；都缺 → 记失败原因，不应用（拒绝优于静默纠正）。

### 3.3 应用通道（平台→落盘）

提案经校验后走**既有 updateAssetOp/资产创建**（version bump + shared 扇出重物化），
不另开写盘路径——jail/原子性/manifest 全部继承。

## 4. 架构

### 4.1 core-engine 新增 `knowledge.js`

三个核心函数 + 数据落点：

```
buildKnowledgeBundle(state, botId)   // 只读聚合：呈现面数据源
runCuration(state, botId, {guidance}) // 整理轮：直跑 runner → 解析提案 → 校验 → 应用 → 记史
rollbackAssetContent(state, assetId, version) // 版本回滚
```

**buildKnowledgeBundle 返回**（GET /api/bots/:id/knowledge）：
- `prompt`: `{sections:[{kind:'argv'|'file'|'profile'|'stdin', title, text?, paths?, truncated?}], notes[]}`
  ——来自 provider 新增的 `knowledgeFace(bot, ctx)` 钩子（§4.2），文件实读（单文件 80KB/总量 200KB 截断）。
- `memory`: 生效记忆（resolveBinding 解析 shared 活资产 / exclusive 快照）——条目全文、条数/上限、资产元数据。
- `skills`: 生效技能列表（name/description/origin/版本/正文，正文超 16KB 截断标注）。
- `curation`: 整理史最近 N 条（§4.4）。

**runCuration 流程**：
1. per-bot 内存锁（同 bot 不并发整理）；guidance 可选自由文本（人只补充引导）。
2. 组装整理提示词：内联生效记忆全文 + 技能正文（>16KB 给盘面路径提示）+ 整理规则 + 输出协议（§5 模板）。
3. testBotOp 同款直跑 runner（全新会话、装备态 cwd、settle 看门狗），超时 `CURATION_TIMEOUT_MS`
   （默认 300s，limits 可覆写）；prompt 上限独立（512KB，远大于岗前测试的 2000 字符）。
4. 解析提案（文件优先、围栏回退）→ 校验（§6）→ 逐项应用：
   - memory：写生效目标——shared→updateAssetOp（扇出）；exclusive→更新 bot 快照 + snapshotVersion + 重物化该 bot。
   - skills create：新资产 `origin:'curation'`，type skill，自动 exclusive 绑定本 bot（AI 产物不自动跨 bot 共享）。
   - skills update：仅允许改 `origin==='curation'` 且绑定本 bot 的技能。
5. 写整理史 + 回执（应用了什么/跳过了什么/为什么），含整理轮 usage。

### 4.2 provider 钩子 `knowledgeFace(bot, ctx)`（五家）

provider 最清楚自己的送达面，core-engine 不重复实现组装逻辑：
- **claude**：argv 段（--append-system-prompt = 人设+prompt/ripgrep 资产文本）+ 盘面（CLAUDE.md 记忆节、
  skills/*/SKILL.md、settings.json hook、claude-mcp.json）+ stdin 任务信封说明。
- **codex**：盘面为主（AGENTS.md 全部节含人设、.agents/skills、config.toml MCP 节）+ stdin。
- **pi**：argv 段（--append-system-prompt 人设 + 资产 flags）+ 盘面（wao-memory.md、skills/）。
- **dsh**：profile 段（combinePersonaPrefix 全文）+ 盘面（.wao/skills 索引）。
- **cursor**：argv 段（prompt 资产前缀块）+ 说明（无资产绑定面）。
缺钩子时 core-engine 通用回落（人设 + 绑定资产文本 + manifest 文件清单）。

### 4.3 版本历史与回滚（数据面）

- 资产记录新增 `history: [{version, at, via, note?, content}]`，**cap 12**，内容变更即入（distill 写回也入，
  连续同内容去重）。旧行无此字段，消费方容忍缺失。
- exclusive 快照在 binding 上新增 `snapshotHistory`（cap 6）。
- `POST /api/assets/:id/rollback {version}`：从 history 恢复 content，version 继续递增，via='rollback'，
  shared 扇出重物化。MCP 侧同名工具（危险级）。

### 4.4 整理史（观测面）

`data/curation/<botId>.jsonl` append-only：
`{at, guidance, ok, reason?, summary, changes:{memory:{before,after}, skillsCreated[], skillsUpdated[], skipped[]}, usage}`
——knowledge tab 呈现；效果对比（整理前后跨轮 token/耗时报表）为 v2 非目标，先留数据不留报表。

### 4.5 API 与 MCP

- REST：`GET /api/bots/:id/knowledge`、`POST /api/bots/:id/curate {guidance?}`、`POST /api/assets/:id/rollback {version}`。
- companyOps 增 `knowledgeOp / curateBotOp / rollbackAssetOp`（一源双面自动生效）。
- MCP 新工具 4 个：`list_assets`（清单+绑定）、`get_asset`（含 content）、`curate_bot`（危险）、
  `rollback_asset`（危险）。补上 AI 盘点盲区。

### 4.6 UI

- **robots 详情新 tab「知识」**（TAB_IDS + 'knowledge'）：
  - 提示词预览：sections 按 kind 徽章（argv/盘面/profile/stdin）分组折叠，正文只读。
  - 记忆：条数进度（n/50）+ 全部条目列表 + 来源资产/模式徽章。
  - 技能文档：per-skill 折叠看正文 + origin 徽章。
  - AI 整理：引导输入框（可选）+「开始整理」按钮（确认弹层：会消耗 token、结果自动生效可回滚）+
    进行中状态 + 回执（应用/跳过明细）+ 整理史列表 + 资产版本历史与回滚按钮。
- **settings 工具库新 tab「知识总览」**：bot × (memory/skill 资产) 矩阵（shared/exclusive/—），
  行=bot 列=资产，格子点击跳对应 bot 知识 tab；记忆条数/上限健康度着色。
- fake-data/harness/ui-shot 同步（新 tab ×浅深 + 总览 ×浅深，基线 34→约 40）。

### 4.7 顺手修复（长期迭代授权范围内）

1. exclusive memory 蒸馏写回缺口：distill 中间件按 bot 生效绑定解析——exclusive 更新快照+重物化本 bot。
2. cost-tracker tool kind 进白名单（PATCH 不再 400）。
3. （已含）MCP list/get_assets 盲区。

## 5. 整理提示词模板（产品核心面）

```
【WAO 知识整理轮】
你是机器人 <name>（引擎 <provider>）。平台请求你整理自己的长期知识，让它更精炼、更专业。

## 你的当前知识
### 记忆（<n>/<cap> 条，资产 <name>，模式 <shared|exclusive>）
<逐条内联>
### 技能/文档
<per skill: name/description/origin/正文(≤16KB 内联, 超限给路径)>

## 整理规则
1. 记忆：合并重复、剔除已过时、压缩冗长；优先保留「操作路径」类知识（用什么工具/命令/参数做成某事）。
   绝不为整理而整理——没有改进空间就原样保留。
2. 文档：把高频操作模式升级为技能文档（新建或改进你之前创建的技能）；
   origin=operator/plugin 的技能只读，不得修改。
3. 人的引导（优先满足）：<guidance 或「无」>

## 输出协议（严格执行）
用 Write 工具把提案写到 <cwd>/.wao/curation/proposal.json（无写文件能力则把同构 JSON
放进最终回复的 ```json 围栏）：
{"memory":{"notes":[...]},            // 整理后的全量记忆（整组替换）
 "skills":[{"action":"create|update","name":"...","description":"...","body":"# md 全文"}],  // ≤3 项
 "summary":"一句话：本次整理做了什么、为什么"}
```

## 6. 提案校验（拒绝优于静默纠正）

- memory.notes：string[]，≤50 条，每条 trim 后非空且 ≤2KB；整组替换语义。
- skills：≤3 项；action∈{create,update}；name slug 化（`[a-z0-9-]{1,64}`）且不得撞 operator/plugin/mcp
  资产名；description ≤500 字；body 非空 ≤60KB（skill 既有上限）。
- update 仅限 origin==='curation' 且当前绑定本 bot；create 不得与既有 (type=skill, name) 重名。
- 单项不合法 → 跳过该项并记录 skipped 原因，其余照常应用；提案整体缺 memory 且无 skills → 视为空提案，
  记 applied=false（「没有改进空间」应输出原样 notes，而不是空提案）。
- 所有应用经 updateAssetOp / 资产创建既有校验（第二道门）。

## 7. 错误处理

- 整理轮超时/报错：guard 强制 settle → applied=false + reason 落整理史（复用 testBotOp 看门狗模式）。
- 提案缺失/JSON 非法/校验全拒：applied=false + 逐条 reason。
- 应用中途失败：逐项独立 try/catch，已成功项保留（每项本身原子：单次 updateAssetOp），
  失败项进 skipped；回执如实呈现。
- 并发：同 bot 整理互斥（内存锁）；与普通会话轮并存（整理用全新会话、知识已内联，竞面极小，
  文档如实声明）。
- 回滚目标 version 不存在 → 400 带现有版本清单。

## 8. 测试与验证（交付红线）

- 单测：bundle 聚合（shared/exclusive/快照缺失容忍）、整理提案解析（文件/围栏/双缺）、校验矩阵
  （超限/重名/越权 update/空提案）、应用（shared 扇出/exclusive 快照+snapshotHistory）、版本 cap 12 +
  回滚、distill exclusive 写回修复、cost-tracker 白名单、路由契约、MCP 四工具（含危险门禁）、
  knowledgeFace 五家存在性。
- UI：fake-data 知识面 + 组件渲染测试 + ui-shot 基线重截。
- 用户路径实测：本地起内核走完整路径（看知识 tab → 触发整理（fake runner 回提案）→ 回执 → 回滚）。
- 独立盲评：零上下文子代理按用户任务清单盲测 UI/流程，FAIL 修到清零。
- 未验证项如实申报（如真模型整理轮质量——PC1 部署后观测，不阻塞交付）。

## 8.5 实现期修正（2026-11-11 交付时）

- **整理提示词的示例不再用 ```json 围栏**（改缩进示意）+ 围栏解析器跳过含模板
  占位痕迹（`create|update`/`整理后的全量记忆条目`）的候选——防模型把提示词里的
  示例原样回显被误当提案（fakeprov 回显 prompt 的测试暴露）。
- **空提案（无 memory 无 skills 且非原样保留）→ `proposal-empty` 如实记因**，
  ok=false（不静默当成功）。
- bundle 带 `botName`（UI 弹层标题用名字不用 botId）。
- `knowledgeFace` 钩子对 cursor 明示「无资产绑定面」；claude 钩子在无 assetsRoot
  时不产 MCP 段（避免相对路径假象）。
- **代码盲审 9 项全修（3 P1）**：①整理窗口期并发写守卫——起跑记记忆版本基线，
  应用前重读，漂移（蒸馏/人工/他台整理）→ memory 项跳过并如实记因，绝不静默吞
  写入；②create 成功 bind 失败 → 补偿回收孤儿资产（按 id 定位注册表本体）；
  ③多份生效记忆绑定 → 400 拒绝（v1 单记忆口径，防提案错位替换）；④REST 回滚
  去掉 asset 404 前置（源已删除的快照回滚合法）；⑤get_asset 描述不再指向不存
  在的 knowledge 工具；⑥guidance 超 2000 字 400（拒绝优于静默截断）；⑦提案文
  件 nonce 轮次名（防超时轮晚到写的僵尸提案被下一轮应用）；⑧整理史路径加
  BOT_ID_RE 守卫（对齐 ledgerFor 先例）；⑨cwd 缺失显式 400（防 join 抛
  TypeError→500）。①②③⑤⑥⑦ 均有回归测试钉死（knowledge.test.js 34 用例）。

## 9. 非目标（v2 候选）

- 整理前后跨轮效果报表（数据已留 curation.jsonl + ledger，报表后做）。
- scope-recall L3 store 内容浏览（现未绑定生产，绑定后再做）。
- 跨 bot 记忆自动去重/共享推荐（矩阵先给人看）。
- bot 在对话中自触发整理（需 bot 持有 WAO MCP 凭证，另议安全面）。
