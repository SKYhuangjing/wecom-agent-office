# WAO 资产系统设计规格（v2 · W3）

> 日期：2026-11-07 ｜ 状态：待两路评审 ｜ 上游：docs/DESIGN.md v3（存量权威）+ docs/superpowers/plans/2026-11-07-wao-v2.md §W3
> 一句话：**平台侧统一登记五类资产（技能/记忆/MCP/提示词/工具），按绑定物化为四家 provider 的原生格式——标记节/专属目录/运行旗标——共享同源、独享快照，热更下轮生效。**

---

## 0. 目标与非目标

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
| F23 | 无技能/MCP 概念（help 无相关项）；配置=profile 的 config 行表（`cordis.patch.yml`），**行 REPLACE 语义（整块替换不深合并）**；`system-prompt` 行 `personaPrefix`（块标量）=提示词注入口；`DSH_HOME` 可重定向 | `dsh --help` 实测 + plugins/provider-dsh/profiles.js 现行代码 |
| F24 | 物化纪律（现行生产代码）：整串 patch 内存构建→单次 tmp+rename 原子写；removeProfile=删整个 profile 目录 | profiles.js |

### 1.6 rtk 与 ripgrep

| # | 事实 | 证据 |
|---|---|---|
| F25 | `rtk` **本机未安装**（`which rtk` → not found；npm 上的 `rtk` 是同名发布工具，无关） | `which rtk`、`npm view rtk` 实测 |
| F26 | 目标工具=rtk-ai/rtk（Rust Token Killer）：单一 Rust 二进制（brew install rtk / install.sh）；`rtk init -g` 装 Claude Code **PreToolUse hook**（仅拦 Bash 工具调用，把 `cargo test` 改写为 `rtk cargo test` 过滤输出）；`rtk init`（无 -g）=项目级**仅写 CLAUDE.md 指引不装 hook**；`rtk init -g --codex` / `--agent pi` / `--gemini` / `--agent cursor` 等 flavor；`--dry-run` 打印将写文件不动盘（`-v` 附全文）；`--uninstall` flavor 存在；`rtk gain` 看节省；配置在 `~/.config/rtk/` | github.com/rtk-ai/rtk README + rtk-ai.app/docs/getting-started/quick-start |
| F27 | `rtk init` 对自定义 `CLAUDE_CONFIG_DIR`/`CODEX_HOME` 的支持**未验证**（本机无二进制）——T3 首步装沙箱实测；**dsh 不在 rtk 支持列表** | README Supported Agents 表 |
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
| 同 `(type,name)` 多条 shared | **拒绑**（400「同名技能已配发，先卸载或改独享」） |
| 同 `(type,name)` exclusive + shared 并存 | **exclusive 覆盖**——shared 条目静默失效，绑定响应与 UI 标注「被独享副本压制」 |
| 多个 memory 资产 | 不冲突：notes 按**绑定顺序**拼接为多节（§4.3） |
| 多个 prompt 资产 | 不冲突：文本按**绑定顺序**拼接 |
| 两个 mcp 资产含同 `serverId` | **拒绑**（400 指名冲突 server）；物化层不再做改名合并 |
| mcp 资产绑 dsh bot | **拒绑**（dsh 无 MCP 面，F23） |
| tool 资产 kind 与 provider 不符（如 rtk×dsh，F27） | **拒绑** |
| provider 端口未实现 `materializeAssets` | **拒绑**（「该 provider 暂不支持资产装备」） |

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
（旗标型注入口 claude/pi 的 prompt 资产在 spawn 时拼 argv 用；F30：runner 在 attach 时重建，
重绑定走 PATCH→重连路径自然换新 runner，无额外机制）。

### 3.2 调用时机与热更

| 触发 | 动作 |
|---|---|
| 绑定变化（PATCH /api/bots 的 assets 段变化） | 校验→`materializeAssets`→存盘。**不走 drain/重连**（物化产物只在下次 spawn 被 CLI 读取）——但 runner 旗标注入依赖新 runner，故 assets 段变化仍触发轻量重 attach（重建 runner，不动 channel） |
| 资产内容 PATCH | 所有 shared 绑定该资产的 bot **立刻重物化**（eager）；exclusive 绑定不动（快照） |
| 资产 DELETE | shared 绑定：移除绑定+重物化（清理节/文件）；exclusive 绑定：保留快照继续生效，回执与 UI 标「源资产已删除，副本仍生效」 |
| bot DELETE | 既有 `removeConfig` 之后追加 `removeAssets`（尽力而为，同契约） |
| 服务重启/启动 | 不主动重物化（幂等保证盘上即真相）；启动时对每 bot 做一次**只读回验**（§3.5），缺失/漂移→日志+agents 状态标注，不自动改写 |

### 3.3 四家目标面矩阵（探查事实驱动）

写入根=bot 声明目录（providerConfig.cwd / claudeConfigDir / codexHome / piAgentDir），子路径固定——越狱防护见 §8.3。

| 资产 | dsh | claude | codex | pi |
|---|---|---|---|---|
| **skill** | `<cwd>/.wao/skills/<name>/SKILL.md` + personaPrefix 索引节（F23 无原生面） | ①有 claudeConfigDir→`$CLAUDE_CONFIG_DIR/skills/<name>/SKILL.md`（个人域，T2-V1 验证 F16）②否则→`<cwd>/.claude/skills/<name>/SKILL.md`（项目域，F14 文档保证） | ①有 codexHome→`$CODEX_HOME/skills/<name>/SKILL.md`（本机证据 F1，T2-V2 验证重定向）②否则→`<cwd>/.agents/skills/<name>/SKILL.md`（REPO 域，F3 文档保证） | `<piAgentDir>/skills/<name>/SKILL.md` + runner 加 `--skill <abs>`（F19 显式旗标，不依赖发现） |
| **prompt** | personaPrefix 拼接节（F23） | runner `--append-system-prompt` 拼接（F11，无文件、每轮 ephemeral） | `$CODEX_HOME/AGENTS.md`（F10）或 `<cwd>/AGENTS.md` 标记节 | runner `--append-system-prompt` 拼接（F19 可重复） |
| **memory** | personaPrefix 拼接节（标注「跨会话记忆」） | `$CLAUDE_CONFIG_DIR/CLAUDE.md` 或 `<cwd>/CLAUDE.md` 标记节（个人/项目记忆域） | 同 prompt（AGENTS.md 标记节，与 prompt 分节） | `<piAgentDir>/wao-memory.md` 文件 + runner `--append-system-prompt <file>`（F19「文本或文件内容」，T2-V3 验证文件形态） |
| **mcp** | **不支持**（§2.3 拒绑） | 物化 `data/assets/<botId>/claude-mcp.json`（WAO data 域）+ runner 加 `--mcp-config <path>`（F12；**单文件整体 owned**，规避 F13 未记载的多文件合并语义；不加 `--strict-mcp-config`——不遮蔽用户自有 server，同名时按 claude scope 优先级让位，文档化） | `$CODEX_HOME/config.toml` 末尾追加标记节，server 物化为 `[mcp_servers.wao-<serverId>]`（F8 形状；**统一 `wao-` 前缀**防与用户自有条目同名造成 TOML 重复表解析错误；无 codexHome 时物化到 `<cwd>/.codex/config.toml`，F9 项目级面，T2-V4 验证非 trusted 目录可用性，不可用则要求 codexHome） | `<piAgentDir>/mcp.json`（F21 实证形状同 claude）——默认 wao 命名目录内**整文件重写**；自定义 piAgentDir 遇外来文件（无 waoManaged 标记）拒写（F22 守卫同款） |
| **tool: rtk** | 不支持（F27） | 见 §7.1 | 见 §7.1 | 见 §7.1 |
| **tool: ripgrep** | 环境预检 + personaPrefix 指引节 | 预检 + `--append-system-prompt` 指引段 | 预检 + AGENTS.md 标记节内指引段 | 预检 + `--append-system-prompt` 指引段 |

> dsh 的 `<cwd>/.wao/skills/` 是 WAO 命名空间目录——即使 bot cwd 是真实 repo，`.wao/` 也是明确的外来管理目录（类比 node_modules），卸载整目录删除；索引节随 personaPrefix 重建天然一致。

### 3.4 标记节格式（拼接到既有文件的唯一合法方式）

```
Markdown（CLAUDE.md / AGENTS.md）:
<!-- wao:assets:begin:bot=<botId> -->
…（资产节内容，按绑定序）
<!-- wao:assets:end:bot=<botId> -->

TOML（config.toml，节永在文件末尾，节内=完整 table 定义）:
# wao:assets:begin:bot=<botId>
[mcp_servers.wao-xxx]
…
# wao:assets:end:bot=<botId>

YAML（cordis.patch.yml——dsh 实为整文件重写，不属拼接；此处纪律=全文由 WAO 重建）
```

规则：一对标记节/每 bot/每文件；重物化=定位起止标记→整节替换；标记缺失（用户手删）=视为未物化，整节重建于文件末尾；**标记节外一字不动**。

### 3.5 幂等与只读回验

- **确定性序列化**：节内容不含时间戳，键序固定（mcp env 键排序）、拼接序=绑定序→同 `(bot, plan)` 物化两次产出**逐字节相同**。
- **只读回验**（reload 后/测试用）：`materializeAssets(bot, plan, { dryRun: true })` 在内存构建全部产物与盘上对比，返回 `{drift:[{path, expected, actual}]}`——不写盘。契约套件用它断言「物化后读回=期望」。

### 3.6 卸载语义

- 文件型（skills/、.wao/、wao-memory.md、claude-mcp.json）：删除**WAO 创建的路径**（快照记录在物化清单）；dsh `.wao/skills/` 删到 `.wao` 空则连 `.wao` 一起删。
- 标记节型（CLAUDE.md/AGENTS.md/config.toml）：剥节保留其余内容；剥后文件为空/仅剩空白→若文件为 WAO 所建（物化清单有据）则删文件，否则留空壳。
- **永不触碰**：无标记的外来内容、pi 自定义 agentDir 的外来 mcp.json/models.json（F22 守卫）、用户自有 settings/hooks。
- rtk 卸载见 §7.1。

### 3.7 原子性与失败回滚

1. 全部目标内容**内存构建完成**后才动盘（profiles.js 同款纪律，F24）。
2. 多文件写入顺序：先独立文件（SKILL.md、memory 文件、mcp.json），后拼接节文件（CLAUDE.md/AGENTS.md/config.toml/patch）——最危险的最后写。
3. 每文件 tmp+rename（kernel atomicWrite）；**写前快照本次将改文件的旧内容**（内存），任一写失败→按快照逆序恢复已写文件（恢复也走 tmp+rename），整体 throw→API 400，错误文案指名路径（dsh/pi 现行文案风格）。
4. 部分失败最坏情形=恢复也失败：日志 ERROR + agents 状态标注「资产物化不一致，建议重试绑定」，不静默。

---

## 4. 五类资产内容 schema 与校验

> 校验器手写在 core-engine（零依赖，validateBot 风格）；错误=字段级数组（`errors`），API 400 原样带回。

### 4.0 公共红线（所有类型）

| 项 | 上限/规则 |
|---|---|
| 控制字符 | 拒绝 C0/C1 除 `\n \r \t` 外全部；NUL 必拒 |
| name（资产名与 skill 名、serverId、memory 标题） | `^[a-z0-9][a-z0-9-_.]{0,63}$`；不得为 `.`/`..`/含路径分隔符（**路径逃逸根防线**，§8.3） |
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

- JSON Schema 校验：每 server **恰一形态**——stdio `{command:非空, args?:string[], env?:{[A-Z_][A-Z0-9_]*: 非空串}}` 或 http `{type:'http', url: http(s) URL, headers?:{合法 header 名: 串}}`；混键/缺键/`url` 无 `type`（F13 红线）→ 拒绝。
- 翻译规则（§3.3）：claude/pi 原样（键序排序）；codex stdio→`command/args/[mcp_servers.wao-X.env]`，http→`url`+`headers`→`http_headers`；`env` 值为密钥语义→**API 回显 `__MASKED__`**（§8.1）。
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

---

## 7. 工具资产与 memory 语义

### 7.1 RTK（kind: 'rtk'）状态机 + 物化

**前置事实**：F25 本机未装、F26 机制=PreToolUse hook、F27 自定义 config dir 支持未验证、dsh 不支持。

状态机（per bot×asset 绑定，状态存注册表侧 `bindings-state`（内存+启动重查），不进 bots.json）：

```
未安装(unavailable) --装 rtk 二进制--> 未装备(unarmed)
未装备 --materialize--> 已装备(armed) | 失败(failed: 原因)
已装备 --unmaterialize--> 未装备
（CLI 缺失时任何态 → unavailable，agents 页指引安装：brew install rtk）
```

物化流程（T3 实装时按 F27 验证结果二选一）：

- **主路径（rtk init 支持自定义目录）**：对 bot 的 `CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`PI_CODING_AGENT_DIR` 执行 `rtk init -g [--codex|--agent pi] --dry-run -v` 采集将写内容→确认仅落在 bot 声明目录内（§8.3 白名单）→去掉 --dry-run 真跑→回读断言。
- **回退路径（不支持自定义目录/写到了共享 ~/.claude）**：WAO 依据 dry-run 学到的 hook 条目形状，**自行写入** bot 域文件（claude=`$CLAUDE_CONFIG_DIR/settings.json` hooks.PreToolUse 标记节；codex=config.toml hook 条目入标记节；pi=agent 目录对应文件），command 指向同一 rtk 二进制。
- **硬红线**：bot 未设 claudeConfigDir/codexHome/piAgentDir（即共享用户主目录）时**拒绑 RTK**——绝不动用户自己的 ~/.claude/settings.json（与 F18 同族的串扰防线）。
- 卸载=`rtk … --uninstall`（同域验证）或回退路径自删标记节；hook 移除后跑一轮岗前测试确认无残留报错。
- 装备效果验收（W3-T3 硬门）：装/卸各跑一轮同 prompt 岗前测试，对比台账 tokens 字段与 `rtk gain`，证据入报告。

### 7.2 ripgrep（kind: 'ripgrep'）

- 物化=环境预检（`rg --version` spawn 探测，超时 3s）+ 指引段注入（「代码检索一律用 `rg` 而非 grep/find，示例：`rg -t js 'pattern'`…」+ options.extraHints）。预检失败→绑定仍成功但回执/agents 标注「rg 未安装，指引已注入但无效」+ 指引段内含安装指引一句。
- 四家注入口同 prompt 类（§3.3 矩阵末行）。

### 7.3 memory 语义边界（与 claude auto-memory 划界）

- **WAO memory 资产**=平台侧托管的人工备注/台账摘要，**唯一写入方是控制面**（API/UI/MCP 工具）；物化为标记节/文件，卸载即净。
- **claude 自带 auto-memory**（F18）=CLI 运行时自写 `…/projects/<cwd>/memory/`，WAO **不读不写不清理**；两者同名「记忆」但来源与生命周期独立——UI 文案区分「公司备注（平台）」vs「自动记忆（CLI 自理）」。
- **同 cwd 泄漏教训**（DESIGN §5.1）：多 bot 共 cwd 时 claude auto-memory 互漏——WAO 缓解=入职向导与文档建议「需要记忆隔离的 bot 配置专属 claudeConfigDir」；WAO 自身 memory 资产走标记节，随 CLAUDE_CONFIG_DIR 重定向天然隔离（T2-V1 一并验证）。

---

## 8. 控制面 API 与安全

### 8.1 API（core-engine 注册，公司话文案）

| 方法 & 路径 | 作用 |
|---|---|
| `GET /api/assets` | 清单（type 徽章数据、绑定数、version；**mcp env 值→`__MASKED__`**） |
| `POST /api/assets` / `PATCH /api/assets/:id` / `DELETE /api/assets/:id` | CRUD；PATCH 触发 shared 重物化（§3.2）；DELETE 回执 `{removedBindings, keptExclusive, rematerialized:[botId]}` |
| `PATCH /api/bots/:id`（assets 段） | 绑定/卸载/模式切换（走 §3.2 资产路径：校验→物化→轻量重 attach） |
| `GET /api/bots` / `GET /api/agents` | 绑定摘要回显（§2.2）；agents 加物化健康标注（回验漂移/工具状态） |

- 剥敏复用现行机制（F31）：mcp.servers.*.env.* 与 headers.Authorization 类值并入 SENSITIVE_KEY 语义；PATCH 回传 `__MASKED__`=`mergePreserving` 保库值。
- MCP 面：companyOps 增 `assets/createAsset/updateAsset/deleteAsset/bindAsset/unbindAsset`（W3-T5 Agent 自助配资产用；REST 与 MCP 同函数不漂移，F31 哲学）。
- TUI：W2 已定键位不扩；仅员工卡加资产徽标数据源（渲染 W2-T2 已留扩展位）。

### 8.2 内容校验红线汇总（§4.0+各型，错误=字段级数组）

长度（64KB 总/各分项）、控制字符、slug 名、env 键 `^[A-Z_][A-Z0-9_]*$`、http(s) URL、原型污染键黑名单、mcp 单 server 恰一形态、tool kind 白名单、（绑定层）冲突矩阵 §2.3。

### 8.3 写入目标越狱防护（物化器公共前置）

- 允许根=bot 声明的 `cwd` / `claudeConfigDir` / `codexHome` / `piAgentDir` / WAO `data/` 目录（仅 claude-mcp.json）。
- 每个写目标=允许根 + **固定子路径模板**（§3.3 矩阵）+ 资产 slug 名；`path.resolve` 后**前缀校验**必须命中且**不含 `..` 段**；skill/memory 名过 slug 规则（§4.0）从源头禁分隔符。
- rtk 物化的外部命令写盘（§7.1 主路径）必须先 dry-run 且对将写路径逐条过同一前缀校验，否则走回退路径。
- 违反=物化 throw（不写盘）→ API 400。

### 8.4 其他安全声明

- data/assets.json 含 mcp env 明文密钥——与 bots.json account secret 同级信任（data/ 0600 + flock，F32），响应永不回显。
- skill/mcp 内容由运营者录入，属本地信任模型（DESIGN §0 非目标「插件沙箱」同款边界）；校验红线只防意外与注入面（路径/结构/体积），不做语义审查承诺。

---

## 9. 验证项清单（T2/T3 首步，全部实证后才能标注「已验证」）

| # | 待验证 | 方法 | 回退 |
|---|---|---|---|
| V1 | claude 技能/CLAUDE.md 是否随 CLAUDE_CONFIG_DIR 重定向（F16） | 临时 CLAUDE_CONFIG_DIR 放 SKILL.md+CLAUDE.md，`claude -p` 问「列出可用技能/引用记忆内容」 | 项目域 `<cwd>/.claude/skills/`、`<cwd>/CLAUDE.md`（文档保证） |
| V2 | codex CODEX_HOME 重定向后 `<CODEX_HOME>/skills` 是否仍被发现（F1↔F3 缝隙） | 临时 CODEX_HOME（auth 从 ~/.codex 复制）+ 技能，`codex exec` 问可用技能 | `<cwd>/.agents/skills/`（文档保证） |
| V3 | pi `--append-system-prompt <文件路径>` 确读文件内容（F19 字面） | `pi -p` 指引文件内容回显探针 | WAO 读文件拼文本传参 |
| V4 | codex 项目级 `.codex/config.toml` 在非 trusted 目录是否生效（F9 限定语） | 临时 cwd 放 `.codex/config.toml`（假 server），`codex exec` 观察 MCP 装载报错 | 要求 codexHome（绑定校验前置） |
| V5 | `rtk init` 对自定义 CLAUDE_CONFIG_DIR/CODEX_HOME/PI_CODING_AGENT_DIR 的行为（F27） | 沙箱装 rtk，`--dry-run -v` 逐条核对将写路径 | §7.1 回退路径（WAO 自写 hook 条目） |
| V6 | `--mcp-config` 传**目录外任意路径文件**+claude 装载成功（W1-T4 已有真 claude MCP 探针可复用） | 沿 W1-T4 真链路 | — |

---

## 10. 测试策略（对齐全局交付红线）

- **契约套件新增 materializeAssets 组**（test/contract/，参数化跑四家）：每家×每型资产 fixture（bot+plan→期望 writes 树+文件内容快照）；幂等（二次物化逐字节同）；卸载清根+外来内容零触碰（预置用户自有节/文件）；标记节剥离重写保外文；原子性（注入构建期 throw→盘面不变）；dryRun 回验（手改盘上一文件→drift 报告命中）；冲突矩阵 §2.3 全分支（API 层）。
- **注册表 API 测试**：CRUD/校验红线逐条（超长/控制字符/路径分隔符名/原型键/畸形 mcp/越权 kind）；`__MASKED__` 回显与 PATCH round-trip；DELETE 的 shared/exclusive 分气回执。
- **端到端（W3-T5）**：main bot 配 skill+mcp 资产→岗前测试真 claude 读到 SKILL.md 内容且 MCP 工具可呼（W1-T4 同法）；rtk 装/卸 token 对比（§7.1）；ripgrep 指引在答问中体现；经 MCP 的 Agent 自助配资产闭环；盲评清零。

---

## 11. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| CLAUDE_CONFIG_DIR/CODEX_HOME 对技能/指令文件的重定向未文档化（F16/V1/V2） | §9 验证项前置 + 文档保证的项目域回退；矩阵里①②两级目标面即回退设计 |
| codex config.toml 标记节 surgery 撞上用户手工同段 | 节永在文件末尾+`wao-` 前缀 server 名+重复表防御；漂移→回验报告 |
| 多 bot 共 cwd 时项目域技能/CLAUDE.md 互见（F18 同族） | 文档+向导建议专属 config dir；标记节含 botId 可审计；v1 接受「同 cwd=共享态」语义并写明 |
| rtk hook 只拦 Bash 工具调用（F26），token 收益取决于 bot 命令面 | 文案如实标注「作用于 shell 命令输出」；T3 实测数据说话 |
| exclusive 快照膨胀 bots.json | §4 上限 64KB/资产；UI 显示落后版本而非无限堆积 |
| 物化多文件非严格事务 | §3.7 快照逆序恢复+最坏情形显式标注（不静默） |

---

## 12. 评审关注点（给两路评审子代理）

1. 冲突矩阵 §2.3 的判定是否完备（尤其 mcp serverId 粒度 vs 资产名粒度的选择）；
2. §3.3 矩阵中「①config dir 重定向②项目域」的两级目标面是否接受（还是强制要求绑定资产前必须设专属 config dir？）；
3. eager 重物化（资产 PATCH 即重物化全部 shared 绑定）vs 惰性（下轮 run 前物化）的取舍；
4. rtk 回退路径「WAO 自写 hook 条目」的外部形状依赖（从 dry-run 学习）是否过于脆弱；
5. memory 与 auto-memory 边界文案（§7.3）是否足够防误用。
