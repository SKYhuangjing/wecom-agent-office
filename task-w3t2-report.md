# W3-T2 评审修复报告（2026-11-07，评审 3 Critical + 5 Minor）

## 结论

- Status: done — 3 Critical 全部修复 + Minor 1/4/5 落地；Minor 2/3 按裁定注记不改（见下）。
- Commit: `fix(assets): pi default-dir jail, TOML newline escape, migration refresh, owned truth`
- Tests: `npm test` 全绿 — 526 pass / 0 fail / 0 skipped（基线 518，新增 8 个测试；基线在 HEAD 8793a4c 复跑亦全绿）。

## 修复清单（Critical）

1. **[C1] pi 默认 agentDir 被 jail 全拒** → `plugins/core-engine/materializer.js` `allowedRootsOf`：pi bot 且无 `piAgentDir` 时增补默认根 `~/.pi/agent-wao-<botId>`（piAgentDirFor 公式内联于注释指名 provider-pi/models.js，无插件间 import，同 DSH_HOME 先例）——此前默认目录 pi bot 绑定落库后物化必败（越界）。
   契约测试：`test/contract/materialize-assets.test.js`「pi 无 piAgentDir → 物化成功」（$HOME 重定向到沙箱，技能+mcp.json 落默认目录、verify 零漂移）。回归证明：仅撤销 materializer.js 改动该测试即失败。
2. **[C2] codex TOML 值不转义 \n\r** → `plugins/provider-codex/plugin.js` `TOML_ESCAPE` 补 `\n→\\n、\r→\\r、\t→\\t`（转义序：反斜杠最前）——注册面放行换行（CONTROL_CHARS 排除 \n\r\t），未转义产物=非法 TOML 静默毒化宿主 config.toml。顺带：SKILL.md frontmatter `description` 四家（dsh/claude/codex/pi）统一改 `JSON.stringify` 落 YAML（合法双引号标量，含冒号/换行/引号安全，单物理行）。
   测试：`test/provider/asset-faces.test.js`（字面 `\n\t\r` 序列断言 + 单趟 unescape 往返逐字节还原 + 四家字节一致）+ 契约「env 值含换行→config.toml 含字面 `\n`、全文件无裸 CR、用户行不动、幂等」。回归证明：仅撤销 codex 改动 2 个测试即失败。
3. **[C3] startupSweep 在 attach 后跑、迁移成功无 refreshRunner** → `plugins/core-engine/plugin.js` `afterAllActivated`：sweep 返回后对 `out.migrated` 中已 attach 的 bot 逐个 `refreshRunner`（离线 bot 该函数自带 no-op；失败保旧 runner 由其内部兜底）——迁移 bot 首进程周期即拿到 manifest 目标富集。
   测试：新文件 `test/engine/startup-migrate.test.js`（真内核 + 预置 bots.json/assets.json 的 T1-skipped 绑定形态启动；断言 attach 期 runner=裸 plan、扫尾后重铸 runner 带 `target`、manifest 与技能产物落盘）。回归证明：仅撤销 plugin.js 改动该测试即失败。

## 修复清单（Minor 落地）

4. **[M1=Minor 1] owned 口径** → `materializer.js`：manifest 的 owned 改记**写入时真值**——`写入时文件不存在（快照 null）或上一好清单已归我` 即 true；宿主文件（用户自建 CLAUDE.md/AGENTS.md/config.toml 等，首写前已存在）记 false。配套消费面：stale 清理对 owned:false 的 marker-section 仍**剥节**（此前被整行过滤=节残留）；`removeAssets` 对 owned:false 文件行不整删（指名告警）；`verify` 孤儿判定改为「marker-section 行以我方标记仍在盘为准」（剥空后的宿主文件不再永久误报孤儿）。
   测试：单测「预存宿主文件 owned:false + 剥空卸载保留 + 自有产物跨次物化 owned 不变 + removeAssets 不整删告警」+ 契约「用户自建空 CLAUDE.md：卸载/removeAssets 后保留且还原为原始字节，自有 mcp 文件照删」。
5. **[M4=Minor 4] 资产正文含 wao 标记行自造 drift** → `plugins/core-engine/assets.js` `checkText`：正文匹配 `wao:assets:…:vN`（`:v\d+` 覆盖前向版本）→ 400 指名字段（description/body/notes/text/extraHints 等全部文本面）。
   测试：`test/engine/assets.test.js`「六文本面 × 四种标记形态拒收且指名字段；无版本段的普通提及放行」。
6. **[M5=Minor 5] provider 端口缺失 bot 的 sweep 静默跳过** → `materializer.js` `startupSweep`：verify 回验带 `error`（端口缺失/计划失败）时 `log.warn` 指名 botId+原因，不抛不静默。
   测试：单测「有 manifest + 无 provider 端口 → warn 含 botId 与『暂不支持资产装备』，migrated/drift 双空」。

## 记录不改（裁定注记）

- **Minor 2（atomicWrite 0600 权限归零）**：设计背书原语（data/ 纪律、密钥红线），宿主侧组/其他权限本不该由 atomicWrite 承载 → 注记 `plugins/core-engine/CHANGELOG.md` Notes。
- **Minor 3（cleanupEmptyParents 空目录攀爬）**：极低频，攀爬以 allowedRoots 为止点且仅删确实为空的目录 → 同上 Notes 注记；如需收紧为「仅删 WAO 命名空间目录」另立任务。

## 验证

- `npm test`：526 pass / 0 fail（改动后全量）；基线复跑（stash 全部改动）518 pass / 0 fail。
- 回归证明（修复不自证）：分别仅撤销 materializer.js / provider-codex/plugin.js / core-engine/plugin.js 的改动，对应新测试均由绿转红，恢复后全绿。
- 触碰面：`plugins/core-engine/{materializer,plugin,assets,CHANGELOG.md}`、`plugins/provider-{codex,claude,pi,dsh}/plugin.js`、`test/contract/materialize-assets.test.js`、`test/engine/{materializer,assets,startup-migrate}.test.js`（新）、`test/provider/asset-faces.test.js`。未触碰并行 WIP 的 UI/web 脏文件（另行留置工作区，不入本 commit）。
- 未验证项：无（全部改动有测试断言覆盖；真实 CLI 面无改动——switch-matrix.realtest 不在本轮 npm test 范围，与本次改动面无交集）。
