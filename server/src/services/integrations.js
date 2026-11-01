// 集成 API：UAPI 天气 / 热榜（内存缓存 + 可注入 fetch，测试不联网）
// key 来源：env UAPI_KEY → admin_settings integrations.uapiKey → COCOA_UAPI_ENV 指向的 env 文件（仅本地调试）
// 约定：上游失败一律抛 502 且**不清空**已有缓存；cached 数据在 TTL 内直接命中
import fs from 'node:fs';
import { AppError, badRequest } from '../core/errors.js';
import { nowIso, truncate } from '../core/util.js';
import logger from '../core/logger.js';
import { getAdminSetting } from './settings.js';

const DEFAULT_BASE = process.env.COCOA_UAPI_BASE || 'https://uapis.cn';
const WEATHER_TTL_MS = 10 * 60_000;
const HOTBOARD_TTL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
export const DEFAULT_CITY = '宣城';
export const HOTBOARD_TYPES = ['weibo', 'zhihu', 'douyin', 'bilibili', 'toutiao', 'baidu'];

const cache = new Map(); // key -> { at, data, ttl }
let fetchImpl = null;
let envKeyCache = { at: 0, value: '' };

/** 测试注入 fetch（本地 http server 或直接返回假响应） */
export function setFetcher(fn) {
  fetchImpl = typeof fn === 'function' ? fn : null;
}

export function clearCache() {
  cache.clear();
}

const doFetch = (...args) => (fetchImpl ? fetchImpl(...args) : fetch(...args));

function readKeyFromEnvFile(file) {
  if (Date.now() - envKeyCache.at < 60_000) return envKeyCache.value;
  let value = '';
  try {
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const idx = line.indexOf('=');
      if (idx < 0) continue;
      const key = line.slice(0, idx).trim();
      if (key === 'UAPI_KEY' || key === 'COCOA_UAPI_KEY') {
        value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
        break;
      }
    }
  } catch {
    value = '';
  }
  envKeyCache = { at: Date.now(), value };
  return value;
}

/** UAPI key（只用于请求头，不写日志、不回显） */
export function uapiKey() {
  const fromEnv = String(process.env.UAPI_KEY || process.env.COCOA_UAPI_KEY || '').trim();
  if (fromEnv) return fromEnv;
  const cfg = getAdminSetting('integrations', {}) || {};
  if (cfg.uapiKey) return String(cfg.uapiKey).trim();
  const file = process.env.COCOA_UAPI_ENV;
  if (file) return readKeyFromEnvFile(file);
  return '';
}

export function integrationStatus() {
  return { uapiKeySet: Boolean(uapiKey()), base: DEFAULT_BASE, defaultCity: DEFAULT_CITY, hotboardTypes: [...HOTBOARD_TYPES] };
}

function buildUrl(pathname, params) {
  const base = String(DEFAULT_BASE).replace(/\/+$/, '');
  const url = new URL(base + pathname);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  return url.toString();
}

async function callUapi(pathname, params) {
  const url = buildUrl(pathname, params);
  const key = uapiKey();
  const headers = { accept: 'application/json' };
  if (key) {
    headers.authorization = `Bearer ${key}`;
    headers['x-api-key'] = key;
  }
  let res;
  try {
    res = await doFetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw new AppError(502, 'uapi_unavailable', `上游接口不可达：${truncate(err.message, 160)}`);
  }
  const text = await res.text().catch(() => '');
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!res.ok) {
    const msg = json?.message || json?.code || truncate(text, 160) || `HTTP ${res.status}`;
    throw new AppError(502, 'uapi_error', `上游接口异常：${msg}`, { status: res.status, path: pathname });
  }
  if (!json || typeof json !== 'object') {
    throw new AppError(502, 'uapi_invalid_response', '上游接口返回非 JSON 数据');
  }
  return json;
}

function cached(key, ttl, refresh) {
  const hit = cache.get(key);
  if (!refresh && hit && Date.now() - hit.at < ttl) return hit.data;
  return null;
}

function store(key, data, ttl) {
  cache.set(key, { at: Date.now(), data, ttl });
  if (cache.size > 64) {
    // 简单容量保护：删掉最旧的一条
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  return data;
}

function shapeWeather(raw, city) {
  const alerts = Array.isArray(raw.alerts)
    ? raw.alerts.slice(0, 3).map((a) => ({
        title: String(a?.title || ''),
        type: String(a?.type || ''),
        level: String(a?.level || ''),
        text: truncate(a?.text || '', 240),
        publishTime: a?.publish_time || null,
        publisher: a?.publisher || '',
      }))
    : [];
  return {
    city: String(raw.city || city),
    province: String(raw.province || ''),
    district: String(raw.district || ''),
    adcode: raw.adcode ? String(raw.adcode) : null,
    weather: String(raw.weather || ''),
    icon: raw.weather_icon ? String(raw.weather_icon) : '',
    temperature: Number.isFinite(Number(raw.temperature)) ? Number(raw.temperature) : null,
    windDirection: String(raw.wind_direction || ''),
    windPower: String(raw.wind_power || ''),
    humidity: Number.isFinite(Number(raw.humidity)) ? Number(raw.humidity) : null,
    reportTime: String(raw.report_time || ''),
    alerts,
    fetchedAt: nowIso(),
  };
}

function shapeHotboard(raw, type) {
  const list = Array.isArray(raw.list) ? raw.list : Array.isArray(raw.data?.list) ? raw.data.list : Array.isArray(raw.items) ? raw.items : [];
  const items = list.slice(0, 50).map((item, idx) => ({
    rank: Number(item?.index ?? item?.rank ?? idx + 1) || idx + 1,
    title: String(item?.title || item?.name || '').trim(),
    hot: Number(item?.hot_value ?? item?.hot ?? item?.heat ?? 0) || 0,
    url: String(item?.url || item?.link || ''),
    desc: truncate(item?.extra?.desc || item?.desc || '', 160),
  })).filter((i) => i.title);
  return {
    type: String(raw.type || type),
    title: String(raw.title || `${type} 热榜`),
    updateTime: raw.update_time || raw.updateTime || null,
    items,
    fetchedAt: nowIso(),
  };
}

/** 天气（10 分钟缓存）；失败抛 502，旧缓存保留 */
export async function getWeather(city = DEFAULT_CITY, { force = false } = {}) {
  const name = String(city || DEFAULT_CITY).trim().slice(0, 32) || DEFAULT_CITY;
  if (!name) throw badRequest('城市不能为空', 'city_required');
  const key = `weather:${name}`;
  const hit = cached(key, WEATHER_TTL_MS, force);
  if (hit) return hit;
  try {
    const raw = await callUapi('/api/v1/misc/weather', { city: name });
    return store(key, shapeWeather(raw, name), WEATHER_TTL_MS);
  } catch (err) {
    logger.warn('天气接口失败', name, err.message);
    throw err;
  }
}

/** 热榜（5 分钟缓存）；失败抛 502，旧缓存保留 */
export async function getHotboard(type = 'weibo', { force = false } = {}) {
  const source = String(type || 'weibo').trim().toLowerCase();
  if (!HOTBOARD_TYPES.includes(source)) {
    throw badRequest(`热榜类型仅支持 ${HOTBOARD_TYPES.join('/')}`, 'hotboard_type_invalid');
  }
  const key = `hot:${source}`;
  const hit = cached(key, HOTBOARD_TTL_MS, force);
  if (hit) return hit;
  try {
    const raw = await callUapi('/api/v1/misc/hotboard', { type: source });
    return store(key, shapeHotboard(raw, source), HOTBOARD_TTL_MS);
  } catch (err) {
    logger.warn('热榜接口失败', source, err.message);
    throw err;
  }
}

/** 供 AI 线注入 prompt：失败返回 null，不抛错 */
export async function getWeatherSafe(city = DEFAULT_CITY) {
  try {
    return await getWeather(city);
  } catch {
    return null;
  }
}

export async function getHotboardSafe(type = 'weibo') {
  try {
    return await getHotboard(type);
  } catch {
    return null;
  }
}

/** 一句话天气摘要（角色聊天/状态刷新可直接拼进 prompt） */
export async function weatherPrompt(city = DEFAULT_CITY) {
  const w = await getWeatherSafe(city);
  if (!w) return '';
  const alert = w.alerts[0]?.title ? `，${w.alerts[0].title}` : '';
  return `${w.city}${w.weather}，${w.temperature}°C，${w.windDirection}${w.windPower}，湿度 ${w.humidity}%${alert}（${w.reportTime}）`;
}

/** 热榜摘要行（默认取前 5 条标题） */
export async function hotboardPrompt(type = 'weibo', limit = 5) {
  const hot = await getHotboardSafe(type);
  if (!hot?.items?.length) return '';
  return hot.items.slice(0, Math.max(1, Math.min(20, limit))).map((i) => `${i.rank}. ${i.title}`).join('\n');
}

export default { getWeather, getHotboard, getWeatherSafe, getHotboardSafe, weatherPrompt, hotboardPrompt };
