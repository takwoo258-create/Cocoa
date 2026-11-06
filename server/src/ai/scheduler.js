// 后台调度器：每 30 秒轮询 jobs 并按 type 分发（build.md 二.7/13、一.6）
// 任务类型：
//   status_refresh / active_reply / segment_send / context_compress / sentence_wait / wake_judge
//   记忆线动态处理器：portrait(_run) / memory(_extract) / news(_run) / creation(_run)
// 记忆线模块尚未就绪时跳过任务，不阻塞调度循环。
import logger from '../core/logger.js';
import { all, get, getMeta, setMeta } from '../db/index.js';
import { dayKey } from '../core/util.js';
import { decryptText } from '../core/crypto.js';
import { enqueue, dueJobs, jobPayload, markJob } from '../services/jobs.js';
import { getSettings, getCharacter, ensureState } from '../services/characters.js';
import { limitState, isCompressing } from './context.js';
import { isCharacterActiveById } from './activity.js';
import { refreshStatus, bootstrapStatusJobs, effectiveSleep } from './status.js';
import { handleActiveReplyJob } from './active.js';
import { getChatProvider, handleSegmentSend, handleSentenceWait, handleWakeJudge, runCompression, runGeneration, isGenerating, applyIntimacy } from './chat.js';

export const POLL_INTERVAL_MS = 30_000;
export const PORTRAIT_INTERVAL_MS = 24 * 3600_000;
export const NEWS_INTERVAL_MS = 6 * 3600_000;
export const DIARY_AT = { hour: 22, minute: 30 }; // UTC+8
export const NOVEL_DAILY_AT = { hour: 20, minute: 0 }; // UTC+8

let timer = null;
let ticking = false;
let tickCount = 0;
const customHandlers = new Map();
let memoryBootstrapCalls = 0;

/** 记忆线维护（补 embedding / 记忆 / 画像 / 新闻 / 创作巡检）；失败不影响调度 */
export async function runMemoryBootstrap() {
  try {
    const mod = await import('./memory.js');
    if (typeof mod.bootstrapAiMemoryJobs !== 'function') return { ok: false, reason: 'export_missing' };
    const out = await mod.bootstrapAiMemoryJobs();
    memoryBootstrapCalls += 1;
    return { ok: true, out };
  } catch (err) {
    logger.warn('记忆线巡检失败', err?.message || err);
    return { ok: false, reason: 'error', error: err?.message || String(err) };
  }
}

// 记忆线（ai-memory）提供的处理器：模块不存在 / 导出缺失时跳过
const MEMORY_HANDLERS = {
  portrait: ['./portrait.js', 'runPortrait'],
  portrait_run: ['./portrait.js', 'runPortrait'],
  portrait_generate: ['./portrait.js', 'runPortrait'],
  memory: ['./memory.js', 'runMemoryExtraction'],
  memory_extract: ['./memory.js', 'runMemoryExtraction'],
  memory_extraction: ['./memory.js', 'runMemoryExtraction'],
  news: ['./news.js', 'runNews'],
  news_run: ['./news.js', 'runNews'],
  news_read: ['./news.js', 'runNews'],
  creation: ['./creation.js', 'runCreation'],
  creation_run: ['./creation.js', 'runCreation'],
  creation_generate: ['./creation.js', 'runCreation'],
};

function contextOf(job, payload) {
  return {
    job,
    payload,
    userId: job.user_id || payload?.userId || null,
    characterId: job.character_id || payload?.characterId || null,
  };
}

async function runStatusRefresh(job, payload) {
  const { userId, characterId } = contextOf(job, payload);
  if (!userId || !characterId) return { ok: false, reason: 'missing_context', skipped: true };
  return refreshStatus({ userId, characterId, provider: getChatProvider() });
}

async function runActiveReply(job, payload) {
  const { userId, characterId } = contextOf(job, payload);
  if (!userId || !characterId) return { ok: false, reason: 'missing_context', skipped: true };
  return handleActiveReplyJob({ userId, characterId, payload, provider: getChatProvider() });
}

async function runSegmentSend(job, payload) {
  const { userId, characterId } = contextOf(job, payload);
  if (!userId || !characterId) return { ok: false, reason: 'missing_context', skipped: true };
  return handleSegmentSend({ userId, characterId, payload });
}

async function runSentenceWait(job, payload) {
  const { userId, characterId } = contextOf(job, payload);
  if (!userId || !characterId) return { ok: false, reason: 'missing_context', skipped: true };
  return handleSentenceWait({ userId, characterId, payload });
}

async function runContextCompress(job, payload) {
  const { userId, characterId } = contextOf(job, payload);
  if (!userId || !characterId || !payload.conversationId) {
    return { ok: false, reason: 'missing_context', skipped: true };
  }
  return runCompression({
    userId,
    characterId,
    conversationId: payload.conversationId,
    provider: getChatProvider(),
    keepRecent: payload.keepRecent,
  });
}

async function runWakeJudge(job, payload) {
  const { userId, characterId } = contextOf(job, payload);
  if (!userId || !characterId) return { ok: false, reason: 'missing_context', skipped: true };
  return handleWakeJudge({ userId, characterId, payload, provider: getChatProvider() });
}

const HANDLERS = {
  status_refresh: runStatusRefresh,
  status: runStatusRefresh,
  active_reply: runActiveReply,
  segment_send: runSegmentSend,
  sentence_wait: runSentenceWait,
  context_compress: runContextCompress,
  compress: runContextCompress,
  wake_judge: runWakeJudge,
  wake: runWakeJudge,
};

async function runMemoryJob(type, job, payload) {
  const entry = MEMORY_HANDLERS[type];
  if (!entry) return { ok: false, reason: 'unknown_type', skipped: true };
  const [spec, exportName] = entry;
  let mod;
  try {
    mod = await import(spec);
  } catch (err) {
    logger.warn(`记忆线模块缺失，跳过任务 ${type}`, spec, err?.message || err);
    return { ok: false, reason: 'module_missing', module: spec, skipped: true };
  }
  const fn = mod?.[exportName] || mod?.default?.[exportName];
  if (typeof fn !== 'function') {
    logger.warn(`记忆线模块缺少导出，跳过任务 ${type}`, spec, exportName);
    return { ok: false, reason: 'export_missing', module: spec, exportName, skipped: true };
  }
  try {
    // ai-memory 的处理器签名是 (job, payload) 且从 job.user_id / job.character_id 读取上下文
    const ctx = contextOf(job, payload);
    const out = await fn(job, { ...payload, userId: ctx.userId, characterId: ctx.characterId });
    return out === undefined ? { ok: true } : { ok: true, result: out };
  } catch (err) {
    logger.error(`记忆线任务执行失败 ${type}`, err?.stack || err?.message || err);
    return { ok: false, reason: 'handler_failed', error: err?.message || String(err) };
  }
}

// ---------------- 周期任务补排（记忆 / 画像 / 新闻 / 创作） ----------------

const JOB_ALIASES = {
  portrait: ['portrait', 'portrait_run', 'portrait_generate'],
  news: ['news', 'news_read', 'news_run'],
  creation: ['creation', 'creation_run', 'creation_generate'],
};

function pendingOf(characterId, kind) {
  const types = JOB_ALIASES[kind] || [kind];
  const placeholders = types.map(() => '?').join(',');
  return get(
    `SELECT id FROM jobs WHERE character_id = ? AND status = 'pending' AND type IN (${placeholders}) LIMIT 1`,
    characterId,
    ...types,
  );
}

function lastJobAt(characterId, kind) {
  const types = JOB_ALIASES[kind] || [kind];
  const placeholders = types.map(() => '?').join(',');
  const row = get(
    `SELECT MAX(created_at) AS last FROM jobs WHERE character_id = ? AND type IN (${placeholders})`,
    characterId,
    ...types,
  );
  const ts = row?.last ? Date.parse(row.last) : 0;
  return Number.isFinite(ts) ? ts : 0;
}

/** UTC+8 每日 hh:mm 的下一次触发时间（毫秒时间戳） */
export function nextDailyUtc8(hour, minute, now = Date.now()) {
  const shifted = new Date(now + 8 * 3600_000);
  let target = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
    hour,
    minute,
    0,
  ) - 8 * 3600_000;
  if (target <= now) target += 24 * 3600_000;
  return target;
}

/** UTC+8 当天 hh:mm 的时间戳（可能早于 now，用于当天补跑） */
export function todayUtc8At(hour, minute, now = Date.now()) {
  const shifted = new Date(now + 8 * 3600_000);
  return Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
    hour,
    minute,
    0,
  ) - 8 * 3600_000;
}

/** UTC+8 下一个整点（毫秒时间戳） */
export function nextHourUtc8(now = Date.now()) {
  const step = 3600_000;
  return Math.ceil((now + 1) / step) * step;
}

/**
 * 按角色补排记忆线周期任务（每轮巡检调用，内部有去重）：
 * - portrait：每 24h 检查一次，由 portrait.maybeTriggerPortrait 判定「200 次对话 / 距上次 3 天」后才入队
 * - news_read：每 6h 一条（软/硬限额不排）
 * - creation：日记每日 22:30（UTC+8）；小说按 creationFrequency（hourly 每小时、daily 每天 20:00、off 不排）
 * 同一角色同类型已有 pending 任务则跳过。
 */
export async function bootstrapPeriodicJobs({ now = Date.now(), maxCharacters = 50 } = {}) {
  const rows = all(
    'SELECT id, user_id FROM characters WHERE archived = 0 ORDER BY created_at ASC LIMIT ?',
    Number(maxCharacters) || 50,
  );
  const out = { characters: rows.length, portrait: 0, news: 0, creation: 0 };
  const limitCache = new Map();
  const limitsFor = (uid) => {
    if (!limitCache.has(uid)) limitCache.set(uid, limitState(uid));
    return limitCache.get(uid);
  };
  for (const row of rows) {
    const characterId = row.id;
    const userId = row.user_id;
    try {
      if (!isCharacterActiveById(userId, characterId)) continue;
      const limits = limitsFor(userId);
      if (limits.hardLimited) continue;

      // 画像：24h 巡检一次；conditions 由 portrait.maybeTriggerPortrait 判定
      if (!pendingOf(characterId, 'portrait') && now - lastJobAt(characterId, 'portrait') >= PORTRAIT_INTERVAL_MS) {
        const portraitMod = await import('./portrait.js').catch(() => null);
        const trigger = portraitMod?.maybeTriggerPortrait;
        if (typeof trigger === 'function') {
          const verdict = trigger(userId, characterId, { now });
          if (verdict?.triggered) out.portrait++;
        } else {
          enqueue('portrait', new Date(now).toISOString(), { force: false }, { userId, characterId });
          out.portrait++;
        }
      }

      if (limits.softLimited) continue;

      // 新闻：每 6 小时一条
      if (!pendingOf(characterId, 'news')) {
        const last = lastJobAt(characterId, 'news');
        if (now - last >= NEWS_INTERVAL_MS) {
          const due = Math.max(now, last + NEWS_INTERVAL_MS);
          enqueue('news', new Date(due).toISOString(), { characterId }, { userId, characterId });
          out.news++;
        }
      }

      // 创作：日记当天缺失时优先日记（22:30，错过则立即补）；日记完成后按频率写小说
      if (!pendingOf(characterId, 'creation')) {
        const settings = getSettings(characterId, userId) || {};
        const freq = String(settings.creationFrequency || 'daily');
        const day = dayKey(new Date(now));
        const diary = get(
          "SELECT id FROM books WHERE user_id = ? AND character_id = ? AND type = 'diary' AND day = ? LIMIT 1",
          userId,
          characterId,
          day,
        );
        let pick = null;
        if (!diary) {
          // 当天 22:30 未到 → 排到 22:30；已过但当天还没有日记 → 立即补跑（失败后至少隔 30 分钟重试，避免每轮空转）
          const due = todayUtc8At(DIARY_AT.hour, DIARY_AT.minute, now);
          const retryAfter = lastJobAt(characterId, 'creation') + 30 * 60_000;
          pick = { type: 'diary', at: due > now ? due : Math.max(now, retryAfter) };
        } else if (freq === 'hourly') {
          pick = { type: 'novel', at: nextHourUtc8(now) };
        } else if (freq === 'daily') {
          pick = { type: 'novel', at: nextDailyUtc8(NOVEL_DAILY_AT.hour, NOVEL_DAILY_AT.minute, now) };
        }
        if (pick) {
          enqueue('creation', new Date(pick.at).toISOString(), { type: pick.type }, { userId, characterId });
          out.creation++;
        }
      }
    } catch (err) {
      logger.warn('周期任务补排失败', characterId, err?.message || err);
    }
  }
  return out;
}


/** 注册自定义任务类型（供其他开发线扩展） */
export function registerHandler(type, fn) {
  if (typeof fn === 'function') customHandlers.set(type, fn);
}

/**
 * 执行单个任务；任何异常都不会抛出到调度循环。
 * @returns {Promise<{ok:boolean, type:string, jobId:string, result?:any, error?:string}>}
 */
export async function dispatchJob(job) {
  if (!job || !job.id) return { ok: false, type: 'unknown', jobId: null, error: 'invalid_job' };
  const payload = jobPayload(job);
  // v1.5.0：角色关闭运行后，所有已入队任务在执行时再检查一次
  if (job.character_id && !isCharacterActiveById(job.user_id, job.character_id)) {
    markJob(job.id, 'skipped');
    return { ok: false, type: job.type, jobId: job.id, status: 'skipped', result: { reason: 'character_disabled' } };
  }
  markJob(job.id, 'running');
  try {
    let result;
    if (typeof customHandlers.get(job.type) === 'function') {
      result = await customHandlers.get(job.type)(contextOf(job, payload));
    } else if (typeof HANDLERS[job.type] === 'function') {
      result = await HANDLERS[job.type](job, payload);
    } else {
      result = await runMemoryJob(job.type, job, payload);
    }
    const status = result?.skipped ? 'skipped' : 'done';
    markJob(job.id, status);
    return { ok: result?.ok !== false, type: job.type, jobId: job.id, status, result };
  } catch (err) {
    logger.error('任务执行异常', job.type, job.id, err?.stack || err?.message || err);
    try {
      markJob(job.id, 'failed');
    } catch {
      /* ignore */
    }
    return { ok: false, type: job.type, jobId: job.id, status: 'failed', error: err?.message || String(err) };
  }
}

// ---------------- 亲密度衰减（v1.5.0） ----------------

const DAY_MS = 86_400_000;

/** 7 天无对话后，每日按 -0.5 衰减（最低 0），并写 intimacy_log(source='decay') */
export async function runIntimacyDecay({ now = Date.now() } = {}) {
  const today = dayKey(new Date(now));
  const rows = all('SELECT id, user_id FROM characters WHERE archived = 0');
  let applied = 0;
  for (const row of rows) {
    const characterId = row.id;
    const userId = row.user_id;
    try {
      if (!isCharacterActiveById(userId, characterId)) continue;
      const guardKey = `intimacy:decay:${characterId}`;
      if (getMeta(guardKey, null) === today) continue;
      const last = get(
        "SELECT MAX(created_at) AS m FROM messages WHERE user_id = ? AND character_id = ? AND role IN ('user','agent')",
        userId,
        characterId,
      );
      setMeta(guardKey, today);
      if (!last?.m) continue;
      const idleMs = now - Date.parse(last.m);
      if (!Number.isFinite(idleMs) || idleMs < 7 * DAY_MS) continue;
      const lastDecayKey = `intimacy:last_decay:${characterId}`;
      const lastDecayAt = Date.parse(getMeta(lastDecayKey, '') || '') || Date.parse(last.m);
      const sinceLast = Math.floor((now - lastDecayAt) / DAY_MS);
      const eligible = Math.floor(idleMs / DAY_MS) - 6;
      const days = Math.max(1, Math.min(30, Math.min(sinceLast || 1, Math.max(1, eligible))));
      const before = Number(ensureStateIntimacy(userId, characterId)) || 0;
      const after = applyIntimacy({ userId, characterId, delta: -0.5 * days, source: 'decay', broadcastState: true });
      setMeta(lastDecayKey, new Date(now).toISOString());
      if (after != null && after !== before) applied += 1;
    } catch (err) {
      logger.warn('亲密度衰减失败', characterId, err?.message || err);
    }
  }
  return { applied };
}

function ensureStateIntimacy(userId, characterId) {
  const row = get('SELECT intimacy FROM character_state WHERE character_id = ?', characterId);
  return row?.intimacy ?? 0;
}

// ---------------- 回复看门狗（v1.0.1） ----------------

export const WATCHDOG_MIN_AGE_MS = 45_000;
export const WATCHDOG_MAX_PER_TICK = 5;
const watchdogSeen = new Set();

export function resetWatchdogSeen() {
  watchdogSeen.clear();
}

/**
 * 扫描主会话：最新用户消息超过 45s 且之后没有 agent 消息、没有等待中的任务、
 * 不在睡眠/硬限额、也没有正在生成时，补一次生成（按 messageId 去重）。
 * 进程重启后也能把「用户发了但没人回」的消息补上。
 */
export async function runWatchdog({ now = Date.now(), max = WATCHDOG_MAX_PER_TICK, limit = 200 } = {}) {
  const out = { scanned: 0, triggered: 0, skipped: 0, results: [] };
  const conversations = all(
    "SELECT * FROM conversations WHERE kind = 'main' AND active = 1 ORDER BY updated_at DESC LIMIT ?",
    Math.max(1, Number(limit) || 200),
  );
  for (const conv of conversations) {
    if (out.triggered >= max) break;
    out.scanned += 1;
    const lastUser = get(
      "SELECT * FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1",
      conv.id,
    );
    if (!lastUser) continue;
    const age = now - Date.parse(lastUser.created_at);
    if (!Number.isFinite(age) || age < WATCHDOG_MIN_AGE_MS) continue;
    if (watchdogSeen.has(lastUser.id)) {
      out.skipped += 1;
      continue;
    }
    const agentAfter = get(
      "SELECT id FROM messages WHERE conversation_id = ? AND role = 'agent' AND created_at >= ? LIMIT 1",
      conv.id,
      lastUser.created_at,
    );
    if (agentAfter) continue;
    const pending = get(
      "SELECT id FROM jobs WHERE character_id = ? AND status = 'pending' AND type IN ('sentence_wait','active_reply','context_compress') LIMIT 1",
      conv.character_id,
    );
    if (pending) {
      out.skipped += 1;
      continue;
    }
    if (!isCharacterActiveById(conv.user_id, conv.character_id)) continue;
    if (isCompressing(conv.id) || isGenerating(conv.user_id, conv.character_id)) {
      out.skipped += 1;
      continue;
    }
    const limits = limitState(conv.user_id);
    if (limits.hardLimited) continue;
    const character = getCharacter(conv.user_id, conv.character_id);
    if (!character) continue;
    const state = ensureState(conv.character_id, conv.user_id);
    if (effectiveSleep(character, state, new Date(now)).mode !== 'awake') continue;

    watchdogSeen.add(lastUser.id);
    if (watchdogSeen.size > 1000) watchdogSeen.clear();
    out.triggered += 1;
    try {
      const result = await runGeneration({
        userId: conv.user_id,
        characterId: conv.character_id,
        conversationId: conv.id,
        reason: 'watchdog',
        triggerText: decryptText(conv.user_id, lastUser.content),
        voiceReply: lastUser.kind === 'voice',
      });
      out.results.push({ messageId: lastUser.id, ok: result?.ok === true, reason: result?.reason || null });
    } catch (err) {
      logger.warn('看门狗补回复失败', conv.id, err?.message || err);
      out.results.push({ messageId: lastUser.id, ok: false, reason: 'exception' });
    }
  }
  return out;
}

/**
 * 跑一轮到期任务。可被调度器或测试直接调用。
 */
export async function tick({ limit = 20, sweep = true } = {}) {
  if (ticking) return { ok: false, reason: 'in_progress', processed: 0 };
  ticking = true;
  const results = [];
  try {
    const jobs = dueJobs(limit);
    for (const job of jobs) {
      results.push(await dispatchJob(job));
    }
    tickCount += 1;
    if (sweep) {
      // 每轮：补排记忆/画像/新闻/创作（内部去重）；每 10 轮：补排状态刷新任务
      try {
        const periodic = await bootstrapPeriodicJobs();
        if (periodic.portrait || periodic.news || periodic.creation) {
          logger.debug('周期任务补排', periodic);
        }
      } catch (err) {
        logger.warn('周期任务巡检失败', err?.message || err);
      }
      if (tickCount % 10 === 1) {
        // 每 10 轮（约 5 分钟）+ 启动首轮：记忆线维护
        try {
          const mem = await runMemoryBootstrap();
          if (mem.ok) logger.debug('记忆线巡检', mem.out);
        } catch (err) {
          logger.warn('记忆线巡检异常', err?.message || err);
        }
        try {
          const boot = bootstrapStatusJobs();
          if (boot.scheduled) logger.info('状态任务补排', boot.scheduled);
        } catch (err) {
          logger.warn('状态任务补排失败', err?.message || err);
        }
      }
      try {
        const decay = await runIntimacyDecay({ now: Date.now() });
        if (decay.applied) logger.info('亲密度衰减', decay);
      } catch (err) {
        logger.warn('亲密度衰减巡检失败', err?.message || err);
      }
      try {
        const watchdog = await runWatchdog({ now: Date.now() });
        if (watchdog.triggered) logger.info('看门狗补回复', watchdog);
      } catch (err) {
        logger.warn('回复看门狗异常', err?.message || err);
      }
    }
    return { ok: true, processed: results.length, results };
  } catch (err) {
    logger.error('调度循环异常', err?.stack || err?.message || err);
    return { ok: false, processed: results.length, results, error: err?.message || String(err) };
  } finally {
    ticking = false;
  }
}

/** 单例启动（index.js 已调用）；重复调用安全 */
export function startScheduler({ intervalMs = POLL_INTERVAL_MS } = {}) {
  if (timer) return timer;
  timer = setInterval(() => {
    tick().catch((err) => logger.error('调度 tick 失败', err?.message || err));
  }, Math.max(1_000, Number(intervalMs) || POLL_INTERVAL_MS));
  timer.unref?.();
  logger.info(`后台调度器已启动（${Math.round((Number(intervalMs) || POLL_INTERVAL_MS) / 1000)}s）`);
  // 启动即跑一轮（不阻塞调用方）
  tick().catch((err) => logger.error('调度首轮失败', err?.message || err));
  return timer;
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
  customHandlers.clear();
}

export function schedulerState() {
  return { running: Boolean(timer), ticking, tickCount, pollMs: POLL_INTERVAL_MS };
}

export default { startScheduler, stopScheduler, tick, dispatchJob, registerHandler, schedulerState, bootstrapPeriodicJobs, runWatchdog, resetWatchdogSeen, runIntimacyDecay, runMemoryBootstrap, nextDailyUtc8, nextHourUtc8, todayUtc8At };
