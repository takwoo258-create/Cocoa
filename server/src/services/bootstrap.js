import env from '../env.js';
import { get, run } from '../db/index.js';
import { hashPassword, randomToken } from '../core/crypto.js';
import { nowIso } from '../core/util.js';
import logger from '../core/logger.js';

export function ensureBootstrapAdmin() {
  const existing = get("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  if (existing) return existing.id;
  const email = env.bootstrapAdminEmail;
  const password = env.bootstrapAdminPassword;
  if (!email || !password) {
    logger.warn('未配置管理员账号（COCOA_ADMIN_EMAIL / COCOA_ADMIN_PASSWORD），跳过初始化');
    return null;
  }
  const { hash, salt } = hashPassword(password);
  const id = `u_${randomToken(8)}`;
  run(
    `INSERT INTO users(id, username, email, password_hash, password_salt, role, qq, email_verified, created_at)
     VALUES(?,?,?,?,?,'admin',?,1,?)`,
    id,
    'admin',
    email.toLowerCase(),
    hash,
    salt,
    null,
    nowIso(),
  );
  logger.info('已创建超级管理员', email);
  return id;
}
