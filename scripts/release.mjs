#!/usr/bin/env node
/**
 * Cocoa GitHub Release 投递（创建 tag + Release + 上传 APK）
 *
 * 令牌：/tmp/gh_token（0600）或环境变量 GITHUB_TOKEN；本脚本不打印令牌。
 * 用法：
 *   node scripts/release.mjs                         # 默认 v1.2.1 + /data/dsh/home/Cocoa-v1.2.1.apk
 *   node scripts/release.mjs --tag v1.2.1 --apk /path/x.apk --notes update1.2.1.md \
 *     --extra /data/dsh/home/Cocoa-backend-v1.2.1.zip    # 额外资产可重复多次
 *   node scripts/release.mjs --dry                   # 只打印将要执行的动作
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const argOf = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const REPO = process.env.GITHUB_REPO || 'takwoo258-create/Cocoa';
const TAG = argOf('--tag', 'v1.2.1');
const APK = argOf('--apk', '/data/dsh/home/Cocoa-v1.2.1.apk');
const NOTES = argOf('--notes', '');
const BRANCH = argOf('--target', 'main');
const DRY = args.includes('--dry');
// --extra 可重复：额外的发布资产（后端源码 zip 等）
const assets = [];
for (let i = 0; i < args.length; i++) if (args[i] === '--extra' && args[i + 1]) assets.push(args[i + 1]);

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  const p = process.env.GH_TOKEN_FILE || '/tmp/gh_token';
  if (!fs.existsSync(p)) throw new Error(`找不到令牌文件 ${p}，也未设置 GITHUB_TOKEN`);
  const t = fs.readFileSync(p, 'utf8').trim();
  if (!t) throw new Error('令牌文件为空');
  return t;
}

const log = (...a) => console.log('[release]', ...a);
const die = (m) => { console.error('[release][error]', m); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(tk, method, url, body, contentType) {
  const res = await fetch(url.startsWith('http') ? url : `https://api.github.com${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${tk}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'cocoa-release-script',
      ...(body ? { 'Content-Type': Buffer.isBuffer(body) ? (contentType || 'application/vnd.android.package-archive') : 'application/json' } : {}),
    },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

async function main() {
  const tk = token();
  if (!fs.existsSync(APK)) die(`APK 不存在：${APK}（先跑 scripts/build-apk.sh）`);
  const apkName = path.basename(APK);
  const size = fs.statSync(APK).size;
  // --extra 可重复：额外的发布资产（如后端源码 zip）
  const EXTRAS = assets.filter(Boolean);
  const ALL = [APK, ...EXTRAS];
  for (const f of ALL) if (!fs.existsSync(f)) die(`待上传资产不存在：${f}`);
  const body = NOTES && fs.existsSync(NOTES) ? fs.readFileSync(NOTES, 'utf8') : `Cocoa ${TAG}\n\nAndroid 客户端安装包。`;
  log(`仓库 ${REPO} / tag ${TAG} / 资产 ${ALL.map((f) => path.basename(f)).join(', ')}`);
  log(`APK ${apkName} (${(size / 1024 / 1024).toFixed(2)} MB)`);
  if (DRY) { log('--dry 模式，不发起任何请求'); return; }

  // 1) 仓库连通性
  const repo = await api(tk, 'GET', `/repos/${REPO}`);
  if (repo.status !== 200) die(`无法访问仓库（${repo.status}）：${JSON.stringify(repo.data).slice(0, 200)}`);
  log(`仓库可访问：${repo.data.full_name}（默认分支 ${repo.data.default_branch}）`);

  // 2) 已存在则复用
  let rel = await api(tk, 'GET', `/repos/${REPO}/releases/tags/${TAG}`);
  if (rel.status === 200) {
    log(`Release ${TAG} 已存在（id=${rel.data.id}），复用`);
  } else {
    const created = await api(tk, 'POST', `/repos/${REPO}/releases`, {
      tag_name: TAG,
      target_commitish: BRANCH,
      name: `Cocoa ${TAG}`,
      body,
      draft: false,
      prerelease: false,
    });
    if (created.status !== 201) die(`创建 Release 失败（${created.status}）：${JSON.stringify(created.data).slice(0, 300)}`);
    rel = created;
    log(`Release 已创建：${created.data.html_url}`);
  }
  const release = rel.data;

  // 3) 同名资产先删后传（幂等重跑）
  const oldAssets = await api(tk, 'GET', `/repos/${REPO}/releases/${release.id}/assets`);
  if (oldAssets.status === 200) {
    for (const a of oldAssets.data || []) {
      if (ALL.some((f) => path.basename(f) === a.name)) {
        log(`删除旧资产 ${a.name}（id=${a.id}）`);
        await api(tk, 'DELETE', `/repos/${REPO}/releases/assets/${a.id}`);
      }
    }
  }

  // 4) 上传（APK + 额外资产）
  const uploaded = [];
  for (const file of ALL) {
    const name = path.basename(file);
    const buf = fs.readFileSync(file);
    const type = /\.apk$/i.test(name) ? 'application/vnd.android.package-archive' : 'application/zip';
    log(`上传 ${name} …`);
    const up = await api(tk, 'POST',
      `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
      buf,
      type);
    if (up.status !== 201) die(`上传失败（${up.status}）：${JSON.stringify(up.data).slice(0, 300)}`);
    uploaded.push(up.data);
    log(`上传完成：${up.data.browser_download_url}（${(up.data.size / 1024 / 1024).toFixed(2)} MB）`);
  }

  // 5) 校验 tag 指向
  await sleep(800);
  const ref = await api(tk, 'GET', `/repos/${REPO}/git/ref/tags/${TAG}`);
  if (ref.status === 200) log(`tag ${TAG} → ${ref.data.object?.sha || '(release tag)'}`);

  console.log('\n──────── Release 结果 ────────');
  console.log(`Release : ${release.html_url}`);
  for (const u of uploaded) console.log(`资产    : ${u.browser_download_url}（${(u.size / 1024 / 1024).toFixed(2)} MB）`);
  console.log('──────────────────────────────');
}

main().catch((e) => die(e.message));
