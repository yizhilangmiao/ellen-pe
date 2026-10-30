# 开发版签名：用 uber-apk-signer 给未签名包打 v2/v3 签名（debug keystore）。
# 用法：
#   pwsh -File _dev_sign.ps1                       # 签 _build\*-dev-unsigned.apk 里最新的一个
#   pwsh -File _dev_sign.ps1 -Apk X.apk            # 指定包
#   pwsh -File _dev_sign.ps1 -Apk X.apk -Publish   # 签完复制进 ..\产出版\（覆盖同名）
param(
    [string]$Apk = "",
    [switch]$Publish
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$signer = "E:\ailian\工具\apk工具链\uber-apk-signer.jar"
$outDir = Join-Path $here "_build"

if (-not (Test-Path $signer)) { throw "缺签名器: $signer" }

if (-not $Apk) {
    $Apk = Get-ChildItem $outDir -Filter "*-dev-unsigned.apk" |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1 -ExpandProperty FullName
    if (-not $Apk) { throw "在 $outDir 里找不到 *-dev-unsigned.apk，先跑 _dev_pack.py" }
}
if (-not (Test-Path $Apk)) { throw "缺包: $Apk" }

$java = "java"
if (-not (Get-Command java -ErrorAction SilentlyContinue)) {
    $cand = "C:\Program Files\Microsoft\jdk-21.0.10.7-hotspot\bin\java.exe"
    if (Test-Path $cand) { $java = $cand } else { throw "找不到 java，也没找到 JDK 21" }
}

Write-Host "签名: $Apk"
& $java -jar $signer -a $Apk --allowResign -o $outDir
if ($LASTEXITCODE -ne 0) { throw "uber-apk-signer 失败，退出码 $LASTEXITCODE" }

$signed = Get-ChildItem $outDir -Filter "*-aligned-debugSigned.apk" |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $signed) { throw "签名器没产出 *-aligned-debugSigned.apk" }
Write-Host ("已签名: {0}  {1} bytes" -f $signed.Name, $signed.Length)

if ($Publish) {
    $pub = Join-Path (Split-Path -Parent $here) "产出版"
    $dst = Join-Path $pub ($signed.Name -replace "-aligned-debugSigned", "")
    Copy-Item $signed.FullName $dst -Force
    Write-Host "已发布到: $dst"
}
