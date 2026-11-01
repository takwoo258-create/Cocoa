// 记忆域：用户特征抽取、嵌入向量、记忆关联图、语义检索
// 同时为本线（画像/新闻/创作）提供共用的：后台系统会话、限额判定、解密与提示词助手。
import { all, get, run, getMeta, setMeta, tx } from '../db/index.js';
import { encryptText, decryptText, encryptJson } from '../core/crypto.js';
import { nowIso, uuid, clamp, dayKey, truncate } from '../core/util.js';
import logger from '../core/logger.js';
import { chatText, embed } from './provider.js';
import { getPrefs } from '../services/settings.js';
import { enqueue, nextJob } from '../services/jobs.js';
import { usageTotals, recordUsage } from './usage.js';
import { getSettings } from '../services/characters.js';
import * as sharedPrompts from './prompts.js';

const log = logger;

/** 关联阈值：余弦相似度高于该值的记忆点用虚线相连 */
export const LINK_THRESHOLD = 0.82;
/** 处理画像/压缩时的统一提示语 */
export const MEMORY_NOTICE = '在回味之前的记忆喵~';
/** 记忆图配色提示（后端不返回节点颜色，仅给客户端参考） */
export const PALETTE_HINT = {
  agent: '#f3c17c',
  category: '#7fc8f8',
  subcategory: '#b7a6ff',
  memory: '#ffffff',
  dashed: '#ffffff66',
};
/** 抽取到的大类候选（模型可自拟，此处仅用于展示与兜底） */
export const MEMORY_CATEGORIES = ['喜好', '特长', '雷点', '经历', '关系', '习惯', '情绪', '画像'];

const MAX_LINK_SCAN = 400;
const GRAPH_PREVIEW = 400;

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

// ---------------------------------------------------------------- 记忆读写

export function shapeMemory(userId, row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    characterId: row.character_id,
    big: row.big,
    small: row.small,
    content: safeDecrypt(userId, row.content),
    weight: round4(row.weight),
    brightness: round4(row.weight),
    source: row.source || null,
    createdAt: row.created_at,
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
 * 写入一个记忆点（内容加密，向量以 Float32Array Buffer 存 BLOB）。
 * 关联建立后按「基础权重 + 关联加成」重算 weight，图中亮度 = weight。
 */
export function insertMemory(userId, characterId, data = {}) {
  const text = String(data.content ?? '').trim();
  if (!text) return null;
  if (!userId || !characterId) return null;
  const id = `mem_${uuid().replace(/-/g, '').slice(0, 16)}`;
  const big = cleanCategory(data.big, '其他');
  const small = cleanCategory(data.small, '其他');
  const base = clamp(Number(data.weight) || 0.5, 0, 1);
  const vec = Array.isArray(data.embedding) && data.embedding.length ? data.embedding.map(Number) : null;
  run(
    `INSERT INTO memories(id, user_id, character_id, big, small, content, weight, embedding, source, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    id,
    userId,
    characterId,
    big,
    small,
    encryptText(userId, text),
    round4(base),
    vec ? vectorToBuffer(vec) : null,
    String(data.source || 'chat'),
    nowIso(),
  );
  const linked = vec && data.link !== false ? linkMemory(userId, characterId, id, vec) : [];
  const finalWeight = weightWithLinks(base, linked.length);
  if (finalWeight !== round4(base)) run('UPDATE memories SET weight = ? WHERE id = ?', finalWeight, id);
  return { ...shapeMemory(userId, get('SELECT * FROM memories WHERE id = ?', id)), linked: linked.length };
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

/** 记忆详情：含大小类目、创建时间、关联列表（虚线关联的来源） */
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

// ---------------------------------------------------------------- 网状图

/**
 * 四层图：agent -> 大类目 -> 小类目 -> 记忆点
 * 类目层级连线 dashed=false；记忆点之间 dashed=true 并带 score。
 */
export function buildGraph(userId, characterId, characterName = '智能体') {
  const memories = listMemories(userId, characterId);
  const nodes = [{ id: 'agent', type: 'agent', label: String(characterName || '智能体'), weight: 1 }];
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
      label: entry.big,
      big: true,
      parent: 'agent',
      weight: avg(entry.weights),
      count: entry.weights.length,
    });
    links.push({ source: 'agent', target: bigId, dashed: false });
    const smallEntries = [...entry.smalls.entries()].sort((a, b) => avg(b[1].weights) - avg(a[1].weights));
    for (const [smallId, smallEntry] of smallEntries) {
      nodes.push({
        id: smallId,
        type: 'category',
        label: smallEntry.small,
        big: false,
        parent: bigId,
        weight: avg(smallEntry.weights),
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
      label: memoryLabel(content),
      preview: truncate(content, GRAPH_PREVIEW),
      weight: m.weight,
      brightness: m.weight,
      big: m.big,
      small: m.small,
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

  return {
    nodes,
    links,
    counts: {
      memories: memories.length,
      big: bigMap.size,
      small: [...bigMap.values()].reduce((n, e) => n + e.smalls.size, 0),
    },
    paletteHint: PALETTE_HINT,
  };
}

// ---------------------------------------------------------------- 检索

function keywordSearch(userId, characterId, q, limit) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return [];
  return listMemories(userId, characterId)
    .filter((m) => {
      const hay = `${m.content} ${m.big} ${m.small}`.toLowerCase();
      return hay.includes(needle);
    })
    .slice(0, limit)
    .map((m) => ({ ...m, score: 1, mode: 'keyword' }));
}

/**
 * 语义检索：有嵌入服务走 cosine；无 embedding key / 调用失败退化为 LIKE（加密后无法 SQL LIKE，改为解密后匹配）。
 */
export async function searchMemories(userId, characterId, query, { limit = 20 } = {}) {
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
  let items = scored.filter((s) => s.score > 0.2).slice(0, limit);
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
 * 这样既满足「另起一会话」，又不会把主会话上下文撑大。
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

// ---------------------------------------------------------------- 记忆抽取

const MEMORY_EXTRACT_FALLBACK = `你是用户特征抽取器。阅读对话，抽取用户明确表达或强烈暗示的、值得长期记住的个人特征。
类别示例：大类「喜好」「特长」「雷点」「经历」「关系」「习惯」「情绪」，小类自拟（2-4 字）。
只输出 JSON：
{"memories":[{"big":"喜好","small":"食物","content":"用户无辣不欢，尤其喜欢火锅","weight":0.8}]}
weight 0-1 表示重要程度；没有可记内容时输出 {"memories":[]}。不要编造，不要记录一次性寒暄。`;

/** 纯函数：解析并规整模型返回的记忆条目 */
export function parseMemoryItems(text) {
  const data = parseJsonLoose(text);
  const list = Array.isArray(data?.memories) ? data.memories : Array.isArray(data) ? data : [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const content = String(item.content ?? item.text ?? '').replace(/\s+/g, ' ').trim();
    if (content.length < 2) continue;
    out.push({
      big: cleanCategory(item.big ?? item.category, '其他'),
      small: cleanCategory(item.small ?? item.subcategory, '其他'),
      content: content.slice(0, 500),
      weight: clamp(Number(item.weight ?? 0.5) || 0.5, 0, 1),
    });
  }
  return out;
}

function isDuplicateMemory(userId, characterId, item, vectors) {
  const rows = all('SELECT content, embedding, big, small FROM memories WHERE user_id = ? AND character_id = ?', userId, characterId);
  const text = item.content.toLowerCase();
  for (const row of rows) {
    const existing = safeDecrypt(userId, row.content).trim().toLowerCase();
    if (existing === text) return true;
    if (existing.includes(text) || text.includes(existing)) return true;
    const other = bufferToVector(row.embedding);
    if (other && vectors) {
      const score = cosine(vectors, other);
      if (score > 0.94) return true;
    }
  }
  return false;
}

/**
 * 后台记忆抽取：把近期用户表达交给模型分类，写 memories + memory_links。
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
    if (limitState(userId).state === 'hard') {
      log.warn('硬限额中，跳过记忆抽取', { userId, characterId });
      return { skipped: true, reason: 'hard_limit', inserted: 0 };
    }

    const metaKey = `memory:since:${userId}:${characterId}`;
    const since = body.since || getMeta(metaKey, null) || new Date(Date.now() - 7 * 86400000).toISOString();
    const messages = recentMessages(userId, characterId, { limit: body.limit || 40, since });
    if (!messages.length) {
      log.debug('记忆抽取：没有新对话', { userId, characterId });
      return { skipped: true, reason: 'no_messages', inserted: 0 };
    }

    const transcript = messages
      .map((m) => `${m.role === 'user' ? '用户' : '角色'}：${truncate(m.content, 300)}`)
      .join('\n');
    const system = promptText('MEMORY_EXTRACT', MEMORY_EXTRACT_FALLBACK);
    const result = await chatText(userId, {
      task: 'memory',
      json: true,
      temperature: 0.3,
      maxTokens: 1200,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `对话如下：\n${transcript}` },
      ],
    });
    recordUsage({
      userId,
      characterId,
      kind: 'memory',
      model: result.model,
      usage: result.usage,
      cost: result.cost,
    });

    const items = parseMemoryItems(result.text);
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
      content: result.text.slice(0, 4000),
      meta: { kind: 'extract', items: items.length },
    });

    if (!items.length) {
      setMeta(metaKey, nowIso());
      return { ok: true, inserted: 0, skipped: 0, links: 0 };
    }

    let vectors = [];
    try {
      const emb = await embed(userId, items.map((i) => `${i.big}/${i.small}：${i.content}`));
      vectors = emb.vectors || [];
      if (vectors.length) {
        recordUsage({ userId, characterId, kind: 'embedding', model: emb.model || 'embedding', usage: emb.usage || {} });
      }
    } catch (err) {
      log.warn('记忆向量生成失败，仅写入文本', err?.message);
    }

    let inserted = 0;
    let skipped = 0;
    let links = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const vec = vectors[i] && vectors[i].length ? vectors[i] : null;
      if (isDuplicateMemory(userId, characterId, item, vec)) {
        skipped++;
        continue;
      }
      const row = insertMemory(userId, characterId, { ...item, embedding: vec, source: 'chat' });
      if (row) {
        inserted++;
        links += row.linked || 0;
      }
    }
    setMeta(metaKey, nowIso());
    log.info('记忆抽取完成', { userId, characterId, inserted, skipped, links });
    return { ok: true, inserted, skipped, links, since, until: nowIso() };
  } catch (err) {
    log.warn('记忆抽取失败', err?.message);
    return null;
  }
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
const HOOK_INTERVAL_MS = 5 * 60_000;
const hookSeen = new Map();

/**
 * 供聊天主链路调用的记忆召回（chat.js 会以 recallForChat/buildChatMemory/memoryContext/recall 之一探测）。
 * 关键词命中优先、其余按权重补足；不发起网络请求，保证回复延迟稳定。
 */
/**
 * 供聊天主链路调用的记忆召回（chat.js 动态 import 本名字）。
 * 两种调用约定都支持：
 *   recallForChat(userId, characterId, query, { limit })      —— 约定形式
 *   recallForChat({ userId, characterId, query, limit })      —— 对象形式
 * 优先语义检索（searchMemories），无嵌入服务/超时/空结果时退回「关键词 + 权重」。
 * 无结果返回 ''，任何异常都吞掉，绝不影响回复主链路。
 */
export async function recallForChat(a, b, c, d = {}) {
  try {
    const opts = a && typeof a === 'object' ? a : { ...(d || {}), userId: a, characterId: b, query: c };
    const userId = opts.userId || opts.user_id || null;
    const characterId = opts.characterId || opts.character_id || null;
    const query = String(opts.query ?? opts.q ?? '').trim();
    const limit = Math.max(1, Math.min(30, Number(opts.limit) || 8));
    if (!userId || !characterId) return '';

    const items = await resolveRecallItems(userId, characterId, query, limit);
    maybeScheduleBackgroundWork(userId, characterId);
    if (!items.length) return '';
    return items
      .map((m) => `${m.big}/${m.small}：${truncate(String(m.content || '').replace(/\s+/g, ' '), 90)}`)
      .filter((line) => line.length > 4)
      .join('\n');
  } catch (err) {
    log.debug('记忆召回失败', err?.message);
    return '';
  }
}

/** 语义优先、关键词兜底；语义调用最多等 2 秒，避免拖慢回复 */
async function resolveRecallItems(userId, characterId, query, limit) {
  if (query) {
    try {
      const res = await Promise.race([
        searchMemories(userId, characterId, query, { limit }),
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(null), 2000);
          timer.unref?.();
        }),
      ]);
      if (res?.items?.length) {
        return res.items.map((m) => ({ big: m.big, small: m.small, content: m.content }));
      }
    } catch (err) {
      log.debug('语义召回失败，退回关键词匹配', err?.message);
    }
  }
  const key = `${userId}:${characterId}`;
  const now = Date.now();
  const cached = recallCache.get(key);
  let rows;
  if (cached && now - cached.at < RECALL_CACHE_MS) {
    rows = cached.items;
  } else {
    rows = all(
      'SELECT big, small, content, weight FROM memories WHERE user_id = ? AND character_id = ? ORDER BY weight DESC LIMIT 200',
      userId,
      characterId,
    ).map((r) => ({
      big: r.big,
      small: r.small,
      content: safeDecrypt(userId, r.content),
      weight: Number(r.weight) || 0,
    }));
    recallCache.set(key, { at: now, items: rows });
    if (recallCache.size > 200) recallCache.clear();
  }
  if (!rows.length) return [];
  const needle = query.toLowerCase();
  const hits = needle
    ? rows.filter((m) => `${m.big}/${m.small}/${m.content}`.toLowerCase().includes(needle))
    : [];
  return [...hits, ...rows.filter((m) => !hits.includes(m))].slice(0, limit);
}

/** 对话线每轮回调一次：节流后触发画像判定与记忆抽取排队（失败静默） */
function maybeScheduleBackgroundWork(userId, characterId, now = Date.now()) {
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

    const metaKey = `memory:since:${userId}:${characterId}`;
    const since = getMeta(metaKey, null) || new Date(now - 86400000).toISOString();
    const row = get(
      "SELECT COUNT(*) n FROM messages WHERE user_id = ? AND character_id = ? AND role IN ('user','agent') AND created_at > ?",
      userId,
      characterId,
      since,
    );
    if ((row?.n || 0) >= 8 && !nextJob(characterId, 'memory')) {
      enqueue('memory', new Date(now), { characterId }, { userId, characterId });
      log.debug('已排队记忆抽取', { userId, characterId });
    }
  } catch (err) {
    log.debug('后台记忆/画像排队失败', err?.message);
  }
}

/**
 * 记忆线的巡检入口：为所有活跃角色补排记忆抽取 / 画像 / 新闻 / 创作任务。
 * 调度器每 N 轮调用一次即可（内部去重 + 节流，可重复调用）。
 */
export async function bootstrapAiMemoryJobs({ now = Date.now(), maxCharacters = 50 } = {}) {
  const out = { characters: 0, memory: 0, portrait: 0, news: 0, creation: 0 };
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

      // 记忆抽取
      const memKey = `memory:since:${userId}:${characterId}`;
      const since = getMeta(memKey, null) || new Date(now - 86400000).toISOString();
      const fresh = get(
        "SELECT COUNT(*) n FROM messages WHERE user_id = ? AND character_id = ? AND role IN ('user','agent') AND created_at > ?",
        userId,
        characterId,
        since,
      );
      if ((fresh?.n || 0) >= 8 && !nextJob(characterId, 'memory')) {
        enqueue('memory', new Date(now), { characterId }, { userId, characterId });
        out.memory++;
      }

      // 画像（内部有阈值与节流）
      if (portraitMod?.maybeTriggerPortrait) {
        const r = portraitMod.maybeTriggerPortrait(userId, characterId, { now });
        if (r?.triggered) out.portrait++;
      }

      if (limit.state === 'soft') continue;

      // 新闻：每天一次（同日已有记录或 4 小时内已排过则跳过）
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

      // 创作：日记每天一篇（20 点后），小说/文集按频率
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
  return out;
}


export default {
  runMemoryExtraction,
  buildGraph,
  memoryDetail,
  deleteMemory,
  searchMemories,
  insertMemory,
  linkMemory,
  limitState,
};
