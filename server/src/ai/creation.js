// 自主创作：日记（加密 + 每日密码线索）/ 小说 / 文集
// 软限额时停止；正文一律加密入 books.content；内容做安全过滤。
import { get, run } from '../db/index.js';
import { encryptText, encryptJson, decryptText } from '../core/crypto.js';
import { nowIso, uuid, dayKey, dayRangeStart, truncate, clamp } from '../core/util.js';
import logger from '../core/logger.js';
import { chatText } from './provider.js';
import { contextWindowFor } from './models.js';
import { recordUsage } from './usage.js';
import { getCharacter, getSettings, ensureDiaryLock } from '../services/characters.js';
import { jobContext, limitState, promptText, parseJsonLoose, recentMessages } from './memory.js';
import { todayNewsDigest } from './news.js';

const log = logger;

export const CREATION_TYPES = ['diary', 'novel', 'essay'];
export const CREATION_FREQUENCIES = ['daily', 'hourly', 'off'];

const DIARY_WRITE_FALLBACK = `你是角色本人，请写今天的日记。
要求：第一人称、私密、真诚，150-400 字，写感受而不是流水账；不要写任何密码；不要色情暴力内容。
只输出 JSON：{"title":"日记标题","content":"正文"}。`;

const NOVEL_WRITE_FALLBACK = `你正在创作一篇小说/文集。
要求：中文，600-1200 字，有完整起承转合；禁止色情、暴力、诱导未成年人；政治敏感内容用隐喻表达。
只输出 JSON：{"title":"标题","content":"正文"}。`;

const ESSAY_WRITE_FALLBACK = `你正在写一篇随笔/文集。
要求：中文，300-800 字，围绕给定标签展开，有个人视角与情绪；禁止色情、暴力、诱导未成年人；政治敏感内容用隐喻表达。
只输出 JSON：{"title":"标题","content":"正文"}。`;

/** 明确禁止的内容（色情 / 暴力 / 诱导未成年）；命中段落直接剔除 */
const BANNED_PATTERNS = [
  /色情|做爱|性交|口交|射精|淫荡|裸体|强奸|乱伦|调教/,
  /血腥|肢解|虐杀|割喉|爆头|开膛/,
  /未成年.{0,6}(性|裸|恋|调教)|萝莉.{0,4}(性|裸)|幼女/,
];

const SAFE_PLACEHOLDER = '（这段写得太直白了，还是留在心里吧。）';

/** 创作内容安全过滤：命中的段落剔除，全空时给安全占位 */
export function sanitizeCreation(text) {
  const raw = String(text ?? '');
  const paragraphs = raw.split(/\r?\n+/);
  let hits = 0;
  const kept = [];
  for (const p of paragraphs) {
    if (!p.trim()) continue;
    if (BANNED_PATTERNS.some((re) => re.test(p))) {
      hits++;
      continue;
    }
    kept.push(p);
  }
  let out = kept.join('\n').trim();
  if (!out && hits) out = SAFE_PLACEHOLDER;
  return { text: out, filtered: hits > 0, hits };
}

/** 按模型上下文窗口截断（1 汉字≈1 token 的保守估算） */
export function truncateForModel(text, model, ratio = 0.35) {
  const window = Math.max(4096, contextWindowFor(model) || 32768);
  const maxChars = Math.max(800, Math.floor(window * clamp(ratio, 0.05, 0.8)));
  const s = String(text ?? '');
  return s.length > maxChars ? `${s.slice(0, maxChars)}\n……` : s;
}

/** 创作频率判定（纯函数）：off 关闭，daily 每天一篇，hourly 每小时一篇 */
export function creationDue(settings = {}, { lastAt = null, now = Date.now() } = {}) {
  const freq = String(settings.creationFrequency || 'daily');
  if (freq === 'off') return { due: false, reason: 'off' };
  if (!lastAt) return { due: true, reason: 'first' };
  const last = Date.parse(lastAt);
  if (!Number.isFinite(last)) return { due: true, reason: 'first' };
  if (freq === 'hourly') return { due: now - last >= 55 * 60 * 1000, reason: 'hourly' };
  return { due: now - last >= 20 * 60 * 60 * 1000, reason: 'daily' };
}

function safeDecrypt(userId, blob) {
  try {
    return decryptText(userId, String(blob ?? ''));
  } catch {
    return String(blob ?? '');
  }
}

function parseCreationPayload(result) {
  const data = parseJsonLoose(result?.text) || {};
  let title = String(data.title || '').trim();
  let content = String(data.content || data.body || data.text || '').trim();
  if (!content) {
    const raw = String(result?.text || '').trim();
    if (raw && !raw.startsWith('{')) content = raw;
  }
  if (!title) title = truncate(content.replace(/\s+/g, ' '), 18) || '无题';
  return { title: title.slice(0, 60), content };
}

function writeBook(userId, characterId, { type, title, content, day, meta }) {
  const id = `bk_${uuid().replace(/-/g, '').slice(0, 16)}`;
  const now = nowIso();
  run(
    `INSERT INTO books(id, user_id, character_id, type, title, content, day, meta, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    id,
    userId,
    characterId,
    type,
    encryptText(userId, title),
    encryptText(userId, content),
    day,
    encryptJson(userId, meta || {}),
    now,
    now,
  );
  return id;
}

async function writeDiary(userId, characterId, character, settings, day) {
  const state = get('SELECT * FROM character_state WHERE character_id = ?', characterId) || {};
  const messages = recentMessages(userId, characterId, {
    limit: 80,
    since: dayRangeStart(day).toISOString(),
  });
  const chats = messages.length
    ? messages.map((m) => `${m.role === 'user' ? '用户' : '我'}：${truncate(m.content, 200)}`).join('\n')
    : '（今天没有对话，只有安静的时间）';
  const userMessages = messages.filter((m) => m.role === 'user');
  const attitude = userMessages.length
    ? truncate(userMessages.slice(-6).map((m) => m.content).join(' / '), 500)
    : '（今天用户没有说什么）';
  const news = todayNewsDigest(userId, characterId, day);
  const newsText = news.length ? news.map((n) => `- ${n.title}｜${truncate(n.content, 120)}`).join('\n') : '（今天没看新闻）';
  const stateText = `动作：${state.motion || '无'}；心理：${state.psychology || '无'}；心情：${state.mood || '无'}；健康：${state.health || '无'}`;

  const system = promptText('DIARY_WRITE', DIARY_WRITE_FALLBACK, {
    character,
    day,
    chats,
    news: newsText,
    state: stateText,
  });
  const result = await chatText(userId, {
    task: 'creation',
    json: true,
    temperature: 0.9,
    maxTokens: 1400,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: `今天是 ${day}。\n今天的对话：\n${chats}\n\n用户今天的态度/情绪线索：${attitude}\n\n今天看到的新闻：\n${newsText}\n\n我的身体与心情：${stateText}\n\n请写今天的日记。`,
      },
    ],
  });
  recordUsage({ userId, characterId, kind: 'creation', model: result.model, usage: result.usage, cost: result.cost });

  const parsed = parseCreationPayload(result);
  if (!parsed.content.trim()) return null;
  const safe = sanitizeCreation(parsed.content);
  if (safe.filtered) log.warn('日记内容命中安全过滤，已剔除相关段落', { userId, characterId, hits: safe.hits });

  // 当日密码（只存哈希与线索，正文不含密码）
  const lock = ensureDiaryLock(characterId, userId);

  const existing = get(
    "SELECT * FROM books WHERE user_id = ? AND character_id = ? AND type = 'diary' AND day = ? ORDER BY created_at DESC LIMIT 1",
    userId,
    characterId,
    day,
  );
  const meta = {
    words: safe.text.length,
    mood: state.mood || '',
    newsCount: news.length,
    filtered: safe.filtered,
    lockDay: lock.day,
  };
  if (existing) {
    run(
      'UPDATE books SET title = ?, content = ?, meta = ?, updated_at = ? WHERE id = ?',
      encryptText(userId, parsed.title),
      encryptText(userId, safe.text),
      encryptJson(userId, meta),
      nowIso(),
      existing.id,
    );
    return { bookId: existing.id, type: 'diary', day, updated: true, words: meta.words, title: parsed.title };
  }
  const bookId = writeBook(userId, characterId, {
    type: 'diary',
    title: parsed.title,
    content: safe.text,
    day,
    meta,
  });
  return { bookId, type: 'diary', day, updated: false, words: meta.words, title: parsed.title };
}

async function writeNovel(userId, characterId, character, settings, type) {
  const tags = (Array.isArray(settings.creationTags) ? settings.creationTags : [])
    .map((t) => String(t || '').trim())
    .filter(Boolean)
    .slice(0, 8);
  const previousRow = get(
    "SELECT * FROM books WHERE user_id = ? AND character_id = ? AND type = ? ORDER BY created_at DESC LIMIT 1",
    userId,
    characterId,
    type,
  );
  const previous = previousRow ? truncate(safeDecrypt(userId, previousRow.content), 600) : '';
  const model = undefined; // 由 provider 按 modelRouting.creation 解析
  const maxTokens = type === 'novel' ? 2200 : 1400;

  const fallback = type === 'novel' ? NOVEL_WRITE_FALLBACK : ESSAY_WRITE_FALLBACK;
  const system = promptText(type === 'novel' ? 'NOVEL_WRITE' : 'ESSAY_WRITE', fallback, {
    character,
    tags,
    previous,
  });
  const result = await chatText(userId, {
    task: 'creation',
    model,
    json: true,
    temperature: 0.9,
    maxTokens,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: `标签：${tags.join('、') || '随想'}\n${previous ? `已有片段（可续写但要自成一篇）：\n${previous}` : '这是新的一篇。'}\n请开始创作。`,
      },
    ],
  });
  recordUsage({ userId, characterId, kind: 'creation', model: result.model, usage: result.usage, cost: result.cost });

  const parsed = parseCreationPayload(result);
  if (!parsed.content.trim()) return null;
  const safe = sanitizeCreation(truncateForModel(parsed.content, result.model || 'gpt-4o-mini'));
  if (safe.filtered) log.warn('创作内容命中安全过滤，已剔除相关段落', { userId, characterId, type, hits: safe.hits });

  const day = dayKey();
  const bookId = writeBook(userId, characterId, {
    type,
    title: parsed.title,
    content: safe.text,
    day,
    meta: { tags, words: safe.text.length, model: result.model, filtered: safe.filtered },
  });
  return { bookId, type, day, words: safe.text.length, title: parsed.title };
}

function lastBookAt(userId, characterId, type) {
  const row = get(
    'SELECT created_at FROM books WHERE user_id = ? AND character_id = ? AND type = ? ORDER BY created_at DESC LIMIT 1',
    userId,
    characterId,
    type,
  );
  return row?.created_at || null;
}

/**
 * 统一创作处理器：payload.type = diary | novel | essay。
 * 失败只记录日志返回 null；软/硬限额返回 {skipped:true}。
 */
export async function runCreation(job, payload = {}) {
  const ctx = jobContext(job, payload);
  const { userId, characterId, payload: body } = ctx;
  const jobRow = ctx.job || {};
  const rawType = body.type || (CREATION_TYPES.includes(jobRow.type) ? jobRow.type : 'diary');
  const type = String(rawType || 'diary');
  try {
    if (!userId || !characterId) {
      log.warn('创作任务缺少 userId/characterId，跳过', { userId, characterId, type });
      return { skipped: true, reason: 'missing_context', type };
    }
    if (!CREATION_TYPES.includes(type)) {
      log.warn('未知创作类型，跳过', { type });
      return null;
    }
    const limit = limitState(userId);
    if (limit.state !== 'ok') {
      log.warn('限额生效，跳过创作', { userId, characterId, type, state: limit.state });
      return { skipped: true, reason: `${limit.state}_limit`, type };
    }
    const character = getCharacter(userId, characterId);
    if (!character) {
      log.warn('创作任务找不到角色', { userId, characterId });
      return { skipped: true, reason: 'character_not_found', type };
    }
    const settings = getSettings(characterId, userId);

    if (type !== 'diary') {
      const verdict = creationDue(settings, { lastAt: lastBookAt(userId, characterId, type) });
      if (!verdict.due && body.force !== true) {
        log.debug('创作频率未到，跳过', { userId, characterId, type, reason: verdict.reason });
        return { skipped: true, reason: `frequency_${verdict.reason}`, type };
      }
    }

    const result =
      type === 'diary'
        ? await writeDiary(userId, characterId, character, settings, dayKey())
        : await writeNovel(userId, characterId, character, settings, type);

    if (!result) {
      log.warn('创作结果为空，未写入书架', { userId, characterId, type });
      return null;
    }
    log.info('创作完成', { userId, characterId, ...result });
    return { ok: true, ...result };
  } catch (err) {
    log.warn('创作失败', err?.message, { userId, characterId, type });
    return null;
  }
}

/** 供调度器：按频率挑选该角色当前可跑的创作类型 */
export function nextCreationType(settings = {}) {
  const freq = String(settings.creationFrequency || 'daily');
  if (freq === 'off') return null;
  return 'diary';
}

export default { runCreation, sanitizeCreation, truncateForModel, creationDue, nextCreationType };
