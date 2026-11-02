import { get, all, run } from '../db/index.js';
import { encryptJson, decryptJson, encryptSystem, decryptSystem } from '../core/crypto.js';
import { nowIso, parseJson } from '../core/util.js';
import env from '../env.js';

// v1.2.0 模型分享：可分享的服务集合（search 复用 deepseek，仅作兼容）
export const SHARE_SERVICES = ['chat', 'embedding', 'deepseek', 'stt', 'tts', 'search'];
const SHARE_CACHE_TTL_MS = 10_000;
const shareCache = new Map(); // userId -> { at, data }

const DEFAULT_API = {
  chat: { baseUrl: '', apiKey: '', model: '' },
  embedding: { baseUrl: '', apiKey: '', model: 'text-embedding-3-small' },
  deepseek: { baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-chat' },
  stt: { baseUrl: 'https://api.xiaomimimo.com/v1', apiKey: '', model: 'mimo-audio' },
  tts: { baseUrl: 'https://api.breezeblue.ai/v1', apiKey: '', model: 'breeze-tts-2', voice: 'default' },
  search: { baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-chat' },
};

const DEFAULT_PREFS = {
  debug: false,
  thinking: false,
  activeReply: true,
  modelRouting: {
    main: '', sentence: '', profile: '', portrait: '', creation: '', status: '',
    memory: '', vision: '', news: '', search: '', tts: '', stt: '',
  },
  limits: { enabled: true, hardTokens: 0, softTokens: 0 },
  contextLimits: {}, // { "gpt-4o-mini": 128000, "default": 65536 }
  segmentEnabled: true,
  language: 'zh-CN',
};

function mergeDeep(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = mergeDeep(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

export function getUserApiRaw(userId) {
  const row = get('SELECT payload FROM api_configs WHERE user_id = ?', userId);
  return row ? decryptJson(userId, row.payload, {}) : {};
}

function parseShareServices(text) {
  try {
    const arr = JSON.parse(String(text || '[]'));
    if (!Array.isArray(arr)) return [];
    return arr.map((s) => String(s)).filter((s) => SHARE_SERVICES.includes(s));
  } catch {
    return [];
  }
}

/**
 * v1.2.0：解析“分享给该用户且仍然有效”的模型配置。
 * - direction=share：owner 分享给 target → 使用方是 target，payload 用 owner 密钥加密
 * - direction=request：owner 向 target 索要 → 使用方是 owner，payload 用 target 密钥加密
 * 返回 { shared: {service: config}, meta: {service: {shareId,ownerCode,ownerNickname,expiresAt,model}} }
 * 绝不对外返回 apiKey，仅用于服务端调用。
 */
export function getSharedApi(userId) {
  const uid = String(userId || '');
  if (!uid) return { shared: {}, meta: {} };
  const cached = shareCache.get(uid);
  if (cached && Date.now() - cached.at < SHARE_CACHE_TTL_MS) return cached.data;

  const now = nowIso();
  const rows = all(
    `SELECT * FROM model_shares
      WHERE status IN ('accepted', 'active')
        AND (permanent = 1 OR expires_at IS NULL OR expires_at > ?)
        AND (owner_id = ? OR target_id = ?)
      ORDER BY created_at ASC`,
    now,
    uid,
    uid,
  );
  const entries = [];
  const ownerIds = new Set();
  for (const row of rows) {
    const consumerId = row.direction === 'request' ? row.owner_id : row.target_id;
    if (consumerId !== uid) continue;
    const configOwnerId = row.direction === 'request' ? row.target_id : row.owner_id;
    entries.push({ row, configOwnerId });
    ownerIds.add(configOwnerId);
  }
  const owners = new Map();
  for (const id of ownerIds) {
    const u = get('SELECT id, code, username FROM users WHERE id = ?', id);
    if (u) owners.set(id, u);
  }

  const shared = {};
  const meta = {};
  for (const { row, configOwnerId } of entries) {
    const payload = decryptJson(configOwnerId, row.payload, null);
    if (!payload || typeof payload !== 'object') continue;
    const owner = owners.get(configOwnerId) || {};
    for (const svc of parseShareServices(row.services)) {
      if (shared[svc]) continue; // 多个分享时先到先得
      const conf = payload[svc];
      if (!conf || !conf.apiKey) continue;
      shared[svc] = {
        baseUrl: conf.baseUrl || '',
        apiKey: String(conf.apiKey),
        model: conf.model || '',
        voice: conf.voice || '',
        extra: conf.extra && typeof conf.extra === 'object' ? conf.extra : {},
      };
      meta[svc] = {
        shareId: row.id,
        ownerId: configOwnerId,
        ownerCode: owner.code ?? null,
        ownerNickname: owner.username || '',
        expiresAt: row.expires_at || null,
        permanent: Boolean(row.permanent),
        model: conf.model || '',
        direction: row.direction,
      };
    }
  }
  const data = { shared, meta };
  if (shareCache.size > 4000) shareCache.clear();
  shareCache.set(uid, { at: Date.now(), data });
  return data;
}

/** 分享创建/响应/撤销/到期后清理缓存（不传 userId 清空全部） */
export function invalidateShareCache(userId = null) {
  if (userId) shareCache.delete(String(userId));
  else shareCache.clear();
}

export const PROVIDER_SERVICES = ['chat', 'embedding', 'deepseek', 'stt', 'tts'];

const PROVIDER_LABELS = { chat: '对话', embedding: '嵌入', deepseek: 'DeepSeek', stt: '语音识别', tts: '语音合成' };

/** 规范化单个模型提供源；mask=true 时不返回 apiKey 明文 */
export function normalizeProvider(input = {}, { mask = false } = {}) {
  const svcModels = {};
  for (const svc of PROVIDER_SERVICES) {
    const model = input.models?.[svc] ?? input[svc] ?? '';
    if (model !== undefined && model !== null && String(model).trim()) svcModels[svc] = String(model).trim();
  }
  const apiKey = String(input.apiKey || '');
  return {
    id: String(input.id || input.providerId || '').trim().slice(0, 64) || `prov_${Math.random().toString(36).slice(2, 10)}`,
    name: String(input.name || input.providerName || '未命名模型').trim().slice(0, 60),
    baseUrl: String(input.baseUrl || '').trim().slice(0, 500),
    apiKey: mask ? (apiKey ? '****' : '') : apiKey,
    models: svcModels,
    voice: String(input.voice || '').trim().slice(0, 100),
    extra: input.extra && typeof input.extra === 'object' && !Array.isArray(input.extra) ? input.extra : {},
  };
}

/** 管理端统一模型配置（含明文 key，仅服务端内部使用） */
export function getSystemModelsConfig() {
  const raw = getAdminSetting('system_models', {}) || {};
  const providers = Array.isArray(raw.providers) ? raw.providers.map((p) => normalizeProvider(p)) : [];
  return { enabled: Boolean(raw.enabled), providers };
}

/** 对外展示的统一模型配置（key 掩码） */
export function getSystemModelsPublic() {
  const cfg = getSystemModelsConfig();
  return {
    enabled: cfg.enabled,
    providers: cfg.providers.map((p) => ({ ...normalizeProvider(p, { mask: true }), services: Object.keys(p.models) })),
  };
}

function providerServiceConfig(provider, svc) {
  const model = provider.models?.[svc] || '';
  if (!model) return null;
  return {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model,
    voice: provider.voice || '',
    extra: provider.extra || {},
    providerId: provider.id,
    providerName: provider.name,
  };
}

function pickProvider(providers, preferredId, svc) {
  const list = Array.isArray(providers) ? providers : [];
  if (preferredId) {
    const hit = list.find((p) => p && String(p.id) === String(preferredId));
    if (hit) return hit;
  }
  return list.find((p) => p && p.models && p.models[svc]) || null;
}

export function getUserApi(userId) {
  const raw = getUserApiRaw(userId);
  const merged = mergeDeep(DEFAULT_API, raw);
  const systemCfg = getSystemModelsConfig();
  const usingSystem = raw.modelSource === 'system' && systemCfg.enabled && systemCfg.providers.length > 0;
  const ownProviders = Array.isArray(raw.providers) ? raw.providers.map((p) => normalizeProvider(p)) : [];
  const activeMap = raw.activeProviderId && typeof raw.activeProviderId === 'object' ? raw.activeProviderId : {};
  const providerMeta = {};

  if (usingSystem) {
    for (const svc of PROVIDER_SERVICES) {
      const provider = pickProvider(systemCfg.providers, raw.systemProviderId, svc);
      const conf = provider ? providerServiceConfig(provider, svc) : null;
      if (conf) {
        merged[svc] = { ...merged[svc], ...conf };
        providerMeta[svc] = { source: 'system', providerId: provider.id, providerName: provider.name };
      }
    }
  } else if (ownProviders.length) {
    for (const svc of PROVIDER_SERVICES) {
      const provider = pickProvider(ownProviders, activeMap[svc] || activeMap.default, svc);
      const conf = provider ? providerServiceConfig(provider, svc) : null;
      if (conf) {
        merged[svc] = { ...merged[svc], ...conf };
        providerMeta[svc] = { source: 'own', providerId: provider.id, providerName: provider.name };
      }
    }
  }

  // 未配置时回退到部署级默认（嵌入/搜索）
  if (!merged.embedding.apiKey && env.embeddingDefault.apiKey) {
    merged.embedding = { ...merged.embedding, ...env.embeddingDefault };
  }
  if (!merged.search.apiKey && env.searchDefault.apiKey) {
    merged.search = { ...merged.search, ...env.searchDefault };
  }
  if (!merged.deepseek.apiKey && merged.chat.apiKey && /deepseek/i.test(merged.chat.baseUrl || merged.chat.model || '')) {
    merged.deepseek = { ...merged.deepseek, apiKey: merged.chat.apiKey, baseUrl: merged.chat.baseUrl || merged.deepseek.baseUrl };
  }
  if (!merged.search.apiKey && merged.deepseek.apiKey) {
    merged.search = { ...merged.search, apiKey: merged.deepseek.apiKey, baseUrl: merged.deepseek.baseUrl };
  }

  merged.providerMeta = providerMeta;
  merged.modelSource = usingSystem ? 'system' : (raw.modelSource === 'own' ? 'own' : (raw.modelSource || 'own'));
  merged.systemProviderId = raw.systemProviderId || '';
  merged.systemEnabled = systemCfg.enabled;
  merged.ownProviderCount = ownProviders.length;

  // v1.2.0：用户未配置 apiKey 的服务，自动合并有效的他人分享
  const { shared, meta } = getSharedApi(userId);
  const effectiveMeta = {};
  for (const [svc, conf] of Object.entries(shared)) {
    if (merged[svc]?.apiKey) continue;
    merged[svc] = { ...(merged[svc] || {}), ...conf };
    merged.providerMeta[svc] = { source: 'shared', providerId: meta[svc]?.shareId || '', providerName: meta[svc]?.ownerNickname || '' };
    if (meta[svc]) effectiveMeta[svc] = meta[svc];
  }
  if (!merged.deepseek.apiKey && merged.chat.apiKey && /deepseek/i.test(merged.chat.baseUrl || merged.chat.model || '')) {
    merged.deepseek = { ...merged.deepseek, apiKey: merged.chat.apiKey, baseUrl: merged.chat.baseUrl || merged.deepseek.baseUrl };
  }
  if (!merged.search.apiKey && merged.deepseek.apiKey) {
    merged.search = { ...merged.search, apiKey: merged.deepseek.apiKey, baseUrl: merged.deepseek.baseUrl };
  }
  // 元信息（不含 apiKey），供 GET /api/config 展示；仅包含实际生效的分享服务
  merged.shared = effectiveMeta;
  return merged;
}

export function saveUserApi(userId, patch) {
  const current = getUserApiRaw(userId);
  const next = mergeDeep(current, patch);
  // 空字符串视为清除
  for (const svc of Object.keys(next)) {
    if (next[svc] && typeof next[svc] === 'object') {
      for (const [k, v] of Object.entries(next[svc])) {
        if (v === null) delete next[svc][k];
      }
    }
  }
  run(
    'INSERT INTO api_configs(user_id, payload, updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at',
    userId,
    encryptJson(userId, next),
    nowIso(),
  );
  return getUserApi(userId);
}

export function hasChatConfig(userId) {
  const cfg = getUserApi(userId);
  return Boolean(cfg.chat.apiKey && (cfg.chat.baseUrl || cfg.chat.apiKey));
}

export function getPrefs(userId) {
  const row = get('SELECT payload FROM user_preferences WHERE user_id = ?', userId);
  const raw = row ? decryptJson(userId, row.payload, {}) : {};
  return mergeDeep(DEFAULT_PREFS, raw);
}

export function savePrefs(userId, patch) {
  const current = getPrefs(userId);
  const next = mergeDeep(current, patch);
  run(
    'INSERT INTO user_preferences(user_id, payload, updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at',
    userId,
    encryptJson(userId, next),
    nowIso(),
  );
  return next;
}

export function getAdminSetting(key, fallback = null) {
  const row = get('SELECT value FROM admin_settings WHERE key = ?', key);
  if (!row) return fallback;
  const raw = decryptSystem(row.value);
  return parseJson(raw, fallback);
}

export function setAdminSetting(key, value) {
  run(
    'INSERT INTO admin_settings(key, value, updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
    key,
    encryptSystem(JSON.stringify(value ?? null)),
    nowIso(),
  );
}

export function getSmtpConfig() {
  return mergeDeep(env.smtp, getAdminSetting('smtp', {}) || {});
}

export function getOnebotConfig() {
  return mergeDeep(env.onebot, getAdminSetting('onebot', {}) || {});
}

export { DEFAULT_API, DEFAULT_PREFS, mergeDeep };
