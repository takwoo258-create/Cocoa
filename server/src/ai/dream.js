// 梦境生成（v2.0.0，需求书「模型分工·梦境生成」落地）
// - 角色入睡后在睡眠窗口内随机时刻于独立系统会话生成梦境；午睡 30% 概率短梦
// - 每段睡眠最多 1 梦（pending 去重）、每日最多 2 梦；软/硬限额跳过
// - 素材：当日对话 + 新闻感想 + 高权重记忆 + 当前状态；产出 type:"dream" JSON
// - 梦境入书架（type='dream'，不上锁），写入系统上下文（3 天过期）
// - 醒来后 2–10 分钟可能以主动消息向用户提起这场梦
import { get, all, run } from '../db/index.js';
import { nowIso, uuid, dayKey, truncate, clamp } from '../core/util.js';
import { encryptText, encryptJson, decryptText } from '../core/crypto.js';
import logger from '../core/logger.js';
import { getCharacter, ensureState } from '../services/characters.js';
import { enqueue, nextJob } from '../services/jobs.js';
import { isCharacterIdActive } from './activity.js';
import { limitState, ensureMainConversation, recentMessages } from './context.js';
import { appendSystemMessage, cleanupSystemContext, parseJsonLoose, jobContext } from './memory.js';
import { normalizeSleepState } from './status.js';
import { todayNewsDigest } from './news.js';
import { recordUsage } from './usage.js';
import { chatText as defaultChatText } from './provider.js';

const log = logger;

export const DREAM_MAX_PER_DAY = 2;
export const NAP_DREAM_CHANCE = 0.3;
const NIGHT_MAX_WINDOW_MS = 8 * 3600_000;
const NIGHT_MIN_DELAY_MS = 10 * 60_000;

export const DREAM_SYSTEM_PROMPT = [
  '你是角色的梦境。请基于素材写一场刚发生的梦：荒诞、变形、有画面感，情绪基调与角色当前状态呼应。',
  '要求：',
  '- 80–150 字，第一人称，像醒来后还记得的那样片段化',
  '- 可以扭曲地映射素材里的人、事、物，但禁止逐字复述聊天记录或新闻原文',
  '- 禁止色情、暴力、诱导未成年人等不良内容；政治敏感内容一律回避',
  '只输出一个 JSON 对象：{"type":"dream","content":"梦境叙事","mood":"情绪基调（如 温柔/怅然/雀跃）"}',
].join('\n');

/** 梦境时刻：夜间落在入睡与预计醒来之间（无作息时最多 8 小时）；午睡 5–40 分钟 */
export function dreamDueMs({ now = Date.now(), mode = 'sleeping', wakeAt = null, rng = Math.random } = {}) {
  const r = clamp(Number(rng()) || 0, 0, 1);
  if (mode === 'napping') return Math.round(now + (5 + r * 35) * 60_000);
  const wakeMs = wakeAt ? Date.parse(wakeAt) : NaN;
  const end = Number.isFinite(wakeMs) && wakeMs > now + NIGHT_MIN_DELAY_MS
    ? Math.min(wakeMs, now + NIGHT_MAX_WINDOW_MS)
    : now + NIGHT_MAX_WINDOW_MS;
  const start = now + NIGHT_MIN_DELAY_MS;
  return Math.round(start + r * Math.max(0, end - start));
}

function dreamsToday(userId, characterId, day = dayKey()) {
  const row = get(
    "SELECT COUNT(*) AS n FROM books WHERE user_id = ? AND character_id = ? AND type = 'dream' AND day = ?",
    userId, characterId, day,
  );
  return Number(row?.n || 0);
}

/**
 * 入睡转换时排期梦境。
 * @returns {{scheduled:boolean, jobId?:string, dueAt?:string, reason?:string}}
 */
export function scheduleDream({ userId, characterId, mode = 'sleeping', wakeAt = null, rng = Math.random, now = Date.now() } = {}) {
  if (!userId || !characterId) return { scheduled: false, reason: 'missing_context' };
  if (!isCharacterIdActive(userId, characterId)) return { scheduled: false, reason: 'character_disabled' };
  const limits = limitState(userId);
  if (limits.hardLimited) return { scheduled: false, reason: 'hard_limit' };
  if (mode === 'napping' && (Number(rng()) || 0) >= NAP_DREAM_CHANCE) return { scheduled: false, reason: 'nap_skip' };
  if (dreamsToday(userId, characterId) >= DREAM_MAX_PER_DAY) return { scheduled: false, reason: 'daily_cap' };
  if (nextJob(characterId, 'dream')) return { scheduled: false, reason: 'pending' };
  const due = dreamDueMs({ now, mode, wakeAt, rng });
  const dueAt = new Date(due).toISOString();
  const jobId = enqueue('dream', dueAt, { mode }, { userId, characterId });
  return { scheduled: true, jobId, dueAt };
}

function insertDreamBook(userId, characterId, { title, content, day, meta }) {
  const id = `bk_${uuid().replace(/-/g, '').slice(0, 16)}`;
  const now = nowIso();
  run(
    'INSERT INTO books(id, user_id, character_id, type, title, content, day, meta, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    id, userId, characterId, 'dream',
    encryptText(userId, title), encryptText(userId, content), day, encryptJson(userId, meta || {}), now, now,
  );
  return id;
}

/** 素材拼装：当日对话 + 新闻感想 + 高权重记忆 + 当前状态 */
export function dreamMaterials(userId, characterId) {
  const parts = [];
  const state = ensureState(characterId, userId);
  parts.push(`当前状态：动作「${state.motion}」，心情「${state.mood}」，健康「${state.health}」，心里想着「${truncate(state.psychology || '', 80)}」`);
  try {
    const conv = ensureMainConversation(userId, characterId);
    const recent = recentMessages(userId, conv.id, 16);
    const lines = recent
      .map((m) => {
        let text = '';
        try { text = decryptText(userId, m.content); } catch { /* 忽略损坏条目 */ }
        return `${m.role === 'user' ? '用户' : '我'}：${truncate(text, 100)}`;
      })
      .filter((s) => s.length > 4);
    if (lines.length) parts.push(`最近的对话：\n${lines.join('\n')}`);
  } catch { /* 无主会话时跳过 */ }
  try {
    const digest = todayNewsDigest(userId, characterId);
    if (Array.isArray(digest) && digest.length) {
      const text = digest.map((n) => `${n.title}：${truncate(n.content || '', 200)}`).join('\n');
      parts.push(`今天读到的新闻与感想：\n${truncate(text, 500)}`);
    }
  } catch { /* 新闻模块不可用时跳过 */ }
  try {
    const rows = all(
      'SELECT big, small, content, weight FROM memories WHERE user_id = ? AND character_id = ? ORDER BY weight DESC LIMIT 5',
      userId, characterId,
    );
    const mems = rows.map((r) => {
      let text = '';
      try { text = decryptText(userId, r.content); } catch { /* 忽略损坏条目 */ }
      return text ? `- [${r.big}/${r.small}] ${truncate(text, 80)}` : null;
    }).filter(Boolean);
    if (mems.length) parts.push(`印象最深的记忆：\n${mems.join('\n')}`);
  } catch { /* 记忆不可用时跳过 */ }
  return parts.join('\n\n');
}

/**
 * dream 任务处理器（scheduler 签名：(job, payload)）。
 * 生成梦境 → 书架 + 系统上下文 + 记账。
 */
export async function runDream(job, payload = {}) {
  const ctx = jobContext(job, payload);
  const userId = ctx.userId;
  const characterId = ctx.characterId;
  if (!userId || !characterId) return { ok: false, reason: 'missing_context', skipped: true };
  const mode = ctx.payload?.mode === 'napping' ? 'napping' : 'sleeping';

  const limits = limitState(userId);
  if (limits.hardLimited) return { ok: false, reason: 'hard_limit', skipped: true };
  if (limits.softLimited) return { ok: false, reason: 'soft_limit', skipped: true };

  const state = ensureState(characterId, userId);
  const sleepNow = normalizeSleepState(state.sleep_state) || 'awake';
  if (sleepNow !== mode) return { ok: false, reason: 'not_asleep', skipped: true };
  if (dreamsToday(userId, characterId) >= DREAM_MAX_PER_DAY) return { ok: false, reason: 'daily_cap', skipped: true };

  const character = getCharacter(userId, characterId);
  if (!character) return { ok: false, reason: 'character_not_found', skipped: true };

  try {
    const materials = dreamMaterials(userId, characterId);
    const provider = ctx.payload?.provider || { chatText: defaultChatText };
    const res = await provider.chatText(userId, {
      task: 'dream',
      temperature: 0.9,
      maxTokens: 400,
      thinking: false,
      json: true,
      messages: [
        { role: 'system', content: DREAM_SYSTEM_PROMPT },
        { role: 'user', content: `角色：${character.name}（${mode === 'napping' ? '午睡短梦' : '夜间梦境'}）\n\n${materials}` },
      ],
    });
    recordUsage({ userId, characterId, kind: 'dream', model: res?.model, usage: res?.usage || {}, cost: res?.cost });
    const parsed = parseJsonLoose(res?.text);
    const content = String(parsed?.content || res?.text || '').trim();
    const mood = String(parsed?.mood || '平静').trim() || '平静';
    if (!content) return { ok: false, reason: 'empty', skipped: true };

    const day = dayKey();
    const bookId = insertDreamBook(userId, characterId, {
      title: `梦境 · ${day}`,
      content: truncate(content, 600),
      day,
      meta: { mode, mood },
    });
    appendSystemMessage(userId, characterId, {
      tag: 'dream',
      kind: 'dream',
      role: 'system',
      content: `${mode === 'napping' ? '午睡时' : '昨晚'}的梦（${day}）：${truncate(content, 400)}（情绪基调：${mood}。你记得这场梦，可以自然地提起。）`,
      meta: { bookId, day, mode, mood },
    });
    cleanupSystemContext(userId, characterId, { days: 3 });
    log.info('梦境生成完成', { userId, characterId, bookId, mode, mood });
    return { ok: true, bookId, day, mode, mood };
  } catch (err) {
    log.warn('梦境生成失败', err?.message || err);
    return { ok: false, reason: 'generation_failed', error: err?.message || 'upstream_error' };
  }
}

/**
 * 醒来转换时排期「讲梦」主动消息（2–10 分钟后）。
 * @returns {{scheduled:boolean, jobId?:string, dueAt?:string, reason?:string}}
 */
export function planDreamMention({ userId, characterId, rng = Math.random, now = Date.now() } = {}) {
  if (!userId || !characterId) return { scheduled: false, reason: 'missing_context' };
  const row = get(
    "SELECT * FROM books WHERE user_id = ? AND character_id = ? AND type = 'dream' ORDER BY created_at DESC LIMIT 1",
    userId, characterId,
  );
  if (!row) return { scheduled: false, reason: 'no_dream' };
  // 只提起 36 小时内的梦
  if (now - Date.parse(row.created_at) > 36 * 3600_000) return { scheduled: false, reason: 'stale_dream' };
  let content = '';
  try { content = decryptText(userId, row.content); } catch { return { scheduled: false, reason: 'decrypt_failed' }; }
  if (!content) return { scheduled: false, reason: 'no_dream' };
  const delayMs = Math.round((2 + clamp(Number(rng()) || 0, 0, 1) * 8) * 60_000);
  const dueAt = new Date(now + delayMs).toISOString();
  const jobId = enqueue('active_reply', dueAt, { kind: 'dream_mention', dreamContent: content }, { userId, characterId });
  return { scheduled: true, jobId, dueAt };
}

export default { dreamDueMs, scheduleDream, runDream, planDreamMention, dreamMaterials, DREAM_MAX_PER_DAY, NAP_DREAM_CHANCE };