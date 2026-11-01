#!/usr/bin/env bash
# 打包后端源码 zip（Release 资产 Cocoa-backend-vX.Y.Z.zip，供 deploy/upgrade.sh 自升级使用）
#
# 用法：bash scripts/package-backend.sh [输出目录]
#   版本号取自 package.json 的 version；产物：<输出目录>/Cocoa-backend-v<version>.zip
#
# 包含：server/src、package.json、package-lock.json、deploy/、docs/、README.md、LICENSE、update<version>.md
# 排除：data、node_modules、.env、build.md、changelog*、app/、scripts/、server/test、.git
#
# 构建机没有 zip 二进制，打包走 scripts/zip-dir.mjs（纯 Node + zlib 实现的 ZIP 写入器）
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-/data/dsh/home}"
VERSION="$(node -p "require('$ROOT/package.json').version")"
NAME="Cocoa-backend-v${VERSION}.zip"
OUT="$OUT_DIR/$NAME"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

log() { printf '\033[1;32m[package]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[package]\033[0m %s\n' "$*" >&2; exit 1; }

cd "$ROOT"
mkdir -p "$STAGE/pkg"

log "打包后端 v$VERSION → $OUT"

for item in server/src package.json package-lock.json deploy docs README.md LICENSE "update${VERSION}.md"; do
  [ -e "$item" ] || die "缺少必需文件/目录：$item"
  mkdir -p "$STAGE/pkg/$(dirname "$item")"
  cp -a "$item" "$STAGE/pkg/$item"
done

# deploy 内不应随包分发的东西
rm -rf "$STAGE/pkg/deploy/backups"
find "$STAGE/pkg" -name '*.log' -delete 2>/dev/null || true
rm -rf "$STAGE/pkg/data" "$STAGE/pkg/node_modules" "$STAGE/pkg/.env" "$STAGE/pkg/build.md"
find "$STAGE/pkg" -maxdepth 1 -name 'changelog*.md' -delete 2>/dev/null || true

node "$ROOT/scripts/zip-dir.mjs" "$STAGE/pkg" "$OUT" || die "zip 打包失败"

SIZE="$(du -h "$OUT" | cut -f1)"
SHA="$(sha256sum "$OUT" | cut -d' ' -f1)"
log "产物：$OUT（$SIZE）"
log "sha256：$SHA"

node "$ROOT/scripts/verify-backend-zip.mjs" "$OUT" || die "结构自检失败"
