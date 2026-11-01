#!/usr/bin/env bash
# Cocoa 本地构建环境变量（source 使用：source scripts/env.sh）
# 工具链根目录：/data/dsh/home/.toolchain（不属于仓库，不进 git）
# 依赖：scripts/install-toolchain.sh + scripts/install-android-sdk.sh 已执行
# 机器约束：4G 内存（DSH/编辑器自身常驻约 1.3G）→ Gradle 单 JVM、1G 堆、串行、Kotlin 在进程内编译

# ⚠️ 仓库路径含中文（sandsend项目）：JVM 在 POSIX locale 下 sun.jnu.encoding=ANSI_X3.4-1968，
# 会把 -classpath 里的非 ASCII 路径解析失败，报
# “Could not find or load main class org.gradle.wrapper.GradleWrapperMain”。
# 必须先切 UTF-8 locale：
export LANG=C.UTF-8
export LC_ALL=C.UTF-8

export COCOA_TOOLCHAIN="${COCOA_TOOLCHAIN:-/data/dsh/home/.toolchain}"
export JAVA_HOME="$COCOA_TOOLCHAIN/jdk17"
export ANDROID_SDK_ROOT="$COCOA_TOOLCHAIN/android-sdk"
export ANDROID_HOME="$ANDROID_SDK_ROOT"
export PATH="$COCOA_TOOLCHAIN/flutter/bin:$JAVA_HOME/bin:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/platform-tools:$COCOA_TOOLCHAIN/bin:$PATH"

# Gradle / 签名缓存目录
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-/data/dsh/home/.gradle}"
export COCOA_SIGN_DIR="${COCOA_SIGN_DIR:-/data/dsh/home/.cocoa-sign}"

# AGP 的 Android 偏好目录：本机 Java user.home=/home/node 是只读挂载；
# 且 AGP 只要发现 ANDROID_PREFS_ROOT 与 ANDROID_USER_HOME 同时存在就抛
# AndroidLocationsException（即使路径相同）——只保留 ANDROID_USER_HOME。
export ANDROID_USER_HOME="${ANDROID_USER_HOME:-/data/dsh/home/.android}"
unset ANDROID_SDK_HOME 2>/dev/null || true
unset ANDROID_PREFS_ROOT 2>/dev/null || true
mkdir -p "$ANDROID_USER_HOME" "$GRADLE_USER_HOME" 2>/dev/null || true

# Gradle 参数：这里不设堆（堆由 app/android/gradle.properties 的 org.gradle.jvmargs 决定，
# 两处叠加会撑爆 4G 机器导致 daemon 被 OOM kill）
export GRADLE_OPTS="-Dorg.gradle.daemon=false -Dorg.gradle.parallel=false -Dorg.gradle.workers.max=1"

# JVM 全局参数：只修 user.home 与编码，绝不带 -Xmx（它会覆盖 gradle.properties 的堆设置）
export JAVA_TOOL_OPTIONS="-Duser.home=/data/dsh/home -Dfile.encoding=UTF-8"

# Flutter 国内镜像（官方不可达时取消注释）
# export PUB_HOSTED_URL=https://pub.flutter-io.cn
# export FLUTTER_STORAGE_BASE_URL=https://storage.flutter-io.cn

cocoa_doctor() {
  echo "LANG/LC_ALL      = $LANG / $LC_ALL"
  echo "JAVA_HOME        = $JAVA_HOME"
  "$JAVA_HOME/bin/java" -version 2>&1 | head -1
  echo "ANDROID_SDK_ROOT = $ANDROID_SDK_ROOT"
  echo "ANDROID_USER_HOME= $ANDROID_USER_HOME"
  ls "$ANDROID_SDK_ROOT/platforms" 2>/dev/null | tr '\n' ' '; echo
  echo "FLUTTER          = $("$COCOA_TOOLCHAIN/flutter/bin/flutter" --version 2>/dev/null | head -1)"
  echo "GRADLE_USER_HOME = $GRADLE_USER_HOME"
  echo "JAVA_TOOL_OPTIONS= $JAVA_TOOL_OPTIONS"
}
