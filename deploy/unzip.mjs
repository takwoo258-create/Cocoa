#!/usr/bin/env node
/**
 * 纯 Node 的 zip 解压器（服务器可能没有 unzip）
 * 用法：node deploy/unzip.mjs <zip 文件> <目标目录>
 *
 * 仅依赖 node:zlib，支持 store(0) 与 deflate(8)，带路径穿越防护。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const [, , zipPath, outDir] = process.argv;
if (!zipPath || !outDir) {
  console.error('用法: node deploy/unzip.mjs <zip> <目标目录>');
  process.exit(2);
}

const buf = fs.readFileSync(zipPath);

// 定位 EOCD
let eocd = -1;
for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) {
  console.error('[unzip] 不是有效的 zip（找不到 EOCD）');
  process.exit(1);
}
const total = buf.readUInt16LE(eocd + 10);
let cdOffset = buf.readUInt32LE(eocd + 16);

fs.mkdirSync(outDir, { recursive: true });
const rootResolved = path.resolve(outDir);
let written = 0;

for (let n = 0; n < total; n++) {
  if (buf.readUInt32LE(cdOffset) !== 0x02014b50) {
    console.error('[unzip] 中央目录损坏');
    process.exit(1);
  }
  const method = buf.readUInt16LE(cdOffset + 10);
  const crc = buf.readUInt32LE(cdOffset + 16);
  const csize = buf.readUInt32LE(cdOffset + 20);
  const usize = buf.readUInt32LE(cdOffset + 24);
  const nlen = buf.readUInt16LE(cdOffset + 28);
  const elen = buf.readUInt16LE(cdOffset + 30);
  const clen = buf.readUInt16LE(cdOffset + 32);
  const lho = buf.readUInt32LE(cdOffset + 42);
  const name = buf.subarray(cdOffset + 46, cdOffset + 46 + nlen).toString('utf8');
  cdOffset += 46 + nlen + elen + clen;

  // 目录条目
  if (name.endsWith('/')) {
    fs.mkdirSync(path.join(outDir, name), { recursive: true });
    continue;
  }
  // 路径穿越防护
  const target = path.resolve(rootResolved, name);
  if (!target.startsWith(rootResolved + path.sep) && target !== rootResolved) {
    console.error('[unzip] 拒绝越界路径:', name);
    process.exit(1);
  }

  // 本地头
  if (buf.readUInt32LE(lho) !== 0x04034b50) {
    console.error('[unzip] 本地文件头损坏:', name);
    process.exit(1);
  }
  const lnlen = buf.readUInt16LE(lho + 26);
  const lelen = buf.readUInt16LE(lho + 28);
  const dataStart = lho + 30 + lnlen + lelen;
  const raw = buf.subarray(dataStart, dataStart + csize);
  const data = method === 0 ? raw : zlib.inflateRawSync(raw);

  if (usize && data.length !== usize) {
    console.error(`[unzip] 尺寸不符 ${name}: ${data.length} != ${usize}`);
    process.exit(1);
  }
  // CRC32 校验
  const table = unzipCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = table[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  if ((c ^ 0xffffffff) >>> 0 !== crc) {
    console.error('[unzip] CRC 校验失败:', name);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
  written++;
}

function unzipCrcTable() {
  if (unzipCrcTable.cache) return unzipCrcTable.cache;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  unzipCrcTable.cache = t;
  return t;
}

console.log(`[unzip] ${written} 个文件 → ${outDir}`);
