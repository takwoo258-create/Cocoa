// v1.2.0 模型分享路由（docs/API.md §14.4）
import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler, badRequest } from '../core/errors.js';
import {
  createShare,
  respondShare,
  revokeShare,
  listShares,
  listPendingShares,
} from '../services/shares.js';

const BOXES = new Set(['incoming', 'outgoing', 'active', 'history']);

function truthy(v) {
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '').toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === '同意' || s === '接受';
}

export default function register() {
  const r = Router();
  r.use(requireAuth);

  // 创建分享 / 索要
  r.post('/', asyncHandler(async (req, res) => {
    const share = createShare(req.userId, req.body || {});
    res.status(201).json({ share });
  }));

  // 列表：incoming（待我处理）/ outgoing（我发出的待处理）/ active（生效中）/ history（历史）
  r.get('/', (req, res) => {
    const box = BOXES.has(String(req.query.box)) ? String(req.query.box) : 'incoming';
    const items = listShares(req.userId, box);
    res.json({ items, total: items.length, box });
  });

  // 客户端启动弹窗：待处理
  r.get('/pending', (req, res) => {
    const items = listPendingShares(req.userId);
    res.json({ items, total: items.length });
  });

  // 同意 / 拒绝
  r.post('/:id/respond', asyncHandler(async (req, res) => {
    const body = req.body || {};
    if (body.accept === undefined) throw badRequest('缺少 accept 参数', 'accept_required');
    const share = respondShare(req.userId, req.params.id, truthy(body.accept));
    res.json({ ok: true, share });
  }));

  // 撤销（双方均可）
  r.post('/:id/revoke', asyncHandler(async (req, res) => {
    const share = revokeShare(req.userId, req.params.id);
    res.json({ ok: true, share });
  }));

  return r;
}
