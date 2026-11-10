# 新建一个「电脑版 → 手机版」功能同步骨架实例
# 用法：pwsh -File _phone-sync\new-phone-sync.ps1 -Feature letter -Title "好感度情书"
# 产出：_patch_phone_<feat>.py（注入补丁） + _phone-sync\inject-<feat>.js（模块骨架）
param(
    [Parameter(Mandatory = $true)][string]$Feature,
    [Parameter(Mandatory = $true)][string]$Title,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$sync = $PSScriptRoot
$root = Split-Path -Parent $sync

if ($Feature -notmatch '^[a-z][a-z0-9]*$') { throw "Feature 只能是小写字母+数字：$Feature" }

$patchOut = Join-Path $root "_patch_phone_$Feature.py"
$injectOut = Join-Path $sync "inject-$Feature.js"

foreach ($p in @($patchOut, $injectOut)) {
    if ((Test-Path $p) -and -not $Force) { throw "已存在，加 -Force 才覆盖：$p" }
}

$tplPatch = Join-Path $sync "_patch_phone_tpl.py"
$tplInject = Join-Path $sync "inject-core.js"
foreach ($p in @($tplPatch, $tplInject)) {
    if (-not (Test-Path $p)) { throw "缺模板：$p" }
}

$enc = New-Object System.Text.UTF8Encoding($false)

$patch = [IO.File]::ReadAllText($tplPatch, $enc) -replace '__FEAT__', $Feature
[IO.File]::WriteAllText($patchOut, $patch, $enc)

$mod = '__ellen' + ($Feature.Substring(0, 1).ToUpper() + $Feature.Substring(1))
$inject = [IO.File]::ReadAllText($tplInject, $enc)
$inject = $inject -replace '__ellenSync', $mod
$inject = $inject -replace '__feat__', $Feature
$inject = $inject -replace '__TITLE__', $Title
[IO.File]::WriteAllText($injectOut, $inject, $enc)

Write-Host "[生成] $patchOut"
Write-Host "[生成] $injectOut"
Write-Host ""
Write-Host "下一步（按顺序）："
Write-Host "  1. 打开 inject-$Feature.js，把同步逻辑和 UI 写完"
Write-Host "  2. 核对 _patch_phone_$Feature.py 里的 ANCHOR 是否仍唯一："
Write-Host "       python _patch_phone_$Feature.py --check   # 锚点必须是 1"
Write-Host "  3. python _patch_phone_$Feature.py            # 注入"
Write-Host "  4. & 'E:\ailian\工具\node\node-v24.21.0-win-x64\node.exe' --check work\assets\public\ellen-startup-opening.js"
Write-Host "  5. python _dev_pack.py ; pwsh -File _dev_sign.ps1"
Write-Host "  6. 真机验收：见 _phone-sync\验收清单.md"
