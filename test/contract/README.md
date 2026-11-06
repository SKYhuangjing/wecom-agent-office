# test/contract — Provider 端口契约套件

对任意 provider 插件验证 DESIGN §5 端口契约（`createRunner().run()/readHistory()`：
结果形状、code 枚举、kill 升级、abort 带部分输出、事件时序、readHistory 容错、
disable 后无泄漏）。独立运行（秒级、真实子进程），刻意不在 `npm test` 的
`test/**/*.test.js` glob 内。

## 运行

```sh
npm run contract                                            # 默认 plugins/_template/provider（参考实现）
npm run contract -- --plugin plugins/provider-dsh           # T18 目标：全量断言
npm run contract -- --plugin plugins/provider-claude        # M2-T2 目标：全量断言
node test/contract/run.js --plugin <dir> [--port <portId>]   # 任意 provider 目录
```

退出码：有 FAIL → 1，全 PASS/SKIP → 0。报告逐组 `PASS/FAIL/SKIP <组> [细节]`，
末行 `X passed, Y failed, Z skipped`。

## 断言组

| 组 | 内容 |
|---|---|
| ok | code=completed、finalText、sessionId、ok=true；（fakeCli+events 时）tool 统一事件、prompt 经 stdin 原样送达 |
| thinking | `{type:'thinking', text}` 有载荷 |
| resume | 二次 run 传 sessionId → 回传同一 id；fake 的 last-argv 含 `--session-id <id>` |
| abort-partial | abort → aborted=true、finalText=部分输出、子进程 ESRCH 死透 |
| kill-escalation | SIGTERM 被忽略 → SIGKILL 升级，≤5s resolve 且子进程死透 |
| timeout | timeoutMs → code=timeout、子进程死透 |
| lock / credential | fake 的锁冲突 / 凭证错误 → 对应 code |
| history | readHistory 容错：缺文件→warnings；坏文件→warnings（默认 profile 下须与缺文件可区分）；超大→truncated（见下）。runner 缺 readHistory 方法或抛 not implemented = **FAIL**——唯一跳法是 profile `history:'deferred'` |
| event-timing | run() resolve 后 150ms 内无新事件 |
| disable-clean | deactivate 撤销端口；`getActiveResourcesInfo` 无 ChildProcess 残留、**非子进程句柄零残留**（套件侧噪声须具名豁免并附证据） |

## fake CLI 注入（fakeCli 类 provider）

`test/fake-bin/` 下每个 agent CLI 一个可编程 fake（`FAKE_MODE` 驱动 8 种行为：
ok/thinking/lock/credential/hang-sigterm/hang-timeout/partial-abort/resume-echo），
并把 `last-prompt`（stdin 原文）、`last-argv`、`last-pid` 写进 `$FAKE_HOME`。套件用
`/bin/sh` 包装脚本注入（export FAKE_MODE/FAKE_HOME 后 `exec` 对应 fake，pid 不变）；
profile 用 `fakeBin` 声明 exec 哪个 fake（dsh→fake-dsh.js，claude→fake-claude.js，
缺省 fake-dsh），provider 只需兑现自己的 `<cli>Bin` 配置并按该 CLI 的方式 spawn——
无需任何 env 透传支持。

## profile（test/contract/profiles.js，按端口 id 索引）

- `makeRunnerArgs({cwd, mode, fakeHome, wrapBin})`：把 fake 注入进 providerConfig（包装脚本名只带序号，不含 FAKE_MODE）
- `fakeCli` / `events`：声明能力缺位 → 相关组 SKIP（模板据此跳过进程组）
- `fakeBin`：该端口用的 fake CLI 路径（默认 fake-dsh.js）
- `history`：仅 `'deferred'` 一种取值可跳过 history 组（套件侧声明"真实 reader 未落地"）；
  **插件侧没有任何逃生门**——`capabilities.history=false`、runner 缺 readHistory、抛
  "not implemented" 一律 FAIL（模板的 stub reader 据此声明 deferred）
- `expect.okFinalText(prompt)`：ok 组 finalText 断言（模板是 echo，dsh/claude 固定 `答案文本`）
- `expect.resumeArg`：resume 组的 CLI 旗标断言（默认 `--session-id`＝dsh 拼法；
  claude 声明 `--resume`）
- `historyPath(cwd, sessionId)` + `hugeHistory(path)`：历史 fixture 约定——
  **dsh 会话文件位于 `<cwd>/sessions/<sessionId>.zst`**；
  **claude 会话文件位于 `<cwd>/claude-home/projects/<slug(cwd)>/<sessionId>.jsonl`**
  （真实布局 `<claudeConfigDir>/projects/...` 的定向重定向，profile 经
  `claudeConfigDir` 注入）。缺/坏两个 case 格式无关、恒跑；超大 case 需 provider
  真实格式，由 `hugeHistory` 钩子生成，未提供则该 case SKIP。

未登记端口的 provider 默认跑**全量**契约——能力缺位要显式声明，不允许静默跳过。
默认 profile 的 `historyPath` 是 **dsh 布局假定**（`assumedHistoryPath`）：别的布局
读不到坏文件 fixture，会以"缺文件"语义混过——套件用"坏文件 warnings 必须不同于
缺文件 warnings"把它变成显性 FAIL；正确做法是给该端口登记带真实 `historyPath`
的 profile。

## T18（provider-dsh）对接状态

已落地（11/11 全绿，0 skipped）：runner 兑现 dshBin spawn / SIGTERM→SIGKILL 升级 /
exit 3+stderr→lock-conflict / error 事件→missing-credential / `--session-id` resume
argv / 统一事件映射（tool 的 brief 含命令摘要）；readHistory 按 `sessions/<id>.zst`
约定读取，`hugeHistory` 钩子用 node:zlib `zstdCompressSync` 生成 3 帧 zstd × 2500
轮的真实格式 fixture。

## M2-T2（provider-claude）对接状态

已落地（11/11 全绿，0 skipped）：runner 兑现 claudeBin spawn（`-p --output-format
stream-json --verbose`，prompt 走 stdin）/ stream-json 映射（init→session、content
块 text/thinking[.thinking]/tool_use→统一事件、thinking_tokens 噪声丢弃、
result.subtype==='success' 判成功）/ `--resume` argv / kill 升级 / abort 语义与 dsh
同构；readHistory 按真实布局 `<claudeConfigDir>/projects/<slug(realpath cwd)>/
<sessionId>.jsonl` 解析（claudeConfigDir 可重定向，macOS /tmp realpath 陷阱已防），
`hugeHistory` 钩子生成 2500 轮真实 jsonl fixture。锁冲突文案 M3 前未知：fake 用合理
猜测文本，runner 正则带通用兜底。
