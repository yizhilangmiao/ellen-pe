# 拉回本地语义召回要用的模型与推理引擎（共 54 MB，不进 git）
#
# 为什么有这个脚本：app\web\public\models\ 与 public\ort\ 被 .gitignore 排除，
# clone 下来直接 vite build 出的包会缺这四个大文件 —— 后果不是崩，是
# embed.js 静默降级回「字面 + 概念」召回，包还能跑、准度回落，很难察觉。
# 所以出包前先跑这个，脚本会按字节数自检。
#
#   pwsh -File _tools\fetch-models.ps1            # 缺什么补什么
#   pwsh -File _tools\fetch-models.ps1 -Force     # 全部重下
#   pwsh -File _tools\fetch-models.ps1 -Check     # 只体检不下载
param(
  [switch]$Force,
  [switch]$Check
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot          # 创作版\
$web = Join-Path $root 'app\web'
$pub = Join-Path $web 'public'
$modelDir = Join-Path $pub 'models\bge-small-zh-v1.5'
$ortDir = Join-Path $pub 'ort'

# 模型四个文件（HF 上的 Xenova 转换版，仓库里存的是 int8 量化）
$modelFiles = @(
  @{ rel = 'config.json';             size = 716 },
  @{ rel = 'tokenizer_config.json';   size = 367 },
  @{ rel = 'tokenizer.json';          size = 439125 },
  @{ rel = 'onnx/model_int8.onnx';    size = 23903394 }
)
$hfRepos = @(
  'https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/main',
  'https://hf-mirror.com/Xenova/bge-small-zh-v1.5/resolve/main'
)

# ort 的四件套来自 node_modules（npm install 就有），不重复下载
$ortFiles = @(
  @{ src = 'ort-wasm-simd-threaded.jsep.wasm'; size = 21596019 },
  @{ src = 'ort-wasm-simd-threaded.jsep.mjs';  size = 44484 },
  @{ src = 'ort-wasm-simd-threaded.wasm';      size = 11133407 },
  @{ src = 'ort-wasm-simd-threaded.mjs';       size = 20856 }
)
$ortSrc = Join-Path $web 'node_modules\onnxruntime-web\dist'

function Test-Size($path, $want) {
  if (-not (Test-Path -LiteralPath $path)) { return $false }
  return (Get-Item -LiteralPath $path).Length -eq $want
}

$missing = @()
$bad = @()

New-Item -ItemType Directory -Force -Path (Join-Path $modelDir 'onnx'), $ortDir | Out-Null

foreach ($f in $modelFiles) {
  $dst = Join-Path $modelDir ($f.rel -replace '/', '\')
  if ((Test-Size $dst $f.size) -and -not $Force) { continue }
  if ($Check) { $missing += "models\$($f.rel)"; continue }

  $got = $false
  foreach ($base in $hfRepos) {
    $url = "$base/$($f.rel)"
    try {
      Write-Host "  下载 $url"
      Invoke-WebRequest -Uri $url -OutFile $dst -UseBasicParsing -TimeoutSec 600
      if (Test-Size $dst $f.size) { $got = $true; break }
      Write-Warning "  大小不对：$(if (Test-Path $dst) { (Get-Item $dst).Length } else { '没下下来' }) / 期望 $($f.size)"
    } catch {
      Write-Warning "  失败：$($_.Exception.Message)"
    }
  }
  if (-not $got) { $bad += "models\$($f.rel)" }
}

foreach ($f in $ortFiles) {
  $dst = Join-Path $ortDir $f.src
  if ((Test-Size $dst $f.size) -and -not $Force) { continue }
  if ($Check) { $missing += "ort\$($f.src)"; continue }
  $src = Join-Path $ortSrc $f.src
  if (-not (Test-Path -LiteralPath $src)) {
    $bad += "ort\$($f.src)（node_modules 里没有，先 cd app\web && npm install）"
    continue
  }
  Copy-Item -LiteralPath $src -Destination $dst -Force
  if (-not (Test-Size $dst $f.size)) { $bad += "ort\$($f.src)（复制后大小不对）" }
}

# 自检
$problems = @()
foreach ($f in $modelFiles) {
  $dst = Join-Path $modelDir ($f.rel -replace '/', '\')
  if (-not (Test-Size $dst $f.size)) { $problems += "缺或大小不对：models\$($f.rel)" }
}
foreach ($f in $ortFiles) {
  $dst = Join-Path $ortDir $f.src
  if (-not (Test-Size $dst $f.size)) { $problems += "缺或大小不对：ort\$($f.src)" }
}

if ($Check -and $missing.Count) {
  Write-Host "`n以下文件缺失（共 $($missing.Count) 个）："
  $missing | ForEach-Object { Write-Host "  - $_" }
  Write-Host "跑 pwsh -File _tools\fetch-models.ps1 补上。"
  exit 1
}

if ($bad.Count) {
  Write-Host "`n以下文件没搞定："
  $bad | ForEach-Object { Write-Host "  - $_" }
  exit 1
}

if ($problems.Count) {
  Write-Host "`n自检没过："
  $problems | ForEach-Object { Write-Host "  - $_" }
  exit 1
}

$total = (Get-ChildItem $modelDir, $ortDir -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ("[ok] 模型与推理引擎齐了：{0:N1} MB" -f ($total / 1MB))
Write-Host "     $modelDir"
Write-Host "     $ortDir"
Write-Host "     出包前跑一次 vite build，它会把这两个目录整拷贝进 assets\public。"
