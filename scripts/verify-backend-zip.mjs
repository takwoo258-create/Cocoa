#!/usr/bin/env node
/**
 * 校验后端发布包结构（不依赖 unzip）
 * 用法：node scripts/verify-backend-zip.mjs <zip 路径>
 * 退出码：0 通过；1 缺文件或包含不应发布的目录
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2];
if (!file) {
  console.error('用法: node scripts/verify-backend-zip.mjs <zip>');
  process.exit(2);
}
const buf = fs.readFileSync(file);

// 解析中央目录
const names = [];
for (let i = 0; i < buf.length - 46; i++) {
  if (buf.readUInt32LE(i) !== 0x02014b50) continue;
  const nlen = buf.readUInt16LE(i + 28);
  names.push(buf.subarray(i + 46, i + 46 + nlen).toString('utf8'));
  i += 45;
}
if (!names.length) {
  console.error('[verify] 未解析到任何条目，zip 可能损坏');
  process.exit(1);
}

const need = [
  'package.json',
  'package-lock.json',
  'server/src/index.js',
  'deploy/install.sh',
  'deploy/upgrade.sh',
  'deploy/cocoa.service',
  'docs/API.md',
  'README.md',
  'LICENSE',
];
const missing = need.filter((n) => !names.includes(n));
const bad = names.filter(
  (n) => n.startsWith('node_modules/') || n.startsWith('data/') || n === 'build.md' || /^changelog/.test(n) || n === '.env',
);

if (missing.length) {
  console.error('[verify] 缺少必需条目:', missing.join(', '));
  process.exit(1);
}
if (bad.length) {
  console.error('[verify] 包含不应发布的条目:', bad.slice(0, 8).join(', '));
  process.exit(1);
}

// 抽查一个条目能否解压（验证 deflate 数据有效）
const cdStart = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
const local = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
let ok = false;
for (let i = 0; i < buf.length - 30; i++) {
  if (buf.readUInt32LE(i) !== 0x04034b50) continue;
  const method = buf.readUInt16LE(i + 8);
  const csize = buf.readUInt32LE(i + 18);
  const nlen = buf.readUInt16LE(i + 26);
  const xlen = buf.readUInt16LE(i + 28);
  const start = i + 30 + nlen + xlen;
  const payload = buf.subarray(start, start + csize);
  try {
    method === 0 ? payload : zlib.inflateRawSync(payload);
    ok = true;
    break;
  } catch {
    /* 继续找下一个条目 */
  }
}
if (!ok) {
  console.error('[verify] 条目解压抽查失败（archive 可能损坏）');
  process.exit(1);
}

console.log(`[verify] 通过：${names.length} 个条目，中央目录与数据流均可解析`);
