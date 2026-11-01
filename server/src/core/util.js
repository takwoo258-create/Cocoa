import crypto from 'node:crypto';

export const nowIso = () => new Date().toISOString();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
export const uuid = () => crypto.randomUUID();
export const pick = (obj, keys) => {
  const out = {};
  for (const k of keys) if (obj?.[k] !== undefined) out[k] = obj[k];
  return out;
};
export const asInt = (v, def = 0) => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : def;
};
export const asFloat = (v, def = 0) => {
  const n = Number.parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : def;
};
export function parseJson(text, fallback = null) {
  if (text == null) return fallback;
  if (typeof text === 'object') return text;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}
export function json(res, data, status = 200) {
  res.status(status).json(data);
  return res;
}
// 只保留 a-z0-9_ 的短标识，用于日志与外部键
export const slug = (s, max = 64) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);

// 按 UTC+8 计算自然日 key: YYYY-MM-DD
export function dayKey(date = new Date(), offsetHours = 8) {
  const d = new Date(date.getTime() + offsetHours * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
export function dayRangeStart(dayStr) {
  // dayStr 为 UTC+8 的日期，转回 UTC 时间
  return new Date(`${dayStr}T00:00:00+08:00`);
}
export function truncate(s, n = 120) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n) + '…' : str;
}
export function uniq(arr) {
  return [...new Set(arr)];
}
export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
export function randomInt(min, max) {
  return crypto.randomInt(min, max + 1);
}
