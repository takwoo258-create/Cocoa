// 对话路由（docs/API.md §4）
// app.js 会把同一个 router 挂载到 '/api/chat' 与 '/api/characters'，
// 因此这里只定义相对路径 '/:id/...'，两种前缀同时可用：
//   POST /api/chat/:id/messages   POST /api/characters/:id/messages
//   GET  .../:id/messages         GET  .../:id/context
//   POST .../:id/active-reply     POST .../:id/wake
import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler, badRequest, notFound } from '../core/errors.js';
import { getCharacter } from '../services/characters.js';
import { submitUserMessage, getContextInfo, listChatMessages, wakeCharacter } from '../ai/chat.js';
import { triggerActiveReply } from '../ai/active.js';

function requireCharacter(req) {
  const characterId = String(req.params.id || '');
  const character = getCharacter(req.userId, characterId);
  if (!character) throw notFound('角色不存在或不属于当前用户', 'character_not_found');
  return character;
}

/** 只对外暴露契约字段；内部 promise / 任务 id 不下发 */
function publicResult(result = {}) {
  const { waitForReply, wakeJobId, sentence, usage, ...rest } = result;
  return {
    accepted: Boolean(rest.accepted),
    queued: Boolean(rest.queued),
    notice: rest.notice ?? null,
    userMessage: rest.userMessage || null,
    ...(rest.reason ? { reason: rest.reason } : {}),
    ...(rest.error ? { error: rest.error } : {}),
    ...(rest.sleepState ? { sleepState: rest.sleepState } : {}),
  };
}

const KINDS = new Set(['text', 'image', 'voice']);

export function chatRoutes() {
  const r = Router();
  r.use(requireAuth);

  // 发送消息
  r.post(
    '/:id/messages',
    asyncHandler(async (req, res) => {
      const character = requireCharacter(req);
      const body = req.body || {};
      const kind = KINDS.has(body.kind) ? body.kind : 'text';
      const content = body.text ?? body.content ?? '';
      const mediaId = body.mediaId ? String(body.mediaId) : null;
      if (kind === 'text' && !String(content || '').trim() && !mediaId) {
        throw badRequest('消息内容不能为空', 'content_required');
      }
      const result = await submitUserMessage({
        userId: req.userId,
        characterId: character.id,
        content: String(content ?? ''),
        kind,
        mediaId,
        meta: body.meta && typeof body.meta === 'object' ? body.meta : null,
        source: 'app',
      });
      if (result.reason === 'character_disabled') {
        return res.status(409).json({
          error: { code: 'character_disabled', message: result.notice || '角色已暂停运行，请先在设置中开启' },
          accepted: false,
          notice: result.notice || null,
        });
      }
      res.status(result.accepted ? 201 : 200).json(publicResult(result));
    }),
  );

  // 历史消息（解密、按时间正序）
  r.get(
    '/:id/messages',
    asyncHandler(async (req, res) => {
      const character = requireCharacter(req);
      const before = req.query.before ? String(req.query.before) : null;
      const limit = Number(req.query.limit) || 50;
      res.json(listChatMessages({ userId: req.userId, characterId: character.id, before, limit }));
    }),
  );

  // 上下文占用（调试模式用）
  r.get(
    '/:id/context',
    asyncHandler(async (req, res) => {
      const character = requireCharacter(req);
      const info = getContextInfo(req.userId, character.id);
      res.json({
        used: info.used,
        limit: info.limit,
        percent: info.percent,
        ratio: info.ratio,
        compressing: info.compressing,
        threshold: info.threshold,
        summary: info.summary,
        conversationId: info.conversationId,
      });
    }),
  );

  // 立即触发主动回复
  r.post(
    '/:id/active-reply',
    asyncHandler(async (req, res) => {
      const character = requireCharacter(req);
      const result = await triggerActiveReply({ userId: req.userId, characterId: character.id });
      res.json({
        ok: Boolean(result.ok),
        scheduled: Boolean(result.scheduled),
        sent: Boolean(result.sent),
        sendsec: result.sendsec ?? null,
        content: result.content || result.parsed?.content || null,
        messageId: result.messageId || null,
        notice: result.notice || null,
        reason: result.reason || null,
        ...(result.error ? { error: result.error } : {}),
      });
    }),
  );

  // 叫醒（v1.5.0：强制叫醒，非睡眠/角色停用时返回 409）
  r.post(
    '/:id/wake',
    asyncHandler(async (req, res) => {
      const character = requireCharacter(req);
      const text = String(req.body?.text ?? req.body?.content ?? '');
      const method = String(req.body?.method ?? '用户');
      const result = await wakeCharacter({ userId: req.userId, characterId: character.id, text, method });
      if (!result.ok) {
        const status = result.status || (result.reason === 'character_disabled' || result.reason === 'not_sleeping' ? 409 : 400);
        return res.status(status).json({
          error: {
            code: result.reason || 'wake_failed',
            message: result.notice || (result.reason === 'not_sleeping' ? '角色现在是清醒的，不需要叫醒哦。' : '暂不能叫醒角色'),
          },
          ok: false,
          state: result.state || null,
          reason: result.reason || null,
        });
      }
      res.json({
        ok: true,
        wakeup: result.wakeup ?? 1,
        state: result.state || null,
        reply: result.reply ?? null,
        transition: result.transition || null,
        notice: result.notice || null,
        ...(result.error ? { error: result.error } : {}),
      });
    }),
  );

  return r;
}

export default function register() {
  return chatRoutes();
}
