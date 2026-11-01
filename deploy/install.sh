#!/usr/bin/env bash
# Cocoa 服务器端安装/升级脚本（在目标服务器以 root 执行）
# 用法：deploy/install.sh <code.tar.gz> [APP_DIR] [PORT]
#   代码包由 deploy/deploy.mjs 上传，也可手工打包：
#   tar -czf /tmp/cocoa.tar.gz --exclude=node_modules --exclude=data --exclude=.git --exclude=app/build .
# 设计要点：
#   * /opt/cocoa/data 永久数据目录，升级绝不覆盖
#   * 升级前把当前代码快照到 /opt/cocoa.prev，用于 rollback.sh
#   * 不触碰 NapCat 及其 systemd 单元；端口被占用直接失败退出，由上层换端口
set -Eeuo pipefail

TARBALL="${1:?用法: install.sh <code.tar.gz> [APP_DIR] [PORT]}"
APP_DIR="${2:-/opt/cocoa}"
PORT="${3:-8787}"
SERVICE="cocoa"
RUN_USER="cocoa"
NODE_MIN_MAJOR=22
NODE_MIN_MINOR=5
NODE_VER="24.11.1"
NODE_TARBALL="node-v${NODE_VER}-linux-x64.tar.xz"
NODE_URL="https://nodejs.org/dist/v${NODE_VER}/${NODE_TARBALL}"
NODE_MIRROR="https://npmmirror.com/mirrors/node/v${NODE_VER}/${NODE_TARBALL}"

log()  { printf '\033[1;32m[cocoa-install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[cocoa-install]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[cocoa-install]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "必须以 root 执行"
[ -f "$TARBALL" ] || die "找不到代码包：$TARBALL"

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local v major minor
  v="$(node -v 2>/dev/null | sed 's/^v//')"
  major="${v%%.*}"; minor="$(echo "$v" | cut -d. -f2)"
  [ "$major" -gt "$NODE_MIN_MAJOR" ] && return 0
  [ "$major" -eq "$NODE_MIN_MAJOR" ] && [ "${minor%.*}" -ge "$NODE_MIN_MINOR" ] && return 0
  return 1
}

install_node() {
  log "安装 Node ${NODE_VER}（官方 tar.xz，静态解压到 /usr/local/lib/nodejs）"
  local tmp; tmp="$(mktemp -d)"
  for url in "$NODE_URL" "$NODE_MIRROR"; do
    if curl -fL --retry 2 --connect-timeout 15 -m 900 -o "$tmp/node.tar.xz" "$url"; then break; fi
    warn "下载失败：$url"; rm -f "$tmp/node.tar.xz"
  done
  [ -s "$tmp/node.tar.xz" ] || die "Node 下载失败（官方与镜像均不可用）"
  mkdir -p /usr/local/lib/nodejs
  tar -xJf "$tmp/node.tar.xz" -C /usr/local/lib/nodejs || die "Node 解压失败（服务器缺少 xz-utils？）"
  local dir; dir="/usr/local/lib/nodejs/node-v${NODE_VER}-linux-x64"
  for b in node npm npx; do ln -sf "$dir/bin/$b" "/usr/local/bin/$b"; done
  rm -rf "$tmp"
  node -v | grep -q . || die "Node 安装后不可用"
  log "Node 就绪：$(node -v) / npm $(npm -v)"
}

port_free() { # port_free <port>
  if command -v ss >/dev/null 2>&1; then
    ss -lnt 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${1}$" && return 1
  fi
  return 0
}

# ── 1. Node ────────────────────────────────────────────
type node >/dev/null 2>&1 || echo "export PATH=/usr/local/bin:$PATH" >/etc/profile.d/cocoa-node.sh
if node_ok; then
  log "复用已有 Node：$(node -v)"
else
  install_node
fi
NODE_BIN="$(command -v node)"
[ -x "$NODE_BIN" ] || die "找不到 node 可执行文件"
log "Node 绝对路径：$NODE_BIN"

# ── 2. 运行用户 ────────────────────────────────────────
if ! id "$RUN_USER" >/dev/null 2>&1; then
  log "创建系统用户 $RUN_USER"
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$RUN_USER" 2>/dev/null || \
    useradd -r -d "$APP_DIR" -s /sbin/nologin "$RUN_USER"
fi

# ── 3. 端口冲突检查（不杀任何进程；本服务自身占用属正常升级）──────
if ! port_free "$PORT"; then
  MAINPID="$(systemctl show -p MainPID --value "$SERVICE" 2>/dev/null || echo 0)"
  PORT_PIDS="$(ss -lntp 2>/dev/null | grep -E "[:.]${PORT} " | grep -oE 'pid=[0-9]+' | cut -d= -f2 | tr '\n' ' ')"
  if [ "${MAINPID:-0}" != "0" ] && echo " $PORT_PIDS " | grep -q " $MAINPID "; then
    log "端口 $PORT 由 $SERVICE 自身占用（MainPID=$MAINPID），属正常升级流程，继续"
  else
    warn "端口 $PORT 已被其它进程占用，占用者："
    ss -lntp 2>/dev/null | grep -E "[:.]${PORT} " || true
    die "端口 $PORT 被非 Cocoa 进程占用；请换端口（例如 8788）或先由人工迁移占用者。本脚本不会终止其它服务。"
  fi
fi

# ── 4. 备份上一版代码（data 目录不动）──────────────────
mkdir -p "$APP_DIR" "$APP_DIR/data"
if [ -f "$APP_DIR/package.json" ] && [ -z "${COCOA_SKIP_PREV:-}" ]; then
  log "快照当前代码到 $APP_DIR.prev"
  rm -rf "$APP_DIR.prev"
  mkdir -p "$APP_DIR.prev"
  tar -C "$APP_DIR" --exclude=./data -cf - . 2>/dev/null | tar -C "$APP_DIR.prev" -xf - || \
    warn "快照失败（继续安装，但无 $APP_DIR.prev 可回滚）"
  echo "$(date -u +%FT%TZ)" > "$APP_DIR.prev/.installed-at" 2>/dev/null || true
fi

# ── 5. 解包代码 ────────────────────────────────────────
STAGE="$(mktemp -d /tmp/cocoa-stage.XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT
tar -xzf "$TARBALL" -C "$STAGE" || die "代码包解压失败"
# 保留 data/ 与运行时文件：只覆盖代码文件（--delete 不得删掉数据、密钥、备份）
rsync -a --delete \
  --exclude 'data/' --exclude '.env' --exclude '.masterkey' \
  --exclude '.admin-initial-password' --exclude 'backups/' --exclude '*.log' \
  "$STAGE"/ "$APP_DIR"/ 2>/dev/null || {
    # 无 rsync 时退回 tar 覆盖（不删除旧文件）
    cp -a "$STAGE"/. "$APP_DIR"/
  }
mkdir -p "$APP_DIR/data"

# ── 6. 依赖 ────────────────────────────────────────────
log "安装生产依赖（--omit=dev）"
cd "$APP_DIR"
export HOME="$APP_DIR"
if [ -f package-lock.json ]; then
  npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund
else
  npm install --omit=dev --no-audit --no-fund
fi
[ -d "$APP_DIR/node_modules/express" ] || die "依赖安装失败（node_modules/express 缺失）"

# ── 7. .env（仅首次生成）───────────────────────────────
if [ ! -f "$APP_DIR/.env" ]; then
  log "生成 $APP_DIR/.env（随机主密钥与管理员密码，稍后请记录）"
  MK="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")"
  AP="$(node -e "console.log(require('crypto').randomBytes(12).toString('base64url'))")"
  cat >"$APP_DIR/.env" <<EOF
NODE_ENV=production
HOST=0.0.0.0
PORT=${PORT}
PUBLIC_URL=http://$(hostname -I 2>/dev/null | awk '{print $1}'):${PORT}
COCOA_DATA_DIR=${APP_DIR}/data
COCOA_MASTER_KEY=${MK}
COCOA_ADMIN_EMAIL=${COCOA_ADMIN_EMAIL:-admin@cocoa.local}
COCOA_ADMIN_PASSWORD=${AP}
COCOA_TOKEN_TTL=2592000
COCOA_ALLOW_REGISTER=1
COCOA_LOG_LEVEL=info
ONEBOT_WS_PATH=/onebot/ws
EOF
  echo "$AP" >"$APP_DIR/.admin-initial-password"
  chmod 600 "$APP_DIR/.admin-initial-password"
else
  log "保留已有 .env（不覆盖）；仅校正 PORT/COCOA_DATA_DIR"
  sed -i "s|^PORT=.*|PORT=${PORT}|" "$APP_DIR/.env"
  grep -q '^COCOA_DATA_DIR=' "$APP_DIR/.env" || echo "COCOA_DATA_DIR=${APP_DIR}/data" >>"$APP_DIR/.env"
fi
# 已存在 .env 但初始密码文件缺失（例如被 --delete 清掉）时，从 .env 回填，避免管理员凭据无处可查
if [ ! -f "$APP_DIR/.admin-initial-password" ]; then
  EXIST_PW="$(grep -E '^COCOA_ADMIN_PASSWORD=' "$APP_DIR/.env" | cut -d= -f2- || true)"
  if [ -n "$EXIST_PW" ]; then
    printf '%s\n' "$EXIST_PW" >"$APP_DIR/.admin-initial-password"
    chmod 600 "$APP_DIR/.admin-initial-password"
    log "已从 .env 回填 $APP_DIR/.admin-initial-password"
  fi
fi
chmod 600 "$APP_DIR/.env"
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"

# ── 8. systemd ─────────────────────────────────────────
install -m 644 "$APP_DIR/deploy/cocoa.service" "/etc/systemd/system/${SERVICE}.service"
sed -i "s|^WorkingDirectory=.*|WorkingDirectory=${APP_DIR}|" "/etc/systemd/system/${SERVICE}.service"
sed -i "s|^EnvironmentFile=.*|EnvironmentFile=${APP_DIR}/.env|" "/etc/systemd/system/${SERVICE}.service"
sed -i "s|^ReadWritePaths=.*|ReadWritePaths=${APP_DIR}/data|" "/etc/systemd/system/${SERVICE}.service"
sed -i "s|^User=.*|User=${RUN_USER}|" "/etc/systemd/system/${SERVICE}.service"
sed -i "s|^ExecStart=.*|ExecStart=${NODE_BIN} server/src/index.js|" "/etc/systemd/system/${SERVICE}.service"
sed -i "s|^Group=.*|Group=${RUN_USER}|" "/etc/systemd/system/${SERVICE}.service"
systemctl daemon-reload
log "启动 $SERVICE"
systemctl enable "$SERVICE" >/dev/null 2>&1 || true
systemctl restart "$SERVICE"

# ── 9. 防火墙放行（只开新端口，不动 NapCat）────────────
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qiE "^Status: active"; then
  ufw allow "${PORT}/tcp" >/dev/null 2>&1 && log "ufw 放行 ${PORT}/tcp"
elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port="${PORT}/tcp" >/dev/null && firewall-cmd --reload >/dev/null && log "firewalld 放行 ${PORT}/tcp"
else
  warn "未检测到活动的 ufw/firewalld；云厂商安全组需手动放行 ${PORT}/tcp"
fi

# ── 10. 冒烟 ───────────────────────────────────────────
log "等待健康检查 http://127.0.0.1:${PORT}/api/health"
ok=0
for i in $(seq 1 30); do
  if curl -fsS -m 3 "http://127.0.0.1:${PORT}/api/health" >/tmp/cocoa-health.json 2>/dev/null; then ok=1; break; fi
  sleep 1
done
if [ "$ok" = "1" ]; then
  log "健康检查通过：$(cat /tmp/cocoa-health.json)"
else
  warn "健康检查失败，最近日志："
  systemctl stop "$SERVICE" 2>/dev/null || true
  journalctl -u "$SERVICE" -n 40 --no-pager || true
  die "部署失败（已停止服务避免重启风暴），可执行 deploy/rollback.sh 回滚"
fi

log "完成：$APP_DIR  端口 $PORT  服务 $SERVICE"
log "初始管理员密码：$APP_DIR/.admin-initial-password（登录后请修改并删除该文件）"
