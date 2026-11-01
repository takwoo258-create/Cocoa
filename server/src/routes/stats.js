// 统计路由：Token 用量 / 亲密度 / 陪伴概览（管理员复用同一套聚合函数）
import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { badRequest, notFound } from '../core/errors.js';
import { all, get } from '../db/index.js';
import { queryUsage, windowStart, windowEnd } from '../ai/usage.js';
import { getCharacter, defaultCharacterId, ensureState } from '../services/characters.js';
import { decryptJson } from '../core/crypto.js';
import { parseJson } from '../core/util.js';

const RANGES = new Set(['day', '3d', '7d', '30d', 'year', 'all', 'custom']);
const BUCKETS = new Set(['day', 'hour', 'month']);
const STATUS_SCAN_LIMIT = 20000;

const round1 = (n) => Math.round(Number(n || 0) * 10) / 10;

function parseIso(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) throw badRequest(`${label} 不是合法时间`, `${label}_invalid`);
  return d.toISOString();
}

export function parseUsageQuery(query = {}) {
  const range = RANGES.has(String(query.range)) ? String(query.range) : '7d';
  const bucket = BUCKETS.has(String(query.bucket)) ? String(query.bucket) : range === 'day' ? 'hour' : 'day';
  const from = parseIso(query.from, 'from');
  const to = parseIso(query.to, 'to');
  if (range === 'custom') {
    if (!from) throw badRequest('自定义区间需要 from 参数', 'from_required');
    if (to && new Date(to) < new Date(from)) throw badRequest('to 不能早于 from', 'range_invalid');
  }
  return { range, bucket, from, to, model: query.model ? String(query.model) : null };
}

/** 用量聚合；userId=null 表示全站（仅管理端使用） */
export function usageFor({ userId = null, query = {} } = {}) {
  const q = parseUsageQuery(query);
  const data = queryUsage({
    userId: userId || null,
    range: q.range,
    from: q.from,
    to: q.to,
    model: q.model,
    bucket: q.bucket,
  });
  return { ...data, model: q.model };
}

function companionDaysOf(since) {
  if (!since) return 0;
  const t = new Date(since).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(1, Math.floor((Date.now() - t) / 86400000) + 1);
}

function assertCharacter(userId, characterId) {
  const character = getCharacter(userId, String(characterId), { includeArchived: true });
  if (!character) throw notFound('角色不存在或不属于当前账号', 'character_not_found');
  return character;
}

/** 亲密度折线：intimacy_log 变化点 + character_state 当前值 */
export function intimacyFor(userId, { characterId = null, range = '7d', from = null, to = null } = {}) {
  const q = parseUsageQuery({ range, from, to, bucket: 'day' });
  let cid = null;
  if (characterId) cid = assertCharacter(userId, characterId).id;
  else cid = defaultCharacterId(userId);

  if (!cid) {
    return { characterId: null, range: q.range, from: q.from, to: q.to, current: 0, companionDays: 0, points: [] };
  }
  const state = ensureState(cid, userId);
  const start = windowStart(q.range, q.from, q.to);
  const end = windowEnd(q.to);
  const rows = all(
    'SELECT value, source, created_at FROM intimacy_log WHERE user_id = ? AND character_id = ? AND created_at >= ? AND created_at <= ? ORDER BY created_at ASC',
    userId,
    cid,
    start,
    end,
  );
  const points = rows.map((row) => ({ t: row.created_at, v: round1(row.value), source: row.source || null }));
  return {
    characterId: cid,
    range: q.range,
    from: start,
    to: end,
    current: round1(state.intimacy),
    companionDays: companionDaysOf(state.companion_since),
    points,
  };
}

/** 普通用户概览：对话数 / 文集数 / 健康异常 / 心情异常 / 陪伴天数 / 亲密度 */
export function overviewFor(userId, { characterId = null } = {}) {
  let cid = null;
  if (characterId) cid = assertCharacter(userId, characterId).id;
  const scope = cid ? 'character' : 'all';
  const charFilter = cid ? ' AND character_id = ?' : '';
  const params = cid ? [userId, cid] : [userId];

  const chatCount = get(
    `SELECT COUNT(*) AS n FROM messages WHERE user_id = ?${charFilter} AND (role = 'user' OR kind = 'user')`,
    ...params,
  ).n;
  const bookCount = get(`SELECT COUNT(*) AS n FROM books WHERE user_id = ?${charFilter}`, ...params).n;

  // v1.2.0：模型调用次数（usage_records 行数）与按模型分布
  const calls = get(`SELECT COUNT(*) AS n FROM usage_records WHERE user_id = ?${charFilter}`, ...params).n;
  const callsByModel = all(
    `SELECT model, COUNT(*) AS calls FROM usage_records WHERE user_id = ?${charFilter} GROUP BY model ORDER BY calls DESC`,
    ...params,
  ).map((row) => ({ model: row.model || 'unknown', calls: row.calls }));

  const statusRows = all(
    `SELECT meta FROM messages WHERE user_id = ?${charFilter} AND kind = 'status' AND meta IS NOT NULL ORDER BY created_at DESC LIMIT ${STATUS_SCAN_LIMIT}`,
    ...params,
  );
  let healthAbnormal = 0;
  let moodAbnormal = 0;
  for (const row of statusRows) {
    // 兼容加密串（AI 线约定 encryptJson）与历史明文
    const meta = decryptJson(userId, row.meta, null) ?? parseJson(row.meta, null);
    const flags = meta?.flags || meta?.statusFlags || {};
    if (flags.healthAbnormal) healthAbnormal += 1;
    if (flags.moodAbnormal) moodAbnormal += 1;
  }

  let companionDays = 0;
  let intimacy = 0;
  let characters = 0;
  if (cid) {
    const state = ensureState(cid, userId);
    companionDays = companionDaysOf(state.companion_since);
    intimacy = round1(state.intimacy);
    characters = 1;
  } else {
    const rows = all(
      'SELECT cs.intimacy, cs.companion_since FROM character_state cs JOIN characters c ON c.id = cs.character_id WHERE c.user_id = ? AND c.archived = 0',
      userId,
    );
    characters = rows.length;
    for (const row of rows) {
      companionDays = Math.max(companionDays, companionDaysOf(row.companion_since));
      intimacy = Math.max(intimacy, round1(row.intimacy));
    }
  }

  return {
    scope,
    characterId: cid,
    characters,
    chatCount,
    bookCount,
    calls,
    callsByModel,
    healthAbnormal,
    moodAbnormal,
    statusScanned: statusRows.length,
    companionDays,
    intimacy,
  };
}

export default function register() {
  const r = Router();
  r.use(requireAuth);

  r.get('/usage', (req, res) => {
    res.json(usageFor({ userId: req.userId, query: req.query }));
  });

  r.get('/intimacy', (req, res) => {
    res.json(
      intimacyFor(req.userId, {
        characterId: req.query.characterId ? String(req.query.characterId) : null,
        range: req.query.range ? String(req.query.range) : '7d',
        from: req.query.from || null,
        to: req.query.to || null,
      }),
    );
  });

  r.get('/overview', (req, res) => {
    res.json(overviewFor(req.userId, { characterId: req.query.characterId ? String(req.query.characterId) : null }));
  });

  return r;
}
