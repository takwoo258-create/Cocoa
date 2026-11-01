// 版本检查：从 GitHub Release 读取最新 APK，并提供 gh-proxy.com 加速下载地址
import { Router } from 'express';
import { getMeta, setMeta } from '../db/index.js';
import { getAdminSetting } from '../services/settings.js';
import logger from '../core/logger.js';
import env from '../env.js';

const REPO = process.env.COCOA_GITHUB_REPO || 'takwoo258-create/Cocoa';
const PROXY_PREFIX = (process.env.COCOA_GH_PROXY || 'https://gh-proxy.com/').replace(/\/*$/, '/');
const CACHE_MS = 10 * 60_000;

// Release 说明中出现 [force] / [force-update] / <!-- cocoa:force --> 即视为强制更新
export function releaseForcesUpdate(notes = '') {
  return /\[force(-update)?\]|<!--\s*cocoa:force\s*-->|强制更新/i.test(String(notes || ''));
}
let memoryCache = { at: 0, data: null };

export function semverParts(v) {
  return String(v || '')
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .map((x) => Number.parseInt(x, 10) || 0);
}

export function compareVersion(a, b) {
  const x = semverParts(a);
  const y = semverParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

function proxyUrl(url) {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return PROXY_PREFIX + url;
  return url;
}

function normalizeRelease(json) {
  const tag = json?.tag_name || '';
  const version = tag.replace(/^v/i, '') || '0.0.0';
  const assets = Array.isArray(json?.assets) ? json.assets : [];
  const apk = assets.find((a) => /\.apk$/i.test(a?.name || '')) || null;
  return {
    version,
    tag,
    name: json?.name || `Cocoa ${tag}`,
    notes: String(json?.body || '').slice(0, 8000),
    publishedAt: json?.published_at || null,
    prerelease: Boolean(json?.prerelease),
    url: json?.html_url || `https://github.com/${REPO}/releases/tag/${tag}`,
    apk: apk
      ? {
          name: apk.name,
          size: Number(apk.size || 0),
          directUrl: apk.browser_download_url,
          url: proxyUrl(apk.browser_download_url),
        }
      : null,
  };
}

async function fetchGithubRelease() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'cocoa-server/1.0.1',
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
  return normalizeRelease(await res.json());
}

export default function register() {
  const r = Router();

  r.get('/latest', async (req, res) => {
    const current = String(req.query.current || '').trim() || '0.0.0';
    let latest = null;
    let source = 'cache';
    let warning = null;

    if (memoryCache.data && Date.now() - memoryCache.at < CACHE_MS) {
      latest = memoryCache.data;
    } else {
      try {
        latest = await fetchGithubRelease();
        memoryCache = { at: Date.now(), data: latest };
        setMeta('release_cache', JSON.stringify(latest));
        source = 'github';
      } catch (err) {
        logger.warn('版本检查失败，尝试本地缓存', err.message);
        warning = err.message;
        const row = getMeta('release_cache', null);
        if (row) {
          try {
            latest = JSON.parse(row);
            source = 'cache';
          } catch { /* ignore */ }
        }
      }
    }

    if (!latest) {
      return res.json({
        ok: false,
        current,
        latest: null,
        updateAvailable: false,
        source: 'unavailable',
        warning: warning || '无法获取版本信息',
        proxy: PROXY_PREFIX,
      });
    }

    const updateAvailable = compareVersion(latest.version, current) > 0;
    const updateCfg = getAdminSetting('update', {}) || {};
    const minVersion = String(updateCfg.minVersion || '').trim();
    const minVersionHit = Boolean(minVersion) && compareVersion(current, minVersion) < 0;
    const forceUpdate = updateAvailable && (
      Boolean(updateCfg.force) || releaseForcesUpdate(latest.notes) || minVersionHit
    );
    const forceReason = !forceUpdate
      ? null
      : updateCfg.force
        ? 'admin'
        : minVersionHit
          ? 'min_version'
          : 'release';
    res.json({
      ok: true,
      current,
      latest,
      updateAvailable,
      forceUpdate,
      forceReason,
      minVersion: minVersion || null,
      source,
      proxy: PROXY_PREFIX,
      checkedAt: new Date().toISOString(),
      ...(warning ? { warning } : {}),
    });
  });

  return r;
}
