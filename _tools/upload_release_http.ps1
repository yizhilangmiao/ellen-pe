<#
  走 HTTP 把安装包推到更新站（22 端口不通时的备用通道）

  背景：2026-11-13 SSH 22 从本机被链路中间掐掉（服务器 sshd 正常、SWAS 防火墙 22 放行、
  服务器日志里连本机出口 IP 都没有）。但 8080 是通的 —— nginx 带 dav 模块，
  临时开一个 PUT 口就能把包传上去，传完立刻撤掉。

  用法：
    pwsh -File _tools/upload_release_http.ps1 -Apk "E:\...\_build\release\ellen-0.3.8-arm64-v8a.apk" -Version "0.3.8" -VersionCode 9 -Notes "一句话说明"

  前置：E:\AI-Tools\aliyun\rc.py 可用（云助手），PATH 上的 python 带 aliyun SDK。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Apk,
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][int]$VersionCode,
  [string]$Notes = "",
  [string]$SiteHost = "120.27.162.122",
  [int]$SitePort = 8080,
  [string]$RcPy = "E:\AI-Tools\aliyun\rc.py"
)

$ErrorActionPreference = "Stop"
$base = "http://${SiteHost}:${SitePort}"

function Invoke-Remote([string]$cmd, [int]$timeout = 60) {
  $out = & python $RcPy $cmd $timeout 2>&1
  $text = ($out | Out-String)
  if ($text -notmatch '\[status=Success') { throw "云助手执行失败:`n$text" }
  return $text
}

if (-not (Test-Path $Apk)) { throw "找不到安装包: $Apk" }
$apkName = Split-Path $Apk -Leaf
$size = (Get-Item $Apk).Length
$sha = (Get-FileHash $Apk -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "[1/4] $apkName  $size B  sha256=$sha"

Write-Host "[2/4] 服务器开临时上传口"
$enable = @'
set -e
CONF=/etc/nginx/conf.d/ellen-update.conf
cp -n "$CONF" "$CONF.bak" || true
grep -q '__up' "$CONF" || python3 - "$CONF" <<'PY'
import sys
p=sys.argv[1]; s=open(p,encoding='utf-8').read()
block="\n    # 临时上传口（传完就删）\n    location /__up/ {\n        dav_methods PUT;\n        client_max_body_size 200m;\n        autoindex off;\n    }\n"
i=s.rstrip().rfind('}')
open(p,'w',encoding='utf-8').write(s[:i]+block+"}\n")
PY
mkdir -p /var/www/ellen/__up && chown nginx:nginx /var/www/ellen/__up
nginx -t && systemctl reload nginx && echo READY
'@
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($enable -replace "`r", "")))
Invoke-Remote "echo $b64 | base64 -d > /tmp/up_enable.sh && bash /tmp/up_enable.sh" 60 | Out-Null

Write-Host "[3/4] 上传（注意后缀不能是 .apk，否则被 nginx 的 apk 正则位置截走、吃默认 1MB 限制 → 413）"
# curl 的 -T 用 PUT；名字加 .part 绕开 location ~* \.apk$
& curl.exe -s -T $Apk --max-time 900 -w "http=%{http_code} sent=%{size_upload}`n" "$base/__up/$apkName.part"
if ($LASTEXITCODE -ne 0) { throw "上传失败 exit=$LASTEXITCODE" }

Write-Host "[4/4] 改名 + 写清单 + 撤上传口"
$json = @{
  schemaVersion = 1
  platform = "android"
  packageName = "cn.ellen.companion2"
  channel = "stable"
  version = $Version
  versionCode = $VersionCode
  publishedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  minSdkVersion = 24
  notes = $Notes
  apk = @{
    sha256 = $sha
    url = "$base/$apkName"
    sizeBytes = $size
  }
} | ConvertTo-Json -Depth 5

$finish = @"
set -e
cd /var/www/ellen
mv -f __up/$apkName.part $apkName
chmod 644 $apkName
cat > latest.json <<'JSON'
$json
JSON
chmod 644 latest.json
rm -rf __up
cp -f /etc/nginx/conf.d/ellen-update.conf.bak /etc/nginx/conf.d/ellen-update.conf
nginx -t && systemctl reload nginx && echo RELOADED
sha256sum $apkName
curl -s -o /dev/null -w 'manifest %{http_code}\n' http://127.0.0.1:$SitePort/latest.json
curl -s -o /dev/null -w 'apk_range %{http_code} %{size_download}\n' -r 0-1023 http://127.0.0.1:$SitePort/$apkName
"@
$b642 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($finish -replace "`r", "")))
Invoke-Remote "echo $b642 | base64 -d > /tmp/up_finish.sh && bash /tmp/up_finish.sh" 90

Write-Host ""
Write-Host "线上自检："
& curl.exe -s "$base/latest.json" | Select-String -Pattern 'version|sha256|url'
Write-Host "核对 sha256 与服务端输出一致即完成；apk_range 应为 206。"
