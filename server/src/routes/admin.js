// 管理端路由：全站概览 / 用户管理 / 用量 / 会话 / 日志审计 / SMTP 与 OneBot 配置 / 存储
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { requireAuth, requireAdmin } from '../auth/middleware.js';
import { asyncHandler, badRequest, notFound, conflict, upstream } from '../core/errors.js';
import { all, get, run, dbStats } from '../db/index.js';
import { nowIso, asInt, clamp, truncate } from '../core/util.js';
import { maskSecret, decryptText, decryptJson } from '../core/crypto.js';
import { publicUser } from './auth.js';
import { audit, listAudit } from '../services/audit.js';
import { getAdminSetting, setAdminSetting, getSmtpConfig, getOnebotConfig, mergeDeep } from '../services/settings.js';
import { sendMail } from '../mail/sender.js';
import { usageFor } from './stats.js';
import { onebotStatus } from '../onebot/server.js';
import env from '../env.js';

const KEEP = new Set(['****', '••••••••', '[REDACTED]', 'unchanged']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ROLES = new Set(['user', 'admin']);
const STATUSES = new Set(['active', 'disabled']);
const ONLINE_WINDOW_MS = 10 * 60 * 1000;
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'tmp']);
const MAX_DIR_ENTRIES = 20_000;

const round = (n, digit = 4) => {
  const f = 10 ** digit;
  return Math.round(Number(n || 0) * f) / f;
};

function paging(query) {
  const page = Math.max(1, asInt(query.page, 1));
  const size = clamp(asInt(query.size, 20), 1, 100);
  return { page, size, offset: (page - 1) * size };
}

function dirSize(target, { maxDepth = 4, maxEntries = MAX_DIR_ENTRIES } = {}) {
  if (!target || !fs.existsSync(target)) return { bytes: 0, files: 0, truncated: false };
  let total = 0;
  let files = 0;
  const stack = [[target, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files >= maxEntries) return { bytes: total, files, truncated: true };
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.has(entry.name)) stack.push([full, depth + 1]);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        total += fs.statSync(full).size;
        files += 1;
      } catch {
        /* 忽略瞬时删除的文件 */
      }
    }
  }
  return { bytes: total, files, truncated: false };
}

/** 存储用量：数据库 + WAL、消息（vault）、媒体、缓存（未来会被清除的目录） */
export function storageUsage() {
  const { fileSize, walSize } = dbStats();
  const vault = dirSize(env.vaultDir, { maxDepth: 6 });
  const media = dirSize(env.mediaDir, { maxDepth: 4 });
  const cache = dirSize(path.join(env.dataDir, 'cache'), { maxDepth: 3 });
  return {
    db: fileSize,
    wal: walSize,
    messages: vault.bytes,
    media: media.bytes,
    cache: cache.bytes,
    total: fileSize + walSize + vault.bytes + media.bytes + cache.bytes,
    detail: {
      messages: { files: vault.files, truncated: vault.truncated },
      media: { files: media.files, truncated: media.truncated },
      cache: { files: cache.files, truncated: cache.truncated },
    },
  };
}

function maskedSmtp() {
  const cfg = getSmtpConfig();
  return {
    host: cfg.host || '',
    port: Number(cfg.port) || 465,
    secure: Boolean(cfg.secure),
    user: cfg.user || '',
    from: cfg.from || '',
    passSet: Boolean(cfg.pass),
    passMasked: maskSecret(cfg.pass),
  };
}

function maskedOnebot() {
  const cfg = getOnebotConfig();
  return {
    tokenSet: Boolean(cfg.token),
    tokenMasked: maskSecret(cfg.token),
    selfId: cfg.selfId || '',
    wsPath: cfg.wsPath || '/onebot/ws',
  };
}

function sanitizeSmtp(input) {
  const patch = {};
  if (input?.host !== undefined) patch.host = String(input.host || '').trim().slice(0, 200);
  if (input?.port !== undefined) {
    const port = asInt(input.port, 465);
    if (port < 1 || port > 65535) throw badRequest('SMTP 端口需在 1-65535 之间', 'smtp_port_invalid');
    patch.port = port;
  }
  if (input?.secure !== undefined) patch.secure = Boolean(input.secure);
  if (input?.user !== undefined) patch.user = String(input.user || '').trim().slice(0, 200);
  if (input?.from !== undefined) patch.from = String(input.from || '').trim().slice(0, 200);
  if (typeof input?.pass === 'string') {
    if (KEEP.has(input.pass)) {
      /* 保持原值 */
    } else {
      patch.pass = input.pass.trim().slice(0, 400);
    }
  }
  return patch;
}

function sanitizeOnebot(input) {
  const patch = {};
  if (typeof input?.token === 'string') {
    if (!KEEP.has(input.token)) patch.token = input.token.trim().slice(0, 400);
  }
  if (input?.selfId !== undefined) {
    const selfId = String(input.selfId || '').trim();
    if (selfId && !/^\d{5,12}$/.test(selfId)) throw badRequest('机器人 QQ 号格式不正确', 'onebot_selfid_invalid');
    patch.selfId = selfId;
  }
  if (input?.wsPath !== undefined) {
    const wsPath = String(input.wsPath || '').trim();
    if (wsPath && !/^\/[A-Za-z0-9_\-/]{0,80}$/.test(wsPath)) throw badRequest('WS 路径需以 / 开头且仅含字母数字、-、_', 'onebot_ws_path_invalid');
    patch.wsPath = wsPath || '/onebot/ws';
  }
  return patch;
}

function usageByUser(from, to, model = null) {
  const where = ['ur.created_at >= ?', 'ur.created_at <= ?'];
  const params = [from, to];
  if (model) {
    where.push('ur.model = ?');
    params.push(model);
  }
  return all(
    `SELECT ur.user_id AS userId, COALESCE(u.username, '') AS username,
            COALESCE(SUM(ur.input_tokens), 0) AS input,
            COALESCE(SUM(ur.cached_tokens), 0) AS cached,
            COALESCE(SUM(ur.output_tokens), 0) AS output,
            COALESCE(SUM(ur.cost), 0) AS cost,
            COUNT(*) AS calls
       FROM usage_records ur LEFT JOIN users u ON u.id = ur.user_id
      WHERE ${where.join(' AND ')}
      GROUP BY ur.user_id ORDER BY cost DESC`,
    ...params,
  ).map((row) => ({
    userId: row.userId,
    username: row.username,
    input: row.input,
    inputHit: row.cached,
    inputMiss: Math.max(0, row.input - row.cached),
    output: row.output,
    total: row.input + row.output,
    cost: round(row.cost, 6),
    calls: row.calls,
  }));
}

function characterNameMap(rows) {
  const map = new Map();
  for (const row of rows) {
    try {
      map.set(row.id, decryptText(row.user_id, row.name || ''));
    } catch {
      map.set(row.id, '');
    }
  }
  return map;
}

function safeDecrypt(userId, value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  try {
    return decryptText(userId, value);
  } catch {
    return fallback;
  }
}

export default function register() {
  const r = Router();
  r.use(requireAuth, requireAdmin);

  // ---------- 概览 ----------
  r.get('/overview', (req, res) => {
    const totalUsers = get('SELECT COUNT(*) AS n FROM users').n;
    const onlineSince = new Date(Date.now() - ONLINE_WINDOW_MS).toISOString();
    const weekSince = new Date(Date.now() - 7 * 86400000).toISOString();
    const online = get('SELECT COUNT(*) AS n FROM users WHERE last_active_at >= ?', onlineSince).n;
    const active7d = get('SELECT COUNT(*) AS n FROM users WHERE last_active_at >= ?', weekSince).n;
    const onlineRatio = totalUsers ? online / totalUsers : 0;
    const active7dRatio = totalUsers ? active7d / totalUsers : 0;
    const activeIndex = Math.round(onlineRatio * 60 + active7dRatio * 40);

    const conversationTotal = get('SELECT COUNT(*) AS n FROM conversations').n;
    const conversationActive = get('SELECT COUNT(*) AS n FROM conversations WHERE active = 1').n;
    const characters = get('SELECT COUNT(*) AS n FROM characters WHERE archived = 0').n;
    const messages = get('SELECT COUNT(*) AS n FROM messages').n;
    const usage = get(
      'SELECT COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(cached_tokens),0) AS cached, COALESCE(SUM(output_tokens),0) AS output, COALESCE(SUM(cost),0) AS cost, COUNT(*) AS calls FROM usage_records',
    );

    res.json({
      users: { total: totalUsers, online, onlineWindowMin: 10, active7d },
      activeIndex,
      formula: 'activeIndex = round(在线用户占比 × 60 + 近7日活跃用户占比 × 40)，占比分母为注册用户总数（在线 = 10 分钟内有活跃）',
      components: {
        onlineRatio: round(onlineRatio),
        active7dRatio: round(active7dRatio),
        onlineWeight: 60,
        active7dWeight: 40,
      },
      conversations: { total: conversationTotal, active: conversationActive, inactive: conversationTotal - conversationActive },
      characters,
      messages,
      usage: {
        input: usage.input,
        inputHit: usage.cached,
        inputMiss: Math.max(0, usage.input - usage.cached),
        output: usage.output,
        total: usage.input + usage.output,
        cost: round(usage.cost, 6),
        calls: usage.calls,
      },
      storage: storageUsage(),
      onebot: onebotStatus(),
      generatedAt: nowIso(),
    });
  });

  // ---------- 用户管理 ----------
  r.get('/users', (req, res) => {
    const { page, size, offset } = paging(req.query);
    const q = String(req.query.q || '').trim();
    const where = [];
    const params = [];
    if (q) {
      where.push('(username LIKE ? OR email LIKE ? OR COALESCE(qq, \'\') LIKE ? OR id LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const total = get(`SELECT COUNT(*) AS n FROM users${clause}`, ...params).n;
    const rows = all(`SELECT * FROM users${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`, ...params, size, offset);

    const counts = new Map();
    for (const row of all('SELECT user_id, COUNT(*) AS n FROM characters WHERE archived = 0 GROUP BY user_id')) {
      counts.set(row.user_id, row.n);
    }
    const convCounts = new Map();
    for (const row of all('SELECT user_id, COUNT(*) AS n FROM conversations GROUP BY user_id')) {
      convCounts.set(row.user_id, row.n);
    }
    const onlineSince = new Date(Date.now() - ONLINE_WINDOW_MS).toISOString();
    const items = rows.map((row) => ({
      ...publicUser(row),
      characters: counts.get(row.id) || 0,
      conversations: convCounts.get(row.id) || 0,
      online: Boolean(row.last_active_at && row.last_active_at >= onlineSince),
    }));
    res.json({ items, total, page, size });
  });

  r.put('/users/:id', (req, res) => {
    const target = get('SELECT * FROM users WHERE id = ?', req.params.id);
    if (!target) throw notFound('用户不存在', 'user_not_found');
    const body = req.body || {};
    const patch = {};

    if (body.role !== undefined) {
      const role = String(body.role);
      if (!ROLES.has(role)) throw badRequest('角色仅支持 user/admin', 'role_invalid');
      if (target.id === req.userId && role !== 'admin') throw badRequest('不能降低当前登录账号的权限', 'self_demote_forbidden');
      if (role !== 'admin' && target.role === 'admin') {
        const admins = get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").n;
        if (admins <= 1) throw conflict('至少需要保留一名超级管理员', 'last_admin');
      }
      patch.role = role;
    }
    if (body.status !== undefined) {
      const status = String(body.status);
      if (!STATUSES.has(status)) throw badRequest('状态仅支持 active/disabled', 'status_invalid');
      if (target.id === req.userId && status !== 'active') throw badRequest('不能停用当前登录的管理员账号', 'self_disable_forbidden');
      patch.status = status;
    }
    if (body.qq !== undefined) {
      const qq = String(body.qq || '').trim();
      if (qq && !/^\d{5,12}$/.test(qq)) throw badRequest('QQ 号格式不正确', 'qq_invalid');
      if (qq && get('SELECT id FROM users WHERE qq = ? AND id <> ?', qq, target.id)) throw conflict('该 QQ 号已绑定其他账号', 'qq_taken');
      patch.qq = qq || null;
    }
    if (!Object.keys(patch).length) throw badRequest('没有可修改的字段', 'empty_patch');

    const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
    run(`UPDATE users SET ${sets} WHERE id = ?`, ...Object.values(patch), target.id);
    if (patch.status === 'disabled') run('DELETE FROM auth_tokens WHERE user_id = ?', target.id);
    const updated = get('SELECT * FROM users WHERE id = ?', target.id);
    audit(req.userId, 'admin.user.update', target.id, { changes: patch }, req.ip);
    res.json({ user: publicUser(updated) });
  });

  // ---------- 用量（支持单用户筛选） ----------
  r.get('/usage', (req, res) => {
    const userId = req.query.userId ? String(req.query.userId) : null;
    if (userId && !get('SELECT id FROM users WHERE id = ?', userId)) throw notFound('用户不存在', 'user_not_found');
    const data = usageFor({ userId, query: req.query });
    res.json({
      ...data,
      userId,
      byUser: userId ? undefined : usageByUser(data.from, data.to, data.model),
    });
  });

  // ---------- 会话列表 / 详情 ----------
  r.get('/conversations', (req, res) => {
    const { page, size, offset } = paging(req.query);
    const userId = req.query.userId ? String(req.query.userId) : null;
    const clause = userId ? ' WHERE c.user_id = ?' : '';
    const params = userId ? [userId] : [];
    const total = get(`SELECT COUNT(*) AS n FROM conversations c${clause}`, ...params).n;
    const rows = all(
      `SELECT c.*, u.username AS username
         FROM conversations c LEFT JOIN users u ON u.id = c.user_id
         ${clause}
        ORDER BY c.updated_at DESC LIMIT ? OFFSET ?`,
      ...params,
      size,
      offset,
    );
    const charRows = all('SELECT id, user_id, name FROM characters');
    const names = characterNameMap(charRows);
    const msgCounts = new Map();
    for (const row of all('SELECT conversation_id, COUNT(*) AS n FROM messages GROUP BY conversation_id')) {
      msgCounts.set(row.conversation_id, row.n);
    }
    const items = rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      username: row.username || '',
      characterId: row.character_id,
      characterName: names.get(row.character_id) || '',
      kind: row.kind,
      title: safeDecrypt(row.user_id, row.title, ''),
      tokenUsed: row.token_used,
      contextLimit: row.context_limit,
      active: Boolean(row.active),
      messageCount: msgCounts.get(row.id) || 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      compressedAt: row.compressed_at,
    }));
    res.json({ items, total, page, size });
  });

  r.get('/conversations/:id', (req, res) => {
    const row = get('SELECT * FROM conversations WHERE id = ?', req.params.id);
    if (!row) throw notFound('会话不存在', 'conversation_not_found');
    const character = get('SELECT id, user_id, name FROM characters WHERE id = ?', row.character_id);
    const user = get('SELECT username, email FROM users WHERE id = ?', row.user_id);
    const messageCount = get('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?', row.id).n;
    const bookCount = get('SELECT COUNT(*) AS n FROM books WHERE character_id = ?', row.character_id).n;
    const recent = all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 20', row.id)
      .reverse()
      .map((m) => ({
        id: m.id,
        role: m.role,
        kind: m.kind,
        content: safeDecrypt(row.user_id, m.content, ''),
        meta: decryptJson(row.user_id, m.meta, null),
        createdAt: m.created_at,
      }));
    res.json({
      conversation: {
        id: row.id,
        userId: row.user_id,
        username: user?.username || '',
        characterId: row.character_id,
        characterName: character ? safeDecrypt(row.user_id, character.name, '') : '',
        kind: row.kind,
        title: safeDecrypt(row.user_id, row.title, ''),
        tokenUsed: row.token_used,
        contextLimit: row.context_limit,
        active: Boolean(row.active),
        summary: row.summary ? safeDecrypt(row.user_id, row.summary, '') : '',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        compressedAt: row.compressed_at,
      },
      messageCount,
      bookCount,
      recent,
    });
  });

  // ---------- 日志审计 ----------
  r.get('/logs', (req, res) => {
    const { page, size } = paging(req.query);
    const action = req.query.action ? String(req.query.action) : null;
    const total = action
      ? get('SELECT COUNT(*) AS n FROM audit_logs WHERE action = ?', action).n
      : get('SELECT COUNT(*) AS n FROM audit_logs').n;
    const items = listAudit({ page, size, action });
    const actorIds = [...new Set(items.map((i) => i.actor_id).filter(Boolean))];
    const actors = new Map();
    for (const id of actorIds) {
      const u = get('SELECT id, username, email FROM users WHERE id = ?', id);
      if (u) actors.set(id, u);
    }
    res.json({
      items: items.map((i) => ({
        ...i,
        actorName: actors.get(i.actor_id)?.username || '',
        actorEmail: actors.get(i.actor_id)?.email || '',
      })),
      total,
      page,
      size,
    });
  });

  // ---------- 服务端配置 ----------
  r.get('/settings', (req, res) => {
    const smtp = getSmtpConfig();
    const onebot = getOnebotConfig();
    res.json({
      smtp: maskedSmtp(),
      onebot: maskedOnebot(),
      ready: {
        smtp: Boolean(smtp.host && smtp.user),
        onebot: Boolean(onebot.token || onebot.selfId),
      },
    });
  });

  r.put('/settings', (req, res) => {
    const body = req.body || {};
    const changed = [];
    const submitted = [];
    if (body.smtp && typeof body.smtp === 'object') {
      submitted.push('smtp');
      const patch = sanitizeSmtp(body.smtp);
      if (Object.keys(patch).length) {
        const next = mergeDeep(getAdminSetting('smtp', {}) || {}, patch);
        setAdminSetting('smtp', next);
        changed.push('smtp');
      }
    }
    if (body.onebot && typeof body.onebot === 'object') {
      submitted.push('onebot');
      const patch = sanitizeOnebot(body.onebot);
      if (Object.keys(patch).length) {
        const next = mergeDeep(getAdminSetting('onebot', {}) || {}, patch);
        setAdminSetting('onebot', next);
        changed.push('onebot');
      }
    }
    if (!submitted.length) throw badRequest('没有可保存的配置项', 'empty_patch');
    // 仅提交掩码（****）视为保持原值，幂等返回当前配置
    if (changed.length) audit(req.userId, 'admin.settings.update', null, { sections: changed }, req.ip);
    res.json({
      ok: true,
      changed,
      smtp: maskedSmtp(),
      onebot: maskedOnebot(),
    });
  });

  r.post(
    '/settings/test-mail',
    asyncHandler(async (req, res) => {
      const to = String(req.body?.to || '').trim();
      if (!EMAIL_RE.test(to)) throw badRequest('收件邮箱格式不正确', 'email_invalid');
      const cfg = getSmtpConfig();
      if (!cfg.host || !cfg.user) throw badRequest('邮件服务未配置，请先填写 SMTP 主机与账号', 'smtp_not_configured');
      let result;
      try {
        result = await sendMail({
          to,
          subject: 'Cocoa 测试邮件',
          text: '这是一封来自 Cocoa 的测试邮件。收到它说明 SMTP 配置可用。',
          html: '<div style="font-family:system-ui;padding:24px"><h2>Cocoa</h2><p>这是一封测试邮件，收到它说明 SMTP 配置可用。</p></div>',
        });
      } catch (err) {
        throw upstream(`测试邮件发送失败：${truncate(err.message || '未知错误', 200)}`, 'mail_failed');
      }
      if (!result?.ok) throw badRequest('邮件服务未配置，测试邮件未发送', result?.reason || 'smtp_not_configured');
      audit(req.userId, 'admin.settings.test_mail', to, null, req.ip);
      res.json({ ok: true, to, at: nowIso() });
    }),
  );

  // ---------- 存储 ----------
  r.get('/storage', (_req, res) => {
    res.json(storageUsage());
  });

  // ---------- OneBot 状态 ----------
  r.get('/onebot/status', (_req, res) => {
    res.json({ ...onebotStatus(), config: maskedOnebot() });
  });

  return r;
}
