// 版本检查：从 GitHub Release 读取版本/更新内容/APK，支持正式版与 Beta 快照片版
import { Router } from 'express';
import { getMeta, setMeta } from '../db/index.js';
import { getAdminSetting } from '../services/settings.js';
import logger from '../core/logger.js';
import env from '../env.js';

const REPO = process.env.COCOA_GITHUB_REPO || 'takwoo258-create/Cocoa';
const PROXY_PREFIX = (process.env.COCOA_GH_PROXY || 'https://gh-proxy.com/').replace(/\/*$/, '/');
const CACHE_MS = 10 * 60_000;
const BETA_RE = /^(\d+\.\d+\.\d+)(?:\s*\+{3}\s*Beta\s*(\d+)|[-_. ]?beta[-_. ]?(\d+))$/i;

// Release 说明中出现 [force] / [force-update] / <!-- cocoa:force --> 即视为需要更新到该版本
export function releaseForcesUpdate(notes = '') {
  // 先剔除 ``` 代码块与 `行内代码`，避免文档里「描述标记」被误判为更新要求
  const text = String(notes || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ');
  return /\[force(-update)?\]|<!--\s*cocoa:force\s*-->|\[版本更新要求\]/i.test(text);
}

/** 解析语义版本与 Beta：1.2.1 / 1.3.0+++Beta 1 / 1.3.0-beta.2 */
export function parseVersion(input = '') {
  const raw = String(input || '').trim().replace(/^v/i, '');
  const direct = raw.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (direct) {
    return {
      raw,
      version: raw,
      baseVersion: raw,
      parts: [Number(direct[1]), Number(direct[2]), Number(direct[3])],
      beta: false,
      betaNumber: 0,
      label: raw,
    };
  }
  const betaMatch = raw.match(BETA_RE);
  if (betaMatch) {
    const base = betaMatch[1];
    const n = Number(betaMatch[2] || betaMatch[3] || 1);
    return {
      raw,
      version: `${base}+++Beta ${n}`,
      baseVersion: base,
      parts: base.split('.').map((x) => Number(x) || 0),
      beta: true,
      betaNumber: n,
      label: `${base} Beta ${n}`,
    };
  }
  const parts = raw.split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  return { raw, version: raw, baseVersion: raw, parts, beta: false, betaNumber: 0, label: raw };
}

/** 版本比较：Beta 低于同 base 的正式版；更高 base 的 Beta 高于旧正式版 */
export function compareVersion(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.parts[i] || 0) - (y.parts[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  if (x.beta !== y.beta) return x.beta ? -1 : 1;
  if (x.beta && y.beta) {
    const d = x.betaNumber - y.betaNumber;
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

// 兼容旧测试/调用
export function semverParts(v) {
  return parseVersion(v).parts;
}

function proxyUrl(url) {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return PROXY_PREFIX + url;
  return url;
}

function pickApk(assets) {
  const apk = (assets || []).find((a) => /\.apk$/i.test(a?.name || '')) || null;
  if (!apk) return null;
  return {
    name: apk.name,
    size: Number(apk.size || 0),
    directUrl: apk.browser_download_url,
    url: proxyUrl(apk.browser_download_url),
  };
}

function normalizeRelease(json) {
  const tag = json?.tag_name || '';
  const fromTag = parseVersion(tag);
  const fromName = parseVersion(json?.name || '');
  const parsed = fromTag.version && /^\d+\.\d+\.\d+/.test(fromTag.raw)
    ? (fromTag.beta || !fromName.beta ? fromTag : fromName)
    : fromName;
  return {
    version: parsed.version,
    label: parsed.label,
    baseVersion: parsed.baseVersion,
    beta: parsed.beta,
    betaNumber: parsed.betaNumber,
    tag,
    name: json?.name || `Cocoa ${tag}`,
    notes: String(json?.body || '').slice(0, 20000),
    publishedAt: json?.published_at || null,
    prerelease: Boolean(json?.prerelease) || parsed.beta,
    url: json?.html_url || `https://github.com/${REPO}/releases/tag/${tag}`,
    apk: pickApk(json?.assets),
  };
}

let memoryCache = { at: 0, data: null };

async function fetchGithubReleases() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'cocoa-server/1.3.0',
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
  const list = await res.json();
  if (!Array.isArray(list)) throw new Error('GitHub releases 响应异常');
  return list
    .filter((r) => r && !r.draft)
    .map(normalizeRelease)
    .filter((r) => r.version && /^\d+\.\d+\.\d+/.test(r.baseVersion))
    .sort((a, b) => compareVersion(b.version, a.version));
}

/** 计算更新列表、最新版、强制起点 */
export function buildUpdateState(releases, current, updateCfg = {}) {
  const sorted = [...releases].sort((a, b) => compareVersion(b.version, a.version));
  const latest = sorted[0] || null;
  const available = sorted.filter((r) => compareVersion(r.version, current) > 0);
  const minVersion = String(updateCfg.minVersion || '').trim();
  const adminForce = Boolean(updateCfg.force);

  // 每个版本的更新要求：Release 显式标记 / 管理端最低版本（仅最低目标版本）/ 管理端整体要求（最新版）
  const forceMap = new Map();
  for (const r of sorted) {
    const marked = releaseForcesUpdate(r.notes);
    if (marked) forceMap.set(r.version, { force: true, reason: 'release' });
  }
  const minTarget = minVersion && compareVersion(current, minVersion) < 0
    ? available
        .filter((r) => compareVersion(r.version, minVersion) >= 0)
        .sort((a, b) => compareVersion(a.version, b.version))[0] || null
    : null;
  if (minTarget) {
    const item = forceMap.get(minTarget.version) || { force: false, reason: null };
    forceMap.set(minTarget.version, { force: true, reason: item.reason || 'min_version' });
  }
  if (adminForce && latest && compareVersion(latest.version, current) > 0) {
    forceMap.set(latest.version, { force: true, reason: 'admin' });
  }

  // 需要更新的起点：最低的、高于当前版本且被标记为必须安装的版本
  const forcedSorted = available
    .filter((r) => forceMap.get(r.version)?.force)
    .sort((a, b) => compareVersion(a.version, b.version));
  let required = forcedSorted[0] || null;
  if (minTarget) {
    // 低于 minVersion 的强制版本不成为起点；若没有更高的强制版本，则 minTarget 为起点
    const forcedAboveMin = forcedSorted.filter((r) => compareVersion(r.version, minTarget.version) >= 0);
    required = forcedAboveMin[0] || minTarget;
    forceMap.set(required.version, { force: true, reason: forceMap.get(required.version)?.reason || 'min_version' });
  }
  if (adminForce && latest && compareVersion(latest.version, current) > 0) required = latest;

  const forceUpdate = Boolean(required);
  const forceReason = required ? forceMap.get(required.version)?.reason || null : null;

  return {
    current,
    latest,
    releases: available.map((r) => ({
      ...r,
      force: Boolean(forceMap.get(r.version)?.force),
      forceReason: forceMap.get(r.version)?.reason || null,
    })),
    required,
    forceUpdate,
    forceReason,
    minVersion: minVersion || null,
  };
}

async function getReleases({ refresh = false } = {}) {
  if (!refresh && memoryCache.data && Date.now() - memoryCache.at < CACHE_MS) {
    return { data: memoryCache.data, source: 'cache', warning: null };
  }
  try {
    const releases = await fetchGithubReleases();
    const data = { releases, fetchedAt: new Date().toISOString() };
    memoryCache = { at: Date.now(), data };
    setMeta('release_list_cache', JSON.stringify(data));
    return { data, source: 'github', warning: null };
  } catch (err) {
    logger.warn('版本列表获取失败，尝试本地缓存', err.message);
    const row = getMeta('release_list_cache', null);
    if (row) {
      try {
        return { data: JSON.parse(row), source: 'cache', warning: err.message };
      } catch { /* ignore */ }
    }
    return { data: null, source: 'unavailable', warning: err.message };
  }
}

function legacyPayload(state, extra = {}) {
  return {
    ok: Boolean(state.latest),
    current: state.current,
    latest: state.latest,
    updateAvailable: Boolean(state.releases.length),
    forceUpdate: state.forceUpdate,
    forceReason: state.forceReason,
    minVersion: state.minVersion,
    requiredVersion: state.required?.version || null,
    releases: state.releases,
    ...extra,
  };
}

export default function register() {
  const r = Router();

  // 新接口：完整更新列表（含 Beta、逐版本更新要求、强制起点）
  r.get('/updates', async (req, res) => {
    const current = String(req.query.current || '').trim() || '0.0.0';
    const { data, source, warning } = await getReleases({ refresh: req.query.refresh === '1' });
    if (!data?.releases) {
      return res.json({
        ok: false, current, latest: null, releases: [], updateAvailable: false,
        forceUpdate: false, source: 'unavailable', warning: warning || '无法获取版本信息', proxy: PROXY_PREFIX,
      });
    }
    const updateCfg = getAdminSetting('update', {}) || {};
    const state = buildUpdateState(data.releases, current, updateCfg);
    res.json({
      ...legacyPayload(state),
      source,
      checkedAt: new Date().toISOString(),
      proxy: PROXY_PREFIX,
      ...(warning ? { warning } : {}),
    });
  });

  // 兼容旧接口
  r.get('/latest', async (req, res) => {
    const current = String(req.query.current || '').trim() || '0.0.0';
    const { data, source, warning } = await getReleases({ refresh: req.query.refresh === '1' });
    if (!data?.releases) {
      return res.json({
        ok: false, current, latest: null, updateAvailable: false,
        source: 'unavailable', warning: warning || '无法获取版本信息', proxy: PROXY_PREFIX,
      });
    }
    const updateCfg = getAdminSetting('update', {}) || {};
    const state = buildUpdateState(data.releases, current, updateCfg);
    const payload = legacyPayload(state, {
      source,
      checkedAt: new Date().toISOString(),
      proxy: PROXY_PREFIX,
      ...(warning ? { warning } : {}),
    });
    if (!payload.latest) payload.ok = false;
    res.json(payload);
  });

  return r;
}
