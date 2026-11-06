// 主动回复与等待期（build.md 二.13/14、七.5）
// - 每条智能体消息发出后进入 60-80 秒随机等待（wait_states 持久化 + jobs 定时）
// - 超时后后台喂「用户未回复」，由模型判断是否追问；不追问则结束本次聊天并生成下一次主动消息
// - 角色处于午睡/夜间睡眠时返回固定文案；用户发送消息时由模型判断 wakeup 0/1
import { get, run } from '../db/index.js';
import { nowIso, randomInt, clamp } from '../core/util.js';
import { broadcast } from '../realtime/hub.js';
import { getCharacter, ensureState, updateState, getSettings } from '../services/characters.js';
import { enqueue, cancelJobs } from '../services/jobs.js';
import { getPrefs } from '../services/settings.js';
import { recordUsage } from './usage.js';
import { parseReply, clampSendSec } from './reply.js';
import { limitState } from './context.js';
import { effectiveSleep, sleepMode } from './status.js';
import { isCharacterIdActive } from './activity.js';
import logger from '../core/logger.js';

// v1.5.0：回复后等待 90 秒起；下一次由模型 timesec 决定
/** timesec 归一化为秒：1-86400，缺省回退 90；误传毫秒时自动折算 */
export function normalizeTimesec(value, fallbackSec = 90) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallbackSec;
  const seconds = n > 86_400 && n <= 86_400_000 ? n / 1000 : n;
  return Math.min(86_400, Math.max(1, Math.round(seconds)));
}

/** timesec → 下一次等待的毫秒数（due = now + timesec*1000） */
export function timesecToDelayMs(value, fallbackSec = 90) {
  return normalizeTimesec(value, fallbackSec) * 1000;
}

export const WAIT_MIN_MS = 90_000;
export const WAIT_MAX_MS = 120_000;

export const TIMEOUT_INSTRUCTION = [
  '系统提示：用户已经超过等待期仍未回复（这条后台消息的内容是：用户未回复）。',
  '请判断这次聊天是否适合继续追问，并用 timesec 指定下一次追问/主动消息的间隔（秒）：',
  '- 很适合追问、答案对角色重要：timesec 取 60-120；',
  '- 不太重要：timesec 取 600-1800；',
  '- 有新闻/生活话题想分享：可以任意更久。',
  '- 适合追问：{"type":"message","content":"一句简短自然的追问","timesec":<秒>}；',
  '- 不适合追问：{"type":"subjective","content":"下一次主动发出的消息","timesec":<秒>}。',
  'sendsec 仍兼容，作为 timesec 的别名。只输出一个 JSON 对象。',
].join('\n');

export const ACTIVE_INSTRUCTION = [
  '系统提示：现在由你主动开启一段对话。',
  '请结合人设、当前状态、最近的聊天内容与记忆，写一条自然、简短、有生活气息的主动消息。',
  '只输出 {"type":"subjective","content":"主动消息内容","sendsec":0}。',
].join('\n');

// ---------------- wait_states ----------------

export function getWaitState(userId, characterId) {
  return (
    get('SELECT * FROM wait_states WHERE user_id = ? AND character_id = ?', userId, characterId) || null
  );
}

function upsertWaitState({ userId, characterId, mode, lastAgentAt = null, deadline = null, attempts = null }) {
  const existing = getWaitState(userId, characterId);
  const now = nowIso();
  if (existing) {
    run(
      'UPDATE wait_states SET mode = ?, last_agent_at = ?, deadline = ?, attempts = ?, updated_at = ? WHERE user_id = ? AND character_id = ?',
      mode,
      lastAgentAt == null ? existing.last_agent_at : lastAgentAt,
      deadline,
      attempts == null ? existing.attempts : attempts,
      now,
      userId,
      characterId,
    );
  } else {
    run(
      'INSERT INTO wait_states(user_id, character_id, mode, last_agent_at, deadline, attempts, updated_at) VALUES(?,?,?,?,?,?,?)',
      userId,
      characterId,
      mode,
      lastAgentAt,
      deadline,
      attempts == null ? 0 : attempts,
      now,
    );
  }
  return getWaitState(userId, characterId);
}

/** 60-80 秒随机等待（含端点） */
export function nextWaitMs(randomFn = null) {
  if (typeof randomFn === 'function') {
    return WAIT_MIN_MS + Math.round(clamp(Number(randomFn()) || 0, 0, 1) * (WAIT_MAX_MS - WAIT_MIN_MS));
  }
  return randomInt(WAIT_MIN_MS, WAIT_MAX_MS);
}

export function activeReplyEnabled(userId, character) {
  try {
    if (getPrefs(userId).activeReply === false) return false;
  } catch {
    /* 配置读取失败时按开启处理 */
  }
  if (character?.settings?.activeReply === false) return false;
  return true;
}

/**
 * 智能体消息发出后调用：写入 wait_states 并排一个 active_reply 任务。
 * @returns {{scheduled:boolean, delayMs?:number, deadline?:string, jobId?:string, reason?:string}}
 */
export function markAgentSent({ userId, characterId, delayMs = null } = {}) {
  if (!isCharacterIdActive(userId, characterId)) {
    return { scheduled: false, reason: 'character_disabled' };
  }
  const character = getCharacter(userId, characterId);
  if (!activeReplyEnabled(userId, character)) {
    upsertWaitState({ userId, characterId, mode: 'idle', deadline: null, attempts: 0 });
    return { scheduled: false, reason: 'disabled' };
  }
  const ms = delayMs == null ? nextWaitMs() : Math.max(1_000, Math.round(delayMs));
  const now = nowIso();
  const deadline = new Date(Date.now() + ms).toISOString();
  upsertWaitState({ userId, characterId, mode: 'waiting', lastAgentAt: now, deadline, attempts: 0 });
  cancelJobs(characterId, 'active_reply');
  const jobId = enqueue('active_reply', deadline, { kind: 'wait_timeout' }, { userId, characterId });
  return { scheduled: true, delayMs: ms, deadline, jobId };
}

/** 用户发来消息：结束等待期，取消尚未发送的主动消息 */
export function markUserReplied({ userId, characterId } = {}) {
  upsertWaitState({ userId, characterId, mode: 'idle', deadline: null, attempts: 0 });
  cancelJobs(characterId, 'active_reply');
  return getWaitState(userId, characterId);
}

// ---------------- 任务处理 ----------------

async function sendSubjective({ userId, characterId, content, sendsec = 0 }) {
  const { deliverSubjective } = await import('./chat.js');
  return deliverSubjective({ userId, characterId, content, sendsec });
}

/** 处理 active_reply 任务（wait_timeout / subjective_send） */
export async function handleActiveReplyJob({ userId, characterId, payload = {}, provider = null } = {}) {
  const kind = payload.kind || 'wait_timeout';
  if (kind === 'subjective') {
    // 任务到点即发送：sendsec 在入队时已折算进 due_at，这里必须立即发，避免再次延迟
    return sendSubjective({ userId, characterId, content: payload.content, sendsec: 0 });
  }
  return handleWaitTimeout({ userId, characterId, provider });
}

/** 等待期超时：喂「用户未回复」，由模型决定追问或结束本次聊天 */
export async function handleWaitTimeout({ userId, characterId, provider = null } = {}) {
  const ws = getWaitState(userId, characterId);
  if (!ws || ws.mode !== 'waiting') return { ok: false, reason: 'not_waiting' };

  if (ws.deadline && new Date(ws.deadline).getTime() > Date.now() + 1_000) {
    // 任务提前触发：按原 deadline 重新排队
    enqueue('active_reply', ws.deadline, { kind: 'wait_timeout' }, { userId, characterId });
    return { ok: false, reason: 'not_due' };
  }

  const lastUser = get(
    "SELECT created_at FROM messages WHERE user_id = ? AND character_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1",
    userId,
    characterId,
  );
  if (lastUser && ws.last_agent_at && lastUser.created_at >= ws.last_agent_at) {
    markUserReplied({ userId, characterId });
    return { ok: false, reason: 'user_replied' };
  }

  if (!isCharacterIdActive(userId, characterId)) {
    markUserReplied({ userId, characterId });
    return { ok: false, reason: 'character_disabled' };
  }
  const limits = limitState(userId);
  if (limits.hardLimited) {
    markUserReplied({ userId, characterId });
    broadcast(userId, { type: 'notice', content: 'Token 已达硬性限额，角色服务已暂停' });
    return { ok: false, reason: 'hard_limit' };
  }

  const character = getCharacter(userId, characterId);
  if (!character) {
    markUserReplied({ userId, characterId });
    return { ok: false, reason: 'character_not_found' };
  }

  const attempts = (Number(ws.attempts) || 0) + 1;
  upsertWaitState({ userId, characterId, mode: 'waiting', deadline: null, attempts });

  // 多次追问无果：写入记忆点、影响心情/态度，再发角色想说的话
  if (attempts >= 3) {
    try {
      const memory = await import('./memory.js');
      memory.insertMemory(userId, characterId, {
        big: '关系',
        small: '主动回应',
        content: '用户多次没有回复角色的主动关心，角色有些失落，但也更在意对方现在的状况。',
        weight: 0.6,
        source: 'active_reply',
      });
    } catch (err) {
      logger.warn('追问无果记忆写入失败', err?.message || err);
    }
    try {
      updateState(characterId, { mood: '有点失落', psychology: '在意对方怎么一直没有回音' });
      const stateRow = ensureState(characterId, userId);
      broadcast(userId, {
        type: 'state',
        characterId,
        state: {
          motion: stateRow.motion,
          psychology: stateRow.psychology,
          mood: stateRow.mood,
          health: stateRow.health,
          sleepState: stateRow.sleep_state,
          updatedAt: nowIso(),
        },
      });
    } catch (err) {
      logger.warn('追问无果状态更新失败', err?.message || err);
    }
    try {
      const { runGeneration } = await import('./chat.js');
      const out = await runGeneration({
        userId,
        characterId,
        reason: 'active_timeout',
        provider,
        triggerText: '',
        extraInstruction:
          '系统提示：你已经多次主动关心用户但对方一直没有回复。请不要再连续追问，写一句你此刻真正想对用户说的话（可以是关心、失落或留个台阶），按 {"type":"message","content":"...","timesec":<秒>} 输出。',
      });
      return { ok: true, attempts, memoryWritten: true, ...out };
    } catch (err) {
      logger.warn('追问无果后的收尾失败', err?.message || err);
      return { ok: false, reason: 'generation_failed', attempts, error: err?.message || 'upstream_error' };
    }
  }

  try {
    const { runGeneration } = await import('./chat.js');
    const out = await runGeneration({
      userId,
      characterId,
      reason: 'active_timeout',
      provider,
      triggerText: '',
      extraInstruction: TIMEOUT_INSTRUCTION,
    });
    return { ok: true, attempts, ...out };
  } catch (err) {
    logger.warn('等待期处理失败', err?.message || err);
    return { ok: false, reason: 'generation_failed', error: err?.message || 'upstream_error' };
  }
}

/** POST /active-reply：立刻生成一条主动消息 */
export async function triggerActiveReply({ userId, characterId, provider = null } = {}) {
  if (!isCharacterIdActive(userId, characterId)) return { ok: false, reason: 'character_disabled' };
  const limits = limitState(userId);
  if (limits.hardLimited) return { ok: false, reason: 'hard_limit', notice: 'Token 已达硬性限额，角色服务已暂停' };
  const character = getCharacter(userId, characterId);
  if (!character) return { ok: false, reason: 'character_not_found' };
  try {
    const { runGeneration } = await import('./chat.js');
    const out = await runGeneration({
      userId,
      characterId,
      reason: 'active_reply',
      provider,
      triggerText: '',
      extraInstruction: ACTIVE_INSTRUCTION,
    });
    return { ok: true, ...out };
  } catch (err) {
    logger.warn('主动回复生成失败', err?.message || err);
    return { ok: false, reason: 'generation_failed', error: err?.message || 'upstream_error' };
  }
}

// ---------------- 唤醒 ----------------

export const WAKEUP_PROMPT = [
  '你在判断角色是否要为用户醒来。',
  '角色当前正在午睡或夜间睡眠。用户发来了消息（可能只有图片/语音，没有文字）。',
  '判断用户这句话是否值得叫醒角色：',
  '- 有明确求助、急事、重要约定、情绪明显需要陪伴 → 1',
  '- 只是打招呼、闲聊、可以等 → 0',
  '只输出一个 JSON 对象：{"type":"wakeup","wakeup":0 或 1}。',
].join('\n');

export const WAKEUP_REPLY_INSTRUCTION =
  '系统提示：你被用户强行叫醒了。请带着刚睡醒的状态自然回应用户这句消息（可以有一点困倦或抱怨，但不要生硬）。按正常被动回复 JSON 输出。';

/**
 * 模型判断 wakeup 0/1；1 时调整角色状态并生成回复。
 * @returns {Promise<{ok:boolean, wakeup:0|1, reason?:string, error?:string}>}
 */
export async function judgeWakeup({ userId, characterId, text = '', provider = null } = {}) {
  if (!isCharacterIdActive(userId, characterId)) return { ok: false, wakeup: 0, reason: 'character_disabled' };
  const prov = provider || (await import('./chat.js')).getChatProvider();
  const character = getCharacter(userId, characterId);
  if (!character) return { ok: false, wakeup: 0, reason: 'character_not_found' };
  const state = ensureState(characterId, userId);
  const now = new Date();
  const computed = effectiveSleep(character, state, now);
  if (computed.mode === 'awake' && !computed.override) {
    return { ok: true, wakeup: 1, reason: 'already_awake' };
  }

  try {
    const res = await prov.chatText(userId, {
      task: 'main',
      temperature: 0.2,
      maxTokens: 80,
      thinking: false,
      json: true,
      messages: [
        { role: 'system', content: WAKEUP_PROMPT },
        {
          role: 'user',
          content: `角色：${character.name}\n当前：${computed.mode === 'nap' ? '午睡' : '夜间睡眠'}\n用户消息：${String(text || '（没有文字，只有媒体）')}`,
        },
      ],
    });
    recordUsage({ userId, characterId, kind: 'wakeup', model: res?.model, usage: res?.usage || {}, cost: res?.cost });
    const parsed = parseReply(res?.text ?? '', { segmentEnabled: false });
    const wakeup = parsed.type === 'wakeup' ? parsed.wakeup : 0;
    if (wakeup !== 1) return { ok: true, wakeup: 0, reason: 'keep_sleeping' };

    updateState(characterId, { sleepState: 'awake' });
    broadcast(userId, {
      type: 'state',
      state: {
        ...state,
        sleepState: 'awake',
        updatedAt: nowIso(),
      },
    });

    const { runGeneration } = await import('./chat.js');
    await runGeneration({
      userId,
      characterId,
      reason: 'wakeup',
      provider,
      triggerText: text,
      extraInstruction: WAKEUP_REPLY_INSTRUCTION,
      thinking: false,
    });
    return { ok: true, wakeup: 1 };
  } catch (err) {
    logger.warn('唤醒判断失败', err?.message || err);
    return { ok: false, wakeup: 0, reason: 'model_failed', error: err?.message || 'upstream_error' };
  }
}

export default {
  nextWaitMs,
  normalizeTimesec,
  timesecToDelayMs,
  markAgentSent,
  markUserReplied,
  getWaitState,
  handleActiveReplyJob,
  handleWaitTimeout,
  triggerActiveReply,
  judgeWakeup,
  activeReplyEnabled,
};
