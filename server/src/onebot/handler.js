// OneBot 事件处理：QQ → users.qq 路由、固定文案、单角色接入、转交 ai/chat.js
// v1.2.0：仅处理 message 事件；空文本 / 输入状态 / notice 直接忽略；只用 qq_enabled=1 的角色
import { get, run } from '../db/index.js';
import { nowIso, uuid, truncate } from '../core/util.js';
import { decryptText } from '../core/crypto.js';
import { getUserApi } from '../services/settings.js';
import { latestPendingShare, respondShare } from '../services/shares.js';
import logger from '../core/logger.js';

export const UNREGISTERED_TEXT = '账号未注册，花名册上没有主人的大名哦~';
export const DISABLED_TEXT = '账号已被停用，请联系管理员';
export const NO_QQ_BINDING_TEXT = '角色还未接入QQ，请在角色设置中开启';
export const missingConfigText = (label) => `${label}还未设置哦，请前往 Cocoa 进行配置`;

const SERVICE_LABELS = {
  chat: '对话模型',
  embedding: '嵌入模型',
  deepseek: 'DeepSeek',
  search: '网页搜索',
  stt: '语音识别',
  tts: '语音合成',
};

const SHARE_ACCEPT_RE = /^(同意|接受|同意分享|接受分享)$/;
const SHARE_REJECT_RE = /^(拒绝|不要了|拒绝分享|不同意)$/;

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

/** 当前账号接入 QQ 的角色（characters.qq_enabled 唯一，name 已解密） */
export function boundCharacter(userId) {
  const row = get(
    'SELECT id, name FROM characters WHERE user_id = ? AND qq_enabled = 1 AND archived = 0 ORDER BY created_at ASC LIMIT 1',
    userId,
  );
  if (!row) return null;
  let name = '';
  try {
    name = decryptText(userId, row.name || '');
  } catch {
    name = '';
  }
  return { id: row.id, name };
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

function ignoredResult({ qq = null, userId = null, reason, status = 200 }) {
  return { ok: true, status, ignored: true, reason, reply: null, userId, qq };
}

function withLocalTimeout(promise, ms, fallback) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), Math.max(1, Number(ms) || 1));
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** 等待智能体回复（沿用 ai/chat.js 的 waitForReply 契约与 120s 上限） */
async function awaitReply(mod, out) {
  if (out?.accepted === false) return { reply: out.notice || '', reason: out.reason || 'not_accepted' };
  if (!out?.waitForReply) return { reply: out.notice || '', reason: out.reason || 'no_wait' };
  const timeoutMs = Number(mod.ONEBOT_REPLY_TIMEOUT_MS) || 120_000;
  const wait = typeof mod.withTimeout === 'function' ? mod.withTimeout : withLocalTimeout;
  const waited = await wait(out.waitForReply, timeoutMs, { ok: false, reason: 'timeout' });
  const hardLimit = mod.NOTICES?.hardLimit || 'Token 已达硬性限额，角色服务已暂停';
  const reply = waited?.sent ? String(waited.content || '') : waited?.reason === 'hard_limit' ? hardLimit : '';
  return { reply, reason: waited?.reason || (waited?.sent ? 'replied' : 'no_reply') };
}

/**
 * 处理一条 OneBot 事件。
 * 返回 { ok, status, qq, userId, reply?, reason?, ignored? }
 */
export async function handleIncomingEvent(event) {
  const postType = event?.post_type || (event?.message !== undefined ? 'message' : '');
  const qq = String(event?.user_id ?? event?.sender?.user_id ?? '').trim();
  const messageType = event?.message_type || 'private';

  if (!qq) {
    return { ok: false, status: 400, reason: 'missing_qq', message: '事件缺少 user_id', reply: null, userId: null, qq: null };
  }
  // 只处理 message；notice（含输入状态）、meta_event、message_sent 等一律忽略
  if (postType !== 'message') {
    return ignoredResult({ qq, reason: `post_type:${postType || 'unknown'}` });
  }
  if (messageType === 'group' && !event?.to_me && !event?.at_me) {
    return ignoredResult({ qq, reason: 'group_not_mentioned' });
  }

  const text = extractText(event);
  if (!text) return ignoredResult({ qq, reason: 'empty_message' });

  recordMessage({ qq, direction: 'in', content: text });

  const user = get('SELECT * FROM users WHERE qq = ?', qq);
  if (!user) {
    return replyResult({ qq, reply: UNREGISTERED_TEXT, reason: 'unregistered' });
  }
  if (user.status !== 'active') {
    return replyResult({ qq, userId: user.id, reply: DISABLED_TEXT, reason: 'disabled', ok: false, status: 403 });
  }

  // QQ 内直接处理待办模型分享：「同意」/「拒绝」（无待办时按普通聊天处理）
  const command = text.replace(/[\s。.!！~～]+$/g, '').trim();
  if (SHARE_ACCEPT_RE.test(command) || SHARE_REJECT_RE.test(command)) {
    const pending = latestPendingShare(user.id);
    if (pending) {
      const accept = SHARE_ACCEPT_RE.test(command);
      try {
        respondShare(user.id, pending.id, accept);
        return replyResult({
          qq,
          userId: user.id,
          reply: accept ? '已接受模型分享，现在可以使用对方分享的模型啦~' : '已拒绝本次模型分享。',
          reason: accept ? 'share_accepted' : 'share_rejected',
          extra: { shareId: pending.id },
        });
      } catch (err) {
        return replyResult({
          qq,
          userId: user.id,
          reply: err?.message || '处理模型分享失败，请稍后再试',
          reason: err?.code || 'share_failed',
          extra: { shareId: pending.id },
        });
      }
    }
  }

  // 关联配置缺失：对话模型缺失时直接提示；仅嵌入模型缺失时放行（记忆降级）
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

  // v1.2.0：仅 qq_enabled=1 的角色可接待（不再使用 defaultCharacterId）
  const bound = boundCharacter(user.id);
  if (!bound) {
    return replyResult({ qq, userId: user.id, reply: NO_QQ_BINDING_TEXT, reason: 'character_not_bound' });
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
    if (typeof mod.submitUserMessage === 'function') {
      const out =
        (await mod.submitUserMessage({
          userId: user.id,
          characterId: bound.id,
          content: text,
          kind: 'text',
          mediaId: null,
          meta: { source: 'onebot', qq, messageType, characterId: bound.id },
          source: 'onebot',
        })) || {};
      const { reply, reason } = await awaitReply(mod, out);
      return {
        ok: out.accepted !== false,
        status: 200,
        reason,
        reply: reply || null,
        notice: out.notice || null,
        accepted: out.accepted !== false,
        queued: Boolean(out.queued),
        userId: user.id,
        qq,
        characterId: bound.id,
      };
    }
    if (typeof mod.handleOnebotIncoming === 'function') {
      // 旧版降级：仅当 submitUserMessage 缺失时使用（内部角色选择不受控）
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

export default {
  handleIncomingEvent,
  extractText,
  missingConfigLabels,
  recordMessage,
  boundCharacter,
  UNREGISTERED_TEXT,
  NO_QQ_BINDING_TEXT,
};
