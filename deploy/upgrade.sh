#!/usr/bin/env bash
# Cocoa 后端自升级脚本
# 部署路径：/opt/cocoa/deploy/upgrade.sh（chmod +x）
# 调用方：backend-platform 的 API 以 `spawn(script, [tag])` 方式调用，tag 已校验 ^v\d+\.\d+\.\d+(-pre)?$
#
# 用法：
#   upgrade.sh v1.2.0                 # 后台执行升级（立即返回，脚本已 detach）
#   upgrade.sh v1.2.0 --foreground    # 前台执行（调试 / 手工演练）
#   upgrade.sh v1.2.0 --check         # 只探测 Release 资产是否存在（退出码 3 = 不存在）
#
# 环境变量（API 契约）：
#   COCOA_UPGRADE_TAG       等价于第 1 个参数
#   COCOA_UPGRADE_STATUS    状态 JSON 路径，默认 /opt/cocoa/data/upgrade-status.json
#   COCOA_UPGRADE_LOG       追加日志路径，默认 /opt/cocoa/data/upgrade.log
#   COCOA_UPGRADE_LOG_ID    调用方日志 ID（原样回写进状态 JSON）
#   COCOA_UPGRADE_FROM      调用方声称的当前版本（仅记录，实际以 package.json 为准）
#   COCOA_ROOT              应用根目录，默认 /opt/cocoa
#
# 状态 JSON（写终态后 API 回写 upgrade_logs）：
#   {"running":bool,"status":"running|success|failed","tag","fromVersion","toVersion",
#    "message","progress":0-100,"startedAt","finishedAt","log","logId"}
#
# 退出码：0 成功（或已 detach）；1 失败（已尝试回滚）；2 参数/前置条件错误；3 --check 资产不存在
set -Eeuo pipefail

TAG="${1:-${COCOA_UPGRADE_TAG:-}}"
MODE="${2:-}"
APP_DIR="${COCOA_ROOT:-${COCOA_APP_DIR:-/opt/cocoa}}"
PREV_DIR="${APP_DIR}.prev"
NEW_DIR="${APP_DIR}.new"
SERVICE="${COCOA_SERVICE:-cocoa}"
REPO="${COCOA_GITHUB_REPO:-takwoo258-create/Cocoa}"
STATUS_FILE="${COCOA_UPGRADE_STATUS:-$APP_DIR/data/upgrade-status.json}"
LOG_FILE="${COCOA_UPGRADE_LOG:-$APP_DIR/data/upgrade.log}"
LOG_ID="${COCOA_UPGRADE_LOG_ID:-}"
PORT="${COCOA_PORT:-}"
STARTED_AT="$(date -u +%FT%TZ)"

log() { printf '[upgrade %s] %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$LOG_FILE" >&2; }
die() { log "ERROR: $*"; status "failed" "${STEP:-unknown}" "$*" 0; exit "${2:-1}"; }

# ── 状态写入（契约格式）────────────────────────────────
status() { # status <status> <step/message> <message> <progress>
  local st="$1" step="$2" msg="$3" prog="${4:-0}"
  local from=""
  from="$([ -f "$APP_DIR/package.json" ] && node -p "require('$APP_DIR/package.json').version" 2>/dev/null || true)"
  node -e '
    const fs = require("fs");
    const [file, st, tag, from, to, msg, prog, started, logFile, logId, step] = process.argv.slice(1);
    const now = new Date().toISOString();
    const terminal = st === "success" || st === "failed";
    const obj = {
      running: !terminal,
      status: st,
      tag,
      fromVersion: from || null,
      toVersion: to,
      message: msg,
      progress: Number(prog) || 0,
      step,
      startedAt: started,
      updatedAt: now,
      finishedAt: terminal ? now : null,
      log: logFile,
      logId: logId || null,
    };
    fs.mkdirSync(require("path").dirname(file), { recursive: true });
    const tmp = file + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
    fs.renameSync(tmp, file);
  ' "$STATUS_FILE" "$st" "$TAG" "${from:-}" "$TAG_V" "$msg" "$prog" "$STARTED_AT" "$LOG_FILE" "$LOG_ID" "$step"
}

[ -n "$TAG" ] || { echo "用法: upgrade.sh <TAG> [--foreground|--check]" >&2; exit 2; }
[[ "$TAG" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+(-pre)?$ ]] || { echo "TAG 格式非法：$TAG" >&2; exit 2; }
TAG_V="${TAG#v}"
TAG="${TAG#v}"; TAG="v${TAG_V}"

mkdir -p "$(dirname "$STATUS_FILE")"
touch "$LOG_FILE" 2>/dev/null || true
STEP="init"

if [ "$MODE" = "--check" ]; then
  URL="https://github.com/${REPO}/releases/download/${TAG}/Cocoa-backend-${TAG}.zip"
  code="$(curl -sSL -o /dev/null -w '%{http_code}' -m 30 --range 0-1 "$URL" || true)"
  case "$code" in 200|206) echo "OK $URL"; exit 0 ;; *) echo "MISS($code) $URL"; exit 3 ;; esac
fi

[ "$(id -u)" = "0" ] || { echo "必须以 root 执行" >&2; exit 2; }

# ── detach：服务重启会带走父进程，必须先脱离 ─────────────
SELF_TMP="/tmp/cocoa-upgrade-${TAG_V}.sh"
if [ "$MODE" != "--foreground" ] && [ "${COCOA_UPGRADE_DETACHED:-0}" != "1" ]; then
  cp "$0" "$SELF_TMP"
  chmod +x "$SELF_TMP"
  status "running" "queued" "升级任务已排队：$TAG" 1
  COCOA_UPGRADE_DETACHED=1 setsid nohup bash "$SELF_TMP" "$TAG" --foreground >>"$LOG_FILE" 2>&1 < /dev/null &
  echo "{\"accepted\":true,\"tag\":\"$TAG\",\"status\":\"$STATUS_FILE\"}"
  exit 0
fi

command -v node >/dev/null 2>&1 || die "未找到 node" 2
command -v curl >/dev/null 2>&1 || die "未找到 curl" 2
command -v unzip >/dev/null 2>&1 || die "未找到 unzip" 2

if [ -z "$PORT" ] && [ -f "$APP_DIR/.env" ]; then
  PORT="$(grep -E '^PORT=' "$APP_DIR/.env" | cut -d= -f2 | tr -d '[:space:]')"
fi
PORT="${PORT:-8787}"

ASSET="Cocoa-backend-${TAG}.zip"
URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"
SRC_URL="https://github.com/${REPO}/archive/refs/tags/${TAG}.tar.gz"

STEP="prepare"; status "running" "prepare" "准备升级 $TAG" 5
log "开始升级 → $TAG（日志 $LOG_FILE）"

# ── 1. 下载 ─────────────────────────────────────────────
STEP="download"; status "running" "download" "下载 $ASSET" 15
TMP="$(mktemp -d /tmp/cocoa-upgrade.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
IS_TAR=0
IMG="$TMP/backend.zip"
log "下载 $URL"
if ! curl -fSL --retry 3 --connect-timeout 15 -m 900 -o "$IMG" "$URL"; then
  log "Release 资产不可用，回退源码包：$SRC_URL"
  IMG="$TMP/backend.tar.gz"; IS_TAR=1
  curl -fSL --retry 3 --connect-timeout 15 -m 900 -o "$IMG" "$SRC_URL" || die "下载失败（Release 与源码包均不可用）"
fi

# ── 2. 解压 + 版本校验 ─────────────────────────────────
STEP="extract"; status "running" "extract" "解压并校验版本" 30
rm -rf "$NEW_DIR"; mkdir -p "$NEW_DIR" "$TMP/src"
if [ "$IS_TAR" = "1" ]; then tar -xzf "$IMG" -C "$TMP/src"; else unzip -q "$IMG" -d "$TMP/src"; fi
SRC="$(find "$TMP/src" -maxdepth 2 -name package.json -printf '%h\n' | head -1)"
[ -n "$SRC" ] || die "包内未找到 package.json"
cp -a "$SRC"/. "$NEW_DIR"/
NEW_VER="$(node -p "require('$NEW_DIR/package.json').version" 2>/dev/null || true)"
[ "$NEW_VER" = "$TAG_V" ] || die "版本校验失败：包内 version=$NEW_VER，期望 $TAG_V"

# ── 3. 停服务 + 快照 ───────────────────────────────────
STEP="snapshot"; status "running" "snapshot" "停止服务并快照当前版本" 40
log "停止 $SERVICE"
systemctl stop "$SERVICE" 2>/dev/null || true
if [ -d "$APP_DIR" ]; then
  rm -rf "$PREV_DIR"; mkdir -p "$PREV_DIR"
  tar -C "$APP_DIR" --exclude=./data --exclude=./node_modules -cf - . 2>/dev/null | tar -C "$PREV_DIR" -xf - || \
    log "警告：代码快照不完整"
  date -u +%FT%TZ > "$PREV_DIR/.installed-at" 2>/dev/null || true
fi

# ── 4. 交换 + 接管运行时文件 ────────────────────────────
STEP="swap"; status "running" "swap" "交换代码目录（保留 data/.env）" 50
if [ -d "$APP_DIR/data" ]; then rm -rf "$NEW_DIR/data"; mv "$APP_DIR/data" "$NEW_DIR/data"; fi
mkdir -p "$NEW_DIR/data"
for f in .env .masterkey .admin-initial-password; do
  if [ -f "$APP_DIR/$f" ]; then cp -a "$APP_DIR/$f" "$NEW_DIR/$f"; fi
done

OLD_DIR="${APP_DIR}.old-$(date +%Y%m%d%H%M%S)"
mv "$APP_DIR" "$OLD_DIR"
mv "$NEW_DIR" "$APP_DIR"
rm -rf "$OLD_DIR" 2>/dev/null || true

# ── 5. 依赖 ─────────────────────────────────────────────
STEP="npm"; status "running" "npm" "安装生产依赖（npm ci --omit=dev）" 65
cd "$APP_DIR"; export HOME="$APP_DIR"
if [ -f package-lock.json ]; then
  npm ci --omit=dev --no-audit --no-fund >>"$LOG_FILE" 2>&1 || npm install --omit=dev --no-audit --no-fund >>"$LOG_FILE" 2>&1 || die "npm 安装失败"
else
  npm install --omit=dev --no-audit --no-fund >>"$LOG_FILE" 2>&1 || die "npm 安装失败"
fi
[ -d "$APP_DIR/node_modules/express" ] || die "依赖缺失（node_modules/express）"

# ── 6. 启动 + 健康校验 ─────────────────────────────────
STEP="restart"; status "running" "restart" "启动服务并校验健康" 85
systemctl daemon-reload
systemctl start "$SERVICE"
ok=0
for _ in $(seq 1 40); do
  body="$(curl -fsS -m 3 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null || true)"
  if [ -n "$body" ] && printf '%s' "$body" | grep -q "\"version\":\"${TAG_V}\""; then ok=1; break; fi
  sleep 1
done
if [ "$ok" = "1" ]; then
  STEP="done"; status "success" "done" "升级成功：$TAG" 100
  log "升级成功 → $TAG（$body）"
  rm -f "$SELF_TMP"
  exit 0
fi

# ── 7. 回滚 ─────────────────────────────────────────────
STEP="rollback"; status "running" "rollback" "健康校验失败，回滚中" 90
log "健康校验失败，开始回滚"
systemctl stop "$SERVICE" 2>/dev/null || true
BAD_DIR="${APP_DIR}.failed-$(date +%Y%m%d%H%M%S)"
mv "$APP_DIR" "$BAD_DIR" 2>/dev/null || true
if [ -d "$PREV_DIR" ] && [ -f "$PREV_DIR/package.json" ]; then
  cp -a "$PREV_DIR" "$APP_DIR"
  mkdir -p "$APP_DIR/data"
  [ -d "$BAD_DIR/data" ] && cp -a "$BAD_DIR/data/." "$APP_DIR/data/" 2>/dev/null || true
  for f in .env .masterkey .admin-initial-password; do
    [ -f "$BAD_DIR/$f" ] && cp -a "$BAD_DIR/$f" "$APP_DIR/$f"
  done
  systemctl start "$SERVICE"; sleep 4
  if curl -fsS -m 5 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    status "failed" "rollback" "升级失败，已回滚到上一版本（坏版本保留在 $BAD_DIR）" 100
    log "已回滚，服务恢复"
  else
    status "failed" "rollback" "升级失败且回滚后仍不健康，需人工介入（坏版本 $BAD_DIR）" 100
    log "回滚后仍不健康，需人工介入"
  fi
else
  status "failed" "rollback" "升级失败且无可回滚快照" 100
fi
rm -f "$SELF_TMP"
exit 1
