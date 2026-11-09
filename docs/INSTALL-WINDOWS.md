# Windows 安装与运维手册（zip 免管理员路线）

> 2026-11-09 在两台干净 Win11 机器（提单测试电脑1/2，无 git、无 Node、无管理员
> 权限）全链路实装沉淀。快速路径用 `scripts/win-install.ps1`（本文坑位它的每一
> 步都替你处理了）；手工排障按 §2 逐条对。

## 1. 一条命令安装（推荐）

在有网可达的 Windows 上，任意 PowerShell 里跑（`iex` 免落盘；或下载后
`powershell -ExecutionPolicy Bypass -File win-install.ps1`）：

```powershell
# 把 <URL> 换成本仓库 scripts/win-install.ps1 的 raw 地址；内网慢可加 -Mirror http://<局域网镜像>:8899
iex (New-Object Net.WebClient).DownloadString('<URL>')
# 同时装 magpie 网关（全新空装，不带任何凭证）：
#   ... -Magpie
```

脚本幂等，产物：

| 产物 | 位置 |
|---|---|
| Node（zip 免安装版，≥22.15） | `%USERPROFILE%\tools\node-v<版本>-win-x64\`，用户级 PATH 已持久化 |
| WAO 代码（GitHub codeload zip） | `%USERPROFILE%\wao\` |
| 生产依赖 | `wao\node_modules\`（`npm.cmd install --omit=dev`） |
| 服务进程 | 分离后台进程，日志 `wao\wao.out.log` / `wao.err.log` |
| magpie（可选 `-Magpie`） | `%USERPROFILE%\tools\magpie\magpie.exe`，无头网关监听 `127.0.0.1:3425` |

装完自检：浏览器开 `http://127.0.0.1:8792`，或
`Invoke-WebRequest http://127.0.0.1:8792/healthz` 应返回 `{"ok":true,...}`。

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
   `--data-dir`（默认 data 目录跟 cwd 走，见 §3）。

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
| 升级 | 重下 codeload zip 覆盖 `wao\`（保留 `data\`），重启进程 |
| 日志 | `data\logs\wao.log`（10MB×5 轮转）+ `wao.out.log`/`wao.err.log`（分离进程 stdout/stderr） |

## 5. 已知边界

- **无 KeepAlive**：进程崩溃不会自动拉起（NSSM/任务计划程序补位，README §3.1）。
- **重启后需自启动已开**：没开开关的话重启即停，跑 `scripts\win-start.cmd` 或
  开关打开。
- **provider CLI 未预装**：dsh/claude/codex/pi 需另装后才能建对应岗位 bot；
  doctor 对缺失只给提示级 `!`。
- **IE 引擎残留的机器**：`Invoke-WebRequest` 记得带 `-UseBasicParsing`。
