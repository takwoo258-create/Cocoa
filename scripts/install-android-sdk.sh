#!/usr/bin/env bash
# Android SDK 直接安装（不依赖 sdkmanager/JVM）
# 背景：本机 JDK17 下 sdkmanager 触发 jdk.internal.logger.LoggerFinderLoader 初始化异常（JDK 侧问题），
#       改用 Google 官方 repository XML + 直接下载/解压，等价于 sdkmanager --install。
# 用法：bash install-android-sdk.sh [SDK_ROOT]
set -Eeuo pipefail

SDK="${1:-/data/dsh/home/.toolchain/android-sdk}"
BB="/data/dsh/home/.toolchain/bin/busybox"
BASE="https://dl.google.com/android/repository"
LOG="/tmp/cocoa-toolchain.log"
TMP="/data/dsh/home/.toolchain/downloads/sdk"
mkdir -p "$SDK" "$TMP"

log() { echo "[$(date +%H:%M:%S)] [sdk] $*" | tee -a "$LOG"; }
die() { echo "[$(date +%H:%M:%S)] [sdk][error] $*" | tee -a "$LOG" >&2; exit 1; }

log "拉取 repository2-3.xml 解析包地址"
curl -fsSL -m 120 "$BASE/repository2-3.xml" -o "$TMP/repository2-3.xml" || die "repository XML 下载失败"

pick_url() { # pick_url <path> —— 从 XML 中找该包的 linux 归档 URL
  node -e '
    const fs=require("fs");
    const xml=fs.readFileSync(process.argv[1],"utf8");
    const want=process.argv[2];
    // 抓取 <remotePackage path="…"> … </remotePackage>
    const re=/<remotePackage path="([^"]+)"[\s\S]*?<\/remotePackage>/g;
    let m, hit=null;
    while((m=re.exec(xml))){
      if(m[1]!==want) continue;
      const block=m[0];
      const archs=[...block.matchAll(/<archive>([\s\S]*?)<\/archive>/g)].map(x=>x[1]);
      // 优先 linux 专用归档；没有 host-os 的是通用归档（platform / build-tools 即如此）
      const pick=archs.find(a=>/<host-os>linux<\/host-os>/.test(a)) || archs.find(a=>!/<host-os>/.test(a));
      if(pick){ const u=pick.match(/<url>([^<]+)<\/url>/); if(u){ hit=u[1]; break; } }
    }
    if(!hit) process.exit(3);
    console.log(hit);
  ' "$TMP/repository2-3.xml" "$1"
}

install_zip() { # install_zip <pkg-path> <url> <dest-subdir>
  local pkg="$1" url="$2" dest="$3"
  local zip="$TMP/$(basename "$url")"
  if [ -d "$SDK/$dest" ] && [ -n "$(ls -A "$SDK/$dest" 2>/dev/null)" ]; then
    log "已存在 $dest，跳过"; return 0
  fi
  log "下载 $pkg → $url"
  curl -fL --retry 3 --connect-timeout 20 -m 1800 -sS -o "$zip" "$BASE/$url" || die "下载失败 $url"
  local stage="$TMP/stage-$(basename "$url" .zip)"
  rm -rf "$stage"; mkdir -p "$stage"
  "$BB" unzip -q -o "$zip" -d "$stage" || die "解压失败 $url"
  # 解压后可能是单一顶层目录，也可能直接是内容
  local top; top="$(find "$stage" -maxdepth 1 -mindepth 1 | head -1)"
  local count; count="$(find "$stage" -maxdepth 1 -mindepth 1 | wc -l)"
  mkdir -p "$(dirname "$SDK/$dest")"
  rm -rf "$SDK/$dest"
  if [ "$count" -eq 1 ] && [ -d "$top" ]; then mv "$top" "$SDK/$dest"; else mv "$stage" "$SDK/$dest"; fi
  rm -rf "$stage"
  log "安装完成 $dest（$(du -sh "$SDK/$dest" | cut -f1)）"
}

# platform-tools（adb / fastboot）
install_zip "platform-tools" "platform-tools-latest-linux.zip" "platform-tools"

# platforms;android-35
P35_URL="$(pick_url 'platforms;android-35')" || die "解析 platforms;android-35 失败"
install_zip "platforms;android-35" "$P35_URL" "platforms/android-35"

# build-tools;35.0.0
BT_URL="$(pick_url 'build-tools;35.0.0')" || die "解析 build-tools;35.0.0 失败"
install_zip "build-tools;35.0.0" "$BT_URL" "build-tools/35.0.0"

# Flutter 3.47 默认 compileSdk/targetSdk = 36（见 FlutterExtension.kt），因此平台 36 与
# build-tools 36.0.0 是实际构建所需；35 保留兼容（AGP 8.6~8.9 默认 buildToolsVersion）。
P36_URL="$(pick_url 'platforms;android-36')" || die "解析 platforms;android-36 失败"
install_zip "platforms;android-36" "$P36_URL" "platforms/android-36"
BT36_URL="$(pick_url 'build-tools;36.0.0')" || die "解析 build-tools;36.0.0 失败"
install_zip "build-tools;36.0.0" "$BT36_URL" "build-tools/36.0.0"

# licenses（AGP 校验这几个文件存在且含已知哈希）
mkdir -p "$SDK/licenses"
printf '24333f8a63b6825ea9c5514f83c2829b004d1fee\nd56f5187479451eabf01fb78af6dfcb131a6481e\n' >"$SDK/licenses/android-sdk-license"
printf '84831b9409646a918e30573bab4c9c91346d8abd\n' >"$SDK/licenses/android-sdk-preview-license"
log "licenses 写入完成"

# 校验关键文件
for f in "platforms/android-35/android.jar" "build-tools/35.0.0/aapt2" "platform-tools/adb"; do
  [ -e "$SDK/$f" ] || die "缺少关键文件：$SDK/$f"
done
[ -d "$SDK/platforms/android-36" ] && log "android-36 就绪（Flutter 3.47 compileSdk 默认值）"
chmod +x "$SDK/build-tools/35.0.0/"* "$SDK/build-tools/36.0.0/"* 2>/dev/null || true
log "SDK 校验通过："
ls "$SDK" | tr '\n' ' ' | tee -a "$LOG"; echo | tee -a "$LOG"
"$SDK/build-tools/35.0.0/aapt2" version 2>&1 | head -1 | tee -a "$LOG"
