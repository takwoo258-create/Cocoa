#!/usr/bin/env bash
# Cocoa 后端自升级脚本
# 部署路径：/opt/cocoa/deploy/upgrade.sh（chmod +x）
# 调用方：backend-platform API 以 `spawn(script, [tag])` 调用；tag 已校验 ^v\d+\.\d+\.\d+(-pre)?$
#
# 用法：
#   upgrade.sh v1.2.0                 # 后台执行（立即返回，脚本已 setsid detach）
#   upgrade.sh v1.2.0 --foreground    # 前台执行（调试 / 演练）
#   upgrade.sh v1.2.0 --check         # 只探测 Release 资产（退出码 3 = 不存在）
#   upgrade.sh v1.2.0 --dry-run       # 下载/解压/版本/权限前置检查，不 swap
#
# 环境变量（API 契约）：
#   COCOA_UPGRADE_TAG / COCOA_UPGRADE_STATUS / COCOA_UPGRADE_LOG /
#   COCOA_UPGRADE_LOG_ID / COCOA_UPGRADE_FROM / COCOA_ROOT
#
# 状态 JSON：{"running","status":"running|success|failed","tag","fromVersion","toVersion",
#             "message","progress":0-100,"step","startedAt","updatedAt","finishedAt","log","logId"}
#
# 可靠性要点（v1.2.0 演练回归）：
#   * 旧目录 $OLD_DIR 保持到健康校验通过为止，回滚用 mv 换回（含 node_modules，不需联网重装）
#   * swap 之后的任何失败（npm/启动/health）都走统一的 rollback_from_old
#   * 下载失败依次尝试 GitHub 直连与 gh-proxy 镜像
#   * 异常退出（set -e）由 EXIT trap 把 running 状态落成 failed
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
STATE_DIR="${COCOA_STATE_DIR:-/var/lib/cocoa}"
# 注意：状态与日志必须写在 APP_DIR 之外。升级过程中 APP_DIR 会被 mv 走，
# 若继续往 APP_DIR/data 写，会把目录重新创建出来，随后 mv NEW_DIR APP_DIR 会变成嵌套移动（严重 bug）。
STATUS_STABLE="$STATE_DIR/upgrade-status.json"
LOG_FILE="$STATE_DIR/upgrade.log"
# API 契约里的默认查看路径：终态时同步一份到 $APP_DIR/data/
STATUS_MIRROR="$APP_DIR/data/upgrade-status.json"
LOG_ID="${COCOA_UPGRADE_LOG_ID:-}"
PORT="${COCOA_PORT:-}"
MIRROR_PREFIX="${COCOA_GH_PROXY:-https://gh-proxy.com/}"
STARTED_AT="$(date -u +%FT%TZ)"
TERMINAL=0
STEP="init"

log() { printf '[upgrade %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >>"$LOG_FILE"; }

# ── 状态写入 ────────────────────────────────────────────
status() { # status <status> <step> <message> <progress>
  local st="$1" step="$2" msg="$3" prog="${4:-0}" from=""
  from="$([ -f "$APP_DIR/package.json" ] && node -p "require('$APP_DIR/package.json').version" 2>/dev/null || true)"
  node -e '
    const fs = require("fs"), path = require("path");
    const [file, st, tag, from, to, msg, prog, started, logFile, logId, step] = process.argv.slice(1);
    const now = new Date().toISOString();
    const terminal = st === "success" || st === "failed";
    const obj = { running: !terminal, status: st, tag, fromVersion: from || null, toVersion: to,
      message: msg, progress: Number(prog) || 0, step, startedAt: started, updatedAt: now,
      finishedAt: terminal ? now : null, log: logFile, logId: logId || null };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
    fs.renameSync(tmp, file);
  ' "$STATUS_STABLE" "$st" "$TAG" "${from:-}" "$TAG_V" "$msg" "$prog" "$STARTED_AT" "$LOG_FILE" "$LOG_ID" "$step"
  # 镜像到 APP_DIR/data（仅当目录已存在，绝不创建）
  if [ -d "$APP_DIR/data" ]; then cp -f "$STATUS_STABLE" "$STATUS_MIRROR" 2>/dev/null || true; fi
  case "$st" in success|failed) TERMINAL=1 ;; esac
}

die() { local msg="$1" code="${2:-1}"; log "ERROR: $msg"; status "failed" "$STEP" "$msg" 0 || true; exit "$code"; }

[ -n "$TAG" ] || { echo "用法: upgrade.sh <TAG> [--foreground|--check]" >&2; exit 2; }
[[ "$TAG" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+(-pre)?$ ]] || { echo "TAG 格式非法：$TAG" >&2; exit 2; }
TAG_V="${TAG#v}"; TAG="v${TAG_V}"

mkdir -p "$STATE_DIR" 2>/dev/null || true
chmod 750 "$STATE_DIR" 2>/dev/null || true
touch "$LOG_FILE" 2>/dev/null || true

ASSET="Cocoa-backend-${TAG}.zip"
URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"
MIRROR_URL="${MIRROR_PREFIX}${URL}"
SRC_URL="https://github.com/${REPO}/archive/refs/tags/${TAG}.tar.gz"

if [ "$MODE" = "--check" ]; then
  for u in "$URL" "$MIRROR_URL"; do
    code="$(curl -sSL -o /dev/null -w '%{http_code}' -m 30 --range 0-1 "$u" 2>/dev/null || true)"
    case "$code" in 200|206) echo "OK $u"; exit 0 ;; esac
  done
  echo "MISS $URL"
  exit 3
fi

[ "$(id -u)" = "0" ] || { echo "必须以 root 执行" >&2; exit 2; }

# ── detach ─────────────────────────────────────────────
SELF_TMP="/tmp/cocoa-upgrade-${TAG_V}.sh"
if [ "$MODE" != "--foreground" ] && [ "$MODE" != "--dry-run" ] && [ "$MODE" != "--check" ] && [ "${COCOA_UPGRADE_DETACHED:-0}" != "1" ]; then
  cp "$0" "$SELF_TMP"; chmod +x "$SELF_TMP"
  status "running" "queued" "升级任务已排队：$TAG" 1 || true
  COCOA_UPGRADE_DETACHED=1 setsid nohup bash "$SELF_TMP" "$TAG" --foreground >>"$LOG_FILE" 2>&1 < /dev/null &
  echo "{\"accepted\":true,\"tag\":\"$TAG\",\"status\":\"$STATUS_STABLE\"}"
  exit 0
fi

command -v node >/dev/null 2>&1 || die "未找到 node" 2
command -v curl >/dev/null 2>&1 || die "未找到 curl" 2

if [ -z "$PORT" ] && [ -f "$APP_DIR/.env" ]; then
  PORT="$(grep -E '^PORT=' "$APP_DIR/.env" | cut -d= -f2 | tr -d '[:space:]')"
fi
PORT="${PORT:-8787}"

UNZIP_BIN=""
command -v unzip >/dev/null 2>&1 && UNZIP_BIN="$(command -v unzip)"

TMP="$(mktemp -d /tmp/cocoa-upgrade.XXXXXX)"
# 异常退出兜底：状态文件不留在 running
cleanup() {
  local code=$?
  rm -rf "$TMP" 2>/dev/null || true
  if [ "${TERMINAL:-0}" != "1" ]; then
    status "failed" "$STEP" "升级脚本异常退出（rc=$code），详见 $LOG_FILE" 0 || true
  fi
}
trap cleanup EXIT

health_version() { # 输出当前 /api/health 的 version 字段
  curl -fsS -m 3 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'
}

# 回滚：用 $OLD_DIR（含 node_modules）整体换回，data/.env 等从坏目录搬回
rollback_from_old() { # rollback_from_old <msg>
  local msg="$1" bad_dir
  STEP="rollback"
  log "开始回滚：$msg"
  status "running" "rollback" "升级失败，回滚中：$msg" 90
  systemctl stop "$SERVICE" 2>/dev/null || true
  bad_dir="${APP_DIR}.failed-$(date +%Y%m%d%H%M%S)"
  [ -d "$APP_DIR" ] && mv "$APP_DIR" "$bad_dir"
  if [ -d "$OLD_DIR" ]; then
    mv "$OLD_DIR" "$APP_DIR"
    mkdir -p "$APP_DIR/data"
    if [ -d "$bad_dir/data" ] && [ -f "$bad_dir/data/cocoa.db" ]; then
      cp -a "$bad_dir/data/." "$APP_DIR/data/" 2>/dev/null || true
    elif [ -d "$bad_dir/cocoa.new/data" ]; then
      cp -a "$bad_dir/cocoa.new/data/." "$APP_DIR/data/" 2>/dev/null || true
    fi
    chown -R cocoa:cocoa "$APP_DIR/data" 2>/dev/null || true
    chmod 755 "$APP_DIR/data" 2>/dev/null || true
    for f in .env .masterkey .admin-initial-password; do
      [ -f "$bad_dir/$f" ] && cp -a "$bad_dir/$f" "$APP_DIR/$f" || true
    done
    chown -R cocoa:cocoa "$APP_DIR/data" 2>/dev/null || true
    systemctl start "$SERVICE"
    sleep 4
    if [ -n "$(health_version)" ]; then
      status "failed" "rollback" "升级失败已回滚到上一版本（坏版本保留在 $bad_dir）：$msg" 100
      log "回滚完成，服务已恢复"
      return 0
    fi
    status "failed" "rollback" "升级失败且回滚后服务仍不健康，需人工介入（坏版本 $bad_dir）" 100
    log "回滚后仍不健康，需人工介入"
    return 1
  fi
  status "failed" "rollback" "升级失败且无可回滚目录（$OLD_DIR 不存在）" 100
  log "无可回滚目录"
  return 1
}

STEP="prepare"; status "running" "prepare" "准备升级 $TAG" 5
log "=== 开始升级 → $TAG（日志 $LOG_FILE）==="

# ── 1. 下载（直连 → gh-proxy 镜像）──────────────────────
STEP="download"; status "running" "download" "下载 $ASSET" 15
IMG="$TMP/backend.zip"
ok=0
# 先镜像后直连：GitHub release 资产在部分网络下会连上但数据卡死
for u in "$MIRROR_URL" "$URL"; do
  log "下载 $u"
  if curl -fsSL --retry 1 --retry-delay 2 --connect-timeout 10 -m 180 -o "$IMG" "$u"; then ok=1; break; fi
  log "下载失败：$u"
  rm -f "$IMG"
done
if [ "$ok" != "1" ]; then
  log "Release 资产均不可用，回退源码包：$SRC_URL"
  IMG="$TMP/backend.tar.gz"
  curl -fsSL --retry 1 --connect-timeout 10 -m 180 -o "$IMG" "$SRC_URL" || die "下载失败（Release / 镜像 / 源码包均不可用）"
  IS_TAR=1
else
  IS_TAR=0
fi

# ── 2. 解压 + 版本校验 ─────────────────────────────────
STEP="extract"; status "running" "extract" "解压并校验版本" 30
rm -rf "$NEW_DIR"; mkdir -p "$NEW_DIR" "$TMP/src"
if [ "${IS_TAR:-0}" = "1" ]; then
  tar -xzf "$IMG" -C "$TMP/src" || die "解压失败（tar）"
elif [ -n "$UNZIP_BIN" ]; then
  "$UNZIP_BIN" -q "$IMG" -d "$TMP/src" || die "解压失败（unzip）"
elif [ -f "$APP_DIR/deploy/unzip.mjs" ]; then
  node "$APP_DIR/deploy/unzip.mjs" "$IMG" "$TMP/src" || die "解压失败（node unzip）"
else
  die "缺少解压工具（unzip / deploy/unzip.mjs）" 2
fi
SRC="$(find "$TMP/src" -maxdepth 2 -name package.json -printf '%h\n' | head -1)"
[ -n "$SRC" ] || die "包内未找到 package.json"
cp -a "$SRC"/. "$NEW_DIR"/
NEW_VER="$(node -p "require('$NEW_DIR/package.json').version" 2>/dev/null || true)"
[ "$NEW_VER" = "$TAG_V" ] || die "版本校验失败：包内 version=$NEW_VER，期望 $TAG_V"

if [ "$MODE" = "--dry-run" ]; then
  status "success" "dry-run" "预检通过：$ASSET 可下载、可解压、版本 $TAG_V 一致（未执行升级）" 100
  log "dry-run 通过：$ASSET / version=$TAG_V"
  exit 0
fi

# ── 3. 停服务，旧目录整体改名保留（含 node_modules）────
STEP="snapshot"; status "running" "snapshot" "停止服务并保留上一版目录" 40
log "停止 $SERVICE"
systemctl stop "$SERVICE" 2>/dev/null || true
OLD_DIR="${APP_DIR}.old-$(date +%Y%m%d%H%M%S)"
rm -rf "$OLD_DIR"
[ -d "$APP_DIR" ] && mv "$APP_DIR" "$OLD_DIR"
[ -d "$OLD_DIR" ] || die "旧目录不存在，无法升级（$APP_DIR）"

# ── 4. 数据与密钥从旧目录迁到新目录，再换上 ─────────────
STEP="swap"; status "running" "swap" "交换代码目录（保留 data/.env）" 50
if [ -d "$OLD_DIR/data" ]; then rm -rf "$NEW_DIR/data"; mv "$OLD_DIR/data" "$NEW_DIR/data"; fi
mkdir -p "$NEW_DIR/data"
for f in .env .masterkey .admin-initial-password; do
  [ -f "$OLD_DIR/$f" ] && cp -a "$OLD_DIR/$f" "$NEW_DIR/$f"
done
# 防御：确保 APP_DIR 不存在，否则 mv 会把新目录嵌套进去
rm -rf "$APP_DIR"
mv "$NEW_DIR" "$APP_DIR"
chown -R cocoa:cocoa "$APP_DIR/data" 2>/dev/null || true
chmod 755 "$APP_DIR/data" 2>/dev/null || true

# ── 5. 依赖（失败也走回滚）─────────────────────────────
STEP="npm"; status "running" "npm" "安装生产依赖（npm ci --omit=dev）" 65
cd "$APP_DIR"; export HOME="$APP_DIR"
if [ -f package-lock.json ]; then
  npm ci --omit=dev --no-audit --no-fund >>"$LOG_FILE" 2>&1 || npm install --omit=dev --no-audit --no-fund >>"$LOG_FILE" 2>&1 || { rollback_from_old "npm 安装失败"; exit 1; }
else
  npm install --omit=dev --no-audit --no-fund >>"$LOG_FILE" 2>&1 || { rollback_from_old "npm 安装失败"; exit 1; }
fi
[ -d "$APP_DIR/node_modules/express" ] || { rollback_from_old "依赖缺失（node_modules/express）"; exit 1; }

# ── 6. 启动 + 健康校验 ─────────────────────────────────
STEP="restart"; status "running" "restart" "启动服务并校验健康" 85
chown -R cocoa:cocoa "$APP_DIR/data" 2>/dev/null || true
systemctl daemon-reload
systemctl start "$SERVICE" || true
got=""
for _ in $(seq 1 40); do
  got="$(health_version)"
  [ "$got" = "$TAG_V" ] && break
  sleep 1
done
if [ "$got" != "$TAG_V" ]; then
  rollback_from_old "健康校验失败（期望 $TAG_V，实际 ${got:-无响应}）"
  exit 1
fi

# ── 7. 成功：旧目录转成 .prev（供 deploy.mjs/rollback.sh 使用）──
STEP="done"
rm -rf "$PREV_DIR"
mv "$OLD_DIR" "$PREV_DIR" 2>/dev/null || true
date -u +%FT%TZ > "$PREV_DIR/.installed-at" 2>/dev/null || true
status "success" "done" "升级成功：$TAG" 100
log "=== 升级成功 → $TAG（health version=$got）==="
if [ -d "$APP_DIR/data" ]; then cp -f "$LOG_FILE" "$APP_DIR/data/upgrade.log" 2>/dev/null || true; fi
rm -f "$SELF_TMP"
exit 0
