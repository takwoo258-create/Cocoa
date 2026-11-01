// Token 用量与消费计量（普通用户/管理员统计的数据源）
import { all, get, run } from '../db/index.js';
import { nowIso, uuid } from '../core/util.js';
import { estimateCost } from './models.js';

export function recordUsage({ userId, characterId = null, kind = 'main', model, usage = {}, cost = null }) {
  const input = Number(usage.input || usage.prompt_tokens || 0);
  const output = Number(usage.output || usage.completion_tokens || 0);
  const cached = Number(usage.cached || 0);
  const amount = cost == null ? estimateCost(model, input, cached, output) : cost;
  run(
    'INSERT INTO usage_records(id, user_id, character_id, kind, model, input_tokens, cached_tokens, output_tokens, cost, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    uuid(),
    userId,
    characterId,
    kind,
    model || 'unknown',
    input,
    cached,
    output,
    amount,
    nowIso(),
  );
  return { input, output, cached, cost: amount };
}

export function windowStart(range, from = null, to = null) {
  const now = new Date();
  const day = 86400000;
  switch (range) {
    case 'day':
      return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    case '3d':
      return new Date(Date.now() - 3 * day).toISOString();
    case '7d':
      return new Date(Date.now() - 7 * day).toISOString();
    case '30d':
      return new Date(Date.now() - 30 * day).toISOString();
    case 'year':
      return new Date(Date.now() - 365 * day).toISOString();
    case 'all':
      return new Date(0).toISOString();
    case 'custom':
      return from ? new Date(from).toISOString() : new Date(Date.now() - 7 * day).toISOString();
    default:
      return new Date(Date.now() - 7 * day).toISOString();
  }
}

export function windowEnd(to = null) {
  return to ? new Date(to).toISOString() : new Date().toISOString();
}

export function queryUsage({ userId = null, range = '7d', from = null, to = null, model = null, bucket = 'day' }) {
  const start = windowStart(range, from, to);
  const end = windowEnd(to);
  const where = ['created_at >= ?', 'created_at <= ?'];
  const params = [start, end];
  if (userId) {
    where.push('user_id = ?');
    params.push(userId);
  }
  if (model) {
    where.push('model = ?');
    params.push(model);
  }
  const rows = all(`SELECT * FROM usage_records WHERE ${where.join(' AND ')} ORDER BY created_at ASC`, ...params);
  const fmt = { day: 10, hour: 13, month: 7 }[bucket] || 10;
  const buckets = new Map();
  const totals = { input: 0, cached: 0, output: 0, cost: 0, calls: 0 };
  const byModel = new Map();
  for (const r of rows) {
    const key = r.created_at.slice(0, fmt);
    const b = buckets.get(key) || { key, input: 0, cached: 0, output: 0, cost: 0, calls: 0 };
    b.input += r.input_tokens;
    b.cached += r.cached_tokens;
    b.output += r.output_tokens;
    b.cost += r.cost;
    b.calls += 1;
    buckets.set(key, b);
    totals.input += r.input_tokens;
    totals.cached += r.cached_tokens;
    totals.output += r.output_tokens;
    totals.cost += r.cost;
    totals.calls += 1;
    const m = byModel.get(r.model) || { model: r.model, input: 0, cached: 0, output: 0, cost: 0, calls: 0 };
    m.input += r.input_tokens;
    m.cached += r.cached_tokens;
    m.output += r.output_tokens;
    m.cost += r.cost;
    m.calls += 1;
    byModel.set(r.model, m);
  }
  return {
    range,
    from: start,
    to: end,
    bucket,
    totals: {
      input: totals.input,
      inputHit: totals.cached,
      inputMiss: Math.max(0, totals.input - totals.cached),
      output: totals.output,
      total: totals.input + totals.output,
      cost: Math.round(totals.cost * 1e6) / 1e6,
      calls: totals.calls,
    },
    series: [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key)),
    models: [...byModel.values()].sort((a, b) => b.cost - a.cost),
  };
}

export function usageTotals(userId = null) {
  const row = userId
    ? get('SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o, COALESCE(SUM(cost),0) c FROM usage_records WHERE user_id = ?', userId)
    : get('SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o, COALESCE(SUM(cost),0) c FROM usage_records');
  return { input: row.i, output: row.o, cost: row.c };
}
