# provider-dsh（DSH Provider）

第一个**真实** provider 插件：通过 `dsh --profile P --json -` 子进程驱动
DeepSeek Harness，兑现 DESIGN §5 端口契约。前身是 wecom-bridge / wecom-bots
里的生产代码，本插件是它的内核化移植。

## 结构

| 文件 | 职责 |
|---|---|
| `plugin.js` | 端口注册：manifest / configSchema / validate / materializeConfig / describeError |
| `runner.js` | 子进程驱动：spawn argv、NDJSON→统一事件、code 映射、SIGTERM→SIGKILL 升级 |
| `profiles.js` | 每 bot dsh profile 物化（atomicWrite 原子写、抛错保留 last-good） |
| `history.js` | 会话历史只读：zstd 多帧解码 + 轮次解析（`{turns, truncated, warnings}`） |

## 要点

- **成功判据**：exit 0 且 `status{phase:'turn_end'}.reason.kind==='completed'`
  （rc.5 起结果在 status 事件上，不在 final——前身实测注释已移植）。
- **kill 升级**（评审 P0）：abort/timeout 先 SIGTERM，`escalationMs`（默认 3s，
  createRunner 可注入）内未死则 SIGKILL，**只在 'close' 后 resolve**——僵尸子进程
  持会话写锁是已知事故类。
- **code 映射**：abort→`aborted`；超时→`timeout`；stderr/error 命中
  `already owned by an active write handle|SessionAlreadyOwnedError|writer-held`
  →`lock-conflict`；`MISSING_CREDENTIAL|no API key`→`missing-credential`。
- **sessionId 契约**：新会话首轮不传→回传新 id；resume 未回显→原样返回输入 id；
  **首 session 事件前被 abort/超时→返回 null**（半写会话不入缓存，引擎侧另有双保险）。
- **历史路径**：先查 `<cwd>/sessions/<id>.zst`（契约套件约定），再查真实 dsh 布局
  `~/.dsh/sessions/<cwdEscape(cwd)>/session-<id>/session.v4.jsonl.zstd`
  （`DSH_HOME` / `providerConfig.dshHome` 可重定向）。

## 验证

```bash
node --test 'test/provider/**/*.test.js'          # 单元格（fake-dsh 注入）
node test/contract/run.js --plugin plugins/provider-dsh   # 契约套件：应全绿
bash test/smoke-dsh.sh                            # 真 dsh 冒烟（无 dsh 时自动跳过）
```
