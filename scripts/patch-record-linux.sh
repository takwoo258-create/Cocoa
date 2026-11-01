#!/usr/bin/env bash
# 构建环境补丁：修复 record_linux 0.7.2 与 record_platform_interface 1.6.0 的 API 不匹配
#
# 背景：app 依赖 record ^5.1.2 → 解析到 record 5.2.1，它锁定 record_linux >=0.5.0 <1.0.0
# （0.7.2 是最后一版）。而 record_platform_interface 已升到 1.6.0，新增了
#   Future<Stream<Uint8List>> startStream(String, RecordConfig)
# 并把 hasPermission 改成带 {bool request = true} 的签名。
# Android 构建同样会把 record_linux 的 Dart 代码编进 kernel，于是报：
#   Target kernel_snapshot_program failed: RecordLinux is missing implementations for ...
#
# 该 Linux 实现只在 Linux 桌面运行，Android 永远不会调用，因此这里做最小签名对齐即可。
# 幂等：重复执行不会重复插入。pub get 重新解包后可再跑一次。
#
# 用法：bash scripts/patch-record-linux.sh
set -Eeuo pipefail

PUB_CACHE="${PUB_CACHE:-/data/dsh/home/.pub-cache}"
TARGET="$PUB_CACHE/hosted/pub.dev/record_linux-0.7.2/lib/record_linux.dart"

log() { printf '\033[1;32m[patch]\033[0m %s\n' "$*"; }

if [ ! -f "$TARGET" ]; then
  log "未找到 $TARGET（未解析 record_linux 或版本变化），跳过"
  exit 0
fi

if grep -q "request = true" "$TARGET"; then
  log "已补丁，跳过"
  exit 0
fi

node -e '
const fs=require("fs");
const p=process.argv[1];
let s=fs.readFileSync(p,"utf8");

// 1) hasPermission 增加可选参数以匹配 1.6.0 的签名
s=s.replace(
  "Future<bool> hasPermission(String recorderId) {",
  "Future<bool> hasPermission(String recorderId, {bool request = true}) {"
);

// 2) 补 startStream 实现（Linux 不支持流式，抛 Unimplemented 即可，Android 不走这里）
if(!s.includes("startStream")){
  s=s.replace(
    "  @override\n  Future<bool> isEncoderSupported(",
    "  @override\n  Future<Stream<Uint8List>> startStream(\n      String recorderId, RecordConfig config) async {\n    throw UnimplementedError(\x27record_linux: startStream not supported\x27);\n  }\n\n  @override\n  Future<bool> isEncoderSupported("
  );
}
fs.writeFileSync(p,s);
' "$TARGET"

# 需要 dart:typed_data 的 Uint8List —— 该文件已 import dart:convert（间接不保证），显式补
grep -q "import 'dart:typed_data';" "$TARGET" || \
  sed -i "0,/^import 'dart:io';/s//import 'dart:io';\nimport 'dart:typed_data';/" "$TARGET"

log "已补丁 $TARGET"
grep -n "startStream\|hasPermission(String recorderId" "$TARGET" | head -4
