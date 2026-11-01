#!/usr/bin/env node
/**
 * 替换 GitHub Release 的单个资产（先删同名旧资产再上传）
 * 用法：node scripts/replace-asset.mjs --tag v1.2.0 --file /path/Cocoa-backend-v1.2.0.zip
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const argOf = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const REPO = process.env.GITHUB_REPO || 'takwoo258-create/Cocoa';
const TAG = argOf('--tag', 'v1.2.0');
const FILE = argOf('--file', '');
if (!FILE || !fs.existsSync(FILE)) {
  console.error('[replace] 缺少 --file 或文件不存在');
  process.exit(2);
}
const token = (process.env.GITHUB_TOKEN || fs.readFileSync(process.env.GH_TOKEN_FILE || '/tmp/gh_token', 'utf8')).trim();

async function api(method, url, body, contentType) {
  const res = await fetch(url.startsWith('http') ? url : `https://api.github.com${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'cocoa-replace-asset',
      ...(body ? { 'Content-Type': Buffer.isBuffer(body) ? contentType || 'application/octet-stream' : 'application/json' } : {}),
    },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

const name = path.basename(FILE);
const rel = await api('GET', `/repos/${REPO}/releases/tags/${TAG}`);
if (rel.status !== 200) {
  console.error('[replace] 找不到 Release:', rel.status);
  process.exit(1);
}
const assets = await api('GET', `/repos/${REPO}/releases/${rel.data.id}/assets`);
for (const a of assets.data || []) {
  if (a.name === name) {
    console.log('[replace] 删除旧资产', a.name, a.id);
    await api('DELETE', `/repos/${REPO}/releases/assets/${a.id}`);
  }
}
const buf = fs.readFileSync(FILE);
const type = /\.apk$/i.test(name) ? 'application/vnd.android.package-archive' : 'application/zip';
const up = await api('POST', `https://uploads.github.com/repos/${REPO}/releases/${rel.data.id}/assets?name=${encodeURIComponent(name)}`, buf, type);
if (up.status !== 201) {
  console.error('[replace] 上传失败', up.status, JSON.stringify(up.data).slice(0, 300));
  process.exit(1);
}
const sha = (await import('node:crypto')).createHash('sha256').update(buf).digest('hex');
console.log(JSON.stringify({ ok: true, name, size: up.data.size, url: up.data.browser_download_url, sha256: sha }, null, 2));
