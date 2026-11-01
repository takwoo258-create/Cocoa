// 角色状态与作息（build.md 二.7/8/14、七.5）
// - 每 10 分钟（软限额时 4 小时一次）结合人设与世界状况请求 status JSON，updateState + WS {type:'state'}
// - 健康/心情异常：state 上标注 flags，并写 messages.kind='status'（meta.flags 加密，统计依赖此约定）
// - 作息：按 character.settings.sleep（UTC+8）判断 sleeping/napping，命中时返回固定文案
import { all, run } from '../db/index.js';
import { nowIso, uuid } from '../core/util.js';
import { encryptText, encryptJson } from '../core/crypto.js';
import { broadcast } from '../realtime/hub.js';
import { getCharacter, getSettings, ensureState, updateState } from '../services/characters.js';
import { enqueue, cancelJobs, nextJob } from '../services/jobs.js';
import { recordUsage } from './usage.js';
import { parseReply } from './reply.js';
import { ensureBackgroundConversation, limitState } from './context.js';
import * as defaultProvider from './provider.js';
import logger from '../core/logger.js';

export const SLEEP_SUFFIX = '若强行叫醒的话，可能会带来不必要的麻烦哦';
export const STATUS_HARD_RETRY_MS = 60 * 60_000;

// ---------------- 作息 ----------------

/** UTC+8 时间分量 */
export function tzParts(date = new Date()) {
  const shifted = new Date(date.getTime() + 8 * 3600_000);
  const hours = shifted.getUTCHours();
  const minutes = shifted.getUTCMinutes();
  return {
    day: shifted.toISOString().slice(0, 10),
    hours,
    minutes,
    hhmm: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`,
    minutesOfDay: hours * 60 + minutes,
  };
}

/** "HH:MM" → 当日分钟数；非法返回 null */
export function parseHm(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/** [start, end) 支持跨零点 */
export function inTimeWindow(nowMinutes, start, end) {
  const s = parseHm(start);
  const e = parseHm(end);
  if (s == null || e == null || s === e) return false;
  if (s < e) return nowMinutes >= s && nowMinutes < e;
  return nowMinutes >= s || nowMinutes < e;
}

/**
 * @returns {{mode:'awake'|'nap'|'sleep', hhmm:string, day:string}}
 */
export function sleepMode(settings, date = new Date()) {
  const parts = tzParts(date);
  const sleep = settings?.sleep || {};
  if (sleep.enabled === false) return { mode: 'awake', hhmm: parts.hhmm, day: parts.day };
  if (inTimeWindow(parts.minutesOfDay, sleep.napStart, sleep.napEnd)) {
    return { mode: 'nap', hhmm: parts.hhmm, day: parts.day };
  }
  if (inTimeWindow(parts.minutesOfDay, sleep.start, sleep.end)) {
    return { mode: 'sleep', hhmm: parts.hhmm, day: parts.day };
  }
  return { mode: 'awake', hhmm: parts.hhmm, day: parts.day };
}

/** 固定提示文案（build.md 二.14，每句后追加唤醒风险提示） */
export function sleepNotice(name, mode) {
  const n = String(name || '角色');
  if (mode === 'nap') return `${n}在休息哦，要稍后再来找他/她吧 ${SLEEP_SUFFIX}`;
  if (mode === 'sleep') return `夜深了，明天再来找他/她吧，你也要早点睡哦 ${SLEEP_SUFFIX}`;
  return '';
}

/** 是否处于需要拒绝发送的休息状态 */
export function restingState(character) {
  const settings = character?.settings || {};
  return sleepMode(settings, new Date()).mode;
}

/**
 * 生效中的作息：作息规则命中时，若角色状态被显式唤醒（sleep_state='awake_override'）则按清醒处理。
 * 唤醒标记会在作息窗口结束后的下一次状态刷新时自然清除。
 */
export function effectiveSleep(character, state, date = new Date()) {
  const computed = sleepMode(character?.settings, date);
  if (computed.mode === 'awake') return computed;
  if (state?.sleep_state === 'awake_override') {
    return { mode: 'awake', override: true, computed: computed.mode, hhmm: computed.hhmm, day: computed.day };
  }
  return computed;
}


// ---------------- 异常判定 ----------------

const HEALTH_BAD = /(生病|病了|发[烧热]|受伤|疼|不适|虚弱|疲惫不堪|感冒|头晕|恶心|咳嗽|过敏|住院|sick|fever|injur|pain|ill\b|exhaust)/i;
const MOOD_BAD = /(烦闷|烦躁|难过|伤心|低落|郁闷|焦虑|不安|害怕|恐惧|生气|愤怒|沮丧|委屈|崩溃|孤独|sad|angry|anxious|upset|depress|lonely)/i;
const HEALTH_OK = /(无(任何)?不适|没有不适|很健康|身体健康|状态良好|健康状况良好|健康)/g;

/** 依据模型显式标记 + 文本关键词判断健康/心情异常（统计依赖 flags） */
export function detectAbnormal(status = {}) {
  const healthText = String(status.health || '');
  const normalizedHealth = healthText.replace(HEALTH_OK, '');
  const moodText = `${status.mood || ''} ${status.psychology || ''}`;
  const healthAbnormal =
    status.healthAbnormal === true || (normalizedHealth.trim().length > 0 && HEALTH_BAD.test(normalizedHealth));
  const moodAbnormal = status.moodAbnormal === true || MOOD_BAD.test(moodText);
  return { healthAbnormal, moodAbnormal };
}

// ---------------- 状态刷新 ----------------

export function buildStatusPrompt(character, state, { softLimited = false } = {}) {
  const parts = tzParts();
  return [
    `你是「${character.name}」，请根据人设推断你此刻真实的状态。`,
    `人设：姓名 ${character.name}；年龄 ${character.age || '未设定'}；种族 ${character.race || '人类'}；性别 ${character.gender || '未设定'}；性格 ${character.personality || '未设定'}；职业 ${character.occupation || '未设定'}；与用户关系 ${character.relation || '未设定'}。`,
    `世界观：${character.worldview || '未设定'}。`,
    `当前状态：动作「${state.motion || '安静地待着'}」，心理「${state.psychology || '平静'}」，心情「${state.mood || '平静'}」，健康「${state.health || '健康'}」。`,
    `当前时间：${parts.day} ${parts.hhmm}（UTC+8）。`,
    '请结合种族、性别与设定推断生理状态、健康程度与是否患病，并给出一小段动作、心理活动、心情、健康状态。',
    '健康与心情正常时 healthAbnormal/moodAbnormal 为 false；出现疾病、受伤、明显不适或强烈负面情绪时为 true。',
    '只输出一个 JSON 对象，不要代码块或多余文字：',
    '{"type":"status","motion":"","psychology":"","mood":"","health":"","healthAbnormal":false,"moodAbnormal":false}',
    softLimited ? '（当前为软限额状态：只做最必要的状态描述，简洁。）' : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function persistStatusMessage({ userId, characterId, content, meta }) {
  const conv = ensureBackgroundConversation(userId, characterId);
  const id = `m_${uuid().replace(/-/g, '').slice(0, 16)}`;
  const now = nowIso();
  run(
    'INSERT INTO messages(id, conversation_id, character_id, user_id, role, kind, content, meta, tokens_in, tokens_out, created_at) VALUES(?,?,?,?,?,?,?,?,0,0,?)',
    id,
    conv.id,
    characterId,
    userId,
    'system',
    'status',
    encryptText(userId, content),
    encryptJson(userId, meta || {}),
    now,
  );
  run('UPDATE conversations SET updated_at = ? WHERE id = ?', now, conv.id);
  return id;
}

export function statusIntervalMs(settings = {}, softLimited = false) {
  if (softLimited) return 4 * 3600_000;
  const min = Number(settings?.statusIntervalMin) || 10;
  return Math.max(60_000, Math.round(min * 60_000));
}

/** 安排下一次状态刷新（同一角色只保留一个 pending） */
export function scheduleStatusRefresh({ userId, characterId, delayMs = null, softLimited = null, settings = null } = {}) {
  const st = settings || getSettings(characterId, userId);
  const soft = softLimited == null ? limitState(userId).softLimited : Boolean(softLimited);
  const ms = delayMs == null ? statusIntervalMs(st, soft) : Math.max(1_000, Math.round(delayMs));
  cancelJobs(characterId, 'status_refresh');
  const jobId = enqueue('status_refresh', new Date(Date.now() + ms).toISOString(), { soft }, { userId, characterId });
  return { jobId, delayMs: ms, soft };
}

/**
 * 刷新角色状态。
 * @returns {Promise<{ok:boolean, reason?:string, state?:object, flags?:object, messageId?:string}>}
 */
export async function refreshStatus({ userId, characterId, provider = defaultProvider } = {}) {
  const character = getCharacter(userId, characterId);
  if (!character) return { ok: false, reason: 'character_not_found' };
  const limits = limitState(userId);
  if (limits.hardLimited) {
    scheduleStatusRefresh({
      userId,
      characterId,
      delayMs: STATUS_HARD_RETRY_MS,
      softLimited: true,
      settings: character.settings,
    });
    return { ok: false, reason: 'hard_limit' };
  }

  const state = ensureState(characterId, userId);
  const settings = character.settings || getSettings(characterId, userId);
  const sleep = effectiveSleep(character, state, new Date());
  try {
    if (sleep.mode === 'awake' && state.sleep_state !== 'awake') {
      // 作息窗口结束：清除唤醒豁免标记
      updateState(characterId, { sleepState: 'awake' });
    } else if (sleep.mode !== 'awake' && state.sleep_state !== 'awake_override' && state.sleep_state !== sleep.mode) {
      updateState(characterId, { sleepState: sleep.mode });
    }
  } catch (err) {
    logger.warn('状态刷新：写入作息失败', err?.message);
  }

  let parsed = null;
  let model = null;
  try {
    const res = await provider.chatText(userId, {
      task: 'status',
      temperature: 0.9,
      maxTokens: 400,
      thinking: false,
      json: true,
      messages: [
        { role: 'system', content: buildStatusPrompt(character, state, { softLimited: limits.softLimited }) },
        { role: 'user', content: '现在请输出你的状态 JSON。' },
      ],
    });
    model = res?.model || null;
    recordUsage({ userId, characterId, kind: 'status', model, usage: res?.usage || {}, cost: res?.cost });
    parsed = parseReply(res?.text ?? '', { segmentEnabled: false });
  } catch (err) {
    logger.warn('状态刷新失败', err?.message || err);
    scheduleStatusRefresh({
      userId,
      characterId,
      softLimited: limits.softLimited,
      settings,
    });
    return { ok: false, reason: 'model_failed', error: err?.message || 'upstream_error' };
  }

  if (!parsed || parsed.type !== 'status' || !parsed.fields) {
    scheduleStatusRefresh({ userId, characterId, softLimited: limits.softLimited, settings });
    return { ok: false, reason: 'parse_failed', raw: String(parsed?.content || '').slice(0, 200) };
  }

  const nextState = {
    motion: parsed.fields.motion || state.motion || '安静地待着',
    psychology: parsed.fields.psychology || state.psychology || '',
    mood: parsed.fields.mood || state.mood || '平静',
    health: parsed.fields.health || state.health || '健康',
  };
  const flags = detectAbnormal({ ...nextState, ...(parsed.flags || {}) });
  updateState(characterId, nextState);

  const messageId = persistStatusMessage({
    userId,
    characterId,
    content: JSON.stringify({ type: 'status', ...nextState, ...flags }),
    meta: { flags, mood: nextState.mood, health: nextState.health, model },
  });

  broadcast(userId, {
    type: 'state',
    state: {
      ...nextState,
      sleepState: sleep.mode,
      flags,
      updatedAt: nowIso(),
    },
  });

  scheduleStatusRefresh({ userId, characterId, softLimited: limits.softLimited, settings });
  return { ok: true, state: nextState, flags, messageId, sleepState: sleep.mode };
}

/**
 * 启动/巡检时为还没有 pending 状态任务的角色补一个（新建角色无需重启即可覆盖）。
 * @returns {{scheduled:number}}
 */
export function bootstrapStatusJobs({ limit = 50 } = {}) {
  const rows = all('SELECT id, user_id FROM characters WHERE archived = 0 ORDER BY created_at ASC LIMIT ?', Number(limit) || 50);
  let scheduled = 0;
  let index = 0;
  for (const row of rows) {
    if (nextJob(row.id, 'status_refresh')) continue;
    const delay = 3_000 + index * 2_000;
    index++;
    try {
      scheduleStatusRefresh({ userId: row.user_id, characterId: row.id, delayMs: delay });
      scheduled++;
    } catch (err) {
      logger.warn('状态任务补排失败', row.id, err?.message);
    }
  }
  return { scheduled };
}

export default {
  sleepMode,
  effectiveSleep,
  sleepNotice,
  restingState,
  detectAbnormal,
  refreshStatus,
  scheduleStatusRefresh,
  statusIntervalMs,
  bootstrapStatusJobs,
  buildStatusPrompt,
};
