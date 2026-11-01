// 加密基座：双层 AES-256-GCM（用户域密钥 + 服务器密钥）、scrypt 口令、HMAC 令牌
import crypto from 'node:crypto';
import env from '../env.js';

const master = Buffer.from(env.masterKey, 'utf8');
const serverKey = Buffer.from(crypto.hkdfSync('sha256', master, Buffer.from('cocoa-server-v1'), Buffer.from('cocoa.data.server'), 32));
const tokenKey = Buffer.from(crypto.hkdfSync('sha256', master, Buffer.from('cocoa-token-v1'), Buffer.from('cocoa.auth.token'), 32));
const codeKey = Buffer.from(crypto.hkdfSync('sha256', master, Buffer.from('cocoa-code-v1'), Buffer.from('cocoa.auth.code'), 32));
const keyCache = new Map();

function userKey(userId) {
  const id = String(userId || 'anonymous');
  if (keyCache.has(id)) return keyCache.get(id);
  const key = Buffer.from(
    crypto.hkdfSync('sha256', master, Buffer.from(`user:${id}`), Buffer.from('cocoa.data.user'), 32),
  );
  if (keyCache.size > 2000) keyCache.clear();
  keyCache.set(id, key);
  return key;
}

function gcmEncrypt(key, plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

function gcmDecrypt(key, blob) {
  if (!Buffer.isBuffer(blob) || blob.length < 29) throw new Error('ciphertext too short');
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

function toBuf(v) {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  return Buffer.from(String(v), 'utf8');
}

/** 双层加密文本（用户域 + 服务器域），返回 'c2.<base64url>' */
export function encryptText(userId, plaintext) {
  const inner = gcmEncrypt(userKey(userId), toBuf(plaintext ?? ''));
  const outer = gcmEncrypt(serverKey, inner);
  return 'c2.' + outer.toString('base64url');
}

/** 系统级加密（无用户域），返回 's1.<base64url>' */
export function decryptSystem(blob) {
  const s = String(blob ?? '');
  if (s.startsWith('s1.')) return gcmDecrypt(serverKey, Buffer.from(s.slice(3), 'base64url')).toString('utf8');
  return s;
}

export function encryptSystem(plaintext) {
  return 's1.' + gcmEncrypt(serverKey, toBuf(plaintext ?? '')).toString('base64url');
}

export function decryptText(userId, blob) {
  const s = String(blob ?? '');
  if (s.startsWith('c2.')) {
    const outer = gcmDecrypt(serverKey, Buffer.from(s.slice(3), 'base64url'));
    return gcmDecrypt(userKey(userId), outer).toString('utf8');
  }
  if (s.startsWith('s1.')) {
    return gcmDecrypt(serverKey, Buffer.from(s.slice(3), 'base64url')).toString('utf8');
  }
  // 兼容历史明文（仅用于迁移前数据）
  return s;
}

export function encryptJson(userId, obj) {
  return encryptText(userId, JSON.stringify(obj ?? null));
}

export function decryptJson(userId, blob, fallback = null) {
  try {
    const txt = decryptText(userId, blob);
    if (!txt) return fallback;
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}

export function isEncrypted(v) {
  const s = String(v ?? '');
  return s.startsWith('c2.') || s.startsWith('s1.');
}

// ---------- 口令 ----------
export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return false;
  const calc = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  const a = Buffer.from(calc, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- 令牌（HMAC-SHA256，JWT 形态） ----------
const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function signToken(payload, ttlSec = env.tokenTtlSec) {
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ ...payload, iat: Date.now(), exp: Date.now() + ttlSec * 1000 }));
  const sig = crypto.createHmac('sha256', tokenKey).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expect = crypto.createHmac('sha256', tokenKey).update(`${header}.${body}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

export function hmac(text, key = codeKey) {
  return crypto.createHmac('sha256', key).update(String(text)).digest('hex');
}

export function randomCode(digits = 6) {
  let out = '';
  for (let i = 0; i < digits; i++) out += crypto.randomInt(0, 10);
  return out;
}

export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function maskSecret(v) {
  const s = String(v || '');
  if (!s) return '';
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

export const __internal = { userKey, serverKey };
