// 上下文占用与主会话管理
// - token 估算：中文≈字符数*0.9，英文≈字符数/4，图片/语音描述按普通文本计入
// - 主会话（kind='main'）永不复用错乱：同一角色同一用户只有一条活跃主会话
// - 后台会话（kind='background'）承载状态刷新等系统消息，不污染聊天上下文
// - 压缩后上下文 = 摘要 + 最近未被摘要的消息
import { all, get, run } from '../db/index.js';
import { decryptText, decryptJson } from '../core/crypto.js';
import { nowIso, uuid, clamp } from '../core/util.js';
import { getPrefs } from '../services/settings.js';
import { resolveModel } from './provider.js';
import { contextWindowFor } from './models.js';
import { usageTotals } from './usage.js';

export const KEEP_RECENT_DEFAULT = 12;
export const COMPRESS_THRESHOLD = 0.85;

const CJK_RE = /[\u2e80-\u2eff\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

/** 估算单段文本 token：中文按 0.9/字，其余（含空白）按 1/4 字符 */
export function estimateTextTokens(input) {
  if (input == null) return 0;
  const s = typeof input === 'string' ? input : String(input);
  if (!s) return 0;
  let cjk = 0;
  for (const ch of s) if (CJK_RE.test(ch)) cjk++;
  return Math.ceil(cjk * 0.9 + (s.length - cjk) / 4);
}

/** 估算消息数组 token（content 可为字符串或多模态 part 数组） */
export function estimateMessagesTokens(messages = []) {
  let total = 0;
  for (const m of messages) {
    const c = m?.content;
    if (typeof c === 'string') total += estimateTextTokens(c);
    else if (Array.isArray(c)) {
      for (const part of c) {
        if (part?.type === 'text') total += estimateTextTokens(part.text);
        else if (part?.type === 'image_url') total += 85; // 图片按固定视觉 token 粗略计入
      }
    }
  }
  return total;
}

/**
 * 上下文上限优先级（v1.0.1）：
 *   prefs.contextLimits[主模型] > prefs.contextLimits[characterId] > prefs.contextLimits.default > 模型内置窗口
 */
export function contextLimitFor(userId, characterId = null) {
  const prefs = getPrefs(userId);
  const model = resolveModel(userId, 'main');
  const limits = prefs.contextLimits || {};
  const candidates = [limits[model], characterId ? limits[characterId] : undefined, limits.default];
  for (const raw of candidates) {
    const candidate = Number(raw);
    if (Number.isFinite(candidate) && candidate > 0) return Math.round(candidate);
  }
  return contextWindowFor(model) || 32_768;
}

function newConversationId(prefix = 'cv') {
  return `${prefix}_${uuid().replace(/-/g, '').slice(0, 16)}`;
}

/** 取（或创建）主会话；上下文满了通过压缩继续，不新建主会话（build.md 四） */
export function ensureMainConversation(userId, characterId) {
  let conv = get(
    "SELECT * FROM conversations WHERE user_id = ? AND character_id = ? AND kind = 'main' AND active = 1 ORDER BY created_at DESC LIMIT 1",
    userId,
    characterId,
  );
  const limit = contextLimitFor(userId, characterId);
  if (conv) {
    if (Number(conv.context_limit) !== limit) {
      run('UPDATE conversations SET context_limit = ? WHERE id = ?', limit, conv.id);
      conv = { ...conv, context_limit: limit };
      // 上限变化后按新口径重算占用（摘要 + 未压缩消息）
      try {
        refreshConversationUsage(conv.id);
      } catch {
        /* 占用刷新失败不影响主链路 */
      }
    }
    return conv;
  }
  const id = newConversationId('cv');
  const now = nowIso();
  run(
    `INSERT INTO conversations(id, character_id, user_id, kind, title, created_at, updated_at, token_used, context_limit, active)
     VALUES(?,?,?,'main',?,?,?,0,?,1)`,
    id,
    characterId,
    userId,
    '主会话',
    now,
    now,
    limit,
  );
  return get('SELECT * FROM conversations WHERE id = ?', id);
}

/** 后台会话：状态刷新等系统行为写入，不进入主会话上下文 */
export function ensureBackgroundConversation(userId, characterId) {
  let conv = get(
    "SELECT * FROM conversations WHERE user_id = ? AND character_id = ? AND kind = 'background' AND active = 1 ORDER BY created_at DESC LIMIT 1",
    userId,
    characterId,
  );
  if (conv) return conv;
  const id = newConversationId('cb');
  const now = nowIso();
  run(
    `INSERT INTO conversations(id, character_id, user_id, kind, title, created_at, updated_at, token_used, context_limit, active)
     VALUES(?,?,?,'background',?,?,?,0,?,1)`,
    id,
    characterId,
    userId,
    '后台会话',
    now,
    now,
    contextLimitFor(userId, characterId),
  );
  return get('SELECT * FROM conversations WHERE id = ?', id);
}

export function getConversation(conversationId) {
  return get('SELECT * FROM conversations WHERE id = ?', conversationId) || null;
}

function safeDecrypt(userId, blob) {
  try {
    return decryptText(userId, blob);
  } catch {
    return '';
  }
}

/** 消息行解密为对外结构 */
export function shapeMessage(userId, row) {
  if (!row) return null;
  const meta = row.meta ? decryptJson(userId, row.meta, null) : null;
  return {
    id: row.id,
    role: row.role,
    kind: row.kind,
    content: safeDecrypt(userId, row.content),
    createdAt: row.created_at,
    meta: meta && typeof meta === 'object' ? meta : null,
  };
}

/** 未压缩的消息（用于喂模型；已摘要的早期消息不再重复进入上下文） */
export function recentMessages(userId, conversationId, limit = 30) {
  const rows = all(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC',
    conversationId,
  );
  const out = [];
  for (const row of rows) {
    const meta = row.meta ? decryptJson(userId, row.meta, null) : null;
    if (meta && meta.summarized) continue;
    out.push(row);
  }
  return out.slice(-Math.max(1, limit));
}

/** 把未压缩消息映射为 OpenAI messages */
export function promptHistory(userId, conversationId, limit = 30) {
  const rows = recentMessages(userId, conversationId, limit);
  const out = [];
  for (const row of rows) {
    if (row.role === 'user') out.push({ role: 'user', content: safeDecrypt(userId, row.content) });
    else if (row.role === 'agent') out.push({ role: 'assistant', content: safeDecrypt(userId, row.content) });
    // system/status 消息属于后台会话，通常不会出现在这里
  }
  return out;
}

/** 当前有效上下文占用（摘要 + 未被摘要的消息）；不写库 */
export function conversationTokenUsed(conv) {
  if (!conv) return 0;
  let used = conv.summary ? estimateTextTokens(safeDecrypt(conv.user_id, conv.summary)) : 0;
  const rows = all('SELECT content, meta FROM messages WHERE conversation_id = ? ORDER BY created_at ASC', conv.id);
  for (const row of rows) {
    const meta = row.meta ? decryptJson(conv.user_id, row.meta, null) : null;
    if (meta && meta.summarized) continue;
    used += estimateTextTokens(safeDecrypt(conv.user_id, row.content));
  }
  return used;
}

/** 重算并回写 conversations.token_used */
export function refreshConversationUsage(conversationId) {
  const conv = getConversation(conversationId);
  if (!conv) return 0;
  const used = conversationTokenUsed(conv);
  run('UPDATE conversations SET token_used = ? WHERE id = ?', used, conversationId);
  return used;
}

const compressingConversations = new Set();

export function setCompressing(conversationId, on = true) {
  if (!conversationId) return;
  if (on) compressingConversations.add(conversationId);
  else compressingConversations.delete(conversationId);
}

export function isCompressing(conversationId) {
  return compressingConversations.has(conversationId);
}

export function clearCompressing() {
  compressingConversations.clear();
}

/**
 * Token 限额状态（build.md 七.5）：
 * - 硬限额：停止主会话、创作与所有角色服务（进行中的等待生成完成后再停）
 * - 软限额：停创作与新闻，仅保留会话与状态刷新，状态刷新降到 4 小时一次
 */
export function limitState(userId) {
  const prefs = getPrefs(userId);
  const totals = usageTotals(userId);
  const total = Number(totals.input || 0) + Number(totals.output || 0);
  const enabled = prefs.limits?.enabled !== false;
  const hard = Number(prefs.limits?.hardTokens || 0);
  const soft = Number(prefs.limits?.softTokens || 0);
  return {
    total,
    hard,
    soft,
    enabled,
    hardLimited: enabled && hard > 0 && total >= hard,
    softLimited: enabled && soft > 0 && total >= soft,
    prefs,
  };
}

/** 调试/接口用占用信息 */
export function usageInfo(userId, characterId) {
  const conv = ensureMainConversation(userId, characterId);
  const used = refreshConversationUsage(conv.id);
  const limit = Number(conv.context_limit) || 0;
  const ratio = limit > 0 ? used / limit : 0;
  return {
    used,
    limit,
    percent: Math.min(1, Math.round(ratio * 1000) / 1000),
    ratio: Math.round(ratio * 1000) / 1000,
    compressing: isCompressing(conv.id),
    conversationId: conv.id,
    summary: Boolean(conv.summary),
    threshold: COMPRESS_THRESHOLD,
  };
}

/** 是否达到压缩阈值（默认 85%） */
export function overThreshold(userId, characterId, threshold = COMPRESS_THRESHOLD) {
  const info = usageInfo(userId, characterId);
  return info.limit > 0 && info.ratio >= threshold;
}

/** 历史消息分页（解密、按时间正序） */
export function listMessages({ userId, characterId, before = null, limit = 50, conversationId = null }) {
  const conv = conversationId ? getConversation(conversationId) : ensureMainConversation(userId, characterId);
  if (!conv) return { items: [], total: 0, page: 1, size: 0, hasMore: false };
  const size = clamp(Number(limit) || 50, 1, 200);
  let cursor = before ? String(before) : null;
  if (cursor) {
    const byId = get('SELECT created_at FROM messages WHERE id = ? AND conversation_id = ?', cursor, conv.id);
    if (byId) cursor = byId.created_at;
  }
  const rows = cursor
    ? all(
        'SELECT * FROM messages WHERE conversation_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?',
        conv.id,
        cursor,
        size,
      )
    : all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?', conv.id, size);
  const items = rows.slice().reverse().map((row) => shapeMessage(userId, row));
  const total = Number(get('SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?', conv.id)?.c || 0);
  return { items, total, page: 1, size, hasMore: rows.length >= size, conversationId: conv.id };
}

export default {
  estimateTextTokens,
  estimateMessagesTokens,
  contextLimitFor,
  ensureMainConversation,
  ensureBackgroundConversation,
  getConversation,
  shapeMessage,
  recentMessages,
  promptHistory,
  conversationTokenUsed,
  refreshConversationUsage,
  usageInfo,
  overThreshold,
  listMessages,
  setCompressing,
  isCompressing,
  limitState,
};
