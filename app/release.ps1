# 出发布包：按 ABI 拆包 + 改名 + sha256 + latest.json
# 为什么需要它：应用内更新（EllenUpdates）吃的是 manifest（latest.json），
# 手动拼这个文件必错字段名，且 sha256 必须与包体逐字节一致，否则客户端校验失败。
#
# 用法：
#   pwsh -File ...\app\release.ps1                      # 出 arm64 + x86_64 两个包和 latest.json
#   pwsh -File ...\app\release.ps1 -Abi arm64-v8a       # 只出真机用的那个
#   pwsh -File ...\app\release.ps1 -SkipBuild           # 只重新算 hash / 重写 latest.json
#   pwsh -File ...\app\release.ps1 -Notes "修了手记分页"  # 写进 latest.json 的更新说明
#
# 通道（老大 2026-11-10：发布通道先留空）：脚本只产出本地文件，不上传、不写死任何托管地址。
# 拿到 https 静态站后，把整个输出目录的内容原样传上去即可，latest.json 里的 URL
# 用 -BaseUrl 参数拼出来（不传就写相对文件名，客户端那边也得配同一个地址）。
param(
  [string[]]$Abi = @('arm64-v8a', 'x86_64'),
  [switch]$SkipBuild,
  [string]$Notes = '',
  [string]$BaseUrl = '',
  [string]$Channel = 'stable'
)
$ErrorActionPreference = 'Stop'
$root = 'E:\ailian\艾莲手机版\创作版\app'
$out = 'E:\ailian\艾莲手机版\创作版\_build\release'
$gradle = 'E:\ailian\工具\gradle-8.11.1\bin\gradle.bat'
$env:JAVA_HOME = 'C:\Program Files\Microsoft\jdk-21.0.10.7-hotspot'
$env:GRADLE_USER_HOME = 'E:\ailian\工具\gradle-home'

# ---- 1. 版本号：从 build.gradle.kts 读，绝不手写第二份 ----
$gradleKts = Get-Content "$root\app\build.gradle.kts" -Raw
$vm = [regex]::Match($gradleKts, 'versionName\s*=\s*"([^"]+)"')
$vc = [regex]::Match($gradleKts, 'versionCode\s*=\s*(\d+)')
if (-not $vm.Success -or -not $vc.Success) { throw 'build.gradle.kts 里找不到 versionName / versionCode' }
$version = $vm.Groups[1].Value
$versionCode = [int]$vc.Groups[1].Value

# ---- 2. 构建（拆包）----
if (-not $SkipBuild) {
  Push-Location $root
  try {
    & $gradle ':app:assembleDebug' '-PellenAbiSplit=true' '--console=plain' '-q'
    if ($LASTEXITCODE -ne 0) { throw "gradle 拆包构建失败（exit $LASTEXITCODE）" }
  } finally { Pop-Location }
}

$apkDir = "$root\app\build\outputs\apk\debug"
New-Item -ItemType Directory -Force -Path $out | Out-Null

# ---- 3. 逐 ABI 取包、改名、算 sha256 ----
$made = @()
foreach ($a in $Abi) {
  $src = Join-Path $apkDir "app-$a-debug.apk"
  if (-not (Test-Path $src)) { throw "没找到拆包产物：$src（先跑 -SkipBuild 之前的完整构建，或检查 -PellenAbiSplit）" }
  # 文件名只用 ASCII：中文名进了 URL 会被百分号编码，客户端拼地址容易出错
  $name = "ellen-$version-$a.apk"
  $dst = Join-Path $out $name
  Copy-Item $src $dst -Force
  $size = (Get-Item $dst).Length
  $sha = (Get-FileHash $dst -Algorithm SHA256).Hash.ToLower()
  if ($sha -notmatch '^[a-f0-9]{64}$') { throw "sha256 格式异常：$sha" }
  $made += [pscustomobject]@{ abi = $a; name = $name; sizeBytes = $size; sha256 = $sha }
  Write-Host ("[apk] {0}  {1:N0} B  sha256={2}" -f $name, $size, $sha.Substring(0, 16))
}

# ---- 4. latest.json：字段照 EllenUpdates 的 check 契约 ----
# 客户端只认这些键：schemaVersion / platform / packageName / channel / version /
# versionCode / publishedAt / minSdkVersion / notes / apk{sha256,url,sizeBytes}
# url 用 -BaseUrl 拼（不传就写裸文件名，方便先本地验，上线时必须给完整 https 地址）
$primary = $made[0]
$url = if ($BaseUrl) { "$($BaseUrl.TrimEnd('/'))/$($primary.name)" } else { $primary.name }
$manifest = [ordered]@{
  schemaVersion  = 1
  platform       = 'android'
  packageName    = 'cn.ellen.companion2'
  channel        = $Channel
  version        = $version
  versionCode    = $versionCode
  publishedAt    = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  minSdkVersion  = 24
  notes          = $Notes
  apk            = [ordered]@{ sha256 = $primary.sha256; url = $url; sizeBytes = $primary.sizeBytes }
}
$json = $manifest | ConvertTo-Json -Depth 5
$manifestPath = Join-Path $out 'latest.json'
# 写成 UTF-8 无 BOM —— 带 BOM 时 Java 侧 JSON 解析会炸在第一字节
[System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "[manifest] $manifestPath"

# ---- 5. 自证：读回来再核一遍（不做这步就等着客户端报「校验失败」）----
$back = Get-Content $manifestPath -Raw | ConvertFrom-Json
$again = (Get-FileHash (Join-Path $out $primary.name) -Algorithm SHA256).Hash.ToLower()
if ($back.apk.sha256 -ne $again) { throw "latest.json 里的 sha256 与包体不一致：$($back.apk.sha256) vs $again" }
if ($back.versionCode -ne $versionCode) { throw "latest.json 的 versionCode 与 build.gradle.kts 不一致" }
Write-Host "[verify] version=$version ($versionCode)  abi=$($primary.abi)  size=$($primary.sizeBytes)  sha256 复算一致"

# ---- 6. 其它 ABI 也留一份小清单，方便人工挑包（客户端不读）----
$index = @{ version = $version; versionCode = $versionCode; builtAt = (Get-Date).ToString('s'); apks = $made } |
  ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText((Join-Path $out 'index.json'), $index, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ''
Write-Host "输出目录：$out"
Get-ChildItem $out | ForEach-Object { Write-Host ("  {0}  {1:N0} B" -f $_.Name, $_.Length) }
Write-Host ''
Write-Host '提醒：现在是 debug keystore 签名。正式发给别人之前要先做 release 签名（keystore 别进 git）。'
