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
