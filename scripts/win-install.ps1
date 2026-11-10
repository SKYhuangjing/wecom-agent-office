# WAO Windows installer - no admin, no git, no MSI (battle-tested 2026-11-09
# on two clean Win11 boxes; pitfalls documented in docs/INSTALL-WINDOWS.md).
# Node comes from the official zip into %USERPROFILE%\tools, WAO from the
# GitHub codeload zip, deps via npm.cmd (PS execution policy blocks npm.ps1).
# Idempotent: every step checks before doing.
#
# Usage (from any PowerShell):
#   iex (New-Object Net.WebClient).DownloadString('<this file over http>')
# or download and run:
#   powershell -ExecutionPolicy Bypass -File .\win-install.ps1 [-Magpie]
#
# Optional params:
#   -NodeVersion  '22.23.4'        Node dist version (>= 22.15 required)
#   -RepoZip      <url>            WAO source zip (GitHub codeload main)
#   -InstallRoot  "$env:USERPROFILE\wao"   target dir
#   -Mirror       <url-prefix>     LAN mirror prefix for big binaries
#                                  (fallback when GitHub/nodejs.org are slow/blocked;
#                                   serves node-v<NODE_VERSION>-win-x64.zip and magpie.exe)
#   -Magpie       switch           also install the magpie DESKTOP APP (Windows
#                                  installer magpie-windows-amd64.exe, silent /S) -
#                                  NOT the CLI/TUI build; the desktop app serves
#                                  the 127.0.0.1:3425 gateway and self-updates
#   -Lan          switch           bind 0.0.0.0 and admit private LAN IPs / hostname
param(
  [string]$NodeVersion = '22.23.4',
  [string]$RepoZip = 'https://codeload.github.com/SKYhuangjing/wecom-agent-office/zip/refs/heads/main',
  [string]$InstallRoot = "$env:USERPROFILE\wao",
  [string]$Mirror = '',
  [switch]$Magpie,
  [switch]$Lan
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$H = $env:USERPROFILE
$NodeDir = "$H\tools\node-$NodeVersion-win-x64"

function Get-File($url, $out, $fallbackName) {
  try { Invoke-WebRequest -UseBasicParsing $url -OutFile $out }
  catch {
    if ($Mirror -and $fallbackName) {
      Write-Output "DIRECT-FAIL $url -> fallback mirror"
      Invoke-WebRequest -UseBasicParsing "$Mirror/$fallbackName" -OutFile $out
    } else { throw }
  }
}

Write-Output "=== [1/5] Node $NodeVersion (zip, user-scope, no admin) ==="
if (-not (Test-Path "$NodeDir\node.exe")) {
  Get-File "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" "$H\node-win.zip" "node-v$NodeVersion-win-x64.zip"
  Expand-Archive "$H\node-win.zip" -DestinationPath "$H\tools" -Force
}
$env:Path = "$NodeDir;$env:Path"
Write-Output ("NODE=" + (node -v))

Write-Output '=== [2/5] WAO source ==='
if (-not (Test-Path "$InstallRoot\package.json")) {
  Get-File $RepoZip "$H\wao.zip" $null
  Expand-Archive "$H\wao.zip" -DestinationPath "$H\wao-ext" -Force
  # codeload zip wraps everything in <repo>-<branch>/ - unwrap to InstallRoot
  $src = (Get-ChildItem "$H\wao-ext" | Select-Object -First 1).FullName
  Move-Item $src $InstallRoot
}
Push-Location $InstallRoot

Write-Output '=== [3/5] production deps (npm.cmd - execution policy safe) ==='
npm.cmd install --omit=dev --no-audit --no-fund

Write-Output '=== [4/5] persist user PATH (node) ==='
$u = [Environment]::GetEnvironmentVariable('Path', 'User')
# desktop magpie owns its dir + self-updates; NOT added to PATH (2026-11-10: CLI/TUI form dropped)
$want = @("$NodeDir")
$missing = @($want | Where-Object { $u -notlike "*$_*" })
if ($missing.Count -gt 0) {
  [Environment]::SetEnvironmentVariable('Path', ($missing + $u) -join ';', 'User')
  Write-Output 'PATH-PERSISTED'
} else { Write-Output 'PATH-ALREADY' }

Write-Output '=== [5/5] doctor + start detached ==='
node .\src\index.js doctor
$startArgs = if ($Lan) { @('.\src\index.js', 'start', '--lan') } else { @('.\src\index.js', 'start') }
Start-Process node -ArgumentList $startArgs -RedirectStandardOutput wao.out.log -RedirectStandardError wao.err.log -WindowStyle Hidden
Start-Sleep -Seconds 5
$hz = (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8792/healthz).Content
Write-Output "HEALTHZ=$hz"

if ($Magpie) {
  Write-Output '=== [+magpie] desktop app (portable single-file, place + launch) ==='
  # 2026-11-10 owner ruling: DESKTOP APP build (serves 127.0.0.1:3425 gateway +
  # subscription UI, self-updates), NOT the CLI/TUI headless form.
  # Field truth from PC2: magpie-windows-amd64.exe is a PORTABLE single-file
  # Tauri app, NOT an NSIS installer (/S is parsed as an agent name!) -
  # placing the exe and launching it IS the install.
  $magpieDir = "$env:LOCALAPPDATA\Programs\magpie"
  if (-not (Test-Path "$magpieDir\magpie.exe")) {
    New-Item -ItemType Directory -Force $magpieDir | Out-Null
    Get-File 'https://github.com/yetone/magpie-releases/releases/latest/download/magpie-windows-amd64.exe' "$magpieDir\magpie.exe" 'magpie-windows-amd64.exe'
  }
  Write-Output "MAGPIE=$magpieDir\magpie.exe"
  Start-Process "$magpieDir\magpie.exe"
  Start-Sleep -Seconds 10
  if (netstat -ano | Select-String ':3425 .*LISTENING') { Write-Output 'MAGPIE-GATEWAY-LISTENING-3425' }
  else { Write-Output 'MAGPIE-PORT-NOT-LISTENING - desktop app may need first-run interaction; open it from Start Menu' }
}
Pop-Location
Write-Output 'DONE'
Write-Output 'Autostart: toggle in Web settings, or POST /api/service/autostart {"enabled":true} (registry Run key; see docs/INSTALL-WINDOWS.md)'
