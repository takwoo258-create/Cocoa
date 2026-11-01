#!/usr/bin/env bash
# Cocoa 工具链安装：Flutter stable + Temurin JDK17 + Android cmdline-tools/platform 35/build-tools 35
# 日志：/tmp/cocoa-toolchain.log    安装根：/data/dsh/home/.toolchain
# 注意：/tmp 为 256M tmpfs 且 noexec —— 所有下载与大文件放在 /data 下；busybox 提供 xz/unzip（系统无 xz-utils/unzip）
set -uo pipefail

TROOT="/data/dsh/home/.toolchain"
DL="$TROOT/downloads"
BB="$TROOT/bin/busybox"
LOG="/tmp/cocoa-toolchain.log"
FLUTTER_VER="3.47.9"
FLUTTER_URL="https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/flutter_linux_${FLUTTER_VER}-stable.tar.xz"
FLUTTER_MIRROR="https://mirrors.tuna.tsinghua.edu.cn/flutter/flutter_infra_release/releases/stable/linux/flutter_linux_${FLUTTER_VER}-stable.tar.xz"
JDK_URL="https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.21%2B9/OpenJDK17U-jdk_x64_linux_hotspot_17.0.21_9.tar.gz"
JDK_MIRROR="https://mirrors.tuna.tsinghua.edu.cn/Adoptium/17/jdk/x64/linux/OpenJDK17U-jdk_x64_linux_hotspot_17.0.21_9.tar.gz"
CMDLINE_URL="https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
CMDLINE_MIRROR="https://mirrors.tuna.tsinghua.edu.cn/android/repository/commandlinetools-linux-11076708_latest.zip"

mkdir -p "$TROOT" "$DL"
log() { echo "[$(date +%H:%M:%S)] $*" >>"$LOG"; }

fetch() { # fetch <url> <mirror> <out>
  local url="$1" mirror="$2" out="$3"
  if [ -s "$out" ] && [ "$(stat -c%s "$out")" -gt 1000000 ]; then
    log "已存在 $out ($(du -h "$out" | cut -f1))，跳过下载"; return 0
  fi
  for u in "$url" "$mirror"; do
    log "下载 $u"
    if curl -fL --retry 2 --retry-delay 3 --connect-timeout 20 -m 3600 -sS -o "$out.part" "$u"; then
      mv "$out.part" "$out"; log "OK $(du -h "$out" | cut -f1) <- $u"; return 0
    fi
    log "下载失败：$u"; rm -f "$out.part"
  done
  return 1
}

install_jdk() {
  if [ -x "$TROOT/jdk17/bin/java" ]; then log "JDK 已就绪：$("$TROOT/jdk17/bin/java" -version 2>&1 | head -1)"; return 0; fi
  fetch "$JDK_URL" "$JDK_MIRROR" "$DL/jdk17.tar.gz" || return 1
  rm -rf "$TROOT/jdk17.tmp"; mkdir -p "$TROOT/jdk17.tmp"
  tar -xzf "$DL/jdk17.tar.gz" -C "$TROOT/jdk17.tmp" || return 1
  local d; d="$(find "$TROOT/jdk17.tmp" -maxdepth 1 -mindepth 1 -type d | head -1)"
  rm -rf "$TROOT/jdk17"; mv "$d" "$TROOT/jdk17"; rm -rf "$TROOT/jdk17.tmp"
  log "JDK 完成：$("$TROOT/jdk17/bin/java" -version 2>&1 | head -1)"
}

install_flutter() {
  if [ -x "$TROOT/flutter/bin/flutter" ]; then log "Flutter 已存在：$("$TROOT/flutter/bin/flutter" --version 2>&1 | head -1)"; return 0; fi
  fetch "$FLUTTER_URL" "$FLUTTER_MIRROR" "$DL/flutter.tar.xz" || return 1
  rm -rf "$TROOT/flutter.part"; mkdir -p "$TROOT/flutter.part"
  log "解压 Flutter（xz 流式解压）"
  if ! "$BB" xz -d -c "$DL/flutter.tar.xz" | tar -xf - -C "$TROOT/flutter.part"; then log "Flutter 解压失败"; return 1; fi
  rm -rf "$TROOT/flutter"
  mv "$TROOT/flutter.part/flutter" "$TROOT/flutter"; rm -rf "$TROOT/flutter.part"
  git config --global --add safe.directory "$TROOT/flutter" 2>/dev/null
  log "Flutter 解压完成 $(du -sh "$TROOT/flutter" | cut -f1)：$("$TROOT/flutter/bin/flutter" --version 2>&1 | head -1)"
}

install_android() {
  local sdk="$TROOT/android-sdk"
  export JAVA_HOME="$TROOT/jdk17"; export ANDROID_SDK_ROOT="$sdk"; export ANDROID_HOME="$sdk"
  export PATH="$JAVA_HOME/bin:$sdk/cmdline-tools/latest/bin:$sdk/platform-tools:$PATH"
  if [ -x "$sdk/cmdline-tools/latest/bin/sdkmanager" ]; then
    log "cmdline-tools 已存在"
  else
    fetch "$CMDLINE_URL" "$CMDLINE_MIRROR" "$DL/cmdline-tools.zip" || return 1
    rm -rf "$sdk/cmdline-tools"; mkdir -p "$sdk/cmdline-tools"
    "$BB" unzip -q -o "$DL/cmdline-tools.zip" -d "$sdk/cmdline-tools" || return 1
    mv "$sdk/cmdline-tools/cmdline-tools" "$sdk/cmdline-tools/latest"
    log "cmdline-tools 完成"
  fi
  log "接受许可（非交互，yes 管道）"
  yes | sdkmanager --licenses >/dev/null 2>&1
  log "安装 platform-tools / platforms;android-35 / build-tools;35.0.0"
  sdkmanager --install "platform-tools" "platforms;android-35" "build-tools;35.0.0" >>"$LOG" 2>&1
  local rc=$?
  log "sdkmanager rc=$rc；SDK 目录：$(ls "$sdk" | tr '\n' ' ')"
  return $rc
}

configure_flutter() {
  export JAVA_HOME="$TROOT/jdk17"; export ANDROID_SDK_ROOT="$TROOT/android-sdk"; export ANDROID_HOME="$TROOT/android-sdk"
  export PATH="$TROOT/flutter/bin:$JAVA_HOME/bin:$PATH"
  "$TROOT/flutter/bin/flutter" config --android-sdk "$TROOT/android-sdk" --no-analytics >>"$LOG" 2>&1
  log "flutter precache --android（下载引擎产物）"
  "$TROOT/flutter/bin/flutter" precache --android >>"$LOG" 2>&1
  log "flutter doctor -v"
  "$TROOT/flutter/bin/flutter" doctor -v >>"$LOG" 2>&1
  log "doctor 摘要：" ; grep -E "^\[.\]|^•|Flutter \(|Android SDK at" "$LOG" | tail -20 >>"$LOG" 2>/dev/null
}

log "===== 工具链安装开始 $(date -u +%FT%TZ) ====="
install_jdk       && log "阶段 JDK OK"     || log "阶段 JDK FAIL"
install_flutter   && log "阶段 Flutter OK" || log "阶段 Flutter FAIL"
install_android   && log "阶段 Android OK" || log "阶段 Android FAIL"
configure_flutter && log "阶段 FLUTTER-CFG OK" || log "阶段 FLUTTER-CFG FAIL"
log "===== 工具链安装结束 $(date -u +%FT%TZ) ====="
du -sh "$TROOT"/* 2>/dev/null | tee -a "$LOG"
df -h /data | tail -1 | tee -a "$LOG"
