# 构建新艾莲 APK（web 产物 + 原生壳一起出）
# 为什么需要这个脚本：Gradle 不会自动跑 Vite，assets\public 是上一次 build 的残留，
# 只跑 gradle 会拿到「旧 web + 新原生」，页面上看不到新加的探针卡。必须先 vite build。
#
# 用法（在任意目录）：
#   pwsh -File E:\ailian\艾莲手机版\创作版\app\build-apk.ps1
#   pwsh -File ...\build-apk.ps1 -SkipWeb      # 只重编原生
#   pwsh -File ...\build-apk.ps1 -Split        # 按 ABI 拆包（arm64 / x86_64 各一个）
#   pwsh -File ...\build-apk.ps1 -Release      # 用正式证书出包（老大 2026-11-13 定：以后都用这个）
#   pwsh -File ...\build-apk.ps1 -Release -Split
#
# 正式证书在 _build\keystore\ellen-release.jks，口令在同目录 keystore.properties（不进 git）。
# 指纹 D8:C4:EA:12:05:0C:02:5D:20:31:04:91:D1:6C:7C:5A:30:59:47:06:65:3D:EC:57:AC:DC:C6:B3:C2:E7:BC:BE
# 注意：release 签名与手机上的 debug 版不兼容，换签名那一次必须卸载重装（先导出资料包）。
param(
  [switch]$SkipWeb,
  [switch]$Split,
  [switch]$Release
)
$ErrorActionPreference = 'Stop'
$root = 'E:\ailian\艾莲手机版\创作版\app'
$node = 'E:\ailian\工具\node\node-v24.21.0-win-x64'
$env:npm_config_cache = 'E:\ailian\工具\npm-cache'
$env:JAVA_HOME = 'C:\Program Files\Microsoft\jdk-21.0.10.7-hotspot'
$env:GRADLE_USER_HOME = 'E:\ailian\工具\gradle-home'

if (-not $SkipWeb) {
  Push-Location "$root\web"
  try {
    & "$node\node.exe" node_modules\vite\bin\vite.js build --logLevel warn
    if ($LASTEXITCODE -ne 0) { throw "vite build 失败（exit $LASTEXITCODE）" }
  } finally { Pop-Location }
  $pub = "$root\app\src\main\assets\public"
  $stamp = (Get-Item "$pub\index.html").LastWriteTime
  Write-Host "[web] assets\public\index.html  $stamp"
}

$task = if ($Release) { ':app:assembleRelease' } else { ':app:assembleDebug' }
$gradleArgs = @($task, '--console=plain', '-q')
if ($Split) { $gradleArgs += '-PellenAbiSplit=true' }

if ($Release) {
  $props = "$root\..\_build\keystore\keystore.properties"
  if (-not (Test-Path $props)) { throw "找不到正式签名口令文件：$props（没有它 gradle 会退回 debug 签名，出的包不是正式证书）" }
  Write-Host "[sign] release · $props"
}

Push-Location $root
try {
  & 'E:\ailian\工具\gradle-8.11.1\bin\gradle.bat' @gradleArgs
  if ($LASTEXITCODE -ne 0) { throw "gradle $task 失败（exit $LASTEXITCODE）" }
} finally { Pop-Location }

# 拆包时输出是 app-arm64-v8a-<buildType>.apk / app-x86_64-<buildType>.apk，不拆才是 app-<buildType>.apk；
# 一律按「最新改动的那个 apk」取，避免脚本写死名字。
$buildType = if ($Release) { 'release' } else { 'debug' }
$dir = "$root\app\build\outputs\apk\$buildType"
$apks = Get-ChildItem "$dir\*.apk" | Sort-Object LastWriteTime -Descending
if (-not $apks) { throw "没找到 apk：$dir" }
foreach ($f in $apks) {
  Write-Host "[apk] $($f.Name)  $($f.Length) B  $($f.LastWriteTime)"
}
