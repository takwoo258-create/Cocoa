import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler, badRequest } from '../core/errors.js';
import {
  getUserApi, getUserApiRaw, saveUserApi, getPrefs, savePrefs, DEFAULT_PREFS,
  getSystemModelsPublic, normalizeServiceProfile, normalizeProfileStore,
  getProfileStorePublic, SERVICE_TYPES, SERVICE_LABELS,
} from '../services/settings.js';
import { listModels, testConnection, resolveModel } from '../ai/provider.js';
import { describeModel } from '../ai/models.js';

const KEEP = new Set(['****', '••••••••', '[REDACTED]', 'unchanged']);
const MAX_PROFILES = 20;

function serviceKey(name) {
  const key = String(name || '').trim();
  if (key === 'deepseek') return 'search';
  return SERVICE_TYPES.includes(key) ? key : null;
}

// 允许前端用未保存的草稿配置直接请求模型列表/连通测试
function pickOverrides(body) {
  const out = {};
  if (typeof body?.baseUrl === 'string') out.baseUrl = body.baseUrl.trim();
  if (typeof body?.apiKey === 'string' && body.apiKey && !KEEP.has(body.apiKey)) out.apiKey = body.apiKey.trim();
  if (typeof body?.model === 'string') out.model = body.model.trim();
  if (typeof body?.voice === 'string') out.voice = body.voice.trim();
  return Object.keys(out).length ? out : null;
}

function profileOverrides(userId, service, profileId) {
  const key = serviceKey(service);
  const id = String(profileId || '').trim();
  if (!key || !id) return null;
  const store = normalizeProfileStore(getUserApiRaw(userId));
  const profile = (store[key] || []).find((p) => p.id === id);
  if (!profile) return null;
  return { baseUrl: profile.baseUrl, apiKey: profile.apiKey, model: profile.model, voice: profile.voice };
}

// 旧客户端兼容视图：单服务掩码
function maskApi(cfg, sharedMeta = {}) {
  const out = {};
  for (const svc of SERVICE_TYPES) {
    const c = cfg[svc] || {};
    const shared = sharedMeta[svc] || null;
    out[svc] = {
      baseUrl: c.baseUrl || '',
      model: c.model || '',
      voice: c.voice || '',
      contextWindow: c.contextWindow || null,
      apiKeySet: Boolean(c.apiKey),
      apiKeyMasked: shared ? '****' : c.apiKey ? `${c.apiKey.slice(0, 4)}****${c.apiKey.slice(-4)}` : '',
      extra: c.extra || {},
      shared,
    };
  }
  return out;
}

function sanitizeProfiles(body, userId) {
  if (!body?.profiles || typeof body.profiles !== 'object') return null;
  const store = normalizeProfileStore(getUserApiRaw(userId));
  const out = {};
  for (const svc of SERVICE_TYPES) {
    const list = body.profiles[svc];
    if (!Array.isArray(list)) continue;
    if (list.length > MAX_PROFILES) throw badRequest(`每个服务最多 ${MAX_PROFILES} 条配置`, 'too_many_profiles');
    const prevMap = new Map((store[svc] || []).map((p) => [p.id, p]));
    out[svc] = list.map((input) => {
      const id = String(input?.id || '').trim();
      const prev = prevMap.get(id);
      const profile = normalizeServiceProfile({ ...(prev || {}), ...input, id });
      if (typeof input?.apiKey === 'string') {
        if (KEEP.has(input.apiKey)) profile.apiKey = prev?.apiKey || '';
        else if (!input.apiKey.trim()) profile.apiKey = '';
        else profile.apiKey = input.apiKey.trim();
      }
      if (!profile.name) profile.name = '未命名配置';
      return profile;
    });
  }
  return Object.keys(out).length ? out : null;
}

function sanitizeLegacyService(body) {
  const patch = {};
  for (const svc of SERVICE_TYPES) {
    const input = body?.[svc];
    if (!input || typeof input !== 'object' || Array.isArray(input)) continue;
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
    if (input.contextWindow !== undefined) next.contextWindow = input.contextWindow;
    if (input.extra && typeof input.extra === 'object') next.extra = input.extra;
    patch[svc] = next;
  }
  return patch;
}

function sanitizeActive(body) {
  if (!body?.active || typeof body.active !== 'object') return null;
  const active = {};
  for (const svc of SERVICE_TYPES) {
    if (typeof body.active[svc] === 'string') active[svc] = body.active[svc].trim().slice(0, 64);
  }
  return Object.keys(active).length ? active : null;
}

function configPayload(userId) {
  const cfg = getUserApi(userId);
  const profiles = getProfileStorePublic(userId);
  const shared = cfg.shared || {};
  const sharedUsed = cfg.sharedUsed || {};
  return {
    api: {
      profiles: profiles.services,
      active: profiles.active,
      providerMeta: cfg.providerMeta || {},
      modelSource: cfg.modelSource || 'own',
      systemProviderId: cfg.systemProviderId || '',
      contextWindow: cfg.contextWindow || null,
      // 兼容旧客户端
      ...maskApi(cfg, sharedUsed),
    },
    systemModels: getSystemModelsPublic(),
    preferences: getPrefs(userId),
    ready: {
      chat: Boolean(cfg.chat.apiKey || cfg.chat.baseUrl),
      vision: Boolean(cfg.vision?.apiKey || cfg.chat.apiKey),
      embedding: Boolean(cfg.embedding.apiKey),
      stt: Boolean(cfg.stt.apiKey),
      tts: Boolean(cfg.tts.apiKey),
      search: Boolean(cfg.search.apiKey || cfg.deepseek.apiKey),
    },
    shared,
    sharedUsed,
    defaults: {
      preferences: DEFAULT_PREFS,
      services: SERVICE_TYPES,
      labels: SERVICE_LABELS,
    },
  };
}

export default function register() {
  const r = Router();
  r.use(requireAuth);

  r.get('/', (req, res) => {
    res.json(configPayload(req.userId));
  });

  r.put(
    '/api',
    asyncHandler(async (req, res) => {
      const body = req.body || {};
      const patch = sanitizeLegacyService(body);
      const profiles = sanitizeProfiles(body, req.userId);
      if (profiles) patch.profiles = profiles;
      const active = sanitizeActive(body);
      if (active) patch.active = active;
      if (body.modelSource === 'system' || body.modelSource === 'own') patch.modelSource = body.modelSource;
      if (typeof body.systemProviderId === 'string') patch.systemProviderId = body.systemProviderId.trim().slice(0, 64);
      if (!Object.keys(patch).length) throw badRequest('没有可保存的配置项', 'empty_patch');
      saveUserApi(req.userId, patch);
      res.json({ ok: true, ...configPayload(req.userId) });
    }),
  );

  r.post(
    '/models',
    asyncHandler(async (req, res) => {
      const service = serviceKey(req.body?.service) || 'chat';
      const overrides = profileOverrides(req.userId, service, req.body?.profileId) || pickOverrides(req.body);
      const result = await listModels(req.userId, service, overrides);
      res.json({ ...result, service });
    }),
  );

  r.post(
    '/test',
    asyncHandler(async (req, res) => {
      const service = serviceKey(req.body?.service) || 'chat';
      const overrides = profileOverrides(req.userId, service, req.body?.profileId) || pickOverrides(req.body);
      const result = await testConnection(req.userId, service, overrides);
      res.status(result.ok ? 200 : 502).json({ ...result, service });
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
      const cfg = getUserApi(req.userId);
      res.json({
        model: {
          ...desc,
          contextWindow: tableCtx || desc.contextWindow,
          contextWindowSource: tableCtx ? 'table' : 'default',
          profileContextWindow: cfg.chat?.contextWindow || null,
          override: getPrefs(req.userId).contextLimits?.[id] || null,
        },
        routed: resolveModel(req.userId, String(req.query.task || 'main')),
      });
    }),
  );

  return r;
}
