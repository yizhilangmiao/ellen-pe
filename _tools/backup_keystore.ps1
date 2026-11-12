# 把正式签名打包备份（本地 tar.gz + 可选传服务器）。
#
# 为什么必须做：keystore 丢了，之后所有包都换不了签名 —— 已装的人只能卸载重装、靠备份包恢复数据。
# 这跟普通代码备份不是一个量级的事，所以要单独一条命令、单独一个 tar.gz，别混在源码备份里。
#
# 用法：
#   pwsh -File _tools\backup_keystore.ps1
#   pwsh -File _tools\backup_keystore.ps1 -SshHost root@120.27.162.122 -RemoteDir /root/ellen/keystore
param(
  [string]$SshHost = '',
  [string]$RemoteDir = '/root/ellen/keystore',
  [string]$OutDir = ''
)
$ErrorActionPreference = 'Stop'
$ksDir = Join-Path $PSScriptRoot '..\_build\keystore'
$ksDir = (Resolve-Path $ksDir).Path
if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot '..\_build\keystore-backup' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$jks = Join-Path $ksDir 'ellen-release.jks'
$props = Join-Path $ksDir 'keystore.properties'
foreach ($p in @($jks, $props)) { if (-not (Test-Path $p)) { throw "缺文件：$p" } }

# 指纹一起存进包：将来核对「服务器上这份是不是同一把钥匙」
$keytool = 'C:\Program Files\Microsoft\jdk-21.0.10.7-hotspot\bin\keytool.exe'
$storePass = (([IO.File]::ReadAllLines($props) | Where-Object { $_ -like 'storePassword=*' }) -replace 'storePassword=', '')
$fp = ''
if (Test-Path $keytool) {
  $fp = (& $keytool -list -v -keystore $jks -storepass $storePass 2>&1 | Select-String 'SHA256:' | Select-Object -First 1)
  $fp = "$fp".Trim()
}
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$name = "ellen-keystore-$stamp.tar.gz"
$tar = Join-Path $OutDir $name

# 用 tar（Win10+ 自带）打包，保持目录结构简单：三个文件平铺
$stage = Join-Path $env:TEMP "ellen-ks-$stamp"
New-Item -ItemType Directory -Force -Path $stage | Out-Null
Copy-Item $jks $stage -Force
Copy-Item $props $stage -Force
@"
艾莲手机版正式签名备份
打包时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
$fp
恢复方法：把 ellen-release.jks 与 keystore.properties 放回 创作版\_build\keystore\，重新构建即可。
"@ | Set-Content (Join-Path $stage 'README-恢复说明.txt') -Encoding UTF8
& tar -czf $tar -C $stage . 
if ($LASTEXITCODE -ne 0) { throw 'tar 打包失败' }
Remove-Item $stage -Recurse -Force

$size = (Get-Item $tar).Length
$sha = (Get-FileHash $tar -Algorithm SHA256).Hash.ToLower()
Write-Host ("[backup] {0}  {1:N0} B  sha256={2}" -f $tar, $size, $sha.Substring(0, 16))
Write-Host "[backup] $fp"

if ($SshHost) {
  # 服务器那份是离线兜底：目录权限收紧，只给 root 读
  & ssh $SshHost "mkdir -p $RemoteDir && chmod 700 $RemoteDir"
  if ($LASTEXITCODE -ne 0) { throw '服务器建目录失败（SSH 通不通？）' }
  & scp $tar "${SshHost}:$RemoteDir/"
  if ($LASTEXITCODE -ne 0) { throw 'scp 传签名失败' }
  # 回读比对大小，别只看 scp 退出码
  $remoteSize = (& ssh $SshHost "stat -c %s $RemoteDir/$name").Trim()
  if ($remoteSize -ne "$size") { throw "服务器上文件大小 $remoteSize ≠ 本地 $size" }
  Write-Host "[backup] 已上传并回读校验: ${SshHost}:$RemoteDir/$name"
  Write-Host '[backup] 另外在私人网盘/U 盘再放一份 —— 服务器和本机同时出事才是真丢。'
} else {
  Write-Host '[backup] 只做了本地打包；加 -SshHost root@IP 可同步到服务器'
}