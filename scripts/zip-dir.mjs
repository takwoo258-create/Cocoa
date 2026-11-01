#!/usr/bin/env node
/**
 * 纯 Node 的 zip 打包器（不依赖系统 zip）
 * 用法：node scripts/zip-dir.mjs <源目录> <输出 zip> [--prefix 前缀/]
 *
 * 说明：构建机无 zip 二进制，用 zlib.deflateRaw 手写 ZIP（store/deflate 两种方法），
 * 产物可被 unzip / Python zipfile / Windows 资源管理器正常读取。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const [, , srcDir, outFile, ...rest] = process.argv;
if (!srcDir || !outFile) {
  console.error('用法: node scripts/zip-dir.mjs <源目录> <输出 zip> [--prefix 前缀/]');
  process.exit(2);
}
const prefixIdx = rest.indexOf('--prefix');
const prefix = prefixIdx >= 0 ? rest[prefixIdx + 1] || '' : '';

// ── CRC32 ──────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

function walk(dir, base = dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, acc);
    else if (entry.isFile()) acc.push(full);
  }
  return acc;
}

const files = walk(srcDir).sort();
const out = [];
const central = [];
let offset = 0;

for (const file of files) {
  const rel = path.posix.join(prefix, path.relative(srcDir, file).split(path.sep).join('/'));
  const data = fs.readFileSync(file);
  const deflated = zlib.deflateRawSync(data, { level: 9 });
  const useDeflate = deflated.length < data.length;
  const payload = useDeflate ? deflated : data;
  const method = useDeflate ? 8 : 0;
  const nameBuf = Buffer.from(rel, 'utf8');
  const crc = crc32(data);
  const { time, date } = dosDateTime(fs.statSync(file).mtime);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);          // version needed
  local.writeUInt16LE(0x0800, 6);      // UTF-8 flag
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);

  out.push(local, nameBuf, payload);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);             // version made by
  cd.writeUInt16LE(20, 6);             // version needed
  cd.writeUInt16LE(0x0800, 8);         // UTF-8 flag
  cd.writeUInt16LE(method, 10);
  cd.writeUInt16LE(time, 12);
  cd.writeUInt16LE(date, 14);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(payload.length, 20);
  cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt16LE(0, 30);             // extra len
  cd.writeUInt16LE(0, 32);             // comment len
  cd.writeUInt16LE(0, 34);             // disk
  cd.writeUInt16LE(0, 36);             // internal attrs
  cd.writeUInt32LE(0, 38);             // external attrs
  cd.writeUInt32LE(offset, 42);        // local header offset
  central.push(cd, nameBuf);

  offset += local.length + nameBuf.length + payload.length;
}

const cdBuf = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(cdBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, Buffer.concat([...out, cdBuf, eocd]));
console.log(`[zip] ${files.length} 个文件 → ${outFile} (${(fs.statSync(outFile).size / 1024).toFixed(1)} KB)`);
