# Changelog

本插件版本史（Keep a Changelog 1.1 格式；版本号与 `manifest.version` 同步）。

## [Unreleased]

### Added

- rtk 工具资产装备执行器（W3 T3，DESIGN-ASSETS §7.1）：新写计划型 `rtk-init`（providers 纯计划
  `{target, flavor}`，本执行器独占外部命令执行）——探测（unavailable：绑定保留零产物，notes+
  agents `toolWarnings` 指引安装）→ dry-run 采集将写路径→§8.3 前缀校验（符号链接规范化后比较，
  白名单=允许根∪rtk 自有域 `~/Library/Application Support/rtk`、`~/.config/rtk`）→ 真跑（claude
  `--auto-patch --no-trust-filters` 免交互）→ 回读断言（hook 条目全文进 manifest.entries，
  `via:'rtk'`）→ install 期 `.bak` 清扫；dry-run 非零/越界→回退路径（claude/codex WAO 自写 JSON
  hook 条目=§3.6 条目型；pi 无 JSON hook 面=failed 不伪造版本耦合的 extensions/rtk.ts）；真跑非零→
  throw（回执 failed[]，stderr 摘要）。卸载=`rtk init --uninstall`（V5 实证三 flavor 尊重重定向且
  幂等）+ rtk 缺失/非零时条目精确匹配删兜底 + `.bak` 清扫；rtk 仍绑定期间其条目不进 stale 清理
  （rtk init 幂等重跑）。rtk 态（armed/unavailable + version + mode）与 §7.2 ripgrep 预检结论同记
  manifest 新增 `tools` 数组。`rtkBin` 可注入（plugins.json `core-engine.options.rtkBin`/
  `$WAO_RTK_BIN`）。checkBind：pi 无 piAgentDir 时默认目录 `~/.pi/agent-wao-<botId>`（per-bot
  命名空间，非共享主目录）放行 rtk；claude/codex 共享目录仍拒。
- 资产回执 notes 线程（§3.2）：bind/unbind/rematerialize 回执携带物化 notes（rtk unavailable/
  rg 未装等装备注记随回执出）；agents 名册 `assetWarnings` 扩 `toolWarnings` 面（rtk/rg 缺失常驻
  警示，判定源同物化器）。
- 资产物化管线执行器（W3 T2，DESIGN-ASSETS rev.2 §3）：新模块 materializer.js 替换 T1 noop——
  provider 侧 `materializeAssets` 纯计划（file-create/marker-section/hook-entry/argv 四型写计划），
  本执行器统一持有盘面纪律：§8.3 越狱防护（bot 声明目录+data/ 白名单、`..` 段拒绝）、§3.4 标记节
  替换与孤儿四态检测（单侧标记/双侧全删留残/节外 wao- 表/他 bot 命名空间拒改）、§3.7 原子写+快照
  逆序回滚、§3.8 manifest（planFingerprint/writes/entries/lastResult 全字段，失败保留上一好清单）、
  §3.6 精确卸载（skill x-wao-asset 守卫、标记节剥节保外文、JSON 条目精确匹配删/不匹配告警不删）、
  §3.5 dryRun 只读回验、启动扫尾（manifest 缺失=T1 skipped 态→一次全量重物化；此后只读回验报
  doctor 不自动改写）。V 项实证结论（V1/V2/V7/V8/V9，§9）写入代码注释。
- 端口接线：createRunner 增 `assets` 生效计划（§3.1，manifest 目标富集——mcp/skill 文件路径随行）；
  materializeConfig 增 `assets` 透传（dsh 单一组合器契约）；「provider 无 materializeAssets→拒绑」
  落地（§2.3）；跨 bot 同文件冲突按 manifest 判定；bot PATCH 改 providerConfig 后带绑定的 bot 重物化。
- 资产注册表与双面 API（W3 T1，DESIGN-ASSETS rev.2 §2/§4/§8）：新模块 assets.js——
  `data/assets.json` 注册表（atomicWrite/0600 纪律同 bots.json）、五类资产内容校验
  （slug 统一禁点、控制字符、原型污染键、体积上限、mcp 单 server 恰一形态、sse/ws
  与 URL 内嵌凭据拒绝文案、(type,name) 唯一）、mcp env/headers 按位置全掩（`__MASKED__`
  同位置回传保库值，strip 形键名防误删回填）、绑定模型存 bots.json（exclusive 快照
  +snapshotVersion/snapshotType/snapshotName）、§2.3 冲突矩阵校验链与
  bindAsset/unbindAsset 回执。物化管线经可注入 `materializer` 接口（T1 noop：
  `{writes:[], skipped:'not-equipped'}`，绑定校验钩 checkBind/外来守卫/跨 bot 同文件
  检测留好——T2 换真实现）。
- /api 资产路由（HTTP+companyOps 双面同源）：GET/POST /api/assets、GET/PATCH/DELETE
  /api/assets/:id（PATCH shared 扇出回执 {rematerialized,failed}，DELETE 回执
  {removedBindings,keptExclusive,…}）、POST /api/bots/:id/assets、DELETE
  /api/bots/:id/assets/:assetId、POST /api/bots/:id/rematerialize-assets；GET /api/bots
  回显绑定摘要（name/type/mode/exclusiveBehind/sourceDeleted，不含内容）；bot
  POST/PATCH 拒绝 assets 直写（走专用绑定面）；bot DELETE 追加 removeAssets（尽力而为）。
- companyOps 增 6 面（MCP 写面分级 §8.1）：createAsset 强制 origin:'mcp'；updateAsset/
  deleteAsset 对配发（非 Agent 自建）资产 403 只读指引；bindAsset/unbindAsset/
  rematerialize 与 REST 同函数。mcp-gateway 工具面注册 create_asset/update_asset/
  delete_asset/bind_asset/unbind_asset/rematerialize（危险级带后果确认文案）。
- 轻量重 attach（plugin.js refreshRunner）：绑定/资产变化仅换 runners 表项，不 drain
  不重建 adapter，在跑 run 持旧 runner 跑完（§3.2）。
- W3 T1 评审加固：agents 名册行回显 `assetWarnings`（memory 绑定且无专属 config 目录的
  bot 标「共享 cwd」警示，判定源=materializer.memoryWarning，REST 与 list_employees 同步）；
  五类 content 闭键（未知键 400「unexpected key」，mcp server 按 stdio/http 形态、
  ripgrep options 同闭）；bind/unbind 物化失败不再 refreshRunner（与扇出统一为仅成功刷新，
  runner 跟注册表真相）。
- `companyOps` 服务（W1 T2）：api.js 各路由的业务核心抽为同文件 `*Op` 函数并经
  `companyOps(state)` 发布到 services 容器（含 `sanitize` 与只读 `botDetail` 聚合），供
  mcp-gateway 插件按次取用——REST 与 MCP 工具共用同一函数源，HTTP 行为零变化。
- 拟人播报（`progressStyle`，2026-11-06 owner 决策默认翻转）：企微进度行默认只播报一句
  「{bot} 思考中… 请稍等（已 N 秒）」（呼吸点按出帧序 . → .. → ... 循环），不再出现任何
  思维链/工具参数/正文预览内容；心跳帧同模板。`progressText` 可配文案（占位符
  `{bot}/{dots}/{elapsed}/{step}`，≤120 字超长 400）。`progressStyle:'cot'` 保留旧 §6.1
  详细汇报；`progressCoT` 降级为废弃兼容别名（仅 cot 风格内抑制 💭，不再能翻回详细汇报）。
  timeline（本地工作日志）照旧收全量 thinking/tool 事件——仅收窄企微出站面。

### Fixed

- v2 终审修复（1 Important + 2 Minor，2026-11-07）：
  **Important（共享资产 PATCH 结构键不可变）** PATCH /api/assets/:id 对存在任一 shared 绑定的资产，
  改 skill `content.name` 或 mcp serverId 集合（改名/增删均算）→ 400「该资产有配发绑定，改名需先解绑
  （避免跨员工文件冲突）」——此前 eager 扇出的 file-create 会静默覆盖共享根目录里其他 bot 已物化的同名
  文件（§2.3 绑定时冲突矩阵不会在 PATCH 上重跑）。同结构键的内容编辑仍走原扇出；exclusive-only 资产
  可改名（快照语义本就不扇出，§6）。
  **Minor（无 manifest 共根 bot 漏比对）** 新物化器钩子 `detectUnverifiedSharedRoots(bot, plan, allBots)`
  （noop 答空）：跨 bot 同文件冲突检测以 manifest 为唯一数据源，共根但无清单的绑定 bot 此前被静默跳过
  ——现于 bind 回执 warnings 提示「先对其 POST rematerialize-assets（或人工核查其目录）」，重物化后
  真实 manifest 比对接管；data/（引擎内部域）不计入共享面根。
  **Minor（TUI 员工卡资产徽章）** `wao tui` 仪表盘员工行消费 /api/agents 的 `assetWarnings`
  （⚠ + 首条 title，黄）与 `assetTools`（🛠 计数，灰），长警示按 80 列预算 … 截断。
- 资产物化评审修复（W3 T2 review，3 Critical + Minor 1/4/5）：
  **Critical 1** pi 默认 agent 目录（`~/.pi/agent-wao-<botId>`，piAgentDirFor 公式内联，同 DSH_HOME 先例）
  补入 §8.3 越狱防护白名单——默认目录 pi bot 的绑定此前落库后物化必败；
  **Critical 2** codex TOML 值转义补 `\n`/`\r`/`\t`（注册面放行换行，未转义产物=非法 TOML 静默毒化宿主
  config.toml），SKILL.md frontmatter description 四家统一改 JSON.stringify 落 YAML（含冒号/换行安全）；
  **Critical 3** 启动扫尾（startupSweep）在 attach 之后跑——迁移成功的 bot 由扫尾后逐个 refreshRunner
  重铸，文件目标富集在首个进程周期生效；**Minor 1（owned 真值）** manifest 的 owned 改记「写入时文件
  是否不存在（或上一好清单已归我）」——宿主文件（用户自建 CLAUDE.md/AGENTS.md/config.toml）记 false，
  卸载只剥节不整删，剥空的宿主文件保留，verify 孤儿判定对剥节后的宿主文件不再误报；
  **Minor 4** 资产校验拒收正文中的 wao 标记行模式（`wao:assets:…:vN`，400 指名字段——自造 §3.4 漂移）；
  **Minor 5** 启动回验遇 provider 端口缺失改为 log.warn 指名 botId+原因（原先 drift/orphans 双空静默跳过）。
- W1 T2 `*Op` 重构的两处错误优先级回归（终审 Important）：`GET /api/timeline` 未知 bot +
  坏 window 组合回到 404 bot 优先（bot 存在性预检查回到 window 解析前，镜像 patchBotHandler）；
  `POST /api/bots/:id/test` provider 端口不可用 + 坏 JSON body 组合回到 400 provider
  unavailable 优先（端口预检查回到 body 解析前）。「HTTP 行为零变化」的承诺在这两个组合上
  恢复成立（plugin.test.js 锁定组合序）。

### Notes

- v2 终审备案：doctor 资产漂移行（`!` 标记 + rematerialize 修复指引）**不翻退出码**（仅 `✗` 计数
  bad）——裁定维持：漂移是「可修复的降级态」而非「装配/连通性失败」，退出码保留给后者；修复路径是
  POST /api/bots/:id/rematerialize-assets，不改。
- 评审 Minor 2（atomicWrite 落盘 0600 权限归零）**不改**：0600 是设计背书的原语（data/ 纪律、
  密钥红线），宿主侧文件本就不该由 atomicWrite 承载组/其他权限。
- 评审 Minor 3（cleanupEmptyParents 至多 6 层空目录攀爬）**不改**：极低频路径，且攀爬以
  allowedRoots 为止点、仅删「确实为空」的目录；如需收紧改「仅删 WAO 命名空间目录」另立任务。

## [0.1.0] - 2026-11-06

初始发布。

### Added

- 台账 + 会话缓存：consumedSeq 规约保证跨 provider 交接正确性（反例 A/B 以测试锁定），撕裂台账尾封口后重算。
- timeline 环形缓冲：轮次事件留痕供 UI 时间线消费（run/ledger SSE emit）。
- 语义化进度器：思维链分句上屏（滞回 + 上行脱敏掩码）。
- 按 chatKey 串行链：队列合并、latest-wins 抢占结算、两阶段 10 分钟截止的轮次编排。
- 插件装配与 bots 注册表：业务 API 与插件 reconcile、facade/progressCoT/validate/enter_chat 接线义务。
- removeConfig provider 钩子：DELETE /api/bots 一并清理落盘的 dsh profile。

### Fixed

- allowedUsers 强制校验、provider 切回持久化、per-bot drain（拒绝后如实回答）、data 目录 0600、四阶段关停韧性。
- claudeConfigDir env 注入、超时上限提升、文档/schema 对齐（M2 终审跟进）。
- 脱敏密钥回显、SSE 防抖、shell 错误呈现、计时窗口、Safari 兼容审计（已知边界波）。
