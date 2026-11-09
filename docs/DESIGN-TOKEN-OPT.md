# Token 优化：实测、已落地与产品化路线

> 2026-11-09 晚 PC1（提单测试电脑1）生产 bot「运价的 Sky」(main) 全链路实测沉淀。
> 数据源：`GET /api/ledger?bot=main`（企微真实轮次）+ 会话文件逐轮 token 记账。
> 本文是运营侧已落地动作的存档 + 产品化缺口的设计底稿；排期见 ROADMAP。

## 1. 实测问题（优化前）

10 轮真实对话共 **562,715 tokens**。三类浪费：

| 模式 | 实例 | 成本 | 根因 |
|---|---|---|---|
| 会话重放 | 用户发"hi"（20:17） | **75,971 tok**，其中 ~62k 是 `--resume` 重放全部历史 | claude CLI 每轮把整段会话树作为输入重放；闲聊也照付 |
| 工具输出未剪 + 盲扫 | "亏舱费怎么维护的"（20:54） | **280,825 tok**，35 次工具调用 | 无检索指引，逐目录 ls/cat 扫 979MB 仓库；无输出过滤 hook |
| 每新会话基线 | 任意新话题 | ~13.8k tok | 人设+资产+系统提示的固定开销（合理下限） |

## 2. 已落地（运营侧，2026-11-09）

| 动作 | 实现 | 验证 |
|---|---|---|
| rtk hook 装备 | 资产 `rtk`(tool) 绑定 main；manifest `state:armed, mode:wao-hook`；`settings.json` 注入 `PreToolUse(Bash)→rtk hook claude` | 绑定回执+manifest+settings 三面核对；W3-T3 基线 -18%/轮 |
| ripgrep 检索指引 | 资产 `ripgrep`(tool, extraHints=fms 定制) 绑定 main；manifest `state:available 15.2.0` | 测试轮「亏舱费相关文件」1:33 完成，deadFreight 语义映射直定位 4 模块（对比此前 35 次盲扫） |
| 人设精简+效率约定 | PATCH prompt：删无机制的「沉淀F&Q文档」空指令；加「闲聊直接答/检索从窄到宽命中即停/回复只给结论」 | 测试轮"hi" 6.1s，回复符合新人设 |
| 会话树隔离 | 新增 `claudeConfigDir=C:\Users\1data\wao\data\claude-config\main`（settings/.claude.json 拷贝保留 magpie 网关路由） | 重定向后 `claude -p` 回 REDIRECT-OK；三个测试会话 .jsonl 全落新目录 |
| 二进制供给 | rtk 1.2.0 + rg 15.2.0 装至 `%USERPROFILE%\tools`，SHA256 校验，用户级 PATH 持久化 | 哈希机器内比对 HASH-OK；双版本回显 |

附带修复：PC1 `data\win-autostart.cmd` 参数漂移（启用自启早于开 `--lan`，重启会丢
LAN 模式）——已手工补参，并落地代码修复（`planAutostartRefresh`：每次 start 用当前
参数重写启动器；`test/ops/autostart-win.test.js` +5 用例，689/689 绿）。

## 3. 产品化缺口（每个新用户都会遇到）

### P1-A 工具装备一键供给

现状痛点：rtk/rg 二进制缺失时绑定虽成功但 `unavailable`（指引装上即生效）——
但「装上」这一步今天花了 40 分钟人工（GitHub 慢→截断 zip→LAN 镜像重下→PATH→
重启服务刷新进程环境）。每个 Windows/新机器用户都会撞同一堵墙。

设计要点（`GET/POST /api/service/tools` + 设置页「工具装备」卡）：
- doctor/设置页聚合展示 rtk/rg 装备态（数据源=manifest.tools，已存在）
- 一键安装：下载（GitHub releases 直连 + `WAO_DOWNLOAD_MIRROR` 回退，复用
  win-install.ps1 的 -Mirror 模式）→ 落 `%USERPROFILE%\tools\<name>\` →
  SHA256 校验 → 用户级 PATH（注册表，拒绝 setx 截断）→ 提示重启服务
- 版本登记 `data/tools.json`（已装版本/来源/时间），doctor 漂移检查
- **重启服务刷新 PATH 的动作产品化**：安装完成后一键「重启服务」（复用
  updater 的重启通道，前端 healthz 轮询自动刷新——与一键升级同款 UX）

### P1-B 省 token 装备包默认推荐

- bot 创建向导（简版/完整版）加「省 token 装备包」勾选项（**默认勾选**）：
  绑 rtk + ripgrep 两资产；claude bot 顺带建议配专属 `claudeConfigDir`
- 资产库预置这两条 operator 资产（首次启动 seed，而非依赖手工 MCP 创建）

### P2-A 会话策略与记忆层（FAQ 沉淀的机制化）

见 §4 设计。

### P2-B 测试路径可观测

`POST /api/bots/:id/test` 探针轮不落台账、不过 cost-tracker 中间件——优化
前后对比只能等真实生产消息。建议：test 轮也走 `middleware.onOutbound`
（或响应体带 usage），让「优化验证」不必等生产流量。

## 4. 会话策略 + 记忆层设计（P2-A）

### 4.1 核心判断：不做「闲聊 vs 新话题」分类器

分类问题在结构上消解：**需要判定的不是「这是什么话」，而是「是否延续当前活跃
会话」**。闲聊天然落到「新会话 + 记忆」路径，成本=基线 13.8k + 记忆注入 2-4k，
无人需要识别它是闲聊。新话题同理。只有「延续」需要判定——而它主要靠时间窗。

### 4.2 三层记忆模型

| 层 | 载体 | 生命周期 | 成本 |
|---|---|---|---|
| L1 活跃会话 | claude `--resume`（现状） | **时间窗内**（默认 45 分钟无活动即退役；显式信号如「继续」可续） | 窗内多轮共享上下文，越窗不再重放 |
| L2 记忆资产 | `memory` 类型资产（资产系统已有该类型！物化为 CLAUDE.md 标记节，随 claudeConfigDir 隔离） | 持久，**容量上限 ~2-4k tok**，LRU 淘汰 | 每轮注入；比 62k 重放便宜一个数量级——「每次都加载记忆」正是正确方向 |
| L3 归档检索（远期） | 台账/归档文件 | 满容量后挤出 L2 | 按需检索，不在本迭代 |

### 4.3 FAQ 沉淀 = 轮后蒸馏（复用现有中间件管线）

人设里「沉淀成 F&Q 文档」之所以是空话，因为没有写回机制。机制化：
- 引擎侧新增 post-turn 钩子（复用 cost-tracker 已验证的
  `middleware.onOutbound(text,{bot,usage,...})` 管线）：轮次完成后，
  由本轮模型顺带产出蒸馏增量（prompt 约定在记忆资产注入段里：值得沉淀的
  「问题→结论」对以固定标记输出），或退化为独立便宜调用（仅歧义时）
- 增量 append 进 memory 资产内容 → 触发重物化（资产热更管线已存在）
- 去重/LRU/容量守恒在引擎侧做，模型只管产出增量
- MCP/控制台补 `get_memory`/`prune_memory` 运维工具，设置页展示记忆条目

### 4.4 会话路由规则（v1 零额外 LLM 调用）

```
新消息到达:
  ├─ 活跃会话存在 且 距上轮 < TTL(45min)  → --resume 延续（现状路径）
  ├─ 活跃会话存在 但已越窗                 → 退役；开新会话 + 注入 L2 记忆
  └─ 无活跃会话                            → 开新会话 + 注入 L2 记忆
```
- TTL per-bot 可配（`providerConfig.sessionTtlMin`，默认 45）
- v2 增强（可选）：窗内但话题明显切换的判定，交给一次便宜调用（~1k tok），
  仅在「窗内首条且与上一轮问题域无关」的启发式命中时触发
- 退役会话文件不删（L3 归档候选），只不再 `--resume`

### 4.5 预期账面

| 场景 | 优化前 | 优化后 |
|---|---|---|
| 闲聊"hi"（有历史时） | 76k | ~16k（基线+记忆注入） |
| 新话题提问 | 62k 重放起步 | ~16k 起步 |
| 重检索型问题 | 280k | rtk+rg 指引已落地；叠加会话不跨话题重放，多轮追问不再累计旧工具输出 |
| 真多轮任务 | 合理重放（L1 窗内） | 不变（这正是 --resume 该付的钱） |
