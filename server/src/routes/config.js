import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler, badRequest } from '../core/errors.js';
import {
  getUserApi, saveUserApi, getPrefs, savePrefs, DEFAULT_PREFS,
} from '../services/settings.js';
import { listModels, testConnection, resolveModel } from '../ai/provider.js';
import { describeModel } from '../ai/models.js';

const SERVICES = ['chat', 'embedding', 'deepseek', 'stt', 'tts'];
const HIDDEN_SERVICES = ['search'];
const KEEP = new Set(['****', '••••••••', '[REDACTED]', 'unchanged']);

// 允许前端用未保存的草稿配置直接请求模型列表/连通测试
function pickOverrides(body) {
  const out = {};
  if (typeof body?.baseUrl === 'string') out.baseUrl = body.baseUrl.trim();
  if (typeof body?.apiKey === 'string' && body.apiKey && !KEEP.has(body.apiKey)) out.apiKey = body.apiKey.trim();
  if (typeof body?.model === 'string') out.model = body.model.trim();
  return Object.keys(out).length ? out : null;
}

function maskApi(cfg) {
  const out = {};
  for (const svc of SERVICES) {
    const c = cfg[svc] || {};
    out[svc] = {
      baseUrl: c.baseUrl || '',
      model: c.model || '',
      voice: c.voice || '',
      apiKeySet: Boolean(c.apiKey),
      apiKeyMasked: c.apiKey ? `${c.apiKey.slice(0, 4)}****${c.apiKey.slice(-4)}` : '',
      extra: c.extra || {},
    };
  }
  return out;
}

function sanitizePatch(body) {
  const patch = {};
  for (const svc of SERVICES) {
    const input = body?.[svc];
    if (!input || typeof input !== 'object') continue;
    const next = {};
    if (typeof input.baseUrl === 'string') next.baseUrl = input.baseUrl.trim();
    if (typeof input.model === 'string') next.model = input.model.trim();
    if (typeof input.voice === 'string') next.voice = input.voice.trim();
    if (typeof input.apiKey === 'string') {
      if (KEEP.has(input.apiKey)) {
        // 保持原值
      } else if (input.apiKey.trim() === '') {
        next.apiKey = '';
      } else {
        next.apiKey = input.apiKey.trim();
      }
    }
    if (input.extra && typeof input.extra === 'object') next.extra = input.extra;
    patch[svc] = next;
  }
  return patch;
}

export default function register() {
  const r = Router();
  r.use(requireAuth);

  r.get('/', (req, res) => {
    const cfg = getUserApi(req.userId);
    const prefs = getPrefs(req.userId);
    res.json({
      api: maskApi(cfg),
      preferences: prefs,
      ready: {
        chat: Boolean(cfg.chat.apiKey),
        embedding: Boolean(cfg.embedding.apiKey),
        stt: Boolean(cfg.stt.apiKey),
        tts: Boolean(cfg.tts.apiKey),
        search: Boolean(cfg.search.apiKey), // 兼容字段：search/fetch 复用 deepseek，不再暴露配置项
      },
      defaults: { preferences: DEFAULT_PREFS, services: SERVICES, note: 'search/fetch 复用 DeepSeek 配置，无需单独设置模型' },
    });
  });

  r.put(
    '/api',
    asyncHandler(async (req, res) => {
      const patch = sanitizePatch(req.body || {});
      if (!Object.keys(patch).length) throw badRequest('没有可保存的配置项', 'empty_patch');
      const cfg = saveUserApi(req.userId, patch);
      res.json({ ok: true, api: maskApi(cfg), ready: { chat: Boolean(cfg.chat.apiKey), embedding: Boolean(cfg.embedding.apiKey) } });
    }),
  );

  r.post(
    '/models',
    asyncHandler(async (req, res) => {
      const service = SERVICES.includes(req.body?.service) ? req.body.service : 'chat';
      const overrides = pickOverrides(req.body);
      const result = await listModels(req.userId, service, overrides);
      res.json(result);
    }),
  );

  r.post(
    '/test',
    asyncHandler(async (req, res) => {
      const service = SERVICES.includes(req.body?.service) ? req.body.service : 'chat';
      const overrides = pickOverrides(req.body);
      const result = await testConnection(req.userId, service, overrides);
      res.status(result.ok ? 200 : 502).json(result);
    }),
  );

  r.get('/preferences', (req, res) => {
    res.json({ preferences: getPrefs(req.userId) });
  });

  r.put(
    '/preferences',
    asyncHandler(async (req, res) => {
      const prefs = savePrefs(req.userId, req.body || {});
      res.json({ preferences: prefs });
    }),
  );

  r.get(
    '/model-info',
    asyncHandler(async (req, res) => {
      const id = String(req.query.id || '');
      if (!id) throw badRequest('缺少模型 id', 'model_required');
      const { lookupContextWindow } = await import('../ai/models.js');
      const desc = describeModel(id);
      const tableCtx = lookupContextWindow(id);
      res.json({
        model: {
          ...desc,
          contextWindow: tableCtx || desc.contextWindow,
          contextWindowSource: tableCtx ? 'table' : 'default',
          override: getPrefs(req.userId).contextLimits?.[id] || null,
        },
        routed: resolveModel(req.userId, String(req.query.task || 'main')),
      });
    }),
  );

  return r;
}
