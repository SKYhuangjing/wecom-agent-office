# Windows 安装与运维手册（zip 免管理员路线）

> 2026-11-09 在两台干净 Win11 机器（提单测试电脑1/2，无 git、无 Node、无管理员
> 权限）全链路实装沉淀。快速路径用 `scripts/win-install.ps1`（本文坑位它的每一
> 步都替你处理了）；手工排障按 §2 逐条对。

## 1. 一条命令安装（推荐）

在有网可达的 Windows 上，任意 PowerShell 里跑（`Set-ExecutionPolicy -Scope Process
Bypass -Force; & .\win-install.ps1` 最稳——PS 5.1 默认禁 `.ps1`，`iex` 对
`(New-Object Net.WebClient).DownloadString(...)` 形态会 ParserError）：

```powershell
# 把 <URL> 换成本仓库 scripts/win-install.ps1 的 raw 地址；内网慢可加 -Mirror http://<局域网镜像>:8899
# PS 5.1：先下载、进程级 Bypass、再执行（iex 对方法调用链会 ParserError；
# 脚本本体纯 ASCII + UTF-8 BOM，避免中文注释被按 GBK 解码导致 ParseException）
curl.exe -s -o win-install.ps1 '<URL>'
Set-ExecutionPolicy -Scope Process Bypass -Force; & .\win-install.ps1
# 同时装 magpie 桌面应用（Windows 安装包静默装；订阅在应用界面里登录）：
#   ... -Magpie
# 启用局域网模式（绑定 0.0.0.0 并允许私网 IP 访问，方便其他电脑通过 AI 操作此机器）：
#   ... -Lan
# 组合使用：
#   .\win-install.ps1 -Magpie -Lan
```

脚本幂等，产物：

| 产物 | 位置 |
|---|---|
| Node（zip 免安装版，≥22.15） | `%USERPROFILE%\tools\node-v<版本>-win-x64\`，用户级 PATH 已持久化 |
| WAO 代码（GitHub codeload zip） | `%USERPROFILE%\wao\` |
| 生产依赖 | `wao\node_modules\`（`npm.cmd install --omit=dev`） |
| 服务进程 | 分离后台进程，日志 `wao\wao.out.log` / `wao.err.log` |
| magpie（可选 `-Magpie`） | **桌面应用**（Windows 安装包静默 /S 安装，`%LOCALAPPDATA%\Programs\magpie\magpie.exe`；自带 `127.0.0.1:3425` 网关与订阅管理界面，自更新）。2026-11-10 裁定：弃 CLI/TUI 形态 |

装完自检：浏览器开 `http://127.0.0.1:8792`，或
`Invoke-WebRequest http://127.0.0.1:8792/healthz` 应返回 `{"ok":true,...}`。

**国内网络（GitHub 慢/不通）**：设置 → 系统信息 →「网络代理」填代理软件的
HTTP 端口（如 `http://127.0.0.1:7890`），点「测试连通」实测——检查更新、
在线升级、工具安装即时走代理（无需重启）。`WAO_DOWNLOAD_MIRROR` 镜像仍是
应急回退，代理才是根治。magpie 与企微连接不经此代理。

**工具装备（省 token 三件套）**：设置 → 系统信息 →「工具装备」卡可一键安装
rtk / ripgrep / Git Bash（钉版+SHA256 门禁，直连慢/被截断时设
`WAO_DOWNLOAD_MIRROR=http://<局域网镜像>:8899` 回退；装完点「重启服务生效」）。
Windows 上 **Git Bash 是 claude bot 的 hook 前置**——缺 bash 时 rtk 等
PreToolUse hook 静默不生效、Bash 工具降级 cmd（11-09 实证）；`wao doctor`
对三件缺失都会告警。

## 2. 坑位清单（脚本已处理，手工安装必读）

1. **PowerShell 执行策略默认禁脚本**——`npm` 是 `npm.ps1` shim，直接调会报
   `UnauthorizedAccess`。一律用 **`npm.cmd`**（`wao start/doctor` 不受影响，
   它们是 node 直跑）。
2. **`C:\` 根目录写入要管理员**——非提权 PowerShell 往 `C:\` 落文件报
   `UnauthorizedAccessException`。全部走 `%USERPROFILE%`。
3. **GitHub codeload zip 自带一层 `<repo>-<branch>\` 目录**——`Expand-Archive`
   后要把它挪成目标目录；直接 `cd` 进去会找不到 `package.json`。
4. **`Expand-Archive` 很慢**——Node zip 几千个文件约 1 分钟，属正常，别以为卡死。
5. **命令行路径分隔符**——`node .\src\index.js`（反斜杠）；正斜杠在部分输入法/
   远控通道下会被吃掉。
6. **登录时 PATH/cwd 陷阱（自启动的实现依据）**——注册表 Run 键触发时
   cwd=`C:\Windows\System32`、PATH 未必含 node。WAO 的自启动因此**在启用一刻
   生成 `%USERPROFILE%\wao\data\win-autostart.cmd`**，烘焙绝对 node.exe 路径与
   `--data-dir`（默认 data 目录跟 cwd 走，见 §3）。`dataDir` 即使是相对路径
   （`--data-dir data`）也会在启用时被 `resolve` 成绝对路径再写入 cmd——登录时
   cwd 漂移不会把数据写到 System32。
7. **PS 5.1 `Invoke-WebRequest -Method Post` 偶发 `IndexOutOfRangeException`**——
   装机脚本里向 `/api/*` POST 时遇到（GET 正常）。改用 `curl.exe`（Win10 1803+
   自带）配 `Set-Content` 写 JSON 文件 + `--data-binary @file`，绕开 PowerShell
   对 JSON 花括号/引号的转义陷阱。`reg query` 查不存在的值返回非零退出码，在
   `$ErrorActionPreference='Stop'` 下会抛 `NativeCommandError`（这是"值不存在"
   的正常表现，别当故障）。
8. **远控剪贴板通道污染**——经 UU 远程等粘贴长命令时，剪贴板可能被别的进程
   改写（实测混入过 Vite 日志、提单文本）。粘贴后**先截图核对再回车**；带 `/`
   的 URL 用粘贴而非 `typeText`（后者会把 `/` 吃成 `?`）。
9. **跨设备 / 局域网访问（--lan 模式）**——默认仅监听 `127.0.0.1` 且严格拦截
   非回环 Host 头（防 DNS-Rebinding）。从局域网其他电脑访问时必须以 `--lan`
   （或环境变量 `WAO_LAN=1`）启动，绑定 `0.0.0.0` 并放行 RFC 1918 私网 IP
   （10.x, 192.168.x, 172.16-31.x）与本机主机名；恶意公网域名依然被 403 阻断。
   Web 控制台的「设置 → AI 操作」会自动探测本机局域网 IP 与主机名，支持一键切换
   生成的 Claude / Codex / ZCode MCP 端点，免去手工查 IP / 域名的麻烦。

## 3. 开机自启动（win32 原生支持）

与 macOS/Linux 同一个开关，语义一致：**只管「随登录启动」，不替客户选择，
不影响当前进程，也无崩溃自愈**（KeepAlive 等价物仍推荐 NSSM，见 README §3.1）。

- 机制：用户级注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`，
  值名 `com.wecom-agent-office`，指向启用时生成的 `data\win-autostart.cmd`
  （免管理员；cmd 内容由 `src/index.js` 的 `buildWinAutostartCmd` 生成，
  `test/ops/autostart-win.test.js` 锁内容）。
- 开：Web 设置页开关，或 `POST /api/service/autostart` body `{"enabled":true}`。
- 关：同开关 `{"enabled":false}`（删值，幂等）。
- 查：`GET /api/service/autostart`；`wao doctor` 的 `autostart` 行。
- 手查注册表：`reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v com.wecom-agent-office`
- 自启动日志：`data\logs\autostart.log`（boot 失败留痕）。

## 4. 日常运维

| 事项 | 命令/位置 |
|---|---|
| 手动启动（前台，Ctrl+C 四阶段停机） | `scripts\win-start.cmd` 或 `node .\src\index.js start` |
| 健康检查 | `Invoke-WebRequest http://127.0.0.1:8792/healthz` |
| 自检 | `node .\src\index.js doctor`（win32 显示 autostart 状态行；dsh/claude/codex/pi CLI 缺失为提示级——建对应岗位 bot 前装 CLI） |
| 停止 | 找 pid：`netstat -ano | findstr :8792` → `taskkill /PID <pid>`（SIGKILL 等价，孤儿扫尾由下次启动兜底）；优雅停止优先前台实例 Ctrl+C |
| 升级（标准推荐） | 打开 Web 控制台「设置 → 系统信息」，点「检查更新」→「一键升级」（全自动下载解压、保护数据目录、平滑重启服务、页面自动刷新，零黑框） |
| 工具装备 | 「设置 → 系统信息 → 工具装备」一键装 rtk/ripgrep/Git Bash；装完「重启服务」刷新 PATH |
| 网络代理 | 「设置 → 系统信息 → 网络代理」填 HTTP 代理 + 测试连通；检查更新/升级/工具安装即时生效 |
| 会话成本 | bot 的 `providerConfig.sessionTtlMin`（默认 45 分钟）控制会话退役——闲聊/隔夜消息不再付全量历史重放（实测一条"hi"从 76k 降到 ~16k） |
| 升级（手动兜底） | 重下 codeload zip 覆盖 `wao\`（**必须保留 `data\`**），重启进程 |
| 日志 | `data\logs\wao.log`（10MB×5 轮转）+ `wao.out.log`/`wao.err.log`（分离进程 stdout/stderr）+ `data\logs\updater.log`（在线升级日志） |

## 5. 已知边界

- **无 KeepAlive**：进程崩溃不会自动拉起（NSSM/任务计划程序补位，README §3.1）。
- **重启后需自启动已开**：没开开关的话重启即停，跑 `scripts\win-start.cmd` 或
  开关打开。
- **provider CLI 未预装**：dsh/claude/codex/pi 需另装后才能建对应岗位 bot；
  doctor 对缺失只给提示级 `!`。
- **IE 引擎残留的机器**：`Invoke-WebRequest` 记得带 `-UseBasicParsing`。


## 6. 把已有 WAO/magpie 配置迁到新机器（不依赖任何一台"源 Mac"常在线）

新机器**全新装机**默认源全在公网（nodejs.org / codeload.github.com / npmjs /
GitHub releases），`-Mirror` 只是可选回退——不需要源机器在线。需要搬运的只有
**私有数据**：企微 botId/secret、magpie 订阅登录态、资产/台账。规范做法：

1. **WAO**：源机器打包 `data/bots.json`（含 secret）、`data/assets.json`、
   `data/assets/<botId>/` 物化文件；目标机器落回 `wao/data/`，把 bot 的
   `providerConfig.cwd` 改成目标机器路径。⚠️ 同一套企微凭证在两处同时启用会
   **单连接互踢**——要么停用源机器 bot，要么换新凭证。
2. **magpie**：用官方 `magpie backup --sign-ins <file>`（口令经 stdin 非交互喂入）
   生成密封文件，自己保管/传输；目标 `magpie restore --no-sign-ins <file>` 只导
   providers/settings。订阅登录态在 `logins.json` 里是**独立记录数组**，可以精确
   只挑需要的几条覆盖 `%APPDATA%\magpie\logins.json`（比全量导入再删干净）。
3. **provider CLI**：bot 走 magpie 网关时还要装对应 CLI（如 `npm.cmd i -g
   @anthropic-ai/claude-code`）并落 `~/.claude/settings.json` 的
   `ANTHROPIC_BASE_URL=http://127.0.0.1:3425` + `ANTHROPIC_AUTH_TOKEN`。
4. 传输走 UU 文件传输/自带 U 盘等任意通道即可；脚本用 `$PSScriptRoot` 自定位，
   三个文件放同一文件夹，落到哪个目录都能跑。

**本次实践（2026-11-09）**：PC1 上 `main`/`bot2` 复制并启用，Mac 生产两 bot 按用户
接受被互踢离线；magpie 只保留 `plugin:workbuddy` / `plugin:workbuddy-ai` 两条订阅。
