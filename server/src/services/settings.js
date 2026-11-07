import { get, all, run } from '../db/index.js';
import { encryptJson, decryptJson, encryptSystem, decryptSystem } from '../core/crypto.js';
import { nowIso, parseJson } from '../core/util.js';
import env from '../env.js';

// v1.2.0 模型分享：可分享的服务集合（search 复用 deepseek，仅作兼容）
export const SHARE_SERVICES = ['chat', 'embedding', 'deepseek', 'stt', 'tts', 'search', 'image'];
const SHARE_CACHE_TTL_MS = 10_000;
const shareCache = new Map(); // userId -> { at, data }

const DEFAULT_API = {
  chat: { baseUrl: '', apiKey: '', model: '' },
  vision: { baseUrl: '', apiKey: '', model: '' },
  image: { baseUrl: '', apiKey: '', model: '' },
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
  voiceReplyMode: 'auto', // auto=仅收到语音时；always=每条都发语音；off=关闭
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

export const SERVICE_TYPES = ['chat', 'vision', 'image', 'tts', 'stt', 'embedding', 'search'];
// 兼容旧字段名：deepseek 与 search 指向同一套配置
export const PROVIDER_SERVICES = [...SERVICE_TYPES, 'deepseek'];
const SERVICE_ALIAS = { deepseek: 'search' };
const MAX_PROFILES_PER_SERVICE = 20;
const SERVICE_KEYS = ['baseUrl', 'apiKey', 'model', 'voice', 'extra', 'contextWindow'];

export const SERVICE_LABELS = {
  chat: '对话模型',
  vision: '视觉模型',
  image: '生图模型',
  tts: '语音合成',
  stt: '语音识别',
  embedding: '嵌入模型',
  search: '网页搜索',
  deepseek: 'DeepSeek',
};

function clipText(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function normalizeContextWindow(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1000) return null;
  return Math.round(Math.min(n, 10_000_000));
}

/**
 * 单条服务配置（v1.5.0）：同一服务类型可建多条，按服务切换生效。
 * 与旧的「一个提供源挂多个服务模型」不同，每条只描述一个服务的提供方与模型。
 */
export function normalizeServiceProfile(input = {}, { mask = false } = {}) {
  const apiKey = String(input.apiKey ?? '');
  const extra = input.extra && typeof input.extra === 'object' && !Array.isArray(input.extra) ? input.extra : {};
  return {
    id: clipText(input.id || input.profileId, 64) || `pf_${Math.random().toString(36).slice(2, 10)}`,
    name: clipText(input.name || input.label, 60) || '未命名配置',
    baseUrl: clipText(input.baseUrl, 500),
    apiKey: mask ? (apiKey ? '****' : '') : apiKey,
    model: clipText(input.model, 120),
    voice: clipText(input.voice, 100),
    contextWindow: normalizeContextWindow(input.contextWindow),
    extra,
  };
}

function emptyProfileStore() {
  const store = {};
  for (const svc of SERVICE_TYPES) store[svc] = [];
  store.active = {};
  return store;
}

function legacyMirrors(store) {
  const out = {};
  for (const svc of SERVICE_TYPES) {
    const p = store[svc].find((x) => x.id === store.active[svc]) || store[svc][0] || null;
    if (!p) continue;
    const conf = { baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model, voice: p.voice, extra: p.extra };
    if (svc === 'search') out.deepseek = { ...conf };
    out[svc] = conf;
  }
  return out;
}

/**
 * 读取用户配置并迁移为「按服务多配置」结构：
 * - 旧结构的顶层 chat/tts/… 会转成各自服务下名为「默认配置」的一条
 * - 旧结构的 providers（一个提供源挂多个服务模型）拆成每个服务一条
 * - 迁移幂等：profiles 已存在时不会重复生成
 */
export function normalizeProfileStore(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const store = emptyProfileStore();
  const hasProfiles = Boolean(src.profiles && typeof src.profiles === 'object');
  const rawProfiles = hasProfiles ? src.profiles : {};
  for (const svc of SERVICE_TYPES) {
    const list = Array.isArray(rawProfiles[svc]) ? rawProfiles[svc] : [];
    store[svc] = list.slice(0, MAX_PROFILES_PER_SERVICE).map((p) => normalizeServiceProfile(p));
  }
  if (!hasProfiles) {
    for (const svc of SERVICE_TYPES) {
      const conf = src[svc];
      if (!conf || typeof conf !== 'object' || Array.isArray(conf)) continue;
      const model = clipText(conf.model, 120);
      const apiKey = String(conf.apiKey ?? '');
      const baseUrl = clipText(conf.baseUrl, 500);
      if (!model && !apiKey && !baseUrl) continue;
      store[svc].push(normalizeServiceProfile({ id: `pf_legacy_${svc}`, name: '默认配置', ...conf }));
    }
  }
  const providers = hasProfiles ? [] : (Array.isArray(src.providers) ? src.providers : []);
  for (const provider of providers) {
    const norm = normalizeProvider(provider);
    for (const key of Object.keys(norm.models || {})) {
      const svc = SERVICE_ALIAS[key] || key;
      if (!SERVICE_TYPES.includes(svc)) continue;
      const model = norm.models[key];
      if (!model) continue;
      if (store[svc].some((p) => p.id === norm.id)) continue;
      store[svc].push(
        normalizeServiceProfile({
          id: norm.id,
          name: norm.name,
          baseUrl: norm.baseUrl,
          apiKey: norm.apiKey,
          model,
          voice: norm.voice,
          contextWindow: norm.contextWindow,
          extra: norm.extra,
        }),
      );
    }
  }
  const activeSrc = src.active && typeof src.active === 'object' ? src.active : {};
  const legacyActive = src.activeProviderId && typeof src.activeProviderId === 'object' ? src.activeProviderId : {};
  for (const svc of SERVICE_TYPES) {
    const wanted = clipText(activeSrc[svc] || legacyActive[svc] || legacyActive.default, 64);
    const hit = wanted ? store[svc].find((p) => p.id === wanted) : null;
    store.active[svc] = hit ? hit.id : store[svc][0]?.id || '';
  }
  return store;
}

/** 对外展示：密钥掩码，不含明文 */
export function getProfileStorePublic(userId) {
  const store = normalizeProfileStore(getUserApiRaw(userId));
  const services = {};
  for (const svc of SERVICE_TYPES) {
    services[svc] = store[svc].map((p) => {
      const masked = normalizeServiceProfile(p, { mask: true });
      return {
        ...masked,
        apiKeySet: Boolean(p.apiKey),
        apiKeyMasked: p.apiKey ? `${p.apiKey.slice(0, 4)}****${p.apiKey.slice(-4)}` : '',
        ready: Boolean(p.apiKey || p.baseUrl),
      };
    });
  }
  return { active: { ...store.active }, services };
}

/** 规范化单个模型提供源（管理端统一模型仍用这一层）；mask=true 时不返回 apiKey 明文 */
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
    contextWindow: normalizeContextWindow(input.contextWindow),
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

function profileServiceConfig(profile) {
  return {
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    model: profile.model,
    voice: profile.voice || '',
    extra: profile.extra || {},
    contextWindow: profile.contextWindow || null,
    profileId: profile.id,
    profileName: profile.name,
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
    contextWindow: provider.contextWindow || null,
    profileId: provider.id,
    profileName: provider.name,
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
  const store = normalizeProfileStore(raw);
  const merged = mergeDeep(DEFAULT_API, {});
  const systemCfg = getSystemModelsConfig();
  const usingSystem = raw.modelSource === 'system' && systemCfg.enabled && systemCfg.providers.length > 0;
  const providerMeta = {};

  for (const svc of SERVICE_TYPES) {
    const own = store[svc].find((p) => p.id === store.active[svc]) || store[svc][0] || null;
    if (usingSystem) {
      const provider = pickProvider(systemCfg.providers, raw.systemProviderId, svc);
      const conf = provider ? providerServiceConfig(provider, svc) : null;
      if (conf) {
        merged[svc] = { ...merged[svc], ...conf };
        providerMeta[svc] = { source: 'system', providerId: provider.id, providerName: provider.name, profileId: provider.id, profileName: provider.name };
        continue;
      }
    }
    if (own && (own.apiKey || own.baseUrl || own.model)) {
      merged[svc] = { ...merged[svc], ...profileServiceConfig(own) };
      providerMeta[svc] = { source: 'own', profileId: own.id, profileName: own.name };
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
  merged.activeProfile = { ...store.active };
  merged.contextWindow = merged.chat.contextWindow || null;

  // v1.2.0：用户未配置 apiKey 的服务，自动合并有效的他人分享
  const { shared, meta } = getSharedApi(userId);
  const effectiveMeta = {};
  for (const [svc, conf] of Object.entries(shared)) {
    const target = SERVICE_ALIAS[svc] || svc;
    if (merged[target]?.apiKey) continue;
    merged[target] = { ...(merged[target] || {}), ...conf };
    merged.providerMeta[target] = { source: 'shared', providerId: meta[svc]?.shareId || '', providerName: meta[svc]?.ownerNickname || '' };
    if (meta[svc]) effectiveMeta[target] = meta[svc];
  }
  if (!merged.search.apiKey && merged.deepseek.apiKey) {
    merged.search = { ...merged.search, apiKey: merged.deepseek.apiKey, baseUrl: merged.deepseek.baseUrl };
  }
  merged.deepseek = { ...merged.deepseek, ...merged.search, model: merged.search.model || merged.deepseek.model };

  // 元信息（不含 apiKey），供 GET /api/config 展示：
  // shared = 所有生效中的分享；sharedUsed = 实际被采用的分享
  merged.shared = meta;
  merged.sharedUsed = effectiveMeta;
  return merged;
}

/** 保存配置：支持 v1.5.0 的 profiles/active，也兼容旧结构（单服务对象 / providers） */
export function saveUserApi(userId, patch) {
  const raw = getUserApiRaw(userId);
  const store = normalizeProfileStore(raw);
  const body = patch && typeof patch === 'object' ? patch : {};
  let profilesTouched = false;

  if (body.profiles && typeof body.profiles === 'object') {
    for (const svc of SERVICE_TYPES) {
      if (!Array.isArray(body.profiles[svc])) continue;
      profilesTouched = true;
      store[svc] = body.profiles[svc]
        .slice(0, MAX_PROFILES_PER_SERVICE)
        .map((p) => normalizeServiceProfile(p));
      if (!store[svc].some((p) => p.id === store.active[svc])) store.active[svc] = store[svc][0]?.id || '';
    }
  }
  if (body.active && typeof body.active === 'object') {
    for (const svc of SERVICE_TYPES) {
      if (typeof body.active[svc] !== 'string') continue;
      const id = body.active[svc].slice(0, 64);
      if (!id) continue;
      if (store[svc].some((p) => p.id === id)) store.active[svc] = id;
    }
  }
  for (const svc of SERVICE_TYPES) {
    const input = body[svc];
    if (!input || typeof input !== 'object' || Array.isArray(input)) continue;
    let profile = store[svc].find((x) => x.id === store.active[svc]) || store[svc][0];
    if (!profile) {
      profile = normalizeServiceProfile({ id: `pf_${svc}`, name: '默认配置' });
      store[svc].unshift(profile);
      store.active[svc] = profile.id;
    }
    for (const key of SERVICE_KEYS) {
      if (input[key] === undefined) continue;
      if (key === 'extra') {
        if (input.extra && typeof input.extra === 'object' && !Array.isArray(input.extra)) profile.extra = input.extra;
        continue;
      }
      if (key === 'contextWindow') {
        profile.contextWindow = normalizeContextWindow(input.contextWindow);
        continue;
      }
      profile[key] = clipText(input[key], key === 'apiKey' ? 400 : key === 'baseUrl' ? 500 : 120);
    }
  }

  const next = { ...raw, ...body };
  delete next.profiles;
  delete next.active;
  const mirrors = legacyMirrors(store);
  for (const svc of SERVICE_TYPES) {
    delete next[svc];
  }
  delete next.deepseek;
  Object.assign(next, mirrors);
  if (profilesTouched) {
    // 已经转成 profiles，旧的提供源结构不再保留，避免删除后又被迁移回来
    delete next.providers;
    delete next.activeProviderId;
  }
  next.v = 2;
  next.profiles = {};
  for (const svc of SERVICE_TYPES) next.profiles[svc] = store[svc];
  next.active = { ...store.active };

  run(
    'INSERT INTO api_configs(user_id, payload, updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at',
    userId,
    encryptJson(userId, next),
    nowIso(),
  );
  invalidateShareCache(userId);
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
