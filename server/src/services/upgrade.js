// 后端升级：GitHub Releases 列表（10 分钟缓存）/ 触发部署脚本 / 读取升级状态 / 自动升级判定
// 安全约束：tag 严格校验后才作为「单个 argv 参数」传给 spawn（不使用 shell），脚本路径与状态文件路径可用 env 覆盖
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import env from '../env.js';
import logger from '../core/logger.js';
import { AppError, badRequest, conflict } from '../core/errors.js';
import { nowIso, uuid, parseJson, truncate } from '../core/util.js';
import { all, get, run, getMeta, setMeta } from '../db/index.js';
import { getAdminSetting, setAdminSetting } from './settings.js';

const REPO = process.env.COCOA_GITHUB_REPO || 'takwoo258-create/Cocoa';
const CACHE_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 12_000;
const LOG_TAIL_BYTES = 4000;
const TERMINAL = new Set(['success', 'failed', 'error', 'done', 'rolled_back', 'idle']);
const AUTO_COOLDOWN_MS = 6 * 3600_000;
const RECENT_RUNNING_MS = 30 * 60_000;
const TAG_RE = /^v\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.-]{1,32})?$/;

const HEADERS = {
  accept: 'application/vnd.github+json',
  'user-agent': 'cocoa-server/1.2.0',
  ...(process.env.COCOA_GITHUB_TOKEN ? { authorization: `Bearer ${process.env.COCOA_GITHUB_TOKEN}` } : {}),
};

// 版本列表：内存缓存 + meta 持久化兜底（服务重启后仍可回退）
let versionsCache = { at: 0, data: null };
let fetchImpl = null; // 测试注入
let autoState = { lastTag: null, lastAt: 0 };
let starting = false; // 进程内 spawn 锁：避免并发点击导致双重升级

/** 测试注入 fetch（无网络环境下模拟 GitHub / 假失败） */
export function setFetcher(fn) {
  fetchImpl = typeof fn === 'function' ? fn : null;
  versionsCache = { at: 0, data: null };
}

export function resetUpgradeCache() {
  versionsCache = { at: 0, data: null };
  autoState = { lastTag: null, lastAt: 0 };
}

const doFetch = (...args) => (fetchImpl ? fetchImpl(...args) : fetch(...args));

export function isValidTag(tag) {
  const value = String(tag || '').trim();
  if (!value || value.length > 40) return false;
  if (!TAG_RE.test(value)) return false;
  // 拒绝任何可能被解释为选项或路径的形态（双保险，spawn 本身已无 shell）
  return !value.includes('..') && !value.includes('/');
}

export function upgradeScriptPath() {
  return process.env.COCOA_UPGRADE_SCRIPT || '/opt/cocoa/deploy/upgrade.sh';
}

export function upgradeStatusPath() {
  return process.env.COCOA_UPGRADE_STATUS || path.join(env.dataDir, 'upgrade-status.json');
}

/** 当前后端版本（读 package.json，缓存 60s） */
let versionCache = { at: 0, value: null };
export function currentVersion() {
  if (versionCache.value && Date.now() - versionCache.at < 60_000) return versionCache.value;
  let value = process.env.COCOA_VERSION || '';
  if (!value) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(env.root, 'package.json'), 'utf8'));
      value = String(pkg.version || '');
    } catch {
      value = '';
    }
  }
  versionCache = { at: Date.now(), value: value || '0.0.0' };
  return versionCache.value;
}

function parseVersion(value) {
  const m = String(value || '')
    .replace(/^v/i, '')
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || '' };
}

/** 语义化版本比较：a>b 返回 1，a<b 返回 -1，相等 0（预发布低于同号正式版） */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x && !y) return 0;
  if (!x) return -1;
  if (!y) return 1;
  for (let i = 0; i < 3; i++) {
    const d = x.core[i] - y.core[i];
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}

function pickBackendAsset(assets) {
  const zips = (Array.isArray(assets) ? assets : []).filter((a) => /\.zip$/i.test(String(a?.name || '')));
  if (!zips.length) return null;
  const backend = zips.find((a) => /backend|server|source|cocoa/i.test(a.name)) || zips[0];
  return {
    name: backend.name,
    size: Number(backend.size || 0),
    url: backend.browser_download_url || '',
    directUrl: backend.browser_download_url || '',
    matched: /backend|server|source|cocoa/i.test(backend.name),
  };
}

function normalizeRelease(json) {
  const tag = String(json?.tag_name || '').trim();
  const version = tag.replace(/^v/i, '') || '0.0.0';
  const asset = pickBackendAsset(json?.assets);
  return {
    tag,
    version,
    name: json?.name || `Cocoa ${tag}`,
    notes: String(json?.body || '').slice(0, 8000),
    publishedAt: json?.published_at || json?.created_at || null,
    prerelease: Boolean(json?.prerelease),
    draft: Boolean(json?.draft),
    url: json?.html_url || `https://github.com/${REPO}/releases/tag/${tag}`,
    asset,
    hasBackend: Boolean(asset),
  };
}

function sortVersions(list) {
  return [...list].sort((a, b) => {
    if (a.prerelease !== b.prerelease) return a.prerelease ? 1 : -1;
    return compareVersions(b.version, a.version);
  });
}

async function fetchReleasesFromGithub() {
  const url = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
  const res = await doFetch(url, { headers: HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new AppError(502, 'github_unavailable', `GitHub Releases 获取失败：HTTP ${res.status} ${truncate(detail, 160)}`);
  }
  const json = await res.json();
  const list = (Array.isArray(json) ? json : []).filter((r) => r && r.tag_name && !r.draft).map(normalizeRelease);
  return sortVersions(list);
}

/**
 * 版本列表（10 分钟缓存）。失败时回退上一份成功缓存（内存 → meta 持久化 → 抛 502）。
 */
export async function fetchVersions({ force = false } = {}) {
  if (!force && versionsCache.data && Date.now() - versionsCache.at < CACHE_MS) {
    return versionsCache.data;
  }
  try {
    const list = await fetchReleasesFromGithub();
    versionsCache = { at: Date.now(), data: list };
    try {
      setMeta('upgrade_versions_cache', JSON.stringify({ at: Date.now(), items: list.slice(0, 20) }));
    } catch {
      /* 缓存落盘失败不影响返回 */
    }
    return list;
  } catch (err) {
    logger.warn('升级版本列表获取失败', err.message);
    if (versionsCache.data) return versionsCache.data;
    const persisted = parseJson(getMeta('upgrade_versions_cache', null), null);
    if (persisted?.items?.length) {
      versionsCache = { at: Date.now() - CACHE_MS, data: persisted.items };
      return persisted.items;
    }
    throw err instanceof AppError ? err : new AppError(502, 'github_unavailable', `GitHub Releases 获取失败：${truncate(err.message, 160)}`);
  }
}

export function versionsCacheInfo() {
  return { at: versionsCache.at ? new Date(versionsCache.at).toISOString() : null, count: versionsCache.data?.length || 0 };
}

function tailFile(file, bytes = LOG_TAIL_BYTES) {
  try {
    const st = fs.statSync(file);
    const size = Math.min(st.size, bytes);
    const buf = Buffer.alloc(size);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buf, 0, size, Math.max(0, st.size - size));
    } finally {
      fs.closeSync(fd);
    }
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

function shapeLog(row) {
  return {
    id: row.id,
    actorId: row.actor_id || null,
    fromVersion: row.from_version || null,
    toVersion: row.to_version || null,
    status: row.status,
    detail: parseJson(row.detail, null),
    createdAt: row.created_at,
  };
}

function syncLogFromStatus(latest, status) {
  if (!latest) return;
  if (['pending', 'running'].includes(latest.status) && (TERMINAL.has(status) || status === 'running')) {
    try {
      run('UPDATE upgrade_logs SET status = ? WHERE id = ?', status === 'idle' ? 'failed' : status, latest.id);
    } catch {
      /* 状态回写失败不影响读取 */
    }
  }
}

/** 升级状态：优先读脚本写的 status.json，缺省 idle；附带日志尾部与历史记录 */
export function upgradeStatus() {
  const statusPath = upgradeStatusPath();
  let file = null;
  try {
    const raw = fs.readFileSync(statusPath, 'utf8').slice(0, 64 * 1024);
    file = parseJson(raw, null);
  } catch {
    file = null;
  }

  const latest = get('SELECT * FROM upgrade_logs ORDER BY created_at DESC LIMIT 1');
  const history = all('SELECT * FROM upgrade_logs ORDER BY created_at DESC LIMIT 5').map(shapeLog);
  const current = currentVersion();

  let status = 'idle';
  let running = false;
  let inferred = false;

  // 状态文件可能来自上一次升级（tag 不匹配），此时以数据库里的最新任务为准，避免把新任务误判为已结束
  const fileTag = typeof file?.tag === 'string' && file.tag ? file.tag : null;
  const staleFile = Boolean(file && latest && fileTag && latest.to_version && fileTag !== latest.to_version);

  if (file && typeof file === 'object' && !staleFile) {
    status = String(file.status || (file.running ? 'running' : 'idle'));
    running = file.running !== undefined ? Boolean(file.running) : !TERMINAL.has(status);
  } else if (latest && ['pending', 'running'].includes(latest.status)) {
    const age = Date.now() - new Date(latest.created_at).getTime();
    if (age < RECENT_RUNNING_MS) {
      running = true;
      status = 'running';
      inferred = true;
    } else {
      status = 'unknown';
    }
  } else if (file && typeof file === 'object') {
    // 无进行中的任务：如实展示（历史）状态文件内容
    status = String(file.status || 'idle');
    running = false;
  }

  syncLogFromStatus(latest, status);

  const logPath = (typeof file?.log === 'string' && file.log) || (latest ? path.join(env.logDir, `upgrade-${latest.id}.log`) : null);
  return {
    running,
    status,
    inferred,
    tag: file?.tag || latest?.to_version || null,
    fromVersion: file?.fromVersion || latest?.from_version || current,
    toVersion: file?.toVersion || latest?.to_version || null,
    message: file?.message || '',
    progress: file?.progress ?? null,
    startedAt: file?.startedAt || null,
    finishedAt: file?.finishedAt || null,
    log: logPath ? tailFile(logPath) : '',
    logPath,
    statusPath,
    currentVersion: current,
    history,
    checkedAt: nowIso(),
  };
}

/**
 * 触发升级：校验 tag → 校验 GitHub 存在 → 写 upgrade_logs → detached spawn 脚本（不阻塞 HTTP）
 * 进程内串行化，避免两个管理员同时点击时双重 spawn；跨进程仍以 status.json 的 running 为准。
 */
export async function startUpgrade({ tag, actorId = null } = {}) {
  const cleanTag = String(tag || '').trim();
  if (!isValidTag(cleanTag)) throw badRequest('版本号格式不正确，需形如 v1.2.3', 'upgrade_tag_invalid');
  if (starting) throw conflict('已有升级任务正在启动，请稍候', 'upgrade_running');

  const state = upgradeStatus();
  if (state.running) throw conflict('已有升级任务正在进行，请等待完成', 'upgrade_running');

  starting = true;
  try {
    return await spawnUpgrade({ cleanTag, actorId });
  } finally {
    starting = false;
  }
}

async function spawnUpgrade({ cleanTag, actorId }) {
  const versions = await fetchVersions();
  const target = versions.find((v) => v.tag === cleanTag);
  if (!target) throw badRequest(`GitHub Releases 中不存在版本 ${cleanTag}`, 'upgrade_tag_not_found');

  const script = upgradeScriptPath();
  try {
    fs.accessSync(script, fs.constants.X_OK);
  } catch {
    throw new AppError(503, 'upgrade_script_missing', `升级脚本不可执行：${script}`);
  }

  const logId = `up_${uuid().replace(/-/g, '').slice(0, 16)}`;
  const logDir = env.logDir;
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `upgrade-${logId}.log`);
  const statusPath = upgradeStatusPath();
  const fromVersion = currentVersion();

  run(
    'INSERT INTO upgrade_logs(id, actor_id, from_version, to_version, status, detail, created_at) VALUES(?,?,?,?,?,?,?)',
    logId,
    actorId,
    fromVersion,
    cleanTag,
    'pending',
    JSON.stringify({ script, logPath, statusPath, name: target.name, notes: truncate(target.notes, 500) }),
    nowIso(),
  );

  let child;
  const fd = fs.openSync(logPath, 'a', 0o600);
  try {
    child = spawn(script, [cleanTag], {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: {
        ...process.env,
        COCOA_ROOT: env.root,
        COCOA_UPGRADE_TAG: cleanTag,
        COCOA_UPGRADE_LOG: logPath,
        COCOA_UPGRADE_STATUS: statusPath,
        COCOA_UPGRADE_LOG_ID: logId,
        COCOA_UPGRADE_FROM: fromVersion,
      },
    });
  } catch (err) {
    fs.closeSync(fd);
    run('UPDATE upgrade_logs SET status = ?, detail = ? WHERE id = ?', 'failed', JSON.stringify({ error: truncate(err.message, 300) }), logId);
    throw new AppError(502, 'upgrade_spawn_failed', `升级脚本启动失败：${truncate(err.message, 160)}`);
  }
  fs.closeSync(fd);

  child.on('error', (err) => {
    logger.error('升级脚本启动异常', err.message);
    try {
      run('UPDATE upgrade_logs SET status = ?, detail = ? WHERE id = ?', 'failed', JSON.stringify({ error: truncate(err.message, 300) }), logId);
    } catch {
      /* 忽略 */
    }
  });
  child.unref();

  run('UPDATE upgrade_logs SET status = ? WHERE id = ?', 'running', logId);
  logger.info('已触发后端升级', cleanTag, logId);
  return {
    accepted: true,
    logId,
    tag: cleanTag,
    fromVersion,
    toVersion: cleanTag,
    logPath,
    statusPath,
    script,
  };
}

/**
 * 自动升级判定（由调度器/启动流程调用）：
 * 仅当 update.autoUpgrade=true、无进行中的升级、存在更高正式版时触发；同 tag 6 小时内只触发一次。
 */
export async function maybeAutoUpgrade({ actorId = null } = {}) {
  const cfg = getAdminSetting('update', {}) || {};
  if (!cfg.autoUpgrade) return { triggered: false, reason: 'disabled' };

  const state = upgradeStatus();
  if (state.running) return { triggered: false, reason: 'running', tag: state.tag };

  let versions;
  try {
    versions = await fetchVersions();
  } catch (err) {
    return { triggered: false, reason: 'fetch_failed', error: truncate(err.message, 160) };
  }
  const latest = versions.find((v) => !v.prerelease && !v.draft) || null;
  const current = currentVersion();
  if (!latest || compareVersions(latest.version, current) <= 0) {
    return { triggered: false, reason: 'up_to_date', current, latest: latest?.version || null };
  }
  if (autoState.lastTag === latest.tag && Date.now() - autoState.lastAt < AUTO_COOLDOWN_MS) {
    return { triggered: false, reason: 'cooldown', tag: latest.tag };
  }

  try {
    const result = await startUpgrade({ tag: latest.tag, actorId });
    autoState = { lastTag: latest.tag, lastAt: Date.now() };
    setAdminSetting('update', { ...cfg, lastAutoUpgradeAt: nowIso(), lastAutoUpgradeTag: latest.tag });
    return { triggered: true, reason: 'new_version', current, latest: latest.version, ...result };
  } catch (err) {
    return { triggered: false, reason: err.code || 'start_failed', error: truncate(err.message, 160), tag: latest.tag };
  }
}

export default {
  fetchVersions,
  startUpgrade,
  upgradeStatus,
  maybeAutoUpgrade,
  isValidTag,
  currentVersion,
  compareVersions,
};
