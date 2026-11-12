# 本地起一个更新桩：http 服务 + adb reverse，让手机/模拟器不碰公网就能走完整条更新链。
#
# 为什么这么绕：Android 9+ 禁明文 http，但 network_security_config 对 127.0.0.1/localhost/10.0.2.2
# 开了 cleartext，所以 adb reverse 之后 http://127.0.0.1:PORT/latest.json 是合法地址。
#
# 用法：
#   pwsh -File _tools\serve_update.ps1                       # 8080，自动挑设备
#   pwsh -File _tools\serve_update.ps1 -Serial 127.0.0.1:16416 -Port 8090
param(
  [int]$Port = 8080,
  [string]$Serial = '',
  [string]$Dir = '',
  [switch]$Stop
)
$ErrorActionPreference = 'Stop'
$adb = 'E:\ailian\工具\platform-tools\adb.exe'
if (-not $Dir) { $Dir = Join-Path $PSScriptRoot '..\_build\release' }
$Dir = (Resolve-Path $Dir).Path

if (-not $Serial) {
  $devs = (& $adb devices) | Select-String 'device$' | ForEach-Object { ($_ -split "`t")[0] }
  if (-not $devs) { throw '没有在线设备' }
  $Serial = @($devs)[0]
  Write-Host "[device] 用 $Serial（多个设备时用 -Serial 指定）"
}

if ($Stop) {
  & $adb -s $Serial reverse --remove tcp:$Port 2>$null | Out-Null
  Get-Process python -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*http.server*$Port*" } | Stop-Process -Force
  Write-Host '[stop] 已撤销 reverse 并停掉 http 服务'
  return
}

& $adb -s $Serial reverse tcp:$Port tcp:$Port | Out-Null
Write-Host "[reverse] tcp:$Port → 本机 tcp:$Port（$Serial）"
Start-Process -FilePath 'python' -ArgumentList '-m','http.server',$Port,'--bind','127.0.0.1','--directory',$Dir -WindowStyle Hidden
Start-Sleep -Milliseconds 800
try { Invoke-WebRequest -Uri "http://127.0.0.1:$Port/latest.json" -TimeoutSec 5 -UseBasicParsing | Out-Null; Write-Host '[http] 服务已起' }
catch { throw "http 服务没起来：$_" }
Write-Host ''
Write-Host "在这台设备的「设置 → 关于与更新 → 更新清单地址」填："
Write-Host "    http://127.0.0.1:$Port/latest.json"
Write-Host ''
Write-Host "要点：清单里的 versionCode 必须比装机那份大，否则客户端判「已是最新」，下载逻辑压根不会跑。"
Write-Host "收工：pwsh -File $($MyInvocation.MyCommand.Path) -Port $Port -Serial $Serial -Stop"