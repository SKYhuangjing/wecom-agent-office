# W3-T1 评审修复报告（2026-11-07，评审裁定 mergeable with fixes）

## 结论

- Status: done — 1 Important + 4 Minor 全部落地，其余按裁定记 T2（见下）。
- Commit: `fix(assets): agents-face warnings, closed schema, docs sync`
- Tests: `npm test` 全绿 — 495 pass / 0 fail / 0 skipped（新增 5 个测试 + 2 处既有测试加钉）。

## 修复清单

1. **[Important] agents 面资产警示缺失** → `plugins/core-engine/api.js` botRow 新增 `assetWarningsOf()`：bot 含 memory 绑定（按**生效 plan** 计——被私发压制的 shared 条目与悬空绑定不物化、不警示）且 `state.materializer.memoryWarning(bot)` 判定命中（无 claudeConfigDir/codexHome/piAgentDir 类专属目录、非 dsh）→ 名册行带 `assetWarnings:['memory 共享 cwd：跨会话记忆可能被同目录其他会话互见']`。判定源与 bindAsset 回执同钩，T2 换真物化器两面同动。GET /api/agents、companyOps.agents、get_employee 三面共用 botRow 自动携带；`plugins/mcp-gateway/tools.js` list_employees 文本面加「↳ 资产警示：…」行并在工具描述声明。
   测试：`test/engine/assets-api.test.js`（ab1 无专属目录→警示；ab2 配 claudeConfigDir→无警示；解绑即清）+ `test/mcp/tools.test.js`（list_employees 文本+structuredContent+/api/agents 三处一致）。
2. **[Minor] DESIGN-ASSETS §8.1 表同步** → 绑定面行由「`PATCH /api/bots/:id`（assets 段）」改为专用端点 `POST /api/bots/:id/assets` / `DELETE /api/bots/:id/assets/:assetId`（bot POST/PATCH 直写 assets 一律 400 拒绝）；§0 变更记录追加「rev.2 实现勘误」一行；core-engine CHANGELOG 同步一条。精准 hunk，未触碰并行 WIP 文件。
3. **[Minor] content schema 闭合** → `plugins/core-engine/assets.js`：五类 content 未知键 400「unexpected key（<type> 仅接受 …）」；mcp server 按 stdio（command/args/env；`type` 保留既有专属文案、不双报）/ http（type/url/headers）闭键；ripgrep options 仅 extraHints（rtk 维持空占位规则）。测试：单测（五类 content 外键 + server 两形态外键 + stdio+type 不双报 + ripgrep options 外键）+ HTTP 面（mcp server 外键、prompt 附加键，均 400 带原样文案）。
4. **[Minor] 0600 测试钉** → `statSync(assets.json).mode & 0o777 === 0o600` 断言两处：`assets.test.js`（saveAssets 直写）与 `assets-api.test.js`（API 真实落盘）。
5. **[Minor] 一致性** → bindAsset/unbindAsset 物化失败不再 refreshRunner，与 rematerializeBots 统一为**仅成功刷新**，注释「runner 跟注册表真相——注册表 plan 落盘成功才换 runner，失败保上一好 runner、经 rematerialize 重试」；§8.1 表行序调和一行（校验→绑定落库存盘→物化失败入 failed[] 不回滚→仅成功轻量重 attach）。

## 记 T2 清单（不改码）

- T1 期落库的绑定（物化回执 skipped:'not-equipped'）在 T2 真物化管线上线时需**一次全量 rematerialize 扫尾**，把盘面从 skipped 态补齐。
- 「provider 无 materializeAssets 钩子→拒绑」未落地：T1 一切 provider 可绑（noop 回 skipped）；T2 落地 provider×type 支持矩阵时补该硬拒。
- 跨 bot 同文件冲突 / skill 外来守卫的**真判据**（§3.8 manifest diff、目标文件读取）仍为 noop 空答——T2 按 manifest 接线后生效。

## 验证

- `npm test`：495 pass / 0 fail（2026-11-07，node --test 全量）。
- 触碰面：`plugins/core-engine/{api,assets,CHANGELOG}*`、`plugins/mcp-gateway/tools.js`、`docs/DESIGN-ASSETS.md`、`test/engine/assets{,-api}.test.js`、`test/mcp/tools.test.js`。
- 未验证项：无（全部改动均有对应测试断言覆盖；无 UI/TUI 渲染面改动）。
