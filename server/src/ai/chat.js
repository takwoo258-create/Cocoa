// AI 对话主链路编排（build.md 一.2/3、二、四、七.5）
//
// 一次用户消息的生命周期：
//   校验（角色归属 / Token 限额 / 无 key 降级）
//   → 多模态分步（语音=图片>文字：STT / 视觉描述先转文字，失败降级占位）
//   → 落库（content/meta 双层加密）
//   → 作息判定（午睡/夜间睡眠：固定文案 + 模型 wakeup 0/1）
//   → 压缩/忙碌排队（排队期间 WS 推送「在回味之前的记忆喵~」）
//   → 句子完整性检查（yes 直接生成；no 等 30s，可被新消息取消）
//   → 生成（思考模式 / JSON 协议 / 分段 jobs / TTS 语音回复）
//   → 主动回复等待期（60-80s）与上下文占用巡检（≥85% 回复后压缩）
import fs from 'node:fs';
import path from 'node:path';
import { get, run, getMeta } from '../db/index.js';
import env from '../env.js';
import logger from '../core/logger.js';
import { badRequest, notFound } from '../core/errors.js';
import { nowIso, uuid, clamp, sleep } from '../core/util.js';
import { encryptText, decryptText, encryptJson, decryptJson } from '../core/crypto.js';
import { broadcast } from '../realtime/hub.js';
import { getCharacter, getSettings, ensureState, updateState, defaultCharacterId } from '../services/characters.js';
import { getPrefs, getUserApi } from '../services/settings.js';
import { enqueue, cancelJobs, nextJob, jobPayload } from '../services/jobs.js';
import { recordUsage } from './usage.js';
import { parseReply, clampSendSec } from './reply.js';
import { checkSentenceComplete, needsSentenceCheck, sentenceWaitDueMs } from './sentence.js';
import {
  ensureMainConversation,
  getConversation,
  usageInfo,
  limitState,
  refreshConversationUsage,
  promptHistory,
  shapeMessage,
  estimateTextTokens,
  setCompressing,
  isCompressing,
  listMessages,
  COMPRESS_THRESHOLD,
} from './context.js';
import { compressConversation } from './compress.js';
import { effectiveSleep, sleepNotice, refreshStatus } from './status.js';
import { markAgentSent, markUserReplied, judgeWakeup } from './active.js';
import * as defaultProvider from './provider.js';

// ---------------- 可注入 provider（单测离线用） ----------------

let providerOverride = null;

export function setChatProvider(next) {
  providerOverride = next || null;
}

export function getChatProvider() {
  return providerOverride || defaultProvider;
}

// ---------------- 固定文案 ----------------

export const NOTICES = {
  hardLimit: 'Token 已达硬性限额，角色服务已暂停',
  softLimit: 'Token 已达到软性限额，创作与新闻服务已暂停',
  compressing: '在回味之前的记忆喵~',
  noApi: '尚未配置对话模型，请前往配置页填写 API Key 与地址',
  voiceFailed: '语音转写失败，已按文字占位继续喵~',
  imageFailed: '图片识别失败，已按文字占位继续喵~',
};

export const THINKING_TRIGGERS = /(再仔细想一想|仔细想一想|再想想|再思考一下|重新思考|思考一下|好好想想|认真想想|动动脑子|用脑子想想|重新想一遍|think again|think carefully|rethink)/i;

export function shouldThink(text, prefs = null) {
  if (prefs && prefs.thinking) return true;
  return THINKING_TRIGGERS.test(String(text || ''));
}

// ---------------- 网页搜索（build.md 二.12） ----------------

export const SEARCH_INTENT_RE =
  /(搜一下|搜索|查一下|查查|帮我查|最新消息|今天发生|最近新闻|网上说|网上查|是真的吗|百度|谷歌|search|look up|google it)/i;
export const URL_RE = /https?:\/\/[^\s<>"'）】]+/i;
export const SEARCH_NOTICE = '网页搜索还没设置哦，请前往 Cocoa 配置 DeepSeek API Key';

/** 是否需要联网：命中搜索意图，或消息里含 URL */
export function needsWebSearch(text) {
  const s = String(text || '');
  if (!s.trim()) return false;
  return SEARCH_INTENT_RE.test(s) || URL_RE.test(s);
}

/** 外部资料格式：- 标题｜摘要（url）；空结果返回 '' */
export function buildSearchContext(results = []) {
  const items = (Array.isArray(results) ? results : []).filter(
    (r) => r && (r.title || r.snippet || r.url),
  );
  if (!items.length) return '';
  const lines = items.slice(0, 6).map((r) => {
    const title = String(r.title || '（无标题）').replace(/\s+/g, ' ').trim().slice(0, 120);
    const snippet = String(r.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 180);
    const url = String(r.url || '').trim().slice(0, 300);
    return `- ${title}｜${snippet}（${url}）`;
  });
  return `外部资料（仅供你参考，不要照读）：\n${lines.join('\n')}`;
}

const searchNoticeConversations = new Set();
const searchNotices = [];

/** 供调试/单测观察已被提示过的搜索配置缺失（不参与业务逻辑） */
export function getSearchNotices() {
  return searchNotices.slice();
}

export function resetSearchNotices() {
  searchNotices.length = 0;
  searchNoticeConversations.clear();
}

async function gatherWebSearch({ userId, characterId, conversationId, text, provider = null }) {
  const query = String(text || '').trim();
  if (!needsWebSearch(query)) return null;
  const cfg = getUserApi(userId);
  if (!cfg.search?.apiKey) {
    // 未配置搜索：不中断回复，只提示一次（同一会话去重）
    if (!searchNoticeConversations.has(conversationId)) {
      searchNoticeConversations.add(conversationId);
      if (searchNoticeConversations.size > 1000) searchNoticeConversations.clear();
      broadcast(userId, { type: 'notice', content: SEARCH_NOTICE });
      searchNotices.push({ conversationId, content: SEARCH_NOTICE, at: nowIso() });
      if (searchNotices.length > 200) searchNotices.shift();
    }
    return null;
  }
  try {
    const prov = provider || getChatProvider();
    if (typeof prov.webSearch !== 'function') return null;
    // 8 秒超时：搜索失败/超时静默降级为无结果
    const data = await withTimeout(
      Promise.resolve(prov.webSearch(userId, query.slice(0, 300), { maxResults: 5 })),
      8_000,
      null,
    );
    if (!data) return null;
    recordUsage({
      userId,
      characterId,
      kind: 'search',
      model: data.model || cfg.search.model,
      usage: data.usage || {},
      cost: data.cost,
    });
    const context = buildSearchContext(data.results);
    if (!context) return null;
    return { context, query, results: data.results || [] };
  } catch (err) {
    logger.warn('网页搜索失败，按无结果继续', err?.message || err);
    return null;
  }
}


// ---------------- 运行时状态（进程内） ----------------

const runtimes = new Map();

function runtime(userId, characterId) {
  const key = `${userId}:${characterId}`;
  let s = runtimes.get(key);
  if (!s) {
    s = { busy: false, compressing: false, pending: [], lock: Promise.resolve() };
    runtimes.set(key, s);
  }
  return s;
}

export function resetRuntime() {
  runtimes.clear();
}

/** 该角色是否正在生成（看门狗据此避免重复触发） */
export function isGenerating(userId, characterId) {
  return Boolean(runtime(userId, characterId).busy);
}

function withLock(s, fn) {
  const run = s.lock.then(fn, fn);
  s.lock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ---------------- 多模态预处理 ----------------

function mediaRow(userId, characterId, mediaId) {
  if (!mediaId) return null;
  const row = get('SELECT * FROM media WHERE id = ? AND user_id = ?', String(mediaId), userId);
  if (!row) return null;
  if (row.character_id && row.character_id !== characterId) return null;
  return row;
}

/** media.path 可能是绝对路径或相对 mediaDir 的文件名 */
function resolveMediaPath(row) {
  const p = String(row?.path || '');
  if (!p) return null;
  if (path.isAbsolute(p) && fs.existsSync(p)) return p;
  const direct = path.join(env.mediaDir, p);
  if (fs.existsSync(direct)) return direct;
  const flat = path.join(env.mediaDir, path.basename(p));
  if (fs.existsSync(flat)) return flat;
  return null;
}

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.amr': 'audio/amr',
};

function mediaPriority(kind) {
  if (kind === 'voice') return 0; // 语音 = 图片 > 文字
  if (kind === 'image') return 1;
  return 2;
}

function mediaDataUrl(row) {
  const file = resolveMediaPath(row);
  if (!file) return null;
  const buf = fs.readFileSync(file);
  const mime = row.mime || MIME_BY_EXT[path.extname(file).toLowerCase()] || 'application/octet-stream';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/**
 * 语音/图片先转文字描述（语音=图片>文字），失败降级为占位文本。
 * @returns {Promise<{parts:string[], notices:string[], hasTranscript:boolean}>}
 */
export async function preprocessMedia({ userId, characterId, kind = 'text', mediaId = null, meta = null, provider = null } = {}) {
  const prov = provider || getChatProvider();
  const parts = [];
  const notices = [];
  let hasTranscript = false;

  const ids = [];
  if (mediaId) ids.push(String(mediaId));
  if (Array.isArray(meta?.mediaIds)) for (const id of meta.mediaIds) if (id) ids.push(String(id));
  const unique = [...new Set(ids)];
  const rows = unique.map((id) => mediaRow(userId, characterId, id)).filter(Boolean);
  rows.sort((a, b) => mediaPriority(a.kind) - mediaPriority(b.kind));

  for (const row of rows) {
    if (row.kind === 'voice') {
      const file = resolveMediaPath(row);
      if (!file) {
        parts.push('〔语音消息，文件缺失，按文字占位处理〕');
        notices.push(NOTICES.voiceFailed);
        continue;
      }
      try {
        const out = await prov.transcribe(userId, file);
        const text = String(out?.text || '').trim();
        if (text) {
          parts.push(`【语音转写】${text}`);
          hasTranscript = true;
        } else {
          parts.push('〔语音消息，未能识别内容〕');
          notices.push(NOTICES.voiceFailed);
        }
      } catch (err) {
        logger.warn('语音转写失败，降级为文字占位', err?.message || err);
        parts.push('〔语音消息，转写失败，按文字占位处理〕');
        notices.push(NOTICES.voiceFailed);
      }
      continue;
    }
    if (row.kind === 'image') {
      try {
        const dataUrl = mediaDataUrl(row);
        if (!dataUrl) throw new Error('图片文件缺失');
        const out = await prov.visionDescribe(userId, dataUrl);
        const desc = String(out?.text || '').trim();
        parts.push(desc ? `【图片描述】${desc}` : '〔图片消息，未识别出内容〕');
        if (!desc) notices.push(NOTICES.imageFailed);
      } catch (err) {
        logger.warn('图片识别失败，降级为文字占位', err?.message || err);
        parts.push('〔图片消息，识别失败，按文字占位处理〕');
        notices.push(NOTICES.imageFailed);
      }
    }
  }

  return { parts, notices, hasTranscript };
}

// ---------------- 消息落库 ----------------

function persistMessage({ userId, characterId, conversationId, role, kind, content, meta, tokensIn = 0, tokensOut = 0, createdAt = null }) {
  const id = `m_${uuid().replace(/-/g, '').slice(0, 16)}`;
  const now = createdAt || nowIso();
  run(
    'INSERT INTO messages(id, conversation_id, character_id, user_id, role, kind, content, meta, tokens_in, tokens_out, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    id,
    conversationId,
    characterId,
    userId,
    role,
    kind,
    encryptText(userId, String(content ?? '')),
    encryptJson(userId, meta || {}),
    Math.max(0, Math.round(tokensIn)),
    Math.max(0, Math.round(tokensOut)),
    now,
  );
  run('UPDATE conversations SET updated_at = ? WHERE id = ?', now, conversationId);
  return get('SELECT * FROM messages WHERE id = ?', id);
}

function broadcastMessage(userId, characterId, row) {
  const message = shapeMessage(userId, row);
  broadcast(userId, { type: 'message', characterId, message });
  return message;
}

function contextEvent(info) {
  return { type: 'context', used: info.used, limit: info.limit, percent: info.percent, compressing: info.compressing };
}

// ---------------- TTS 语音回复 ----------------

function saveVoiceMedia({ userId, characterId, buffer, mime }) {
  const type = String(mime || 'audio/mpeg');
  const ext = /mpeg|mp3/i.test(type) ? 'mp3' : /wav/i.test(type) ? 'wav' : /ogg/i.test(type) ? 'ogg' : /mp4|m4a/i.test(type) ? 'm4a' : 'bin';
  const id = `md_${uuid().replace(/-/g, '').slice(0, 16)}`;
  const filename = `${id}.${ext}`;
  fs.mkdirSync(env.mediaDir, { recursive: true });
  fs.writeFileSync(path.join(env.mediaDir, filename), buffer);
  run(
    'INSERT INTO media(id, user_id, character_id, kind, path, mime, size, created_at) VALUES(?,?,?,?,?,?,?,?)',
    id,
    userId,
    characterId,
    'voice',
    filename,
    type,
    buffer.length,
    nowIso(),
  );
  return { id, url: `/api/media/${id}`, mime: type, size: buffer.length };
}

/** 用户以语音发送时，用 Breeze TTS 合成回复语音；失败只记日志，不影响文字回复 */
async function maybeSynthesize({ userId, characterId, text }) {
  const prov = getChatProvider();
  if (typeof prov.synthesize !== 'function') return null;
  const content = String(text || '').trim();
  if (!content) return null;
  try {
    const out = await prov.synthesize(userId, content);
    if (!out?.buffer || !Buffer.isBuffer(out.buffer)) return null;
    return saveVoiceMedia({ userId, characterId, buffer: out.buffer, mime: out.mime });
  } catch (err) {
    logger.warn('TTS 合成失败，仅发送文字回复', err?.message || err);
    return null;
  }
}

function lastUserMessage(userId, conversationId) {
  return (
    get(
      "SELECT * FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1",
      conversationId,
    ) || null
  );
}

function detectVoiceReply(userId, conversationId) {
  const row = lastUserMessage(userId, conversationId);
  if (!row) return false;
  if (row.kind === 'voice') return true;
  const meta = row.meta ? decryptJson(userId, row.meta, null) : null;
  return Boolean(meta?.voice);
}

// ---------------- 提示词 ----------------

export function buildSystemPrompt({ character, state, summary = '', memory = '', thinking = false, segmentEnabled = true, sleepState = 'awake', userAddress = '' } = {}) {
  const time = new Date(Date.now() + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 16);
  return [
    `你是「${character.name}」，正在和你的${character.relation || '重要的人'}通过聊天软件聊天。`,
    '人物设定：',
    `- 姓名：${character.name}；年龄：${character.age || '未设定'}；种族：${character.race || '人类'}；性别：${character.gender || '未设定'}`,
    `- 性格：${character.personality || '未设定'}`,
    `- 世界观：${character.worldview || '未设定'}`,
    `- 爱好：${character.hobbies || '未设定'}`,
    `- 外观：${character.appearance || '未设定'}`,
    `- 职业：${character.occupation || '未设定'}`,
    `当前状态：动作「${state?.motion || '安静地待着'}」，心理「${state?.psychology || ''}」，心情「${state?.mood || '平静'}」，健康「${state?.health || '健康'}」，${sleepState === 'awake' ? '醒着' : sleepState === 'napping' ? '正在午睡' : '正在睡觉'}。`,
    `现在时间：${time}（UTC+8）。`,
    userAddress ? `你对用户的称呼：${userAddress}（请自然使用，不要生硬重复）` : '',
    summary ? `你记得之前聊过的事：\n${summary}` : '',
    memory ? `你记得关于对方的这些细节：\n${memory}` : '',
    '回复要求：先理解用户最后一条消息，直接回应其内容；不要答非所问，不要复述人物设定/状态/记忆。口语化、简短、自然，像真人发消息；不要长篇大论、列清单或说教；通常一两句话就够。',
    '必须只输出一个 JSON 对象，不要输出 JSON 以外的任何文字（不要代码块标记）。格式：',
    '{"type":"message","content":"完整回复","devide":1,"agent":[{"content":"第一段","wait":0}]}',
    '分段规则（重要）：如果回复自然包含两段以上内容、或需要停顿/连发，必须使用 agent 数组分段：devide 为段数，agent 每段 {content, wait}，wait 为该段排队秒数（1-3 的整数，第一段 0）；不要只输出 content。普通一句短回复才用单段。只有你（智能体）的消息允许分段。',
    '如果要主动发起话题而不是回应，使用：{"type":"subjective","content":"内容","sendsec":60}。',
    thinking ? '这次请先在心里认真思考再回答（可以反复推敲），但只输出最终 JSON，不要输出思考过程。' : '',
    segmentEnabled ? '' : '本次不要分段，只填 content 字段即可。',
  ]
    .filter(Boolean)
    .join('\n');
}

async function loadMemoryContext(userId, characterId, query) {
  try {
    const mod = await import('./memory.js');
    // ai-memory 约定 recallForChat(userId, characterId, query, {limit})；同时兼容对象入参与 searchMemories
    const fn = mod.recallForChat || mod.searchMemories || mod.buildChatMemory || mod.memoryContext || mod.recall;
    if (typeof fn !== 'function') return '';
    let out;
    try {
      out = await fn(userId, characterId, query, { limit: 6 });
    } catch {
      out = await fn({ userId, characterId, query, limit: 6 });
    }
    return normalizeMemoryContext(out);
  } catch {
    // 记忆线模块可能尚未就绪
    return '';
  }
}

/** 记忆召回结果归一化为提示词文本（兼容 string / array / {items} / {memories}） */
export function normalizeMemoryContext(out) {
  if (!out) return '';
  if (typeof out === 'string') return out.trim().slice(0, 2000);
  const items = Array.isArray(out)
    ? out
    : Array.isArray(out.items)
      ? out.items
      : Array.isArray(out.memories)
        ? out.memories
        : null;
  if (items) {
    return items
      .map((m) => {
        if (typeof m === 'string') return m;
        const content = String(m?.content ?? m?.preview ?? '').trim();
        if (!content) return '';
        return m?.big || m?.small ? `${m.big || ''}/${m.small || ''}：${content}` : content;
      })
      .filter(Boolean)
      .slice(0, 10)
      .join('\n')
      .slice(0, 2000);
  }
  if (typeof out.text === 'string') return out.text.slice(0, 2000);
  if (typeof out.content === 'string') return out.content.slice(0, 2000);
  return '';
}

// ---------------- 生成与发送 ----------------

function updateChatCounts(characterId, state) {
  try {
    updateState(characterId, {
      chatCount: Number(state?.chat_count || 0) + 1,
      chatSincePortrait: Number(state?.chat_count_since_portrait || 0) + 1,
    });
  } catch (err) {
    logger.warn('更新对话计数失败', err?.message);
  }
}

/**
 * 每次成功生成回复后排队记忆抽取（60 秒去抖；同角色已有 pending 则不重复排）。
 * payload.since 取记忆线维护的游标（memory:since:user:character），供 runMemoryExtraction 增量抽取。
 */
export function scheduleMemoryExtract({ userId, characterId, reason = 'user_message' } = {}) {
  if (!userId || !characterId) return null;
  // 主动消息/等待期超时不含新的用户表达，不需要抽取
  if (reason === 'active_timeout' || reason === 'active_reply' || reason === 'active_wait') return null;
  const pending = get(
    "SELECT id FROM jobs WHERE character_id = ? AND status = 'pending' AND type IN ('memory','memory_extract','memory_extraction') LIMIT 1",
    characterId,
  );
  if (pending) return null;
  const since = getMeta(`memory:since:${userId}:${characterId}`, null) || new Date(Date.now() - 3600_000).toISOString();
  return enqueue('memory_extract', new Date(Date.now() + 60_000).toISOString(), { since }, { userId, characterId });
}

async function afterAgentSent({ userId, characterId, conversation, state, reason = 'user_message' }) {
  updateChatCounts(characterId, state);
  refreshConversationUsage(conversation.id);
  const info = usageInfo(userId, characterId);
  broadcast(userId, contextEvent(info));
  const wait = markAgentSent({ userId, characterId });
  const memoryJobId = scheduleMemoryExtract({ userId, characterId, reason });
  let compression = null;
  if (info.limit > 0 && info.ratio >= COMPRESS_THRESHOLD) {
    compression = startCompression({ userId, characterId, conversationId: conversation.id });
  }
  return { wait, compression, usage: info, memoryJobId };
}

/** 智能体文字回复（含分段 jobs、可选 TTS 语音） */
/** v1.2.1：模型只给单段 content 时，按句子自动拆成 2-3 段，保证分段能力可见 */
export function autoSegmentParsed(parsed, segmentEnabled = true) {
  if (!parsed || parsed.type !== 'message' || !segmentEnabled) return parsed;
  const segs = Array.isArray(parsed.segments) ? parsed.segments.filter((x) => String(x?.content || '').trim()) : [];
  if (segs.length > 1) return parsed;
  const text = String(parsed.content || segs[0]?.content || '').trim();
  if (text.length < 36) return parsed;
  const parts = text.split(/(?<=[。！？!?…~～])\s*/).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return parsed;
  const target = Math.min(3, parts.length);
  const per = Math.ceil(parts.length / target);
  const groups = [];
  for (let i = 0; i < parts.length; i += per) groups.push(parts.slice(i, i + per).join(''));
  const limited = groups.slice(0, 3).filter(Boolean);
  if (limited.length < 2) return parsed;
  return {
    ...parsed,
    content: text,
    segments: limited.map((content, idx) => ({ content, wait: idx === 0 ? 0 : Math.min(2, idx) })),
    devide: limited.length,
  };
}

async function sendAgentReply({ userId, characterId, conversation, state, parsed, thinking, reason, voiceReply, reasoning = '' }) {
  const segments = (parsed.segments || []).filter((s) => String(s.content || '').trim());
  if (!segments.length) return { ok: false, sent: false, reason: 'empty_reply' };

  const wantsVoice = voiceReply == null ? detectVoiceReply(userId, conversation.id) : Boolean(voiceReply);
  const fullText = String(parsed.content || segments.map((s) => s.content).join('')).trim();
  const voice = wantsVoice ? await maybeSynthesize({ userId, characterId, text: fullText }) : null;

  const thinkingText = String(reasoning || '').trim().slice(0, 4_000);
  const meta = {
    segment: 1,
    segments: segments.length,
    wait: segments[0].wait || 0,
    thinkingMode: Boolean(thinking),
    ...(thinkingText ? { thinking: thinkingText } : {}),
    reason,
    ...(voice ? { voiceMediaId: voice.id, voiceUrl: voice.url, voiceMime: voice.mime } : {}),
  };
  const row = persistMessage({
    userId,
    characterId,
    conversationId: conversation.id,
    role: 'agent',
    kind: 'text',
    content: segments[0].content,
    meta,
    tokensOut: estimateTextTokens(segments[0].content),
  });
  broadcastMessage(userId, characterId, row);

  // v1.2.1：分段一次性推送，客户端按每段 wait 依次显示。
  // 旧实现用调度任务（30s 轮询）会严重延迟甚至丢段，导致“分段未实现”。
  for (let i = 1; i < segments.length; i++) {
    const segmentMeta = {
      segment: i + 1,
      segments: segments.length,
      wait: clamp(segments[i].wait || 0, 0, 8),
      thinkingMode: Boolean(thinking),
      reason,
    };
    const segRow = persistMessage({
      userId,
      characterId,
      conversationId: conversation.id,
      role: 'agent',
      kind: 'text',
      content: segments[i].content,
      meta: segmentMeta,
      tokensOut: estimateTextTokens(segments[i].content),
      createdAt: new Date(Date.now() + i * 2).toISOString(),
    });
    broadcastMessage(userId, characterId, segRow);
  }
  refreshConversationUsage(conversation.id);

  const after = await afterAgentSent({ userId, characterId, conversation, state, reason });
  return {
    ok: true,
    sent: true,
    messageId: row.id,
    content: fullText,
    segments: segments.length,
    thinking: Boolean(thinking),
    thinkingText: thinkingText || null,
    voiceMediaId: voice?.id || null,
    voiceUrl: voice?.url || null,
    ...after,
  };
}

async function handleParsedReply({ userId, characterId, conversation, state, parsed, thinking, reason, voiceReply, reasoning = '' }) {
  if (parsed.type === 'subjective') {
    return deliverSubjective({
      userId,
      characterId,
      conversationId: conversation.id,
      content: parsed.content,
      sendsec: parsed.sendsec,
    });
  }
  if (parsed.type === 'status') {
    const nextState = {
      motion: parsed.fields?.motion || state?.motion || '',
      psychology: parsed.fields?.psychology || state?.psychology || '',
      mood: parsed.fields?.mood || state?.mood || '',
      health: parsed.fields?.health || state?.health || '',
    };
    updateState(characterId, nextState);
    broadcast(userId, { type: 'state', characterId, state: { ...nextState, updatedAt: nowIso() } });
    return { ok: true, sent: false, type: 'status', state: nextState };
  }
  if (parsed.type === 'profile') {
    broadcast(userId, { type: 'profile', characterId, content: parsed.content });
    return { ok: true, sent: false, type: 'profile', content: parsed.content };
  }
  if (parsed.type === 'wakeup') {
    return { ok: true, sent: false, type: 'wakeup', wakeup: parsed.wakeup };
  }
  return sendAgentReply({ userId, characterId, conversation, state, parsed, thinking, reason, voiceReply, reasoning });
}

// ---------------- 回复可靠性（v1.0.1） ----------------

export const STRICT_REPLY_INSTRUCTION = [
  '上一次回复没有产生可发送的消息（空内容、只有思考过程或被截断）。',
  '现在请严格重新输出一个 JSON 对象，content 必须是非空文本：',
  '{"type":"message","content":"你要说的内容"}',
  '不要输出思考过程、不要输出空字符串、不要使用代码块或额外解释。',
].join('\n');

export const FALLBACK_REPLY_TEXT = '我在听，刚刚没听清，你再说一遍好吗？';
export const PLAIN_REPLY_INSTRUCTION = '忽略上一条消息里的 JSON 格式要求。现在直接用角色口吻回复用户最后一条消息，1-3 句口语化中文；不要输出 JSON、Markdown、代码块、括号说明或任何解释。';

function stripCodeFence(text = '') {
  return String(text).replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();
}

/** 该解析结果是否可以真正发给用户 */
export function replyIsUsable(parsed, reason = 'user_message') {
  if (!parsed) return false;
  const content = String(parsed.content || '').trim();
  const segments = Array.isArray(parsed.segments)
    ? parsed.segments.filter((seg) => String(seg?.content || '').trim())
    : [];
  if (parsed.type === 'message') return Boolean(content || segments.length);
  if (parsed.type === 'subjective') {
    return ['active_timeout', 'active_reply'].includes(reason) && Boolean(content);
  }
  return false;
}

/** 是否需要重试：空内容 / 非 message 类型 / 截断 / 只有 reasoning */
export function replyNeedsRetry(res, parsed, reason = 'user_message') {
  if (!res) return true;
  if (res.finishReason === 'length') return true;
  const text = String(res.text || '').trim();
  if (!text && String(res.reasoning || '').trim()) return true;
  return !replyIsUsable(parsed, reason);
}

function broadcastTyping(userId, characterId, typing, stage = null) {
  const event = { type: 'typing', characterId, typing: Boolean(typing) };
  if (typing && stage) event.stage = stage;
  broadcast(userId, event);
}

/** 主模型调用：provider 抛错时 1.5s 后重试一次，两次都失败则抛给上层广播 error */
async function callMainModel({ prov, userId, characterId, messages, thinking, maxTokens = 1200 }) {
  const request = { task: 'main', messages, temperature: 0.85, maxTokens, thinking, json: true };
  try {
    const res = await prov.chatText(userId, request);
    recordUsage({ userId, characterId, kind: 'main', model: res?.model, usage: res?.usage || {}, cost: res?.cost });
    return res;
  } catch (err) {
    logger.warn('对话模型调用失败，1.5 秒后重试一次', err?.message || err);
    await sleep(1_500);
    const res = await prov.chatText(userId, request);
    recordUsage({ userId, characterId, kind: 'main', model: res?.model, usage: res?.usage || {}, cost: res?.cost });
    return res;
  }
}

async function generateOnce(opts, s) {
  const {
    userId,
    characterId,
    reason = 'user_message',
    triggerText = '',
    extraInstruction = '',
    thinking = null,
    voiceReply = null,
    conversationId = null,
    provider = null,
  } = opts;

  const character = getCharacter(userId, characterId);
  if (!character) return { ok: false, reason: 'character_not_found' };

  const limits = limitState(userId);
  if (limits.hardLimited) {
    broadcast(userId, { type: 'notice', content: NOTICES.hardLimit });
    return { ok: false, reason: 'hard_limit' };
  }

  const prov = provider || getChatProvider();
  const prefs = getPrefs(userId);
  const conversation = conversationId ? getConversation(conversationId) : ensureMainConversation(userId, characterId);
  if (!conversation) return { ok: false, reason: 'conversation_not_found' };
  const state = ensureState(characterId, userId);
  const useThinking = thinking == null ? shouldThink(triggerText, prefs) : Boolean(thinking);
  const segmentEnabled = prefs.segmentEnabled !== false;
  const sleep = effectiveSleep(character, state, new Date());

  s.busy = true;
  broadcastTyping(userId, characterId, true, 'replying');
  try {
    const summary = conversation.summary ? decryptText(userId, conversation.summary) : '';
    const memory = await loadMemoryContext(userId, characterId, triggerText);
    const search = await gatherWebSearch({
      userId,
      characterId,
      conversationId: conversation.id,
      text: triggerText,
      provider: prov,
    });
    const userRow = get('SELECT * FROM users WHERE id = ?', userId);
    const nickname = String(userRow?.nickname || userRow?.username || '').trim();
    const userAddress = String(character.settings?.userAddress || '').trim() || nickname;
    const history = promptHistory(userId, conversation.id, 30);
    const messages = [
      {
        role: 'system',
        content: buildSystemPrompt({
          character,
          state,
          summary,
          memory,
          thinking: useThinking,
          segmentEnabled,
          sleepState: sleep.mode,
          userAddress,
        }),
      },
    ];
    if (search?.context) messages.push({ role: 'system', content: search.context });
    messages.push(...history);
    if (extraInstruction) messages.push({ role: 'system', content: extraInstruction });

    let res = await callMainModel({
      prov,
      userId,
      characterId,
      messages,
      thinking: useThinking,
    });
    let parsed = parseReply(res?.text ?? '', { segmentEnabled });
    let retried = false;
    let reasoningText = String(res?.reasoning || '').trim();

    if (replyNeedsRetry(res, parsed, reason)) {
      logger.warn('模型回复为空或无效，使用严格指令重试一次', {
        reason,
        finishReason: res?.finishReason || null,
        textLength: String(res?.text || '').length,
        hasReasoning: Boolean(res?.reasoning),
      });
      try {
        res = await prov.chatText(userId, {
          task: 'main',
          messages: [...messages, { role: 'system', content: STRICT_REPLY_INSTRUCTION }],
          temperature: 0.7,
          maxTokens: 2_000,
          thinking: false,
          json: true,
        });
        recordUsage({ userId, characterId, kind: 'main', model: res?.model, usage: res?.usage || {}, cost: res?.cost });
        parsed = parseReply(res?.text ?? '', { segmentEnabled });
        const retryReasoning = String(res?.reasoning || '').trim();
        if (retryReasoning) reasoningText = retryReasoning;
        retried = true;
      } catch (err) {
        logger.warn('空回复重试失败，使用兜底文案', err?.message || err);
      }
    }

    // 二次兜底：部分模型无法稳定输出 JSON，改用纯文本口吻再请求一次
    if (replyNeedsRetry(res, parsed, reason)) {
      try {
        const plainRes = await prov.chatText(userId, {
          task: 'main',
          messages: [...messages, { role: 'system', content: PLAIN_REPLY_INSTRUCTION }],
          temperature: 0.8,
          maxTokens: 900,
          thinking: false,
          json: false,
        });
        recordUsage({ userId, characterId, kind: 'main', model: plainRes?.model, usage: plainRes?.usage || {}, cost: plainRes?.cost });
        const plainText = stripCodeFence(plainRes?.text || '');
        let plainParsed = parseReply(plainText, { segmentEnabled: false });
        if (!replyIsUsable(plainParsed, reason) && plainText && !/^[{[]/.test(plainText)) {
          plainParsed = {
            type: 'message',
            content: plainText,
            segments: [{ content: plainText, wait: 0 }],
            devide: 1,
            wait: 0,
            parsed: false,
            fallback: false,
          };
        }
        if (replyIsUsable(plainParsed, reason)) {
          res = plainRes;
          parsed = plainParsed;
          retried = true;
          const rescueReasoning = String(plainRes?.reasoning || '').trim();
          if (rescueReasoning) reasoningText = rescueReasoning;
          logger.info('JSON 回复不可用，已用纯文本回复兜底', {
            reason,
            textLength: String(plainText).length,
          });
        }
      } catch (err) {
        logger.warn('纯文本兜底请求失败', err?.message || err);
      }
    }

    let usedReason = reason;
    let fallback = false;
    if (replyNeedsRetry(res, parsed, reason)) {
      // 重试后仍不可用：绝不静默丢弃，落一条温和兜底消息
      logger.error('模型连续两次未产出可用回复，写入兜底消息', {
        reason,
        finishReason: res?.finishReason || null,
        rawText: String(res?.text || '').slice(0, 300),
      });
      fallback = true;
      usedReason = 'fallback';
      parsed = {
        type: 'message',
        content: FALLBACK_REPLY_TEXT,
        segments: [{ content: FALLBACK_REPLY_TEXT, wait: 0 }],
        devide: 1,
        wait: 0,
        parsed: false,
        fallback: true,
      };
    }

    parsed = autoSegmentParsed(parsed, segmentEnabled);
    const out = await handleParsedReply({
      userId,
      characterId,
      conversation,
      state,
      parsed,
      thinking: useThinking,
      reason: usedReason,
      voiceReply,
      reasoning: reasoningText,
    });
    return {
      ...out,
      thinking: useThinking,
      model: res?.model || null,
      parsed,
      search: Boolean(search?.context),
      retried,
      fallback,
      reasoning: reasoningText || null,
    };
  } catch (err) {
    logger.warn('对话生成失败', err?.message || err);
    broadcast(userId, {
      type: 'error',
      characterId,
      code: err?.code || 'upstream_error',
      message: err?.message || '模型服务异常',
    });
    return { ok: false, reason: 'generation_failed', error: err?.message || 'upstream_error', code: err?.code };
  } finally {
    s.busy = false;
    broadcastTyping(userId, characterId, false);
    // 释放锁之后再处理排队消息（drain 内部会重新排队生成）
    Promise.resolve().then(() => drainPending({ userId, characterId })).catch(() => {});
  }
}

/**
 * 生成一次回复（同一角色串行）。供被动回复、主动消息、等待期超时、唤醒复用。
 */
export async function runGeneration(opts = {}) {
  const { userId, characterId } = opts;
  if (!userId || !characterId) return { ok: false, reason: 'invalid_arguments' };
  const s = runtime(userId, characterId);
  return withLock(s, () => generateOnce(opts, s));
}

/** 压缩期间/生成期间排队的用户消息：压缩或上一条回复结束后只回最新一条（全部消息都在历史里） */
async function drainPending({ userId, characterId }) {
  const s = runtime(userId, characterId);
  if (s.busy || s.compressing) return { ok: false, reason: 'busy' };
  const ids = s.pending.splice(0);
  if (!ids.length) return { ok: false, reason: 'empty_queue' };
  const lastId = ids[ids.length - 1];
  const row = get('SELECT * FROM messages WHERE id = ?', lastId);
  if (!row) return { ok: false, reason: 'message_missing' };
  const conv = getConversation(row.conversation_id) || ensureMainConversation(userId, characterId);
  return runGeneration({
    userId,
    characterId,
    conversationId: conv.id,
    reason: 'queued_message',
    triggerText: decryptText(userId, row.content),
    voiceReply: row.kind === 'voice',
  });
}

/** 压缩任务入队 + 提示用户 */
export function startCompression({ userId, characterId, conversationId }) {
  const s = runtime(userId, characterId);
  if (s.compressing || isCompressing(conversationId)) return { scheduled: false, reason: 'already_compressing' };
  s.compressing = true;
  setCompressing(conversationId, true);
  broadcast(userId, { type: 'notice', characterId, content: NOTICES.compressing });
  const info = usageInfo(userId, characterId);
  broadcast(userId, contextEvent(info));
  cancelJobs(characterId, 'context_compress');
  const jobId = enqueue('context_compress', nowIso(), { conversationId }, { userId, characterId });
  return { scheduled: true, jobId };
}

/** 调度器执行压缩任务：完成后处理排队消息 */
export async function runCompression({ userId, characterId, conversationId, provider = null, keepRecent = undefined } = {}) {
  const s = runtime(userId, characterId);
  s.compressing = true;
  setCompressing(conversationId, true);
  let out;
  try {
    out = await compressConversation({
      userId,
      characterId,
      conversationId,
      ...(keepRecent ? { keepRecent } : {}),
      provider: provider || getChatProvider(),
    });
  } catch (err) {
    logger.warn('上下文压缩失败', err?.message || err);
    out = { ok: false, reason: 'compress_failed', error: err?.message || 'unknown' };
  } finally {
    s.compressing = false;
    setCompressing(conversationId, false);
  }
  const info = usageInfo(userId, characterId);
  broadcast(userId, contextEvent(info));
  const drained = await drainPending({ userId, characterId });
  return { ...out, usage: info, drained: drained?.ok === true };
}

/** 主动消息：sendsec>0 时排任务，到点发送；sendsec=0 立即发送 */
export async function deliverSubjective({ userId, characterId, content, sendsec = 0, conversationId = null } = {}) {
  const text = String(content || '').trim();
  if (!text) return { ok: false, reason: 'empty_content' };
  const character = getCharacter(userId, characterId);
  if (!character) return { ok: false, reason: 'character_not_found' };
  const limits = limitState(userId);
  if (limits.hardLimited) return { ok: false, reason: 'hard_limit' };

  const conversation = conversationId ? getConversation(conversationId) : ensureMainConversation(userId, characterId);
  const delay = clampSendSec(sendsec, 0);
  if (delay > 0) {
    cancelJobs(characterId, 'active_reply');
    const jobId = enqueue(
      'active_reply',
      new Date(Date.now() + delay * 1000).toISOString(),
      { kind: 'subjective', content: text, sendsec: delay },
      { userId, characterId },
    );
    broadcast(userId, { type: 'subjective', characterId, content: text, sendsec: delay });
    return { ok: true, scheduled: true, sendsec: delay, jobId };
  }

  const state = ensureState(characterId, userId);
  const row = persistMessage({
    userId,
    characterId,
    conversationId: conversation.id,
    role: 'agent',
    kind: 'text',
    content: text,
    meta: { segment: 1, segments: 1, wait: 0, subjective: true },
    tokensOut: estimateTextTokens(text),
  });
  broadcastMessage(userId, characterId, row);
  const after = await afterAgentSent({ userId, characterId, conversation, state, reason: 'active_reply' });
  return { ok: true, sent: true, messageId: row.id, content: text, ...after };
}

// ---------------- 任务处理器（scheduler 调用） ----------------

export async function handleSegmentSend({ userId, characterId, payload = {} } = {}) {
  const conversation = getConversation(payload.conversationId) || ensureMainConversation(userId, characterId);
  const content = String(payload.content || '').trim();
  if (!content) return { ok: false, reason: 'empty_segment' };
  const row = persistMessage({
    userId,
    characterId,
    conversationId: conversation.id,
    role: 'agent',
    kind: 'text',
    content,
    meta: {
      segment: payload.segment || 1,
      segments: payload.segments || 1,
      wait: payload.wait || 0,
    },
    tokensOut: estimateTextTokens(content),
  });
  broadcastMessage(userId, characterId, row);
  refreshConversationUsage(conversation.id);
  return { ok: true, messageId: row.id };
}

export async function handleSentenceWait({ userId, characterId, payload = {} } = {}) {
  const row = payload.messageId ? get('SELECT * FROM messages WHERE id = ?', payload.messageId) : null;
  if (!row) return { ok: false, reason: 'message_missing' };
  const newer = get(
    "SELECT id FROM messages WHERE conversation_id = ? AND role = 'user' AND created_at > ? ORDER BY created_at DESC LIMIT 1",
    row.conversation_id,
    row.created_at,
  );
  if (newer) return { ok: false, reason: 'superseded' };
  return runGeneration({
    userId,
    characterId,
    conversationId: row.conversation_id,
    reason: 'sentence_wait',
    triggerText: decryptText(userId, row.content),
    voiceReply: row.kind === 'voice',
  });
}

export async function handleWakeJudge({ userId, characterId, payload = {}, provider = null } = {}) {
  return judgeWakeup({ userId, characterId, text: payload.text || '', provider: provider || getChatProvider() });
}

// ---------------- 用户消息入口 ----------------

/**
 * App / OneBot 统一的用户消息入口。
 * 无 API key、硬限额、休眠时返回 accepted:false + notice（不抛 500）。
 */
export async function submitUserMessage({
  userId,
  characterId,
  content = '',
  kind = 'text',
  mediaId = null,
  meta = null,
  source = 'app',
} = {}) {
  if (!userId) throw badRequest('缺少用户身份', 'user_required');
  const character = getCharacter(userId, characterId);
  if (!character) throw notFound('角色不存在或不属于当前用户', 'character_not_found');

  const limits = limitState(userId);
  if (limits.hardLimited) {
    broadcast(userId, { type: 'notice', content: NOTICES.hardLimit });
    return { accepted: false, queued: false, notice: NOTICES.hardLimit, messageId: null, reason: 'hard_limit' };
  }

  const cfg = getUserApi(userId);
  if (!cfg.chat?.apiKey) {
    broadcast(userId, { type: 'error', code: 'api_not_configured', message: NOTICES.noApi });
    return {
      accepted: false,
      queued: false,
      notice: NOTICES.noApi,
      messageId: null,
      reason: 'api_not_configured',
      error: { code: 'api_not_configured', message: NOTICES.noApi },
    };
  }

  const mediaKind = kind === 'image' || kind === 'voice' ? kind : 'text';
  if (mediaKind !== 'text' && !mediaId && !(Array.isArray(meta?.mediaIds) && meta.mediaIds.length)) {
    throw badRequest('图片/语音消息需要先上传媒体文件', 'media_required');
  }

  const prov = getChatProvider();
  const media = await preprocessMedia({ userId, characterId, kind: mediaKind, mediaId, meta, provider: prov });
  for (const notice of media.notices) broadcast(userId, { type: 'notice', characterId, content: notice });

  const text = String(content ?? '').trim();
  const parts = [...media.parts];
  if (text) parts.push(text);
  const merged = parts.join('\n').trim();
  if (!merged) throw badRequest('消息内容不能为空', 'content_required');

  const settings = character.settings || getSettings(characterId, userId);
  const state = ensureState(characterId, userId);
  const sleep = effectiveSleep(character, state, new Date());
  const conversation = ensureMainConversation(userId, characterId);

  const userMeta = {
    ...(meta && typeof meta === 'object' ? meta : {}),
    source,
    kind: mediaKind,
    mediaId: mediaId || null,
    mediaParts: media.parts.length,
    sleepState: sleep.mode,
    clientTs: meta?.clientTs || null,
  };
  const row = persistMessage({
    userId,
    characterId,
    conversationId: conversation.id,
    role: 'user',
    kind: mediaKind,
    content: merged,
    meta: userMeta,
    tokensIn: estimateTextTokens(merged),
  });
  const userMessage = shapeMessage(userId, row);

  // 用户发消息 = 结束等待期，取消尚未发出的主动消息
  markUserReplied({ userId, characterId });
  cancelJobs(characterId, 'segment_send');

  if (sleep.mode !== 'awake') {
    const notice = sleepNotice(character.name, sleep.mode);
    broadcast(userId, { type: 'notice', characterId, content: notice });
    const jobId = enqueue(
      'wake_judge',
      nowIso(),
      { messageId: row.id, text: merged, mode: sleep.mode },
      { userId, characterId },
    );
    return {
      accepted: false,
      queued: false,
      notice,
      messageId: row.id,
      userMessage,
      reason: 'sleep',
      sleepState: sleep.mode,
      wakeJobId: jobId,
    };
  }

  const s = runtime(userId, characterId);
  const info = usageInfo(userId, characterId);

  if (s.compressing || isCompressing(conversation.id)) {
    s.pending.push(row.id);
    return {
      accepted: true,
      queued: true,
      notice: NOTICES.compressing,
      messageId: row.id,
      userMessage,
      reason: 'compressing',
      usage: info,
    };
  }

  if (info.limit > 0 && info.ratio >= COMPRESS_THRESHOLD) {
    s.pending.push(row.id);
    startCompression({ userId, characterId, conversationId: conversation.id });
    return {
      accepted: true,
      queued: true,
      notice: NOTICES.compressing,
      messageId: row.id,
      userMessage,
      reason: 'compress_scheduled',
      usage: info,
    };
  }

  if (s.busy) {
    s.pending.push(row.id);
    return {
      accepted: true,
      queued: true,
      notice: null,
      messageId: row.id,
      userMessage,
      reason: 'busy',
      usage: info,
    };
  }

  // 句子完整性检查：App 通道强制执行 30s 等待（连续输入总等待上限 60s）；OneBot 直接生成
  let sentence = { complete: true, verdict: 'yes', failed: false };
  let sentenceCapped = false;
  if (source !== 'onebot' && needsSentenceCheck({ kind: mediaKind, text, hasTranscript: media.hasTranscript })) {
    const pendingSentence = nextJob(characterId, 'sentence_wait');
    const pendingPayload = pendingSentence ? jobPayload(pendingSentence) : null;
    // 同一段连续输入从第一条 incomplete 起算，总等待不超过 60s
    const firstAt = Number(pendingPayload?.firstAt) > 0 ? Number(pendingPayload.firstAt) : Date.now();
    cancelJobs(characterId, 'sentence_wait');
    broadcastTyping(userId, characterId, true, 'checking');
    sentence = await checkSentenceComplete(userId, text, { provider: prov });
    if (!sentence.complete) {
      const now = Date.now();
      const due = sentenceWaitDueMs({ now, firstAt });
      if (due <= now + 25) {
        // 已达到 60s 总等待上限：不再排队，直接生成
        sentenceCapped = true;
        logger.debug('句子等待达到总上限，直接生成', { characterId, firstAt, now });
      } else {
        enqueue(
          'sentence_wait',
          new Date(due).toISOString(),
          { messageId: row.id, firstAt, voiceReply: mediaKind === 'voice' },
          { userId, characterId },
        );
        broadcastTyping(userId, characterId, true, 'waiting');
        return {
          accepted: true,
          queued: true,
          notice: null,
          messageId: row.id,
          userMessage,
          reason: 'sentence_wait',
          sentence,
          firstAt,
          dueAt: new Date(due).toISOString(),
        };
      }
    }
  }

  const waitForReply = runGeneration({
    userId,
    characterId,
    conversationId: conversation.id,
    reason: source === 'onebot' ? 'onebot' : sentenceCapped ? 'sentence_wait' : 'user_message',
    triggerText: text || merged,
    provider: prov,
    voiceReply: mediaKind === 'voice',
  });

  return {
    accepted: true,
    queued: false,
    notice: null,
    messageId: row.id,
    userMessage,
    reason: 'generating',
    ...(sentenceCapped ? { capped: true } : {}),
    sentence,
    waitForReply,
  };
}

// ---------------- OneBot ----------------

/**
 * OneBot（QQ）入口：复用与 App 相同的管线，返回同步文本回复。
 * @returns {Promise<{ok:boolean, reply?:string, reason?:string, userMessage?:object}>}
 */
export async function handleOnebotIncoming({ qq = null, text = '', userId = null, messageType = 'text', event = null } = {}) {
  const digits = String(qq ?? event?.user_id ?? event?.sender?.user_id ?? '').trim();
  let user = userId ? get('SELECT * FROM users WHERE id = ?', String(userId)) : null;
  if (!user && digits) user = get('SELECT * FROM users WHERE qq = ?', digits);
  if (!user) {
    return { ok: true, reply: '账号未注册，花名册上没有主人的大名哦~', reason: 'unregistered' };
  }
  if (user.status !== 'active') {
    return { ok: true, reply: '账号已被停用，请联系管理员', reason: 'account_disabled' };
  }
  const cfg = getUserApi(user.id);
  if (!cfg.chat?.apiKey) {
    return { ok: true, reply: '对话模型还未设置哦，请前往 Cocoa 进行配置', reason: 'api_not_configured' };
  }
  const characterId = defaultCharacterId(user.id);
  if (!characterId) {
    return { ok: true, reply: '角色还未设置哦，请前往 Cocoa 进行配置', reason: 'character_missing' };
  }

  let result;
  try {
    result = await submitUserMessage({
      userId: user.id,
      characterId,
      content: String(text ?? ''),
      kind: 'text',
      meta: { source: 'onebot', qq: digits, messageType },
      source: 'onebot',
    });
  } catch (err) {
    logger.warn('OneBot 消息处理失败', err?.message || err);
    return { ok: false, reason: err?.code || 'failed', reply: err?.message || '处理消息失败' };
  }

  if (!result.accepted) {
    return { ok: true, reply: result.notice || '', reason: result.reason, userMessage: result.userMessage };
  }
  if (!result.waitForReply) {
    return { ok: true, reply: result.notice || '', reason: result.reason, userMessage: result.userMessage };
  }

  const out = await withTimeout(result.waitForReply, ONEBOT_REPLY_TIMEOUT_MS, { ok: false, reason: 'timeout' });
  const reply = out?.sent ? String(out.content || '') : out?.reason === 'hard_limit' ? NOTICES.hardLimit : '';
  return { ok: true, reply, reason: out?.reason || (out?.sent ? 'replied' : 'no_reply'), userMessage: result.userMessage };
}

export const ONEBOT_REPLY_TIMEOUT_MS = 120_000;

/**
 * 带清理的超时等待：定时器 unref 且结束后 clearTimeout，
 * 避免 OneBot 同步等待在测试/空闲进程里留下悬挂 timer。
 */
export function withTimeout(promise, ms, fallback) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), Math.max(1, Number(ms) || 1));
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// ---------------- 路由辅助 ----------------

export function getContextInfo(userId, characterId) {
  return usageInfo(userId, characterId);
}

export function listChatMessages({ userId, characterId, before = null, limit = 50 } = {}) {
  const mod = listMessages; // 保持从 context 引入的分页实现
  return mod({ userId, characterId, before, limit });
}

export const WAKE_FORCE_INSTRUCTION =
  '系统提示：你被用户强行叫醒了，现在必须保持清醒。请带着刚醒来的状态（可以有一点困倦或小小抱怨）自然回应用户这句话。按正常被动回复 JSON 输出。';

/**
 * 强制叫醒（v1.2.0）：无论当前 sleep_state 如何，都置 awake → 刷新状态 → 生成一次回复（reason='wake'）。
 * 模型/状态刷新失败也保持 awake，并返回可读提示。
 * @returns {Promise<{ok:boolean, wakeup:1, state?:object, reply?:string|null, notice?:string, reason?:string, error?:string}>}
 */
export async function wakeCharacter({ userId, characterId, text = '', provider = null } = {}) {
  const character = getCharacter(userId, characterId);
  if (!character) return { ok: false, wakeup: 1, state: null, reply: null, reason: 'character_not_found' };
  const prov = provider || getChatProvider();

  updateState(characterId, { sleepState: 'awake' });
  let refreshed = null;
  try {
    refreshed = await refreshStatus({ userId, characterId, provider: prov });
  } catch (err) {
    logger.warn('叫醒后刷新状态失败，保持 awake', err?.message || err);
  }
  // 模型刷新可能又判成睡眠：叫醒语义优先，强制覆盖为清醒
  updateState(characterId, { sleepState: 'awake' });
  const row = ensureState(characterId, userId);
  const state = {
    motion: row.motion || '',
    psychology: row.psychology || '',
    mood: row.mood || '',
    health: row.health || '',
    sleepState: 'awake',
    updatedAt: row.updated_at || nowIso(),
    ...(refreshed?.state
      ? { motion: refreshed.state.motion || row.motion, psychology: refreshed.state.psychology || row.psychology, mood: refreshed.state.mood || row.mood, health: refreshed.state.health || row.health }
      : {}),
  };
  broadcast(userId, { type: 'state', characterId, state });

  let reply = null;
  let error = null;
  try {
    const out = await runGeneration({
      userId,
      characterId,
      reason: 'wake',
      triggerText: String(text || '（用户把你叫醒了）'),
      provider: prov,
      extraInstruction: WAKE_FORCE_INSTRUCTION,
      thinking: false,
    });
    if (out?.sent) reply = String(out.content || '').trim() || null;
    else if (!out?.ok) error = out?.error || out?.reason || 'generation_failed';
  } catch (err) {
    logger.warn('叫醒回复生成失败', err?.message || err);
    error = err?.message || 'generation_failed';
  }

  return {
    ok: true,
    wakeup: 1,
    state,
    reply,
    ...(error ? { notice: '已经把你叫醒了，只是刚才没能说出话来，再和我说一句吧。', error } : {}),
  };
}

export { compressConversation };

export default {
  submitUserMessage,
  handleOnebotIncoming,
  runGeneration,
  runCompression,
  startCompression,
  deliverSubjective,
  handleSegmentSend,
  handleSentenceWait,
  handleWakeJudge,
  setChatProvider,
  getChatProvider,
  getContextInfo,
  listChatMessages,
  wakeCharacter,
  preprocessMedia,
  shouldThink,
  buildSystemPrompt,
  resetRuntime,
};
