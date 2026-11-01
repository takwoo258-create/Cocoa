import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import env from '../env.js';
import logger from '../core/logger.js';

const schemaPath = path.join(import.meta.dirname, 'schema.sql');

export const db = new DatabaseSync(env.dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 8000;');
db.exec('PRAGMA synchronous = NORMAL;');
db.exec(fs.readFileSync(schemaPath, 'utf8'));

const stmtCache = new Map();
function stmt(sql) {
  let s = stmtCache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    if (stmtCache.size > 500) stmtCache.clear();
    stmtCache.set(sql, s);
  }
  return s;
}

function norm(params) {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p instanceof Date) return p.toISOString();
    if (Buffer.isBuffer(p) || p instanceof Uint8Array) return p;
    return p;
  });
}

export function all(sql, ...params) {
  return stmt(sql).all(...norm(params));
}
export function get(sql, ...params) {
  return stmt(sql).get(...norm(params));
}
export function run(sql, ...params) {
  return stmt(sql).run(...norm(params));
}
export function exec(sql) {
  db.exec(sql);
}
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw err;
  }
}

export function getMeta(key, fallback = null) {
  const row = get('SELECT value FROM meta WHERE key = ?', key);
  return row ? row.value : fallback;
}
export function setMeta(key, value) {
  run('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
}
export function dbStats() {
  const fileSize = fs.existsSync(env.dbPath) ? fs.statSync(env.dbPath).size : 0;
  const walSize = fs.existsSync(env.dbPath + '-wal') ? fs.statSync(env.dbPath + '-wal').size : 0;
  return { fileSize, walSize, total: fileSize + walSize };
}

setMeta('schema_version', '1');
logger.info('数据库已就绪', env.dbPath);

export default { db, all, get, run, exec, tx };
