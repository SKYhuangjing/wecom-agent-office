# WAO 资产系统设计规格（v2 · W3）

> 日期：2026-11-07 ｜ 状态：rev.2——两路评审 NEEDS-REVISION，控制者逐条裁定已并入（§0 变更记录）｜ 上游：docs/DESIGN.md v3（存量权威）+ docs/superpowers/plans/2026-11-07-wao-v2.md §W3
> 一句话：**平台侧统一登记五类资产（技能/记忆/MCP/提示词/工具），按绑定物化为四家 provider 的原生格式——标记节/专属目录/运行旗标——共享同源、独享快照，热更下轮生效。**

---

## 0. 目标与非目标

### 变更记录

**rev.2（2026-11-07）**：两路设计评审均 NEEDS-REVISION，控制者逐条裁定后并入——P0 四条 + P1 十条：

| # | 裁定 | 落点 |
|---|---|---|
| P0-1 | 资产内容 PATCH→重物化后**轻量重 attach**（定义=仅换 runners 表项，不动 adapter/channel；在跑 run 持旧 runner 跑完，下轮生效）；plan 可变引用纪律+契约用例 | §3.1 / §3.2 / §10 |
| P0-2 | 孤儿标记检测（单侧标记、标记对外 `wao-` 残留→先清孤儿再重建）；「半删标记」TOML fixture 必测 | §3.4 / §10 |
| P0-3 | MCP 写面分级（createAsset 仅 exclusive；shared 资产 update/delete 经 MCP 禁=只读+unbind；bind/unbind/rematerialize 危险级带后果确认文案）；§8.4 信任模型如实改写（原「运营者录入」声明被 MCP 写面推翻） | §8.1 / §8.4 / §2.3 |
| P0-4 | dsh personaPrefix **单一组合器**（providerConfig.prompt+plan，绑定序）；materializeConfig 与 materializeAssets 同过组合器；契约用例「dsh 改模型→资产节仍在」 | §3.3 / §10 |
| P1-5 | 密钥三态（明文/`${VAR}`·env_vars 引用=V8 待验证/落盘 0600）；回显掩码**按位置**（env/headers 全值，`__MASKED__` 同位置保库值）；URL 拒 `user:pass@` | §4.2 / §8.1 / §9 |
| P1-6 | serverId/skill 名 slug 统一 `^[a-z0-9][a-z0-9-]{0,63}$`（禁 `.`）；跨 bot 同 cwd 同文件→绑定校验拒绑指名文案 | §4.0 / §2.3 / §11 |
| P1-7 | 扇出 per-bot 隔离：回执 `{rematerialized[], failed[]}`+失败进 agents 健康标注；与 bot PATCH last-good 差异对比表 | §3.2 |
| P1-8 | `POST /api/bots/:id/rematerialize-assets`（确定性→安全自动修复）+doctor 漂移检查+companyOps rematerialize 工具（危险级） | §8.1 |
| P1-9 | rtk JSON hooks：清单记条目全文，卸载=精确匹配删（不匹配告警不删）；§3.6 补 JSON 条目型 | §3.6 / §7.1 |
| P1-10 | V2 扩 skills+AGENTS.md 重定向，回退 `<cwd>/AGENTS.md` | §9 / §3.3 |
| P1-11 | V 项（V9）：pi 读带未知顶层键 mcp.json 的容忍度；不容忍→外来判据改物化清单 | §9 / §3.3 |
| P1-12 | claude/pi serverId 统一 `wao-` 前缀；V7=同名让位方向实证 | §3.3 / §9 |
| P1-13 | skill 物化外来守卫：目标存在无 `x-wao-asset` 注记→拒绑 400 指名路径 | §2.3 / §3.6 |
| P1-14 | P2 包：manifest 持久化 `data/assets/<botId>/manifest.json`；agents 加 `lastMaterializedAt`/`lastResult`；UI 词表定死「配发/私发」（API 映射行）；memory 同 cwd 绑定告警；bot prompt 在前资产在后；`GET /api/assets/:id`；§7.1 注记弃 PATH-shim；sse/ws 拒绝文案「v1 仅 stdio/http」；标记 `:v1` 版本段；§12 补 eager 成立依据 | §3.8 / §8.1 / §6 / §7.1 / §7.3 / §3.3 / §3.4 / §4.2 / §12 |

**rev.2 实现勘误（2026-11-07，W3 T1 评审落地）**：§8.1 绑定面按 T1 实现形状改专用端点 `POST/DELETE /api/bots/:id/assets`（bot POST/PATCH 直写 `assets` 拒绝），行序调和为「校验→绑定落库→物化（失败不回滚）→仅成功轻量重 attach」；五类 content 未知键拒绝（closed schema，mcp server 亦按形态闭键）；agents 名册面回显 `assetWarnings`（memory 共享 cwd 警示，判定源同 §7.3 memoryWarning）。

**T2 实现勘误（2026-11-07，W3 T2 落地）**：§3.1 端口形状按实现细化为**纯计划者**——`materializeAssets(bot, plan, {log, dryRun, assetsDir})` 返回写计划（`file-create | marker-section | hook-entry | argv` 四型，含 `for`/`appliesTo` 归属标记），**不落盘**；一切盘面纪律（§8.3 越狱防护、§3.4 标记节手术、§3.7 原子/回滚、§3.8 manifest、§3.6 卸载）收敛到 core-engine 的 materializer.js 单点，provider 只做格式翻译（dsh patch.yml 例外说明：组合器仍走 profiles.js 的纯构建 `buildBotPatch`，profile 引导留在 materializeConfig）。§3.1 的 `removeAssets` 端口钩子随之上收到 core（manifest 驱动精确清理）；`createRunner` 的 `assets` 计划由 core 以 manifest 富集文件目标（`--mcp-config`/`--skill`/记忆文件路径）后传入。**V 项实证结论（§9 记录）已按冻结点落地**：claude mcp `${VAR}` 引用态经 V8 实证 spawn 期展开（缺变量=字面量透传）→ 引用串原样落 claude-mcp.json；codex 引用态=env_vars 转发（V8 实证从 codex 自身环境转发）；pi `x-wao-managed` 注记经 V9 实证可落文件（pi 容忍且自身重写保留，manifest 回退判据不需要）；claude `--mcp-config` 经 V7 实证覆盖用户 scope 同名（旗标即权威面），且该旗标为 variadic——runner argv 中置末位。

**T3 实现勘误（2026-11-07，W3 T3 落地）**：写计划扩第五型 `rtk-init`（`{target:<config dir>, flavor}`）+ 计划返回值新增 `tools` 行（§7.2 ripgrep 预检结论；rtk 态由执行器补记）——外部命令执行（dry-run 前缀校验/真跑/回读断言/卸载）全部收敛在 materializer.js（§8.3「rtk 物化的外部命令写盘」单点纪律），providers 仍纯计划。manifest 新增 `tools` 数组（§7.1 三态 + §7.2 预检）；绑定/解绑/rematerialize 回执新增 `notes`（装备注记随回执出）；agents `assetWarnings` 扩 `toolWarnings` 面（rtk/rg 缺失常驻警示）。装备面形状修正：codex hook 面=**hooks.json**（独立文件，非 config.toml）；pi 面=extensions/rtk.ts（版本耦合，回退路径对 pi 不可用=failed）。rtk 装备用 `rtkBin` 可注入（plugins.json `core-engine.options.rtkBin` / `$WAO_RTK_BIN`，测试指向 fake，运维可钉绝对路径）。

### 目标（W3）

1. **五类资产**：`skill | memory | mcp | prompt | tool`，统一注册表 `data/assets.json`，统一绑定模型（bot × 资产 × 共享/独享）。
2. **四家物化**：dsh / claude / codex / pi 各自落到**原生消费面**（SKILL.md、AGENTS.md/CLAUDE.md、mcp.json/config.toml、profile system-prompt、运行旗标），不发明私有装载器。
3. **共享/独享语义**：shared=同源引用（资产更新全量重物化）；exclusive=绑定时刻内容快照（更新不跟随，UI 标识）。
4. **热更**：绑定/资产变化→重物化→**下轮 run 生效**，无需重启服务、无需重建 channel 适配器。
5. **工具资产**：RTK（token 瘦身 hook）与 ripgrep（代码检索指引）两类白名单工具，带装备状态机。
6. **安全红线**：内容静态校验 + 写入目标越狱防护（bot 声明目录白名单下的既定子路径）+ mcp 密钥剥敏回显。

### 非目标（W3 明确不做）

- 资产市场/远程分发（本地注册表，与插件体系同哲学）
- SKILL.md 之外的 skill 附属文件（scripts/、references/）——v1 只做 instruction-only skill（codex 官方亦建议 "Prefer instructions over scripts"）；`content.scripts` 留 schema 扩展位
- 修改 provider 自身凭据/模型路由（资产只叠加，不碰 providerConfig 既有字段）
- claude/codex/pi 自带的会话内 auto-memory 托管（边界见 §7）
- tree-sitter 语义检索 MCP（二期，ripgrep 资产内预留指引段占位）

---

## 1. 实测事实（2026-11-07 本机探查，全部真跑）

> 探查环境：macOS arm64；`codex-cli 0.166.0`（/opt/homebrew/bin/codex）、`claude 2.1.318`（~/.local/bin/claude）、
> `dsh 0.2.1-rc.5`、`pi`（@earendil-works/pi-coding-agent）、`rg 15.2.0`（/opt/homebrew/bin/rg）。
> 未装：`rtk`（`which rtk` → not found）。

### 1.1 codex 0.166 技能（结论：原生支持，无需回退）

| # | 事实 | 证据 |
|---|---|---|
| F1 | `~/.codex/skills/` 存在且已装 11 个技能（alibaba-sls-query、docx、pdf…），每技能一目录 + `SKILL.md` | `ls ~/.codex/skills` 实测 |
| F2 | `~/.codex/config.toml` 有 `[[skills.config]]` 条目：`path = "…/SKILL.md"`（或 `name = "…"`）+ `enabled = false`——按路径/名字停用技能的官方机制（不删除文件） | `cat ~/.codex/config.toml` 实测；官方文档同款示例 |
| F3 | 官方文档技能发现范围：REPO=`$CWD/.agents/skills`（含父目录至 repo root）、USER=`$HOME/.agents/skills`、ADMIN=`/etc/codex/skills`、SYSTEM=内置；同名技能不合并、都出现 | developers.openai.com/codex/skills |
| F4 | SKILL.md 格式：YAML frontmatter `name` + `description` **必填**，正文 Markdown；技能列表占上下文预算（2% 或 8000 字符），选中才读全文 | 同上 + 本机 `~/.agents/skills/pm-output/SKILL.md` frontmatter 实样 |
| F5 | 技能相关特性旗标：`skill_search`=stable/true、`skill_mcp_dependency_install`=stable/true、`skip_host_skill_discovery`=under-development/false | `codex features list` 实测 |
| F6 | 本机 `~/.agents/skills` 是指向 oneaix-skill-hub 的**符号链接**，codex 支持跟随 symlink 扫描 | `ls -ld` 实测 + 文档明示 |

> 本机证据表明 `~/.codex/skills`（=CODEX_HOME 下）也是被发现面（大量 skills.config 条目指向其内文件）；
> 但 **CODEX_HOME 重定向后是否仍扫描 `<CODEX_HOME>/skills` 未验证**——列为 T2 首步验证项（§9），回退路径=`$CWD/.agents/skills`（文档保证）。

### 1.2 codex MCP（config.toml 形状）

| # | 事实 | 证据 |
|---|---|---|
| F7 | `codex mcp add <name> [--env K=V] -- <cmd…>`（stdio）/ `--url <URL>`（streamable HTTP）/ `--bearer-token-env-var`；`codex mcp list/get/remove` 管理子命令 | `codex mcp --help` 实测 |
| F8 | config.toml 条目形状（本机实样）：`[mcp_servers.<name>]` → `command`（必填，stdio）/ `args`（数组）/ `env`（子表 `[mcp_servers.X.env]`，字符串值）/ `env_vars`（转发白名单）/ `cwd` / `startup_timeout_sec` / `tool_timeout_sec` / `enabled`；HTTP 型：`url` / `bearer_token_env_var` / `http_headers` / `env_http_headers` | `grep -n mcp_servers ~/.codex/config.toml` 实样（node_repl/alibabacloud-sls 等 5 个真实条目）+ 官方 MCP 文档 |
| F9 | MCP 配置默认读 `~/.codex/config.toml`，也支持**项目级** `.codex/config.toml`（仅 trusted projects） | 官方 MCP 文档 |
| F10 | `~/.codex/AGENTS.md` 存在——codex 全局指令文件挂 CODEX_HOME | `ls ~/.codex/AGENTS.md` 实测 |

### 1.3 claude 2.1.318 面

| # | 事实 | 证据 |
|---|---|---|
| F11 | `--append-system-prompt <prompt>`（字符串，追加默认系统提示词）；`--system-prompt`（整体替换）；`--system-prompt-snapshot on|off`（首问快照防 resume 漂移） | `claude --help` 实测 |
| F12 | `--mcp-config <configs...>`：**JSON 文件或内联 JSON 字符串，空格分隔可多个**；`--strict-mcp-config` 只用传入的 server 忽略其余来源 | `claude --help` 实测 |
| F13 | mcp-config JSON 形状：`{"mcpServers":{"<name>":{"command","args","env","timeout"} | {"type":"http"|"sse"|"ws","url","headers"}}}`；**`url` 而无 `type` = 配置错误**（该 server 被跳过并在 system/init 的 `mcp_server_errors` 报告）；`command/args/env/url/headers` 支持 `${VAR}` 展开；**多文件冲突合并语义官方未记载**（仅 scope 优先级 local>project>user>plugin，无字段级合并） | code.claude.com/docs/en/mcp |
| F14 | 技能位置：个人 `~/.claude/skills/<name>/SKILL.md`、项目 `.claude/skills/<name>/SKILL.md`（可提交 repo）、嵌套子目录、`--add-dir` 目录、插件；旧 `.claude/commands/*.md` 已并入技能体系；frontmatter `name/description/when_to_use/allowed-tools/…`（description 与 when_to_use 合计超 1536 字符截断）；正文仅被调用时载入 | code.claude.com/docs/en/skills |
| F15 | 本机 `~/.claude/`：settings.json（keys 仅 env/model/modelPicker/theme）、projects/、plugins/；**无 skills/commands/agents 目录**（未用过则不建） | `ls ~/.claude` 实测 |
| F16 | `CLAUDE_CONFIG_DIR`：WAO provider-claude 已在生产用它重定向会话树（`$CLAUDE_CONFIG_DIR/projects/…`，DESIGN §5.1）；技能/CLAUDE.md 是否随其重定向**文档未明说**——T2 验证项（§9） | docs 无记载 + 现有代码行为 |
| F17 | `--bare` 佐证装载面清单：hooks、auto-memory、CLAUDE.md 自动发现、skills（`/skill-name`）、MCP、settings、agents、plugins 均为独立可关装载源 | `claude --help` 实测 |
| F18 | auto-memory 按 cwd 共享：`~/.claude/projects/<cwd>/memory/`——同 cwd 多 bot 互漏（DESIGN §5.1 已记录的教训） | DESIGN §5.1 风险注记 |

### 1.4 pi 1.5.0 面

| # | 事实 | 证据 |
|---|---|---|
| F19 | `--skill <path>`：加载技能文件或目录，**可重复**；`--no-skills` 关闭发现；`--append-system-prompt <text>`：追加**文本或文件内容**，可重复；`--no-context-files` = 关闭 **AGENTS.md 与 CLAUDE.md** 的 cwd 发现装载 | `pi --help` 实测 |
| F20 | `pi mcp add/remove/list [--json]`；读全局 `~/.pi/agent/mcp.json` 与项目 `.pi/mcp.json`（trusted）；add 支持 `--env`/`--cwd`（stdio）与 `--url`/`--header`/`--bearer-token-env-var`（HTTP） | `pi mcp --help` 实测 |
| F21 | **实跑验证**：`PI_CODING_AGENT_DIR=/tmp/x pi mcp add probe-server --env FOO=bar -- /bin/echo hi` → 写 `<agentDir>/mcp.json`，形状 `{"mcpServers":{"probe-server":{"command":"/bin/echo","args":["hi"],"env":{"FOO":"bar"}}}}`——agent 目录重定向对 MCP 配置生效 | 本机探针（§1.0） |
| F22 | WAO provider-pi 已物化 `<piAgentDir>/models.json`（`waoManaged:true` 标记 + 外来文件拒写守卫 + `$ENV` 凭证引用）；默认目录 `~/.pi/agent-wao-<botId>` 为 WAO 命名空间 | plugins/provider-pi/models.js 现行代码 |

### 1.5 dsh 0.2.1-rc.5 面

| # | 事实 | 证据 |
|---|---|---|
| F23 | 无技能/MCP 概念（help 无相关项；**W3 T6 勘误**：MCP 面存在于 profile 行——`@deepseek-ai/dsh-mcp-client`，见 §3.3 dsh 列，原「无 MCP 面」为保守裁定）；配置=profile 的 config 行表（`cordis.patch.yml`），**行 REPLACE 语义（整块替换不深合并）**；`system-prompt` 行 `personaPrefix`（块标量）=提示词注入口；`DSH_HOME` 可重定向 | `dsh --help` 实测 + plugins/provider-dsh/profiles.js 现行代码 + 已装 `@deepseek-ai/dsh-mcp-client` README/lib（2026-11-07） |
| F24 | 物化纪律（现行生产代码）：整串 patch 内存构建→单次 tmp+rename 原子写；removeProfile=删整个 profile 目录 | profiles.js |

### 1.6 rtk 与 ripgrep

| # | 事实 | 证据 |
|---|---|---|
| F25 | **T3 已装**：rtk 1.1.0（aarch64-apple-darwin tar.gz，checksum 校验后 `install -m 0755` 到 `~/.local/bin/rtk`，用户级不动系统；npm 上的 `rtk` 是同名发布工具，无关） | `which rtk`→`~/.local/bin/rtk`、`rtk --version`→`rtk 1.1.0`（2026-11-07） |
| F26 | 目标工具=rtk-ai/rtk（Rust Token Killer）：单一 Rust 二进制（brew install rtk / GitHub releases / install.sh）；`rtk init -g` 装 Claude Code **PreToolUse hook**（仅拦 Bash 工具调用，把 `git status` 改写为 `rtk git status` 过滤输出）；`rtk init`（无 -g）=项目级**仅写 CLAUDE.md 指引不装 hook**；`rtk init -g --codex` / `--agent pi` / `--gemini` / `--agent cursor` 等 flavor；`--dry-run` 打印将写文件不动盘（**1.1.0 无 `-v`/`--verbose`**，README 旧文）；`--uninstall` flavor 存在；`rtk gain` 看节省。**1.1.0 实测补充**：claude 免交互=`--auto-patch --no-trust-filters`（裸跑会 prompt settings.json 补丁）；`--codex` 与 `--auto-patch`/`--no-patch` **互斥**（codex/pi flavor 关闭 stdin 即免交互）；install/uninstall 都会留 `<被改文件>.bak` 残片；自有配置域在 macOS=`~/Library/Application Support/rtk/`（filters.toml 模板 + history.db），Linux=`~/.config/rtk/` | github.com/rtk-ai/rtk README + rtk-ai.app/docs + 本机 1.1.0 全程实测（2026-11-07，探针 /tmp/wao-t3-v5*） |
| F27 | **已验证（V5，2026-11-07）**：`rtk init -g` **尊重** `CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`PI_CODING_AGENT_DIR` 重定向——三 flavor 的 bot 面产物全落重定向目录（见 §7.1 形状表）；**dsh 不在 rtk 支持列表**（agent 枚举：claude/cursor/trae/windsurf/cline/kilocode/antigravity/kimi/**pi**/hermes/droid/vibe/omp） | `rtk init --help` agent 枚举 + 三 flavor dry-run/真跑实测（2026-11-07） |
| F28 | `rg` 已装：ripgrep 15.2.0，/opt/homebrew/bin/rg | `rg --version` 实测 |

### 1.7 core-engine 现状（物化管线挂点）

| # | 事实 | 证据 |
|---|---|---|
| F29 | provider 端口现行签名 `{configSchema, validate, materializeConfig, removeConfig, createRunner, readHistory, describeError}`；materializeConfig 钩子由 `POST/PATCH /api/bots` 经 `materialize()` 调用，throw→400 | DESIGN §2.2 + core-engine/api.js:178 |
| F30 | `makeRunner` 在 bot attach 时调用 `port.createRunner({bot, providerConfig, log})`；PATCH bot 走 校验→materialize→drain→重连（重建 adapter+runner） | core-engine/plugin.js:126-165 |
| F31 | 剥敏现行：`MASKED_ECHO='__MASKED__'` + `SENSITIVE_KEY` + `mergePreserving`（PATCH 回传掩码值=保留库中原值）；companyOps 服务把同一组函数供 mcp-gateway 复用（REST 与 MCP 不漂移） | core-engine/api.js:46-160 |
| F32 | bots.json=数组 `{id,name,enabled,channel,account,allowedUsers,provider,providerConfig}`；数据纪律：原子写、data/ 0600、flock | data/bots.json 实样 + DESIGN §3 |

---

## 2. 资产模型

### 2.1 注册表 `data/assets.json`（core-engine 所有，纪律同 bots.json：原子写/0600/flock）

```jsonc
{
  "assets": [
    {
      "id": "ast-7f3k",            // 前缀+短随机，创建时生成，不可变
      "type": "skill",             // skill | memory | mcp | prompt | tool
      "name": "wao-company",       // 类型内唯一，slug（§5 校验）
      "description": "公司操作技能", // 可选，≤200 字，UI/索引用
      "content": { … },            // 按 type 的 schema（§4）
      "version": 3,                // 每 PATCH 自增 1，独享快照的时点锚
      "createdAt": 1762500000000,
      "updatedAt": 1762500000000
    }
  ]
}
```

### 2.2 绑定（bots.json 记录扩展，additive）

```jsonc
{
  "id": "main", "provider": "claude", …,
  "assets": [                       // 可选数组；顺序=生效顺序（prompt/memory 拼接序）
    { "assetId": "ast-7f3k", "mode": "shared" },
    { "assetId": "ast-9q2m", "mode": "exclusive",
      "snapshot": { … },            // exclusive 绑定时整份 content 快照（§6）
      "snapshotVersion": 3, "snapshotAt": 1762500000000 }
  ]
}
```

- 校验链：`validateBot` 扩展 assets 段（assetId 存在、type 与 provider 能力匹配 §3.3、冲突矩阵 §2.3 通过）。
- `GET /api/bots` 回显绑定摘要 `[{assetId, name, type, mode, exclusiveBehind?:N}]`（不回 content；mcp 密钥见 §8）。

### 2.3 冲突策略（绑定时刻强制，API 400 拒绝）

设某 bot 生效集内按 `(type, name)` 归组（mcp 按 `(type,'mcp', serverId)` 归组）：

| 情形 | 判定 |
|---|---|
| 同 `(type,name)` 多条 shared | **拒绑**（400「同名技能已配发，先卸载或改私发」） |
| 同 `(type,name)` exclusive + shared 并存 | **exclusive 覆盖**——shared 条目静默失效，绑定响应与 UI 标注「被私发副本压制」 |
| 多个 memory 资产 | 不冲突：notes 按**绑定顺序**拼接为多节（§4.3） |
| 多个 prompt 资产 | 不冲突：文本按**绑定顺序**拼接 |
| 两个 mcp 资产含同 `serverId` | **拒绑**（400 指名冲突 server）；物化层不再做改名合并 |
| mcp 资产绑 dsh bot 且某 `serverId` >32 字符 | **拒绑**（W3 T6 起 dsh 支持 MCP——物化为 profile `mcp-<serverId>` 行；但 dsh-mcp-client `SERVER_NAME_PATTERN ^[A-Za-z0-9_-]{1,32}$`（对已装包实证）拒超长名，且 failOnStartupError=false 下 MCP 工具会静默不出现——拒绝优于静默失败） |
| tool 资产 kind 与 provider 不符（如 rtk×dsh，F27） | **拒绑** |
| provider 端口未实现 `materializeAssets` | **拒绑**（「该 provider 暂不支持资产装备」） |
| skill 物化目标已存在且其 frontmatter 无 `x-wao-asset` 注记（外来技能占位） | **拒绑**（400 指名路径：「目标已有非 WAO 技能：\<path\>；请改资产名或先移除该技能」——注记=外来判别印，§4.1） |
| 与其他 bot 的物化目标撞同一路径（同 cwd / 同 claudeConfigDir / 同 codexHome 等解析后同文件） | **拒绑**（400 指名：「与 bot \<id\> 的资产目标文件冲突：\<path\>；同目录 bot 请改用专属 config 目录或先解绑」——检测数据源=各 bot 物化清单 manifest，§3.8） |
| 绑定 `origin:'mcp'` 资产（Agent 经 MCP 写面创建）为 shared 模式 | **拒绑**（400「Agent 创建的资产仅可私发（exclusive）绑定」，§8.1 写面分级） |

> rev.2 收紧说明：rev.1 曾按「标记节带 botId 可多 bot 共存一文件」接受同 cwd 共享态（原 §11 风险行）——
> 评审裁定弃该宽松语义：跨 bot 同文件的卸载判别/refcount/同名技能覆盖复杂度不值，一律拒绑；
> 标记节内的 botId 段保留（审计印 + 未来放宽的余量）。

---

## 3. 物化管线（provider 端口扩展）

### 3.1 端口扩展（additive，端口方言版本 ^1 不变——可选钩子不破坏旧实现）

```js
ctx.registerProvider('claude', {
  …, // 既有七件不动
  // 资产物化（可选钩子）：plan=core-engine 解析绑定后的生效清单（含快照），
  // 已按冲突策略裁决、按绑定序排列。返回写入清单供 API 回执/审计/测试断言。
  async materializeAssets(bot, plan, { log }) →
    { writes: [{ path, action: 'write'|'delete' }], notes: [{assetId, detail}] } | null,  // null=无该 bot 相关产物
  // 反物化（可选钩子）：bot 删除、或全部资产卸载后清理——只删自己写的标记节/文件（§3.6）
  async removeAssets(bot, { log }) → { removed: boolean } | null,
})
```

`plan` 条目形状：`{ assetId, type, name, mode, content }`（exclusive 时 content=snapshot）。

`createRunner` 签名扩展：`createRunner({ bot, providerConfig, assets, log })`——`assets`=同一 plan
（旗标型注入口 claude/pi 的 prompt 资产在 spawn 时拼 argv 用）。plan 变化（绑定变化或资产内容 PATCH
扇出）后走**轻量重 attach**（§3.2 定义）——不再借道 bot PATCH 的 drain/重连路径。

**plan 可变引用纪律（P0 裁定）**：plan 由 core-engine 构建后对 provider **只读**——shared 条目的
`content` 是注册表内对象的**引用**（未复制），exclusive 条目是 bots.json 快照的引用；钩子内不得原地
mutate plan 或其条目/`content`（改=污染注册表与快照的共享对象，且 §3.5 幂等性随之失效），一切变形
（翻译/拼接/排序）在副本上进行。契约用例断言：`materializeAssets` 返回后 plan 深比较=传入前一致（§10）。

### 3.2 调用时机与热更

| 触发 | 动作 |
|---|---|
| 绑定变化（PATCH /api/bots 的 assets 段变化） | 校验→`materializeAssets`→写清单（§3.8）→存盘→**轻量重 attach**（定义见下）。不走 drain/重连——物化产物只在下次 spawn 被 CLI 读取，adapter/channel 不动 |
| 资产内容 PATCH | 所有 shared 绑定该资产的 bot **立刻重物化**（eager）+逐 bot 轻量重 attach，**per-bot 隔离**：单 bot 失败不阻断其余，回执 `{rematerialized:[botId…], failed:[{botId, error}…]}`，失败 bot 进 agents 健康标注（对比表见下）；exclusive 绑定不动（快照） |
| 资产 DELETE | shared 绑定：移除绑定+重物化（清理节/文件）；exclusive 绑定：保留快照继续生效，回执与 UI 标「源资产已删除，副本仍生效」 |
| bot DELETE | 既有 `removeConfig` 之后追加 `removeAssets`（尽力而为，同契约）+删 manifest（§3.8） |
| 服务重启/启动 | 不主动重物化（幂等保证盘上即真相）；启动时对每 bot 做一次**只读回验**（§3.5），缺失/漂移→日志+agents 状态标注，不自动改写（按需修复走 §8.1 rematerialize 端点/doctor） |

**轻量重 attach（定义，P0 裁定）**：仅替换 runners 表项（`makeRunner(bot)`→`runners.set(botId, …)`），
**不动 adapter/channel**（不 drain、不重建适配器）；**在跑 run 持旧 runner 跑完**（turn 开始时已解析的
runner 引用不被夺走，旗标为旧版本），**下轮 run 起用新 runner 生效**。区别于既有 bot PATCH 的
校验→materialize→drain→重连（adapter+runner 全重建，F30）——资产面变化不需要那么重。

**扇出 vs 单 bot 写路径差异对比（资产内容 PATCH × bot PATCH，P1 裁定）**：

| | 资产内容 PATCH（shared 扇出，N bot） | bot PATCH（provider/providerConfig/assets 段，现行 api.js patchBotOp） |
|---|---|---|
| 失败语义 | **per-bot 隔离**：某 bot 物化 throw 只记入 `failed[]`，不回滚、不阻断其余 bot 已成功的物化 | **last-good 整体回滚**：物化 throw→库不落盘、盘面留上一好版本、bot 离线带原因 |
| 库面 | 资产新版本已入库（内容 PATCH 本身合法）；失败 bot 的**绑定保留**、盘面滞后于库 | 拒绝整个请求，库与盘都不动 |
| 恢复 | 失败 bot 由 agents 标注定位→`POST /api/bots/:id/rematerialize-assets` 重试（§8.1） | 修正后重发 PATCH |
| 回执 | `{rematerialized:[], failed:[]}` | 常规 bot 回执（masked echo） |

> 扇出不沿用 last-good 的理由：内容 PATCH 的对象是**资产**（已合法入库），N 个绑定 bot 中 N−1 个可
> 正常推进——为一个 bot 的盘面失败回滚整批物化（或连带回滚资产入库）会制造更大的不一致面；
> 隔离+显式 `failed[]` 清单+可重试端点是不静默原则下的最小充分语义。

### 3.3 四家目标面矩阵（探查事实驱动）

写入根=bot 声明目录（providerConfig.cwd / claudeConfigDir / codexHome / piAgentDir），子路径固定——越狱防护见 §8.3。

| 资产 | dsh | claude | codex | pi |
|---|---|---|---|---|
| **skill** | `<cwd>/.wao/skills/<name>/SKILL.md` + personaPrefix 索引节（F23 无原生面） | ①有 claudeConfigDir→`$CLAUDE_CONFIG_DIR/skills/<name>/SKILL.md`（个人域，T2-V1 验证 F16）②否则→`<cwd>/.claude/skills/<name>/SKILL.md`（项目域，F14 文档保证） | ①有 codexHome→`$CODEX_HOME/skills/<name>/SKILL.md`（本机证据 F1，T2-V2 验证重定向）②否则→`<cwd>/.agents/skills/<name>/SKILL.md`（REPO 域，F3 文档保证） | `<piAgentDir>/skills/<name>/SKILL.md` + runner 加 `--skill <abs>`（F19 显式旗标，不依赖发现） |
| **prompt** | personaPrefix 拼接节（F23） | runner `--append-system-prompt` 拼接（F11，无文件、每轮 ephemeral） | ①`$CODEX_HOME/AGENTS.md`（F10；重定向是否生效=V2 一并验证，rev.2 扩）②`<cwd>/AGENTS.md` 标记节（回退，文档保证的项目域面） | runner `--append-system-prompt` 拼接（F19 可重复） |
| **memory** | personaPrefix 拼接节（标注「跨会话记忆」） | `$CLAUDE_CONFIG_DIR/CLAUDE.md` 或 `<cwd>/CLAUDE.md` 标记节（个人/项目记忆域） | 同 prompt（AGENTS.md 标记节，与 prompt 分节） | `<piAgentDir>/wao-memory.md` 文件 + runner `--append-system-prompt <file>`（F19「文本或文件内容」，T2-V3 验证文件形态） |
| **mcp** | 每 server 一条 profile 行 `mcp-<serverId>`（`@deepseek-ai/dsh-mcp-client`；stdio=command/args/env，http=transport `streamable-http`+url/headers；形状对已装包 README+lib 实证，W3 T6 解除 F23 保守裁定）。行由 profiles.js 纯构建 `mcpClientRows` 生成、经 `buildBotPatch(…, assetsPlan)` 随**整文件重建**写入——materializeConfig 与 materializeAssets 都传生效计划，bot PATCH 重物化不掉 MCP 行（P0-4 同型防线）；env/headers 值**明文**落 patch（dsh 无引用语义；文件恒 0600）；serverId ≤32 字符（超出=绑定面拒绑，§2.3） | 物化 `data/assets/<botId>/claude-mcp.json`（WAO data 域，**0600**）+ runner 加 `--mcp-config <path>`（F12；**单文件整体 owned**，规避 F13 未记载的多文件合并语义；不加 `--strict-mcp-config`——不遮蔽用户自有 server）；server 名物化为 `wao-<serverId>`（**三家统一前缀**，rev.2；同名让位方向不再按未实证的 scope 优先级声明——V7 实证后写进文档） | `$CODEX_HOME/config.toml` 末尾追加标记节，server 物化为 `[mcp_servers.wao-<serverId>]`（F8 形状；**统一 `wao-` 前缀**防与用户自有条目同名造成 TOML 重复表解析错误；无 codexHome 时物化到 `<cwd>/.codex/config.toml`，F9 项目级面，T2-V4 验证非 trusted 目录可用性，不可用则要求 codexHome） | `<piAgentDir>/mcp.json`（F21 实证形状同 claude，**0600**）——默认 wao 命名目录内**整文件重写**，server 名 `wao-<serverId>`（三家统一前缀）；自定义 piAgentDir 遇外来文件拒写（F22 守卫同款）——外来判据：顶层 `x-wao-managed` 注记，**pi 对未知顶层键的容忍度未验证（V9）；不容忍则注记不落文件，判据改用物化清单 manifest（§3.8）** |
| **tool: rtk** | 不支持（F27） | 见 §7.1 | 见 §7.1 | 见 §7.1 |
| **tool: ripgrep** | 环境预检 + personaPrefix 指引节 | 预检 + `--append-system-prompt` 指引段 | 预检 + AGENTS.md 标记节内指引段 | 预检 + `--append-system-prompt` 指引段 |

> dsh 的 `<cwd>/.wao/skills/` 是 WAO 命名空间目录——即使 bot cwd 是真实 repo，`.wao/` 也是明确的外来管理目录（类比 node_modules），卸载整目录删除；索引节随 personaPrefix 重建天然一致。
>
> **dsh personaPrefix 单一组合器（P0 裁定）**：personaPrefix 行全文只由**一个**组合器函数生成，组合序
> =「`providerConfig.prompt`（运营者人物设定，**永远在前**）→ plan 内资产节（skill 索引 / prompt /
> memory / ripgrep 指引，按绑定序）」。`materializeConfig`（providerConfig 变更路径）与
> `materializeAssets`（资产路径）**都过同一组合器**重建全文——任何一侧重物化都产出含全部资产的完整
> personaPrefix，不存在「改模型丢资产节」的缝隙。契约用例「dsh 改模型」：只改 providerConfig（如
> model 行）触发 materializeConfig 重写 patch.yml，断言 personaPrefix 内资产节逐字节不变（§10）。
>
> **拼接序通则（全 provider，rev.2）**：bot 自身 prompt 在前、资产内容按绑定序在后——dsh 组合器序、
> claude/pi 的 `--append-system-prompt` 串内序、codex 标记节内分节序同守此则。

### 3.4 标记节格式（拼接到既有文件的唯一合法方式）

```
Markdown（CLAUDE.md / AGENTS.md）:
<!-- wao:assets:begin:v1:bot=<botId> -->
…（资产节内容，按绑定序）
<!-- wao:assets:end:v1:bot=<botId> -->

TOML（config.toml，节永在文件末尾，节内=完整 table 定义）:
# wao:assets:begin:v1:bot=<botId>
[mcp_servers.wao-xxx]
…
# wao:assets:end:v1:bot=<botId>

YAML（cordis.patch.yml——dsh 实为整文件重写，不属拼接；此处纪律=全文由 WAO 重建）
```

规则：一对标记节/每 bot/每文件（绑定层已拒跨 bot 同文件，§2.3——botId 段保留为审计印与未来放宽的余量）；
重物化=定位起止标记→整节替换；**`:v1`=格式版本段（rev.2）**——解析器按版本段路由处理逻辑，遇未知
版本段=报 drift 不自动改写（前向兼容锚点）；标记缺失（用户手删）=视为未物化，整节重建于文件末尾；
**标记节外一字不动**（孤儿清除是唯一例外，见下）。

**孤儿标记检测（P0 裁定；重物化/回验/卸载的公共前置）**：

- **单侧标记**：有 begin 无 end（或反之）=孤儿——该残标记及其后至文件尾视为未物化残骸；
- **标记对外 `wao-` 残留**：起止标记完好，但标记节**外**仍有 `wao-` 命名产物（TOML 的
  `[mcp_servers.wao-*]` 表、Markdown 的 wao 管理段）——既往物化或用户挪动留下的残骸；
- 处置一律=**先清孤儿再重建**：剥除残骸→按当前 plan 于文件末尾重建→清除动作计入 writes 清单
  （`action:'delete'`）与 drift 报告；**无法归属**的 `wao-` 残留（manifest §3.8 无据且非本 botId
  命名空间，可能属他 bot/来历不明）不自动清——报 drift，交 doctor/人工处置（§8.1）；
- **「半删标记」fixture 必测**（§10，TOML 面为最低要求）：手删 begin 单侧 / 手删 end 单侧 /
  起止全删留中间内容 / 标记完好但节外藏 `wao-` 表——各态断言=清孤儿+重建后与全新物化逐字节相同。

### 3.5 幂等与只读回验

- **确定性序列化**：节内容不含时间戳，键序固定（mcp env 键排序）、拼接序=绑定序→同 `(bot, plan)` 物化两次产出**逐字节相同**。
- **只读回验**（reload 后/测试用）：`materializeAssets(bot, plan, { dryRun: true })` 在内存构建全部产物与盘上对比，返回 `{drift:[{path, expected, actual}]}`——不写盘。契约套件用它断言「物化后读回=期望」。

### 3.6 卸载语义

- 文件型（skills/、.wao/、wao-memory.md、claude-mcp.json）：删除**WAO 创建的路径**（据=物化清单 manifest，§3.8）；skill 目录删除前校验 SKILL.md frontmatter 仍含本资产 `x-wao-asset` 注记——不符=告警不删（与 §2.3 绑定侧外来守卫对称）；dsh `.wao/skills/` 删到 `.wao` 空则连 `.wao` 一起删。
- 标记节型（CLAUDE.md/AGENTS.md/config.toml）：剥节保留其余内容（剥前先过 §3.4 孤儿检测）；剥后文件为空/仅剩空白→若文件为 WAO 所建（清单有据）则删文件，否则留空壳。
- **JSON 条目型（P1 裁定，rev.2 新增）**：rtk 回退路径写 `settings.json` 的 `hooks.PreToolUse[]` 等**数组项**——JSON 无标记节可剥；物化时**清单（§3.8 entries）记写入条目的全文**（定序 JSON 序列化）；卸载=对目标数组**精确匹配删**（逐项与记录全文 deep-equal，命中一条删一条）；**不匹配（条目已被用户手改）→告警不删**，回执/agents 标注「hook 条目已变化，请人工确认后删除：\<条目全文\>」。绝不按数组索引删（索引会漂移）、绝不模糊匹配（防误删用户相似条目）。
- **永不触碰**：无标记的外来内容、pi 自定义 agentDir 的外来 mcp.json/models.json（F22 守卫）、用户自有 settings/hooks。
- rtk 卸载见 §7.1（`--uninstall` 主路径；回退路径按标记节型/JSON 条目型各依上述语义）。

### 3.7 原子性与失败回滚

1. 全部目标内容**内存构建完成**后才动盘（profiles.js 同款纪律，F24）。
2. 多文件写入顺序：先独立文件（SKILL.md、memory 文件、mcp.json），后拼接节文件（CLAUDE.md/AGENTS.md/config.toml/patch）——最危险的最后写。
3. 每文件 tmp+rename（kernel atomicWrite）；**写前快照本次将改文件的旧内容**（内存），任一写失败→按快照逆序恢复已写文件（恢复也走 tmp+rename），整体 throw→API 400，错误文案指名路径（dsh/pi 现行文案风格）。
4. 部分失败最坏情形=恢复也失败：日志 ERROR + agents 状态标注「资产物化不一致，建议重试绑定」，不静默。

### 3.8 物化清单（manifest）持久化

`data/assets/<botId>/manifest.json`（data/ 纪律同 bots.json：原子写/0600/flock）——每次成功
`materializeAssets` 后整体重写：

```jsonc
{
  "botId": "main",
  "planFingerprint": "…",            // plan 规范化序列化的 hash（幂等性锚，§3.5）
  "writes": [{ "path": "…", "action": "write|delete", "owned": true }],
  "entries": [                        // JSON 条目型（§3.6）——rtk hook 数组项全文
    { "file": "…", "pointer": "/hooks/PreToolUse/3", "entry": { … } }
  ],
  "lastMaterializedAt": 1762500000000,
  "lastResult": "ok"                  // 或 "failed:<reason>"——物化失败如实记，不清旧清单
}
```

消费方：跨 bot 同文件冲突检测（§2.3）、卸载判别（文件是否 WAO 所建、rtk 条目精确匹配删）、
doctor 漂移比对（§8.1）、pi 外来文件判据回退（V9 不容忍时）、agents 的
`lastMaterializedAt`/`lastResult` 回显（§8.1）。物化失败保留上一好清单供 doctor 比对。

---

## 4. 五类资产内容 schema 与校验

> 校验器手写在 core-engine（零依赖，validateBot 风格）；错误=字段级数组（`errors`），API 400 原样带回。

### 4.0 公共红线（所有类型）

| 项 | 上限/规则 |
|---|---|
| 控制字符 | 拒绝 C0/C1 除 `\n \r \t` 外全部；NUL 必拒 |
| name（资产名与 skill 名、serverId、memory 标题） | **统一** `^[a-z0-9][a-z0-9-]{0,63}$`（rev.2：**禁 `.`**——TOML 表名以 `.` 分层，serverId 带点=意外嵌套表；亦消文件主干扩展名歧义）；不得为 `.`/`..`/含路径分隔符（**路径逃逸根防线**，§8.3） |
| 原型污染 | 任意层对象键 ∈ `__proto__|constructor|prototype` → 拒绝 |
| description | ≤200 字 |
| content 总大小 | ≤64KB（API 层 JSON 载荷上限照走内核既有 body 限制） |

### 4.1 skill

```jsonc
{ "name": "wao-company",           // 须过 slug 规则（成为目录名）
  "description": "何时触发本技能…",  // ≤1536 字符（F14 截断线，codex 亦用作匹配依据）
  "body": "# 指令正文…（Markdown，≤60KB）" }
```

物化为 SKILL.md：frontmatter `name`+`description`（+`x-wao-asset: <assetId>` 追注——claude F14 明示未识别字段静默忽略，codex 同为超集容忍；该注记是卸载审计与外来文件判别的第二道印）+ `\n\n` + body。v1 无 scripts/references（§0 非目标）。

### 4.2 mcp

```jsonc
{ "servers": {
    "company": { "command": "node", "args": ["server.js"], "env": { "TOKEN": "sk-…" } },
    "docs":    { "type": "http", "url": "https://example.com/mcp", "headers": { "X-K": "v" } } } }
```

- JSON Schema 校验：每 server **恰一形态**——stdio `{command:非空, args?:string[], env?:{[A-Z_][A-Z0-9_]*: 非空串}}` 或 http `{type:'http', url: http(s) URL, headers?:{合法 header 名: 串}}`；混键/缺键/`url` 无 `type`（F13 红线）→ 拒绝；`type:'sse'|'ws'`（F13 面上存在）→ 拒绝，文案定死「v1 仅支持 stdio/http 形态 MCP server」；URL 解析含 `user:pass@` 内嵌凭据 → 拒绝，文案「URL 内嵌凭据不允许：凭据走 env/headers」。
- 翻译规则（§3.3）：claude/pi 原样（键序排序，server 名统一 `wao-<serverId>`）；codex stdio→`command/args/[mcp_servers.wao-X.env]`，http→`url`+`headers`→`http_headers`。
- **密钥三态（P1 裁定）**：
  1. **明文入库**（默认态）：值明文存 data/assets.json（0600+flock，§8.4），回显按位置全掩（§8.1）；
  2. **引用态**：`env`/`headers` 值可写引用串——claude 面 `${VAR}` 展开（F13 实证存在）、codex 面经 `env_vars` 转发白名单（F8）——引用串入库不含密钥本体；**两家的引用展开语义（展开时机/缺变量行为/headers 面是否展开）未实证，列为 V8（§9），实证前 UI 不宣传引用能力**；
  3. **物化落盘态**：无法引用处明文落盘——WAO 独立文件（claude-mcp.json、pi mcp.json、`.wao/` 内）一律 **0600**；拼接进用户既有文件的（codex config.toml 标记节内 env 值）无独立权限位，**如实标注「权限=宿主文件」**，暴露面靠 bot 专属 codexHome 收敛。
- serverId 过 slug 规则；个数 ≤16/server，args ≤32 项/每项 ≤512 字符。

### 4.3 memory

```jsonc
{ "notes": ["台账摘要：…", "人工备注：…"] }   // ≤50 条，每条 ≤2KB，允许空数组
```

物化=每条一节（`## note-<i>` 无标题形态，直接条目列表，按绑定序），节首标注来源资产名。语义见 §7.2。

### 4.4 prompt

```jsonc
{ "text": "回答风格约束…" }   // ≤8KB
```

多 prompt 资产按绑定序以空行拼接；dsh/claude/pi 注入系统提示词（personaPrefix / --append-system-prompt），codex 进 AGENTS.md 标记节（codex 无逐轮 append 旗标，F10 面）。

### 4.5 tool（白名单 kind，仅两种）

```jsonc
{ "kind": "rtk",     "options": {} }                      // 空 options 占位（edition 等后期）
{ "kind": "ripgrep", "options": { "extraHints": "…" } }   // extraHints ≤1KB 追加进指引段
```

其余 kind 一律拒绝（§8.4）。行为见 §7。

---

## 5.（并入 §4.0 公共红线，避免重复）

---

## 6. 共享 / 独享语义

| | shared（配发） | exclusive（私发） |
|---|---|---|
| 存的是 | `{assetId, mode}` 引用 | + 绑定时刻整份 `content` 快照 + `snapshotVersion` |
| 资产 PATCH | 立即重物化该 bot（eager，§3.2） | **不跟随**（快照不变） |
| 资产 DELETE | 绑定移除+清理产物 | **副本继续生效**，UI/回执标「源已删除」 |
| N bot 同绑 | 各自物化各自目标面（同源不同副本，内容逐字节同——确定性序列化保证可互相校验） | 各自快照独立演化 |
| UI 标识 | 「配发」徽章 | 「私发」徽章 + 落后版本提示（`snapshotVersion < asset.version`） |

- 快照大小受 §4 上限约束（64KB 级，bots.json 膨胀可控；超限资产本就过不了内容校验）。
- 模式切换=改 mode：shared→exclusive 落快照；exclusive→shared 丢快照回到同源（UI 二次确认文案说明「私发修改将丢失」——内容本就只能平台侧改，此提示针对版本落后场景）。
- **UI 词表定死（P2 裁定，rev.2）**：徽章与全部产品文案只用「**配发**」「**私发**」两词，不再出现「共享/独享」直译混用；API 面枚举保持 `mode:'shared'|'exclusive'` 不改。映射行（UI 渲染层执行，词表进 UI 文案表）：`mode:'shared'` ↔ 徽章「配发」；`mode:'exclusive'` ↔ 徽章「私发」。

---

## 7. 工具资产与 memory 语义

### 7.1 RTK（kind: 'rtk'）状态机 + 物化

**前置事实**：F25 已装 rtk 1.1.0（~/.local/bin）；F26 机制=PreToolUse hook；F27/V5 已验证三 flavor 全部尊重重定向；dsh 不支持。

状态机（per bot×asset 绑定，态存物化清单 `manifest.tools`（§3.8），不进 bots.json；绑定本身永不因装备态回滚）：

```
未安装(unavailable) ——rtk 二进制缺失：绑定保留、零产物，回执 notes + agents assetWarnings 指引安装
已装备(armed)       ——主路径（rtk init 主导）或回退路径（WAO 自写 hook 条目），version 记 manifest.tools
失败(failed)        ——rtk init 非零/超时：物化 throw→回执 failed[]（stderr 摘要随 error），manifest lastResult 记因
```

物化流程（**T3 实装，V5 已解冻——主路径为常路径**）：providers 纯计划 `{kind:'rtk-init', target:<config dir>, flavor}` 写，core-engine 物化器独占执行（§8.3「外部命令写盘」纪律归一处）：

- **主路径（V5 已验证）**：`rtk init -g [flavor] --dry-run` 采集将写路径 → 逐条过 §8.3 前缀校验（**符号链接规范化后比较**——rtk 吐 realpath 化路径，macOS /tmp→/private/tmp；白名单=允许根 ∪ rtk 自有配置域 `~/Library/Application Support/rtk`、`~/.config/rtk`——filters.toml 模板/history.db 是二进制自身域，非 bot 面）→ 去掉 --dry-run 真跑（claude 加 `--auto-patch --no-trust-filters` 免交互；codex/pi 关闭 stdin 即免交互——`--codex` 与 `--auto-patch` 互斥）→ 回读断言（hook 条目全文记 manifest.entries、`via:'rtk'`）→ 清 install 期 `.bak` 残片。三 flavor 产物形状（实证）：
  - claude：`$CLAUDE_CONFIG_DIR/RTK.md` + `CLAUDE.md` 追加 `@RTK.md` 行 + `settings.json` 的 `hooks.PreToolUse[]` 条目 `{matcher:'Bash', hooks:[{type:'command', command:'rtk hook claude'}]}`（宿主文件则追加，幂等）；
  - codex：`$CODEX_HOME/RTK.md` + `AGENTS.md` 追加 `@/abs/RTK.md` + **`hooks.json`**（独立文件）同形条目（command `rtk hook codex`）；卸载后留空骨架 `{"hooks":{"PreToolUse":[]}}`；
  - pi：`$PI_CODING_AGENT_DIR/extensions/rtk.ts`（版本耦合 TS 扩展）+ `extensions/.rtk-agents` 属主记。
- **回退路径（dry-run 非零/无路径/越界→WAO 自写）**：claude/codex 有 JSON hook 面——WAO 依实证形状**自行写入** `$CLAUDE_CONFIG_DIR/settings.json` / `$CODEX_HOME/hooks.json` 的 `hooks.PreToolUse[]`（**JSON 条目型**，§3.6：清单记条目全文、卸载精确匹配删）；**pi 无 JSON hook 面**——extensions/rtk.ts 与 rtk 版本耦合，伪造比失败更糟，主路径不可用即 **failed**（指名文案），不降级不静默。
- **硬红线**：bot 未设 claudeConfigDir/codexHome（即共享用户主目录）时**拒绑 RTK**——绝不动用户自己的 ~/.claude/settings.json。**pi 例外形状（T3 判定）**：无 piAgentDir 的 pi bot 装备面是 WAO 命名空间默认目录 `~/.pi/agent-wao-<botId>`（per-bot，非共享主目录，§8.3 已列允许根）——放行，与 T2 评审 C1 同款判定。
- 卸载=`rtk init -g [flavor] --uninstall`（实证三 flavor 均尊重重定向且幂等，hook 条目已被手删时 exit 0）+ `.bak` 残片清扫；rtk 二进制缺失/卸载非零时按 §3.6 条目型精确匹配删兜底（清单已记全文；不匹配=告警不删，回执/agents 标注请人工确认）。装备态重物化不误删：rtk 仍绑定期间其 hook 条目不进 stale 清理（3.5 步重跑自会核对，rtk init 幂等）。
- **弃 PATH-shim（P2 裁定注记，rev.2）**：评审议过「PATH 前置垫片目录改写命令（如 grep/find→rg、cargo→rtk cargo）」方案——**弃**：垫片=发明私有装载器语义（违 §0「不发明私有装载器」红线），且对 provider 子进程 PATH 环境的侵入面大于收益；工具资产维持 hook（rtk）与指引段（ripgrep）两条既有路径。
- 装备效果验收（W3-T3 硬门，**已达成 2026-11-07**）：装/不装各跑一轮同 prompt 岗前测试（真 claude + Bash `git status` 原样复述，60 untracked+10 modified 确定性 repo）：baseline **1668 chars/79 行**（~417 tok）vs armed **1366 chars/71 行**（~342 tok）= **-302 chars / -18%，rtk gain 独立记账 76 tokens saved（18.2%）**，两轮复现逐字一致；证据在 T3 报告与 `test/e2e/rtk-token.realtest.js`（真 CLI，不入 npm test）。附带实证：stream-json 的 tool_use 事件回显**改写前**原文——改写判定源=rtk gain 记账，非事件原文。

### 7.2 ripgrep（kind: 'ripgrep'）

- 物化=环境预检（`rg --version` spawn 探测，超时 3s）+ 指引段注入（「代码检索一律用 `rg` 而非 grep/find，示例：`rg -t js 'pattern'`…」+ options.extraHints）。预检结论（available/unavailable+version）随 provider 计划**记入 manifest.tools**；预检失败→绑定仍成功但回执 notes + agents assetWarnings 标注「rg 未安装，指引已注入但无效」+ 指引段内含安装指引一句（**预检不失败**，装上即生效）。
- 四家注入口同 prompt 类（§3.3 矩阵末行）。

### 7.3 memory 语义边界（与 claude auto-memory 划界）

- **WAO memory 资产**=平台侧托管的人工备注/台账摘要，**唯一写入方是控制面**（API/UI/MCP 工具）；物化为标记节/文件，卸载即净。
- **claude 自带 auto-memory**（F18）=CLI 运行时自写 `…/projects/<cwd>/memory/`，WAO **不读不写不清理**；两者同名「记忆」但来源与生命周期独立——UI 文案区分「公司备注（平台）」vs「自动记忆（CLI 自理）」。
- **同 cwd 泄漏教训**（DESIGN §5.1）：多 bot 共 cwd 时 claude auto-memory 互漏——WAO 缓解=创建向导与文档建议「需要记忆隔离的 bot 配置专属 claudeConfigDir」；WAO 自身 memory 资产走标记节，随 CLAUDE_CONFIG_DIR 重定向天然隔离（T2-V1 一并验证）。
- **memory 同 cwd 绑定告警（P2 裁定，rev.2）**：bot 绑定 memory 资产时，若未设专属 claudeConfigDir/codexHome（记忆将落共享 cwd 的项目域 `<cwd>/CLAUDE.md`/`<cwd>/AGENTS.md`，对同 cwd 的一切会话可见——F18 同族面）→ **绑定回执带 `warning` 字段 + agents 状态警示**「记忆落在共享 cwd，对同目录其他会话可见，建议配专属 config 目录」。跨 bot 的同文件冲突本身已被 §2.3 拒绑；此告警针对的是**非 WAO 会话**（人/其他工具开在同一 cwd）的可见性。

---

## 8. 控制面 API 与安全

### 8.1 API（core-engine 注册，公司话文案）

| 方法 & 路径 | 作用 |
|---|---|
| `GET /api/assets` / `GET /api/assets/:id` | 清单/单查（type 徽章数据、绑定数、version；**mcp env/headers 值按位置→`__MASKED__`**，见下） |
| `POST /api/assets` / `PATCH /api/assets/:id` / `DELETE /api/assets/:id` | CRUD；PATCH 触发 shared 重物化扇出（§3.2：per-bot 隔离，回执 `{rematerialized:[], failed:[]}`）；DELETE 回执 `{removedBindings, keptExclusive, rematerialized:[], failed:[]}` |
| `POST /api/bots/:id/assets` / `DELETE /api/bots/:id/assets/:assetId` | 绑定/解绑专用校验面（bot POST/PATCH 直写 `assets` 一律 400 拒绝——绑定变更必须走本面的 §2.3 校验链，T1 实现形状）。行序（本表调和 §3.2 首行）：校验→**绑定落库存盘**（bots.json 即绑定库，注册表先于盘面）→物化（失败入 `failed[]` 不回滚，per-bot 隔离同 §3.2 扇出）→**仅成功**轻量重 attach（runner 跟注册表真相，失败保上一好 runner，重试走 rematerialize）；memory 绑定的共享 cwd `warning` 见 §7.3（agents 名册面同步回显 `assetWarnings`） |
| `POST /api/bots/:id/rematerialize-assets` | 单 bot 强制重物化（校验→materializeAssets→轻量重 attach）。**确定性序列化（§3.5）+孤儿清理（§3.4）使其=安全的自动修复路径**：drift 归零、幂等可重试；§3.2 扇出 `failed[]` 的 bot 用它重试；回执 `{writes, notes, lastMaterializedAt, lastResult}` |
| `GET /api/bots` / `GET /api/agents` | 绑定摘要回显（§2.2）；agents 加物化健康标注（回验漂移/工具状态/**扇出失败**）与 **`lastMaterializedAt` / `lastResult`**（读 manifest，§3.8） |

- **剥敏按位置（P1 裁定）**：复用现行机制（F31），掩码判据从「敏感键名」扩为**按位置全掩**——`servers.*.env.*` 的**全部值**与 `servers.*.headers.*` 的**全部值**不论键名一律 `__MASKED__`（密钥可藏于任意 header 名下，SENSITIVE_KEY 键名匹配仅作补充）；PATCH 回传 `__MASKED__`=`mergePreserving` 按路径**同位置**保库值。
- **MCP 写面分级（P0 裁定）**：companyOps 增 `assets/createAsset / updateAsset / deleteAsset / bindAsset / unbindAsset / rematerialize`（W3-T5 Agent 自助配资产用；REST 与 MCP 同函数不漂移，F31 哲学）。分级：
  - `createAsset`：允许——注册表标 `origin:'mcp'`，**该类资产仅允许 exclusive 绑定**（§2.3 拒绑兜底；Agent 私用快照域，不进共享同源）；
  - `updateAsset`/`deleteAsset`：**shared 资产一律禁**——工具返回只读指引「共享（配发）资产的改动请走控制台/REST」；`origin:'mcp'` 的 exclusive 资产（Agent 自建）可改可删；
  - `bindAsset`/`unbindAsset`/`rematerialize`：**危险级**——工具描述带后果确认文案（bind=「将向 bot 磁盘写入技能/配置文件并重建 runner，下一轮生效」；unbind=「将删除该 bot 盘上的资产产物；私发（exclusive）副本内容随卸载丢失」；rematerialize=「将按当前绑定重写该 bot 的全部资产产物文件」），执行回执附 writes 清单。
- **doctor 漂移检查（P1 裁定）**：`wao doctor`（src/index.js 既有命令）增资产检查项——对每 enabled bot 跑 dryRun 回验（§3.5）+孤儿标记扫描（§3.4）+manifest 与盘面 diff（§3.8），报告 drift 摘要与无法归属残留；修复指引=`POST /api/bots/:id/rematerialize-assets`（确定性序列化使其可安全自动修复，doctor 提供确认后直调的修复动作）。
- TUI：W2 已定键位不扩；仅员工卡加资产徽标数据源（渲染 W2-T2 已留扩展位）。

### 8.2 内容校验红线汇总（§4.0+各型，错误=字段级数组）

长度（64KB 总/各分项）、控制字符、slug 名（统一禁 `.`，§4.0）、env 键 `^[A-Z_][A-Z0-9_]*$`、http(s) URL 且**拒 `user:pass@` 内嵌凭据**、**拒 `sse`/`ws` 型**（文案「v1 仅支持 stdio/http 形态 MCP server」）、原型污染键黑名单、mcp 单 server 恰一形态、tool kind 白名单、（绑定层）冲突矩阵 §2.3（含跨 bot 同文件拒绑、skill 外来守卫、origin=mcp 仅 exclusive）。

### 8.3 写入目标越狱防护（物化器公共前置）

- 允许根=bot 声明的 `cwd` / `claudeConfigDir` / `codexHome` / `piAgentDir` / WAO `data/` 目录（claude-mcp.json；manifest §3.8 由 core-engine 自写，不经物化器钩子）。
- 每个写目标=允许根 + **固定子路径模板**（§3.3 矩阵）+ 资产 slug 名；`path.resolve` 后**前缀校验**必须命中且**不含 `..` 段**；skill/memory 名过 slug 规则（§4.0）从源头禁分隔符。
- rtk 物化的外部命令写盘（§7.1 主路径）必须先 dry-run 且对将写路径逐条过同一前缀校验，否则走回退路径。
- 违反=物化 throw（不写盘）→ API 400。

### 8.4 其他安全声明

- data/assets.json 含 mcp env 明文密钥——与 bots.json account secret 同级信任（data/ 0600 + flock，F32），响应永不回显（剥敏按位置全掩，§8.1）。
- **信任模型（rev.2 如实改写，P0 裁定）**：rev.1 声明「skill/mcp 内容由运营者录入，属本地信任模型」——**该声明已被 MCP 写面推翻**：W3-T5 起 Agent 可经 companyOps 写面创建/修改/删除资产并绑定，内容来源实为**运营者（REST/UI）与被授权 Agent（MCP）两方**。如实声明：
  - MCP 写面按 §8.1 分级收窄：Agent 自建资产仅 exclusive（影响面钉死在其有权绑定的单 bot 快照域），shared 同源只许运营者改；
  - Agent 写入的资产**不享有运营者级信任**：mcp 资产含 `command`（=绑定 bot 将 spawn 的进程面），prompt/skill 资产影响 bot 行为——运营者绑定 Agent 自建资产前自行审阅（UI 绑定确认处标注来源 origin）；
  - 校验红线只防意外与注入面（路径/结构/体积/凭据形态），**不做语义审查承诺**——提示词注入不在防线内，如实声明；
  - 本地信任边界本身不变（与 DESIGN §0「插件沙箱」非目标同款）：能调用控制面的人本就是运营者。

---

## 9. 验证项清单（T2/T3 首步，全部实证后才能标注「已验证」）

> **T2 实证记录（2026-11-07，W3 T2 首步，全部真跑，探针目录 /tmp/wao-v{1,2,7,8,9}-\*）**：
> - **V1 ✅ 已验证**：`CLAUDE_CONFIG_DIR` 重定向后 `<dir>/skills/<name>/SKILL.md` **被技能发现装载**、`<dir>/CLAUDE.md` **被读入指令**（真 claude -p 两问两答「有；是」）。附带发现：重定向后认证随 settings.json 走——生产 provider-claude 经 providerConfig.env 注入凭证不受影响；裸重定向需自带 settings.json。
> - **V2 ✅ 已验证**：CODEX_HOME 重定向后 `<CODEX_HOME>/skills/<name>/SKILL.md` 仍被发现（F1↔F3 缝隙闭合），**且 `<CODEX_HOME>/AGENTS.md` 被读**（F10 重定向生效；真 codex exec 三问答「有；有」「是」）。
> - **V7 ✅ 已验证**：`--mcp-config` 传入的 server **覆盖**用户 scope 同名 server——双向实证（用户侧好+旗标坏→failed；用户侧坏+旗标好→connected；无旗标→用户侧生效）。WAO `wao-` 前缀 + `--mcp-config` 即权威面。
> - **V8 ✅ 已验证**：claude 在**spawn server 时**对 env 值与 **headers 值**展开 `${VAR}`（展开自 claude 进程环境）；**缺失变量=字面量原样透传**（不报错/不清空）；父环境整体透传给 stdio server。codex `env` 表值原样透传给子进程；`env_vars=["X"]` 从 codex 自身进程环境转发 X（父缺 X→子进程无此变量，不报错）。
> - **V9 ✅ 已验证**：pi 容忍 mcp.json 未知顶层键（`pi mcp list` 正常列出 server），**且 pi 自身重写（`pi mcp add`）保留未知键**——`x-wao-managed` 注记既作外来判据又抗 pi 改写，manifest 回退判据不需要。
> - V3（pi --append-system-prompt 文件形态）不在 T2 清单：runner 采用设计回退「WAO 读文件拼文本传参」，不依赖文件形态。
> - V4/V6 留后续（项目级 config.toml/目录外 mcp-config）。

> **T3 实证记录（2026-11-07，W3 T3 首步，全部真跑，探针 /tmp/wao-t3-v5\* + rtk 1.1.0 ~/.local/bin）**：
> - **V5 ✅ 已验证**：`rtk init -g` 三 flavor 全部尊重重定向——claude（CLAUDE_CONFIG_DIR：RTK.md+CLAUDE.md `@RTK.md`+settings.json PreToolUse 条目）/codex（CODEX_HOME：RTK.md+AGENTS.md `@/abs/RTK.md`+**hooks.json** 条目）/pi（PI_CODING_AGENT_DIR：extensions/rtk.ts+.rtk-agents）；`--uninstall` 同样尊重且幂等。附带发现：1.1.0 无 `-v`；`--codex`×`--auto-patch` 互斥；install/uninstall 留 `.bak` 残片（WAO 清扫）；rtk 自有域写 filters.toml 模板+history.db（macOS `~/Library/Application Support/rtk`）；dry-run 路径 realpath 化（前缀校验需符号链接规范化）；stream-json tool_use 事件回显改写前原文（改写判定源=rtk gain）。装备效果硬门数字见 §7.1（-18% / 76 tokens）。
> - 装备面形状变化：codex 的 hook 面是 **hooks.json**（非 config.toml——T0 设计时未知）；pi 的面是 **TS 扩展文件**（无 JSON hook 面→回退路径对 pi 不可用=failed，见 §7.1）。

| # | 待验证 | 方法 | 回退 |
|---|---|---|---|
| V1 | claude 技能/CLAUDE.md 是否随 CLAUDE_CONFIG_DIR 重定向（F16） | 临时 CLAUDE_CONFIG_DIR 放 SKILL.md+CLAUDE.md，`claude -p` 问「列出可用技能/引用记忆内容」 | 项目域 `<cwd>/.claude/skills/`、`<cwd>/CLAUDE.md`（文档保证） |
| V2 | codex CODEX_HOME 重定向后 `<CODEX_HOME>/skills` 是否仍被发现（F1↔F3 缝隙）；**且（rev.2 扩）`<CODEX_HOME>/AGENTS.md` 是否随重定向被读**（F10 只证默认位 `~/.codex/AGENTS.md`，未证重定向） | 临时 CODEX_HOME（auth 从 ~/.codex 复制）+ 放技能与 AGENTS.md 标记节，`codex exec` 问可用技能/引用标记节内容 | skills→`<cwd>/.agents/skills/`；AGENTS.md→`<cwd>/AGENTS.md` 标记节（§3.3 ②级面；两级均为文档保证的项目域） |
| V3 | pi `--append-system-prompt <文件路径>` 确读文件内容（F19 字面） | `pi -p` 指引文件内容回显探针 | WAO 读文件拼文本传参 |
| V4 | codex 项目级 `.codex/config.toml` 在非 trusted 目录是否生效（F9 限定语） | 临时 cwd 放 `.codex/config.toml`（假 server），`codex exec` 观察 MCP 装载报错 | 要求 codexHome（绑定校验前置） |
| V5 | ~~`rtk init` 对自定义 CLAUDE_CONFIG_DIR/CODEX_HOME/PI_CODING_AGENT_DIR 的行为（F27）~~ **✅ 已验证（T3，2026-11-07）**：三 flavor 全部尊重重定向，产物形状见 §7.1 | ~~沙箱装 rtk，`--dry-run -v` 逐条核对将写路径~~ 已真跑（rtk 1.1.0，探针 /tmp/wao-t3-v5*） | §7.1 回退路径（WAO 自写 hook 条目；pi=failed 不伪造） |
| V6 | `--mcp-config` 传**目录外任意路径文件**+claude 装载成功（W1-T4 已有真 claude MCP 探针可复用） | 沿 W1-T4 真链路 | — |
| V7 | **claude 同名 server 让位方向实证（rev.2）**：`--mcp-config` 传入的 server 与用户既有 local/project/user scope 同名时哪侧生效——F13 只记 scope 间优先级，未记 CLI 旗标面与配置文件的合成方向 | 探针：user scope 放 server A（假 command 甲），`--mcp-config` 同名传 A'（假 command 乙），`claude -p` 经 mcp_server_errors/装载行为辨明生效侧 | 三家统一 `wao-` 前缀（§3.3）后同名冲突仅剩「用户自起 `wao-` 名」的病态情形；实证结果如实写进文档文案 |
| V8 | **claude `${VAR}` / codex `env_vars` 引用语义（rev.2，§4.2 密钥三态②）**：展开时机（读配置时 vs spawn server 时）、环境变量缺失时的行为（报错/空串/字面量）、claude headers 面是否同样展开、codex `env_vars` 从哪个进程环境继承 | claude：inline mcp-config 传 `${PROBE_VAR}`，分别设/不设变量跑探针；codex：config.toml `env_vars` 条目+`codex exec` 探针 | 引用态不宣传（UI 不暴露），密钥走明文态+落盘 0600（§4.2 ③） |
| V9 | **pi 读带未知顶层键的 mcp.json 的容忍度（rev.2）**：`<piAgentDir>/mcp.json` 加 `x-wao-managed` 类注记键后 pi 是否仍正常装载 mcpServers | 探针 mcp.json 加 `{"x-wao-managed":true,…}`，`pi mcp list` / `pi -p` 观察装载 | **不容忍→外来判据改物化清单**：注记不落 mcp.json，自定义 piAgentDir 的外来判别改查 `data/assets/<botId>/manifest.json`（该文件在 WAO writes 清单内与否，§3.8）——§3.3 pi 格线判据随之切换 |

---

## 10. 测试策略（对齐全局交付红线）

- **契约套件新增 materializeAssets 组**（test/contract/，参数化跑四家）：每家×每型资产 fixture（bot+plan→期望 writes 树+文件内容快照）；幂等（二次物化逐字节同）；卸载清根+外来内容零触碰（预置用户自有节/文件）；标记节剥离重写保外文；原子性（注入构建期 throw→盘面不变）；dryRun 回验（手改盘上一文件→drift 报告命中）；冲突矩阵 §2.3 全分支（API 层）；rev.2 新增契约用例——**plan 可变引用纪律**（materializeAssets 返回后 plan 深比较不变，§3.1）；**「dsh 改模型」**（只改 providerConfig 走 materializeConfig→personaPrefix 资产节逐字节仍在，§3.3 单一组合器）；**「半删标记」fixture**（TOML 面必测：删 begin 单侧/删 end 单侧/双侧全删留内容/标记完好节外藏 `wao-` 表——清孤儿+重建=全新物化逐字节同，§3.4）；**rtk JSON 条目型**（清单记全文→精确匹配删命中；用户手改后不匹配→告警不删，§3.6）；**扇出 per-bot 隔离**（N bot 绑 shared、注入 1 个物化 throw→其余 bot 成功、`failed[]` 回执+agents 标注，§3.2）；**rematerialize 端点幂等**（漂移盘面→调用→与全新物化逐字节同）。
- **注册表 API 测试**：CRUD/校验红线逐条（超长/控制字符/路径分隔符名/**带点名**/原型键/畸形 mcp/**sse·ws 型拒绝文案**/**URL 内嵌凭据拒绝**/越权 kind）；`__MASKED__` **按位置掩码**与 PATCH round-trip **同位置保库值**；DELETE 的 shared/exclusive 分气回执；**跨 bot 同文件拒绑指名文案、skill 外来守卫 400 指名路径、origin=mcp 资产 shared 绑定拒绑**；memory 绑定共享 cwd 的 `warning` 回执（§7.3）。
- **端到端（W3-T5）**：main bot 配 skill+mcp 资产→岗前测试真 claude 读到 SKILL.md 内容且 MCP 工具可呼（W1-T4 同法）；rtk 装/卸 token 对比（§7.1）；ripgrep 指引在答问中体现；经 MCP 的 Agent 自助配资产闭环；盲评清零。

---

## 11. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| CLAUDE_CONFIG_DIR/CODEX_HOME 对技能/指令文件的重定向未文档化（F16/V1/V2） | §9 验证项前置 + 文档保证的项目域回退；矩阵里①②两级目标面即回退设计 |
| codex config.toml 标记节 surgery 撞上用户手工同段 | 节永在文件末尾+`wao-` 前缀 server 名+重复表防御；漂移→回验报告 |
| 多 bot 共 cwd 时项目域技能/CLAUDE.md 互见（F18 同族） | **rev.2 收紧（P1 裁定）**：跨 bot 同目标文件一律拒绑（§2.3 指名文案），弃「同 cwd=共享态」宽松语义；memory 绑定另加共享 cwd 告警（§7.3）；文档+向导仍建议专属 config dir |
| rtk hook 只拦 Bash 工具调用（F26），token 收益取决于 bot 命令面 | 文案如实标注「作用于 shell 命令输出」；T3 实测数据说话 |
| exclusive 快照膨胀 bots.json | §4 上限 64KB/资产；UI 显示落后版本而非无限堆积 |
| 物化多文件非严格事务 | §3.7 快照逆序恢复+最坏情形显式标注（不静默） |

---

## 12. 评审关注点（rev.2：两路评审已裁定，此处记录结论与依据）

1. 冲突矩阵完备性 → **裁定补三行**：跨 bot 同目标文件拒绑（§2.3，指名文案）、skill 物化外来守卫（§2.3/§3.6）、`origin:'mcp'` 资产仅 exclusive（§8.1）；mcp 冲突维持 serverId 粒度。
2. 两级目标面（①config dir 重定向②项目域回退） → **维持①②两级**，不强制专属 config dir（rtk 除外——§7.1 硬红线本就要求）；V1/V2（rev.2 扩 AGENTS.md 重定向）验证前置。
3. eager vs 惰性 → **裁定=eager**。**成立依据（rev.2 补）**：① 确定性序列化（§3.5）使重物化=幂等本地文件写，无网络/外部副作用，重试零风险；② 轻量重 attach（§3.2 定义）代价极小——不 drain、不动 channel、在跑 run 不打断；③ 惰性需「脏标记+下轮 run 前拦截物化」的额外状态机与崩溃恢复语义，复杂度高于收益；④ eager 保住「盘上即真相」前提（§3.2 启动不重物化的根基）。扇出失败面由 per-bot 隔离+`failed[]` 清单+rematerialize 端点收敛（§3.2/§8.1）。
4. rtk 回退形状依赖（从 dry-run 学习是否过脆） → **裁定**：维持 dry-run 学习主路径+回退，但回退写面收敛为 JSON 条目型**清单记全文+精确匹配删**（§3.6），不匹配告警不删；T3 实装仍 pin 版本+复验（F27/V5）。
5. memory/auto-memory 边界文案 → **裁定**：§7.3 文案维持，另加「memory+共享 cwd 绑定告警」（回执 `warning`+agents 警示）。
