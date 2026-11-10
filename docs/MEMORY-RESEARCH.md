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

## 5. 待验证项 → 实证结论（2026-11-10 Phase 0/B 产品化实测，macOS arm64）

> 实测环境：uv 0.6.8、claude 2.1.318、rtk 1.2.0、hermes-scope-recall 4.0.3；
> scratch `/private/tmp/wao-scope-recall-p0*`（注意：**必须用 realpath**——scope-recall
> 拒绝符号链接路径，`/tmp` 在 macOS 是 symlink，报
> `symlink or reparse paths are not allowed: /tmp`）。**PyPI 包名是
> `hermes-scope-recall`**（`scope-recall` 名不在 PyPI——`uv tool install
> scope-recall` 报 not found；GitHub README 2026-11 版已改用此名，仓库 checkout
> 4.0.3）。需 Python ≥3.11，uv 自动落托管 Python（本机 cpython-3.12.9）。

- [x] **`claude -p`（print 模式）下 hooks 自动召回触发——PASS**。
  `CLAUDE_CONFIG_DIR=<scratch> scope-recall setup --host claude-code --yes`
  （或 `--home <dir>` 显式）后跑 `claude -p '回复ok' --output-format stream-json`：
  共享库 `~/.scope-recall/shared/memory.sqlite3` 的 `session_brief_sessions` 出现
  该会话行（started=1，recall_elapsed_ms=166），`source_events` 记下 user/assistant/
  session_end 全周期三条——SessionStart 召回 + UserPromptSubmit/Stop/SessionEnd 捕获
  四类 hook 在 print 模式全触发，无需任何交互批准（-p 非交互面直接生效）。
  发现：setup 不写 settings.json——hooks/MCP/skill 三面全在
  `<configDir>/skills/scope-recall/` 的 **claude-code 插件 bundle** 里
  （`.claude-plugin/plugin.json` + `hooks/hooks.json` + `.mcp.json` + SKILL.md），
  claude 经 `CLAUDE_CONFIG_DIR/skills/` 原生发现插件。
- [x] **与 rtk hook 共存——PASS（零冲突）**。同一 config dir 再 `rtk init -g
  --auto-patch --no-trust-filters`：rtk 产物=RTK.md + CLAUDE.md `@RTK.md` 行 +
  `settings.json` 的 PreToolUse 条目；scope-recall 的 hooks 在自己的插件
  hooks.json——**不同文件、不同事件**（rtk=PreToolUse，scope-recall=
  SessionStart/UserPromptSubmit/Stop/SessionEnd）。装两件后再跑一次 claude -p：
  第二会话照常全周期捕获、settings.json 的 rtk 条目原样。
- [ ] **Win 免管理员安装——设计通 + 供给面就位，真机未验证**（Windows 面
  未验证项：uv-windows zip 一键装 → 绑定 scope-recall → WAO 自动
  `uv tool install hermes-scope-recall`（uv 自带托管 Python≥3.11）→ setup
  `--host claude-code` → hooks 在 Win 的 `claude -p` 触发。uv 0.6.8 win zip
  SHA256 已实下载钉死进 src/tools-spec.js；PC1/PC2 下次上真机补验）。
- [x] **双写口径协调——v1 决策：WAO 蒸馏（L2）保持开 + scope-recall 不配模型
  路由（原文检索降级模式）**。实证：4.0.3 setup 默认零模型路由（plan-json
  `existing_models: {embedding:false, extraction:false, budget:全 0}`，README
  「Without model routes or budget, setup reports 原文检索可用」）——不配路由=
  scope-recall 的后台抽取/嵌入 worker 不启动，与 WAO distill 无双写；召回走
  词法检索。要完整记忆功能需 `--configure-models`（交互）或 `--models <json>`
  （模型键=环境变量引用），**未证明能干净指向 magpie 网关**（127.0.0.1:3425 是
  Anthropic 形态端点，其路由 schema 是自有 JSON），v1 不做 options 可选项，
  留待需要向量召回时再试。

### 5.1 B 产品化落地形状（对应 §4 路径 B，2026-11-10 实装）

- 工具资产 kind `scope-recall`（白名单第三员，seed 内置、**不进向导默认
  装备包**——记忆规模驱动的升级项）；绑定面 v1 仅 claude+claudeConfigDir
  （codex/pi/dsh 拒，dsh 独立文案）。
- 物化器 `scope-recall-init` 状态机（学 rtk 三态）：probe（`--help` 探测——
  真 CLI **无 --version 旗标**；候选=PATH → `~/.local/bin/scope-recall`）→
  缺 CLI 但有 uv 则自动 `uv tool install hermes-scope-recall==4.0.3`（钉版，
  盲评 P1-2——latest 浮动=今天验证过的形状明天悄悄变）→
  `setup --host claude-code --home <cfgDir> --store <cfgDir>/scope-recall-store
  --yes`（**store 必须显式指 per-bot 目录**——默认 `~/.scope-recall/shared`
  是全局共享域，违反 bot 隔离）→ 回读断言（`.scope-recall-install-receipt.json`
  + `skills/scope-recall/hooks/hooks.json`）→ armed 态记 manifest.tools。
- 卸载（盲评 2026-11-10 后口径，**收据属主判据**）：清扫前过三重门——清单行
  path 须非空绝对路径（''/相对路径=以服务进程 CWD 为基准的越狱删，拒绝告警）；
  `.scope-recall-install-receipt.json` 在位=属主凭证（unavailable 必然无收据；
  收据被删=缺证不删）；行态 unavailable 不扫（零产物承诺——试点期操作者手工
  预装的同名 `skills/scope-recall/`/记忆库绝不能被按名盲删）。过门后
  `apply-uninstall --instance-root <cfgDir>`（删插件四件套、retain_memory）+
  WAO 清扫残片（收据/`scope-recall/` 目录/attachment lock/per-bot store——bot
  卸载即记忆随走），清扫目标再过 §8.3 jail；setup 失败路径也在 manifest 补记
  state:'failed' 行——首败半装残片（收据在位时）解绑可回收。
- uv 进 `/api/service/tools` 供给面（win zip/darwin+linux brew，钉版 SHA256），
  `wao doctor` 自动带 `tool uv` 行；scope-recall 本体不进供给面（materializer
  首次装备时装，钉版 spec，幂等）。
