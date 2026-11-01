// v1.2.0 模型分享：创建 / 响应 / 撤销 / 列表 / 到期巡检 + 多通道通知
// 约定：
// - direction=share：owner 分享自己的配置给 target（使用方 target，payload 用 owner 密钥加密）
// - direction=request：owner 向 target 索要配置（使用方 owner，payload 在接受时用 target 密钥加密）
// - status: pending | accepted | rejected | revoked | expired
import { all, get, run } from '../db/index.js';
import { encryptJson } from '../core/crypto.js';
import { nowIso, uuid, asInt, parseJson, truncate } from '../core/util.js';
import { badRequest, conflict, forbidden, notFound } from '../core/errors.js';
import { getUserApiRaw, invalidateShareCache, SHARE_SERVICES } from './settings.js';
import { audit } from './audit.js';
import { broadcast } from '../realtime/hub.js';
import logger from '../core/logger.js';

export const SHARE_STATUSES = ['pending', 'accepted', 'rejected', 'revoked', 'expired'];
export const SERVICE_LABELS = {
  chat: '对话模型',
  embedding: '嵌入模型',
  deepseek: 'DeepSeek',
  stt: '语音识别',
  tts: '语音合成',
  search: '网页搜索',
};
const DURATION_KEYS = ['years', 'months', 'weeks', 'days', 'hours', 'minutes'];
const DURATION_UNITS = { years: '年', months: '个月', weeks: '周', days: '天', hours: '小时', minutes: '分钟' };
const EXPIRES_AT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const WATCH_INTERVAL_MS = 60_000;

// ---------------- 工具 ----------------

function parseServices(text) {
  try {
    const arr = JSON.parse(String(text || '[]'));
    if (!Array.isArray(arr)) return [];
    return arr.map((s) => String(s)).filter((s) => SHARE_SERVICES.includes(s));
  } catch {
    return [];
  }
}

export function normalizeServices(input) {
  const arr = Array.isArray(input) ? input : [];
  const list = [...new Set(arr.map((s) => String(s || '').trim().toLowerCase()))].filter((s) =>
    SHARE_SERVICES.includes(s),
  );
  if (!list.length) throw badRequest('请选择要分享/索要的服务（chat、embedding 等）', 'services_required');
  if (list.length > SHARE_SERVICES.length) throw badRequest('服务列表不合法', 'services_invalid');
  return list;
}

export function normalizeDuration(input) {
  if (!input || typeof input !== 'object') return null;
  const d = {};
  let total = 0;
  for (const key of DURATION_KEYS) {
    const n = Math.max(0, Math.min(9999, asInt(input[key], 0)));
    d[key] = n;
    total += n;
  }
  return total > 0 ? d : null;
}

export function durationText(d = {}) {
  const parts = DURATION_KEYS.filter((key) => d[key] > 0).map((key) => `${d[key]} ${DURATION_UNITS[key]}`);
  return parts.length ? parts.join(' ') : '0 分钟';
}

/** 日历计算：年/月按日历加减（末日夹取），周/天/时/分按绝对时长 */
export function addCalendar(base, d = {}) {
  const dt = new Date(base.getTime());
  if (d.years) dt.setUTCFullYear(dt.getUTCFullYear() + d.years);
  if (d.months) {
    const day = dt.getUTCDate();
    dt.setUTCDate(1);
    dt.setUTCMonth(dt.getUTCMonth() + d.months);
    const lastDay = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
    dt.setUTCDate(Math.min(day, lastDay));
  }
  const ms = ((d.weeks || 0) * 7 + (d.days || 0)) * 86400_000 + (d.hours || 0) * 3600_000 + (d.minutes || 0) * 60_000;
  return new Date(dt.getTime() + ms);
}

/** 'YYYY-MM-DD HH:mm:ss'（UTC+8）→ ISO UTC */
export function parseExpiresAt(text) {
  const s = String(text || '').trim();
  if (!EXPIRES_AT_RE.test(s)) throw badRequest('截止时间格式应为 YYYY-MM-DD HH:mm:ss（UTC+8）', 'expires_at_invalid');
  const date = new Date(`${s.replace(' ', 'T')}+08:00`);
  if (Number.isNaN(date.getTime())) throw badRequest('截止时间不是合法时间', 'expires_at_invalid');
  return date;
}

function fmtUtc8(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const t = new Date(d.getTime() + 8 * 3600_000).toISOString();
  return `${t.slice(0, 10)} ${t.slice(11, 19)}`;
}

function userLabel(user = {}) {
  const code = user.code ?? null;
  const name = user.username || '';
  return code != null ? `#${code} ${name}` : name || '未知用户';
}

function userBrief(id) {
  const u = get('SELECT id, code, username FROM users WHERE id = ?', id);
  if (!u) return { id, code: null, nickname: '' };
  return { id: u.id, code: u.code ?? null, nickname: u.username || '' };
}

export function resolveTarget(actorId, identifier) {
  const key = String(identifier ?? '').trim();
  if (!key) throw badRequest('请填写对方的用户代号或邮箱', 'target_required');
  let user = null;
  if (/^\d+$/.test(key)) user = get('SELECT * FROM users WHERE code = ?', Number(key));
  if (!user && key.includes('@')) user = get('SELECT * FROM users WHERE email = ?', key.toLowerCase());
  if (!user) throw notFound('未找到该用户，请检查用户代号或邮箱', 'share_target_not_found');
  if (user.id === actorId) throw badRequest('不能向自己分享/索要模型', 'share_self');
  if (user.status !== 'active') throw badRequest('对方账号已停用', 'share_target_disabled');
  return user;
}

function pickConfiguredConfig(userId, services) {
  const raw = getUserApiRaw(userId) || {};
  const out = {};
  for (const svc of services) {
    const conf = raw[svc];
    if (!conf || !conf.apiKey) continue;
    out[svc] = {
      baseUrl: String(conf.baseUrl || ''),
      apiKey: String(conf.apiKey),
      model: String(conf.model || ''),
      voice: String(conf.voice || ''),
      extra: conf.extra && typeof conf.extra === 'object' ? conf.extra : {},
    };
  }
  return Object.keys(out).length ? out : null;
}

function effectiveStatus(row) {
  if ((row.status === 'accepted' || row.status === 'active') && row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
    return 'expired';
  }
  return row.status === 'active' ? 'accepted' : row.status;
}

export function toShare(row, viewerId) {
  const owner = userBrief(row.owner_id);
  const target = userBrief(row.target_id);
  const status = effectiveStatus(row);
  const isParty = row.owner_id === viewerId || row.target_id === viewerId;
  return {
    id: row.id,
    direction: row.direction,
    status,
    owner,
    target,
    services: parseServices(row.services),
    permanent: Boolean(row.permanent),
    duration: row.duration ? parseJson(row.duration, null) : null,
    expiresAt: row.expires_at || null,
    note: row.note || '',
    createdAt: row.created_at,
    respondedAt: row.responded_at || null,
    revokedAt: row.revoked_at || null,
    seen: Boolean(row.seen),
    canRespond: isParty && status === 'pending' && row.target_id === viewerId,
    canRevoke: isParty && (status === 'pending' || status === 'accepted'),
    side: row.owner_id === viewerId ? 'owner' : row.target_id === viewerId ? 'target' : null,
  };
}

function windowText(row) {
  if (row.permanent) return '永久有效';
  if (row.expires_at) return `截止 ${fmtUtc8(row.expires_at)}（UTC+8）`;
  const d = row.duration ? parseJson(row.duration, null) : null;
  if (d) return `时长 ${durationText(d)}（接受后开始计时）`;
  return '未设置时长';
}

function serviceText(list) {
  return list.map((s) => SERVICE_LABELS[s] || s).join('、') || '模型服务';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function mailHtml(title, lines) {
  return `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#faf7f2;padding:24px">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:14px;padding:24px 26px;border:1px solid #f0e6da">
    <h2 style="margin:0 0 14px;color:#8a5a2b;font-size:18px">${escapeHtml(title)}</h2>
    ${lines.map((l) => `<p style="margin:8px 0;color:#4a4a4a;line-height:1.7;font-size:14px">${escapeHtml(l)}</p>`).join('')}
    <p style="margin-top:22px;font-size:12px;color:#9b9b9b">此邮件由 Cocoa 自动发送，请勿直接回复。</p>
  </div>
</div>`;
}

// ---------------- 通知 ----------------

let onebotModule = null;
async function sendQq(userId, text) {
  const user = get('SELECT id, qq FROM users WHERE id = ?', userId);
  if (!user?.qq) return;
  try {
    if (!onebotModule) onebotModule = await import('../onebot/server.js');
    if (typeof onebotModule.sendPrivate !== 'function') return;
    await onebotModule.sendPrivate(user.qq, text);
  } catch (err) {
    logger.warn('分享通知 QQ 发送失败', err?.message || err);
  }
}

/**
 * 邮件通知：优先使用 mail/sender.js 的品牌模板（sendShareNotice / sendExpiryNotice），
 * 模板缺失或调用异常时降级为 sendMail 纯文本；SMTP 未配置时静默跳过。
 */
async function sendMailNotice(userId, subject, lines, mailKind = 'share', payload = {}) {
  const user = get('SELECT id, email FROM users WHERE id = ?', userId);
  if (!user?.email) return;
  const html = mailHtml(subject, lines);
  try {
    const mod = await import('../mail/sender.js');
    if (mailKind === 'expired' && typeof mod.sendExpiryNotice === 'function') {
      try {
        await mod.sendExpiryNotice(user.email, payload);
        return;
      } catch (err) {
        logger.warn('sendExpiryNotice 调用失败，降级 sendMail', err?.message || err);
      }
    }
    if (typeof mod.sendShareNotice === 'function') {
      try {
        await mod.sendShareNotice(user.email, payload);
        return;
      } catch (err) {
        logger.warn('sendShareNotice 调用失败，降级 sendMail', err?.message || err);
      }
    }
    if (typeof mod.sendMail === 'function') {
      await mod.sendMail({ to: user.email, subject, text: lines.join('\n'), html });
    }
  } catch (err) {
    logger.warn('分享通知邮件失败', err?.message || err);
  }
}

function notify({ userIds = [], event = null, subject = 'Cocoa 模型分享', lines = [], mailKind = 'share', mailPayload = null }) {
  for (const uid of [...new Set(userIds.filter(Boolean))]) {
    if (event) {
      try {
        broadcast(uid, event);
      } catch (err) {
        logger.warn('分享通知 WS 推送失败', err?.message);
      }
    }
    void sendQq(uid, [subject, ...lines].join('\n'));
    const payload = typeof mailPayload === 'function' ? mailPayload(uid) || {} : mailPayload || {};
    void sendMailNotice(uid, subject, lines, mailKind, payload);
  }
}

/** 邮件模板 payload（mail/sender.js 的 shareNoticeTemplate/expiryNoticeTemplate 契约） */
function shareMailBase(row, extra = {}) {
  const owner = userBrief(row.owner_id);
  const target = userBrief(row.target_id);
  return {
    ownerName: owner.nickname || '',
    targetName: target.nickname || '',
    services: parseServices(row.services),
    permanent: Boolean(row.permanent),
    durationText: row.duration ? durationText(parseJson(row.duration, {}) || {}) : '',
    expiresAt: row.expires_at ? fmtUtc8(row.expires_at) : '',
    note: row.note || '',
    ...extra,
  };
}

// ---------------- 业务 ----------------

export function createShare(actorId, input = {}) {
  const direction = input.direction === 'request' ? 'request' : 'share';
  const target = resolveTarget(actorId, input.target);
  const requested = normalizeServices(input.services);
  const permanent = Boolean(input.permanent);
  let duration = null;
  let expiresAt = null;

  if (!permanent) {
    if (input.expiresAt) {
      const date = parseExpiresAt(input.expiresAt);
      if (date.getTime() <= Date.now()) throw badRequest('截止时间必须晚于当前时间', 'expires_at_past');
      expiresAt = date.toISOString();
    } else {
      duration = normalizeDuration(input.duration);
      if (!duration) throw badRequest('请设置分享时长、截止时间或永久有效', 'share_expiry_required');
    }
  }

  const note = truncate(String(input.note ?? '').trim(), 200);
  let services = requested;
  let payload = null;
  if (direction === 'share') {
    const conf = pickConfiguredConfig(actorId, requested);
    if (!conf) throw badRequest('你还没有可分享的模型配置，请先在设置中填写 API Key', 'share_no_config');
    services = Object.keys(conf);
    payload = encryptJson(actorId, conf);
  }

  const id = `sh_${uuid().replace(/-/g, '').slice(0, 18)}`;
  const createdAt = nowIso();
  run(
    `INSERT INTO model_shares(id, owner_id, target_id, direction, services, payload, status, permanent, duration, expires_at, note, seen, created_at)
     VALUES(?,?,?,?,?,?,'pending',?,?,?,?,0,?)`,
    id,
    actorId,
    target.id,
    direction,
    JSON.stringify(services),
    payload,
    permanent ? 1 : 0,
    duration ? JSON.stringify(duration) : null,
    expiresAt,
    note || null,
    createdAt,
  );

  const row = get('SELECT * FROM model_shares WHERE id = ?', id);
  const actor = userBrief(actorId);
  const verb = direction === 'request' ? '索要' : '分享';
  const lines = [
    `${userLabel(actor)} 向你发起了模型${verb}：${serviceText(services)}`,
    `有效期：${windowText(row)}`,
    ...(note ? [`留言：${note}`] : []),
    '打开 Cocoa → 设置 → 模型分享 处理，或直接在 QQ 回复「同意」/「拒绝」。',
  ];
  notify({
    userIds: [target.id],
    event: { type: 'share_request', share: toShare(row, target.id), at: nowIso() },
    subject: `【Cocoa】收到模型${verb}请求`,
    lines,
    mailKind: 'share',
    mailPayload: shareMailBase(row, { direction: row.direction }),
  });
  audit(actorId, 'share.create', id, { direction, targetId: target.id, services, permanent, expiresAt }, null);
  invalidateShareCache(actorId);
  invalidateShareCache(target.id);
  return toShare(row, actorId);
}

export function respondShare(actorId, id, accept) {
  const row = get('SELECT * FROM model_shares WHERE id = ?', String(id || ''));
  if (!row) throw notFound('分享记录不存在', 'share_not_found');
  if (row.target_id !== actorId) throw forbidden('无权处理该分享', 'share_forbidden');
  if (row.status !== 'pending') throw conflict('该分享已处理，请刷新列表', 'share_not_pending');

  const services = parseServices(row.services);
  if (!accept) {
    run("UPDATE model_shares SET status = 'rejected', responded_at = ? WHERE id = ?", nowIso(), row.id);
    const fresh = get('SELECT * FROM model_shares WHERE id = ?', row.id);
    const actor = userBrief(actorId);
    notify({
      userIds: [row.owner_id, row.target_id],
      event: { type: 'share_result', share: toShare(fresh, row.owner_id), accepted: false, at: nowIso() },
      subject: '【Cocoa】模型分享已被拒绝',
      lines: [`${userLabel(actor)} 拒绝了模型分享：${serviceText(services)}`, '如有需要，可以重新发起或与对方沟通。'],
      mailKind: 'share',
      mailPayload: shareMailBase(fresh, { direction: 'result', accepted: false }),
    });
    invalidateShareCache(row.owner_id);
    invalidateShareCache(row.target_id);
    return toShare(fresh, actorId);
  }

  const now = new Date();
  if (row.expires_at && new Date(row.expires_at).getTime() <= now.getTime()) {
    throw badRequest('该分享的截止时间已过，无法接受', 'share_expired');
  }

  let payload = row.payload;
  let granted = services;
  if (row.direction === 'request') {
    const conf = pickConfiguredConfig(row.target_id, services);
    if (!conf) throw badRequest('你没有可分享的模型配置，无法接受该请求', 'share_no_config');
    granted = Object.keys(conf);
    payload = encryptJson(row.target_id, conf);
  } else if (!payload) {
    throw badRequest('分享内容缺失，请让对方重新发起', 'share_payload_missing');
  }

  let expiresAt = row.expires_at || null;
  if (!row.permanent && !expiresAt) {
    const duration = row.duration ? parseJson(row.duration, null) : null;
    if (!duration) throw badRequest('分享时长缺失，请让对方重新发起', 'share_duration_missing');
    expiresAt = addCalendar(now, duration).toISOString();
  }
  if (row.permanent) expiresAt = null;

  run(
    "UPDATE model_shares SET status = 'accepted', payload = ?, services = ?, expires_at = ?, responded_at = ? WHERE id = ?",
    payload,
    JSON.stringify(granted),
    expiresAt,
    nowIso(),
    row.id,
  );
  const fresh = get('SELECT * FROM model_shares WHERE id = ?', row.id);
  const actor = userBrief(actorId);
  const owner = userBrief(row.owner_id);
  const target = userBrief(row.target_id);
  const lines = [
    `${userLabel(actor)} 已接受模型分享：${serviceText(granted)}`,
    `发起方：${userLabel(owner)}　对象：${userLabel(target)}`,
    `有效期：${windowText(fresh)}`,
  ];
  notify({
    userIds: [row.owner_id, row.target_id],
    event: { type: 'share_result', share: toShare(fresh, row.owner_id), accepted: true, at: nowIso() },
    subject: '【Cocoa】模型分享已接受',
    lines,
    mailKind: 'share',
    mailPayload: shareMailBase(fresh, { direction: 'result', accepted: true }),
  });
  invalidateShareCache(row.owner_id);
  invalidateShareCache(row.target_id);
  audit(actorId, 'share.respond', row.id, { accept: true, services: granted, expiresAt }, null);
  return toShare(fresh, actorId);
}

export function revokeShare(actorId, id) {
  const row = get('SELECT * FROM model_shares WHERE id = ?', String(id || ''));
  if (!row) throw notFound('分享记录不存在', 'share_not_found');
  const isParty = row.owner_id === actorId || row.target_id === actorId;
  if (!isParty) throw forbidden('无权撤销该分享', 'share_forbidden');
  const status = effectiveStatus(row);
  if (status !== 'pending' && status !== 'accepted') throw conflict('该分享已结束，无法撤销', 'share_not_revocable');

  run("UPDATE model_shares SET status = 'revoked', revoked_at = ? WHERE id = ?", nowIso(), row.id);
  const fresh = get('SELECT * FROM model_shares WHERE id = ?', row.id);
  const actor = userBrief(actorId);
  const otherId = row.owner_id === actorId ? row.target_id : row.owner_id;
  const services = parseServices(row.services);
  const lines = [`${userLabel(actor)} 撤销了模型分享：${serviceText(services)}`, '相关配置已停止使用。'];
  notify({
    userIds: [otherId, actorId],
    event: { type: 'share_result', share: toShare(fresh, otherId), accepted: false, revoked: true, at: nowIso() },
    subject: '【Cocoa】模型分享已撤销',
    lines,
    mailKind: 'share',
    mailPayload: shareMailBase(fresh, { direction: 'result', accepted: false }),
  });
  invalidateShareCache(row.owner_id);
  invalidateShareCache(row.target_id);
  audit(actorId, 'share.revoke', row.id, { services }, null);
  return toShare(fresh, actorId);
}

export function listShares(actorId, box = 'incoming') {
  let rows;
  switch (box) {
    case 'outgoing':
      rows = all("SELECT * FROM model_shares WHERE owner_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 200", actorId);
      break;
    case 'active':
      rows = all(
        "SELECT * FROM model_shares WHERE (owner_id = ? OR target_id = ?) AND status IN ('accepted','active') ORDER BY created_at DESC LIMIT 200",
        actorId,
        actorId,
      );
      break;
    case 'history':
      rows = all(
        "SELECT * FROM model_shares WHERE (owner_id = ? OR target_id = ?) AND status <> 'pending' ORDER BY created_at DESC LIMIT 200",
        actorId,
        actorId,
      );
      break;
    case 'incoming':
    default:
      rows = all("SELECT * FROM model_shares WHERE target_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 200", actorId);
      break;
  }
  return rows.map((row) => toShare(row, actorId));
}

/** 客户端启动弹窗：待我处理（并标记已查看） */
export function listPendingShares(actorId) {
  const rows = all(
    "SELECT * FROM model_shares WHERE target_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 50",
    actorId,
  );
  if (rows.length) {
    const ids = rows.map((r) => r.id);
    run(`UPDATE model_shares SET seen = 1 WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
  }
  return rows.map((row) => toShare({ ...row, seen: 1 }, actorId));
}

/** 供 OneBot 使用：待处理分享（不标记 seen） */
export function latestPendingShare(userId) {
  const row = get(
    "SELECT * FROM model_shares WHERE target_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
    userId,
  );
  return row ? toShare(row, userId) : null;
}

/** 把到期（accepted/active 且 expires_at <= now）的分享标记为 expired，并通知双方 */
export function expireDueShares(now = new Date()) {
  const iso = new Date(now).toISOString();
  const rows = all(
    "SELECT * FROM model_shares WHERE status IN ('accepted','active') AND expires_at IS NOT NULL AND expires_at <= ?",
    iso,
  );
  let count = 0;
  for (const row of rows) {
    run("UPDATE model_shares SET status = 'expired' WHERE id = ? AND status IN ('accepted','active')", row.id);
    const fresh = get('SELECT * FROM model_shares WHERE id = ?', row.id);
    if (!fresh || fresh.status !== 'expired') continue;
    count += 1;
    invalidateShareCache(row.owner_id);
    invalidateShareCache(row.target_id);
    const owner = userBrief(row.owner_id);
    const target = userBrief(row.target_id);
    const lines = [
      `你与 ${userLabel(owner)} / ${userLabel(target)} 的模型分享已到期。`,
      `服务：${serviceText(parseServices(row.services))}，已停止使用。`,
    ];
    notify({
      userIds: [row.owner_id, row.target_id],
      event: { type: 'share_expired', share: toShare(fresh, row.owner_id), at: iso },
      subject: '【Cocoa】模型分享已到期',
      lines,
      mailKind: 'expired',
      mailPayload: (uid) => {
        // 提供方 = 分享配置的人；接收方 = 使用配置的人（到期通知按收件人视角措辞）
        const provider = userBrief(row.direction === 'share' ? row.owner_id : row.target_id);
        const consumer = userBrief(row.direction === 'share' ? row.target_id : row.owner_id);
        const incoming = row.direction === 'share' ? uid === row.target_id : uid === row.owner_id;
        return {
          ownerName: provider.nickname || '',
          targetName: consumer.nickname || '',
          services: parseServices(row.services),
          expiresAt: row.expires_at ? fmtUtc8(row.expires_at) : '',
          direction: incoming ? 'share' : 'request',
        };
      },
    });
    logger.info('模型分享到期', row.id);
  }
  return count;
}

let watcher = null;
/** 到期巡检（60s，unref）；由 index.js 挂载，可重复调用 */
export function startShareExpiryWatcher() {
  if (watcher) return watcher;
  try {
    expireDueShares();
  } catch (err) {
    logger.warn('分享到期巡检首次执行失败', err?.message || err);
  }
  watcher = setInterval(() => {
    try {
      expireDueShares();
    } catch (err) {
      logger.warn('分享到期巡检失败', err?.message || err);
    }
  }, WATCH_INTERVAL_MS);
  watcher.unref?.();
  return watcher;
}

export function stopShareExpiryWatcher() {
  if (watcher) clearInterval(watcher);
  watcher = null;
}

export default {
  createShare,
  respondShare,
  revokeShare,
  listShares,
  listPendingShares,
  expireDueShares,
  startShareExpiryWatcher,
  stopShareExpiryWatcher,
};
