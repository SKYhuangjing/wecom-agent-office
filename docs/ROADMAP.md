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

## 搁置(Shelved)

- **第五 provider:CodeBuddy(WorkBuddy CLI)接入** —— **2026-11-07 裁定暂不启动(owner)**。
  根因:四诉求(cbc 引擎+API key+走 magpie+保留 login)不可能同时满足——magpie 无 cbc 原生协议路由,CLI 登录被付费墙挡住。
  **解冻条件与完整事实底稿见 [PROVIDER-RESEARCH.md](PROVIDER-RESEARCH.md) §4-§5**(任一解冻条件满足即可按 §5 草案重启,工程模板现成)。
