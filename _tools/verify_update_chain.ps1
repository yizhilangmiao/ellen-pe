# 一条命令把「更新链」在本地跑通：造假清单（versionCode 故意比装机那份大）+ 起 http 桩 + adb reverse。
#
# 为什么要造假清单：release.ps1 出的清单 versionCode 等于当前构建，装机那份也一样，
# 客户端会判「已经是最新的」，下载逻辑根本不会跑。这里只改 versionCode 与 notes，
# sha256/sizeBytes/url 全部照抄真包，所以走的还是真实下载与校验路径。
#
# 用法：
#   pwsh -File _tools\verify_update_chain.ps1                       # 自动挑设备
#   pwsh -File _tools\verify_update_chain.ps1 -Serial 127.0.0.1:16416 -Port 8090
#   pwsh -File _tools\verify_update_chain.ps1 -Stop
param(
  [int]$Port = 8080,
  [string]$Serial = '',
  [int]$FakeVersionCode = 99,
  [switch]$Stop
)
$ErrorActionPreference = 'Stop'
$adb = 'E:\ailian\工具\platform-tools\adb.exe'
$release = (Resolve-Path (Join-Path $PSScriptRoot '..\_build\release')).Path

if (-not $Serial) {
  $devs = (& $adb devices) | Select-String 'device$' | ForEach-Object { ($_ -split "`t")[0] }
  if (-not $devs) { throw '没有在线设备' }
  $Serial = @($devs)[0]
  Write-Host "[device] $Serial"
}

if ($Stop) {
  & $adb -s $Serial reverse --remove tcp:$Port 2>$null | Out-Null
  Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
    Where-Object { $_.CommandLine -like "*http.server*$Port*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Write-Host '[stop] 已撤销 reverse 并停掉 http 服务'
  return
}

# 装机那份的 ABI 决定拿哪个包：x86_64 模拟器拿 x86_64 包，真机拿 arm64
$abi = (& $adb -s $Serial shell getprop ro.product.cpu.abi).Trim()
$wanted = if ($abi -eq 'x86_64') { 'x86_64' } else { 'arm64-v8a' }
$index = Get-Content (Join-Path $release 'index.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$pick = $index.apks | Where-Object { $_.abi -eq $wanted } | Select-Object -First 1
if (-not $pick) { throw "index.json 里没有 $wanted 的包（先跑 app\release.ps1）" }
Write-Host ("[apk] {0}  {1:N0} B" -f $pick.name, $pick.sizeBytes)

# 清单里 url 故意留相对文件名：客户端必须能按清单地址解析出来（native 侧 absoluteUrl）
$manifest = [ordered]@{
  schemaVersion = 1
  platform      = 'android'
  packageName   = 'cn.ellen.companion2'
  channel       = 'stable'
  version       = "$($index.version)-updtest"
  versionCode   = $FakeVersionCode
  publishedAt   = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  minSdkVersion = 24
  notes         = '更新链路本地验证用的假版本，不是真发布'
  apk           = [ordered]@{ sha256 = $pick.sha256; url = $pick.name; sizeBytes = $pick.sizeBytes }
}
$testPath = Join-Path $release 'latest-test.json'
$json = $manifest | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText($testPath, $json, (New-Object Text.UTF8Encoding($false)))
Write-Host "[manifest] latest-test.json  versionCode=$FakeVersionCode url=$($pick.name)（相对）"

& $adb -s $Serial reverse tcp:$Port tcp:$Port | Out-Null
Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
  Where-Object { $_.CommandLine -like "*http.server*$Port*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Process -FilePath 'python' -ArgumentList '-m','http.server',$Port,'--bind','127.0.0.1','--directory',$release -WindowStyle Hidden
Start-Sleep -Milliseconds 900
$probe = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/latest-test.json" -TimeoutSec 5 -UseBasicParsing
Write-Host '[http] 200，清单可取'
Write-Host ''
Write-Host "在设备「设置 → 关于与更新 → 更新清单地址」填："
Write-Host "    http://127.0.0.1:$Port/latest-test.json"
Write-Host ''
Write-Host "预期：点检查更新 → 「有新版本」→ 下载到 ~100% → sha256 校验 → 出现安装按钮。"
Write-Host "收工：pwsh -File _tools\verify_update_chain.ps1 -Port $Port -Serial $Serial -Stop"