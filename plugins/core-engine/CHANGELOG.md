# Changelog

本插件版本史（Keep a Changelog 1.1 格式；版本号与 `manifest.version` 同步）。

## [Unreleased]

### Added

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

- W1 T2 `*Op` 重构的两处错误优先级回归（终审 Important）：`GET /api/timeline` 未知 bot +
  坏 window 组合回到 404 bot 优先（bot 存在性预检查回到 window 解析前，镜像 patchBotHandler）；
  `POST /api/bots/:id/test` provider 端口不可用 + 坏 JSON body 组合回到 400 provider
  unavailable 优先（端口预检查回到 body 解析前）。「HTTP 行为零变化」的承诺在这两个组合上
  恢复成立（plugin.test.js 锁定组合序）。

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
