# 出发布包：按 ABI 拆包 + 改名 + sha256 + latest.json
# 为什么需要它：应用内更新（EllenUpdates）吃的是 manifest（latest.json），
# 手动拼这个文件必错字段名，且 sha256 必须与包体逐字节一致，否则客户端校验失败。
#
# 用法：
#   pwsh -File ...\app\release.ps1                      # 默认出【正式签名】包 + latest.json
#   pwsh -File ...\app\release.ps1 -Abi arm64-v8a       # 只出真机用的那个
#   pwsh -File ...\app\release.ps1 -SkipBuild           # 只重新算 hash / 重写 latest.json
#   pwsh -File ...\app\release.ps1 -Notes "修了手记分页"  # 写进 latest.json 的更新说明
#   pwsh -File ...\app\release.ps1 -Debug               # 内部自测才用：debug 签名，不能发出去
#
# 老大 2026-11-13 定：**发布必须用正式签名**。所以默认就是 assembleRelease，
# 要出 debug 包得显式加 -Debug；出完还校验证书指纹，不对就 throw —— 不靠人记得加参数。
#
# 通道（老大 2026-11-10：发布通道先留空）：脚本只产出本地文件，不上传、不写死任何托管地址。
# 拿到 https 静态站后，把整个输出目录的内容原样传上去即可，latest.json 里的 URL
# 用 -BaseUrl 参数拼出来（不传就写相对文件名，客户端那边也得配同一个地址）。
param(
  [string[]]$Abi = @('arm64-v8a', 'x86_64'),
  [switch]$SkipBuild,
  # 跳过 web 构建（只重新 gradle 时用）。默认必须先 vite build ——
  # 不跑它，gradle 拿的是 assets\public 里上一次的旧 web，出再多版也看不到改动
  # （2026-11-13 连出 0.3.4~0.3.7 全白修，就是因为漏了这一步）。
  [switch]$SkipWeb,
  # 内部自测专用：出 debug 签名包。默认（不加这个）就是正式签名。
  # debug 与 release 签名不同，互相不能覆盖安装 —— 手机装 debug 包没事，发布一律正式签名。
  [switch]$Debug,
  # 兼容老写法：以前要 -Sign 才是正式签名，现在默认就是，传了也不报错。
  [switch]$Sign,
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

# ---- 1.5 web 产物：先 vite build，产物落到 app/src/main/assets/public ----
# 没这一步就是「旧 web + 新原生」：包出了、装了、界面一点没变。
# 2026-11-13 连出 0.3.4~0.3.7 全白修，就是漏了这一步（release.ps1 只跑 gradle）。
if (-not $SkipWeb) {
  $env:npm_config_cache = 'E:\ailian\工具\npm-cache'
  Push-Location "$root\web"
  try {
    & 'E:\ailian\工具\node\node-v24.21.0-win-x64\node.exe' node_modules\vite\bin\vite.js build --logLevel warn
    if ($LASTEXITCODE -ne 0) { throw "vite build 失败（exit $LASTEXITCODE）" }
  } finally { Pop-Location }
  $idx = Get-Item "$root\app\src\main\assets\public\index.html"
  Write-Host ("[web] assets\public\index.html  {0}" -f $idx.LastWriteTime)
}

# ---- 2. 构建（拆包）----
$variant = if ($Debug) { 'debug' } else { 'release' }
$task = if ($Debug) { ':app:assembleDebug' } else { ':app:assembleRelease' }
if (-not $SkipBuild) {
  Push-Location $root
  try {
    & $gradle $task '-PellenAbiSplit=true' '--console=plain' '-q'
    if ($LASTEXITCODE -ne 0) { throw "gradle 拆包构建失败（exit $LASTEXITCODE）" }
  } finally { Pop-Location }
}

$apkDir = "$root\app\build\outputs\apk\$variant"
New-Item -ItemType Directory -Force -Path $out | Out-Null

# ---- 3. 逐 ABI 取包、改名、算 sha256 ----
$made = @()
foreach ($a in $Abi) {
  $src = Join-Path $apkDir "app-$a-$variant.apk"
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

# ---- 5.5 签名自检：发布包必须是正式证书（老大 2026-11-13 定）----
if (-not $Debug) {
  $apksigner = Get-ChildItem 'E:/ailian/工具/android-sdk/build-tools/*/apksigner.bat' |
    Sort-Object FullName -Descending | Select-Object -First 1
  if (-not $apksigner) { throw '找不到 apksigner.bat（android-sdk/build-tools），没法校验签名' }
  $wantPrint = 'd8c4ea12050c025d20310491d16c7c5a30594706653dec57acdcc6b3c2e7bcbe'
  foreach ($m2 in $made) {
    $printed = & $apksigner.FullName verify --print-certs (Join-Path $out $m2.name) 2>&1 | Out-String
    if ($printed -notmatch $wantPrint) {
      throw "包 $($m2.name) 不是正式证书签的（apksigner 没找到 $wantPrint）。发布一律正式签名。"
    }
  }
  Write-Host '[sign] 证书指纹校验通过（正式签名）'
}

# ---- 6. 其它 ABI 也留一份小清单，方便人工挑包（客户端不读）----
$index = @{ version = $version; versionCode = $versionCode; builtAt = (Get-Date).ToString('s'); apks = $made } |
  ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText((Join-Path $out 'index.json'), $index, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ''
Write-Host "输出目录：$out"
Get-ChildItem $out | ForEach-Object { Write-Host ("  {0}  {1:N0} B" -f $_.Name, $_.Length) }
Write-Host ''
if ($Debug) {
  Write-Host '签名：debug（自测包，不能发出去；发布用不带 -Debug 的默认模式）'
} else {
  Write-Host '签名：正式（_build/keystore/ellen-release.jks，指纹已校验）'
  Write-Host '提醒：发版前确认 versionCode 已递增，否则已装的客户端会判「已是最新」，更新根本不会触发。'
}
