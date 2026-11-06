// v1.5.0 共享广场：本服广场 + 全球广场（仅全球主机对外提供 global 端点）
// 设计要点：
// - 资源 payload 一律服务端加密（encryptJson），接口只返回摘要/人设内容，绝不返回 apiKey
// - 模型使用权：使用后在本机 materialize 一条 model_shares 镜像行，AI 侧无需改动即可生效；
//   quota 累加在 plaza_grants.used_tokens，硬限额用尽 → 撤销镜像行 + 通知
// - 全球接口：X-Share-Id + HMAC-SHA256(timestamp\nmethod\npath\nbody)，±300s 防重放；
//   API key 跨服传输使用 COCOA_PLAZA_GLOBAL_TOKEN 派生密钥 AES-256-GCM 封装（sealedPayload）
// - 通知：资源被使用只发应用内 WS；额度/到期/封禁 → WS + 邮件
import crypto from 'node:crypto';
import { all, get, run, getMeta, setMeta } from '../db/index.js';
import { encryptJson, decryptJson, sha256, maskSecret } from '../core/crypto.js';
import { nowIso, uuid, asInt, parseJson, truncate } from '../core/util.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../core/errors.js';
import { PROFILE_FIELDS } from './characters.js';
import { getUserApiRaw, SHARE_SERVICES, invalidateShareCache } from './settings.js';
import { parseExpiresAt } from './shares.js';
import { broadcast } from '../realtime/hub.js';
import { audit } from './audit.js';
import logger from '../core/logger.js';

export const SHARE_ID_RE = /^[A-Za-z0-9]{8}$/;
export const KINDS = ['template', 'model'];
export const VISIBILITIES = ['server', 'global', 'users'];
export const BAN_SCOPES = ['all', 'server', 'global'];
export const GRANT_ACTIVE = ['active', 'soft_limited', 'expiring'];
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_PER_MINUTE = 60;
const SIGNATURE_WINDOW_MS = 300_000;
const UNKNOWN_PRICE_PER_MILLION = 0.6; // 元 / 百万 token（未知模型兜底）
const ROTATE_INTERVAL_MS = 86_400_000;

const round = (n, d = 6) => Math.round(Number(n || 0) * 10 ** d) / 10 ** d;

// ---------------- 基础工具 ----------------

export function fmtUtc8(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const t = new Date(d.getTime() + 8 * 3600_000).toISOString();
  return `${t.slice(0, 10)} ${t.slice(11, 19)}`;
}

export function parseShareIdList(input) {
  if (input === undefined || input === null) return [];
  const arr = Array.isArray(input) ? input : String(input).split(/[\s,，]+/);
  const out = [];
  for (const raw of arr) {
    const sid = String(raw || '').trim();
    if (!sid) continue;
    if (!SHARE_ID_RE.test(sid)) throw badRequest(`share ID 需为 8 位大小写字母或数字：${sid}`, 'share_id_invalid');
    if (!out.includes(sid)) out.push(sid);
  }
  if (out.length > 50) throw badRequest('单次最多指定 50 个 share ID', 'share_targets_too_many');
  return out;
}

function parseTargets(row) {
  return parseJson(row?.target_user_ids, []) || [];
}

export function shareIdOf(userId) {
  const row = get('SELECT share_id FROM users WHERE id = ?', String(userId || ''));
  return row?.share_id || '';
}

/** 确保用户有 share ID（迁移已回填；缺失时兜底生成） */
export function ensureShareId(userId) {
  const sid = shareIdOf(userId);
  if (sid) return sid;
  for (let attempt = 0; attempt < 5; attempt++) {
    const next = randomShareId();
    if (get('SELECT id FROM users WHERE share_id = ?', next)) continue;
    run('UPDATE users SET share_id = ? WHERE id = ?', next, userId);
    return next;
  }
  throw new AppError(500, 'share_id_generate_failed', 'share ID 生成失败，请稍后重试');
}

export function randomShareId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 8; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

export function userByShareId(shareId) {
  const sid = String(shareId || '').trim();
  if (!SHARE_ID_RE.test(sid)) return null;
  return get('SELECT id, code, username, share_id, status, email FROM users WHERE share_id = ?', sid) || null;
}

/** 广场动作的行为主体：本站用户用 user:<id>；外站用户用 share:<SID>（不落用户表） */
export function actorFromShareId(shareId) {
  const user = userByShareId(shareId);
  if (user) return { ref: user.id, userId: user.id, shareId: user.share_id, local: true, user };
  const sid = String(shareId || '').trim();
  if (!SHARE_ID_RE.test(sid)) throw new AppError(401, 'share_id_invalid', 'share ID 格式不正确');
  return { ref: `share:${sid}`, userId: null, shareId: sid, local: false, user: null };
}

export function isLocalActor(ref) {
  return Boolean(ref) && !String(ref).startsWith('share:');
}

export function shareIdOfActor(ref) {
  if (!ref) return '';
  if (!isLocalActor(ref)) return String(ref).slice(6);
  return shareIdOf(ref);
}

export function actorBrief(ref) {
  if (!ref) return { userId: null, shareId: '', code: null, nickname: '' };
  if (!isLocalActor(ref)) return { userId: null, shareId: String(ref).slice(6), code: null, nickname: '' };
  const u = get('SELECT id, code, username, share_id FROM users WHERE id = ?', String(ref));
  return {
    userId: u?.id || null,
    shareId: u?.share_id || '',
    code: u?.code ?? null,
    nickname: u?.username || '',
  };
}

// ---------------- share ID 轮换 ----------------

export function rotateShareId(userId) {
  const key = `plaza_rotate:${userId}`;
  const last = getMeta(key, null);
  if (last && Date.now() - new Date(last).getTime() < ROTATE_INTERVAL_MS) {
    const nextAt = new Date(new Date(last).getTime() + ROTATE_INTERVAL_MS).toISOString();
    throw new AppError(429, 'share_id_rotate_cooldown', '分享 ID 每天只能更换一次', { nextAllowedAt: nextAt });
  }
  let sid = '';
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = randomShareId();
    if (get('SELECT id FROM users WHERE share_id = ? AND id <> ?', candidate, userId)) continue;
    sid = candidate;
    break;
  }
  if (!sid) throw new AppError(500, 'share_id_generate_failed', 'share ID 生成失败，请稍后重试');
  run('UPDATE users SET share_id = ? WHERE id = ?', sid, userId);
  setMeta(key, nowIso());
  audit(userId, 'plaza.share_id.rotate', userId, { shareId: sid }, null);
  return { shareId: sid, nextRotateAt: new Date(Date.now() + ROTATE_INTERVAL_MS).toISOString() };
}

// ---------------- 封禁 ----------------

export function activeBan(userId, scope = null, now = Date.now()) {
  const rows = all('SELECT * FROM plaza_bans WHERE user_id = ? ORDER BY created_at DESC', String(userId || ''));
  return (
    rows.find((row) => {
      if (scope && row.scope !== 'all' && row.scope !== scope) return false;
      if (!row.until) return true;
      const until = new Date(row.until).getTime();
      return Number.isFinite(until) && until > now;
    }) || null
  );
}

export function assertNotBanned(userId, scope = 'server') {
  const ban = activeBan(userId, scope);
  if (ban) {
    throw new AppError(403, 'plaza_banned', '你的分享权限已被管理员禁用', {
      scope: ban.scope,
      reason: ban.reason || '',
      until: ban.until || null,
    });
  }
}

export function toBan(row) {
  const user = actorBrief(row.user_id);
  return {
    id: row.id,
    user: user,
    scope: row.scope,
    reason: row.reason || '',
    until: row.until || null,
    permanent: !row.until,
    createdAt: row.created_at,
    createdBy: row.created_by || null,
  };
}

export function listBans({ activeOnly = false } = {}) {
  const rows = all('SELECT * FROM plaza_bans ORDER BY created_at DESC LIMIT 500');
  const now = Date.now();
  return rows
    .filter((row) => !activeOnly || !row.until || new Date(row.until).getTime() > now)
    .map(toBan);
}

export function createBan(adminId, input = {}, { allowRemote = false } = {}) {
  const scope = BAN_SCOPES.includes(String(input.scope)) ? String(input.scope) : 'all';
  const user = input.userId
    ? get('SELECT * FROM users WHERE id = ?', String(input.userId))
    : userByShareId(String(input.shareId || ''));
  // 全球主机可按 share ID 禁用跨服用户（plaza_bans.user_id 允许 share:<SID>）
  const remoteSid = String(input.shareId || '').trim();
  const remoteRef = !user && allowRemote && scope === 'global' && SHARE_ID_RE.test(remoteSid) ? `share:${remoteSid}` : null;
  if (!user && !remoteRef) throw notFound('本服不存在该用户（只能禁用本服用户；跨服用户需 scope=global）', 'ban_user_not_found');
  const subjectRef = user ? user.id : remoteRef;
  let until = null;
  if (input.until) until = parseExpiresAt(input.until).toISOString();
  if (input.permanent === true) until = null;
  const reason = truncate(String(input.reason || '').trim(), 200);
  const id = `pb_${uuid().replace(/-/g, '').slice(0, 16)}`;
  run(
    'INSERT INTO plaza_bans(id, user_id, scope, reason, until, created_by, created_at) VALUES(?,?,?,?,?,?,?)',
    id,
    subjectRef,
    scope,
    reason || null,
    until,
    adminId,
    nowIso(),
  );
  const row = get('SELECT * FROM plaza_bans WHERE id = ?', id);
  audit(adminId, 'plaza.ban.create', subjectRef, { scope, until, reason, remote: Boolean(remoteRef) }, null);
  const brief = actorBrief(subjectRef);
  if (!remoteRef) {
    notifyUser(subjectRef, {
      type: 'plaza_banned',
      ban: toBan(row),
      message: '你的分享权限已被管理员禁用',
    });
  }
  void sendMail(remoteRef || subjectRef, 'ban', {
    name: brief.nickname,
    shareId: brief.shareId,
    reason: reason || '未填写',
    until: until ? fmtUtc8(until) : '永久',
    scope,
  });
  return toBan(row);
}

export function deleteBan(adminId, id) {
  const row = get('SELECT * FROM plaza_bans WHERE id = ?', String(id || ''));
  if (!row) throw notFound('禁用记录不存在', 'ban_not_found');
  run('DELETE FROM plaza_bans WHERE id = ?', row.id);
  audit(adminId, 'plaza.ban.delete', row.user_id, { scope: row.scope }, null);
  return { ok: true, id: row.id };
}

// ---------------- 通知 ----------------

function notifyUser(ref, event) {
  if (!ref || !isLocalActor(ref)) return 0;
  try {
    return broadcast(String(ref), event);
  } catch (err) {
    logger.warn('广场通知 WS 推送失败', err?.message || err);
    return 0;
  }
}

async function sendMail(ref, kind, payload) {
  if (!ref || !isLocalActor(ref)) return { ok: false, reason: 'remote_actor' };
  const user = get('SELECT id, email, username FROM users WHERE id = ?', String(ref));
  if (!user?.email) return { ok: false, reason: 'no_email' };
  try {
    const sender = await import('../mail/sender.js');
    const fnMap = { quota: 'sendQuotaNotice', ban: 'sendBanNotice', expiry: 'sendExpiryNotice' };
    const fnName = fnMap[kind];
    const fn = fnName ? sender[fnName] : null;
    if (typeof fn !== 'function') return { ok: false, reason: 'template_missing' };
    return await fn(user.email, { ...payload, name: payload.name || user.username || '' });
  } catch (err) {
    logger.warn('广场邮件发送失败', kind, err?.message || err);
    return { ok: false, reason: err?.message || 'mail_failed' };
  }
}

// ---------------- 资源：校验与序列化 ----------------

function windowState(row, now = Date.now()) {
  if (row.status && row.status !== 'active') return row.status;
  if (!row.permanent) {
    const start = row.starts_at ? new Date(row.starts_at).getTime() : null;
    const end = row.expires_at ? new Date(row.expires_at).getTime() : null;
    if (start && Number.isFinite(start) && now < start) return 'pending';
    if (end && Number.isFinite(end) && now >= end) return 'expired';
  }
  return 'active';
}

function canView(row, viewerRef, viewerShareId) {
  if (!row) return false;
  if (row.status === 'deleted') return false;
  if (row.owner_id === viewerRef) return true;
  if (row.visibility === 'server' || row.visibility === 'global') return true;
  if (row.visibility === 'users') return parseTargets(row).includes(viewerShareId);
  return false;
}

function payloadOf(row) {
  return decryptJson(row.owner_id, row.payload, null) || {};
}

/** 摘要：绝不包含密钥；模板内容作为公开人设展示 */
export function toResource(row, viewerRef = null, { detail = false } = {}) {
  const payload = payloadOf(row);
  const owner = actorBrief(row.owner_id);
  const viewerShareId = shareIdOfActor(viewerRef);
  const state = windowState(row);
  const like = viewerRef ? get('SELECT 1 AS x FROM plaza_likes WHERE resource_id = ? AND user_id = ?', row.id, String(viewerRef)) : null;
  const grant = viewerRef ? get('SELECT * FROM plaza_grants WHERE resource_id = ? AND user_id = ?', row.id, String(viewerRef)) : null;
  const out = {
    id: row.id,
    kind: row.kind,
    title: row.title,
    description: row.description || '',
    visibility: row.visibility,
    targetShareIds: row.visibility === 'users' ? parseTargets(row) : [],
    owner,
    tokenSoft: row.token_soft || 0,
    tokenHard: row.token_hard || 0,
    permanent: Boolean(row.permanent),
    startsAt: row.starts_at || null,
    expiresAt: row.expires_at || null,
    status: state,
    likeCount: row.like_count || 0,
    useCount: row.use_count || 0,
    liked: Boolean(like),
    mine: row.owner_id === viewerRef,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    visible: canView(row, viewerRef, viewerShareId),
    services: row.kind === 'model' ? (payload.services || []) : [],
    preview:
      row.kind === 'template'
        ? {
            name: String(payload.profile?.name || ''),
            personality: truncate(payload.profile?.personality || '', 80),
            race: payload.profile?.race || '',
            gender: payload.profile?.gender || '',
          }
        : { services: payload.services || [], models: payload.models || {} },
    grant: grant
      ? {
          id: grant.id,
          status: grant.status,
          usedTokens: grant.used_tokens || 0,
          expiresAt: grant.expires_at || null,
        }
      : null,
  };
  if (row.kind === 'template' && (detail || canView(row, viewerRef, viewerShareId))) {
    out.profile = payload.profile || null;
  }
  if (detail && row.kind === 'model') {
    out.models = payload.models || {};
    out.providerRef = providerRefOf(row, payload);
  }
  return out;
}

function providerRefOf(row, payload) {
  const services = payload.services || [];
  return {
    providerId: `plaza:${row.id}`,
    providerName: actorBrief(row.owner_id).nickname || '广场分享',
    services: services.map((svc) => ({
      service: svc,
      model: String(payload.config?.[svc]?.model || payload.models?.[svc] || ''),
    })),
  };
}

export function parseTimeInput(value, label = 'expiresAt') {
  if (value === undefined || value === null || value === '') return null;
  return parseExpiresAt(value).toISOString();
}

function parseTokenLimit(value, label) {
  const n = asInt(value, 0);
  if (n < 0) throw badRequest(`${label} 不能为负数`, 'token_limit_invalid');
  return Math.min(n, 1_000_000_000);
}

function sanitizeProfile(input) {
  const profile = {};
  for (const field of PROFILE_FIELDS) profile[field] = String(input?.[field] ?? '').slice(0, 4000);
  if (!profile.name) throw badRequest('人设模板缺少角色姓名', 'template_profile_name_required');
  return profile;
}

function pickModelPayload(ownerRef, input) {
  // 允许本服用户直接从自己的配置生成；跨服调用必须给 sealedPayload（见 globalPublish）
  if (!isLocalActor(ownerRef)) throw badRequest('跨服发布模型需要提供加密配置', 'plaza_sealed_payload_required');
  const requested = Array.isArray(input?.services) && input.services.length ? input.services : SHARE_SERVICES;
  const raw = getUserApiRaw(ownerRef) || {};
  const config = {};
  const models = {};
  for (const svc of requested) {
    const conf = raw[svc];
    if (!conf || !conf.apiKey) continue;
    config[svc] = {
      baseUrl: String(conf.baseUrl || ''),
      apiKey: String(conf.apiKey),
      model: String(conf.model || ''),
      voice: String(conf.voice || ''),
      extra: conf.extra && typeof conf.extra === 'object' ? conf.extra : {},
    };
    models[svc] = String(conf.model || '');
  }
  const services = Object.keys(config);
  if (!services.length) throw badRequest('你没有可公开的模型配置，请先在设置中填写 API Key', 'plaza_no_model_config');
  return { services, config, models };
}

/**
 * 发布资源。
 * @param {string} ownerRef 本服用户 id 或 share:<SID>
 * @param {object} input {kind,title,description,visibility,targetShareIds,tokenSoft,tokenHard,permanent,startsAt,expiresAt,profile,services}
 */
export function createResource(ownerRef, input = {}, extraPayload = null) {
  const kind = KINDS.includes(String(input.kind)) ? String(input.kind) : null;
  if (!kind) throw badRequest('kind 仅支持 template / model', 'plaza_kind_invalid');
  const title = truncate(String(input.title || '').trim(), 80);
  if (!title) throw badRequest('请填写标题', 'plaza_title_required');
  const description = truncate(String(input.description || '').trim(), 500);
  const visibility = VISIBILITIES.includes(String(input.visibility)) ? String(input.visibility) : 'server';
  const targetShareIds = parseShareIdList(input.targetShareIds ?? input.targetUserIds);
  if (visibility === 'users' && !targetShareIds.length) {
    throw badRequest('定向分享需要提供 targetShareIds', 'plaza_target_required');
  }
  if (visibility === 'users' && ownerRef && targetShareIds.includes(shareIdOfActor(ownerRef))) {
    throw badRequest('不能把资源定向分享给自己', 'plaza_target_self');
  }
  if (visibility === 'global' && !globalConfig().hostEnabled) {
    throw badRequest('本服不是全球广场主机，无法发布全球资源', 'plaza_global_unavailable');
  }
  if (isLocalActor(ownerRef)) assertNotBanned(ownerRef, visibility === 'global' ? 'global' : 'server');

  const permanent = Boolean(input.permanent);
  let startsAt = null;
  let expiresAt = null;
  if (!permanent) {
    startsAt = parseTimeInput(input.startsAt, 'startsAt');
    expiresAt = parseTimeInput(input.expiresAt, 'expiresAt');
    if (!startsAt && !expiresAt) throw badRequest('请设置展示时间或选择永久', 'plaza_time_required');
    if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) throw badRequest('结束时间必须晚于当前时间', 'plaza_expires_past');
    if (startsAt && expiresAt && new Date(startsAt).getTime() >= new Date(expiresAt).getTime()) {
      throw badRequest('开始时间必须早于结束时间', 'plaza_time_range_invalid');
    }
  }
  const tokenSoft = parseTokenLimit(input.tokenSoft, 'tokenSoft');
  const tokenHard = parseTokenLimit(input.tokenHard, 'tokenHard');
  if (tokenSoft && tokenHard && tokenHard < tokenSoft) throw badRequest('硬限额不能小于软限额', 'plaza_token_limit_order');

  let payload;
  if (kind === 'template') {
    payload = { profile: sanitizeProfile(input.profile) };
  } else {
    payload = pickModelPayload(ownerRef, input);
  }
  if (extraPayload && typeof extraPayload === 'object') payload = { ...payload, ...extraPayload };

  const id = `pl_${uuid().replace(/-/g, '').slice(0, 18)}`;
  const now = nowIso();
  run(
    `INSERT INTO plaza_resources(id, owner_id, kind, title, description, payload, visibility, target_user_ids,
       token_soft, token_hard, permanent, starts_at, expires_at, status, like_count, use_count, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?, 'active', 0, 0, ?, ?)`,
    id,
    String(ownerRef),
    kind,
    title,
    description || null,
    encryptJson(String(ownerRef), payload),
    visibility,
    visibility === 'users' ? JSON.stringify(targetShareIds) : null,
    tokenSoft,
    tokenHard,
    permanent ? 1 : 0,
    startsAt,
    expiresAt,
    now,
    now,
  );
  const row = get('SELECT * FROM plaza_resources WHERE id = ?', id);
  if (isLocalActor(ownerRef)) audit(ownerRef, 'plaza.resource.create', id, { kind, visibility, title }, null);
  return toResource(row, ownerRef, { detail: true });
}

export function updateResource(ownerRef, id, input = {}) {
  const row = get('SELECT * FROM plaza_resources WHERE id = ?', String(id || ''));
  if (!row) throw notFound('资源不存在', 'plaza_resource_not_found');
  if (row.owner_id !== String(ownerRef)) throw forbidden('只能修改自己发布的内容', 'plaza_not_owner');
  const sets = [];
  const params = [];
  if (input.title !== undefined) {
    const title = truncate(String(input.title || '').trim(), 80);
    if (!title) throw badRequest('标题不能为空', 'plaza_title_required');
    sets.push('title = ?');
    params.push(title);
  }
  if (input.description !== undefined) {
    sets.push('description = ?');
    params.push(truncate(String(input.description || '').trim(), 500) || null);
  }
  if (input.status !== undefined) {
    const status = String(input.status);
    if (!['active', 'hidden'].includes(status)) throw badRequest('status 仅支持 active / hidden', 'plaza_status_invalid');
    sets.push('status = ?');
    params.push(status);
  }
  if (input.tokenSoft !== undefined) {
    sets.push('token_soft = ?');
    params.push(parseTokenLimit(input.tokenSoft, 'tokenSoft'));
  }
  if (input.tokenHard !== undefined) {
    sets.push('token_hard = ?');
    params.push(parseTokenLimit(input.tokenHard, 'tokenHard'));
  }
  if (input.visibility !== undefined) {
    const visibility = String(input.visibility);
    if (!VISIBILITIES.includes(visibility)) throw badRequest('visibility 不合法', 'plaza_visibility_invalid');
    const targets = parseShareIdList(input.targetShareIds ?? parseTargets(row));
    if (visibility === 'users' && !targets.length) throw badRequest('定向分享需要 targetShareIds', 'plaza_target_required');
    sets.push('visibility = ?', 'target_user_ids = ?');
    params.push(visibility, visibility === 'users' ? JSON.stringify(targets) : null);
  }
  if (!sets.length) throw badRequest('没有可修改的字段', 'empty_patch');
  sets.push('updated_at = ?');
  params.push(nowIso(), row.id);
  run(`UPDATE plaza_resources SET ${sets.join(', ')} WHERE id = ?`, ...params);
  audit(ownerRef, 'plaza.resource.update', row.id, { fields: Object.keys(input) }, null);
  return toResource(get('SELECT * FROM plaza_resources WHERE id = ?', row.id), ownerRef, { detail: true });
}

export function deleteResource(ownerRef, id) {
  const row = get('SELECT * FROM plaza_resources WHERE id = ?', String(id || ''));
  if (!row) throw notFound('资源不存在', 'plaza_resource_not_found');
  if (row.owner_id !== String(ownerRef)) throw forbidden('只能删除自己发布的内容', 'plaza_not_owner');
  run("UPDATE plaza_resources SET status = 'deleted', updated_at = ? WHERE id = ?", nowIso(), row.id);
  const grants = all('SELECT * FROM plaza_grants WHERE resource_id = ? AND status IN (?,?,?)', row.id, ...GRANT_ACTIVE);
  for (const grant of grants) {
    run("UPDATE plaza_grants SET status = 'revoked', updated_at = ? WHERE id = ?", nowIso(), grant.id);
    revokeGrantMirror(grant);
  }
  audit(ownerRef, 'plaza.resource.delete', row.id, null, null);
  return { ok: true, id: row.id };
}

// ---------------- 列表 / 搜索 ----------------

const SORTS = {
  latest: (a, b) => String(b.created_at).localeCompare(String(a.created_at)),
  popular: (a, b) => (b.use_count || 0) - (a.use_count || 0) || (b.like_count || 0) - (a.like_count || 0),
  likes: (a, b) => (b.like_count || 0) - (a.like_count || 0) || String(b.created_at).localeCompare(String(a.created_at)),
};

export function listResources(viewerRef, query = {}) {
  const scope = query.scope === 'global' ? 'global' : 'server';
  const kind = KINDS.includes(String(query.kind)) ? String(query.kind) : null;
  const sort = SORTS[String(query.sort)] ? String(query.sort) : 'latest';
  const page = Math.max(1, asInt(query.page, 1));
  const pageSize = Math.min(50, Math.max(1, asInt(query.pageSize ?? query.size, 20)));
  const viewerShareId = shareIdOfActor(viewerRef);
  const q = String(query.q || '').trim().toLowerCase();
  const ownerSid = String(query.shareId || '').trim();

  let rows = all('SELECT * FROM plaza_resources ORDER BY created_at DESC LIMIT 500');
  rows = rows.filter((row) => {
    if (scope === 'global') {
      if (row.visibility === 'global') return true;
      return row.visibility === 'users' && parseTargets(row).includes(viewerShareId);
    }
    // 本服广场：本服内可见的全部（server / global / 定向给我 / 我自己的全部）
    if (row.owner_id === viewerRef) return true;
    if (row.visibility === 'server' || row.visibility === 'global') return true;
    if (row.visibility === 'users') return parseTargets(row).includes(viewerShareId);
    return false;
  });
  if (kind) rows = rows.filter((row) => row.kind === kind);
  if (ownerSid) rows = rows.filter((row) => actorBrief(row.owner_id).shareId === ownerSid);
  if (q) {
    rows = rows.filter((row) => {
      const owner = actorBrief(row.owner_id);
      const hay = [row.title, row.description, owner.nickname, owner.shareId, String(owner.code ?? '')]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }
  rows.sort(SORTS[sort]);
  const total = rows.length;
  const items = rows.slice((page - 1) * pageSize, page * pageSize).map((row) => toResource(row, viewerRef));
  return { items, total, page, pageSize, scope, kind, sort, q: q || null, shareId: ownerSid || null };
}

export function getResource(viewerRef, id) {
  const row = get('SELECT * FROM plaza_resources WHERE id = ?', String(id || ''));
  if (!row || row.status === 'deleted') throw notFound('资源不存在', 'plaza_resource_not_found');
  if (!canView(row, viewerRef, shareIdOfActor(viewerRef))) throw forbidden('无权查看该资源', 'plaza_forbidden');
  return toResource(row, viewerRef, { detail: true });
}

export function likeResource(viewerRef, id) {
  const row = get('SELECT * FROM plaza_resources WHERE id = ?', String(id || ''));
  if (!row || row.status !== 'active') throw notFound('资源不存在', 'plaza_resource_not_found');
  if (!canView(row, viewerRef, shareIdOfActor(viewerRef))) throw forbidden('无权点赞该资源', 'plaza_forbidden');
  const existing = get('SELECT 1 AS x FROM plaza_likes WHERE resource_id = ? AND user_id = ?', row.id, String(viewerRef));
  if (existing) {
    run('DELETE FROM plaza_likes WHERE resource_id = ? AND user_id = ?', row.id, String(viewerRef));
    run('UPDATE plaza_resources SET like_count = MAX(0, like_count - 1) WHERE id = ?', row.id);
  } else {
    run('INSERT INTO plaza_likes(resource_id, user_id, created_at) VALUES(?,?,?)', row.id, String(viewerRef), nowIso());
    run('UPDATE plaza_resources SET like_count = like_count + 1 WHERE id = ?', row.id);
  }
  const fresh = get('SELECT * FROM plaza_resources WHERE id = ?', row.id);
  return { ok: true, liked: !existing, likeCount: fresh.like_count || 0, resource: toResource(fresh, viewerRef) };
}

// ---------------- 使用与额度 ----------------

function grantMirrorId(grantId) {
  return `ps_${String(grantId).replace(/^pg_/, '')}`;
}

/** 把模型使用权落到本机 model_shares（payload 以使用方密钥加密），使 AI 调用链路自动生效 */
export function materializeModelGrant(consumerUserId, { resourceId, grantId, config, services, expiresAt, permanent = false }) {
  const id = grantMirrorId(grantId);
  const payload = encryptJson(consumerUserId, config);
  const existing = get('SELECT id FROM model_shares WHERE id = ?', id);
  if (existing) {
    run(
      "UPDATE model_shares SET payload = ?, services = ?, status = 'accepted', permanent = ?, expires_at = ? WHERE id = ?",
      payload,
      JSON.stringify(services),
      permanent ? 1 : 0,
      expiresAt || null,
      id,
    );
  } else {
    const now = nowIso();
    run(
      `INSERT INTO model_shares(id, owner_id, target_id, direction, services, payload, status, permanent, duration, expires_at, note, seen, created_at, responded_at)
       VALUES(?,?,?,'share',?,?,'accepted',?,NULL,?,?,1,?,?)`,
      id,
      String(consumerUserId),
      String(consumerUserId),
      JSON.stringify(services),
      payload,
      permanent ? 1 : 0,
      expiresAt || null,
      `plaza:${resourceId}`,
      now,
      now,
    );
  }
  invalidateShareCache(consumerUserId);
  return id;
}

export function revokeGrantMirror(grant) {
  if (!grant || !isLocalActor(grant.user_id)) return;
  run(
    "UPDATE model_shares SET status = 'revoked', revoked_at = ? WHERE id = ? AND status IN ('accepted','active')",
    nowIso(),
    grantMirrorId(grant.id),
  );
  invalidateShareCache(grant.user_id);
}

function ensureGrant(row, consumerRef) {
  let grant = get('SELECT * FROM plaza_grants WHERE resource_id = ? AND user_id = ?', row.id, String(consumerRef));
  if (grant) {
    if (grant.status === 'exhausted') throw new AppError(403, 'plaza_quota_exhausted', '该资源的使用额度已用尽');
    if (['revoked', 'expired'].includes(grant.status)) {
      throw new AppError(403, 'plaza_grant_inactive', '授权已失效，请重新使用该资源');
    }
    if (grant.expires_at && new Date(grant.expires_at).getTime() <= Date.now()) {
      run("UPDATE plaza_grants SET status = 'expired', updated_at = ? WHERE id = ?", nowIso(), grant.id);
      revokeGrantMirror(grant);
      throw new AppError(403, 'plaza_grant_expired', '授权已到期');
    }
    return grant;
  }
  const id = `pg_${uuid().replace(/-/g, '').slice(0, 16)}`;
  const now = nowIso();
  const expiresAt = row.permanent ? null : row.expires_at || null;
  run(
    'INSERT INTO plaza_grants(id, resource_id, user_id, status, used_tokens, created_at, updated_at, expires_at) VALUES(?,?,?,?,0,?,?,?)',
    id,
    row.id,
    String(consumerRef),
    'active',
    now,
    now,
    expiresAt,
  );
  run('UPDATE plaza_resources SET use_count = use_count + 1 WHERE id = ?', row.id);
  grant = get('SELECT * FROM plaza_grants WHERE id = ?', id);
  return grant;
}

function quotaReached(row, grant) {
  const hard = Number(row.token_hard || 0);
  return hard > 0 && Number(grant.used_tokens || 0) >= hard;
}

/**
 * 使用资源：模板返回人设内容；模型返回 provider 引用（本机已 materialize，客户端拿不到 key）
 */
export function useResource(consumerRef, id) {
  const row = get('SELECT * FROM plaza_resources WHERE id = ?', String(id || ''));
  if (!row || row.status === 'deleted') throw notFound('资源不存在', 'plaza_resource_not_found');
  if (row.owner_id === String(consumerRef)) throw badRequest('不能使用自己发布的资源', 'plaza_self_use');
  const consumerShareId = shareIdOfActor(consumerRef);
  if (!canView(row, consumerRef, consumerShareId)) throw forbidden('无权使用该资源', 'plaza_forbidden');
  if (windowState(row) !== 'active') throw conflict('资源当前不可用（未开始或已结束）', 'plaza_resource_inactive');
  if (isLocalActor(consumerRef)) assertNotBanned(consumerRef, row.visibility === 'global' ? 'global' : 'server');

  const grant = ensureGrant(row, consumerRef);
  if (quotaReached(row, grant)) throw new AppError(403, 'plaza_quota_exhausted', '该资源的使用额度已用尽');

  const payload = payloadOf(row);
  const owner = actorBrief(row.owner_id);
  let result;
  if (row.kind === 'template') {
    result = { ok: true, kind: 'template', resourceId: row.id, profile: payload.profile || {} };
  } else {
    const config = payload.config || {};
    const services = payload.services || [];
    if (!services.length) throw new AppError(502, 'plaza_model_payload_missing', '该资源的模型配置缺失，请联系发布者重新发布');
    if (isLocalActor(consumerRef)) {
      materializeModelGrant(consumerRef, {
        resourceId: row.id,
        grantId: grant.id,
        config,
        services: Object.keys(config),
        expiresAt: grant.expires_at,
        permanent: Boolean(row.permanent),
      });
    }
    result = {
      ok: true,
      kind: 'model',
      resourceId: row.id,
      providerRef: providerRefOf(row, payload),
      services: Object.keys(config),
    };
  }
  notifyUser(row.owner_id, {
    type: 'plaza_used',
    resourceId: row.id,
    title: row.title,
    kind: row.kind,
    by: { shareId: consumerShareId, code: actorBrief(consumerRef).code, nickname: actorBrief(consumerRef).nickname },
    at: nowIso(),
  });
  if (isLocalActor(consumerRef)) audit(consumerRef, 'plaza.use', row.id, { kind: row.kind }, null);
  const fresh = get('SELECT * FROM plaza_resources WHERE id = ?', row.id);
  return {
    ...result,
    resource: toResource(fresh, consumerRef),
    grant: {
      id: grant.id,
      status: grant.status,
      usedTokens: grant.used_tokens || 0,
      tokenSoft: row.token_soft || 0,
      tokenHard: row.token_hard || 0,
      expiresAt: grant.expires_at || null,
      ownerShareId: owner.shareId,
    },
  };
}

export function grantFor(userId, id) {
  const grant = get('SELECT * FROM plaza_grants WHERE id = ?', String(id || ''));
  if (!grant) throw notFound('授权不存在', 'plaza_grant_not_found');
  if (grant.user_id !== String(userId)) throw forbidden('无权查看该授权', 'plaza_forbidden');
  const row = get('SELECT * FROM plaza_resources WHERE id = ?', grant.resource_id);
  return {
    id: grant.id,
    status: grant.status,
    usedTokens: grant.used_tokens || 0,
    createdAt: grant.created_at,
    updatedAt: grant.updated_at,
    expiresAt: grant.expires_at || null,
    resource: row ? toResource(row, userId) : null,
  };
}

/**
 * 用量回写：把一次 model 调用的 token 计入该用户的广场授权额度。
 * 由 ai/usage.js 的 recordUsage 调用（同步、失败静默）。
 */
export function consumeGrantTokens(userId, { model = '', tokens = 0 } = {}) {
  const amount = Math.max(0, Math.round(Number(tokens) || 0));
  if (!amount || !isLocalActor(userId)) return null;
  const rows = all(
    `SELECT g.*, r.kind AS r_kind, r.title AS r_title, r.token_soft AS r_soft, r.token_hard AS r_hard,
            r.payload AS r_payload, r.owner_id AS r_owner, r.permanent AS r_permanent, r.expires_at AS r_expires
       FROM plaza_grants g JOIN plaza_resources r ON r.id = g.resource_id
      WHERE g.user_id = ? AND g.status IN (?,?,?) AND r.kind = 'model'
      ORDER BY g.created_at ASC`,
    String(userId),
    ...GRANT_ACTIVE,
  );
  if (!rows.length) return null;

  let chosen = null;
  for (const row of rows) {
    const payload = decryptJson(row.r_owner, row.r_payload, null) || {};
    const cfg = payload.config || {};
    if (model && Object.values(cfg).some((conf) => String(conf?.model || '') === String(model))) {
      chosen = row;
      break;
    }
  }
  if (!chosen) chosen = rows[0];

  const nextUsed = Number(chosen.used_tokens || 0) + amount;
  run('UPDATE plaza_grants SET used_tokens = ?, updated_at = ? WHERE id = ?', nextUsed, nowIso(), chosen.id);
  const soft = Number(chosen.r_soft || 0);
  const hard = Number(chosen.r_hard || 0);
  let status = chosen.status;

  if (hard > 0 && nextUsed >= hard) {
    status = 'exhausted';
    run("UPDATE plaza_grants SET status = 'exhausted', updated_at = ? WHERE id = ?", nowIso(), chosen.id);
    revokeGrantMirror({ ...chosen, user_id: userId });
    notifyUser(userId, { type: 'plaza_quota', level: 'hard', resourceId: chosen.resource_id, title: chosen.r_title, usedTokens: nextUsed, tokenHard: hard, at: nowIso() });
    void sendMail(userId, 'quota', {
      shareId: shareIdOf(userId),
      level: 'hard',
      resourceTitle: chosen.r_title,
      usedTokens: nextUsed,
      tokenHard: hard,
      tokenSoft: soft,
      expiresAt: fmtUtc8(chosen.expires_at),
    });
  } else if (soft > 0 && nextUsed >= soft && chosen.status === 'active') {
    status = 'soft_limited';
    run("UPDATE plaza_grants SET status = 'soft_limited', updated_at = ? WHERE id = ?", nowIso(), chosen.id);
    notifyUser(userId, { type: 'plaza_quota', level: 'soft', resourceId: chosen.resource_id, title: chosen.r_title, usedTokens: nextUsed, tokenSoft: soft, at: nowIso() });
    void sendMail(userId, 'quota', {
      shareId: shareIdOf(userId),
      level: 'soft',
      resourceTitle: chosen.r_title,
      usedTokens: nextUsed,
      tokenHard: hard,
      tokenSoft: soft,
    });
  }
  return { grantId: chosen.id, status, usedTokens: nextUsed, tokenSoft: soft, tokenHard: hard };
}

// ---------------- 我的 ----------------

export function myPlaza(userRef, box = 'published') {
  if (box === 'published') {
    const rows = all('SELECT * FROM plaza_resources WHERE owner_id = ? AND status <> ? ORDER BY created_at DESC LIMIT 200', String(userRef), 'deleted');
    return { box, items: rows.map((row) => toResource(row, userRef, { detail: true })), total: rows.length };
  }
  if (box === 'grants') {
    const rows = all('SELECT * FROM plaza_grants WHERE user_id = ? ORDER BY created_at DESC LIMIT 200', String(userRef));
    const items = rows.map((grant) => {
      const row = get('SELECT * FROM plaza_resources WHERE id = ?', grant.resource_id);
      return {
        grant: {
          id: grant.id,
          status: grant.status,
          usedTokens: grant.used_tokens || 0,
          createdAt: grant.created_at,
          expiresAt: grant.expires_at || null,
        },
        resource: row ? toResource(row, userRef) : null,
      };
    });
    return { box, items, total: items.length };
  }
  if (box === 'liked') {
    const rows = all(
      'SELECT r.* FROM plaza_likes l JOIN plaza_resources r ON r.id = l.resource_id WHERE l.user_id = ? AND r.status <> ? ORDER BY l.created_at DESC LIMIT 200',
      String(userRef),
      'deleted',
    );
    return { box, items: rows.map((row) => toResource(row, userRef)), total: rows.length };
  }
  throw badRequest('box 仅支持 published / grants / liked', 'plaza_box_invalid');
}

// ---------------- 到期 / 限额巡检 ----------------

export function expireDuePlaza(now = new Date()) {
  const iso = new Date(now).toISOString();
  const soonIso = new Date(new Date(now).getTime() + 86_400_000).toISOString();
  const stats = { resources: 0, grants: 0, reminders: 0 };

  const expiredResources = all(
    "SELECT * FROM plaza_resources WHERE status = 'active' AND permanent = 0 AND expires_at IS NOT NULL AND expires_at <= ?",
    iso,
  );
  for (const row of expiredResources) {
    run("UPDATE plaza_resources SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'active'", iso, row.id);
    stats.resources += 1;
  }

  const dueGrants = all(
    `SELECT g.*, r.title AS r_title, r.payload AS r_payload, r.owner_id AS r_owner, r.permanent AS r_permanent,
            r.expires_at AS r_expires
       FROM plaza_grants g JOIN plaza_resources r ON r.id = g.resource_id
      WHERE g.status IN (?,?,?) AND g.expires_at IS NOT NULL AND g.expires_at <= ?`,
    ...GRANT_ACTIVE,
    iso,
  );
  for (const grant of dueGrants) {
    run("UPDATE plaza_grants SET status = 'expired', updated_at = ? WHERE id = ?", iso, grant.id);
    revokeGrantMirror(grant);
    stats.grants += 1;
    const payload = decryptJson(grant.r_owner, grant.r_payload, null) || {};
    notifyUser(grant.user_id, {
      type: 'plaza_expired',
      resourceId: grant.resource_id,
      title: grant.r_title,
      expiresAt: grant.expires_at,
      at: iso,
    });
    void sendMail(grant.user_id, 'expiry', {
      shareId: shareIdOf(grant.user_id),
      ownerName: actorBrief(grant.r_owner).nickname,
      targetName: actorBrief(grant.user_id).nickname,
      services: payload.services || [],
      expiresAt: fmtUtc8(grant.expires_at),
      actionUrl: '',
    });
  }

  const upcoming = all(
    `SELECT g.*, r.title AS r_title
       FROM plaza_grants g JOIN plaza_resources r ON r.id = g.resource_id
      WHERE g.status = 'active' AND g.expires_at IS NOT NULL AND g.expires_at > ? AND g.expires_at <= ?`,
    iso,
    soonIso,
  );
  for (const grant of upcoming) {
    run("UPDATE plaza_grants SET status = 'expiring', updated_at = ? WHERE id = ?", iso, grant.id);
    stats.reminders += 1;
    notifyUser(grant.user_id, {
      type: 'plaza_expiring',
      resourceId: grant.resource_id,
      title: grant.r_title,
      expiresAt: grant.expires_at,
      at: iso,
    });
    void sendMail(grant.user_id, 'expiry', {
      shareId: shareIdOf(grant.user_id),
      ownerName: actorBrief(grant.user_id).nickname,
      targetName: '',
      services: [],
      expiresAt: fmtUtc8(grant.expires_at),
      upcoming: true,
    });
  }
  return stats;
}

let watcher = null;
export function startPlazaWatcher() {
  if (watcher) return watcher;
  try {
    expireDuePlaza();
  } catch (err) {
    logger.warn('广场巡检首次执行失败', err?.message || err);
  }
  watcher = setInterval(() => {
    try {
      expireDuePlaza();
    } catch (err) {
      logger.warn('广场巡检失败', err?.message || err);
    }
  }, RATE_WINDOW_MS);
  watcher.unref?.();
  return watcher;
}

export function stopPlazaWatcher() {
  if (watcher) clearInterval(watcher);
  watcher = null;
}

// ---------------- 全球广场（公开只读 + 服务间签名写 + 本服代理） ----------------

const NONCE_TTL_MS = 300_000;
const usedNonces = new Map();

/** 全球地址：env COCOA_GLOBAL_PLAZA_URL → PUBLIC_URL → 当前请求 origin */
export function resolveGlobalUrl(origin = '') {
  const explicit = String(process.env.COCOA_GLOBAL_PLAZA_URL || '').trim();
  const pub = String(process.env.PUBLIC_URL || '').trim();
  const fallback = String(origin || '').trim();
  return (explicit || pub || fallback).replace(/\/+$/, '');
}

export function globalConfig() {
  const token = String(process.env.COCOA_PLAZA_GLOBAL_TOKEN || '').trim();
  const url = String(process.env.COCOA_GLOBAL_PLAZA_URL || '').trim().replace(/\/+$/, '');
  // host：本机承载全球广场（只部署全球主机，建议显式设置 COCOA_PLAZA_GLOBAL_HOST=1）
  const hostEnabled = Boolean(token) && (process.env.COCOA_PLAZA_GLOBAL_HOST === '1' || !url);
  return {
    token,
    hostEnabled,
    url,
    available: Boolean(transportUrl('')) && Boolean(token),
    rateLimit: { windowSec: RATE_WINDOW_MS / 1000, maxPerIp: RATE_LIMIT_PER_MINUTE, maxPerShareId: RATE_LIMIT_PER_MINUTE },
  };
}

function transportUrl(origin = '') {
  return resolveGlobalUrl(origin);
}

function sameOrigin(a, b) {
  if (!a || !b) return false;
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return String(a).replace(/\/+$/, '') === String(b).replace(/\/+$/, '');
  }
}

function isSelfGlobal(origin = '') {
  const url = transportUrl(origin);
  if (!url) return false;
  if (sameOrigin(url, origin)) return true;
  const pub = String(process.env.PUBLIC_URL || '').trim();
  return Boolean(pub) && sameOrigin(url, pub);
}

export function plazaMeta(userId, { origin = '' } = {}) {
  const cfg = globalConfig();
  const url = transportUrl(origin);
  return {
    scopeServer: true,
    scope: 'server',
    globalUrl: url,
    globalAvailable: Boolean(url),
    globalWritable: Boolean(cfg.token),
    globalHost: cfg.hostEnabled,
    shareId: userId ? ensureShareId(userId) : '',
    rateLimit: cfg.rateLimit,
    kinds: [...KINDS],
    visibilities: [...VISIBILITIES],
  };
}

function randomNonce() {
  return crypto.randomBytes(12).toString('base64url');
}

function rememberNonce(nonce, expiresAt) {
  usedNonces.set(nonce, expiresAt);
  if (usedNonces.size > 5000) {
    const now = Date.now();
    for (const [key, exp] of usedNonces) if (exp <= now) usedNonces.delete(key);
  }
}

const nonceTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, exp] of usedNonces) if (exp <= now) usedNonces.delete(key);
}, NONCE_TTL_MS);
nonceTimer.unref?.();

/**
 * 服务间签名：HMAC-SHA256(token, timestamp\nnonce\nMETHOD\npath\nbody)，±300s 时间窗 + nonce 防重放
 * @returns {{timestamp:string, nonce:string, signature:string}}
 */
export function signGlobalRequest({ method = 'GET', path: reqPath = '', bodyString = '', timestamp = Date.now(), nonce, token } = {}) {
  const secret = token ?? globalConfig().token;
  if (!secret) throw new AppError(503, 'plaza_global_disabled', '本服未配置全球共享密钥');
  const ts = String(timestamp);
  const n = nonce || randomNonce();
  const data = `${ts}\n${n}\n${String(method).toUpperCase()}\n${reqPath}\n${bodyString}`;
  return { timestamp: ts, nonce: n, signature: crypto.createHmac('sha256', secret).update(data).digest('hex') };
}

function parseTimestamp(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return text.length >= 13 ? n : n * 1000;
  }
  const t = new Date(text).getTime();
  return Number.isFinite(t) ? t : null;
}

/** 校验签名 / 时间窗 / nonce；返回 { shareId, actor } */
export function verifyGlobalRequest({ headers = {}, method = 'GET', path: reqPath = '', bodyString = '', now = Date.now() } = {}) {
  const cfg = globalConfig();
  if (!cfg.token) throw new AppError(503, 'plaza_global_disabled', '本服未启用全球广场服务');
  const shareId = String(headers['x-share-id'] || '').trim();
  if (!SHARE_ID_RE.test(shareId)) throw new AppError(401, 'plaza_share_id_required', '缺少或非法的 X-Share-Id');
  const tsRaw = String(headers['x-timestamp'] || '').trim();
  const nonce = String(headers['x-nonce'] || '').trim();
  const sig = String(headers['x-signature'] || '').trim();
  if (!tsRaw || !sig) throw new AppError(401, 'plaza_signature_required', '缺少 X-Timestamp / X-Signature');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(nonce)) throw new AppError(401, 'plaza_nonce_required', '缺少或非法的 X-Nonce');
  const ts = parseTimestamp(tsRaw);
  if (!ts || Math.abs(now - ts) > SIGNATURE_WINDOW_MS) {
    throw new AppError(401, 'plaza_signature_expired', '签名已过期，请检查时间同步');
  }
  const expected = crypto
    .createHmac('sha256', cfg.token)
    .update(`${tsRaw}\n${nonce}\n${String(method).toUpperCase()}\n${reqPath}\n${bodyString}`)
    .digest();
  const given = /^[0-9a-f]{64}$/i.test(sig) ? Buffer.from(sig, 'hex') : Buffer.alloc(0);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    throw new AppError(401, 'plaza_signature_invalid', '签名校验失败');
  }
  if (usedNonces.has(nonce)) throw new AppError(401, 'plaza_nonce_replay', '重复的请求 nonce，已拒绝');
  rememberNonce(nonce, ts + SIGNATURE_WINDOW_MS);
  return { shareId, actor: actorFromShareId(shareId) };
}

function sealKey() {
  const cfg = globalConfig();
  if (!cfg.token) throw new AppError(503, 'plaza_global_disabled', '本服未启用全球广场服务');
  return crypto.createHash('sha256').update(cfg.token).digest();
}

/** API key 跨服传输封装：AES-256-GCM，密钥由 COCOA_PLAZA_GLOBAL_TOKEN 派生 */
export function sealPayload(payload) {
  const key = sealKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${data.toString('base64url')}`;
}

export function openPayload(sealed) {
  const key = sealKey();
  const parts = String(sealed || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw badRequest('sealedPayload 格式不正确', 'plaza_seal_invalid');
  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]);
    return JSON.parse(out.toString('utf8'));
  } catch {
    throw badRequest('sealedPayload 解密失败', 'plaza_seal_invalid');
  }
}

/** 跨服身份（share ID）的封禁检查：本地用户与 share:<SID> 共用 plaza_bans */
export function assertActorNotBanned(ref, scope = 'global') {
  if (!ref) return;
  const ban = activeBan(ref, scope);
  if (ban) {
    throw new AppError(403, 'plaza_banned', '该 share ID 的分享权限已被禁用', {
      scope: ban.scope,
      reason: ban.reason || '',
      until: ban.until || null,
    });
  }
}

function ownerMetaOf(row) {
  const payload = payloadOf(row);
  return {
    originUrl: String(payload.originUrl || ''),
    ownerNickname: String(payload.ownerNickname || ''),
  };
}

function summaryOf(row, viewerRef = null) {
  const payload = payloadOf(row);
  const owner = actorBrief(row.owner_id);
  const meta = ownerMetaOf(row);
  const viewerShareId = shareIdOfActor(viewerRef);
  const likeRefs = viewerRef ? [String(viewerRef)] : [];
  if (viewerShareId) likeRefs.push(`share:${viewerShareId}`);
  const liked = likeRefs.some((ref) =>
    get('SELECT 1 AS x FROM plaza_likes WHERE resource_id = ? AND user_id = ?', row.id, ref),
  );
  return {
    id: row.id,
    title: row.title,
    description: row.description || '',
    kind: row.kind,
    ownerShareId: owner.shareId,
    ownerNickname: meta.ownerNickname || owner.nickname || '',
    likes: row.like_count || 0,
    liked,
    useCount: row.use_count || 0,
    expiresAt: row.expires_at || null,
    permanent: Boolean(row.permanent),
    tokenSoft: row.token_soft || 0,
    tokenHard: row.token_hard || 0,
    createdAt: row.created_at,
    services: row.kind === 'model' ? payload.services || [] : [],
    preview:
      row.kind === 'template'
        ? {
            name: String(payload.profile?.name || ''),
            personality: truncate(payload.profile?.personality || '', 80),
          }
        : { services: payload.services || [] },
  };
}

/** 全球公开只读列表（无需登录）：只返回摘要，绝不返回 payload / 密钥 / 邮箱 */
export function globalListPublic({ shareId = '', query = {} } = {}) {
  const page = Math.max(1, asInt(query.page, 1));
  const pageSize = Math.min(50, Math.max(1, asInt(query.pageSize ?? query.size, 20)));
  const kind = KINDS.includes(String(query.kind)) ? String(query.kind) : null;
  const q = String(query.q || '').trim().toLowerCase();
  const scope = String(query.scope || 'global') === 'server' ? 'server' : 'global';

  let rows = all("SELECT * FROM plaza_resources WHERE status = 'active' ORDER BY created_at DESC LIMIT 500");
  rows = rows.filter((row) => {
    if (windowState(row) !== 'active') return false;
    if (row.owner_id === 'share:' + shareId && shareId) return true;
    if (row.visibility === 'global') return true;
    if (row.visibility === 'users' && shareId) return parseTargets(row).includes(shareId);
    return scope === 'server' ? row.owner_id === 'share:' + shareId : false;
  });
  if (kind) rows = rows.filter((row) => row.kind === kind);
  if (q) {
    rows = rows.filter((row) =>
      `${row.title} ${row.description || ''}`.toLowerCase().includes(q) ||
      (row.kind === 'template' && String(payloadOf(row).profile?.name || '').toLowerCase().includes(q)),
    );
  }
  const viewerRef = shareId && SHARE_ID_RE.test(shareId) ? actorFromShareId(shareId).ref : null;
  const total = rows.length;
  const items = rows.slice((page - 1) * pageSize, page * pageSize).map((row) => summaryOf(row, viewerRef));
  return { items, total, page, pageSize, scope: 'global' };
}

function assertGlobalHost() {
  if (!globalConfig().hostEnabled) {
    throw new AppError(503, 'plaza_global_disabled', '本服不是全球广场主机，全球写接口未启用');
  }
}

/** 内部：按已解密的 payload 创建资源（外站主体与全球模型发布共用） */
function createResourceWithPayload(actor, input, payload) {
  if (!payload || typeof payload !== 'object') throw badRequest('资源内容缺失', 'plaza_payload_missing');
  const visibility = input.visibility === 'users' ? 'users' : 'global';
  const targetShareIds = parseShareIdList(input.targetShareIds);
  if (visibility === 'users' && !targetShareIds.length) {
    throw badRequest('定向分享需要 targetShareIds', 'plaza_target_required');
  }
  const permanent = Boolean(input.permanent);
  let startsAt = null;
  let expiresAt = null;
  if (!permanent) {
    startsAt = parseTimeInput(input.startsAt);
    expiresAt = parseTimeInput(input.expiresAt);
    if (!startsAt && !expiresAt) throw badRequest('请设置展示时间或选择永久', 'plaza_time_required');
    if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) throw badRequest('结束时间必须晚于当前时间', 'plaza_expires_past');
    if (startsAt && expiresAt && new Date(startsAt).getTime() >= new Date(expiresAt).getTime()) {
      throw badRequest('开始时间必须早于结束时间', 'plaza_time_range_invalid');
    }
  }
  const title = truncate(String(input.title || '').trim(), 80);
  if (!title) throw badRequest('请填写标题', 'plaza_title_required');
  const tokenSoft = parseTokenLimit(input.tokenSoft, 'tokenSoft');
  const tokenHard = parseTokenLimit(input.tokenHard, 'tokenHard');
  if (tokenSoft && tokenHard && tokenHard < tokenSoft) throw badRequest('硬限额不能小于软限额', 'plaza_token_limit_order');

  const id = `pl_${uuid().replace(/-/g, '').slice(0, 18)}`;
  const now = nowIso();
  run(
    `INSERT INTO plaza_resources(id, owner_id, kind, title, description, payload, visibility, target_user_ids,
       token_soft, token_hard, permanent, starts_at, expires_at, status, like_count, use_count, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?, 'active', 0, 0, ?, ?)`,
    id,
    String(actor.ref),
    input.kind === 'model' ? 'model' : 'template',
    title,
    truncate(String(input.description || '').trim(), 500) || null,
    encryptJson(String(actor.ref), payload),
    visibility,
    visibility === 'users' ? JSON.stringify(targetShareIds) : null,
    tokenSoft,
    tokenHard,
    permanent ? 1 : 0,
    startsAt,
    expiresAt,
    now,
    now,
  );
  const row = get('SELECT * FROM plaza_resources WHERE id = ?', id);
  return toResource(row, actor.ref, { detail: true });
}

/** 全球发布（服务间）：body 可带 ownerShareId / originUrl / ownerNickname */
export function globalPublish({ shareId, body = {}, originUrl = '' }) {
  assertGlobalHost();
  const actor = actorFromShareId(shareId);
  if (body.ownerShareId && String(body.ownerShareId) !== shareId) {
    throw new AppError(400, 'plaza_owner_mismatch', 'ownerShareId 与签名身份不一致');
  }
  assertActorNotBanned(actor.ref, 'global');

  const visibility = body.visibility === 'users' ? 'users' : 'global';
  const origin = truncate(String(body.originUrl || originUrl || ''), 200);
  const ownerNickname = truncate(String(body.ownerNickname || ''), 40);
  const meta = { originUrl: origin, ownerNickname };
  const input = {
    kind: body.kind,
    title: body.title,
    description: body.description,
    visibility,
    targetShareIds: body.targetShareIds,
    tokenSoft: body.tokenSoft,
    tokenHard: body.tokenHard,
    permanent: body.permanent,
    startsAt: body.startsAt,
    expiresAt: body.expiresAt,
    profile: body.profile,
  };

  if (body.kind === 'model') {
    const sealed = body.sealedPayload;
    if (!sealed) throw badRequest('模型资源需要 sealedPayload', 'plaza_sealed_payload_required');
    const payload = openPayload(sealed);
    const config = payload?.config || {};
    const services = (payload?.services || Object.keys(config)).filter((svc) => config[svc]?.apiKey);
    if (!services.length) throw badRequest('sealedPayload 中没有可用的模型配置', 'plaza_no_model_config');
    return createResourceWithPayload(actor, input, {
      services,
      config: Object.fromEntries(services.map((svc) => [svc, config[svc]])),
      models: Object.fromEntries(services.map((svc) => [svc, String(config[svc]?.model || '')])),
      ...meta,
    });
  }
  return createResource(actor.ref, input, meta);
}

/** 全球点赞（服务间） */
export function globalLike({ shareId, resourceId }) {
  assertGlobalHost();
  const actor = actorFromShareId(shareId);
  assertActorNotBanned(actor.ref, 'global');
  const row = get('SELECT * FROM plaza_resources WHERE id = ?', String(resourceId || ''));
  if (!row || row.status !== 'active') throw notFound('资源不存在', 'plaza_resource_not_found');
  if (!canView(row, actor.ref, actor.shareId)) throw forbidden('无权点赞该资源', 'plaza_forbidden');
  const exists = get('SELECT 1 AS x FROM plaza_likes WHERE resource_id = ? AND user_id = ?', row.id, actor.ref);
  if (exists) {
    run('DELETE FROM plaza_likes WHERE resource_id = ? AND user_id = ?', row.id, actor.ref);
    run('UPDATE plaza_resources SET like_count = MAX(0, like_count - 1) WHERE id = ?', row.id);
  } else {
    run('INSERT INTO plaza_likes(resource_id, user_id, created_at) VALUES(?,?,?)', row.id, actor.ref, nowIso());
    run('UPDATE plaza_resources SET like_count = like_count + 1 WHERE id = ?', row.id);
  }
  const fresh = get('SELECT * FROM plaza_resources WHERE id = ?', row.id);
  return { ok: true, liked: !exists, likes: fresh.like_count || 0, likeCount: fresh.like_count || 0 };
}

/** 全球使用（服务间）：模板返回人设；模型返回 sealedPayload（仅服务端可解） */
export function globalUse({ shareId, resourceId }) {
  assertGlobalHost();
  const actor = actorFromShareId(shareId);
  assertActorNotBanned(actor.ref, 'global');
  const row = get('SELECT * FROM plaza_resources WHERE id = ?', String(resourceId || ''));
  if (!row || row.status === 'deleted') throw notFound('资源不存在', 'plaza_resource_not_found');
  if (row.owner_id === actor.ref) throw badRequest('不能使用自己发布的资源', 'plaza_self_use');
  if (!canView(row, actor.ref, actor.shareId)) throw forbidden('无权使用该资源', 'plaza_forbidden');
  if (windowState(row) !== 'active') throw conflict('资源当前不可用（未开始或已结束）', 'plaza_resource_inactive');
  const grant = ensureGrant(row, actor.ref);
  if (quotaReached(row, grant)) throw new AppError(403, 'plaza_quota_exhausted', '该资源的使用额度已用尽');

  const payload = payloadOf(row);
  let result;
  if (row.kind === 'template') {
    result = { kind: 'template', profile: payload.profile || {} };
  } else {
    const config = payload.config || {};
    const services = payload.services || Object.keys(config);
    if (!services.length) throw new AppError(502, 'plaza_model_payload_missing', '该资源的模型配置缺失');
    if (actor.local) {
      materializeModelGrant(actor.ref, {
        resourceId: row.id,
        grantId: grant.id,
        config,
        services,
        expiresAt: grant.expires_at,
        permanent: Boolean(row.permanent),
      });
    }
    result = {
      kind: 'model',
      providerRef: providerRefOf(row, payload),
      services,
      sealedPayload: sealPayload({ services, config, models: payload.models || {} }),
    };
  }
  notifyUser(row.owner_id, {
    type: 'plaza_used',
    resourceId: row.id,
    title: row.title,
    kind: row.kind,
    by: { shareId: actor.shareId, code: actorBrief(actor.ref).code, nickname: actorBrief(actor.ref).nickname },
    at: nowIso(),
  });
  const fresh = get('SELECT * FROM plaza_resources WHERE id = ?', row.id);
  return {
    ok: true,
    ...result,
    resource: summaryOf(fresh, actor.ref),
    grant: {
      id: grant.id,
      status: grant.status,
      usedTokens: grant.used_tokens || 0,
      tokenSoft: row.token_soft || 0,
      tokenHard: row.token_hard || 0,
      expiresAt: grant.expires_at || null,
      ownerShareId: actorBrief(row.owner_id).shareId,
    },
  };
}

/** 把「全球 use 结果」落到本服：影子资源 + 授权 + 模型镜像 */
export function applyGlobalUseResult(userId, globalResourceId, json = {}, { originUrl = '' } = {}) {
  const ownerShareId = json.grant?.ownerShareId || json.resource?.ownerShareId || '';
  const localId = `pl_global_${sha256(`global:${globalResourceId}:${userId}`).slice(0, 14)}`;
  const now = nowIso();
  let sealedPayload = null;
  if (json.kind === 'model' && json.sealedPayload) sealedPayload = openPayload(json.sealedPayload);
  const existing = get('SELECT * FROM plaza_resources WHERE id = ?', localId);
  if (!existing) {
    const ownerRef = ownerShareId ? `share:${ownerShareId}` : 'share:00000000';
    const payload = json.kind === 'model'
      ? {
          services: sealedPayload?.services || [],
          config: sealedPayload?.config || {},
          models: sealedPayload?.models || {},
          originUrl,
          ownerNickname: json.resource?.ownerNickname || '',
        }
      : {
          profile: json.profile || {},
          originUrl,
          ownerNickname: json.resource?.ownerNickname || '',
        };
    run(
      `INSERT INTO plaza_resources(id, owner_id, kind, title, description, payload, visibility, target_user_ids,
         token_soft, token_hard, permanent, starts_at, expires_at, status, like_count, use_count, created_at, updated_at)
       VALUES(?,?,?,?,?,?, 'users', ?,?,?,?,NULL,?, 'active', 0, 1, ?, ?)`,
      localId,
      ownerRef,
      json.kind === 'model' ? 'model' : 'template',
      truncate(json.resource?.title || '全球资源', 80),
      truncate(json.resource?.description || '', 500) || null,
      encryptJson(ownerRef, payload),
      JSON.stringify([shareIdOf(userId)]),
      json.grant?.tokenSoft || 0,
      json.grant?.tokenHard || 0,
      json.grant?.expiresAt ? 0 : 1,
      json.grant?.expiresAt || null,
      now,
      now,
    );
  }
  run(
    `INSERT INTO plaza_grants(id, resource_id, user_id, status, used_tokens, created_at, updated_at, expires_at)
     VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(resource_id, user_id) DO UPDATE SET status='active', expires_at=excluded.expires_at, updated_at=excluded.updated_at`,
    `pg_${sha256(`grant:${localId}:${userId}`).slice(0, 16)}`,
    localId,
    String(userId),
    'active',
    json.grant?.usedTokens || 0,
    now,
    now,
    json.grant?.expiresAt || null,
  );
  const grant = get('SELECT * FROM plaza_grants WHERE resource_id = ? AND user_id = ?', localId, String(userId));
  if (json.kind === 'model' && sealedPayload) {
    materializeModelGrant(userId, {
      resourceId: localId,
      grantId: grant.id,
      config: sealedPayload.config || {},
      services: sealedPayload.services || [],
      expiresAt: json.grant?.expiresAt || null,
      permanent: !json.grant?.expiresAt,
    });
  }
  const row = get('SELECT * FROM plaza_resources WHERE id = ?', localId);
  return {
    ok: true,
    kind: json.kind,
    globalResourceId,
    resource: toResource(row, userId, { detail: true }),
    grant: {
      id: grant.id,
      status: grant.status,
      usedTokens: grant.used_tokens || 0,
      tokenSoft: json.grant?.tokenSoft || 0,
      tokenHard: json.grant?.tokenHard || 0,
      expiresAt: grant.expires_at || null,
      ownerShareId,
    },
    ...(json.kind === 'template' ? { profile: json.profile || {} } : { providerRef: json.providerRef }),
  };
}

async function signedRequest({ method, path: reqPath, body, origin = '', fetchImpl = null }) {
  const cfg = globalConfig();
  const url = transportUrl(origin);
  if (!url) throw new AppError(503, 'plaza_global_unavailable', '本服未配置全球广场地址');
  if (!cfg.token) throw new AppError(503, 'plaza_global_disabled', '本服未配置全球共享密钥');
  const bodyString = body === undefined ? '' : JSON.stringify(body);
  const signed = signGlobalRequest({ method, path: reqPath, bodyString });
  const doFetch = fetchImpl || fetch;
  let res;
  try {
    res = await doFetch(url + reqPath, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-share-id': body?.ownerShareId || body?.shareId || '',
        'x-timestamp': signed.timestamp,
        'x-nonce': signed.nonce,
        'x-signature': signed.signature,
      },
      ...(bodyString ? { body: bodyString } : {}),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new AppError(502, 'plaza_global_unreachable', `全球广场不可达：${truncate(err.message, 160)}`);
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!res.ok || !json || json.ok === false) {
    throw new AppError(502, 'plaza_global_error', json?.error?.message || `全球广场返回 ${res.status}`);
  }
  return json;
}

/** 跨服导入（保留旧接口）：签名请求全球 use 后落地到本服 */
export async function importGlobalResource(userId, { resourceId, fetchImpl = null, origin = '' } = {}) {
  const shareId = ensureShareId(userId);
  const json = await signedRequest({
    method: 'POST',
    path: '/api/plaza/global/use',
    body: { resourceId: String(resourceId || ''), ownerShareId: shareId },
    origin,
    fetchImpl,
  });
  const result = applyGlobalUseResult(userId, String(resourceId), json, { originUrl: transportUrl(origin) });
  audit(userId, 'plaza.global.import', result.resource.id, { globalResourceId: resourceId }, null);
  return result;
}

// ---------------- 本服代理（客户端只访问本服） ----------------

/** 代理全球公开列表；不可用时返回 {ok:false, globalAvailable:false} 而不是 500 */
export async function proxyGlobalList(actorRef, query = {}, { origin = '', fetchImpl = null } = {}) {
  const url = transportUrl(origin);
  const shareId = shareIdOfActor(actorRef);
  if (!url) return { ok: false, globalAvailable: false, reason: 'not_configured', items: [], total: 0 };
  if (isSelfGlobal(origin)) {
    return { ok: true, globalAvailable: true, ...globalListPublic({ shareId, query }) };
  }
  try {
    const params = new URLSearchParams();
    for (const key of ['q', 'kind', 'page', 'pageSize', 'scope']) {
      if (query[key] !== undefined && query[key] !== '') params.set(key, String(query[key]));
    }
    const doFetch = fetchImpl || fetch;
    const res = await doFetch(`${url}/api/plaza/global/list?${params.toString()}`, {
      headers: shareId ? { 'x-share-id': shareId } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return { ok: true, globalAvailable: true, ...json };
  } catch (err) {
    return { ok: false, globalAvailable: false, reason: truncate(err.message, 120), items: [], total: 0 };
  }
}

/** 代理发布：用本服用户身份（share ID + originUrl + HMAC）转发到全球服 */
export async function proxyGlobalPublish(actorRef, input = {}, { origin = '', fetchImpl = null } = {}) {
  if (!isLocalActor(actorRef)) throw forbidden('只有本服用户可以通过代理发布', 'plaza_proxy_local_only');
  const shareId = ensureShareId(actorRef);
  const actor = actorBrief(actorRef);
  const base = {
    kind: input.kind,
    title: input.title,
    description: input.description,
    visibility: input.visibility === 'users' ? 'users' : 'global',
    targetShareIds: input.targetShareIds,
    tokenSoft: input.tokenSoft,
    tokenHard: input.tokenHard,
    permanent: input.permanent,
    startsAt: input.startsAt,
    expiresAt: input.expiresAt,
    ownerShareId: shareId,
    ownerNickname: actor.nickname || '',
    originUrl: transportUrl(origin),
  };
  if (base.kind === 'model') {
    const payload = pickModelPayload(actorRef, input);
    base.sealedPayload = sealPayload(payload);
  } else {
    base.profile = input.profile;
  }
  if (isSelfGlobal(origin)) {
    const resource = globalPublish({ shareId, body: base, originUrl: base.originUrl });
    audit(actorRef, 'plaza.global.publish', resource.id, { via: 'proxy-self' }, null);
    return { ok: true, resource };
  }
  const json = await signedRequest({
    method: 'POST',
    path: '/api/plaza/global/publish',
    body: base,
    origin,
    fetchImpl,
  });
  audit(actorRef, 'plaza.global.publish', json.resource?.id || null, { via: 'proxy-remote' }, null);
  return json;
}

/** 代理使用：全球模板/模型结果落到本服（模型镜像 + 授权 + 额度） */
export async function proxyGlobalUse(actorRef, resourceId, { origin = '', fetchImpl = null } = {}) {
  if (!isLocalActor(actorRef)) throw forbidden('只有本服用户可以通过代理使用', 'plaza_proxy_local_only');
  const shareId = ensureShareId(actorRef);
  if (isSelfGlobal(origin)) {
    const { sealedPayload, ...safe } = globalUse({ shareId, resourceId: String(resourceId) });
    return safe;
  }
  const json = await signedRequest({
    method: 'POST',
    path: '/api/plaza/global/use',
    body: { resourceId: String(resourceId), ownerShareId: shareId },
    origin,
    fetchImpl,
  });
  const result = applyGlobalUseResult(actorRef, String(resourceId), json, { originUrl: transportUrl(origin) });
  audit(actorRef, 'plaza.global.use', result.resource.id, { globalResourceId: resourceId }, null);
  return result;
}

/** 代理点赞 */
export async function proxyGlobalLike(actorRef, resourceId, { origin = '', fetchImpl = null } = {}) {
  if (!isLocalActor(actorRef)) throw forbidden('只有本服用户可以通过代理点赞', 'plaza_proxy_local_only');
  const shareId = ensureShareId(actorRef);
  if (isSelfGlobal(origin)) return globalLike({ shareId, resourceId: String(resourceId) });
  return signedRequest({
    method: 'POST',
    path: '/api/plaza/global/like',
    body: { resourceId: String(resourceId), ownerShareId: shareId },
    origin,
    fetchImpl,
  });
}

/** 供 AI 线/配置页展示：当前生效的广场模型授权（不含 key） */
export function plazaModelGrants(userId) {
  const rows = all(
    `SELECT g.*, r.title, r.owner_id FROM plaza_grants g JOIN plaza_resources r ON r.id = g.resource_id
      WHERE g.user_id = ? AND g.status IN (?,?,?) AND r.kind = 'model' ORDER BY g.created_at DESC`,
    String(userId),
    ...GRANT_ACTIVE,
  );
  return rows.map((grant) => {
    const { shareId } = actorBrief(grant.owner_id);
    return {
      grantId: grant.id,
      resourceId: grant.resource_id,
      title: grant.title,
      ownerShareId: shareId,
      status: grant.status,
      usedTokens: grant.used_tokens || 0,
      expiresAt: grant.expires_at || null,
      providerId: `plaza:${grant.resource_id}`,
    };
  });
}

export function maskKey(value) {
  return maskSecret(value);
}

export default {
  plazaMeta,
  ensureShareId,
  rotateShareId,
  createResource,
  updateResource,
  deleteResource,
  listResources,
  getResource,
  likeResource,
  useResource,
  myPlaza,
  grantFor,
  consumeGrantTokens,
  expireDuePlaza,
  startPlazaWatcher,
  stopPlazaWatcher,
  createBan,
  deleteBan,
  listBans,
  assertNotBanned,
  assertActorNotBanned,
  activeBan,
  globalConfig,
  resolveGlobalUrl,
  globalPublish,
  globalListPublic,
  globalLike,
  globalUse,
  applyGlobalUseResult,
  importGlobalResource,
  proxyGlobalList,
  proxyGlobalPublish,
  proxyGlobalUse,
  proxyGlobalLike,
  signGlobalRequest,
  verifyGlobalRequest,
  sealPayload,
  openPayload,
  plazaModelGrants,
  fmtUtc8,
};
