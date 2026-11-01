import { get, run } from '../db/index.js';
import { verifyToken, sha256 } from '../core/crypto.js';
import { unauthorized, forbidden } from '../core/errors.js';
import { nowIso } from '../core/util.js';

function extractToken(req) {
  const header = req.headers?.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  if (req.query?.token) return String(req.query.token);
  return null;
}

export function resolveUser(token) {
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload?.uid) return null;
  const stored = get('SELECT * FROM auth_tokens WHERE token_hash = ?', sha256(token));
  if (!stored) return null;
  if (new Date(stored.expires_at).getTime() < Date.now()) return null;
  const user = get('SELECT * FROM users WHERE id = ?', payload.uid);
  if (!user || user.status !== 'active') return null;
  return user;
}

export function requireAuth(req, res, next) {
  const token = extractToken(req);
  const user = resolveUser(token);
  if (!user) return next(unauthorized());
  req.user = user;
  req.userId = user.id;
  req.token = token;
  // 活跃度（10 分钟内视为在线）
  const last = user.last_active_at ? new Date(user.last_active_at).getTime() : 0;
  if (Date.now() - last > 60_000) {
    run('UPDATE users SET last_active_at = ? WHERE id = ?', nowIso(), user.id);
  }
  next();
}

export function optionalAuth(req, _res, next) {
  const user = resolveUser(extractToken(req));
  if (user) {
    req.user = user;
    req.userId = user.id;
  }
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return next(unauthorized());
  if (req.user.role !== 'admin') return next(forbidden('仅超级管理员可访问'));
  next();
}
