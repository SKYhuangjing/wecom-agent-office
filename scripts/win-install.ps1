# WAO Windows installer — no admin, no git, no MSI (battle-tested 2026-11-09
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
#   -Magpie       switch           also install magpie CLI + headless gateway (fresh, no credentials)
param(
  [string]$NodeVersion = '22.23.4',
  [string]$RepoZip = 'https://codeload.github.com/SKYhuangjing/wecom-agent-office/zip/refs/heads/main',
  [string]$InstallRoot = "$env:USERPROFILE\wao",
  [string]$Mirror = '',
  [switch]$Magpie
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
  # codeload zip wraps everything in <repo>-<branch>/ — unwrap to InstallRoot
  $src = (Get-ChildItem "$H\wao-ext" | Select-Object -First 1).FullName
  Move-Item $src $InstallRoot
}
Push-Location $InstallRoot

Write-Output '=== [3/5] production deps (npm.cmd — execution policy safe) ==='
npm.cmd install --omit=dev --no-audit --no-fund

Write-Output '=== [4/5] persist user PATH (node' + ($(if ($Magpie) { ' + magpie' } else { '' })) + ') ==='
$u = [Environment]::GetEnvironmentVariable('Path', 'User')
$want = if ($Magpie) { @("$NodeDir", "$H\tools\magpie") } else { @("$NodeDir") }
$missing = @($want | Where-Object { $u -notlike "*$_*" })
if ($missing.Count -gt 0) {
  [Environment]::SetEnvironmentVariable('Path', ($missing + $u) -join ';', 'User')
  Write-Output 'PATH-PERSISTED'
} else { Write-Output 'PATH-ALREADY' }

Write-Output '=== [5/5] doctor + start detached ==='
node .\src\index.js doctor
Start-Process node -ArgumentList '.\src\index.js', 'start' -RedirectStandardOutput wao.out.log -RedirectStandardError wao.err.log -WindowStyle Hidden
Start-Sleep -Seconds 5
$hz = (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8792/healthz).Content
Write-Output "HEALTHZ=$hz"

if ($Magpie) {
  Write-Output '=== [+magpie] fresh CLI + headless gateway (NO credentials copied) ==='
  New-Item -ItemType Directory -Force "$H\tools\magpie" | Out-Null
  if (-not (Test-Path "$H\tools\magpie\magpie.exe")) {
    Get-File 'https://github.com/yetone/magpie-releases/releases/latest/download/magpie-cli-windows-amd64.exe' "$H\tools\magpie\magpie.exe" 'magpie.exe'
  }
  Write-Output ("MAGPIE=" + (& "$H\tools\magpie\magpie.exe" --version))
  Start-Process "$H\tools\magpie\magpie.exe" -ArgumentList 'web', '--gateway', '--no-open', '--addr', '127.0.0.1:3425' -RedirectStandardOutput magpie.out.log -RedirectStandardError magpie.err.log -WindowStyle Hidden
  Start-Sleep -Seconds 6
  if (netstat -ano | Select-String ':3425 .*LISTENING') { Write-Output 'MAGPIE-GATEWAY-LISTENING-3425' }
  else {
    Write-Output 'MAGPIE-PORT-NOT-LISTENING — tail logs:'
    Get-Content magpie.err.log -Tail 15 -ErrorAction SilentlyContinue
    Get-Content magpie.out.log -Tail 15 -ErrorAction SilentlyContinue
  }
}
Pop-Location
Write-Output 'DONE'
Write-Output '开机自启动：Web 设置页开关，或 POST /api/service/autostart {"enabled":true}（注册表 Run 键，详见 docs/INSTALL-WINDOWS.md）'
