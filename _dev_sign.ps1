# 开发版签名：用 uber-apk-signer 给未签名包打 v2/v3 签名（debug keystore）。
# 用法：
#   pwsh -File _dev_sign.ps1                       # 签 _build\*-dev-unsigned.apk 里最新的一个
#   pwsh -File _dev_sign.ps1 -Apk X.apk            # 指定包
#   pwsh -File _dev_sign.ps1 -Apk X.apk -Publish   # 签完复制进 ..\产出版\（覆盖同名）
param(
    [string]$Apk = "",
    [string]$Signer = "",
    [switch]$Publish
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$outDir = Join-Path $here "_build"

# 签名器查找顺序：显式参数 > 本机工具链 > 同级 _工具\ > 脚本旁。
# 这样换机器/换目录也能用，不必改脚本。
if (-not $Signer) {
    $cands = @(
        "E:\ailian\工具\apk工具链\uber-apk-signer.jar",
        (Join-Path (Split-Path -Parent $here) "_工具\uber-apk-signer.jar"),
        (Join-Path $here "_工具\uber-apk-signer.jar"),
        (Join-Path $here "uber-apk-signer.jar")
    )
    foreach ($c in $cands) {
        if (Test-Path $c) { $Signer = $c; break }
    }
}
$signer = $Signer
if (-not $signer -or -not (Test-Path $signer)) {
    $msg = @(
        '缺签名器 uber-apk-signer.jar。放到下面任一位置，或用 -Signer 指定路径：'
        '  E:\ailian\工具\apk工具链\'
        '  <创作版上一级>\_工具\'
        '  <创作版>\_工具\'
    ) -join [Environment]::NewLine
    throw $msg
}

if (-not $Apk) {
    $Apk = Get-ChildItem $outDir -Filter "*-dev-unsigned.apk" |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1 -ExpandProperty FullName
    if (-not $Apk) { throw "在 $outDir 里找不到 *-dev-unsigned.apk，先跑 _dev_pack.py" }
}
if (-not (Test-Path $Apk)) { throw "缺包: $Apk" }

$java = "java"
if (-not (Get-Command java -ErrorAction SilentlyContinue)) {
    $javaCands = @()
    if ($env:JAVA_HOME) { $javaCands += (Join-Path $env:JAVA_HOME "bin\java.exe") }
    $javaCands += "C:\Program Files\Microsoft\jdk-21.0.10.7-hotspot\bin\java.exe"
    foreach ($root in @("C:\Program Files\Java", "C:\Program Files\Eclipse Adoptium", "C:\Program Files\Microsoft")) {
        if (Test-Path $root) {
            $javaCands += (Get-ChildItem $root -Directory -ErrorAction SilentlyContinue |
                ForEach-Object { Join-Path $_.FullName "bin\java.exe" } |
                Where-Object { Test-Path $_ })
        }
    }
    $hit = $javaCands | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($hit) { $java = $hit } else { throw "找不到 java。装一个 JDK 17 或 21（或设 JAVA_HOME），或把 java.exe 加进 PATH。" }
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
