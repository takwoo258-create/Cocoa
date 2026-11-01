import { run, all, get } from '../db/index.js';
import { nowIso, uuid } from '../core/util.js';
import { encryptSystem, decryptSystem } from '../core/crypto.js';

export function audit(actorId, action, target = null, detail = null, ip = null) {
  run(
    'INSERT INTO audit_logs(id, actor_id, action, target, detail, ip, created_at) VALUES(?,?,?,?,?,?,?)',
    uuid(),
    actorId,
    action,
    target,
    detail ? encryptSystem(JSON.stringify(detail)) : null,
    ip,
    nowIso(),
  );
}

export function listAudit({ page = 1, size = 50, action = null } = {}) {
  const offset = (page - 1) * size;
  const rows = action
    ? all('SELECT * FROM audit_logs WHERE action = ? ORDER BY created_at DESC LIMIT ? OFFSET ?', action, size, offset)
    : all('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ? OFFSET ?', size, offset);
  return rows.map((r) => ({
    ...r,
    detail: r.detail ? (() => {
      try {
        return JSON.parse(decryptSystem(r.detail));
      } catch {
        return null;
      }
    })() : null,
  }));
}
