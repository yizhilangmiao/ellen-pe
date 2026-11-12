#!/usr/bin/env bash
# 艾莲手机版更新站的服务器侧安装（幂等，可重复跑）
# 由 _tools\deploy_update_site.ps1 上传后执行，不要手改端口而不同步客户端。
set -euo pipefail
DIR="${1:-/var/www/ellen}"
PORT="${2:-8080}"

mkdir -p "$DIR"

echo "[1/6] 检查 $PORT 端口占用"
if command -v ss >/dev/null 2>&1; then
  if ss -lntp 2>/dev/null | grep ":$PORT " | grep -qv 'nginx'; then
    echo "  !! $PORT 已被占用，先确认是不是小鲸鱼/AstrBot 之类的服务：
$(ss -lntp 2>/dev/null | grep ":$PORT " || true)"
    echo "  换端口的话：客户端 core/updates.js 的 DEFAULT_MANIFEST 与 network_security_config.xml 要一起改。"
    exit 2
  fi
  echo "  端口空闲"
fi

echo "[2/6] 确保 nginx 存在"
if ! command -v nginx >/dev/null 2>&1; then
  if command -v dnf >/dev/null 2>&1; then dnf install -y nginx
  else yum install -y nginx; fi
fi
nginx -v 2>&1 | sed 's/^/  /'

echo "[3/6] 写站点配置 /etc/nginx/conf.d/ellen-update.conf"
cat > /etc/nginx/conf.d/ellen-update.conf <<CONF
# 艾莲手机版更新站（自建，IP 直连明文；客户端按 sha256 逐字节校验，改包必失败）
server {
    listen $PORT;
    server_name _;
    root $DIR;
    autoindex off;
    charset utf-8;

    # 清单绝不能进缓存：客户端拿旧清单就永远看不到新版本
    location = /latest.json {
        default_type application/json;
        add_header Cache-Control "no-cache, max-age=0" always;
    }

    # apk 要支持 Range，客户端断点续传靠它（不支持 Range 时会退回整包重下）
    location ~* \.apk\$ {
        default_type application/vnd.android.package-archive;
        add_header Accept-Ranges bytes always;
    }
}
CONF

echo "[4/6] nginx 语法检查并重载"
nginx -t
systemctl enable nginx >/dev/null 2>&1 || true
systemctl reload nginx 2>/dev/null || systemctl restart nginx
systemctl is-active nginx | sed 's/^/  nginx: /'

echo "[5/6] 自检"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/latest.json" || echo 000)
echo "  /latest.json -> $CODE"
if [ -f "$DIR"/*.apk ] 2>/dev/null; then
  APK=$(ls "$DIR"/*.apk | head -1)
  RCODE=$(curl -s -o /dev/null -w '%{http_code}' -H 'Range: bytes=0-1023' "http://127.0.0.1:$PORT/$(basename "$APK")")
  SIZE=$(stat -c %s "$APK")
  echo "  $(basename "$APK") -> $RCODE (Range 请求，206 才算支持续传)  大小 $SIZE"
fi

echo "[6/6] 放行检查提醒"
echo "  如果外部还是连不上，是阿里云控制台「防火墙」没放行 TCP $PORT —— 那一步只能在控制台点。"
echo "  目录：$DIR"