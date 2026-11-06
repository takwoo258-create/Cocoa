// 增量迁移：兼容已存在的 SQLite 数据库（幂等）
import logger from '../core/logger.js';

function columns(db, table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  } catch {
    return [];
  }
}

function addColumn(db, table, name, ddl) {
  if (!columns(db, table).includes(name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
    logger.info('迁移：新增列', `${table}.${name}`);
  }
}

export function runMigrations(db) {
  addColumn(db, 'users', 'code', 'INTEGER');
  addColumn(db, 'auth_tokens', 'last_renew_at', 'TEXT');
  addColumn(db, 'characters', 'qq_enabled', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'character_state', 'last_manual_refresh_at', 'TEXT');
  addColumn(db, 'character_state', 'sleep_schedule', 'TEXT');
  addColumn(db, 'character_state', 'sleep_since', 'TEXT');
  addColumn(db, 'character_state', 'next_sleep_change', 'TEXT');
  addColumn(db, 'users', 'share_id', 'TEXT');
  addColumn(db, 'books', 'series_id', 'TEXT');
  addColumn(db, 'books', 'session_id', 'TEXT');
  // v1.5.0 记忆点使用痕迹与情绪标签；日记密码（加密）供角色上下文使用
  addColumn(db, 'memories', 'last_used_at', 'TEXT');
  addColumn(db, 'memories', 'use_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'memories', 'emotion', 'TEXT');
  addColumn(db, 'diary_locks', 'code', 'TEXT');

  // 用户代号：按注册时间顺序补齐 1..N
  const missing = db.prepare('SELECT id FROM users WHERE code IS NULL ORDER BY created_at ASC, id ASC').all();
  if (missing.length) {
    let next = Number(db.prepare('SELECT COALESCE(MAX(code),0) AS m FROM users').get()?.m || 0);
    const update = db.prepare('UPDATE users SET code = ? WHERE id = ?');
    for (const row of missing) update.run(++next, row.id);
    logger.info('迁移：补齐用户代号', missing.length);
  }
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_code ON users(code)');
  } catch (err) {
    logger.warn('用户代号唯一索引创建失败', err.message);
  }

  // v1.5.0 共享广场：8 位 share ID（大小写字母+数字）
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const missingShare = db.prepare('SELECT id FROM users WHERE share_id IS NULL OR share_id = \'\'').all();
  for (const row of missingShare) {
    let sid = '';
    for (let i = 0; i < 8; i++) sid += alphabet[Math.floor(Math.random() * alphabet.length)];
    try {
      db.prepare('UPDATE users SET share_id = ? WHERE id = ?').run(sid, row.id);
    } catch (err) {
      logger.warn('share_id 生成冲突，跳过', err.message);
    }
  }
  if (missingShare.length) logger.info('迁移：补齐用户 share ID', missingShare.length);
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_share_id ON users(share_id)');
  } catch (err) {
    logger.warn('share ID 唯一索引创建失败', err.message);
  }

  // 历史 30 天令牌收紧为新的 3 天上限（仅处理明显超长的旧令牌）
  try {
    const cap = new Date(Date.now() + 4 * 86400000).toISOString();
    const maxNew = new Date(Date.now() + 3 * 86400000).toISOString();
    const longTokens = db.prepare('SELECT token_hash, expires_at FROM auth_tokens WHERE expires_at > ?').all(cap);
    const update = db.prepare('UPDATE auth_tokens SET expires_at = ?, last_renew_at = NULL WHERE token_hash = ?');
    for (const t of longTokens) update.run(maxNew, t.token_hash);
    if (longTokens.length) logger.info('迁移：收紧历史令牌有效期', longTokens.length);
  } catch (err) {
    logger.warn('令牌有效期迁移失败', err.message);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS model_shares (
      id           TEXT PRIMARY KEY,
      owner_id     TEXT NOT NULL,
      target_id    TEXT NOT NULL,
      direction    TEXT NOT NULL,
      services     TEXT NOT NULL,
      payload      TEXT,
      status       TEXT NOT NULL DEFAULT 'pending',
      permanent    INTEGER NOT NULL DEFAULT 0,
      duration     TEXT,
      expires_at   TEXT,
      note         TEXT,
      seen         INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL,
      responded_at TEXT,
      revoked_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_shares_target ON model_shares(target_id, status);
    CREATE INDEX IF NOT EXISTS idx_shares_owner ON model_shares(owner_id, status);
    CREATE INDEX IF NOT EXISTS idx_shares_expire ON model_shares(status, expires_at);

    CREATE TABLE IF NOT EXISTS upgrade_logs (
      id         TEXT PRIMARY KEY,
      actor_id   TEXT,
      from_version TEXT,
      to_version TEXT,
      status     TEXT NOT NULL,
      detail     TEXT,
      created_at TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS character_templates (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, profile TEXT NOT NULL,
      source_character_id TEXT, imported_from TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_templates_user ON character_templates(user_id, updated_at);

    CREATE TABLE IF NOT EXISTS plaza_resources (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL,
      title TEXT NOT NULL, description TEXT, payload TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'server', target_user_ids TEXT,
      token_soft INTEGER NOT NULL DEFAULT 0, token_hard INTEGER NOT NULL DEFAULT 0,
      permanent INTEGER NOT NULL DEFAULT 0, starts_at TEXT, expires_at TEXT,
      status TEXT NOT NULL DEFAULT 'active', like_count INTEGER NOT NULL DEFAULT 0,
      use_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_plaza_owner ON plaza_resources(owner_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_plaza_visibility ON plaza_resources(visibility, status, created_at);

    CREATE TABLE IF NOT EXISTS plaza_likes (
      resource_id TEXT NOT NULL, user_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(resource_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS plaza_grants (
      id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', used_tokens INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT,
      UNIQUE(resource_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_grants_user ON plaza_grants(user_id, status);
    CREATE TABLE IF NOT EXISTS plaza_bans (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'all',
      reason TEXT, until TEXT, created_by TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_plaza_bans_user ON plaza_bans(user_id, until);
  `);
  db.prepare("INSERT INTO meta(key, value) VALUES('schema_version','3') ON CONFLICT(key) DO UPDATE SET value='3'").run();
}

export function nextUserCode(db) {
  return Number(db.prepare('SELECT COALESCE(MAX(code),0) + 1 AS next FROM users').get()?.next || 1);
}
