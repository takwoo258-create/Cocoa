// OneBot 事件处理：QQ → users.qq 路由、固定文案、转交 ai/chat.js
import { get, run } from '../db/index.js';
import { nowIso, uuid, truncate } from '../core/util.js';
import { getUserApi } from '../services/settings.js';
import { defaultCharacterId } from '../services/characters.js';
import logger from '../core/logger.js';

export const UNREGISTERED_TEXT = '账号未注册，花名册上没有主人的大名哦~';
export const DISABLED_TEXT = '账号已被停用，请联系管理员';
export const missingConfigText = (label) => `${label}还未设置哦，请前往 Cocoa 进行配置`;

const SERVICE_LABELS = {
  chat: '对话模型',
  embedding: '嵌入模型',
  deepseek: 'DeepSeek',
  search: '网页搜索',
  stt: '语音识别',
  tts: '语音合成',
};

/** 抽取纯文本（支持 string / message 段数组 / 含 CQ 码的 raw_message） */
export function extractText(event) {
  const msg = event?.message ?? event?.raw_message ?? '';
  if (Array.isArray(msg)) {
    const text = msg
      .map((seg) => {
        if (!seg) return '';
        if (typeof seg === 'string') return seg;
        const type = seg.type;
        if (type === 'text') return seg.data?.text || '';
        if (type === 'image') return '[图片]';
        if (type === 'record') return '[语音]';
        if (type === 'face') return '[表情]';
        if (type === 'at') return '';
        return '';
      })
      .join('');
    return text.trim();
  }
  return String(msg ?? '')
    .replace(/\[CQ:[^\]]*\]/g, '')
    .trim();
}

export function recordMessage({ userId = null, qq = null, direction, content }) {
  try {
    run(
      'INSERT INTO onebot_messages(id, user_id, qq, direction, content, created_at) VALUES(?,?,?,?,?,?)',
      `ob_${uuid().replace(/-/g, '').slice(0, 20)}`,
      userId,
      qq,
      direction === 'out' ? 'out' : 'in',
      truncate(content || '', 2000),
      nowIso(),
    );
  } catch (err) {
    logger.warn('OneBot 消息记录失败', err.message);
  }
}

/** 已注册用户缺失的服务配置项（返回中文项目名数组） */
export function missingConfigLabels(userId) {
  const cfg = getUserApi(userId);
  const missing = [];
  if (!cfg?.chat?.apiKey) missing.push(SERVICE_LABELS.chat);
  if (!cfg?.embedding?.apiKey) missing.push(SERVICE_LABELS.embedding);
  return [...new Set(missing)];
}

let chatModule = null;
let chatLoadFailedAt = 0;

async function loadChatModule() {
  if (chatModule) return chatModule;
  if (Date.now() - chatLoadFailedAt < 5000) return null;
  try {
    chatModule = await import('../ai/chat.js');
    return chatModule;
  } catch (err) {
    chatLoadFailedAt = Date.now();
    logger.warn('OneBot: ai/chat.js 尚未就绪', err?.code || err?.message);
    return null;
  }
}

function replyResult({ qq, userId = null, reply, reason = null, ok = true, status = 200, extra = {} }) {
  return { ok, status, qq, userId, reply, reason, ...extra };
}

/**
 * 处理一条 OneBot 事件。
 * 返回 { ok, status, qq, userId, reply?, reason?, ignored? }
 * - 未注册 / 缺配置：直接给出固定文案（reply）
 * - 正常：转交 ai/chat.js（缺失时 status=503，不抛异常）
 */
export async function handleIncomingEvent(event) {
  const postType = event?.post_type || (event?.message !== undefined ? 'message' : '');
  const qq = String(event?.user_id ?? event?.sender?.user_id ?? '').trim();
  const messageType = event?.message_type || 'private';
  const text = extractText(event);

  if (!qq) {
    return { ok: false, status: 400, reason: 'missing_qq', message: '事件缺少 user_id', reply: null, userId: null, qq: null };
  }
  if (postType && postType !== 'message') {
    return { ok: true, status: 200, ignored: true, reason: `post_type:${postType}`, reply: null, userId: null, qq };
  }
  if (messageType === 'group' && !event?.to_me && !event?.at_me) {
    return { ok: true, status: 200, ignored: true, reason: 'group_not_mentioned', reply: null, userId: null, qq };
  }

  recordMessage({ qq, direction: 'in', content: text });

  const user = get('SELECT * FROM users WHERE qq = ?', qq);
  if (!user) {
    return replyResult({ qq, reply: UNREGISTERED_TEXT, reason: 'unregistered' });
  }
  if (user.status !== 'active') {
    return replyResult({ qq, userId: user.id, reply: DISABLED_TEXT, reason: 'disabled', ok: false, status: 403 });
  }

  // 关联配置缺失：对话模型缺失时直接提示（与 build.md 固定文案一致）；
  // 仅嵌入模型等非阻塞项缺失时放行，由 ai/chat.js 自行降级（记忆功能减弱但会话可用）。
  const missing = missingConfigLabels(user.id);
  const chatReady = Boolean(getUserApi(user.id)?.chat?.apiKey);
  if (!chatReady) {
    return replyResult({
      qq,
      userId: user.id,
      reply: missingConfigText(missing.join('、') || SERVICE_LABELS.chat),
      reason: 'config_missing',
      extra: { missing },
    });
  }

  if (!text) {
    return { ok: false, status: 400, reason: 'empty_message', message: '消息为空', reply: null, userId: user.id, qq };
  }

  const mod = await loadChatModule();
  if (!mod) {
    return {
      ok: false,
      status: 503,
      reason: 'chat_not_ready',
      message: '对话服务尚未就绪，请稍后再试',
      reply: null,
      userId: user.id,
      qq,
    };
  }

  try {
    if (typeof mod.handleOnebotIncoming === 'function') {
      const out = (await mod.handleOnebotIncoming({ qq, text, userId: user.id, messageType, event })) || {};
      return {
        ok: out.ok !== false,
        status: out.status || 200,
        reason: out.reason || null,
        reply: out.reply || null,
        notice: out.notice || null,
        accepted: out.accepted !== false,
        userId: user.id,
        qq,
      };
    }
    if (typeof mod.submitUserMessage === 'function') {
      const characterId = defaultCharacterId(user.id);
      if (!characterId) {
        return replyResult({
          qq,
          userId: user.id,
          reply: '还没有创建角色哦，请前往 Cocoa 创建一位角色吧~',
          reason: 'no_character',
          ok: false,
          status: 409,
        });
      }
      const out =
        (await mod.submitUserMessage({
          userId: user.id,
          characterId,
          content: text,
          kind: 'text',
          mediaId: null,
          meta: { source: 'onebot', qq, messageType },
          source: 'onebot',
        })) || {};
      return {
        ok: out.accepted !== false,
        status: 200,
        reason: out.reason || null,
        reply: out.reply || null,
        notice: out.notice || null,
        accepted: out.accepted !== false,
        queued: Boolean(out.queued),
        userId: user.id,
        qq,
        characterId,
      };
    }
  } catch (err) {
    logger.error('OneBot: 对话处理失败', err?.stack || err?.message);
    return {
      ok: false,
      status: 502,
      reason: 'chat_error',
      message: '对话处理失败，请稍后再试',
      reply: null,
      userId: user.id,
      qq,
    };
  }

  return {
    ok: false,
    status: 503,
    reason: 'chat_not_ready',
    message: '对话服务尚未就绪，请稍后再试',
    reply: null,
    userId: user.id,
    qq,
  };
}

export default { handleIncomingEvent, extractText, missingConfigLabels, recordMessage, UNREGISTERED_TEXT };
