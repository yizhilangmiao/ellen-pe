# 一条命令把更新站部署到服务器：传脚本 → 传包与清单 → 远端装 nginx → 公网自检 → 传签名备份。
#
# 前提：阿里云控制台已经放了 TCP 8080（防火墙那一步只能在控制台点，SSH 里做不了）。
#
# 用法：
#   pwsh -File _tools\deploy_update_site.ps1 -SshHost root@120.27.162.122
#   pwsh -File _tools\deploy_update_site.ps1 -SshHost root@120.27.162.122 -Port 8080 -SkipKeystore
param(
  [Parameter(Mandatory)] [string]$SshHost,
  [int]$Port = 8080,
  [string]$RemoteDir = '/var/www/ellen',
  [string]$PublicIp = '120.27.162.122',
  [switch]$SkipKeystore,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$sshOpt = @('-o','StrictHostKeyChecking=accept-new','-o','ConnectTimeout=15')
$release = (Resolve-Path (Join-Path $PSScriptRoot '..\_build\release')).Path
$manifestPath = Join-Path $release 'latest.json'
if (-not (Test-Path $manifestPath)) { throw '没有 latest.json：先跑 app\release.ps1 -Sign -BaseUrl ...' }

# 清单里的 url 必须指向这台机器的这个端口，否则装上去也是下不到
$m = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$want = "http://${PublicIp}:$Port/"
if (-not ([string]$m.apk.url).StartsWith($want)) {
  throw "清单里的地址是 $($m.apk.url)，与 http://${PublicIp}:$Port/ 不一致（重跑 release.ps1 -BaseUrl）"
}
$apkName = Split-Path -Leaf ([string]$m.apk.url)
$apkPath = Join-Path $release $apkName
if (-not (Test-Path $apkPath)) { throw "缺包：$apkName" }
$sha = (Get-FileHash $apkPath -Algorithm SHA256).Hash.ToLower()
if ($sha -ne $m.apk.sha256) { throw '本地包体与清单 sha256 不一致' }

Write-Host "[0/5] 连通性 $SshHost"
& ssh @sshOpt $SshHost 'echo ok' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "SSH 连不上 $SshHost" }

if ($DryRun) {
  Write-Host "[dry-run] 会传：deploy_site.sh / $apkName / latest.json → ${RemoteDir}，端口 $Port"
  return
}

Write-Host "[1/5] 传安装脚本"
& scp @sshOpt (Join-Path $PSScriptRoot 'deploy_site.sh') "${SshHost}:/tmp/deploy_site.sh"
if ($LASTEXITCODE -ne 0) { throw 'scp 传部署脚本失败' }

Write-Host "[2/5] 传包与清单（$([math]::Round((Get-Item $apkPath).Length/1MB,1)) MB）"
& ssh @sshOpt $SshHost "mkdir -p $RemoteDir"
& scp @sshOpt $apkPath "${SshHost}:$RemoteDir/"
& scp @sshOpt $manifestPath "${SshHost}:$RemoteDir/"

Write-Host "[3/5] 远端装 nginx 并起站"
& ssh @sshOpt $SshHost "bash /tmp/deploy_site.sh $RemoteDir $Port"
if ($LASTEXITCODE -ne 0) { throw '远端部署脚本失败（看上面输出：端口被占 / nginx 起不来）' }

Write-Host "[4/5] 公网自检 http://${PublicIp}:$Port/latest.json"
$localSha = $sha
$ok = $false
for ($i = 0; $i -lt 6; $i++) {
  try {
    $remote = Invoke-RestMethod -Uri "http://${PublicIp}:$Port/latest.json" -Headers @{ 'Cache-Control' = 'no-cache' } -TimeoutSec 15
    if ($remote.apk.sha256 -ne $localSha) { throw "公网清单 sha256 与本地不一致：$($remote.apk.sha256)" }
    $head = Invoke-WebRequest -Uri "http://${PublicIp}:$Port/$apkName" -Method Head -TimeoutSec 20
    $len = [int64]@($head.Headers['Content-Length'])[0]   # PS7 里这是 string[]，直接转 int64 会抛
    if ($len -ne (Get-Item $apkPath).Length) { throw "公网包体 $len ≠ 本地 $((Get-Item $apkPath).Length)" }
    $range = Invoke-WebRequest -Uri "http://${PublicIp}:$Port/$apkName" -Headers @{ Range = 'bytes=0-1023' } -TimeoutSec 20
    $sig = [Text.Encoding]::ASCII.GetString($range.Content[0..1])
    if ($sig -ne 'PK') { throw "前两字节是 $sig 不是 PK" }
    $ok = $true
    break
  } catch {
    Write-Host "  第 $($i+1) 次没通：$($_.Exception.Message)"
    Start-Sleep -Seconds 5
  }
}
if (-not $ok) { throw "公网仍不通。多半是阿里云「防火墙」没放行 TCP $Port（控制台点，SSH 里做不了）" }
Write-Host "  通过：清单一致、包体大小一致、Range 可用（断点续传没问题）"

if (-not $SkipKeystore) {
  Write-Host "[5/5] 备份签名到服务器"
  & (Join-Path $PSScriptRoot 'backup_keystore.ps1') -SshHost $SshHost -RemoteDir '/root/ellen/keystore'
}

Write-Host ''
Write-Host '完成。客户端默认清单地址：' -NoNewline
Write-Host " http://${PublicIp}:$Port/latest.json"