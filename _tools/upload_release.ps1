# 把 _build\release 里的东西传到托管（OSS 或自己的服务器），然后回读自证。
#
# 为什么需要：release.ps1 只产出本地文件；latest.json 里的 URL 必须是完整的 https 地址，
# 上传完不验一遍，客户端那边就是「检查更新失败」，而失败原因藏在 sha256 还是 404 里看不出来。
#
# 用法：
#   # 走 OSS（需要 ossutil 已配好 profile，或用 AK 环境变量）
#   pwsh -File _tools\upload_release.ps1 -Provider oss -Bucket oss://ellen-apk/mobile -BaseUrl https://ellen-apk.oss-cn-hangzhou.aliyuncs.com/mobile
#
#   # 走自己的服务器
#   pwsh -File _tools\upload_release.ps1 -Provider ssh -SshHost root@1.2.3.4 -RemoteDir /var/www/ellen/mobile -BaseUrl https://ellen.example.com/mobile
#
#   # 只回读（不上传），确认现网那份和本地包体一致
#   pwsh -File _tools\upload_release.ps1 -BaseUrl https://... -SkipUpload
param(
  [ValidateSet('oss', 'ssh')][string]$Provider = 'oss',
  [string]$BaseUrl = '',
  [string]$ReleaseDir = '',
  [string]$Bucket = '',
  [string]$SshHost = '',
  [string]$RemoteDir = '',
  [string]$Ossutil = 'ossutil64.exe',
  [switch]$SkipUpload,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
if (-not $ReleaseDir) { $ReleaseDir = Join-Path $PSScriptRoot '..\_build\release' }
$ReleaseDir = (Resolve-Path $ReleaseDir).Path
$manifestPath = Join-Path $ReleaseDir 'latest.json'
if (-not (Test-Path $manifestPath)) { throw "没有 latest.json：先跑 app\release.ps1" }
$manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json

# 本地包体必须是清单里点名的那个
$apkName = Split-Path ([string]$manifest.apk.url) -Leaf
$apkPath = Join-Path $ReleaseDir $apkName
if (-not (Test-Path $apkPath)) { throw "latest.json 指向 $apkName，但输出目录里没有这个包" }
$localSha = (Get-FileHash $apkPath -Algorithm SHA256).Hash.ToLower()
if ($localSha -ne $manifest.apk.sha256) { throw "本地包体 sha256 与 latest.json 不一致，先重跑 release.ps1" }
Write-Host ("[local] {0}  {1:N0} B  v{2} ({3})" -f $apkName, (Get-Item $apkPath).Length, $manifest.version, $manifest.versionCode)

if ($BaseUrl) {
  $BaseUrl = $BaseUrl.TrimEnd('/')
  if ($BaseUrl -notmatch '^https://') { Write-Warning 'BaseUrl 不是 https —— Android 9+ 会直接拒绝明文下载' }
  # 把清单里的相对 url 改写成完整地址（只改内存，落盘由 -WriteBack 决定）
  $manifest.apk.url = "$BaseUrl/$apkName"
  $json = $manifest | ConvertTo-Json -Depth 5
  [System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "[manifest] url → $($manifest.apk.url)"
}

if (-not $SkipUpload) {
  if ($DryRun) {
    Write-Host "[dry-run] 会传：$apkName + latest.json"
  } elseif ($Provider -eq 'oss') {
    if (-not $Bucket) { throw '走 OSS 要给 -Bucket（如 oss://ellen-apk/mobile）' }
    if (-not (Get-Command $Ossutil -ErrorAction SilentlyContinue) -and -not (Test-Path $Ossutil)) { throw "找不到 ossutil：$Ossutil" }
    & $Ossutil cp (Join-Path $ReleaseDir $apkName) "$Bucket/$apkName" -f
    if ($LASTEXITCODE -ne 0) { throw 'ossutil 传 apk 失败' }
    # 清单最后传：包没到位就先让客户端看到新版本，等于把人往 404 上引
    & $Ossutil cp $manifestPath "$Bucket/latest.json" -f `
      --meta 'Cache-Control:no-cache, max-age=0'
    if ($LASTEXITCODE -ne 0) { throw 'ossutil 传 latest.json 失败' }
  } else {
    if (-not $SshHost -or -not $RemoteDir) { throw '走服务器要给 -SshHost 和 -RemoteDir' }
    scp $apkPath "${SshHost}:$RemoteDir/"
    if ($LASTEXITCODE -ne 0) { throw 'scp 传 apk 失败' }
    scp $manifestPath "${SshHost}:$RemoteDir/"
    if ($LASTEXITCODE -ne 0) { throw 'scp 传 latest.json 失败' }
  }
  Write-Host '[upload] 完成'
}

if (-not $BaseUrl) { Write-Host '没给 -BaseUrl，跳过回读校验'; return }

# ---- 回读自证：客户端怎么拿到，就怎么验一遍 ----
$url = $manifest.apk.url
$manifestUrl = "$BaseUrl/latest.json"
Write-Host "[verify] GET $manifestUrl"
$remote = Invoke-RestMethod -Uri $manifestUrl -Headers @{ 'Cache-Control' = 'no-cache' } -TimeoutSec 30
if ($remote.versionCode -ne $manifest.versionCode) { throw "现网清单 versionCode=$($remote.versionCode)，本地=$($manifest.versionCode)（可能 CDN 缓存没刷）" }
if ($remote.apk.sha256 -ne $localSha) { throw '现网清单 sha256 与本地包体不一致' }
# HEAD 看包在不在、大小对不对（比整包下载快得多）
$head = Invoke-WebRequest -Uri $url -Method Head -TimeoutSec 30
$len = [int64]$head.Headers['Content-Length']
if ($len -ne (Get-Item $apkPath).Length) { throw "远端包体大小 $len ≠ 本地 $((Get-Item $apkPath).Length)" }
# 抽中段一片，确认不是 HTML 错误页冒充 apk
$range = Invoke-WebRequest -Uri $url -Headers @{ Range = 'bytes=0-1023' } -TimeoutSec 30
$sig = [System.Text.Encoding]::ASCII.GetString($range.Content[0..1])
if ($sig -ne 'PK') { throw "远端前两字节是 '$sig' 不是 'PK' —— 下到的不是 zip/apk" }
Write-Host "[verify] 通过  version=$($remote.version)($($remote.versionCode))  size=$len  sha256 一致  PK 头正常"