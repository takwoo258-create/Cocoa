// 轻量后台任务队列（SQLite 持久化，调度器轮询执行）
import { all, run, get } from '../db/index.js';
import { nowIso, uuid, parseJson } from '../core/util.js';
import { encryptJson, decryptJson } from '../core/crypto.js';

export function enqueue(type, dueAt, payload = {}, { userId = null, characterId = null } = {}) {
  const id = `j_${uuid().replace(/-/g, '').slice(0, 16)}`;
  run(
    'INSERT INTO jobs(id, type, user_id, character_id, due_at, payload, status, created_at) VALUES(?,?,?,?,?,?,?,?)',
    id,
    type,
    userId,
    characterId,
    typeof dueAt === 'string' ? dueAt : new Date(dueAt).toISOString(),
    userId ? encryptJson(userId, payload) : JSON.stringify(payload),
    'pending',
    nowIso(),
  );
  return id;
}

export function dueJobs(limit = 20) {
  return all(
    "SELECT * FROM jobs WHERE status = 'pending' AND due_at <= ? ORDER BY due_at ASC LIMIT ?",
    nowIso(),
    limit,
  );
}

export function jobPayload(job) {
  try {
    return job.user_id ? decryptJson(job.user_id, job.payload, {}) : parseJson(job.payload, {});
  } catch {
    return {};
  }
}

export function markJob(id, status = 'done') {
  run('UPDATE jobs SET status = ? WHERE id = ?', status, id);
}

export function cancelJobs(characterId, type) {
  run("UPDATE jobs SET status = 'cancelled' WHERE character_id = ? AND type = ? AND status = 'pending'", characterId, type);
}

export function nextJob(characterId, type) {
  return get(
    "SELECT * FROM jobs WHERE character_id = ? AND type = ? AND status = 'pending' ORDER BY due_at ASC LIMIT 1",
    characterId,
    type,
  );
}
