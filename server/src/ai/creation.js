// 自主创作（v1.5）：日记 / 小说连载 / 独立散文
// - 每类文体独立 conversation（kind='creation'），books 落 series_id / session_id
// - 小说 ≥1500 字、散文 ≥800 字，字数不足自动重试一次；标题必须具体有钩子
// - 会话上下文接近 85% 时复用 ai/compress.js 压缩
// - 正文一律加密入 books.content；日记密码由 services/characters.ensureDiaryLock 生成
import { all, get, run } from '../db/index.js';
import { encryptText, encryptJson, decryptText } from '../core/crypto.js';
import { nowIso, uuid, dayKey, dayRangeStart, truncate, clamp } from '../core/util.js';
import logger from '../core/logger.js';
import { chatText } from './provider.js';
import { contextWindowFor } from './models.js';
import { recordUsage } from './usage.js';
import { getCharacter, getSettings } from '../services/characters.js';
import { jobContext, limitState, parseJsonLoose, recentMessages, ensureDiaryCode } from './memory.js';
import { todayNewsDigest } from './news.js';
import { compressConversation, shouldCompress } from './compress.js';
import { refreshConversationUsage, contextLimitFor, COMPRESS_THRESHOLD } from './context.js';

const log = logger;

export const CREATION_TYPES = ['diary', 'novel', 'essay'];
export const CREATION_FREQUENCIES = ['daily', 'hourly', 'off'];
/** 正文字数下限（不含空白） */
export const CREATION_MIN_CHARS = { novel: 1500, essay: 800, diary: 80 };

const GENERIC_TITLES = new Set(['无题', '随笔', '日记', '感想', '随想', '日常', '碎碎念', '故事', '小说', '散文', '标题']);

const STYLE = {
  novel: {
    label: '小说',
    minChars: CREATION_MIN_CHARS.novel,
    maxTokens: 4200,
    truncateRatio: 0.55,
    system: `你是小说家，以角色身份连载一部长篇小说。
硬性要求：
1. 单章正文 1500-2600 字（必须 ≥1500 字，不含标题），宁长勿短。
2. 结构完整：开场有画面与人物处境，中段有冲突与转折，结尾留钩子（悬念、未说完的话或情绪余波）。
3. 用场景、动作、对话、感官细节推进；禁止流水账、大纲体、总结式叙述、说教和作者旁白解释。
4. 标题要有钩子：具体意象 + 悬念或反差，4-14 字；禁止「无题 / 随笔 / 日常 / 第X章 / 某某的故事」这类空泛标题。
5. 与已有章节保持人称、设定、伏笔一致；本章必须有新事件推进，不要复述前文。
6. 禁止色情、暴力、诱导未成年人内容；涉及敏感现实议题用隐喻，不直白点名。
7. 只输出 JSON：{"title":"标题","content":"正文","summary":"一句话本章概要"}。`,
  },
  essay: {
    label: '散文',
    minChars: CREATION_MIN_CHARS.essay,
    maxTokens: 3200,
    truncateRatio: 0.5,
    system: `你是散文作者，以角色身份写一篇独立散文。
硬性要求：
1. 正文 800-1500 字（必须 ≥800 字），独立成篇，不依赖上一篇的情节与人称。
2. 围绕给定标签，从具体场景 / 物件 / 气味 / 声音切入，写出个人视角与情绪弧线（起—展开—回落），结尾收束到一个具体画面或念头。
3. 禁止流水账、空泛抒情、格言堆砌、说教；每一段都要有可感知的细节。
4. 标题要有钩子：具体意象 + 情绪张力，4-14 字；禁止「无题 / 随笔 / 感想 / 碎碎念 / 日常」。
5. 禁止色情、暴力、诱导未成年人内容；涉及敏感现实议题用隐喻表达。
6. 只输出 JSON：{"title":"标题","content":"正文","summary":"一句话概要"}。`,
  },
  diary: {
    label: '日记',
    minChars: CREATION_MIN_CHARS.diary,
    maxTokens: 1600,
    truncateRatio: 0.4,
    system: `你是角色本人，请写今天的日记。
要求：
1. 第一人称、私密、真诚，300-600 字；写今天发生的具体细节、情绪变化和你对他的在意，不要流水账。
2. 禁止色情、暴力、诱导未成年人内容；敏感现实议题用隐喻。
3. 日记会被锁起来，密码只有你知道，不要把密码或数字写进正文。
4. 只输出 JSON：{"title":"日记标题","content":"正文"}。`,
  },
};

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

/** 正文字数（不含空白），用于字数下限判定 */
export function countChars(text) {
  return String(text ?? '').replace(/\s+/g, '').length;
}

/** 按模型上下文窗口截断（1 汉字≈1 token 的保守估算） */
export function truncateForModel(text, model, ratio = 0.35) {
  const window = Math.max(4096, contextWindowFor(model) || 32768);
  const maxChars = Math.max(1200, Math.floor(window * clamp(ratio, 0.05, 0.8)));
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

/** 标题兜底：模型的泛标题换成正文里的具体意象 */
export function pickTitle(rawTitle, content) {
  const title = String(rawTitle || '').replace(/^[《「【"']+|[》」】"']+$/g, '').trim();
  if (title && title.length >= 2 && !GENERIC_TITLES.has(title) && !/^(第.{1,3}章|第.{1,3}篇)$/.test(title)) {
    return title.slice(0, 40);
  }
  const firstClause = String(content || '')
    .split(/[。！？\n]/)
    .map((s) => s.replace(/\s+/g, '').trim())
    .find((s) => s.length >= 4);
  return truncate(firstClause || '无题', 16);
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
  if (!title) title = '无题';
  return { title, content, summary: String(data.summary || '').trim() };
}

// ---------------------------------------------------------------- 会话

function newConversationId() {
  return `cv_${uuid().replace(/-/g, '').slice(0, 16)}`;
}

/** 取或建创作会话（kind='creation'）：小说连载复用，散文/日记按篇/按日独立 */
export function ensureCreationConversation(userId, characterId, { titleKey, contextLimit = null } = {}) {
  const title = `creation:${titleKey}`;
  const existing = get(
    "SELECT * FROM conversations WHERE user_id = ? AND character_id = ? AND kind = 'creation' AND title = ? ORDER BY created_at DESC LIMIT 1",
    userId,
    characterId,
    title,
  );
  if (existing) return existing;
  const id = newConversationId();
  const now = nowIso();
  run(
    `INSERT INTO conversations(id, character_id, user_id, kind, title, created_at, updated_at, token_used, context_limit, active)
     VALUES(?,?,?,'creation',?,?,?,0,?,1)`,
    id,
    characterId,
    userId,
    title,
    now,
    now,
    Math.max(4096, Number(contextLimit) || contextLimitFor(userId, characterId)),
  );
  return get('SELECT * FROM conversations WHERE id = ?', id);
}

function conversationSummary(userId, conv) {
  if (!conv?.summary) return '';
  return safeDecrypt(userId, conv.summary);
}

function recentSessionText(userId, conversationId, limit = 6) {
  const rows = all(
    'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?',
    conversationId,
    limit,
  );
  return rows
    .reverse()
    .map((r) => `${r.role === 'agent' ? '作者' : '设定'}：${truncate(safeDecrypt(userId, r.content), 700)}`)
    .join('\n');
}

function appendCreationMessage(userId, characterId, conversationId, role, content, meta = null) {
  const text = String(content ?? '').trim();
  if (!text) return null;
  const id = `m_${uuid().replace(/-/g, '').slice(0, 16)}`;
  const now = nowIso();
  run(
    `INSERT INTO messages(id, conversation_id, character_id, user_id, role, kind, content, meta, tokens_in, tokens_out, created_at)
     VALUES(?,?,?,?,?,?,?,?,0,?,?)`,
    id,
    conversationId,
    characterId,
    userId,
    role,
    'creation',
    encryptText(userId, text),
    meta ? encryptJson(userId, meta) : null,
    Math.max(1, Math.round(text.length / 1.5)),
    now,
  );
  run('UPDATE conversations SET updated_at = ? WHERE id = ?', now, conversationId);
  refreshConversationUsage(conversationId);
  return id;
}

/** 会话占用 ≥85% 时压缩（复用 ai/compress.js） */
async function maybeCompressSession(userId, characterId, conversationId) {
  try {
    refreshConversationUsage(conversationId);
    const conv = get('SELECT * FROM conversations WHERE id = ?', conversationId);
    if (!conv) return null;
    const used = Number(conv.token_used) || 0;
    const limit = Number(conv.context_limit) || 0;
    if (!shouldCompress({ used, limit }, COMPRESS_THRESHOLD)) return null;
    const res = await compressConversation({ userId, characterId, conversationId });
    log.info('创作会话上下文已压缩', { userId, characterId, conversationId, dropped: res?.dropped, model: res?.model });
    return res;
  } catch (err) {
    log.warn('创作会话压缩失败', err?.message);
    return null;
  }
}

// ---------------------------------------------------------------- 生成

function buildCreationSystem(type, { character, tags, chapterNo, hasPrevious }) {
  const style = STYLE[type];
  const lines = [
    style.system,
    `你的人设：${character.name}，${character.gender || '未设定'}，${character.age || '未设定'}岁，${character.race || '人类'}；性格：${character.personality || '未设定'}；职业：${character.occupation || '未设定'}；世界观：${character.worldview || '未设定'}。`,
    `写作标签：${(tags || []).join('、') || '随想'}。`,
    type === 'novel' ? (hasPrevious ? `这是连载第 ${chapterNo} 章，请承接前文的人称、设定与伏笔。` : `这是连载第 ${chapterNo} 章（开篇），要立住人物与世界观。`) : '',
    type === 'essay' ? '这一篇必须独立成篇，不承接上一篇的人物与情节。' : '',
  ];
  return lines.filter(Boolean).join('\n');
}

function buildCreationUser({ type, tags, chapterNo, summary, previous, newsText }) {
  const parts = [`请开始写这一篇${STYLE[type].label}（第 ${chapterNo} 章）。`];
  if (tags?.length) parts.push(`标签：${tags.join('、')}`);
  if (summary) parts.push(`你自己的前情摘要：\n${truncate(summary, 900)}`);
  if (previous) parts.push(`上一章结尾片段（仅供衔接，不要复述）：\n${truncate(previous, 1200)}`);
  if (newsText) parts.push(`最近看到的事（可化作素材，不要生硬引用）：\n${truncate(newsText, 900)}`);
  parts.push(type === 'novel' ? '本章要有新事件推进，结尾留钩子。' : '这一篇要独立成篇。');
  return parts.filter(Boolean).join('\n\n');
}

async function generateCreation({ userId, characterId, type, character, tags, chapterNo, summary, previous, newsText, hasPrevious }) {
  const style = STYLE[type];
  const model = undefined; // 由 provider 按 modelRouting.creation 解析
  const system = buildCreationSystem(type, { character, tags, chapterNo, hasPrevious });
  const userPrompt = buildCreationUser({ type, tags, chapterNo, summary, previous, newsText });
  let best = null;
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const retryNote =
      attempt > 1
        ? `\n\n注意：上一稿只有 ${best?.chars || 0} 字，太短。请重写并扩写到至少 ${style.minChars} 字：增加场景、人物对话、感官细节与心理描写，保留标题方向，输出完整一篇（不要只给续写或大纲）。`
        : '';
    try {
      const result = await chatText(userId, {
        task: 'creation',
        model,
        json: true,
        temperature: attempt > 1 ? 0.95 : 0.9,
        maxTokens: style.maxTokens + (attempt > 1 ? 1200 : 0),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userPrompt + retryNote },
        ],
      });
      recordUsage({ userId, characterId, kind: 'creation', model: result.model, usage: result.usage, cost: result.cost });
      const parsed = parseCreationPayload(result);
      const safe = sanitizeCreation(parsed.content);
      const chars = countChars(safe.text);
      const candidate = {
        title: pickTitle(parsed.title, safe.text),
        content: safe.text,
        summary: parsed.summary || truncate(safe.text, 100),
        chars,
        attempt,
        model: result.model,
        filtered: safe.filtered,
        hits: safe.hits,
      };
      if (!best || candidate.chars > best.chars) best = candidate;
      if (candidate.chars >= style.minChars) return best;
      log.warn('创作字数不足，重试一次', { userId, characterId, type, chars, min: style.minChars, attempt });
    } catch (err) {
      lastError = err;
      log.warn('创作生成失败', { attempt, type, err: err?.message });
    }
  }
  if (!best) throw lastError || new Error('创作生成失败');
  return best;
}

// ---------------------------------------------------------------- 入库

function insertBook(userId, characterId, { type, title, content, day, meta, seriesId = null, sessionId = null }) {
  const id = `bk_${uuid().replace(/-/g, '').slice(0, 16)}`;
  const now = nowIso();
  run(
    `INSERT INTO books(id, user_id, character_id, type, title, content, day, meta, series_id, session_id, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    userId,
    characterId,
    type,
    encryptText(userId, title),
    encryptText(userId, content),
    day,
    encryptJson(userId, meta || {}),
    seriesId,
    sessionId,
    now,
    now,
  );
  return id;
}

async function writeDiary(userId, characterId, character, settings, day) {
  const state = get('SELECT * FROM character_state WHERE character_id = ?', characterId) || {};
  const messages = recentMessages(userId, characterId, { limit: 80, since: dayRangeStart(day).toISOString() });
  const chats = messages.length
    ? messages.map((m) => `${m.role === 'user' ? '用户' : '我'}：${truncate(m.content, 200)}`).join('\n')
    : '（今天没有对话，只有安静的时间）';
  const userMessages = messages.filter((m) => m.role === 'user');
  const attitude = userMessages.length
    ? truncate(userMessages.slice(-6).map((m) => m.content).join(' / '), 500)
    : '（今天用户没有说什么）';
  const news = todayNewsDigest(userId, characterId, day);
  const newsText = news.length ? news.map((n) => `- ${n.title}｜${truncate(n.content, 500)}`).join('\n') : '（今天没看新闻）';
  const stateText = `动作：${state.motion || '无'}；心理：${state.psychology || '无'}；心情：${state.mood || '无'}；健康：${state.health || '无'}`;

  const conv = ensureCreationConversation(userId, characterId, { titleKey: `diary:${day}` });
  const system = [STYLE.diary.system, `你的人设：${character.name}；性格：${character.personality || '未设定'}；与用户的关系：${character.relation || '重要的人'}。`].join('\n');
  const result = await chatText(userId, {
    task: 'creation',
    json: true,
    temperature: 0.9,
    maxTokens: STYLE.diary.maxTokens,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: `今天是 ${day}。\n今天的对话：\n${chats}\n\n用户今天的态度/情绪线索：${attitude}\n\n今天看到的新闻（含正文摘要）：\n${newsText}\n\n我的身体与心情：${stateText}\n\n请写今天的日记（不要写任何密码或数字线索）。`,
      },
    ],
  });
  recordUsage({ userId, characterId, kind: 'creation', model: result.model, usage: result.usage, cost: result.cost });

  const parsed = parseCreationPayload(result);
  if (!parsed.content.trim()) return null;
  const safe = sanitizeCreation(truncateForModel(parsed.content, result.model || 'gpt-4o-mini', STYLE.diary.truncateRatio));
  const title = pickTitle(parsed.title, safe.text);
  if (safe.filtered) log.warn('日记内容命中安全过滤，已剔除相关段落', { userId, characterId, hits: safe.hits });

  // 当日密码（hash + 加密 code 存在 services 侧；这里只确保存在，正文不含密码）
  const lock = ensureDiaryCode(userId, characterId);

  const existing = get(
    "SELECT * FROM books WHERE user_id = ? AND character_id = ? AND type = 'diary' AND day = ? ORDER BY created_at DESC LIMIT 1",
    userId,
    characterId,
    day,
  );
  const meta = {
    words: countChars(safe.text),
    mood: state.mood || '',
    newsCount: news.length,
    filtered: safe.filtered,
    lockDay: lock.day,
    attempts: 1,
    sessionTitle: conv.title,
  };
  if (existing) {
    run(
      'UPDATE books SET title = ?, content = ?, meta = ?, session_id = ?, updated_at = ? WHERE id = ?',
      encryptText(userId, title),
      encryptText(userId, safe.text),
      encryptJson(userId, meta),
      conv.id,
      nowIso(),
      existing.id,
    );
    appendCreationMessage(userId, characterId, conv.id, 'user', `【${day} 日记素材】${truncate(chats, 1200)}`);
    appendCreationMessage(userId, characterId, conv.id, 'agent', safe.text, { bookId: existing.id });
    return { bookId: existing.id, type: 'diary', day, updated: true, words: meta.words, title, sessionId: conv.id };
  }
  const bookId = insertBook(userId, characterId, {
    type: 'diary',
    title,
    content: safe.text,
    day,
    meta,
    seriesId: `diary_${characterId}`,
    sessionId: conv.id,
  });
  appendCreationMessage(userId, characterId, conv.id, 'user', `【${day} 日记素材】${truncate(chats, 1200)}`);
  appendCreationMessage(userId, characterId, conv.id, 'agent', safe.text, { bookId });
  return { bookId, type: 'diary', day, updated: false, words: meta.words, title, sessionId: conv.id };
}

async function writeSerial(userId, characterId, character, settings, type) {
  const tags = (Array.isArray(settings.creationTags) ? settings.creationTags : [])
    .map((t) => String(t || '').trim())
    .filter(Boolean)
    .slice(0, 8);
  const day = dayKey();
  const seriesId = type === 'novel' ? `ser_${characterId}_novel` : `ser_${characterId}_essay_${uuid().replace(/-/g, '').slice(0, 8)}`;
  const titleKey = type === 'novel' ? `novel:${seriesId}` : `essay:${seriesId}`;
  const conv = ensureCreationConversation(userId, characterId, { titleKey });

  // 连载章节数：小说按 series 累计，散文每篇独立
  const chapterNo = type === 'novel'
    ? Number(get('SELECT COUNT(*) n FROM books WHERE user_id = ? AND character_id = ? AND series_id = ?', userId, characterId, seriesId)?.n || 0) + 1
    : 1;
  const previousRow = get(
    type === 'novel'
      ? "SELECT * FROM books WHERE user_id = ? AND character_id = ? AND type = 'novel' AND series_id = ? ORDER BY created_at DESC LIMIT 1"
      : "SELECT * FROM books WHERE user_id = ? AND character_id = ? AND type = 'essay' ORDER BY created_at DESC LIMIT 1",
    userId,
    characterId,
    ...(type === 'novel' ? [seriesId] : []),
  );
  const previous = previousRow ? truncate(safeDecrypt(userId, previousRow.content), 1200) : '';
  const summary = conversationSummary(userId, conv) || recentSessionText(userId, conv.id, 2);
  const news = todayNewsDigest(userId, characterId, day);
  const newsText = news.length ? news.map((n) => `${n.title}：${truncate(n.content, 300)}`).join('\n') : '';

  const generated = await generateCreation({
    userId,
    characterId,
    type,
    character,
    tags,
    chapterNo,
    summary,
    previous: type === 'novel' ? previous : '',
    newsText,
    hasPrevious: Boolean(previous),
  });

  const safe = sanitizeCreation(truncateForModel(generated.content, generated.model || 'gpt-4o-mini', STYLE[type].truncateRatio));
  const content = safe.text;
  const words = countChars(content);
  const meta = {
    tags,
    words,
    chapter: chapterNo,
    model: generated.model,
    attempts: generated.attempt,
    filtered: safe.filtered,
    short: words < STYLE[type].minChars,
    summary: generated.summary,
    sessionTitle: conv.title,
  };
  const bookId = insertBook(userId, characterId, {
    type,
    title: generated.title,
    content,
    day,
    meta,
    seriesId,
    sessionId: conv.id,
  });

  appendCreationMessage(
    userId,
    characterId,
    conv.id,
    'user',
    `【第 ${chapterNo} 章任务】标签：${tags.join('、') || '随想'}${summary ? `\n前情摘要：${truncate(summary, 600)}` : ''}`,
  );
  appendCreationMessage(userId, characterId, conv.id, 'agent', content, { bookId, chapter: chapterNo });
  const compression = await maybeCompressSession(userId, characterId, conv.id);

  if (meta.short) log.warn('创作仍不足字数下限', { userId, characterId, type, words, min: STYLE[type].minChars });
  return {
    bookId,
    type,
    day,
    words,
    title: generated.title,
    seriesId,
    sessionId: conv.id,
    chapter: chapterNo,
    attempts: generated.attempt,
    compression: compression ? { compressed: Boolean(compression.compressed), dropped: compression.dropped || 0 } : null,
  };
}

/**
 * 统一创作处理器：payload.type = diary | novel | essay。
 * 失败只记录日志返回 null；软/硬限额返回 {skipped:true}；角色关闭直接跳过。
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
      return { skipped: true, reason: 'unknown_type', type };
    }
    const character = getCharacter(userId, characterId);
    if (!character) {
      log.warn('创作任务找不到角色', { userId, characterId });
      return { skipped: true, reason: 'character_not_found', type };
    }
    if (character.settings?.enabled === false) {
      log.debug('角色已关闭，跳过创作', { userId, characterId, type });
      return { skipped: true, reason: 'character_disabled', type };
    }
    const limit = limitState(userId);
    if (limit.state !== 'ok') {
      log.warn('限额生效，跳过创作', { userId, characterId, type, state: limit.state });
      return { skipped: true, reason: `${limit.state}_limit`, type };
    }
    const settings = getSettings(characterId, userId);

    // 幂等保护：日记每天一篇，重复排队直接跳过（除非显式 force 重写）
    if (type === 'diary' && body.force !== true) {
      const existing = get(
        "SELECT id FROM books WHERE user_id = ? AND character_id = ? AND type = 'diary' AND day = ? LIMIT 1",
        userId,
        characterId,
        dayKey(),
      );
      if (existing) return { skipped: true, reason: 'diary_exists', type, bookId: existing.id };
    }

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
        : await writeSerial(userId, characterId, character, settings, type);

    if (!result) {
      log.warn('创作结果为空，未写入书架', { userId, characterId, type });
      return null;
    }
    log.info('创作完成', { userId, characterId, type, words: result.words, chapter: result.chapter || null });
    return { ok: true, ...result };
  } catch (err) {
    log.warn('创作失败', err?.message, { userId, characterId, type });
    return null;
  }
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

/** 供调度器：按频率挑选该角色当前可跑的创作类型 */
export function nextCreationType(settings = {}) {
  const freq = String(settings.creationFrequency || 'daily');
  if (freq === 'off') return null;
  return 'diary';
}

export default { runCreation, sanitizeCreation, truncateForModel, creationDue, nextCreationType, countChars, ensureCreationConversation };
