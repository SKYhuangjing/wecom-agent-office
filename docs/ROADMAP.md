# WAO Roadmap

> 维护约定:每项注明状态与裁定日期;细节一律链接到对应文档,本文不重复内容。
> 交接权威仍是 [HANDOFF.md](HANDOFF.md);里程碑级设计的 SDD 台账在 `.superpowers/sdd/`。

## 已交付(摘要,详见 HANDOFF §9 里程碑史)

| 交付 | 说明 |
|---|---|
| M1-M3(11-05~06) | 微内核+万物皆插件;三 provider+切换矩阵;Web UI+运维+生产切换 |
| 公司隐喻全站重设计(11-06) | 入职向导/离职面谈/打卡钟/头像即化身(4651eb6..149816f) |
| 拟人播报(11-06,00118a8) | progressStyle polite 默认,企微不露思维链 |
| W1 MCP 网关(11-07) | 13 公司工具,三家 CLI 经 MCP 操作公司;盲评零 P0/P1 |
| provider-pi(11-07,122d49d) | 第四技能部门,pi 1.5.0 经 magpie;盲评 P0 修复闭环 |
| office 视觉流(11-07,c95fb1f) | ui-office3d vendored three 重构 + ui-office-studio 白棚页 |

## 进行中

- **W2 TUI 运维仪表盘**(`wao tui`:打卡钟/员工卡/日志尾随/启停/广播/简版入职)——并行会话进行中,详见 [v2 计划](superpowers/plans/2026-11-07-wao-v2.md)

## 待启动

- **W3 资产系统**(skill/memory/MCP/prompt+工具类,per-provider 物化管线;RTK 并入)——设计文档先行,详见 [v2 计划](superpowers/plans/2026-11-07-wao-v2.md)
- **Token 优化产品化**(2026-11-09 PC1 生产实测沉淀 → **同日全量落地,723/723 绿**,详见 [DESIGN-TOKEN-OPT.md](DESIGN-TOKEN-OPT.md)):
  - ✅ P1-A 工具装备一键供给(「工具装备」卡:装备态+一键安装(SHA256 门禁/镜像回退/SFX/brew)+`/api/service/restart` 重启刷 PATH=--restart-only 更新器)
  - ✅ P1-B 省 token 装备包(seed 按 kind 判重+向导默认勾选+「省 token 装备包」chip+claude 新建自动专属 claudeConfigDir 含网关 settings 预拷)
  - ✅ P2-A 会话策略+记忆层(`sessionTtlMin` TTL 退役路由(默认 45min,0=永不);记忆蒸馏=四 provider footer 标记协议+distill 中间件剥标写回 memory 资产自动重物化)
  - ✅ P2-B test 探针轮回 usage 读数(方言归一,优化验证不等生产流量)
  - ✅ 附带:win-autostart 参数漂移修复(`planAutostartRefresh`)

## 搁置(Shelved)

- **第五 provider:CodeBuddy(WorkBuddy CLI)接入** —— **2026-11-07 裁定暂不启动(owner)**。
  根因:四诉求(cbc 引擎+API key+走 magpie+保留 login)不可能同时满足——magpie 无 cbc 原生协议路由,CLI 登录被付费墙挡住。
  **解冻条件与完整事实底稿见 [PROVIDER-RESEARCH.md](PROVIDER-RESEARCH.md) §4-§5**(任一解冻条件满足即可按 §5 草案重启,工程模板现成)。

- **provider-cursor 收尾(真 CLI 验证+生产转岗)** —— **2026-11-08 owner 暂缓登录**。
  已落地(fake 级全绿):插件三件套+契约 11/11+单测 16 项+UI 岗位+probe.sh/矩阵五家扩腿。
  唯一阻塞:`agent login` 浏览器动作(owner 暂缓;编辑器 token 移植已实测不可行,凭证域分离,见插件 CHANGELOG)。
  **解冻 = 登录(或 CURSOR_API_KEY)后跑 probe 基线校准 → 五家矩阵 → 盲评 → 生产转岗**,预计半天内收完。

## 设计备忘(记录在案,暂不排期)

- **记忆层外部系统集成**(2026-11-10 调研,详见 [MEMORY-RESEARCH.md](MEMORY-RESEARCH.md)):首选 scope-recall(MIT,536★,原生尊重 CLAUDE_CONFIG_DIR→per-bot 隔离零改动);路径 A 试点(per-bot 直装)→B 产品化(工具资产 kind,rtk 状态机同款)→C 网关层(magpie 插件,bot 隔离粗,远期);mem0 过重/basic-memory AGPL 不推荐。触发条件:WAO memory 资产条数逼近 50 上限或 FAQ 检索需求出现。


- **provider 凭证/模型目录层**(2026-11-08 讨论记录;**owner 裁定短期不需要**——magpie 支持统一代理,
  新 provider 走网关型路线即可零凭证入职,问题只在账号型 provider 上存在)。
  问题本质:provider 实际分两类——**网关型**(dsh/claude/codex/pi 经 magpie:凭证机器级、模型目录可查、
  入职零摩擦)vs **账号型**(cursor/cbc 直连:厂商登录态会过期、每账号模型目录+订阅档位、
  失败死在入职后的第一次岗前测试而非入职门口——pi 盲评 P0 与 cursor 接入同一病)。
  若将来触发,方案草案:provider 契约加三个可选钩子(`checkCredential()` 入职 fail-fast +
  `listModels()`/默认模型下拉,顺带消灭「模型字段手写 JSON」盲评遗留 + `describeAuth()` 登录引导),
  呈现面=设置页「引擎就绪」小节+doctor 同源;不做多账号池/配额追踪(YAGNI)。
  **触发条件:下一个无法走 magpie 的 provider 出现,或账号型 provider 积累到第二个**。

