import { get, run } from '../db/index.js';
import { encryptJson, decryptJson, encryptSystem, decryptSystem } from '../core/crypto.js';
import { nowIso, parseJson } from '../core/util.js';
import env from '../env.js';

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
  limits: { hardTokens: 0, softTokens: 0 },
  contextLimits: {},
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

export function getUserApi(userId) {
  const raw = getUserApiRaw(userId);
  const merged = mergeDeep(DEFAULT_API, raw);
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
