# provider-pi

pi coding agent(`pi` CLI,@earendil-works/pi-coding-agent)作为技能岗位的 provider 插件。
复制即契约的第四家(前作 provider-dsh/claude/codex);spawn/NDJSON/kill 升级链/错误码映射
与三家同构,差异只在 CLI 调用与事件解析。

## 驱动方式

```
pi -p --mode json [--session <id>] [--thinking <lvl>] --provider <p> --model <id> [piArgs…]
```

- prompt 走 **stdin**(新旧腿皆可,探针实测);续接 `--session <partial-uuid>`,首事件
  `session` 回显同一 id。
- **exit 0 ≠ 成功**:模型全败时 pi 仍 exit 0(流内 assistant `message_end
  stopReason:'error'` + `auto_retry_end{success:false, finalError}`,错误文本只在
  retry 事件里)。成功判据 = exit 0 且最后 assistant `stopReason==='stop'`。
- 网关路由:materializeConfig 写 per-bot models.json(`$PI_CODING_AGENT_DIR/models.json`,
  默认 `~/.pi/agent-wao-<botId>/`),声明 baseUrl/api,**apiKey 只写 `"$变量名"`**
  (`$` 前缀承重——裸名会被当成字面量),密钥字面量由 runner 经 apiKeyEnv 注入,不落盘。
- 会话历史:`<piAgentDir>/sessions/<cwdSlug>/<ts>_<sessionId>.jsonl`(JSONL
  `{type:'message',message:{role,content}}`),history.js 只读解析。

## providerConfig 一览(与 configSchema 同步)

| 键 | 说明 |
|---|---|
| `cwd`(必填) | 作业目录;决定会话文件的 cwd slug 归属 |
| `model`(必填) | `{model 必填, apiKey?, apiKeyEnv?, contextWindow?, maxTokens?}` |
| `provider` | models.json 里的 provider 键名(默认 `magpie`) |
| `baseUrl` / `api` | 网关地址/协议(默认本机 magpie / anthropic-messages) |
| `thinking` | off/minimal/low/medium/high/xhigh/max(off 时省略 flag) |
| `piArgs` | 额外 CLI 参数(逐项原样追加) |
| `apiKeyEnv` | 凭证环境变量名(默认 `PI_MAGPIE_API_KEY`) |
| `piBin` | pi 可执行文件(默认 `pi`) |
| `piAgentDir` | agent 目录(默认 `~/.pi/agent-wao-<botId>`;删除机器人只清 models.json,sessions/ 会话数据保留) |
| `env` | 注入子进程的环境变量 |
| `progressStyle`/`progressText` | 播报(与其他三家同参,core-engine 消费) |

## 实测事实(2026-11-07,pi 1.5.0,探针基线在 `test/probe-baselines/pi*.ndjson`)

- resume 三腿同 id 回显、记忆延续(resume-of-resume 也稳)。
- GLM 经 magpie(anthropic-messages)会回 **thinking 块**(runner 映射为 💭,finalText
  只取 `text` 块)。
- magpie 对 localhost **不校验 caller key**——missing-credential 无法真机触发,靠正则
  +fake 层锁定(与 codex 锁文案同款闭案)。
- 带斜杠的模型 id 必须配 `--provider`,否则被解析成 provider/model 硬报错。

## shell 超时护栏(2026-11-12)

pi 的 bash/powershell 工具 timeout 参数无默认值——模型不带参数的命令(实测 `find /`)可挂满引擎 30 分钟硬帽。防护两层:

- **本插件层**:materializeConfig 落盘 `extensions/wao-shell-guard.js`,runner 恒加 `-e` 加载并注入 `WAO_BASH_TIMEOUT_SEC`;`providerConfig.bashTimeoutSec`(默认 90)即上限,缺省填充+超上限钳制,bash/powershell 双覆盖。
- **引擎层**:`providerConfig.hardTimeoutMin`(core-engine)per-bot 收紧单轮硬帽(会话型 bot 建议 8-10)。

Windows 提示:pi 另有原生 powershell 工具(优先 pwsh 7),`piArgs: ["--tools","+powershell"]` 可加配——超时护栏同样覆盖它。
