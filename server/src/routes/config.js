import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler, badRequest } from '../core/errors.js';
import {
  getUserApi, getUserApiRaw, saveUserApi, getPrefs, savePrefs, DEFAULT_PREFS,
  getSystemModelsPublic, normalizeProvider, PROVIDER_SERVICES,
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

function maskApi(cfg, sharedMeta = {}) {
  const out = {};
  for (const svc of SERVICES) {
    const c = cfg[svc] || {};
    const shared = sharedMeta[svc] || null;
    out[svc] = {
      baseUrl: c.baseUrl || '',
      model: c.model || '',
      voice: c.voice || '',
      apiKeySet: Boolean(c.apiKey),
      // 分享来的配置不暴露任何密钥片段
      apiKeyMasked: shared ? '****' : c.apiKey ? `${c.apiKey.slice(0, 4)}****${c.apiKey.slice(-4)}` : '',
      extra: c.extra || {},
      shared,
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

function maskProviders(raw) {
  const list = Array.isArray(raw?.providers) ? raw.providers : [];
  return list.map((p) => ({
    ...normalizeProvider(p, { mask: true }),
    models: normalizeProvider(p).models,
    apiKeySet: Boolean(p.apiKey),
    services: Object.keys(normalizeProvider(p).models),
  }));
}

function sanitizeProviders(body, raw) {
  if (!Array.isArray(body?.providers)) return null;
  if (body.providers.length > 8) throw badRequest('最多配置 8 个模型提供源', 'too_many_providers');
  const existing = new Map((Array.isArray(raw?.providers) ? raw.providers : []).map((p) => [String(p.id), p]));
  return body.providers.map((input) => {
    const id = String(input?.id || '').trim();
    const prev = existing.get(id);
    const base = normalizeProvider({ ...(prev || {}), ...input, id }, { mask: false });
    if (typeof input?.apiKey === 'string') {
      if (KEEP.has(input.apiKey)) base.apiKey = prev?.apiKey || '';
      else if (!input.apiKey.trim()) base.apiKey = '';
      else base.apiKey = input.apiKey.trim();
    }
    if (!base.models || !Object.keys(base.models).length) throw badRequest('模型提供源至少配置一个服务模型', 'provider_model_required');
    return base;
  });
}
export default function register() {
  const r = Router();
  r.use(requireAuth);

  r.get('/', (req, res) => {
    const cfg = getUserApi(req.userId);
    const raw = getUserApiRaw(req.userId);
    const prefs = getPrefs(req.userId);
    const shared = cfg.shared || {};
    const sharedUsed = cfg.sharedUsed || {};
    res.json({
      api: {
        ...maskApi(cfg, sharedUsed),
        providers: maskProviders(raw),
        modelSource: cfg.modelSource || 'own',
        systemProviderId: cfg.systemProviderId || '',
        providerMeta: cfg.providerMeta || {},
      },
      systemModels: getSystemModelsPublic(),
      preferences: prefs,
      ready: {
        chat: Boolean(cfg.chat.apiKey),
        embedding: Boolean(cfg.embedding.apiKey),
        stt: Boolean(cfg.stt.apiKey),
        tts: Boolean(cfg.tts.apiKey),
        search: Boolean(cfg.search.apiKey), // 兼容字段：search/fetch 复用 deepseek，不再暴露配置项
      },
      // v1.2.0：他人分享且生效中的服务元信息（不含密钥）
      shared,
      defaults: { preferences: DEFAULT_PREFS, services: SERVICES, note: 'search/fetch 复用 DeepSeek 配置，无需单独设置模型' },
    });
  });

  r.put(
    '/api',
    asyncHandler(async (req, res) => {
      const raw = getUserApiRaw(req.userId);
      const patch = sanitizePatch(req.body || {});
      const providers = sanitizeProviders(req.body || {}, raw);
      if (providers) patch.providers = providers;
      if (req.body?.modelSource === 'system' || req.body?.modelSource === 'own') patch.modelSource = req.body.modelSource;
      if (typeof req.body?.systemProviderId === 'string') patch.systemProviderId = req.body.systemProviderId.trim().slice(0, 64);
      if (req.body?.activeProviderId && typeof req.body.activeProviderId === 'object') {
        const active = {};
        for (const svc of [...PROVIDER_SERVICES, 'default']) {
          if (typeof req.body.activeProviderId[svc] === 'string') active[svc] = req.body.activeProviderId[svc].slice(0, 64);
        }
        patch.activeProviderId = active;
      }
      if (!Object.keys(patch).length) throw badRequest('没有可保存的配置项', 'empty_patch');
      const cfg = saveUserApi(req.userId, patch);
      const shared = cfg.shared || {};
      const sharedUsed = cfg.sharedUsed || {};
      res.json({
        ok: true,
        api: {
          ...maskApi(cfg, sharedUsed),
          providers: maskProviders(getUserApiRaw(req.userId)),
          modelSource: cfg.modelSource || 'own',
          systemProviderId: cfg.systemProviderId || '',
          providerMeta: cfg.providerMeta || {},
        },
        systemModels: getSystemModelsPublic(),
        ready: { chat: Boolean(cfg.chat.apiKey), embedding: Boolean(cfg.embedding.apiKey) },
        shared,
      });
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
