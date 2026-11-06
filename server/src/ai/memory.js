// 记忆域（v1.5）：用户特征抽取、去重合并、嵌入向量、关联图、三维布局、语义召回
// 同时为本线（画像/新闻/创作）提供：后台系统会话、限额判定、解密与提示词助手、日记密码上下文。
import { all, get, run, getMeta, setMeta, tx, db } from '../db/index.js';
import { encryptText, decryptText, encryptJson } from '../core/crypto.js';
import { nowIso, uuid, clamp, dayKey, truncate } from '../core/util.js';
import logger from '../core/logger.js';
import { chatText, embed } from './provider.js';
import { getPrefs } from '../services/settings.js';
import { enqueue, nextJob } from '../services/jobs.js';
import { usageTotals, recordUsage } from './usage.js';
import { getSettings, ensureDiaryLock, getDiaryCode as serviceDiaryCode } from '../services/characters.js';
import * as sharedPrompts from './prompts.js';

const log = logger;

/** 记忆点之间的相似度阈值（虚线关联） */
export const LINK_THRESHOLD = 0.82;
/** 召回/检索的相关性阈值（v1.5 提高，减少噪音） */
export const RELATED_THRESHOLD = 0.35;
/** 每次生成注入的记忆条数上限与高权重兜底条数 */
export const RECALL_K = 8;
export const RECALL_HIGH_WEIGHT = 3;
/** 抽取触发：≥2 条新用户消息，或距上次 ≥5 分钟（首次至少 1 条） */
export const EXTRACT_MIN_USER_MESSAGES = 2;
export const EXTRACT_INTERVAL_MS = 5 * 60_000;
/** 权重衰减：半衰期约 62 天（tau=90） */
export const DECAY_TAU_DAYS = 90;
export const ACCESS_BOOST = 0.015;
/** 处理画像/压缩时的统一提示语 */
export const MEMORY_NOTICE = '在回味之前的记忆喵~';

export const PALETTE_HINT = {
  agent: '#f3c17c',
  category: '#7fc8f8',
  subcategory: '#b7a6ff',
  memory: '#ffffff',
  dashed: '#ffffff66',
  glow: '#7cf9ff',
};

export const MEMORY_CATEGORIES = ['喜好', '雷点', '特长', '经历', '关系', '习惯', '情绪', '性格', '画像', '其他'];

const TYPE_TO_BIG = {
  preference: '喜好', like: '喜好', hobby: '喜好', favorite: '喜好',
  dislike: '雷点', taboo: '雷点', hate: '雷点',
  experience: '经历', event: '经历', story: '经历',
  relation: '关系', people: '关系', family: '关系',
  habit: '习惯', routine: '习惯', skill: '特长', ability: '特长',
  emotion: '情绪', mood: '情绪', trait: '性格', personality: '性格',
};

const MAX_LINK_SCAN = 400;
const GRAPH_PREVIEW = 400;
const GRAPH_VERSION = 2;

// 列自适应：Lead 在 migrations 里加列后自动启用（未加列时用 meta 表兜底）
function tableColumns(table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  } catch {
    return new Set();
  }
}
const MEMORY_COLUMNS = tableColumns('memories');
export const HAS_LAST_USED = MEMORY_COLUMNS.has('last_used_at');
export const HAS_USE_COUNT = MEMORY_COLUMNS.has('use_count');
export const HAS_EMOTION = MEMORY_COLUMNS.has('emotion');

// ---------------------------------------------------------------- 小工具

export function safeDecrypt(userId, blob) {
  if (blob == null) return '';
  try {
    return decryptText(userId, String(blob));
  } catch (err) {
    log.debug('解密失败，回退原文', err?.message);
    return String(blob);
  }
}

const round4 = (n) => Math.round(Number(n || 0) * 10000) / 10000;
const round3 = (n) => Math.round(Number(n || 0) * 1000) / 1000;

function cleanCategory(value, fallback = '其他') {
  const s = String(value ?? '')
    .replace(/[\u0000-\u001f/\\:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12);
  return s || fallback;
}

/** 记忆点的短摘要标签（图中显示） */
export function memoryLabel(text, max = 16) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return truncate(flat, max);
}

/** 共享提示词优先，缺失时用本地兜底（不因他线改动而崩） */
export function promptText(name, fallback, args) {
  const v = sharedPrompts?.[name];
  if (typeof v === 'string' && v.trim()) return v;
  if (typeof v === 'function') {
    try {
      const s = v(args);
      if (typeof s === 'string' && s.trim()) return s;
    } catch (err) {
      log.debug('共享提示词渲染失败', name, err?.message);
    }
  }
  return fallback;
}

export function parseJsonLoose(text) {
  if (!text) return null;
  if (typeof text === 'object') return text;
  const raw = String(text).trim();
  const candidates = [raw];
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {}
  }
  return null;
}

/** 稳定哈希 -> [0,1)，用于三维坐标等“不抖动”的确定性分布 */
export function hash01(seed, salt = 0) {
  let h = (2166136261 ^ Math.imul(Number(salt) + 1, 0x9e3779b9)) >>> 0;
  const s = String(seed ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39) >>> 0;
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// ---------------------------------------------------------------- 向量

/** Float32Array -> Buffer（写入 memories.embedding BLOB） */
export function vectorToBuffer(vector) {
  const arr = Float32Array.from((vector || []).map((n) => Number(n) || 0));
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

/** 任意 BLOB 形态 -> number[]（node:sqlite 返回 Uint8Array） */
export function bufferToVector(blob) {
  if (!blob || typeof blob === 'string') return null;
  const bytes = Buffer.isBuffer(blob) ? blob : Buffer.from(blob.buffer ?? blob);
  const len = Math.floor(bytes.byteLength / 4);
  if (!len) return null;
  // 复制到对齐的 ArrayBuffer，避免 Buffer 池偏移导致 Float32Array 构造失败
  const ab = new ArrayBuffer(len * 4);
  new Uint8Array(ab).set(bytes.subarray(0, len * 4));
  return Array.from(new Float32Array(ab));
}

export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 记忆权重：基础权重 + 关联加成（0-1，亮度直接取其值） */
export function weightWithLinks(base, linkCount = 0) {
  const b = clamp(Number(base) || 0, 0, 1);
  const bonus = Math.min(0.25, 0.05 * Math.max(0, Number(linkCount) || 0));
  return round4(clamp(b + bonus, 0, 1));
}

// ---------------------------------------------------------------- 关键词

const STOPWORDS = new Set([
  '用户', '喜欢', '讨厌', '觉得', '感觉', '最近', '今天', '而且', '但是', '因为', '所以',
  '我们', '他们', '自己', '一点', '有点', '非常', '真的', '东西', '事情', '时候', '这个',
  '那个', '什么', '怎么', '可以', '不是', '就是', '还有', '已经', '一直', '总是', '比较',
  '现在', '然后', '如果', '虽然', '应该', '可能', '其实', '特别', '感觉', '知道', '想要',
]);

/** 轻量关键词/实体抽取：中文二元组 + 英文单词，用于无 embedding 时去重与建链 */
export function extractKeywords(text, { limit = 12 } = {}) {
  const s = String(text ?? '');
  const out = new Set();
  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9_+.-]{1,}/g)) {
    const w = m[0].toLowerCase();
    if (w.length >= 2) out.add(w);
  }
  for (const seg of s.match(/[\u4e00-\u9fa5]+/g) || []) {
    if (seg.length >= 2 && seg.length <= 6 && !STOPWORDS.has(seg)) out.add(seg);
    for (let i = 0; i < seg.length - 1; i++) {
      const bg = seg.slice(i, i + 2);
      if (!STOPWORDS.has(bg)) out.add(bg);
    }
  }
  return [...out].slice(0, limit);
}

export function keywordOverlap(a = [], b = []) {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  const shared = a.filter((w) => setB.has(w));
  if (!shared.length) return 0;
  return shared.length / Math.sqrt(a.length * b.length);
}

// ---------------------------------------------------------------- 访问与衰减

const touchSeen = new Map();

function usageFromMeta(id) {
  return {
    lastUsedAt: getMeta(`mem:used:${id}`, null),
    useCount: Number(getMeta(`mem:cnt:${id}`, '0')) || 0,
  };
}

/** 命中回写：last_used_at / use_count / weight（列缺失时用 meta 兜底） */
export function touchMemory(id, { now = Date.now(), boost = ACCESS_BOOST } = {}) {
  try {
    const row = get('SELECT id, weight FROM memories WHERE id = ?', id);
    if (!row) return null;
    const iso = new Date(now).toISOString();
    const weight = round4(clamp(Number(row.weight) + boost, 0, 1));
    if (HAS_LAST_USED && HAS_USE_COUNT) {
      run('UPDATE memories SET weight = ?, last_used_at = ?, use_count = use_count + 1 WHERE id = ?', weight, iso, id);
    } else {
      run('UPDATE memories SET weight = ? WHERE id = ?', weight, id);
      setMeta(`mem:used:${id}`, iso);
      const cnt = Number(getMeta(`mem:cnt:${id}`, '0')) || 0;
      setMeta(`mem:cnt:${id}`, String(cnt + 1));
    }
    return { id, weight, lastUsedAt: iso };
  } catch (err) {
    log.debug('记忆访问回写失败', err?.message);
    return null;
  }
}

/** 同一记忆 10 分钟内只加一次访问权重，避免刷屏式膨胀 */
export function touchMemoryThrottled(id, { now = Date.now(), windowMs = 10 * 60_000 } = {}) {
  const last = touchSeen.get(id) || 0;
  if (now - last < windowMs) return null;
  touchSeen.set(id, now);
  if (touchSeen.size > 2000) touchSeen.clear();
  return touchMemory(id, { now });
}

/**
 * 时间衰减：按距上次衰减的天数做指数衰减（每天最多执行一次，避免重复叠加）。
 * 访问加成在 touchMemory 里单独 +。
 */
export function decayMemories(userId, characterId, { now = Date.now(), tauDays = DECAY_TAU_DAYS } = {}) {
  const key = `memory:decay:${userId}:${characterId}`;
  const last = Date.parse(getMeta(key, '') || '') || 0;
  const hours = last ? (now - last) / 3600_000 : Infinity;
  if (hours < 20) return { skipped: true, reason: 'recent', changed: 0 };
  const days = Number.isFinite(hours) ? Math.min(365, hours / 24) : 0;
  const factor = days > 0 ? Math.exp(-days / Math.max(7, tauDays)) : 1;
  const rows = all('SELECT id, weight FROM memories WHERE user_id = ? AND character_id = ?', userId, characterId);
  let changed = 0;
  if (days > 0) {
    tx(() => {
      for (const r of rows) {
        const w = round4(clamp(Number(r.weight) * factor, 0.05, 1));
        if (Math.abs(w - Number(r.weight)) > 0.0001) {
          run('UPDATE memories SET weight = ? WHERE id = ?', w, r.id);
          changed++;
        }
      }
    });
  }
  setMeta(key, nowIso());
  return { ok: true, days: round3(days), factor: round4(factor), changed };
}

// ---------------------------------------------------------------- 记忆读写

export function shapeMemory(userId, row) {
  if (!row) return null;
  const fallback = HAS_LAST_USED && HAS_USE_COUNT ? {} : usageFromMeta(row.id);
  return {
    id: row.id,
    userId: row.user_id,
    characterId: row.character_id,
    big: row.big,
    small: row.small,
    content: safeDecrypt(userId, row.content),
    weight: round4(row.weight),
    brightness: round4(row.weight),
    emotion: row.emotion ?? null,
    source: row.source || null,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? fallback.lastUsedAt ?? null,
    useCount: Number(row.use_count ?? fallback.useCount ?? 0),
    hasEmbedding: Boolean(row.embedding),
  };
}

export function listMemories(userId, characterId, { limit = 800 } = {}) {
  const rows = all(
    'SELECT * FROM memories WHERE user_id = ? AND character_id = ? ORDER BY created_at ASC LIMIT ?',
    userId,
    characterId,
    limit,
  );
  return rows.map((r) => shapeMemory(userId, r));
}

export function getMemory(userId, id) {
  const row = get('SELECT * FROM memories WHERE id = ? AND user_id = ?', id, userId);
  return row ? shapeMemory(userId, row) : null;
}

/** 与已有记忆做相似度比对，>阈值写 memory_links（无向、去重、按 a<b 规范化） */
export function linkMemory(userId, characterId, memoryId, vector, { threshold = LINK_THRESHOLD } = {}) {
  if (!Array.isArray(vector) || !vector.length) return [];
  const rows = all(
    'SELECT id, embedding FROM memories WHERE user_id = ? AND character_id = ? AND id <> ? AND embedding IS NOT NULL LIMIT ?',
    userId,
    characterId,
    memoryId,
    MAX_LINK_SCAN,
  );
  const linked = [];
  for (const row of rows) {
    const other = bufferToVector(row.embedding);
    if (!other) continue;
    const score = cosine(vector, other);
    if (!(score > threshold)) continue;
    const [a, b] = memoryId < row.id ? [memoryId, row.id] : [row.id, memoryId];
    run(
      `INSERT INTO memory_links(a, b, score, created_at) VALUES(?,?,?,?)
       ON CONFLICT(a, b) DO UPDATE SET score = CASE
         WHEN excluded.score > memory_links.score THEN excluded.score ELSE memory_links.score END`,
      a,
      b,
      round4(score),
      nowIso(),
    );
    linked.push({ id: row.id, score: round4(score) });
  }
  return linked;
}

/**
 * 建立关联（v1.5）：至少按同类/同实体生成，再叠加语义相似。
 * 返回建立的关联条数。
 */
export function relinkMemory(userId, memoryId, { vector = null, keywords = null, maxSemantic = 5 } = {}) {
  const row = get('SELECT * FROM memories WHERE id = ? AND user_id = ?', memoryId, userId);
  if (!row) return 0;
  const vec = vector && vector.length ? vector : bufferToVector(row.embedding);
  const kw = keywords && keywords.length ? keywords : extractKeywords(safeDecrypt(userId, row.content));
  const others = all(
    'SELECT id, big, small, content, weight, embedding FROM memories WHERE user_id = ? AND character_id = ? AND id <> ? ORDER BY weight DESC LIMIT ?',
    userId,
    row.character_id,
    memoryId,
    MAX_LINK_SCAN,
  );
  const candidates = [];
  for (const o of others) {
    let score = 0;
    let kind = 'semantic';
    if (vec) {
      const ov = bufferToVector(o.embedding);
      if (ov) {
        const s = cosine(vec, ov);
        if (s > LINK_THRESHOLD) {
          score = s;
          kind = 'semantic';
        }
      }
    }
    if (!score && o.small === row.small) {
      score = 0.64;
      kind = 'same_small';
    }
    if (!score && o.big === row.big) {
      score = 0.58;
      kind = 'same_big';
    }
    if (!score) {
      const ov = keywordOverlap(kw, extractKeywords(safeDecrypt(userId, o.content)));
      if (ov >= 0.34) {
        score = 0.55 + Math.min(0.2, ov * 0.2);
        kind = 'entity';
      }
    }
    if (score > 0) candidates.push({ id: o.id, score: round4(score), kind });
  }
  candidates.sort((a, b) => b.score - a.score);
  const caps = { semantic: maxSemantic, same_small: 3, same_big: 2, entity: 3 };
  const used = {};
  const chosen = [];
  for (const c of candidates) {
    if (chosen.length >= 10) break;
    used[c.kind] = (used[c.kind] || 0) + 1;
    if (used[c.kind] > (caps[c.kind] || 2)) continue;
    chosen.push(c);
  }
  if (!chosen.length) return 0;
  tx(() => {
    for (const c of chosen) {
      const [a, b] = memoryId < c.id ? [memoryId, c.id] : [c.id, memoryId];
      run(
        `INSERT INTO memory_links(a, b, score, created_at) VALUES(?,?,?,?)
         ON CONFLICT(a, b) DO UPDATE SET score = CASE
           WHEN excluded.score > memory_links.score THEN excluded.score ELSE memory_links.score END`,
        a,
        b,
        c.score,
        nowIso(),
      );
    }
  });
  return chosen.length;
}

/**
 * 写入一个记忆点（内容加密，向量以 Float32Array Buffer 存 BLOB）。
 * 关联建立后按「基础权重 + 关联加成」重算 weight，图中亮度 = weight。
 */
export function insertMemory(userId, characterId, data = {}) {
  const text = String(data.content ?? '').trim();
  if (!text || !userId || !characterId) return null;
  const id = `mem_${uuid().replace(/-/g, '').slice(0, 16)}`;
  const big = cleanCategory(data.big, '其他');
  const small = cleanCategory(data.small, '其他');
  const base = clamp(Number(data.weight) || 0.5, 0, 1);
  const vec = Array.isArray(data.embedding) && data.embedding.length ? data.embedding.map(Number) : null;
  const cols = ['id', 'user_id', 'character_id', 'big', 'small', 'content', 'weight', 'embedding', 'source', 'created_at'];
  const vals = [id, userId, characterId, big, small, encryptText(userId, text), round4(base), vec ? vectorToBuffer(vec) : null, String(data.source || 'chat'), nowIso()];
  if (HAS_EMOTION) {
    cols.push('emotion');
    vals.push(data.emotion ? String(data.emotion).slice(0, 20) : null);
  }
  if (HAS_USE_COUNT) {
    cols.push('use_count');
    vals.push(0);
  }
  if (HAS_LAST_USED) {
    cols.push('last_used_at');
    vals.push(null);
  }
  run(`INSERT INTO memories(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, ...vals);
  const linked = data.link === false ? 0 : relinkMemory(userId, id, { vector: vec, keywords: data.keywords });
  const finalWeight = weightWithLinks(base, linked);
  if (finalWeight !== round4(base)) run('UPDATE memories SET weight = ? WHERE id = ?', finalWeight, id);
  return { ...shapeMemory(userId, get('SELECT * FROM memories WHERE id = ?', id)), linked };
}

/**
 * 去重合并：命中相似记忆时合并内容、抬高权重、补向量，而不是新增一条。
 * 返回 {row, reason, score} 或 null。
 */
export function findSimilarMemory(userId, characterId, item, vector, { embeddingThreshold = 0.92, keywordThreshold = 0.62 } = {}) {
  const rows = all('SELECT * FROM memories WHERE user_id = ? AND character_id = ?', userId, characterId);
  const text = String(item.content || '').toLowerCase();
  const kwNew = item.keywords?.length ? item.keywords : extractKeywords(item.content);
  let best = null;
  for (const row of rows) {
    const existing = safeDecrypt(userId, row.content).trim();
    const lower = existing.toLowerCase();
    if (lower && text && (lower === text || lower.includes(text) || text.includes(lower))) {
      return { row, reason: 'text', score: 1 };
    }
    const vec = bufferToVector(row.embedding);
    if (vec && Array.isArray(vector) && vector.length) {
      const s = cosine(vector, vec);
      if (s >= embeddingThreshold && (!best || s > best.score)) best = { row, reason: 'embedding', score: round4(s) };
    }
    const ov = keywordOverlap(kwNew, extractKeywords(existing));
    if (ov >= keywordThreshold && (!best || ov > best.score)) best = { row, reason: 'keywords', score: round4(ov) };
  }
  return best;
}

/** 合并进已有记忆：更新内容/权重/情绪/向量，并重建关联 */
export function mergeMemory(userId, row, item, vector = null) {
  const oldText = safeDecrypt(userId, row.content).trim();
  const incoming = String(item.content || '').trim();
  let content = oldText;
  if (incoming && !oldText.includes(incoming)) {
    content = incoming.length > oldText.length ? incoming : `${oldText}；${incoming}`;
  }
  content = content.slice(0, 500);
  const weight = round4(clamp(Math.max(Number(row.weight) || 0, Number(item.weight) || 0) + 0.03, 0, 1));
  const sets = ['content = ?', 'weight = ?'];
  const vals = [encryptText(userId, content), weight];
  if (HAS_EMOTION && item.emotion) {
    sets.push('emotion = ?');
    vals.push(String(item.emotion).slice(0, 20));
  }
  if (vector && vector.length) {
    sets.push('embedding = ?');
    vals.push(vectorToBuffer(vector));
  }
  if (HAS_LAST_USED) {
    sets.push('last_used_at = ?');
    vals.push(nowIso());
  }
  if (HAS_USE_COUNT) {
    sets.push('use_count = use_count + 1');
  }
  run(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`, ...vals, row.id);
  relinkMemory(userId, row.id, { vector, keywords: extractKeywords(content) });
  return { ...shapeMemory(userId, get('SELECT * FROM memories WHERE id = ?', row.id)), merged: true };
}

/** 把记忆写进库：先查重合并，否则新增。 */
export function upsertMemory(userId, characterId, item, vector = null) {
  const dup = findSimilarMemory(userId, characterId, item, vector);
  if (dup) return { memory: mergeMemory(userId, dup.row, item, vector), merged: true, reason: dup.reason, score: dup.score };
  const memory = insertMemory(userId, characterId, { ...item, embedding: vector, source: item.source || 'chat' });
  return { memory, merged: false };
}

/** 补齐某角色的关联（启动/抽取后调用） */
export function ensureMemoryLinks(userId, characterId, { limit = 60 } = {}) {
  const rows = all(
    'SELECT id FROM memories WHERE user_id = ? AND character_id = ? ORDER BY created_at DESC LIMIT ?',
    userId,
    characterId,
    limit,
  );
  let links = 0;
  for (const r of rows) {
    try {
      links += relinkMemory(userId, r.id);
    } catch (err) {
      log.debug('补建记忆关联失败', err?.message);
    }
  }
  return links;
}

export function deleteMemory(userId, id) {
  const row = get('SELECT id FROM memories WHERE id = ? AND user_id = ?', id, userId);
  if (!row) return false;
  tx(() => {
    run('DELETE FROM memory_links WHERE a = ? OR b = ?', id, id);
    run('DELETE FROM memories WHERE id = ? AND user_id = ?', id, userId);
  });
  return true;
}

/** 记忆详情：含大小类目、创建时间、情绪、关联列表（虚线关联的来源） */
export function memoryDetail(userId, id) {
  const row = get('SELECT * FROM memories WHERE id = ? AND user_id = ?', id, userId);
  if (!row) return null;
  const mem = shapeMemory(userId, row);
  const linkRows = all('SELECT a, b, score, created_at FROM memory_links WHERE a = ? OR b = ?', id, id);
  const links = [];
  for (const l of linkRows) {
    const otherId = l.a === id ? l.b : l.a;
    const other = get('SELECT id, big, small, content, weight FROM memories WHERE id = ? AND user_id = ?', otherId, userId);
    if (!other) continue;
    links.push({
      id: other.id,
      label: memoryLabel(safeDecrypt(userId, other.content)),
      big: other.big,
      small: other.small,
      weight: round4(other.weight),
      score: round4(l.score),
      dashed: true,
    });
  }
  links.sort((a, b) => b.score - a.score);
  return { ...mem, links, linkCount: links.length };
}

// ---------------------------------------------------------------- 三维布局

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function unitSphere(i, total, seed) {
  const z = total <= 1 ? 0 : 1 - (2 * (i + 0.5)) / total;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  const theta = GOLDEN_ANGLE * i + hash01(seed, 7) * 0.9;
  return { x: Math.cos(theta) * r, y: z, z: Math.sin(theta) * r };
}

/**
 * 稳定三维坐标：id 哈希 -> 球面分布，父子锚定；最后整体平移到图质心。
 * 同一份数据多次请求结果完全一致（没有随机数），节点增删也只是局部偏移。
 */
export function layout3D(nodes = []) {
  const pos = new Map();
  const agent = nodes.find((n) => n.type === 'agent');
  const bigs = nodes.filter((n) => n.type === 'category' && n.big === true);
  const smalls = nodes.filter((n) => n.type === 'category' && n.big === false);
  const memories = nodes.filter((n) => n.type === 'memory');
  if (agent) pos.set(agent.id, { x: 0, y: 0, z: 0 });

  bigs.sort((a, b) => String(a.label).localeCompare(String(b.label), 'zh'));
  bigs.forEach((n, i) => {
    const u = unitSphere(i, bigs.length, n.id);
    const r = 250 + hash01(n.id, 11) * 80;
    pos.set(n.id, { x: u.x * r, y: u.y * r * 0.82, z: u.z * r });
  });

  for (const n of smalls) {
    const base = pos.get(n.parent) || { x: 0, y: 0, z: 0 };
    const a = hash01(n.id, 3) * Math.PI * 2;
    const e = (hash01(n.id, 4) - 0.5) * Math.PI * 0.9;
    const r = 95 + hash01(n.id, 5) * 45;
    pos.set(n.id, {
      x: base.x + Math.cos(a) * Math.cos(e) * r,
      y: base.y + Math.sin(e) * r,
      z: base.z + Math.sin(a) * Math.cos(e) * r,
    });
  }

  for (const n of memories) {
    const base = pos.get(`cat:${n.big}/${n.small}`) || pos.get(agent?.id || 'agent') || { x: 0, y: 0, z: 0 };
    const a = hash01(n.id, 6) * Math.PI * 2;
    const e = (hash01(n.id, 7) - 0.5) * Math.PI;
    const r = 46 + hash01(n.id, 8) * 46;
    pos.set(n.id, {
      x: base.x + Math.cos(a) * Math.cos(e) * r,
      y: base.y + Math.sin(e) * r,
      z: base.z + Math.sin(a) * Math.cos(e) * r,
    });
  }

  // 平移到质心：客户端看到的旋转中心就是图的重心
  if (pos.size) {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const p of pos.values()) {
      cx += p.x;
      cy += p.y;
      cz += p.z;
    }
    cx /= pos.size;
    cy /= pos.size;
    cz /= pos.size;
    for (const [id, p] of pos) {
      pos.set(id, { x: round3(p.x - cx), y: round3(p.y - cy), z: round3(p.z - cz) });
    }
  }
  return pos;
}

/** 节点发光强度：权重为主，访问越近越亮 */
export function glowOf(weight, lastUsedAt = null, { now = Date.now() } = {}) {
  const w = clamp(Number(weight) || 0, 0, 1);
  if (!lastUsedAt) return round3(clamp(0.18 + 0.62 * w, 0, 1));
  const days = Math.max(0, (now - Date.parse(lastUsedAt)) / 86400000);
  const recency = Math.exp(-days / 30);
  return round3(clamp(0.2 + 0.55 * w + 0.2 * recency, 0, 1));
}

// ---------------------------------------------------------------- 网状图

/**
 * 四层图：agent -> 大类目 -> 小类目 -> 记忆点
 * v1.5：每个节点附带稳定 x/y/z、level、weight、glow；旧字段保持兼容。
 */
export function buildGraph(userId, characterId, characterName = '智能体') {
  const memories = listMemories(userId, characterId);
  const nodes = [{ id: 'agent', type: 'agent', level: 0, label: String(characterName || '智能体'), weight: 1, brightness: 1, glow: 1 }];
  const links = [];
  const bigMap = new Map();

  for (const m of memories) {
    const bigId = `cat:${m.big}`;
    const smallId = `cat:${m.big}/${m.small}`;
    if (!bigMap.has(bigId)) bigMap.set(bigId, { big: m.big, smalls: new Map(), weights: [] });
    const bigEntry = bigMap.get(bigId);
    bigEntry.weights.push(m.weight);
    if (!bigEntry.smalls.has(smallId)) bigEntry.smalls.set(smallId, { small: m.small, weights: [] });
    bigEntry.smalls.get(smallId).weights.push(m.weight);
  }

  const avg = (arr) => (arr.length ? round3(arr.reduce((a, b) => a + b, 0) / arr.length) : 0);

  const bigEntries = [...bigMap.entries()].sort((a, b) => avg(b[1].weights) - avg(a[1].weights));
  for (const [bigId, entry] of bigEntries) {
    nodes.push({
      id: bigId,
      type: 'category',
      level: 1,
      label: entry.big,
      big: true,
      parent: 'agent',
      weight: avg(entry.weights),
      brightness: avg(entry.weights),
      glow: round3(clamp(0.2 + 0.5 * avg(entry.weights), 0, 1)),
      count: entry.weights.length,
    });
    links.push({ source: 'agent', target: bigId, dashed: false });
    const smallEntries = [...entry.smalls.entries()].sort((a, b) => avg(b[1].weights) - avg(a[1].weights));
    for (const [smallId, smallEntry] of smallEntries) {
      nodes.push({
        id: smallId,
        type: 'category',
        level: 2,
        label: smallEntry.small,
        big: false,
        parent: bigId,
        weight: avg(smallEntry.weights),
        brightness: avg(smallEntry.weights),
        glow: round3(clamp(0.18 + 0.5 * avg(smallEntry.weights), 0, 1)),
        count: smallEntry.weights.length,
      });
      links.push({ source: bigId, target: smallId, dashed: false });
    }
  }

  for (const m of memories) {
    const content = String(m.content || '');
    nodes.push({
      id: m.id,
      type: 'memory',
      level: 3,
      label: memoryLabel(content),
      preview: truncate(content, GRAPH_PREVIEW),
      weight: m.weight,
      brightness: m.weight,
      glow: glowOf(m.weight, m.lastUsedAt),
      big: m.big,
      small: m.small,
      emotion: m.emotion || null,
      useCount: m.useCount || 0,
      lastUsedAt: m.lastUsedAt || null,
      createdAt: m.createdAt,
    });
    links.push({ source: `cat:${m.big}/${m.small}`, target: m.id, dashed: false });
  }

  // 记忆点之间的虚线关联（memory_links 无向，按 a<b 存储）
  const ids = new Set(memories.map((m) => m.id));
  const linkRows = all('SELECT a, b, score FROM memory_links');
  for (const l of linkRows) {
    if (!ids.has(l.a) || !ids.has(l.b)) continue;
    links.push({ source: l.a, target: l.b, dashed: true, score: round4(l.score) });
  }

  const pos = layout3D(nodes);
  for (const n of nodes) {
    const p = pos.get(n.id) || { x: 0, y: 0, z: 0 };
    n.x = p.x;
    n.y = p.y;
    n.z = p.z;
    n.seed = Math.round(hash01(n.id, 13) * 0xffffffff).toString(16);
  }

  return {
    nodes,
    links,
    counts: {
      memories: memories.length,
      big: bigMap.size,
      small: [...bigMap.values()].reduce((n, e) => n + e.smalls.size, 0),
    },
    layout: { type: 'sphere', version: GRAPH_VERSION, centered: true, centroid: { x: 0, y: 0, z: 0 } },
    paletteHint: PALETTE_HINT,
  };
}

// ---------------------------------------------------------------- 检索

function keywordSearch(userId, characterId, q, limit) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return [];
  return listMemories(userId, characterId)
    .filter((m) => `${m.content} ${m.big} ${m.small}`.toLowerCase().includes(needle))
    .slice(0, limit)
    .map((m) => ({ ...m, score: 1, mode: 'keyword' }));
}

/**
 * 语义检索：有嵌入服务走 cosine（阈值 RELATED_THRESHOLD）；无 key/失败退化为解密后关键词匹配。
 */
export async function searchMemories(userId, characterId, query, { limit = 20, threshold = RELATED_THRESHOLD } = {}) {
  const q = String(query || '').trim();
  if (!q) return { q, mode: 'keyword', items: [] };
  let vector = null;
  try {
    const res = await embed(userId, [q]);
    vector = res?.vectors?.[0] || null;
    if (vector) {
      recordUsage({ userId, characterId, kind: 'embedding', model: res.model || 'embedding', usage: res.usage || {} });
    }
  } catch (err) {
    log.debug('语义检索退回关键词匹配', err?.message);
  }
  if (!vector) return { q, mode: 'keyword', items: keywordSearch(userId, characterId, q, limit) };

  const rows = all(
    'SELECT * FROM memories WHERE user_id = ? AND character_id = ? AND embedding IS NOT NULL LIMIT 1000',
    userId,
    characterId,
  );
  const scored = [];
  for (const row of rows) {
    const vec = bufferToVector(row.embedding);
    if (!vec) continue;
    scored.push({ ...shapeMemory(userId, row), score: round4(cosine(vector, vec)), mode: 'semantic' });
  }
  scored.sort((a, b) => b.score - a.score);
  let items = scored.filter((s) => s.score >= threshold).slice(0, limit);
  if (!items.length) items = keywordSearch(userId, characterId, q, limit);
  return { q, mode: items.length && items[0].mode === 'semantic' ? 'semantic' : 'keyword', items };
}

// ---------------------------------------------------------------- 限额与上下文

/** Token 限额状态：hard 停全部，soft 停创作/新闻 */
export function limitState(userId) {
  const prefs = getPrefs(userId) || {};
  const limits = prefs.limits || {};
  const soft = Number(limits.softTokens || 0);
  const hard = Number(limits.hardTokens || 0);
  let total = 0;
  try {
    const totals = usageTotals(userId);
    total = Number(totals.input || 0) + Number(totals.output || 0);
  } catch (err) {
    log.debug('用量统计失败', err?.message);
  }
  if (hard > 0 && total >= hard) return { state: 'hard', total, soft, hard };
  if (soft > 0 && total >= soft) return { state: 'soft', total, soft, hard };
  return { state: 'ok', total, soft, hard };
}

/** 用户偏好：是否自动抽取特征记忆（默认 true） */
export function autoMemoryEnabled(userId) {
  try {
    const prefs = getPrefs(userId) || {};
    return prefs.autoMemory !== false;
  } catch {
    return true;
  }
}

/** 近期对话（解密），供记忆抽取/画像/日记使用 */
export function recentMessages(userId, characterId, { limit = 40, days = 7, since = null, roles = ['user', 'agent'] } = {}) {
  const from = since || new Date(Date.now() - days * 86400000).toISOString();
  const placeholders = roles.map(() => '?').join(',');
  const rows = all(
    `SELECT id, role, kind, content, created_at FROM messages
     WHERE user_id = ? AND character_id = ? AND role IN (${placeholders}) AND created_at >= ?
     ORDER BY created_at DESC LIMIT ?`,
    userId,
    characterId,
    ...roles,
    from,
    limit,
  );
  return rows
    .reverse()
    .map((r) => ({
      id: r.id,
      role: r.role,
      kind: r.kind,
      content: safeDecrypt(userId, r.content),
      createdAt: r.created_at,
    }))
    .filter((m) => m.content.trim());
}

/**
 * 后台系统会话（kind='system'）：记忆抽取/画像/新闻各用独立会话，按「日 + 标签」复用。
 */
export function systemConversation(userId, characterId, tag = 'sys') {
  const title = `sys:${tag}:${dayKey()}`;
  let row = get(
    "SELECT * FROM conversations WHERE user_id = ? AND character_id = ? AND kind = 'system' AND title = ? ORDER BY created_at DESC LIMIT 1",
    userId,
    characterId,
    title,
  );
  if (row) return row;
  const id = `conv_${uuid().replace(/-/g, '').slice(0, 16)}`;
  const now = nowIso();
  run(
    `INSERT INTO conversations(id, character_id, user_id, kind, title, created_at, updated_at, token_used, context_limit, active)
     VALUES(?,?,?,'system',?,?,?,0,128000,0)`,
    id,
    characterId,
    userId,
    title,
    now,
    now,
  );
  return get('SELECT * FROM conversations WHERE id = ?', id);
}

export function appendSystemMessage(userId, characterId, { tag = 'sys', kind = 'notice', role = 'system', content = '', meta = null } = {}) {
  const text = String(content ?? '').trim();
  if (!text) return null;
  const conv = systemConversation(userId, characterId, tag);
  const id = `m_${uuid().replace(/-/g, '').slice(0, 16)}`;
  const now = nowIso();
  const tokens = Math.max(1, Math.round(text.length / 1.5));
  run(
    `INSERT INTO messages(id, conversation_id, character_id, user_id, role, kind, content, meta, tokens_in, tokens_out, created_at)
     VALUES(?,?,?,?,?,?,?,?,0,?,?)`,
    id,
    conv.id,
    characterId,
    userId,
    role,
    kind,
    encryptText(userId, text),
    meta ? encryptJson(userId, meta) : null,
    tokens,
    now,
  );
  run('UPDATE conversations SET updated_at = ?, token_used = token_used + ? WHERE id = ?', now, tokens, conv.id);
  return id;
}

/** 清理 3 天前的后台上下文（新闻/记忆/画像系统会话） */
export function cleanupSystemContext(userId, characterId, { days = 3 } = {}) {
  const cutoff = new Date(Date.now() - Math.max(1, days) * 86400000).toISOString();
  const convs = all(
    "SELECT id FROM conversations WHERE user_id = ? AND character_id = ? AND kind = 'system' AND updated_at < ?",
    userId,
    characterId,
    cutoff,
  );
  let removed = 0;
  tx(() => {
    for (const c of convs) {
      run('DELETE FROM messages WHERE conversation_id = ?', c.id);
      run('DELETE FROM conversations WHERE id = ?', c.id);
      removed++;
    }
  });
  run(
    "DELETE FROM messages WHERE user_id = ? AND character_id = ? AND kind = 'news' AND created_at < ?",
    userId,
    characterId,
    cutoff,
  );
  return { conversations: removed, cutoff };
}

// ---------------------------------------------------------------- 日记密码上下文

/** 当日日记密码明文（来自 services/characters.js，仅服务端内部注入用，绝不返回客户端） */
export function getDiaryCode(userId, characterId, day = dayKey()) {
  if (day !== dayKey()) return '';
  try {
    return serviceDiaryCode(characterId, userId) || '';
  } catch (err) {
    log.debug('读取日记密码失败', err?.message);
    return '';
  }
}

/** 确保当日日记锁存在：密码由 services/characters.ensureDiaryLock 生成（hash + 加密 code） */
export function ensureDiaryCode(userId, characterId) {
  try {
    const lock = ensureDiaryLock(characterId, userId);
    return { day: lock.day, code: lock.code || '', hint: lock.hint || '', fresh: Boolean(lock.fresh) };
  } catch (err) {
    log.debug('日记锁创建失败', err?.message);
    return { day: dayKey(), code: '', hint: '', fresh: false };
  }
}

/** 注入 system prompt 的日记上下文：角色知道密码，但被要求只能暗示（不写库、不写日志） */
export function diaryContextForChat(userId, characterId, day = dayKey()) {
  try {
    if (day !== dayKey()) return '';
    const owned = get('SELECT id FROM characters WHERE id = ? AND user_id = ?', characterId, userId);
    if (!owned) return '';
    const book = get(
      "SELECT id FROM books WHERE user_id = ? AND character_id = ? AND type = 'diary' AND day = ? LIMIT 1",
      userId,
      characterId,
      day,
    );
    const lock = get('SELECT * FROM diary_locks WHERE character_id = ? AND day = ?', characterId, day);
    if (!book && !lock) return '';
    const info = ensureDiaryCode(userId, characterId);
    const code = info.code || getDiaryCode(userId, characterId, day);
    const today = new Date(Date.now() + 8 * 3600_000);
    const dateLabel = `${today.getUTCMonth() + 1} 月 ${today.getUTCDate()} 日`;
    if (code) {
      return `【今天的日记本】今天是 ${dateLabel}，日记密码是 ${code}。这是你的秘密：他问起时只能给含蓄线索（比如「${info.hint}」），绝不能直接说出这六位数字，也不要提到这段说明。`;
    }
    return `【今天的日记本】今天是 ${dateLabel}，密码只有你知道。可以给他的线索：${info.hint || '（暂无）'}（不要直接说出数字）。`;
  } catch (err) {
    log.debug('日记上下文注入失败', err?.message);
    return '';
  }
}

// ---------------------------------------------------------------- 记忆抽取

const MEMORY_EXTRACT_SYSTEM = `你是用户特征抽取器。阅读对话，抽取用户明确表达或强烈暗示的、值得长期记住的个人特征。
只输出 JSON，不要代码块、不要解释：
{"memories":[{"type":"preference|dislike|experience|relation|habit|emotion|skill|trait","big":"喜好","small":"食物","content":"一句具体、可验证的描述","weight":0.8,"emotion":"喜爱|厌恶|焦虑|开心|低落|平静|其他","keywords":["火锅","辣"]}]}
规则：
1. type 必填；big 只能是 喜好/雷点/经历/关系/习惯/情绪/特长/性格 之一；small 2-4 字。
2. content 20-80 字，写清楚“是什么 + 具体细节”，不要复述原句，不要模糊（反例：用户喜欢一些东西）。
3. weight 0-1：长期偏好/雷点 0.6-0.9；一次性经历 0.3-0.6；强烈情绪 0.5-0.8。
4. emotion 描述用户当时的情绪；keywords 给 1-4 个可用于检索的关键词/实体。
5. 同一特征只输出一次；没有可记内容时输出 {"memories":[]}；不要编造，不要记录寒暄、天气、一次性的“在吗”。`;

const MEMORY_EXTRACT_RETRY = `${MEMORY_EXTRACT_SYSTEM}
注意：上一次输出不是合法 JSON。这次必须只输出一个 JSON 对象，第一个字符是 {，最后一个字符是 }。`;

/** 解析抽取结果；非法 JSON 返回 null（用于触发重试），合法但空返回 [] */
export function parseExtractionResult(text) {
  const data = parseJsonLoose(text);
  if (!data || typeof data !== 'object') return null;
  const list = Array.isArray(data.memories) ? data.memories : Array.isArray(data) ? data : [];
  const items = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const content = String(raw.content ?? raw.text ?? '').replace(/\s+/g, ' ').trim();
    if (content.length < 2) continue;
    const type = String(raw.type || '').toLowerCase();
    const big = cleanCategory(raw.big || raw.category || TYPE_TO_BIG[type] || '其他');
    const small = cleanCategory(raw.small || raw.subcategory || '其他');
    let weight = Number(raw.weight);
    if (!Number.isFinite(weight)) weight = 0.5;
    if (big === '雷点') weight += 0.05;
    if (['经历', '关系'].includes(big)) weight += 0.02;
    const keywords = Array.isArray(raw.keywords)
      ? raw.keywords.map((k) => String(k || '').trim()).filter(Boolean).slice(0, 6)
      : [];
    items.push({
      type: type || 'preference',
      big,
      small,
      content: content.slice(0, 500),
      weight: round4(clamp(weight, 0, 1)),
      emotion: raw.emotion ? String(raw.emotion).slice(0, 20) : null,
      keywords: keywords.length ? keywords : extractKeywords(content),
    });
  }
  return { items, raw: data };
}

/** 兼容旧接口：直接给出条目数组 */
export function parseMemoryItems(text) {
  const parsed = parseExtractionResult(text);
  return parsed ? parsed.items : [];
}

/** 触发判定（v1.5）：首次≥1 条用户消息；之后 ≥2 条新用户消息或距上次 ≥5 分钟 */
export function shouldRunExtraction(userId, characterId, { now = Date.now(), since = null, force = false } = {}) {
  if (force) return { ok: true, reason: 'forced', from: since };
  if (!autoMemoryEnabled(userId)) return { ok: false, reason: 'auto_memory_off', pending: 0 };
  const lastAt = Date.parse(getMeta(`memory:last_at:${userId}:${characterId}`, '') || '') || 0;
  const from = since || (lastAt ? new Date(lastAt).toISOString() : new Date(now - 86400000).toISOString());
  const row = get(
    "SELECT COUNT(*) n FROM messages WHERE user_id = ? AND character_id = ? AND role = 'user' AND created_at > ?",
    userId,
    characterId,
    from,
  );
  const pending = Number(row?.n || 0);
  if (!lastAt) return pending >= 1 ? { ok: true, reason: 'first', from, pending } : { ok: false, reason: 'no_user_messages', pending: 0, from };
  if (pending >= EXTRACT_MIN_USER_MESSAGES) return { ok: true, reason: 'count', from, pending };
  if (pending >= 1 && now - lastAt >= EXTRACT_INTERVAL_MS) return { ok: true, reason: 'interval', from, pending };
  return { ok: false, reason: 'below_threshold', pending, from };
}

async function callExtraction(userId, characterId, { system, transcript, temperature = 0.3 }) {
  const result = await chatText(userId, {
    task: 'memory',
    json: true,
    temperature,
    maxTokens: 1400,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `对话如下：\n${transcript}` },
    ],
  });
  recordUsage({ userId, characterId, kind: 'memory', model: result.model, usage: result.usage, cost: result.cost });
  return result;
}

/**
 * 后台记忆抽取：结构化 JSON、失败重试一次、去重合并、补向量与关联。
 * LLM 不可用时返回 null（不向调度器抛错）。
 */
export async function runMemoryExtraction(job, payload = {}) {
  const ctx = jobContext(job, payload);
  const { userId, characterId, payload: body } = ctx;
  try {
    if (!userId || !characterId) {
      log.warn('记忆抽取缺少 userId/characterId，跳过', { userId, characterId });
      return { skipped: true, reason: 'missing_context' };
    }
    const settings = getSettings(characterId, userId) || {};
    if (settings.enabled === false) {
      log.debug('角色已关闭，跳过记忆抽取', { userId, characterId });
      return { skipped: true, reason: 'character_disabled', inserted: 0 };
    }
    if (limitState(userId).state === 'hard') {
      log.warn('硬限额中，跳过记忆抽取', { userId, characterId });
      return { skipped: true, reason: 'hard_limit', inserted: 0 };
    }
    const verdict = shouldRunExtraction(userId, characterId, {
      since: body.since,
      force: body.force === true,
    });
    if (!verdict.ok) return { skipped: true, reason: verdict.reason, pending: verdict.pending };

    const metaKey = `memory:since:${userId}:${characterId}`;
    const since = body.since || verdict.from || getMeta(metaKey, null) || new Date(Date.now() - 7 * 86400000).toISOString();
    const messages = recentMessages(userId, characterId, { limit: body.limit || 40, since });
    if (!messages.length) return { skipped: true, reason: 'no_messages', inserted: 0 };

    const transcript = messages
      .map((m) => `${m.role === 'user' ? '用户' : '角色'}：${truncate(m.content, 300)}`)
      .join('\n');

    let result = null;
    let parsed = null;
    try {
      result = await callExtraction(userId, characterId, { system: MEMORY_EXTRACT_SYSTEM, transcript });
      parsed = parseExtractionResult(result.text);
    } catch (err) {
      log.warn('记忆抽取调用失败，重试一次', err?.message);
    }
    if (!parsed) {
      try {
        result = await callExtraction(userId, characterId, { system: MEMORY_EXTRACT_RETRY, transcript, temperature: 0.1 });
        parsed = parseExtractionResult(result.text);
      } catch (err) {
        log.warn('记忆抽取重试失败', err?.message);
        return null;
      }
    }
    if (!parsed) {
      log.warn('记忆抽取返回非法 JSON，放弃本次', { userId, characterId });
      return null;
    }

    // 留档到独立系统会话
    appendSystemMessage(userId, characterId, {
      tag: 'memory',
      kind: 'memory',
      role: 'user',
      content: transcript.slice(-2000),
      meta: { kind: 'transcript', count: messages.length },
    });
    appendSystemMessage(userId, characterId, {
      tag: 'memory',
      kind: 'memory',
      role: 'system',
      content: JSON.stringify(parsed.raw).slice(0, 4000),
      meta: { kind: 'extract', items: parsed.items.length },
    });

    const items = parsed.items;
    let vectors = [];
    if (items.length) {
      try {
        const emb = await embed(
          userId,
          items.map((i) => `${i.big}/${i.small}：${i.content}${i.keywords?.length ? `｜${i.keywords.join('、')}` : ''}`),
        );
        vectors = emb.vectors || [];
        if (vectors.length) {
          recordUsage({ userId, characterId, kind: 'embedding', model: emb.model || 'embedding', usage: emb.usage || {} });
        }
      } catch (err) {
        log.warn('记忆向量生成失败，使用关键词兜底', err?.message);
      }
    }

    let inserted = 0;
    let merged = 0;
    let links = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const vec = vectors[i] && vectors[i].length ? vectors[i] : null;
      try {
        const res = upsertMemory(userId, characterId, item, vec);
        if (!res.memory) continue;
        if (res.merged) merged++;
        else inserted++;
        links += res.memory.linked || 0;
      } catch (err) {
        log.warn('记忆写入失败', err?.message);
      }
    }

    // 补历史记忆向量 + 补关联 + 时间衰减
    try {
      await backfillEmbeddings({ userId, characterId, limit: 12 });
    } catch (err) {
      log.debug('抽取后补向量失败', err?.message);
    }
    ensureMemoryLinks(userId, characterId, { limit: 40 });
    decayMemories(userId, characterId);

    const now = nowIso();
    setMeta(metaKey, now);
    setMeta(`memory:last_at:${userId}:${characterId}`, now);
    log.info('记忆抽取完成', { userId, characterId, inserted, merged, links, items: items.length });
    return { ok: true, inserted, merged, skipped: 0, links, items: items.length, since, until: now };
  } catch (err) {
    log.warn('记忆抽取失败', err?.message);
    return null;
  }
}

// ---------------------------------------------------------------- 向量补齐

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

/**
 * 为缺失 embedding 的记忆补向量（按用户分组调用嵌入服务），并补建关联。
 * 启动/抽取后调用；无嵌入服务时安全跳过。
 */
export async function backfillEmbeddings({ userId = null, characterId = null, limit = 24, batch = 16 } = {}) {
  const where = ['embedding IS NULL'];
  const params = [];
  if (userId) {
    where.push('user_id = ?');
    params.push(userId);
  }
  if (characterId) {
    where.push('character_id = ?');
    params.push(characterId);
  }
  const rows = all(
    `SELECT id, user_id, character_id, big, small, content FROM memories WHERE ${where.join(' AND ')} ORDER BY created_at ASC LIMIT ?`,
    ...params,
    limit,
  );
  if (!rows.length) return { scanned: 0, filled: 0, failed: 0 };
  let filled = 0;
  let failed = 0;
  for (const [owner, group] of groupBy(rows, (r) => r.user_id)) {
    for (let i = 0; i < group.length; i += batch) {
      const slice = group.slice(i, i + batch);
      try {
        const emb = await embed(owner, slice.map((r) => `${r.big}/${r.small}：${safeDecrypt(owner, r.content)}`));
        const vectors = emb.vectors || [];
        if (!vectors.length) throw new Error('empty vectors');
        recordUsage({ userId: owner, characterId: slice[0]?.character_id || null, kind: 'embedding', model: emb.model || 'embedding', usage: emb.usage || {} });
        for (let j = 0; j < slice.length; j++) {
          const vec = vectors[j];
          if (!vec || !vec.length) continue;
          run('UPDATE memories SET embedding = ? WHERE id = ?', vectorToBuffer(vec), slice[j].id);
          relinkMemory(owner, slice[j].id, { vector: vec });
          filled++;
        }
      } catch (err) {
        failed += slice.length;
        log.debug('补向量失败（可能未配置嵌入服务）', err?.message);
      }
    }
  }
  return { scanned: rows.length, filled, failed };
}

/** 启动用：按用户批量补向量（每次限少量，避免 4G 机器抖动） */
export async function backfillAllEmbeddings({ limitUsers = 3, perUser = 24 } = {}) {
  const users = all('SELECT DISTINCT user_id FROM memories WHERE embedding IS NULL LIMIT ?', limitUsers);
  const out = { users: users.length, filled: 0, failed: 0, scanned: 0 };
  for (const u of users) {
    const res = await backfillEmbeddings({ userId: u.user_id, limit: perUser });
    out.filled += res.filled;
    out.failed += res.failed;
    out.scanned += res.scanned;
  }
  return out;
}

// ---------------------------------------------------------------- 调度/对话线集成助手

/**
 * 兼容两种调用约定：
 *   handler(jobRow, payload)                 —— 直接调用（测试/内部）
 *   handler({ job, payload, userId, characterId }) —— ai/scheduler.js 的 contextOf
 */
export function jobContext(job, payload = {}) {
  const isCtx = Boolean(job && typeof job === 'object' && job.job && typeof job.job === 'object' && !job.user_id);
  const jobRow = (isCtx ? job.job : job) || {};
  const merged = { ...(isCtx ? job.payload || {} : {}), ...(payload || {}) };
  return {
    job: jobRow,
    payload: merged,
    userId: jobRow.user_id || (isCtx ? job.userId : null) || merged.userId || null,
    characterId: jobRow.character_id || (isCtx ? job.characterId : null) || merged.characterId || null,
  };
}

const recallCache = new Map();
const RECALL_CACHE_MS = 30_000;
const HOOK_INTERVAL_MS = 60_000;
const hookSeen = new Map();
const pendingJobTypes = new Set(['memory', 'memory_extract', 'memory_extraction']);

function pickRecallItems(userId, characterId, query, limit) {
  const all = listMemories(userId, characterId);
  if (!all.length) return { items: [], mode: 'empty' };
  const byWeight = [...all].sort((a, b) => b.weight - a.weight);
  const fallback = byWeight.slice(0, Math.min(RECALL_HIGH_WEIGHT, limit));
  let relevant = [];
  let mode = 'weight';
  if (query) {
    const needle = query.toLowerCase();
    relevant = all
      .filter((m) => `${m.big}/${m.small}/${m.content}`.toLowerCase().includes(needle))
      .slice(0, limit);
    if (relevant.length) mode = 'keyword';
  }
  const out = [];
  const seen = new Set();
  for (const m of [...relevant, ...fallback, ...byWeight]) {
    if (out.length >= limit) break;
    if (!m || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return { items: out, mode };
}

async function semanticRecall(userId, characterId, query, limit) {
  if (!query) return null;
  const cached = recallCache.get(`${userId}:${characterId}:${query.slice(0, 40)}`);
  const now = Date.now();
  if (cached && now - cached.at < RECALL_CACHE_MS) return cached.items;
  try {
    const res = await Promise.race([
      searchMemories(userId, characterId, query, { limit, threshold: RELATED_THRESHOLD }),
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 2000);
        timer.unref?.();
      }),
    ]);
    const items = res?.items?.length
      ? res.items.map((m) => ({ id: m.id, big: m.big, small: m.small, content: m.content, weight: m.weight, score: m.score }))
      : [];
    if (items.length) {
      recallCache.set(`${userId}:${characterId}:${query.slice(0, 40)}`, { at: now, items });
      if (recallCache.size > 300) recallCache.clear();
    }
    return items;
  } catch (err) {
    log.debug('语义召回失败，退回关键词/权重', err?.message);
    return null;
  }
}

/**
 * 供聊天主链路调用的记忆召回（chat.js 动态 import 本名字）。
 * 支持 recallForChat(userId, characterId, query, {limit}) 与对象形式。
 * 返回「大类/小类：内容」多行文本 + 今日日记密码上下文；命中记忆会回写访问权重。
 */
export async function recallForChat(a, b, c, d = {}) {
  try {
    const opts = a && typeof a === 'object' ? a : { ...(d || {}), userId: a, characterId: b, query: c };
    const userId = opts.userId || opts.user_id || null;
    const characterId = opts.characterId || opts.character_id || null;
    const query = String(opts.query ?? opts.q ?? '').trim();
    const limit = clamp(Number(opts.limit) || RECALL_K, 1, 30);
    if (!userId || !characterId) return '';

    const semantic = await semanticRecall(userId, characterId, query, limit);
    let items;
    let mode;
    if (semantic?.length) {
      const all = listMemories(userId, characterId);
      const byId = new Map(all.map((m) => [m.id, m]));
      const byWeight = [...all].sort((x, y) => y.weight - x.weight);
      const merged = [];
      const maxRelevant = Math.max(1, limit - RECALL_HIGH_WEIGHT);
      for (const hit of semantic) {
        if (merged.length >= maxRelevant) break;
        const m = byId.get(hit.id);
        if (m && !merged.some((x) => x.id === m.id)) merged.push(m);
      }
      // 高权重兜底：补足 top-k，保证每次注入都含最重的记忆
      for (const m of byWeight) {
        if (merged.length >= limit) break;
        if (!merged.some((x) => x.id === m.id)) merged.push(m);
      }
      items = merged.slice(0, limit);
      mode = 'semantic';
    } else {
      const picked = pickRecallItems(userId, characterId, query, limit);
      items = picked.items;
      mode = picked.mode;
    }

    for (const m of items) touchMemoryThrottled(m.id);
    scheduleBackgroundWork(userId, characterId);

    const lines = items
      .map((m) => `${m.big}/${m.small}：${truncate(String(m.content || '').replace(/\s+/g, ' '), 90)}`)
      .filter((line) => line.length > 4);
    const diary = diaryContextForChat(userId, characterId);
    if (diary) lines.push(diary);
    if (!lines.length) return '';
    log.debug('记忆召回', { userId, characterId, mode, count: items.length, diary: Boolean(diary) });
    return lines.join('\n');
  } catch (err) {
    log.debug('记忆召回失败', err?.message);
    return '';
  }
}

/** 对话线触发：画像判定 + 抽取排队（节流 60 秒，失败静默） */
function scheduleBackgroundWork(userId, characterId, now = Date.now()) {
  try {
    const key = `${userId}:${characterId}`;
    if (now - (hookSeen.get(key) || 0) < HOOK_INTERVAL_MS) return;
    hookSeen.set(key, now);
    if (hookSeen.size > 500) hookSeen.clear();

    import('./portrait.js')
      .then((mod) => {
        if (typeof mod.maybeTriggerPortrait === 'function') mod.maybeTriggerPortrait(userId, characterId, { now });
      })
      .catch((err) => log.debug('画像触发钩子失败', err?.message));

    if (!autoMemoryEnabled(userId)) return;
    const verdict = shouldRunExtraction(userId, characterId, { now });
    if (!verdict.ok) return;
    const pending = get(
      `SELECT id FROM jobs WHERE character_id = ? AND status = 'pending' AND type IN (${[...pendingJobTypes].map(() => '?').join(',')}) LIMIT 1`,
      characterId,
      ...pendingJobTypes,
    );
    if (pending) return;
    enqueue('memory_extract', new Date(now + 30_000), { characterId, since: verdict.from }, { userId, characterId });
    log.debug('已排队记忆抽取', { userId, characterId, reason: verdict.reason });
  } catch (err) {
    log.debug('后台记忆/画像排队失败', err?.message);
  }
}

function hasPendingMemoryJob(characterId) {
  return Boolean(
    get(
      `SELECT id FROM jobs WHERE character_id = ? AND status = 'pending' AND type IN (${[...pendingJobTypes].map(() => '?').join(',')}) LIMIT 1`,
      characterId,
      ...pendingJobTypes,
    ),
  );
}

/**
 * 记忆线的巡检入口：为所有活跃角色补排记忆抽取 / 画像 / 新闻 / 创作任务，并补 embedding。
 * 调度器每 N 轮调用一次即可（内部去重 + 节流，可重复调用）。
 */
export async function bootstrapAiMemoryJobs({ now = Date.now(), maxCharacters = 50, backfill = true } = {}) {
  const out = { characters: 0, memory: 0, portrait: 0, news: 0, creation: 0, embeddings: 0 };
  const rows = all(
    'SELECT id, user_id FROM characters WHERE archived = 0 ORDER BY created_at ASC LIMIT ?',
    maxCharacters,
  );
  out.characters = rows.length;
  const portraitMod = await import('./portrait.js').catch(() => null);
  const creationMod = await import('./creation.js').catch(() => null);
  for (const c of rows) {
    const { id: characterId, user_id: userId } = c;
    try {
      const limit = limitState(userId);
      if (limit.state === 'hard') continue;

      if (autoMemoryEnabled(userId)) {
        const verdict = shouldRunExtraction(userId, characterId, { now });
        if (verdict.ok && !hasPendingMemoryJob(characterId)) {
          enqueue('memory_extract', new Date(now), { characterId, since: verdict.from }, { userId, characterId });
          out.memory++;
        }
      }

      if (portraitMod?.maybeTriggerPortrait) {
        const r = portraitMod.maybeTriggerPortrait(userId, characterId, { now });
        if (r?.triggered) out.portrait++;
      }

      if (limit.state === 'soft') continue;

      const day = dayKey();
      const newsBook = get(
        "SELECT id FROM books WHERE user_id = ? AND character_id = ? AND type = 'news' AND day = ? LIMIT 1",
        userId,
        characterId,
        day,
      );
      const newsKey = `news:queued:${characterId}`;
      const lastNews = Date.parse(getMeta(newsKey, '') || 0) || 0;
      if (!newsBook && !nextJob(characterId, 'news') && now - lastNews > 4 * 3600_000) {
        enqueue('news', new Date(now), { characterId }, { userId, characterId });
        setMeta(newsKey, nowIso());
        out.news++;
      }

      const settings = getSettings(characterId, userId) || {};
      const diary = get(
        "SELECT id FROM books WHERE user_id = ? AND character_id = ? AND type = 'diary' AND day = ? LIMIT 1",
        userId,
        characterId,
        day,
      );
      const hourCst = new Date(now + 8 * 3600_000).getUTCHours();
      const creatKey = `creation:queued:${characterId}`;
      const lastCreat = Date.parse(getMeta(creatKey, '') || 0) || 0;
      if (!diary && hourCst >= 20 && !nextJob(characterId, 'creation') && now - lastCreat > 2 * 3600_000) {
        enqueue('creation', new Date(now), { characterId, type: 'diary' }, { userId, characterId });
        setMeta(creatKey, nowIso());
        out.creation++;
      } else if (settings.creationFrequency && settings.creationFrequency !== 'off' && creationMod?.creationDue) {
        const tags = Array.isArray(settings.creationTags) ? settings.creationTags : [];
        const type = tags.length ? 'novel' : 'essay';
        const last = get(
          'SELECT created_at FROM books WHERE user_id = ? AND character_id = ? AND type = ? ORDER BY created_at DESC LIMIT 1',
          userId,
          characterId,
          type,
        );
        const verdict = creationMod.creationDue(settings, { lastAt: last?.created_at || null, now });
        if (verdict.due && !nextJob(characterId, 'creation') && now - lastCreat > 30 * 60_000) {
          enqueue('creation', new Date(now), { characterId, type }, { userId, characterId });
          setMeta(creatKey, nowIso());
          out.creation++;
        }
      }
    } catch (err) {
      log.warn('记忆线巡检失败', characterId, err?.message);
    }
  }
  if (backfill) {
    try {
      const res = await backfillAllEmbeddings({});
      out.embeddings = res.filled;
    } catch (err) {
      log.debug('启动补向量失败', err?.message);
    }
  }
  return out;
}

export default {
  runMemoryExtraction,
  buildGraph,
  layout3D,
  memoryDetail,
  deleteMemory,
  searchMemories,
  insertMemory,
  upsertMemory,
  relinkMemory,
  linkMemory,
  limitState,
  recallForChat,
  autoMemoryEnabled,
  backfillEmbeddings,
  ensureDiaryCode,
  diaryContextForChat,
};
