#!/usr/bin/env bash
# Cocoa Android 客户端构建（本机构建机执行，不要在服务器上跑）
# 用法：bash scripts/build-apk.sh [--debug] [--skip-analyze]
# 产物：app/build/app/outputs/flutter-apk/app-release.apk
#       → 复制到 /data/dsh/home/Cocoa-v1.0.1.apk（/tmp 仅 256M 且 noexec，勿作最终存放点）
# 签名：$COCOA_SIGN_DIR（默认 /data/dsh/home/.cocoa-sign）下的 cocoa-release.jks + key.properties，均不入库
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
. "$ROOT/scripts/env.sh"

MODE="release"
SKIP_ANALYZE=0
for arg in "$@"; do
  case "$arg" in
    --debug) MODE="debug" ;;
    --skip-analyze) SKIP_ANALYZE=1 ;;
  esac
done

APP_DIR="$ROOT/app"
OUT_NAME="${COCOA_APK_NAME:-Cocoa-v1.0.1.apk}"
OUT_DIR="${COCOA_OUT_DIR:-/data/dsh/home}"
SIGN_DIR="${COCOA_SIGN_DIR:-/data/dsh/home/.cocoa-sign}"
STOREPASS_FILE="$SIGN_DIR/storepass.txt"

log()  { printf '\033[1;32m[apk]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[apk]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[apk]\033[0m %s\n' "$*" >&2; exit 1; }

[ -x "$JAVA_HOME/bin/java" ] || die "JAVA_HOME 不可用：$JAVA_HOME（先跑 scripts/install-toolchain.sh）"
[ -x "$COCOA_TOOLCHAIN/flutter/bin/flutter" ] || die "Flutter 未安装：$COCOA_TOOLCHAIN/flutter"
[ -d "$ANDROID_SDK_ROOT/platforms" ] || die "Android SDK 不完整：$ANDROID_SDK_ROOT"

cd "$APP_DIR"

# ── 1. Android 平台目录（Flutter 工程脚手架，只生成 android/ 不覆盖 lib/）──
if [ ! -d android ]; then
  log "生成 Android 平台目录（app/android）"
  flutter create --platforms=android --org com.sandcocoa --project-name cocoa --overwrite . >/dev/null
fi

# ── 2. 签名材料（仓库外）──────────────────────────────
mkdir -p "$SIGN_DIR"
chmod 700 "$SIGN_DIR"
if [ ! -f "$SIGN_DIR/cocoa-release.jks" ]; then
  log "生成 release keystore → $SIGN_DIR/cocoa-release.jks"
  STOREPASS="$(node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))")"
  printf '%s\n' "$STOREPASS" >"$STOREPASS_FILE"
  chmod 600 "$STOREPASS_FILE"
  "$JAVA_HOME/bin/keytool" -genkeypair -v \
    -keystore "$SIGN_DIR/cocoa-release.jks" -alias cocoa -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$STOREPASS" -keypass "$STOREPASS" \
    -dname "CN=Cocoa, OU=Sand Salt, O=Cocoa, L=Hangzhou, ST=Zhejiang, C=CN" >/dev/null 2>&1 \
    || die "keystore 生成失败"
else
  STOREPASS="$(cat "$STOREPASS_FILE")"
fi
log "签名密钥就绪（$SIGN_DIR，不入库）"

KEYPROPS="$APP_DIR/android/key.properties"
cat >"$KEYPROPS" <<EOF
storePassword=$STOREPASS
keyPassword=$STOREPASS
keyAlias=cocoa
storeFile=$SIGN_DIR/cocoa-release.jks
EOF
chmod 600 "$KEYPROPS"
grep -q "^/key.properties$\|key.properties" "$ROOT/.gitignore" || echo "app/android/key.properties" >>"$ROOT/.gitignore"

# ── 3. Gradle 注入签名（幂等：已处理过则跳过）────────────
GRADLE_KTS="$APP_DIR/android/app/build.gradle.kts"
GRADLE_GROOVY="$APP_DIR/android/app/build.gradle"
if [ -f "$GRADLE_KTS" ] && ! grep -q "cocoa-keystore" "$GRADLE_KTS"; then
  log "注入 signingConfig（build.gradle.kts）"
  node -e '
    const fs=require("fs"); const p=process.argv[1]; let s=fs.readFileSync(p,"utf8");
    if(!s.includes("cocoa-keystore")){
      const inject = `
// cocoa-keystore: 从 android/key.properties 读取签名（文件不入库，缺失时回落 debug 签名）
val cocoaKeyProps = Properties().apply {
    val f = rootProject.file("key.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
val cocoaKeystoreFile = file(cocoaKeyProps.getProperty("storeFile") ?: "")
val hasCocoaKeystore = cocoaKeystoreFile.exists()
`;
      s = s.replace(/(\n)(android\s*\{)/, "$1"+inject+"$1$2");
      s = s.replace(/buildTypes\s*\{/, `buildTypes {\n        signingConfig = if (hasCocoaKeystore) signingConfigs.create("cocoa") {`+
        ` storeFile = cocoaKeystoreFile; storePassword = cocoaKeyProps.getProperty("storePassword");`+
        ` keyAlias = cocoaKeyProps.getProperty("keyAlias"); keyPassword = cocoaKeyProps.getProperty("keyPassword")`+
        ` } else signingConfigs.getByName("debug")`);
      if(!s.includes("import java.util.Properties")) s="import java.util.Properties\n"+s;
      fs.writeFileSync(p,s);
    }
  ' "$GRADLE_KTS" || warn "build.gradle.kts 注入失败，将使用 debug 签名"
elif [ -f "$GRADLE_GROOVY" ] && ! grep -q "cocoa-keystore" "$GRADLE_GROOVY"; then
  log "注入 signingConfig（build.gradle）"
  node -e '
    const fs=require("fs"); const p=process.argv[1]; let s=fs.readFileSync(p,"utf8");
    if(!s.includes("cocoa-keystore")){
      const inject = `
// cocoa-keystore: 从 android/key.properties 读取签名（文件不入库）
def cocoaKeyProps = new Properties()
def cocoaPropsFile = rootProject.file("key.properties")
if (cocoaPropsFile.exists()) { cocoaPropsFile.withInputStream { cocoaKeyProps.load(it) } }
def cocoaStore = cocoaKeyProps.getProperty("storeFile") ? file(cocoaKeyProps.getProperty("storeFile")) : null
def hasCocoaKeystore = cocoaStore != null && cocoaStore.exists()
`;
      s = s.replace(/(\n)(android\s*\{)/, "$1"+inject+"$1$2");
      s = s.replace(/buildTypes\s*\{/, `buildTypes {\n        if (hasCocoaKeystore) { signingConfig = signingConfigs.create("cocoa") { storeFile cocoaStore; storePassword cocoaKeyProps.getProperty("storePassword"); keyAlias cocoaKeyProps.getProperty("keyAlias"); keyPassword cocoaKeyProps.getProperty("keyPassword") } }`);
      fs.writeFileSync(p,s);
    }
  ' "$GRADLE_GROOVY" || warn "build.gradle 注入失败，将使用 debug 签名"
fi

# ── 4. 依赖与静态分析 ─────────────────────────────────
log "flutter pub get"
flutter pub get

if [ "$SKIP_ANALYZE" = "0" ]; then
  log "flutter analyze（error 会中断构建；warning/info 不阻塞）"
  set +e
  flutter analyze 2>&1 | tee /data/dsh/home/.apk-analyze.log | tail -30
  analyze_rc=${PIPESTATUS[0]}
  set -e
  if grep -qE "^\s*error •" /data/dsh/home/.apk-analyze.log; then
    die "flutter analyze 存在 error，先由客户端线修复：/data/dsh/home/.apk-analyze.log"
  fi
  [ "$analyze_rc" -le 1 ] || warn "analyze 退出码 $analyze_rc（非 error 级）"
fi

# ── 5. 构建 ───────────────────────────────────────────
log "flutter build apk --$MODE（Gradle 串行，堆 2G）"
flutter build apk --"$MODE"

APK="$APP_DIR/build/app/outputs/flutter-apk/app-$MODE.apk"
[ -f "$APK" ] || die "构建产物缺失：$APK"
mkdir -p "$OUT_DIR"
FINAL="$OUT_DIR/$OUT_NAME"
cp -f "$APK" "$FINAL"
SIZE="$(du -h "$FINAL" | cut -f1)"
SHA="$(sha256sum "$FINAL" | cut -d' ' -f1)"
log "产物：$FINAL ($SIZE)"
log "SHA256：$SHA"
"$ANDROID_SDK_ROOT/build-tools/35.0.0/aapt2" dump badging "$FINAL" 2>/dev/null | head -3 || \
  "$JAVA_HOME/bin/jarsigner" -verify "$FINAL" >/dev/null 2>&1 && log "签名校验：$( "$JAVA_HOME/bin/jarsigner" -verify "$FINAL" 2>/dev/null | head -1 )"
