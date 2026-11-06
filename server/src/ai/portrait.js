// 人物画像：200 次对话或距上次 3 天触发，在独立系统会话中生成，二次投送提炼心理/行为特征
import { all, get, run, tx } from '../db/index.js';
import { encryptText, decryptText, encryptJson } from '../core/crypto.js';
import { nowIso, uuid, truncate, dayKey } from '../core/util.js';
import logger from '../core/logger.js';
import { chatText, embed } from './provider.js';
import { recordUsage } from './usage.js';
import { broadcast } from '../realtime/hub.js';
import { getCharacter, updateState } from '../services/characters.js';
import { enqueue, nextJob } from '../services/jobs.js';
import {
  MEMORY_NOTICE,
  jobContext,
  promptText,
  parseJsonLoose,
  recentMessages,
  insertMemory,
  appendSystemMessage,
  limitState,
} from './memory.js';

const log = logger;

export const PORTRAIT_CHAT_THRESHOLD = 200;
export const PORTRAIT_INTERVAL_DAYS = 3;
/** 首次画像（尚无上一版）时，至少要有这些对话，避免新角色立刻生成空画像 */
export const PORTRAIT_FIRST_MIN_CHATS = 20;
const DAY_MS = 86400000;
const HISTORY_LIMIT = 60;

const running = new Set();
const throttle = new Map(); // characterId -> last check ts
const THROTTLE_MS = 60_000;

const PORTRAIT_GENERATE_FALLBACK = `你在为陪伴角色整理一份对用户的「人物画像」。
结合角色人设、近期对话与已知记忆，写出 200-400 字画像：用户的性格、情绪模式、生活习惯、喜好与雷点、与角色的关系变化。
只输出 JSON：{"type":"profile","content":"画像正文"}。`;

const PORTRAIT_REFINE_FALLBACK = `请对下面的人物画像做二次提炼：区分心理特征与行为特征，各 80-150 字，并给出一句话总览。
只输出 JSON：{"psychology":"","behavior":"","summary":""}。`;

/** 触发判定（纯函数，便于单测） */
export function portraitDue(state = {}, { createdAt = null, now = Date.now() } = {}) {
  const count = Number(state?.chat_count_since_portrait ?? state?.chatSincePortrait ?? 0) || 0;
  const lastRaw = state?.last_portrait_at ?? state?.lastPortraitAt ?? null;
  const last = lastRaw ? Date.parse(lastRaw) : null;
  if (count >= PORTRAIT_CHAT_THRESHOLD) return { due: true, reason: 'chat_count', count, elapsed: last ? now - last : null };
  if (last) {
    const elapsed = now - last;
    if (elapsed >= PORTRAIT_INTERVAL_DAYS * DAY_MS && count > 0) {
      return { due: true, reason: 'interval', count, elapsed };
    }
    return { due: false, reason: 'interval_pending', count, elapsed };
  }
  const baseRaw = state?.companion_since || state?.companionSince || createdAt;
  const base = baseRaw ? Date.parse(baseRaw) : NaN;
  const days = Number.isFinite(base) ? (now - base) / DAY_MS : 0;
  if (days >= PORTRAIT_INTERVAL_DAYS && count >= PORTRAIT_FIRST_MIN_CHATS) {
    return { due: true, reason: 'first_interval', count, days };
  }
  return { due: false, reason: 'not_enough', count, days };
}

/** 画像差异对比（纯函数）：无上一版 -> 首次画像 */
export function diffPortraits(previous, next) {
  if (!previous || !String(previous).trim()) return '首次画像';
  const split = (t) =>
    String(t || '')
      .split(/[。！？\n；;]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 1);
  const prev = split(previous);
  const curr = split(next);
  const same = (a, b) => a === b || a.includes(b) || b.includes(a);
  const added = curr.filter((s) => !prev.some((p) => same(p, s)));
  const removed = prev.filter((s) => !curr.some((c) => same(c, s)));
  if (!added.length && !removed.length) return '与上一版一致，暂无新变化';
  const parts = [`与前一次画像相比：新增 ${added.length} 处、淡化 ${removed.length} 处`];
  if (added.length) parts.push(`新增 ${added.slice(0, 3).map((s) => truncate(s, 60)).join('；')}`);
  if (removed.length) parts.push(`淡化 ${removed.slice(0, 3).map((s) => truncate(s, 60)).join('；')}`);
  return `${parts.join('。')}。`;
}

function portraitTextFrom(result) {
  const data = parseJsonLoose(result?.text);
  const content = data?.content ?? data?.profile ?? data?.portrait;
  if (typeof content === 'string' && content.trim()) return content.trim();
  const raw = String(result?.text || '').trim();
  return raw && !raw.startsWith('{') ? raw : '';
}

function analysisFrom(result, portrait) {
  const data = parseJsonLoose(result?.text) || {};
  const psychology = String(data.psychology || data.mental || '').trim();
  const behavior = String(data.behavior || data.behaviour || '').trim();
  const summary = String(data.summary || data.content || '').trim();
  return {
    psychology: psychology || truncate(portrait, 200),
    behavior: behavior || truncate(summary || portrait, 200),
    summary: summary || truncate(portrait, 80),
  };
}

function decryptRowSafe(userId, row) {
  if (!row) return null;
  try {
    return { ...row, plain: decryptText(userId, row.content) };
  } catch (err) {
    log.debug('画像解密失败', err?.message);
    return { ...row, plain: String(row.content || '') };
  }
}

function buildHistory(userId, characterId) {
  const messages = recentMessages(userId, characterId, { limit: HISTORY_LIMIT, days: 14 });
  if (!messages.length) return '（近期没有对话记录）';
  return messages
    .map((m) => `${m.role === 'user' ? '用户' : '角色'}：${truncate(m.content, 200)}`)
    .join('\n');
}

function buildMemoryText(userId, characterId) {
  const rows = all(
    'SELECT id, big, small, content, weight FROM memories WHERE user_id = ? AND character_id = ? ORDER BY weight DESC LIMIT 60',
    userId,
    characterId,
  );
  if (!rows.length) return '（暂无记忆）';
  return rows
    .slice(0, 40)
    .map((r) => `- [${r.big}/${r.small}] ${truncate(decryptRowSafe(userId, r)?.plain || '', 120)}`)
    .join('\n');
}

/**
 * 生成画像并落库：portraits + memories（big=画像）+ changelogs + WS profile。
 * 失败只记录日志并返回 null（调度器不崩）。
 */
export async function runPortrait(job, payload = {}) {
  const ctx = jobContext(job, payload);
  const { userId, characterId, payload: body } = ctx;
  if (!userId || !characterId) {
    log.warn('画像任务缺少 userId/characterId，跳过', { userId, characterId });
    return { skipped: true, reason: 'missing_context' };
  }
  if (running.has(characterId)) {
    log.debug('画像任务已在执行，跳过重复触发', { characterId });
    return { skipped: true, reason: 'running' };
  }
  running.add(characterId);
  try {
    if (limitState(userId).state === 'hard') {
      log.warn('硬限额中，跳过画像生成', { userId, characterId });
      return { skipped: true, reason: 'hard_limit' };
    }
    const character = getCharacter(userId, characterId);
    if (!character) {
      log.warn('画像任务找不到角色', { userId, characterId });
      return { skipped: true, reason: 'character_not_found' };
    }
    if (character.settings?.enabled === false) {
      log.debug('角色已关闭，跳过画像生成', { userId, characterId });
      return { skipped: true, reason: 'character_disabled' };
    }
    const stateRow = get('SELECT * FROM character_state WHERE character_id = ?', characterId) || {};
    if (body.force !== true && stateRow.last_portrait_at) {
      const since = Date.now() - Date.parse(stateRow.last_portrait_at);
      if (Number.isFinite(since) && since < 3600_000) {
        log.debug('画像刚生成过，跳过重复任务', { userId, characterId });
        return { skipped: true, reason: 'recent_portrait', lastPortraitAt: stateRow.last_portrait_at };
      }
    }

    // 处理期间的统一提示语（与上下文压缩一致）
    broadcast(userId, { type: 'notice', content: MEMORY_NOTICE, characterId });

    const state = get('SELECT * FROM character_state WHERE character_id = ?', characterId) || {};
    const history = buildHistory(userId, characterId);
    const memoryText = buildMemoryText(userId, characterId);
    const prevRow = get(
      'SELECT * FROM portraits WHERE user_id = ? AND character_id = ? ORDER BY created_at DESC LIMIT 1',
      userId,
      characterId,
    );
    const previous = decryptRowSafe(userId, prevRow)?.plain || '';

    const genPrompt = promptText('PORTRAIT_GENERATE', PORTRAIT_GENERATE_FALLBACK, {
      character,
      history,
      memories: memoryText,
    });
    const gen = await chatText(userId, {
      task: 'portrait',
      json: true,
      temperature: 0.7,
      maxTokens: 1000,
      messages: [
        { role: 'system', content: genPrompt },
        { role: 'user', content: `请生成本次人物画像。\n近期对话：\n${history}\n已知记忆：\n${memoryText}` },
      ],
    });
    recordUsage({ userId, characterId, kind: 'portrait', model: gen.model, usage: gen.usage, cost: gen.cost });
    const portrait = portraitTextFrom(gen);
    if (!portrait) {
      log.warn('画像生成结果为空，保留原状态', { userId, characterId });
      return null;
    }

    // 二次投送：提炼心理与行为特征
    const refinePrompt = promptText('PORTRAIT_REFINE', PORTRAIT_REFINE_FALLBACK, {
      portrait,
      previous: previous || null,
    });
    let analysis = { psychology: truncate(portrait, 200), behavior: truncate(portrait, 200), summary: truncate(portrait, 80) };
    try {
      const refine = await chatText(userId, {
        task: 'portrait',
        json: true,
        temperature: 0.4,
        maxTokens: 800,
        messages: [
          { role: 'system', content: refinePrompt },
          {
            role: 'user',
            content: `画像：\n${portrait}\n${previous ? `上一版画像：\n${previous}` : '这是首次画像。'}`,
          },
        ],
      });
      recordUsage({ userId, characterId, kind: 'portrait', model: refine.model, usage: refine.usage, cost: refine.cost });
      analysis = analysisFrom(refine, portrait);
    } catch (err) {
      log.warn('画像二次提炼失败，使用画像正文替代', err?.message);
    }

    const changelog = diffPortraits(previous, portrait);
    const portraitId = `pt_${uuid().replace(/-/g, '').slice(0, 16)}`;
    const now = nowIso();
    tx(() => {
      run(
        'INSERT INTO portraits(id, user_id, character_id, content, analysis, created_at) VALUES(?,?,?,?,?,?)',
        portraitId,
        userId,
        characterId,
        encryptText(userId, portrait),
        encryptJson(userId, analysis),
        now,
      );
      run(
        'INSERT INTO changelogs(id, user_id, character_id, content, created_at) VALUES(?,?,?,?,?)',
        uuid(),
        userId,
        characterId,
        encryptJson(userId, { kind: 'portrait', portraitId, changelog, summary: analysis.summary }),
        now,
      );
    });
    updateState(characterId, { chatSincePortrait: 0, lastPortraitAt: now });

    // 画像与提炼结果写入记忆（big=画像，small=心理特征/行为特征）
    let embeddings = [];
    try {
      const emb = await embed(userId, [`心理特征：${analysis.psychology}`, `行为特征：${analysis.behavior}`]);
      embeddings = emb.vectors || [];
      if (embeddings.length) {
        recordUsage({ userId, characterId, kind: 'embedding', model: emb.model || 'embedding', usage: emb.usage || {} });
      }
    } catch (err) {
      log.warn('画像记忆向量生成失败，仅写入文本', err?.message);
    }
    insertMemory(userId, characterId, {
      big: '画像',
      small: '心理特征',
      content: analysis.psychology,
      weight: 0.9,
      embedding: embeddings[0] || null,
      source: 'portrait',
    });
    insertMemory(userId, characterId, {
      big: '画像',
      small: '行为特征',
      content: analysis.behavior,
      weight: 0.8,
      embedding: embeddings[1] || null,
      source: 'portrait',
    });

    // 独立系统会话留档（画像在新会话中形成）
    appendSystemMessage(userId, characterId, {
      tag: 'portrait',
      kind: 'portrait',
      role: 'user',
      content: `（画像素材 ${dayKey()}）近况：${truncate(history, 1500)}\n记忆：${truncate(memoryText, 800)}`,
      meta: { reason: body.reason || job?.type || 'portrait', portraitId },
    });
    appendSystemMessage(userId, characterId, {
      tag: 'portrait',
      kind: 'portrait',
      role: 'agent',
      content: `${portrait}\n\n【提炼】${analysis.summary}\n【差异】${changelog}`,
      meta: { portraitId },
    });

    broadcast(userId, { type: 'profile', content: portrait, changelog, characterId });
    log.info('人物画像已生成', { userId, characterId, portraitId, reason: body.reason || 'scheduled' });
    return { ok: true, portraitId, portrait, changelog, analysis };
  } catch (err) {
    log.warn('人物画像生成失败', err?.message);
    return null;
  } finally {
    running.delete(characterId);
  }
}

/**
 * 供 chat 线在每条消息后调用：内部节流 + 去重排队，命中条件才入队 portrait 任务。
 * 任何异常都吞掉，绝不打断对话主链路。
 */
export function maybeTriggerPortrait(userId, characterId, { force = false, now = Date.now() } = {}) {
  try {
    if (!userId || !characterId) return { triggered: false, reason: 'missing_ids' };
    if (running.has(characterId)) return { triggered: false, reason: 'running' };
    const lastCheck = throttle.get(characterId) || 0;
    if (!force && now - lastCheck < THROTTLE_MS) return { triggered: false, reason: 'throttled' };
    throttle.set(characterId, now);

    const state = get('SELECT * FROM character_state WHERE character_id = ?', characterId);
    if (!state) return { triggered: false, reason: 'no_state' };
    const character = getCharacter(userId, characterId);
    if (!character) return { triggered: false, reason: 'no_character' };

    const verdict = portraitDue(state, { createdAt: character.createdAt, now });
    if (!verdict.due && !force) return { triggered: false, reason: verdict.reason };

    if (nextJob(characterId, 'portrait')) return { triggered: false, reason: 'pending_job' };

    const jobId = enqueue('portrait', new Date(now), { characterId, reason: verdict.reason }, { userId, characterId });
    log.info('已排队人物画像', { userId, characterId, jobId, reason: verdict.reason });
    return { triggered: true, jobId, reason: verdict.reason };
  } catch (err) {
    log.warn('画像触发判定失败', err?.message);
    return { triggered: false, reason: 'error', error: err?.message };
  }
}

export function isPortraitRunning(characterId) {
  return running.has(characterId);
}

/** 最近一次画像（解密），供接口/调试使用 */
export function latestPortrait(userId, characterId) {
  const row = get(
    'SELECT * FROM portraits WHERE user_id = ? AND character_id = ? ORDER BY created_at DESC LIMIT 1',
    userId,
    characterId,
  );
  if (!row) return null;
  return {
    id: row.id,
    characterId: row.character_id,
    content: decryptRowSafe(userId, row)?.plain || '',
    analysis: parseJsonLoose(safeAnalysis(userId, row.analysis)),
    createdAt: row.created_at,
  };
}

function safeAnalysis(userId, blob) {
  if (!blob) return null;
  try {
    return decryptText(userId, blob);
  } catch {
    return null;
  }
}

export default { runPortrait, maybeTriggerPortrait, portraitDue, diffPortraits, latestPortrait };
