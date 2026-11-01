// OneBot HTTP 兼容接口：事件上报 / 状态 / 管理员手动发送
import express, { Router } from 'express';
import { requireAuth, requireAdmin } from '../auth/middleware.js';
import { asyncHandler, badRequest } from '../core/errors.js';
import { sendPrivate, onebotStatus, sendQzonePost } from '../onebot/server.js';
import { handleIncomingEvent, recordMessage } from '../onebot/handler.js';
import { getOnebotConfig } from '../services/settings.js';
import { truncate } from '../core/util.js';

function parseEventBody(req) {
  let payload = req.body;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      throw badRequest('事件体不是合法 JSON', 'invalid_event');
    }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw badRequest('缺少事件体', 'invalid_event');
  }
  if (!payload.post_type && payload.message === undefined) {
    throw badRequest('不是有效的 OneBot 事件', 'invalid_event');
  }
  return payload;
}

async function dispatch(req, res) {
  const payload = parseEventBody(req);
  const result = await handleIncomingEvent(payload);
  if (result.status >= 400 && !result.reply) {
    return res.status(result.status).json({
      ok: false,
      reason: result.reason || 'event_failed',
      message: result.message || '事件处理失败',
    });
  }
  let delivered = false;
  if (result.reply) {
    recordMessage({ userId: result.userId || null, qq: result.qq, direction: 'out', content: result.reply });
    const sent = await sendPrivate(result.qq, result.reply);
    delivered = Boolean(sent.ok);
  }
  res.json({
    ok: true,
    accepted: result.ok !== false,
    ignored: Boolean(result.ignored),
    reason: result.reason || null,
    reply: result.reply ?? null,
    delivered,
  });
}

export default function register() {
  const r = Router();

  // NapCat 以 text/plain 上报时也能解析（json 已被 app.js 的 express.json 处理）
  r.post('/event', express.text({ type: ['text/*', 'application/x-www-form-urlencoded'], limit: '1mb' }), asyncHandler(dispatch));

  r.get('/status', requireAuth, (req, res) => {
    const cfg = getOnebotConfig();
    res.json({
      ...onebotStatus(),
      configured: Boolean(cfg.token || cfg.selfId),
      selfId: cfg.selfId || '',
      wsPath: cfg.wsPath || '/onebot/ws',
    });
  });

  r.post(
    '/send',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const qq = String(req.body?.qq || '').trim();
      const text = String(req.body?.text ?? req.body?.message ?? '').trim();
      if (!/^\d{5,12}$/.test(qq)) throw badRequest('QQ 号格式不正确', 'qq_invalid');
      if (!text) throw badRequest('消息内容不能为空', 'text_required');
      const sent = await sendPrivate(qq, text);
      if (!sent.ok) {
        return res.status(sent.reason === 'not_connected' ? 503 : 502).json({
          ok: false,
          reason: sent.reason || 'send_failed',
          message: sent.reason === 'not_connected' ? 'OneBot 尚未连接，请确认 NapCat 已上报到 ' + (getOnebotConfig().wsPath || '/onebot/ws') : 'OneBot 发送失败',
        });
      }
      recordMessage({ qq, direction: 'out', content: truncate(text, 2000) });
      res.json({ ok: true, qq, delivered: true, echo: sent.echo || null });
    }),
  );

  // 角色发送 QQ 空间动态（需 NapCat 支持 send_qzone_msg 扩展动作）
  r.post(
    '/qzone',
    requireAuth,
    asyncHandler(async (req, res) => {
      const content = String(req.body?.content ?? '').trim();
      if (!content) throw badRequest('动态内容不能为空', 'content_required');
      if (content.length > 1000) throw badRequest('动态内容过长（最多 1000 字）', 'content_too_long');
      const images = Array.isArray(req.body?.images) ? req.body.images.slice(0, 9).map(String) : [];
      const ugcRight = Number(req.body?.ugcRight ?? req.body?.ugc_right ?? 1) || 1;
      const sent = await sendQzonePost({ content, images, ugcRight });
      if (!sent.ok) {
        const status = sent.reason === 'not_connected' ? 503 : 502;
        return res.status(status).json({
          ok: false,
          reason: sent.reason || 'send_failed',
          message:
            sent.reason === 'not_connected'
              ? 'OneBot 尚未连接，请确认 NapCat 已上报并支持 send_qzone_msg'
              : `QQ 动态发送失败：${sent.reason || '未知原因'}`,
        });
      }
      recordMessage({ direction: 'out', content: truncate('[QQ动态] ' + content, 2000) });
      res.json({ ok: true, tid: sent.tid, time: sent.time, ugcRight });
    }),
  );

  return r;
}
