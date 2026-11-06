#!/usr/bin/env bash
# Caddy 安装与配置（在目标服务器以 root 执行）
# 用法：bash deploy/caddy-setup.sh [DOMAIN]
#   DOMAIN 必填：你的域名（sslip.io 泛解析域名或自备域名）
#
# 做的事：
#   1. 下载官方静态二进制（caddyserver.com/api/download，含 systemd 单元）
#   2. 安装到 /usr/local/bin/caddy，创建系统用户 caddy 与数据目录
#   3. 安装 /etc/caddy/Caddyfile（先 validate，renewal_window_ratio 不被支持时自动去掉）
#   4. 安装并启动 caddy.service，enable 自启
#   5. 打印证书申请状态（Let's Encrypt 需要 80/443 对公网可达）
set -Eeuo pipefail

DOMAIN="${1:-${COCOA_DOMAIN:?请提供域名：deploy/caddy-setup.sh <domain> 或设置 COCOA_DOMAIN}}"
CADDY_VER="${CADDY_VER:-}"   # 留空用官方 latest 构建
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { printf '\033[1;32m[caddy]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[caddy]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[caddy]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "必须以 root 执行"

# 1) 二进制
if [ -x /usr/local/bin/caddy ]; then
  log "已安装：$(/usr/local/bin/caddy version)"
else
  TMP="$(mktemp -d)"
  if [ -n "${CADDY_TARBALL:-}" ] && [ -s "$CADDY_TARBALL" ]; then
    log "使用本地离线包：$CADDY_TARBALL"
    cp "$CADDY_TARBALL" "$TMP/caddy.tar.gz"
  else
    # 优先 GitHub Release（caddyserver.com 的下载接口在部分网络下会 HTTP/2 中断）
    VER="${CADDY_VER:-2.11.7}"
    for URL in \
      "https://github.com/caddyserver/caddy/releases/download/v${VER}/caddy_${VER}_linux_amd64.tar.gz" \
      "https://caddyserver.com/api/download?os=linux&arch=amd64&version=v${VER}"; do
      log "下载 $URL"
      if curl -fsSL --retry 3 --connect-timeout 15 -m 900 "$URL" -o "$TMP/caddy.tar.gz"; then break; fi
      rm -f "$TMP/caddy.tar.gz"
    done
    [ -s "$TMP/caddy.tar.gz" ] || die "Caddy 下载失败（GitHub 与官方接口均不可用；可本机下载后传 CADDY_TARBALL）"
  fi
  tar -xzf "$TMP/caddy.tar.gz" -C "$TMP" || die "解压失败"
  install -m 755 "$TMP/caddy" /usr/local/bin/caddy
  if [ -f "$TMP/caddy.service" ]; then
    install -m 644 "$TMP/caddy.service" /etc/systemd/system/caddy.service
    log "使用官方 systemd 单元"
  fi
  rm -rf "$TMP"
  log "安装完成：$(/usr/local/bin/caddy version)"
fi

# 2) 用户与目录
id caddy >/dev/null 2>&1 || useradd --system --home /var/lib/caddy --shell /usr/sbin/nologin caddy
mkdir -p /var/lib/caddy /etc/caddy /var/log/caddy
chown -R caddy:caddy /var/lib/caddy /var/log/caddy

# 3) Caddyfile（校验 → 必要时去掉不被支持项）
install -d /etc/caddy
install -m 644 "$SRC_DIR/Caddyfile" /etc/caddy/Caddyfile
sed -i "s/<DOMAIN>/${DOMAIN}/g" /etc/caddy/Caddyfile
if ! /usr/local/bin/caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/tmp/caddy-validate.log 2>&1; then
  warn "Caddyfile 校验失败，尝试去掉 renewal_window_ratio 后重试："
  tail -3 /tmp/caddy-validate.log >&2 || true
  sed -i '/renewal_window_ratio/d' /etc/caddy/Caddyfile
  /usr/local/bin/caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >>/tmp/caddy-validate.log 2>&1 \
    || { tail -20 /tmp/caddy-validate.log >&2; die "Caddyfile 仍无法通过校验"; }
  warn "已省略 renewal_window_ratio，续签窗口使用 certmagic 默认（剩余约 1/3 时续签）"
fi
log "Caddyfile 校验通过"

# 4) systemd（官方单元缺失时自己写一个）
if [ ! -f /etc/systemd/system/caddy.service ]; then
  cat >/etc/systemd/system/caddy.service <<'EOF'
[Unit]
Description=Caddy web server
Documentation=https://caddyserver.com/docs/
After=network-online.target
Wants=network-online.target

[Service]
User=caddy
Group=caddy
ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
EOF
fi
sed -i "s|^ExecStart=.*|ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile|" /etc/systemd/system/caddy.service
grep -q "^AmbientCapabilities" /etc/systemd/system/caddy.service || \
  sed -i '/^\[Service\]/a AmbientCapabilities=CAP_NET_BIND_SERVICE' /etc/systemd/system/caddy.service

systemctl daemon-reload
systemctl enable caddy >/dev/null 2>&1 || true
systemctl restart caddy
sleep 4

# 5) 状态
if systemctl is-active --quiet caddy; then
  log "caddy.service 已启动"
else
  warn "caddy.service 未运行，最近日志："
  journalctl -u caddy -n 30 --no-pager || true
  exit 1
fi
ss -lntp 2>/dev/null | grep -E ':(80|443)\s' || warn "80/443 尚未监听（可能仍在申请证书）"
log "证书目录：/var/lib/caddy/.local/share/caddy/certificates"
log "查看日志：journalctl -u caddy -f"
log "完成。若公网 80/443 不可达（云安全组），Let's Encrypt 申请会失败，需先放行入站。"
