# Provider 候选调研 与 CodeBuddy(WorkBuddy CLI)深潜

> 调研日期:2026-11-07(§3.6 补充于 11-08)｜裁定:**第五 provider(CodeBuddy 接入)暂不启动**(owner 裁定,见 §4)｜
> 关联:[ROADMAP.md](ROADMAP.md) 搁置项｜本文是重启时的完整事实底稿,引用的本机实测均标注来源。

---

## 1. 背景与评估口径

WAO 现有四家 provider:dsh / claude / codex / pi(复制即契约,契约套件 11/11×4)。新增一家需满足 DESIGN §5 端口契约:

| 维度 | 要求 |
|---|---|
| 非交互 | headless 模式(prompt 可经 stdin/argv) |
| 流式事件 | JSON/NDJSON 事件流 → 统一事件(session/text/thinking/tool) |
| 续会话 | sessionId 回显、`--resume`/`--session` 语义 |
| 只读历史 | 会话文件落盘、路径可推导(history.js 容错三件套) |
| 网关路由 | 可指 magpie(127.0.0.1:3425,统一记账)或自有凭证 |
| 无人值守 | 自动批准/权限 flag;exit code 与流内判据 |

## 2. 候选总览(2026-11-07 扫描)

| 候选 | headless/流式 | 续会话 | 本机 | 网关 | 结论 |
|---|---|---|---|---|---|
| **OpenCode**(sst) | `opencode run --format json`(原生 JSON 事件)+ `-s <id>`/`-c`/`--fork`/`-m provider/model`/`--dir`/`--agent` | ✓ | **✓ 已装 1.18.31(零配置)** | models.dev 目录 + opencode.json 自定义 provider → magpie 直连;/v1 已列 `workbuddy/*` 模型 | **候选池第一名**;风险:headless "Session not found" issue(#28407)待探针 |
| **Qwen Code**(阿里,gemini fork) | `-p` + `--output-format json/stream-json` | `--resume` | 未装 | Qwen OAuth 免费档(2000 次/天) | 备选;无官方文档页,旗标靠 fork 同源推断 |
| **Gemini CLI**(google) | `-p` + `--output-format stream-json` + `--approval-mode` | `--resume`(新版已补) | 未装 | `GOOGLE_GEMINI_BASE_URL`;走 magpie 需验 openai-compat | 备选 |
| **Kiro CLI**(AWS,Q CLI 后继) | 官方 headless:`--no-interactive` + `--output-format stream-json` + `KIRO_API_KEY` | 有 | 未装 | magpie 已有 kiro 上游;网关路由待验 | 备选 |
| **Factory droid** | `droid exec -o stream-json`(**逐字段兼容 claude stream-json**,移植成本最低) | 有 | 未装 | 需 Factory 账号 | 备选 |
| Cursor CLI | `-p` + `--output-format stream-json` | `--resume <chat-id>`/`-c`/`agent ls` | 未装 bin,但**本机用过**(~/.cursor/agent-cli-state.json 有 worker 记录含 workbuddy_workspace) | **闭源网关,CLI 无 base URL 覆盖**(论坛确认,IDE 的 OpenAI Base URL 覆盖不作用于 CLI)→ 无法走 magpie;但**订阅池共享**(CLI 用量=Cursor 订阅同一池,无独立付费墙,`agent login` 或 CURSOR_API_KEY 即用)——见 §3.6 | **可接入(不经 magpie)**;2026-02 有 print 模式掉回交互 UI 的 bug 报告,需探针 |
| GitHub Copilot CLI | `-p` 有;JSON/续会话无文档,2026-10 仍有 headless 中途 exit 0 bug | 弱 | 未装 | GitHub 账号 | ✗ |
| Crush(charm) | `crush run`(非交互即 yolo);结构化输出仍在 issue 阶段(#1862/#796) | 有 | 未装 | OpenAI 兼容可配 | 观望(输出格式未定型) |
| Goose(block) | `goose run -t --output-format json` | recipe/session | 未装 | OpenAI 兼容可配 | 观望 |

## 3. WorkBuddy / CodeBuddy 深潜(本次主体)

### 3.1 产品关系与 CLI 本体

- **WorkBuddy = 腾讯 CodeBuddy 的桌面 agent**:国内版(China build,CodeBuddy 计划)API `https://copilot.tencent.com/v2`;国际版 WorkBuddy AI `https://www.workbuddy.ai/v2`。本机装有 `WorkBuddy.app` **5.9.3** 且已登录。
- **它的 CLI = `@tencent-ai/codebuddy-code` v2.181.0**(bin:`cbc` / `codebuddy`),Claude Code 同构;未全局安装,npx 可验。
- **桌面端把 cbc 当引擎拉起**:bundle 内 `CODEBUDDY_HOST=workbuddy-desktop` 宿主信号;本机 `~/.codebuddy/` 有 `.settings.json.workbuddy.lock`(桌面实时写入)——桌面与 CLI 共享同一状态目录。

### 3.2 CLI 接口体检(实测 `--help`,2026-11-07)

| 契约项 | cbc 提供 |
|---|---|
| 非交互 | `-p/--print` |
| 流式事件 | `--output-format text\|json\|stream-json` + `--include-partial-messages`(SSE 增量);`--input-format stream-json` |
| 续会话 | `-r/--resume [sessionId]`、`-c/--continue`、**`--session-id <uuid>`(确定性 id)**、`--resume-create-missing`(会话丢失兜底) |
| 历史 | `~/.codebuddy/…`(bundle 内 100 处 jsonl 引用,claude 同款布局;确切 slug 未验证——需一次真跑) |
| 无人值守 | `--subagent-permission-mode`(acceptEdits/bypassPermissions/default/plan/dontAsk/auto)、`--fallback-model` |
| 模型 | `--model` 目录:`deepseek-v4.1-flash / glm-5.3-flash / glm-5.3 / glm-5.2 / hy3 / hy4-preview / kimi-k3 / gpt-5.6-sol…`(与 magpie workbuddy 路由组同款 id) |
| 其他 | `-H` 自定义头、`--no-session-persistence`、`-w/--worktree` |

### 3.3 认证链(bundle 实证)

`CODEBUDDY_AUTH_TOKEN` env → settings `apiKeyHelper`(命令产 key)→ `CODEBUDDY_API_KEY` env → 登录态(login session)。API key 发送形态:`X-API-Key` + `Authorization: Bearer` + `X-User-Id: anonymous_<key 尾 8 位>`(与 @magpie-community/opencode-workbuddy-auth README 描述逐字吻合)。支持 **`CODEBUDDY_BASE_URL`**(settings env / process.env 双通道,21 处引用)——但见 §3.5,magpie 侧无对接路由。

### 3.4 订阅复用分析(核心问题:"cbc 能复用 workbuddy 的订阅吗")

**结论:能——订阅绑腾讯账号不绑端;但"直读桌面 token"是死路,三条正路如下。**

1. **桌面 token 直读:不可行(实测)**。`~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info` 中 accessToken/refreshToken 均为 **`$wbEncrypted` 信封**(suite:1 + keyId `9127dea1…` + nonce + authTag + ciphertext,AES-GCM 族);WorkBuddy **5.6+ 加密,只有 app 自己能解**(magpie 插件 README 明示)。cbc bundle 认得信封格式(`isStandardEncryptedFieldWrapper`)但密钥在 app 侧。
2. **路 A:CLI 自行登录同一账号**(最干净)——`cbc /login` 浏览器授权 → 独立 token 落 `~/.codebuddy/`,同账号同订阅。⚠️ **owner 实测反馈:CLI 登录/使用疑似需要付费计划,owner 未付费,此路当前不通。**
3. **路 B:API key**——`workbuddy.cn/profile/keys` 造 `ck_`/`pt_` key → `CODEBUDDY_API_KEY` env → cbc 直连 `copilot.tencent.com`。未证项:①无付费计划能否造 key ②key 用量是否扣现有订阅额度(magpie 插件 README:"WorkBuddy's own client reads none with a key"——自家 client 对 key 读不到用量,需真调用后到桌面用量页对账)。
4. **路 C:desktop 拉起模式**(`CODEBUDDY_HOST=workbuddy-desktop` + 宿主注入凭证)——app 内部机制,WAO 不可用。

### 3.5 magpie 侧事实(2026-11-07 实测)

- magpie 的 **workbuddy / workbuddy-ai 上游已是 OAuth 登录态**(`plugin-auth.json`:type oauth + refresh token,`@magpie-community/opencode-workbuddy-auth` 托管、自动刷新)——即 **magpie 侧已"登录"workbuddy,复用现有订阅无需任何新凭证**。
- `/v1/models` 已列出 `workbuddy/hy3`、`workbuddy/deepseek-v4.1-flash`、`workbuddy-ai/gpt-6-luna` 等(OpenAI 兼容面)。
- **magpie 没有 cbc 原生协议的入口路由**:`/backend-api/codebuddy`、`/backend-api/workbuddy`、`/v2`、`/codebuddy`、`/workbuddy/v2` 全部 404(codex 有 `/backend-api/codex` 先例,cbc 无对应物)。→ **cbc 无法走 magpie**。

### 3.6 Cursor CLI 补充深潜(2026-11-08,用户问询触发)

CLI 现名 **`agent`**(原 `cursor-agent`),安装 `curl https://cursor.com/install | bash`。

- **接口**(官方 docs):`-p` + `--output-format text|json|stream-json`(事件族 system/init、assistant、tool_call started/completed、result{duration_ms})+ `--stream-partial-output` 增量;`--resume <chat-id>`/`-c`/`agent ls`;`--force`/`--yolo` 免确认;`--mode plan|ask`;`--sandbox`;MCP 经 mcp.json 自动发现;`agent acp` 可作 ACP server。
- **认证**:`agent login`(浏览器,凭证存本地)或 `CURSOR_API_KEY` env / `--api-key`(cursor.com/settings → Integrations 造 key)——套 WAO apiKeyEnv 注入纪律(codex 同款)。
- **订阅语义(与 CodeBuddy 的本质区别)**:CLI 用量是 Cursor 订阅的一部分,**编辑器/CLI/Cloud Agents 共享同一用量池**,无独立 CLI 付费墙——有 Cursor 账号(含免费档)即可 login 使用。⚠️ 未证:owner 账号档位(免费限额小,Pro 大池)——本机文件读不出,登录后可知。
- **magpie 死路(同 CodeBuddy)**:CLI 无 base URL 覆盖——官方论坛确认(2025-09 thread 133409)无 `CURSOR_API_BASE`/`--base-url`;IDE 的 "Override OpenAI Base URL"(Merge.dev/AgentGateway 等网关依赖的入口)只作用于编辑器;也不认 `ANTHROPIC_BASE_URL`。绕法仅 HTTP 代理截流,不建议。
- **本机痕迹**:Cursor.app 3.29.9 已装;`~/.cursor/agent-cli-state.json` 有跨项目 workerIds(含 workbuddy_workspace)——CLI 曾在此机运行过,即当时已通过认证;cli-config.json(vimMode/permissions)也在。
- **结论**:**可接入为第五 provider**(engine=agent,直连 cursor.com,凭证 apiKeyEnv,runner 移植自 provider-claude),代价=用量不进 magpie 统一记账;风险=2026 年论坛仍有 print 模式掉回交互 UI 的 bug 报告,探针时验。是否启动待 owner 裁定(roadmap 未列)。

## 4. 裁定(2026-11-07)

Owner 原始诉求四条:**cbc 引擎 + WorkBuddy API key + 走 magpie + 保留 login 入口**。

根因:**四诉求不可能同时满足**——"走 magpie"与"cbc 引擎"互斥(magpie 无 cbc 协议路由);"API key"只在 cbc 直连形态有意义(经 magpie 的 OpenAI 兼容面不需要 key,magpie 本地不校验 caller);"login 入口"被付费墙挡住(owner 未付费)。

备选形态曾被提出并否决/搁置:
- opencode 引擎 + magpie 路由(pi 模式,零新凭证,统一记账)——owner 未选;
- cbc 直连 + API key(不经 magpie)——owner 未选;
- **裁定:整个需求暂不启动。**

## 5. 解冻条件与重启草案

任一满足即可重启:
1. **magpie 出 cbc 协议透传路由**(类比 `/backend-api/codex`)→ 四诉求全满足;
2. owner 接受 **cbc 直连 + API key**(放弃 magpie 记账)→ 先实测:造 key(验付费墙)→ 一次真调用 → 桌面用量页对账额度归属;
3. **付费计划解锁 `/login`** → 路 A 直接成立(仍不经 magpie);
4. 或改选 **opencode + magpie**(候选池第一名,随时可做)。

重启时按复制即契约全流程:装 CLI → 真调用探针(stream-json 形状/session id 回显/错误三去向/额度对账)→ fake-bin → 契约 11 → 切换矩阵扩腿 → 盲评 → kickstart。工程模板现成:provider-claude(stream-json 同构)与 provider-pi(models.json 物化/`$ENV` 凭证)两份可复制。

## 6. 参考

- 本机实测:cbc `--help`(npx @tencent-ai/codebuddy-code 2.181.0)、bundle 抽取(auth 链/`$wbEncrypted`/`CODEBUDDY_HOST`)、`workbuddy-desktop.info` 信封结构、magpie `plugin-auth.json`/`/v1/models`/路由 404 探测
- magpie 插件:`~/.config/magpie/plugins/node_modules/@magpie-community/opencode-workbuddy-auth/README.md`(认证三法/key 发送形态/5.6+ 加密说明)
- 外部:opencode CLI docs(https://opencode.ai/docs/cli)、Kiro headless(https://kiro.dev/docs/cli/headless)、droid exec(https://docs.factory.com/droid-exec/overview)、Copilot CLI 参考(https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)、crush #1862/#1030、opencode #28407
