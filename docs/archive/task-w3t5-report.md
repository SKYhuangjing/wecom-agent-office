# W3-T5 盲评 P2 修复报告（2026-11-07，盲评 PASS with 4 P2s）

## 结论

- Status: done — 4 个 P2 全部修复，并行 WIP（白棚重设计：`plugins/ui-workbench/ui/style.js`、`web/*`、`plugins/ui-office-studio/*`、office3d/白棚截图等）全程未动、不入本 commit（sha256 校验临时换回原样）。
- Commit: `fix(assets): blind P2s — docs tool count, agents materialized fields, tool badge, wizard defaults`
- Tests: `npm test` 全绿 — 545 pass / 0 fail / 0 skipped（基线 542，新增 3 个测试）；红证见「验证」。

## 修复清单

1. **[P2] 文档 13↔19 工具数不符** → `docs/skills/wao-company.md`（头部说明 13→19「13 公司 + 6 资产」、速查表补 6 行：create/update/delete/bind/unbind_asset+rematerialize，危险列标 ⚠️；危险确认规范从三工具扩为七工具；新增配方 6「资产配发（危险）」；触发场景与 frontmatter description 补资产话术）+ `README.md` §3.2（工具表 13→19 行、引言补「资产配发」）。exclusive-only 规则（Agent 自建 origin:mcp 仅可私发）与 update/delete 的「配发池走控制台/REST」分级均写入两处表格。
2. **[P2] agents 名册缺 lastMaterializedAt/lastResult（DESIGN §8.1 P1-14 承诺）** → `materializer.js` 新增 `getManifest(botId)`（§3.8 只读出口，深拷贝；noop 同步补 null 形状）；`api.js` botRow 回显 `lastMaterializedAt`/`lastResult`（三面共享：/api/agents、companyOps.agents、botDetail=get_employee）；`tools.js` `list_employees` 摘要加「↳ 最近物化：<时间>（正常 | failed:<原因>截断）」一行（无清单不显示）。
   测试：materializer 单测「getManifest null/深拷贝」+ assets-api「名册回显=盘上 manifest 时间戳逐字节一致 + 未物化 bot 回显 null + botDetail 三面一致」+ mcp tools「摘要行正则 + REST 同源」。
3. **[P2] 装备台工具装备态徽章** → botRow 增 `assetTools`（manifest.tools 摘要：assetId/kind/state/version，不带盘面路径）；`ui/assets.js` 装备台「已装备」表新增「装备态」列：工具行 🛠 已装备 ripgrep 14.1.1（armed/available）/ ⚠ 未安装（unavailable，title 注记装好二进制后「重新物化」）/ 未物化（无清单条目），非工具行「—」（title 说明）；复用既有徽章配色类，未新造样式（避让并行 WIP 的 style.js）。harness 假数据补 `ast-rg004`（ripgrep 工具，available）+ bot-2 绑定与 `assetTools`/`lastMaterializedAt` 回显（rtk-slim 保持 unavailable 与既有警示条自洽）。
   验证：4 张资产科截图重截亲验（见下）。
4. **[P2] 向导 3.5 步默认不一致 + 不支持岗位可勾选** → `ui/wizard.js` 默认 `equipMode:'shared'`（选项序改为「配发（默认·跟源更新）」在前，与装备台口径一致，label 注明默认）；提交循环对 Agent 自建资产固定 exclusive（默认改配发后不再踩 §8.1 400）。不支持岗位禁勾：`api.js` portsOp providers 增 `assets: <有无 materializeAssets>`（判定源同 materializer checkBind 的 provider 支持面），向导据 `assets===false` 禁用全部勾选 + title「该岗位暂不支持装备」+ 行内可见注记 + 顶部说明条，换岗到不支持岗位时清空已勾选。harness ports 假数据补 `assets:true`。
   测试：plugin.test「/api/ports assets 旗标（fakeprov 无 materializeAssets=false / dsh=true）」+ CDP 实测（见下）。

## 验证

- `npm test`：545 pass / 0 fail（改动后全量，两轮一致）。
- 红证（修复不自证）：stash 后端三文件（api.js/tools.js/materializer.js）→ 3 个新测试由绿转红（roster 回显 / getManifest / 最近物化行），恢复后全绿。
- 截图（ui-shot 重截，亲验 4 张）：`test/ui-shots/ui-workbench-assets-{light,dark}.png`、`ui-workbench-assets-equip-{light,dark}.png`——装备态列两种徽章+「—」齐全；dark 底色像素实证 #1d2422。**截图隔离**：并行 WIP 已把 `style.js`/`web/dist/assets/app.css` 改为纯白主题（去 dark 块），直接重截会把 WIP 视觉烙进本 commit 的基线——临时换回 HEAD 版本拍摄、拍完 sha256 校验逐字节还原 WIP 文件（`bcc46dec…`/`68cd72cb…` 前后一致）。
- 向导 CDP 实测（临时内核 18931 + 无头 Chrome，真 harness 页 `?page=bots&select=new` 驱动）：10/10 PASS——默认=shared、首选项「配发（默认·跟源更新）」、dsh 全部可勾、codex（临时 mock assets:false）4 个勾选全禁用 + title 全为「该岗位暂不支持装备」+ 可见注记。向导无既有截图基线位（ui-shot.sh 不含向导步骤），未新增基线槽位。
- 文档口径核对：`wao-company.md` 与 README §3.2 速查表均为 19 行工具、6 个资产工具危险标记与 plugins/mcp-gateway/README.md（既有 19 工具表）一致。
- 触碰面：`README.md`、`docs/skills/wao-company.md`、`plugins/core-engine/{api,assets,materializer}.js`、`plugins/mcp-gateway/tools.js`、`plugins/ui-workbench/ui/{assets,wizard,fake-data}.js`、`test/engine/{materializer,assets-api,plugin}.test.js`、`test/mcp/tools.test.js`、`test/contract/rtk-round.test.js`、4 张资产科截图。并行 WIP 文件零触碰零提交。
- 未验证项：真控制台页（非 harness）的装备态列未实测——同构渲染路径且 /api/agents 字段有 REST 测试断言；向导「换岗清空已勾选」逻辑经代码路径覆盖（pickProvider 分支），未单独 CDP 断言。

# v2 终审修复（SHIP with 1 Important + minors，2026-11-07）

## 结论

- Status: done — 1 Important + 2 Minor 全修，1 项[备案不改]（doctor）记 CHANGELOG Notes；并行 WIP（白棚重设计等）零触碰零提交。
- Commit: `fix(assets): immutability guard for shared renames, conflict-scan fallback, tui asset badges`
- Tests: `npm test` 全绿 — 549 pass / 0 fail / 0 skipped（基线 545，新增 4 个测试）。

## 修复清单

1. **[Important] 资产 PATCH 扇出不复查跨 bot 冲突** → `plugins/core-engine/api.js` updateAssetOp 增 `structuralKeysOf`（skill=content.name；mcp=serverId 集合）：存在任一 shared 绑定的资产，PATCH 使结构键集合变化（改名/增删 server 均算）→ 400「该资产有配发绑定，改名需先解绑（避免跨员工文件冲突）」——裁定=不可变方案，扇出 file-create 不再可能静默覆盖共享根目录他 bot 已物化文件（§2.3 冲突矩阵不会在 PATCH 上重跑）。同结构键内容编辑仍走原 eager 扇出；exclusive-only 资产可改（快照不扇出，§6）。测试：assets-api「shared skill 改名 400 + 注册表键未变 + 同键 body 编辑仍扇出 + 解绑后可改名 / shared mcp serverId 改名 400、同 serverId 改 args 200 / exclusive 改名 200 且快照冻结」。
2. **[Minor] detectFileConflicts 对方无 manifest 漏比对** → 取裁定的最小实现：新物化器钩子 `detectUnverifiedSharedRoots(bot, plan, allBots)`（materializer.js 真实现 + assets.js noop 答空 + 接缝契约注释）：共根（face roots 交集，data/ 引擎内部域除外）且有绑定但无 manifest 的他 bot → bind 回执 warnings 提示「先对其 POST rematerialize-assets（或人工核查其目录）」——warning 不翻 400；重物化后真实 manifest 比对接管。无绑定 bot 不告警（未物化过，避免噪音）。测试：materializer 单测（bound 无 manifest 命名 / 有 manifest、未绑定、异根、空 plan 不命名 / 补物化后退出 advisory 且 detectFileConflicts 接管）+ assets 单测（bindAsset 回执 wiring）。
3. **[Minor] TUI 员工卡消费资产数据源** → `src/tui/render.js` dashboardPane 员工行消费 /api/agents botRow 的 `assetWarnings`（⚠ + 首条 title，黄）与 `assetTools`（🛠 计数，灰），置于「今日N轮」注记区；长警示由 composeLine 按 80 列预算 … 截断（行宽不破）。computeFrame 快照测试两例：徽章齐全+首条 only+双色 / 长警示截断 + 无数据行形状不变。
4. **[备案不改] doctor 漂移 `!` 不翻退出码** → 终审裁定维持（漂移=可修复降级态，退出码留给装配/连通性失败）；CHANGELOG Notes 记一行（plugins/core-engine/CHANGELOG.md）。

## 验证

- `npm test`：549 pass / 0 fail（改动后全量）。首轮 3 处测试断言写错（错误体 shape=`{error}` 非 `{message}`；选中行 SGR 合成 33;7 断颜色前缀）修正后全绿——实现代码零返工。
- 原路径复测：三条发现路径均以真表面重走——Important 走真 kernel HTTP PATCH（fake-kernel boot）；Minor-2 走真物化器钩子 + bindAsset 回执；Minor-3 走 computeFrame 纯函数快照（数据形状=botRow，与 /api/agents REST 测试同源锁定）。
- 触碰面：`plugins/core-engine/{api,assets,materializer}.js`、`plugins/core-engine/CHANGELOG.md`、`src/tui/render.js`、`test/engine/{assets-api,assets,materializer}.test.js`、`test/tui/render.test.js`、`task-w3t5-report.md`。并行 WIP 文件零触碰零提交。
- 未验证项：真终端里的 `wao tui` 目测未跑（computeFrame 纯函数快照 + 80 列行宽断言覆盖视觉契约，ANSI 配色码前缀已断言）；Minor-2 的 CDP/UI 面未重截（回执 warnings 为 API 面字段，无 UI 变更）。
