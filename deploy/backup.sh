#!/usr/bin/env bash
# Cocoa 数据备份（在目标服务器以 root 执行，建议 systemd timer 每日 03:30）
# 用法：deploy/backup.sh [APP_DIR] [保留份数]
#   * 用 node:sqlite 的 VACUUM INTO 做一致性快照（WAL 模式下直接拷 .db 会不一致）
#   * 打包 data/ 下除 .db 外的内容（vault / media / logs）
#   * 产物：<APP_DIR>/backups/cocoa-YYYYmmdd-HHMMSS.tar.gz
#   * 默认保留 14 份；不在仓库内，密码/密钥来自 .env 不落备份目录文件头
set -Eeuo pipefail

APP_DIR="${1:-/opt/cocoa}"
KEEP="${2:-14}"
DATA_DIR="${APP_DIR}/data"
BK_DIR="${APP_DIR}/backups"
STAMP="$(date +%Y%m%d-%H%M%S)"
WORK="$(mktemp -d)"

log()  { printf '\033[1;32m[cocoa-backup]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[cocoa-backup]\033[0m %s\n' "$*" >&2; exit 1; }
trap 'rm -rf "$WORK"' EXIT

[ -d "$DATA_DIR" ] || die "数据目录不存在：$DATA_DIR"
mkdir -p "$BK_DIR"

DB="$DATA_DIR/cocoa.db"
if [ -f "$DB" ]; then
  log "一致性快照 cocoa.db → $WORK/cocoa.db"
  node -e '
    const { DatabaseSync } = require("node:sqlite");
    const [src, dst] = process.argv.slice(1);
    const db = new DatabaseSync(src, { readOnly: true });
    db.exec(`VACUUM INTO ${JSON.stringify(dst)}`);
    db.close();
  ' "$DB" "$WORK/cocoa.db" || die "sqlite 快照失败（Node 版本需 >= 22.5）"
else
  log "未发现 cocoa.db，跳过数据库快照"
fi

log "打包 vault / media / logs"
( cd "$DATA_DIR" && tar -czf "$WORK/assets.tar.gz" \
    --exclude='cocoa.db' --exclude='cocoa.db-wal' --exclude='cocoa.db-shm' \
    . 2>/dev/null || true )

OUT="$BK_DIR/cocoa-${STAMP}.tar.gz"
tar -czf "$OUT" -C "$WORK" . || die "备份打包失败"
chmod 600 "$OUT"
log "备份完成：$OUT ($(du -h "$OUT" | cut -f1))"

# 轮转
ls -1t "$BK_DIR"/cocoa-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  log "删除旧备份 $old"; rm -f "$old"
done
log "当前保留 $(ls -1 "$BK_DIR"/cocoa-*.tar.gz 2>/dev/null | wc -l) 份"
