# 记忆层开源实现调研（适配/集成底稿）

> 2026-11-10 调研沉淀。背景：DESIGN-TOKEN-OPT P2-A 已落地 WAO 自有记忆层
> （memory 资产 notes 全量注入 + 蒸馏闭环，LRU 50×2KB）；本调研回答「什么时候
> 需要外部记忆系统、选哪个、怎么接」。排序依据=与 WAO 架构的咬合度。

## 1. 候选一览

| 项目 | ⭐ | 许可证 | 形态 | 与 WAO 的咬合点 | 短板 |
|---|---|---|---|---|---|
| **[scope-recall](https://github.com/410979729/scope-recall-hermes)** | 536 | **MIT** | pip 包；SQLite 存原文+可重建向量（LanceDB 可选）；hooks 自动召回（0-6 条，词法+相似度双门槛）+ MCP 工具；`scope-recall ui` 管理页（中英）；隐私模式/导出导入/密钥扫描 | **Claude Code 发现逻辑原生尊重 `CLAUDE_CONFIG_DIR`**——WAO per-bot 配置目录=天然 bot 级记忆隔离；写 skills+hooks+MCP 三面，与 WAO 物化管线同面；中文生态（README 双语）；MIT 无传染 | Python 运行时依赖（PC 需装 py 环境）；向量召回要配模型路由（不配=降级原文检索） |
| [remnic](https://github.com/joshuaswarren/remnic) | 232 | — | 作用域知识图+语义检索+溯源，MCP/HTTP | MCP 面可经 WAO mcp 资产直接挂 | 无 hooks 自动注入（模型须主动调工具）；体量小 |
| [mem0](https://github.com/mem0ai/mem0) | 68.7k | Apache-2.0 | 生产级记忆基建（SDK/REST/MCP），抽取需配 LLM | 生态最成熟 | 重基建：自建服务+抽取用 LLM——WAO 蒸馏已零成本覆盖抽取，mem0 的强项（抽取质量/规模）对当前量级是过度工程 |
| [basic-memory](https://github.com/basicmachines-co/basic-memory) | 4.5k | **AGPL-3.0** | Markdown 知识库+MCP | 理念与 WAO memory 资产同构 | **AGPL 传染**（引代码即传染，仅 MCP 调用无碍）；功能与 WAO 自有层重叠最大 |
| memx-memory 等长尾 | ≤17 | — | 各式（图/压缩码/日蒸馏） | — | 体量小，观望 |

## 2. Magpie 侧发现（本地实查 + 官方文档）

- 本机 `~/.config/magpie/plugins/`（工作区）与 `plugin-providers.json`（注册表）
  **只有 auth 类插件 + page-agent-office，无任何记忆插件安装**。
- Magpie 官方 reference.md：**插件=OpenCode 插件或 pi 包，无需 magpie 特殊适配**
  ——即 Magpie 的记忆生态就是 OpenCode 插件生态（先例：PowerContext 记忆插件
  专为 Magpie 而写、经网关层注入）。
- 对 WAO 的含义：网关层记忆（magpie 插件）= **provider 无关**（dsh/claude/codex/pi
  全覆盖，绕过每家 CLI 的 hook 差异），但 **bot 级隔离粗**（插件按请求特征区分，
  而非 WAO 的 per-bot config dir 硬隔离），且注入发生在请求改写层——对企微 bot
  的可见性/审计不如资产面清晰。

## 3. 与 WAO 自有记忆层的关系（互补而非替代）

WAO 现有 L2 = **全量注入**（每轮 2-4k token，50 条封顶）+ 蒸馏写回。其失效边界：

1. **条数溢出**：>50 条后 LRU 丢最旧——FAQ 累积到几百条时，全量注入既贵又稀释；
2. **相关性**：全量注入与当前问题无关的记忆也占 token；
3. **溯源**：notes 是蒸馏产物，丢了「哪轮对话得出的」原始出处。

scope-recall 恰好补这三点：**检索式注入**（只注入过门槛的相关项）+ 原文留存
（facts 可回溯/可重建）+ 管理面。WAO 蒸馏（轻、即时、零依赖）与 scope-recall
（检索、溯源、规模）是 L2 小记忆 → L3 大记忆的天然分层。

## 4. 集成路径（推荐排序）

### A. 试点（1 天级）：per-bot 直装 scope-recall
PC1 `main` bot：`CLAUDE_CONFIG_DIR=<data/claude-config/main>` 下跑
`scope-recall setup --host claude-code` → hooks/MCP/skills 全落 bot 专属目录，
与 WAO 已有物化面共存（不同文件）。不配模型路由先体验原文检索降级模式。
风险：hooks 与 rtk 的 PreToolUse 共存（不同 matcher/事件，理论无冲突，实测确认）。

### B. 产品化（迭代级）：WAO 工具资产新 kind `scope-recall`
复用 rtk 的状态机模式（§7.1）：`content: {kind:'scope-recall'}` → 物化器执行
`scope-recall setup`（探针二进制→setup→回读 hooks 断言），卸载走其
plan-uninstall/apply-uninstall 收据流；装备态进 manifest.tools + doctor。
装备包（P1-B）在记忆条数达阈值时推荐此升级。

### C. 网关层（远期，观察 PowerContext 演化）
Magpie 插件面：全 provider 覆盖 + 零 CLI 差异，代价是 bot 隔离粗、注入不可见。
等 WAO 出现「非 claude 系 bot 也强烈要记忆」的需求再启动。

### 不推荐
- **mem0**：抽取已自有，基建过重；
- **basic-memory**：AGPL + 与自有层功能重叠。

## 5. 待验证项（试点 A 的检查单）
- [ ] `claude -p`（print 模式）下 hooks 自动召回是否触发（WAO bot 全是 -p 驱动）
- [ ] 与 rtk hook 的共存（同 settings.json PreToolUse 数组）
- [ ] Win 免管理员安装（PC1 无 py：先装用户级 Python？scope-recall 的 host-local venv 首选项）
- [ ] 蒸馏（WAO distill）与 scope-recall 抽取（后台 worker）双写的口径协调——试点期先关 WAO 蒸馏或关 scope-recall 模型路由，避免两套记忆
