// 集成路由：天气 / 热榜（挂载于 /api/integrations，需登录）
import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../core/errors.js';
import { DEFAULT_CITY, HOTBOARD_TYPES, getWeather, getHotboard, integrationStatus } from '../services/integrations.js';

export default function register() {
  const r = Router();
  r.use(requireAuth);

  // GET /api/integrations/weather?city=宣城&refresh=1
  r.get(
    '/weather',
    asyncHandler(async (req, res) => {
      const city = req.query.city ? String(req.query.city) : DEFAULT_CITY;
      const weather = await getWeather(city, { force: String(req.query.refresh || '') === '1' });
      res.json({ ok: true, ...weather });
    }),
  );

  // GET /api/integrations/hotboard?type=weibo&refresh=1
  r.get(
    '/hotboard',
    asyncHandler(async (req, res) => {
      const type = req.query.type ? String(req.query.type) : 'weibo';
      const hotboard = await getHotboard(type, { force: String(req.query.refresh || '') === '1' });
      res.json({ ok: true, ...hotboard });
    }),
  );

  // 客户端展示可用项与 key 是否就绪
  r.get('/status', (_req, res) => {
    res.json({ ok: true, ...integrationStatus() });
  });

  return r;
}
