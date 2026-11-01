#!/usr/bin/env bash
# Cocoa 服务器端回滚（在目标服务器以 root 执行）
# 用法：deploy/rollback.sh [APP_DIR]
#   把 /opt/cocoa 当前代码移开，恢复 /opt/cocoa.prev 的代码快照；
#   data/ 与 .env 永远取最新（回滚代码不回滚数据）。
#   回滚后若健康检查失败，会尝试把“失败版本”换回来，保证线上至少跑一个版本。
set -Eeuo pipefail

APP_DIR="${1:-/opt/cocoa}"
PREV="${APP_DIR}.prev"
SERVICE="cocoa"
RUN_USER="cocoa"
PORT="${COCOA_PORT:-$(grep -E '^PORT=' "$APP_DIR/.env" 2>/dev/null | cut -d= -f2 || true)}"
PORT="${PORT:-8787}"
STAMP="$(date +%Y%m%d%H%M%S)"
BROKEN="${APP_DIR}.broken-${STAMP}"

log()  { printf '\033[1;32m[cocoa-rollback]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[cocoa-rollback]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[cocoa-rollback]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "必须以 root 执行"
[ -d "$PREV" ] || die "没有可回滚的快照：$PREV"

health() {
  for _ in $(seq 1 30); do
    curl -fsS -m 3 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

swap_in_prev() {
  log "停止 $SERVICE"
  systemctl stop "$SERVICE" 2>/dev/null || true
  log "当前代码移开 → $BROKEN（保留 data 于其中）"
  mv "$APP_DIR" "$BROKEN"
  log "恢复快照 $PREV → $APP_DIR"
  mv "$PREV" "$APP_DIR"
  # 数据与配置取最新
  if [ -d "$BROKEN/data" ]; then
    mkdir -p "$APP_DIR/data"
    cp -a "$BROKEN/data/." "$APP_DIR/data/"
  fi
  [ -f "$BROKEN/.env" ] && cp -a "$BROKEN/.env" "$APP_DIR/.env"
  chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"
  chmod 600 "$APP_DIR/.env" 2>/dev/null || true
  systemctl daemon-reload
  systemctl start "$SERVICE"
}

log "回滚到上一版本（快照时间：$(cat "$PREV/.installed-at" 2>/dev/null || echo 未知)）"
swap_in_prev

if health; then
  log "回滚成功，服务健康：http://127.0.0.1:${PORT}/api/health"
  log "失败版本仍保留在 $BROKEN（确认稳定后可删除）"
else
  warn "回滚版本健康检查失败，把失败版本换回来以避免长时间停机"
  mv "$APP_DIR" "${APP_DIR}.rollback-failed-${STAMP}"
  mv "$BROKEN" "$APP_DIR"
  systemctl start "$SERVICE" || true
  journalctl -u "$SERVICE" -n 60 --no-pager || true
  die "两版均未通过健康检查，需人工介入。目录：$APP_DIR / ${APP_DIR}.rollback-failed-${STAMP}"
fi
