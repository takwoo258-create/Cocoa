// v1.5.0 共享广场路由：本服广场（登录）+ 全球公开读 + 全球服务间签名写 + 本服代理
// 客户端只访问本服：GET /api/plaza/global/list、POST /api/plaza/global/publish、POST /api/plaza/global/:id/use
// 全球主机额外提供：GET /api/plaza/global/list（公开）、POST /api/plaza/global/{publish,use,like}（X-Share-Id + HMAC）
import { Router } from 'express';
import { requireAuth, optionalAuth } from '../auth/middleware.js';
import { asyncHandler, tooMany } from '../core/errors.js';
import { clientKey, rateLimit } from '../core/ratelimit.js';
import { listShares } from '../services/shares.js';
import {
  SHARE_ID_RE,
  plazaMeta,
  ensureShareId,
  rotateShareId,
  createResource,
  updateResource,
  deleteResource,
  listResources,
  getResource,
  likeResource,
  useResource,
  myPlaza,
  grantFor,
  plazaModelGrants,
  globalPublish,
  globalUse,
  globalLike,
  verifyGlobalRequest,
  proxyGlobalList,
  proxyGlobalPublish,
  proxyGlobalUse,
  proxyGlobalLike,
} from '../services/plaza.js';

const BOXES = new Set(['published', 'grants', 'liked']);

function requestOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : '';
}

function rawBody(req) {
  if (!req.body || typeof req.body !== 'object') return '';
  return JSON.stringify(req.body);
}

function publicPath(req) {
  return String(req.originalUrl || req.url || '').split('?')[0];
}

/** 全球接口限流：每 IP / 每 shareId 每分钟 60 次 */
function globalRateLimit(req, _res, next) {
  try {
    const ip = clientKey(req);
    const byIp = rateLimit({ key: `plaza:global:ip:${ip}`, limit: 60, windowMs: 60_000 });
    const shareId = String(req.headers['x-share-id'] || '').trim();
    const byShare = shareId
      ? rateLimit({ key: `plaza:global:sid:${shareId}`, limit: 60, windowMs: 60_000 })
      : { ok: true };
    if (!byIp.ok || !byShare.ok) throw tooMany('请求过于频繁，请稍后再试', 'rate_limited');
    next();
  } catch (err) {
    next(err);
  }
}

export default function register() {
  const r = Router();

  // ===================== 全球广场：公开只读 + 服务间写 =====================

  // GET /api/plaza/global/list?scope=global&q=&kind=&page=&pageSize=
  // - 全球主机：公开只读（无需登录，IP 限流），返回摘要
  // - 其他部署：登录用户走本服代理；未登录也尽量返回公开列表（失败降级 ok:false）
  r.get(
    '/global/list',
    globalRateLimit,
    optionalAuth,
    asyncHandler(async (req, res) => {
      const origin = requestOrigin(req);
      const result = await proxyGlobalList(req.userId || null, req.query, { origin });
      res.json(result);
    }),
  );

  // POST /api/plaza/global/publish
  // - 带登录态：本服代理（客户端只和本服通信）
  // - 无登录态：全球主机接受服务间签名调用
  r.post(
    '/global/publish',
    globalRateLimit,
    optionalAuth,
    asyncHandler(async (req, res) => {
      const origin = requestOrigin(req);
      if (req.userId) {
        const result = await proxyGlobalPublish(req.userId, req.body || {}, { origin });
        return res.status(201).json(result);
      }
      const bodyString = rawBody(req);
      const { shareId } = verifyGlobalRequest({
        headers: req.headers,
        method: 'POST',
        path: publicPath(req),
        bodyString,
      });
      const resource = globalPublish({ shareId, body: req.body || {}, originUrl: req.body?.originUrl || '' });
      res.status(201).json({ ok: true, resource });
    }),
  );

  // POST /api/plaza/global/use（服务间签名；客户端使用 /api/plaza/global/:id/use）
  r.post(
    '/global/use',
    globalRateLimit,
    asyncHandler(async (req, res) => {
      const bodyString = rawBody(req);
      const { shareId } = verifyGlobalRequest({
        headers: req.headers,
        method: 'POST',
        path: publicPath(req),
        bodyString,
      });
      res.json(globalUse({ shareId, resourceId: req.body?.resourceId }));
    }),
  );

  // POST /api/plaza/global/like（服务间签名）
  r.post(
    '/global/like',
    globalRateLimit,
    asyncHandler(async (req, res) => {
      const bodyString = rawBody(req);
      const { shareId } = verifyGlobalRequest({
        headers: req.headers,
        method: 'POST',
        path: publicPath(req),
        bodyString,
      });
      res.json(globalLike({ shareId, resourceId: req.body?.resourceId }));
    }),
  );

  r.get('/global/meta', globalRateLimit, (req, res) => {
    const shareId = String(req.headers['x-share-id'] || '').trim();
    res.json({
      ok: true,
      scopeServer: false,
      scope: 'global',
      ...plazaMeta(null, { origin: requestOrigin(req) }),
      shareId,
    });
  });

  // ===================== 以下需要登录 =====================
  r.use(requireAuth);

  r.get('/meta', (req, res) => {
    res.json({ ok: true, ...plazaMeta(req.userId, { origin: requestOrigin(req) }) });
  });

  r.get('/share-id', (req, res) => {
    res.json({ ok: true, shareId: ensureShareId(req.userId) });
  });

  r.post('/share-id/rotate', (req, res) => {
    const result = rotateShareId(req.userId);
    res.json({ ok: true, ...result });
  });

  // ---------- 本服广场 ----------
  r.post('/resources', (req, res) => {
    const resource = createResource(req.userId, req.body || {});
    res.status(201).json({ ok: true, resource });
  });

  r.get('/resources', (req, res) => {
    const result = listResources(req.userId, req.query);
    res.json({ ok: true, ...result });
  });

  r.get('/resources/:id', (req, res) => {
    res.json({ ok: true, resource: getResource(req.userId, req.params.id) });
  });

  r.patch('/resources/:id', (req, res) => {
    res.json({ ok: true, resource: updateResource(req.userId, req.params.id, req.body || {}) });
  });

  r.delete('/resources/:id', (req, res) => {
    res.json(deleteResource(req.userId, req.params.id));
  });

  r.post('/resources/:id/like', (req, res) => {
    res.json(likeResource(req.userId, req.params.id));
  });

  const useHandler = (req, res) => {
    res.json(useResource(req.userId, req.params.id));
  };
  r.post('/resources/:id/use', useHandler);
  r.post('/:id/use', useHandler);

  r.get('/mine', (req, res) => {
    const box = BOXES.has(String(req.query.box)) ? String(req.query.box) : 'published';
    res.json({ ok: true, ...myPlaza(req.userId, box) });
  });

  r.get('/grants', (req, res) => {
    const items = plazaModelGrants(req.userId);
    res.json({ ok: true, items, total: items.length });
  });

  r.get('/grants/:id', (req, res) => {
    res.json({ ok: true, grant: grantFor(req.userId, req.params.id) });
  });

  // 旧模型分享（兼容 MVP：广场页跳转 /api/shares）
  r.get('/legacy-shares', (req, res) => {
    const items = listShares(req.userId, 'active').map((item) => ({
      ...item,
      legacy: true,
      jumpTo: `/api/shares?box=active&id=${item.id}`,
    }));
    res.json({ ok: true, items, total: items.length, note: '旧版模型分享，仍可在 /api/shares 中管理' });
  });

  // ---------- 本服代理：全球资源的使用 / 点赞 / 导入 ----------
  const globalUseProxy = asyncHandler(async (req, res) => {
    const result = await proxyGlobalUse(req.userId, req.params.id, { origin: requestOrigin(req) });
    res.json(result);
  });
  r.post('/global/:id/use', globalUseProxy);
  r.post('/global/:id/import', globalUseProxy);

  r.post(
    '/global/:id/like',
    asyncHandler(async (req, res) => {
      const result = await proxyGlobalLike(req.userId, req.params.id, { origin: requestOrigin(req) });
      res.json(result);
    }),
  );

  return r;
}

export { SHARE_ID_RE };
