// 环境与运行时配置加载（无外部依赖）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DATA_DIR = process.env.COCOA_DATA_DIR || path.join(ROOT, 'data');

// 读取 .env（不覆盖已存在的环境变量）
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv(path.join(ROOT, '.env'));
loadDotEnv(path.join(ROOT, 'server', '.env'));

fs.mkdirSync(DATA_DIR, { recursive: true });

function ensureMasterKey() {
  if (process.env.COCOA_MASTER_KEY && process.env.COCOA_MASTER_KEY.length >= 32) return process.env.COCOA_MASTER_KEY;
  const keyFile = path.join(DATA_DIR, '.masterkey');
  if (fs.existsSync(keyFile)) {
    const v = fs.readFileSync(keyFile, 'utf8').trim();
    if (v.length >= 32) return v;
  }
  const generated = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(keyFile, generated, { mode: 0o600 });
  console.warn('[env] COCOA_MASTER_KEY 未设置，已生成并保存到 data/.masterkey（请备份，丢失将无法解密历史数据）');
  return generated;
}

export const env = {
  root: ROOT,
  dataDir: DATA_DIR,
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',
  publicUrl: process.env.PUBLIC_URL || '',
  masterKey: ensureMasterKey(),
  dbPath: process.env.COCOA_DB_PATH || path.join(DATA_DIR, 'cocoa.db'),
  vaultDir: path.join(DATA_DIR, 'vault'),
  mediaDir: path.join(DATA_DIR, 'media'),
  logDir: path.join(DATA_DIR, 'logs'),
  tokenTtlSec: Number(process.env.COCOA_TOKEN_TTL || 60 * 60 * 24 * 3), // 3 天；客户端每日打开可续期至最多 4 天
  allowRegister: process.env.COCOA_ALLOW_REGISTER !== '0',
  bootstrapAdminEmail: process.env.COCOA_ADMIN_EMAIL || '',
  bootstrapAdminPassword: process.env.COCOA_ADMIN_PASSWORD || '',
  // 管理端默认邮箱服务（可被 admin_settings 覆盖）
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 465),
    secure: process.env.SMTP_SECURE !== '0',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || '',
  },
  // NapCat / OneBot11 反向 WS 默认配置（可被 admin_settings 覆盖）
  onebot: {
    token: process.env.ONEBOT_TOKEN || '',
    selfId: process.env.ONEBOT_SELF_ID || '',
    wsPath: process.env.ONEBOT_WS_PATH || '/onebot/ws',
  },
  embeddingDefault: {
    baseUrl: process.env.COCOA_EMBEDDING_BASE_URL || '',
    apiKey: process.env.COCOA_EMBEDDING_API_KEY || '',
    model: process.env.COCOA_EMBEDDING_MODEL || 'text-embedding-3-small',
  },
  searchDefault: {
    baseUrl: process.env.COCOA_SEARCH_BASE_URL || 'https://api.deepseek.com',
    apiKey: process.env.COCOA_SEARCH_API_KEY || '',
  },
};

for (const dir of [env.vaultDir, env.mediaDir, env.logDir, path.dirname(env.dbPath)]) {
  fs.mkdirSync(dir, { recursive: true });
}

export default env;
