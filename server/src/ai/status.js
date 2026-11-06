// 角色状态与作息（build.md 二.7/8/14、七.5）
// - 每 10 分钟（软限额时 4 小时一次）结合人设与世界状况请求 status JSON，updateState + WS {type:'state'}
// - 健康/心情异常：state 上标注 flags，并写 messages.kind='status'（meta.flags 加密，统计依赖此约定）
// - 作息：v1.2.0 起由模型状态决定（character_state.sleep_state: awake/napping/sleeping），不再读取用户作息设置
import { all, run } from '../db/index.js';
import { nowIso, uuid } from '../core/util.js';
import { encryptText, encryptJson } from '../core/crypto.js';
import { broadcast } from '../realtime/hub.js';
import { getCharacter, getSettings, ensureState, updateState } from '../services/characters.js';
import { enqueue, cancelJobs, nextJob } from '../services/jobs.js';
import { recordUsage } from './usage.js';
import { parseReply, extractJson } from './reply.js';
import { ensureBackgroundConversation, limitState } from './context.js';
import { isCharacterActiveById } from './activity.js';
import * as defaultProvider from './provider.js';
import { getWeatherSafe, weatherPrompt } from '../services/integrations.js';
import logger from '../core/logger.js';

export const SLEEP_SUFFIX = '若强行叫醒的话，可能会带来不必要的麻烦哦';
export const STATUS_HARD_RETRY_MS = 60 * 60_000;
export const MANUAL_REFRESH_COOLDOWN_MS = 5 * 60_000;
// v1.5.0：自动状态刷新间隔 5 分钟 ~ 30 天；null/0 表示不自动刷新
export const STATUS_INTERVAL_MIN_SEC = 300;
export const STATUS_INTERVAL_MAX_SEC = 86_400 * 30;
export const DEFAULT_STATUS_INTERVAL_SEC = 600;
const refreshing = new Set(); // 防止并发刷新导致状态重复

// v1.5.0：天气 30 分钟缓存 + 单飞（同一城市并发只请求一次），避免每条消息都打接口
export const WEATHER_TTL_MS = 30 * 60_000;
const weatherCache = new Map(); // city -> { at, prompt }
const weatherInflight = new Map(); // city -> Promise<string>

export function clearWeatherCache() {
  weatherCache.clear();
  weatherInflight.clear();
}

export async function cachedWeatherPrompt(settings = {}, { fetchIfMissing = true, fetcher = weatherPrompt, ttlMs = WEATHER_TTL_MS } = {}) {
  if (process.env.COCOA_DISABLE_WEATHER === '1') return '';
  const city = String(settings?.weatherCity || '宣城').trim().slice(0, 32) || '宣城';
  const hit = weatherCache.get(city);
  if (hit && Date.now() - hit.at < ttlMs) return hit.prompt;
  if (!fetchIfMissing) return hit?.prompt || '';
  if (weatherInflight.has(city)) return weatherInflight.get(city);
  const task = (async () => {
    try {
      const prompt = String((await fetcher(city)) || '');
      weatherCache.set(city, { at: Date.now(), prompt });
      return prompt;
    } catch {
      return hit?.prompt || '';
    } finally {
      weatherInflight.delete(city);
    }
  })();
  weatherInflight.set(city, task);
  return task;
}

/** 模型作息值归一化：awake | napping | sleeping（兼容旧的 nap/sleep/awake_override） */
export function normalizeSleepState(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (['awake', 'awake_override', 'wake', '清醒', '醒着', '醒'].includes(raw)) return 'awake';
  if (['napping', 'nap', '午睡', '小睡', '打盹', '休息'].includes(raw)) return 'napping';
  if (['sleeping', 'sleep', '睡眠', '睡觉', '夜间睡眠', '熟睡'].includes(raw)) return 'sleeping';
  return null;
}

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
export function sleepNotice(name, mode, date = new Date()) {
  const n = String(name || '角色');
  const normalized = normalizeSleepState(mode) || mode;
  if (!normalized || normalized === 'awake') return '';
  // 白天小睡/补觉不要说成“夜深了”：按 UTC+8 当前小时判断
  const hour = new Date(new Date(date).getTime() + 8 * 3600_000).getUTCHours();
  const night = hour >= 21 || hour < 6;
  if (normalized === 'sleeping' && night) return `夜深了，明天再来找他/她吧，你也要早点睡哦 ${SLEEP_SUFFIX}`;
  return `${n}在休息哦，要稍后再来找他/她吧 ${SLEEP_SUFFIX}`;
}

/** 是否处于需要拒绝发送的休息状态（v1.2.0：以模型写入的 state.sleep_state 为准） */
export function restingState(character, state = null) {
  return effectiveSleep(character, state || {}, new Date()).mode;
}

/**
 * 生效中的作息（v1.2.0）：
 * - 优先使用模型在状态刷新时写入的 character_state.sleep_state；
 * - 不再读取 character.settings.sleep（用户作息设置已从前端移除）；
 * - 无状态/未知值兜底为 awake。
 * @returns {{mode:'awake'|'napping'|'sleeping', hhmm:string, day:string, source:'model'|'default'}}
 */
export function effectiveSleep(character, state, date = new Date()) {
  const parts = tzParts(date);
  const normalized = normalizeSleepState(state?.sleep_state);
  if (normalized === 'napping' || normalized === 'sleeping') {
    return { mode: normalized, hhmm: parts.hhmm, day: parts.day, source: 'model' };
  }
  if (normalized === 'awake') {
    return { mode: 'awake', hhmm: parts.hhmm, day: parts.day, source: 'model' };
  }
  return { mode: 'awake', hhmm: parts.hhmm, day: parts.day, source: 'default' };
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

export function buildStatusPrompt(character, state, { softLimited = false, world = '' } = {}) {
  const parts = tzParts();
  return [
    `你是「${character.name}」，请根据人设推断你此刻真实的状态。`,
    `人设：姓名 ${character.name}；年龄 ${character.age || '未设定'}；种族 ${character.race || '人类'}；性别 ${character.gender || '未设定'}；性格 ${character.personality || '未设定'}；职业 ${character.occupation || '未设定'}；与用户关系 ${character.relation || '未设定'}。`,
    `世界观：${character.worldview || '未设定'}。`,
    `当前状态：动作「${state.motion || '安静地待着'}」，心理「${state.psychology || '平静'}」，心情「${state.mood || '平静'}」，健康「${state.health || '健康'}」。`,
    `当前时间：${parts.day} ${parts.hhmm}（UTC+8）。`,
    world ? `外部环境：${world}` : '',
    '请结合种族、性别与设定推断生理状态、健康程度与是否患病，并给出一小段动作、心理活动、心情、健康状态。',
    `当前作息：${normalizeSleepState(state?.sleep_state) || 'awake'}（awake 清醒 / napping 午睡或小睡 / sleeping 夜间睡眠）。请结合当前时间、人设与健康状况重新判断此刻是否清醒、在午睡还是在睡觉。`,
    `今天的作息安排：${state?.sleep_schedule || '尚未确定'}。请按真实生活习惯给出动态窗口（允许熬夜、晚起、早睡），每天首次刷新时确定。`,
    '健康与心情正常时 healthAbnormal/moodAbnormal 为 false；出现疾病、受伤、明显不适或强烈负面情绪时为 true。',
    '只输出一个 JSON 对象，不要代码块或多余文字：',
    '{"type":"status","motion":"","psychology":"","mood":"","health":"","sleepState":"awake","sleepSchedule":{"sleepAt":"23:30","wakeAt":"07:00","napStart":null,"napEnd":null},"healthAbnormal":false,"moodAbnormal":false}',
    'sleepSchedule 用 24 小时制 HH:MM（UTC+8）；sleepAt 为今天入睡时间、wakeAt 为起床时间，可留空表示不睡/不设午睡。',
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

/** settings.statusIntervalSec → 秒；null/0 = 永久不自动刷新；缺省时兼容旧 statusIntervalMin（默认 10 分钟） */
export function statusIntervalSecFor(settings = {}) {
  const raw = settings?.statusIntervalSec;
  if (raw === null || raw === 0 || raw === '0' || raw === '') return null;
  if (raw === undefined) {
    const legacy = Number(settings?.statusIntervalMin);
    if (Number.isFinite(legacy) && legacy > 0) {
      return Math.min(STATUS_INTERVAL_MAX_SEC, Math.max(STATUS_INTERVAL_MIN_SEC, Math.round(legacy * 60)));
    }
    return DEFAULT_STATUS_INTERVAL_SEC;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(STATUS_INTERVAL_MAX_SEC, Math.max(STATUS_INTERVAL_MIN_SEC, Math.round(n)));
}

/** @returns {number|null} 毫秒；null 表示不自动刷新 */
export function statusIntervalMs(settings = {}, _softLimited = false) {
  const sec = statusIntervalSecFor(settings);
  return sec == null ? null : sec * 1000;
}

// ---------------- 当日作息（sleep_schedule / sleep_since / next_sleep_change） ----------------

const TZ_OFFSET_MS = 8 * 3600_000;

function dayKeyUtc8(date = new Date()) {
  return new Date(date.getTime() + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

function todayUtc8At(hour, minute, nowMs = Date.now()) {
  const shifted = new Date(nowMs + TZ_OFFSET_MS);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), hour, minute, 0) - TZ_OFFSET_MS;
}

function nextDailyUtc8(hour, minute, nowMs = Date.now()) {
  let t = todayUtc8At(hour, minute, nowMs);
  if (t <= nowMs) t += 86_400_000;
  return t;
}

/** 校验模型给出的当日作息（HH:MM），返回带 day 的对象或 null */
export function normalizeSleepSchedule(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const schedule = {};
  for (const key of ['sleepAt', 'wakeAt', 'napStart', 'napEnd']) {
    const value = raw[key];
    if (value === undefined || value === null || value === '') {
      schedule[key] = null;
      continue;
    }
    const text = String(value).trim();
    if (parseHm(text) == null) return null;
    schedule[key] = text;
  }
  if (!schedule.sleepAt && !schedule.wakeAt) return null;
  schedule.day = raw.day || dayKeyUtc8();
  return schedule;
}

/** 读取角色状态里的作息附加字段 */
export function readSleepMeta(state = {}) {
  let schedule = null;
  if (state?.sleep_schedule) {
    try {
      schedule = typeof state.sleep_schedule === 'string' ? JSON.parse(state.sleep_schedule) : state.sleep_schedule;
    } catch {
      schedule = null;
    }
  }
  return {
    schedule,
    since: state?.sleep_since || null,
    nextChange: state?.next_sleep_change || null,
  };
}

function writeSleepMeta(characterId, { schedule = null, since = null, nextChange = null } = {}) {
  run(
    'UPDATE character_state SET sleep_schedule = ?, sleep_since = ?, next_sleep_change = ? WHERE character_id = ?',
    schedule ? JSON.stringify(schedule) : null,
    since,
    nextChange,
    characterId,
  );
}

/** 下一次入睡/起床时间点（ISO），用于即时刷新状态 */
export function nextSleepChangeAt(schedule, sleepState, nowMs = Date.now()) {
  if (!schedule) return null;
  const state = normalizeSleepState(sleepState) || 'awake';
  const target = state === 'awake' ? schedule.sleepAt : schedule.wakeAt;
  if (!target) return null;
  const hm = parseHm(target);
  if (hm == null) return null;
  return new Date(nextDailyUtc8(Math.floor(hm / 60), hm % 60, nowMs)).toISOString();
}

/**
 * 安排下一次自动状态刷新（同一角色只保留一个 pending）。
 * 取「设置间隔」与「next_sleep_change」中更早的时间；null/0 且无睡觉时间点时取消自动刷新。
 */
export function scheduleStatusRefresh({ userId, characterId, delayMs = null, settings = null } = {}) {
  if (!isCharacterActiveById(userId, characterId)) {
    cancelJobs(characterId, 'status_refresh');
    return { scheduled: false, reason: 'character_disabled' };
  }
  const st = settings || getSettings(characterId, userId);
  const state = ensureState(characterId, userId);
  const now = Date.now();
  const candidates = [];
  if (delayMs != null) candidates.push(now + Math.max(1_000, Math.round(delayMs)));
  else {
    const intervalSec = statusIntervalSecFor(st);
    if (intervalSec != null) candidates.push(now + intervalSec * 1000);
  }
  const nextChange = state?.next_sleep_change ? Date.parse(state.next_sleep_change) : NaN;
  if (Number.isFinite(nextChange) && nextChange > now) candidates.push(nextChange);
  cancelJobs(characterId, 'status_refresh');
  if (!candidates.length) return { scheduled: false, reason: 'interval_off' };
  const due = Math.min(...candidates);
  const jobId = enqueue('status_refresh', new Date(due).toISOString(), {}, { userId, characterId });
  return { scheduled: true, jobId, delayMs: due - now };
}

/**
 * 刷新角色状态。
 * @returns {Promise<{ok:boolean, reason?:string, state?:object, flags?:object, messageId?:string}>}
 */
export async function refreshStatus({ userId, characterId, provider = defaultProvider } = {}) {
  const character = getCharacter(userId, characterId);
  if (!character) return { ok: false, reason: 'character_not_found' };
  if (!isCharacterActiveById(userId, characterId)) return { ok: false, reason: 'character_disabled' };
  if (refreshing.has(characterId)) return { ok: false, reason: 'busy' };
  refreshing.add(characterId);
  try {
    const limits = limitState(userId);
    if (limits.hardLimited) {
      scheduleStatusRefresh({ userId, characterId, delayMs: STATUS_HARD_RETRY_MS, settings: character.settings });
      return { ok: false, reason: 'hard_limit' };
    }

    const state = ensureState(characterId, userId);
    const settings = character.settings || getSettings(characterId, userId);
    let world = '';
    try {
      world = await cachedWeatherPrompt(settings);
    } catch {
      world = '';
    }
    let parsed = null;
    let model = null;
    let rawStatus = null;
    try {
      const res = await provider.chatText(userId, {
        task: 'status',
        temperature: 0.9,
        maxTokens: 500,
        thinking: false,
        json: true,
        messages: [
          { role: 'system', content: buildStatusPrompt(character, state, { softLimited: limits.softLimited, world }) },
          { role: 'user', content: '现在请输出你的状态 JSON。' },
        ],
      });
      model = res?.model || null;
      recordUsage({ userId, characterId, kind: 'status', model, usage: res?.usage || {}, cost: res?.cost });
      parsed = parseReply(res?.text ?? '', { segmentEnabled: false });
      rawStatus = extractJson(res?.text ?? '') || null;
    } catch (err) {
      logger.warn('状态刷新失败', err?.message || err);
      scheduleStatusRefresh({ userId, characterId, settings });
      return { ok: false, reason: 'model_failed', error: err?.message || 'upstream_error' };
    }

    if (!parsed || parsed.type !== 'status' || !parsed.fields) {
      scheduleStatusRefresh({ userId, characterId, settings });
      return { ok: false, reason: 'parse_failed', raw: String(parsed?.content || '').slice(0, 200) };
    }

    const rawSchedule = rawStatus?.sleepSchedule ?? rawStatus?.sleep_schedule;
    const modelSchedule = normalizeSleepSchedule(rawSchedule);
    const current = readSleepMeta(state);
    const today = dayKeyUtc8();
    // 每天首次刷新由模型确定当日作息；当天后续刷新沿用，不再被模型改动
    const firstToday = !current.schedule || current.schedule.day !== today;
    const schedule = firstToday
      ? modelSchedule
        ? { ...modelSchedule, day: today }
        : current.schedule
          ? { ...current.schedule, day: today }
          : null
      : current.schedule;
    const prevSleep = normalizeSleepState(state.sleep_state) || 'awake';
    const modelSleep =
      normalizeSleepState(rawStatus?.sleepState ?? rawStatus?.sleep_state) || prevSleep;
    const sleepSince =
      modelSleep === 'awake' ? null : prevSleep === modelSleep ? current.since || null : nowIso();
    const nextChange = nextSleepChangeAt(schedule, modelSleep);

    const nextState = {
      motion: parsed.fields.motion || state.motion || '安静地待着',
      psychology: parsed.fields.psychology || state.psychology || '',
      mood: parsed.fields.mood || state.mood || '平静',
      health: parsed.fields.health || state.health || '健康',
      sleepState: modelSleep,
    };
    const flags = detectAbnormal({ ...nextState, ...(parsed.flags || {}) });
    const scheduleKey = (value) => (value ? JSON.stringify({ ...value, day: undefined }) : 'null');
    const same =
      state.motion === nextState.motion &&
      (state.psychology || '') === nextState.psychology &&
      state.mood === nextState.mood &&
      state.health === nextState.health &&
      prevSleep === modelSleep &&
      scheduleKey(current.schedule) === scheduleKey(schedule);

    const sleepInfo = {
      state: modelSleep,
      since: sleepSince,
      nextChange,
      schedule,
    };
    const payload = { ...nextState, sleep: sleepInfo, flags, updatedAt: nowIso() };

    if (same) {
      // 状态未变化：不重复写消息/广播（修复状态重复）
      scheduleStatusRefresh({ userId, characterId, settings });
      broadcast(userId, { type: 'state', state: payload });
      return { ok: true, duplicate: true, state: payload, flags, messageId: null, sleepState: modelSleep };
    }

    updateState(characterId, nextState);
    writeSleepMeta(characterId, { schedule, since: sleepSince, nextChange });

    const messageId = persistStatusMessage({
      userId,
      characterId,
      content: JSON.stringify({ type: 'status', ...nextState, sleep: sleepInfo, ...flags }),
      meta: { flags, mood: nextState.mood, health: nextState.health, sleepState: nextState.sleepState, model, sleep: sleepInfo },
    });

    broadcast(userId, { type: 'state', state: payload });
    scheduleStatusRefresh({ userId, characterId, settings });
    return { ok: true, duplicate: false, state: payload, flags, messageId, sleepState: modelSleep };
  } finally {
    refreshing.delete(characterId);
  }
}

/**
 * 手动刷新冷却（v1.2.0）：以 character_state.last_manual_refresh_at 为基准，5 分钟内只允许一次。
 */
export function manualRefreshCooldown(userId, characterId) {
  const state = ensureState(characterId, userId);
  const lastRaw = state?.last_manual_refresh_at || null;
  const last = lastRaw ? Date.parse(lastRaw) : 0;
  const now = Date.now();
  const next = last ? last + MANUAL_REFRESH_COOLDOWN_MS : 0;
  const allowed = !last || now >= next;
  const remainingMs = allowed ? 0 : Math.max(0, next - now);
  return {
    allowed,
    retryAfterSec: remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0,
    retryAfterMs: remainingMs,
    nextAllowedAt: new Date(allowed ? now : next).toISOString(),
    lastManualRefreshAt: lastRaw,
  };
}

/**
 * 立即刷新状态（POST /api/characters/:id/status/refresh 调用）。
 * 冷却中返回 {ok:false, reason:'cooldown', retryAfterSec, nextAllowedAt}。
 * 成功返回 {ok:true, state, flags, messageId, nextAllowedAt, retryAfterSec:0}。
 */
export async function refreshStatusNow({ userId, characterId, provider = defaultProvider } = {}) {
  const character = getCharacter(userId, characterId);
  if (!character) return { ok: false, reason: 'character_not_found', status: 404, retryAfterSec: 0, nextAllowedAt: null };
  if (!isCharacterActiveById(userId, characterId)) {
    return { ok: false, reason: 'character_disabled', status: 409, retryAfterSec: 0, nextAllowedAt: null };
  }
  const cooldown = manualRefreshCooldown(userId, characterId);
  if (!cooldown.allowed) {
    return {
      ok: false,
      reason: 'cooldown',
      status: 429,
      retryAfterSec: cooldown.retryAfterSec,
      retryAfterMs: cooldown.retryAfterMs,
      nextAllowedAt: cooldown.nextAllowedAt,
    };
  }
  // 先记冷却时间，避免并发/失败时被连续点击
  run('UPDATE character_state SET last_manual_refresh_at = ? WHERE character_id = ?', nowIso(), characterId);
  const result = await refreshStatus({ userId, characterId, provider });
  const after = manualRefreshCooldown(userId, characterId);
  return {
    ...result,
    retryAfterSec: after.retryAfterSec,
    retryAfterMs: after.retryAfterMs,
    nextAllowedAt: after.nextAllowedAt,
  };
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
    if (!isCharacterActiveById(row.user_id, row.id)) continue;
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
  normalizeSleepState,
  manualRefreshCooldown,
  refreshStatusNow,
  statusIntervalSecFor,
  normalizeSleepSchedule,
  readSleepMeta,
  nextSleepChangeAt,
  MANUAL_REFRESH_COOLDOWN_MS,
  STATUS_INTERVAL_MIN_SEC,
  STATUS_INTERVAL_MAX_SEC,
  DEFAULT_STATUS_INTERVAL_SEC,
  cachedWeatherPrompt,
  clearWeatherCache,
  WEATHER_TTL_MS,
};
