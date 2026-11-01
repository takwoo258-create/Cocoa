// 轻量内存限流（单进程足够；多进程部署请换 Redis）
const buckets = new Map();

export function rateLimit({ key, limit = 10, windowMs = 60_000 }) {
  const now = Date.now();
  const item = buckets.get(key);
  if (!item || now > item.reset) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return { ok: true, remaining: limit - 1, resetAt: now + windowMs };
  }
  if (item.count >= limit) return { ok: false, remaining: 0, resetAt: item.reset };
  item.count++;
  return { ok: true, remaining: limit - item.count, resetAt: item.reset };
}

export function clientKey(req, suffix = '') {
  const ip = req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() || req.ip || 'unknown';
  return `${ip}:${suffix}`;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k);
}, 120_000).unref?.();
