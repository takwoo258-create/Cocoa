-- Cocoa 数据库结构（SQLite / WAL）
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',
  qq            TEXT UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL,
  last_login_at TEXT,
  last_active_at TEXT
);

CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id);

CREATE TABLE IF NOT EXISTS email_codes (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  purpose    TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  used       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_codes_email ON email_codes(email, purpose);

CREATE TABLE IF NOT EXISTS api_configs (
  user_id    TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id    TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS characters (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  age          TEXT,
  race         TEXT,
  gender       TEXT,
  personality  TEXT,
  worldview    TEXT,
  hobbies      TEXT,
  relation     TEXT,
  appearance   TEXT,
  occupation   TEXT,
  avatar       TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  archived     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_characters_user ON characters(user_id, archived);

CREATE TABLE IF NOT EXISTS character_templates (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_templates_user ON character_templates(user_id);

CREATE TABLE IF NOT EXISTS character_settings (
  character_id TEXT PRIMARY KEY,
  payload      TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS character_state (
  character_id TEXT PRIMARY KEY,
  motion       TEXT,
  psychology   TEXT,
  mood         TEXT,
  health       TEXT,
  sleep_state  TEXT NOT NULL DEFAULT 'awake',
  chat_count   INTEGER NOT NULL DEFAULT 0,
  chat_count_since_portrait INTEGER NOT NULL DEFAULT 0,
  last_portrait_at TEXT,
  intimacy     REAL NOT NULL DEFAULT 0,
  companion_since TEXT,
  updated_at   TEXT
);

CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,
  character_id  TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'main',
  title         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  token_used    INTEGER NOT NULL DEFAULT 0,
  context_limit INTEGER NOT NULL DEFAULT 128000,
  summary       TEXT,
  compressed_at TEXT,
  active        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_conversations_character ON conversations(character_id, kind, active);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  character_id    TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  role            TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'text',
  content         TEXT NOT NULL,
  meta            TEXT,
  tokens_in       INTEGER NOT NULL DEFAULT 0,
  tokens_out      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_character ON messages(character_id, created_at);

CREATE TABLE IF NOT EXISTS memories (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  character_id TEXT NOT NULL,
  big          TEXT NOT NULL,
  small        TEXT NOT NULL,
  content      TEXT NOT NULL,
  weight       REAL NOT NULL DEFAULT 0.5,
  embedding    BLOB,
  source       TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_character ON memories(character_id, big, small);

CREATE TABLE IF NOT EXISTS memory_links (
  a          TEXT NOT NULL,
  b          TEXT NOT NULL,
  score      REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (a, b)
);

CREATE TABLE IF NOT EXISTS portraits (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  character_id TEXT NOT NULL,
  content      TEXT NOT NULL,
  analysis     TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_portraits_character ON portraits(character_id, created_at);

CREATE TABLE IF NOT EXISTS changelogs (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  character_id TEXT NOT NULL,
  content      TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS books (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  character_id TEXT NOT NULL,
  type         TEXT NOT NULL,
  title        TEXT NOT NULL,
  content      TEXT,
  day          TEXT,
  meta         TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_books_character ON books(character_id, type, created_at);

CREATE TABLE IF NOT EXISTS diary_locks (
  character_id TEXT NOT NULL,
  day          TEXT NOT NULL,
  hash         TEXT NOT NULL,
  salt         TEXT NOT NULL,
  hint         TEXT,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (character_id, day)
);

CREATE TABLE IF NOT EXISTS wait_states (
  user_id      TEXT NOT NULL,
  character_id TEXT NOT NULL,
  mode         TEXT NOT NULL DEFAULT 'idle',
  last_agent_at TEXT,
  deadline     TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT,
  PRIMARY KEY (user_id, character_id)
);

CREATE TABLE IF NOT EXISTS usage_records (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  character_id   TEXT,
  kind           TEXT NOT NULL,
  model          TEXT NOT NULL,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  cached_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  cost           REAL NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_user_time ON usage_records(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_time ON usage_records(created_at);

CREATE TABLE IF NOT EXISTS intimacy_log (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  character_id TEXT NOT NULL,
  value        REAL NOT NULL,
  source       TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intimacy_character ON intimacy_log(character_id, created_at);

CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  user_id      TEXT,
  character_id TEXT,
  due_at       TEXT NOT NULL,
  payload      TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status, due_at);

CREATE TABLE IF NOT EXISTS admin_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         TEXT PRIMARY KEY,
  actor_id   TEXT,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  ip         TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(created_at);

CREATE TABLE IF NOT EXISTS media (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  character_id TEXT,
  kind         TEXT NOT NULL,
  path         TEXT NOT NULL,
  mime         TEXT,
  size         INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS onebot_messages (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  qq         TEXT,
  direction  TEXT NOT NULL,
  content    TEXT,
  created_at TEXT NOT NULL
);
