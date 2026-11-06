// v1.5.0 人设模板：CRUD / 从角色导入（去重）/ 应用模板建角 / 发布到广场
// 存储沿用 character_templates(id, user_id, name, payload, created_at)，payload 为加密人设 JSON
import { all, get, run } from '../db/index.js';
import { encryptJson, decryptJson, sha256 } from '../core/crypto.js';
import { nowIso, uuid } from '../core/util.js';
import { AppError, badRequest, notFound } from '../core/errors.js';
import { PROFILE_FIELDS, createCharacter, getCharacter, listCharacters } from './characters.js';
import { audit } from './audit.js';
import { createResource, getResource, useResource } from './plaza.js';

export function sanitizeProfile(input = {}, { requireName = true } = {}) {
  const profile = {};
  for (const field of PROFILE_FIELDS) profile[field] = String(input?.[field] ?? '').slice(0, 4000);
  if (requireName && !profile.name.trim()) throw badRequest('人设模板缺少角色姓名', 'template_profile_name_required');
  return profile;
}

/** 归一化 hash：忽略空白差异，按字段排序后 sha256 —— 用于「不可重复导入」 */
export function profileHash(profile = {}) {
  const normalized = {};
  for (const field of PROFILE_FIELDS) {
    const value = String(profile?.[field] ?? '')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();
    if (value) normalized[field] = value;
  }
  return sha256(JSON.stringify(normalized));
}

function shape(row, userId) {
  const profile = decryptJson(userId, row.payload, {}) || {};
  return {
    id: row.id,
    name: row.name,
    profile,
    hash: profileHash(profile),
    createdAt: row.created_at,
    fieldCount: PROFILE_FIELDS.filter((f) => String(profile[f] || '').trim()).length,
  };
}

export function listTemplates(userId) {
  const rows = all('SELECT * FROM character_templates WHERE user_id = ? ORDER BY created_at DESC LIMIT 300', userId);
  return rows.map((row) => shape(row, userId));
}

export function getTemplate(userId, id) {
  const row = get('SELECT * FROM character_templates WHERE id = ? AND user_id = ?', String(id || ''), userId);
  if (!row) throw notFound('模板不存在', 'template_not_found');
  return shape(row, userId);
}

function findDuplicate(userId, hash, exceptId = null) {
  const rows = all('SELECT * FROM character_templates WHERE user_id = ?', userId);
  for (const row of rows) {
    if (exceptId && row.id === exceptId) continue;
    const profile = decryptJson(userId, row.payload, {}) || {};
    if (profileHash(profile) === hash) return row;
  }
  return null;
}

function insertTemplate(userId, { name, profile }) {
  const id = `tpl_${uuid().replace(/-/g, '').slice(0, 16)}`;
  const createdAt = nowIso();
  run(
    'INSERT INTO character_templates(id, user_id, name, payload, created_at) VALUES(?,?,?,?,?)',
    id,
    userId,
    String(name).slice(0, 60),
    encryptJson(userId, profile),
    createdAt,
  );
  return { id, createdAt };
}

export function createTemplate(userId, input = {}) {
  const name = String(input.name || input.profileName || '').trim();
  const profile = sanitizeProfile(input.profile || input);
  const validName = (name || profile.name).slice(0, 60);
  if (!validName) throw badRequest('请填写模板名称', 'template_name_required');
  const { id, createdAt } = insertTemplate(userId, { name: validName, profile });
  audit(userId, 'template.create', id, { name: validName }, null);
  return { template: { id, name: validName, profile, createdAt, hash: profileHash(profile) } };
}

/** 从已有角色导入（重复导入返回 409，并回带已存在的模板 id） */
export function importFromCharacter(userId, characterId) {
  const character = getCharacter(userId, String(characterId || ''), { includeArchived: true });
  if (!character) throw notFound('角色不存在或不属于当前账号', 'character_not_found');
  const profile = sanitizeProfile(character);
  const hash = profileHash(profile);
  const dup = findDuplicate(userId, hash);
  if (dup) {
    throw new AppError(409, 'template_duplicate', '该人设已经导入过，无需重复导入', {
      templateId: dup.id,
      name: dup.name,
      createdAt: dup.created_at,
    });
  }
  const { id, createdAt } = insertTemplate(userId, { name: `${character.name || '未命名'} 人设`.slice(0, 60), profile });
  audit(userId, 'template.import', id, { characterId: character.id }, null);
  return { template: { id, name: `${character.name || '未命名'} 人设`, profile, createdAt, hash }, sourceCharacterId: character.id };
}

export function updateTemplate(userId, id, input = {}) {
  const row = get('SELECT * FROM character_templates WHERE id = ? AND user_id = ?', String(id || ''), userId);
  if (!row) throw notFound('模板不存在', 'template_not_found');
  const current = decryptJson(userId, row.payload, {}) || {};
  const profile = input.profile ? sanitizeProfile(input.profile) : current;
  if (input.profile) {
    const dup = findDuplicate(userId, profileHash(profile), row.id);
    if (dup) throw new AppError(409, 'template_duplicate', '已存在相同人设的模板', { templateId: dup.id });
  }
  const name = input.name !== undefined ? String(input.name || '').trim().slice(0, 60) : row.name;
  if (!name) throw badRequest('模板名称不能为空', 'template_name_required');
  run('UPDATE character_templates SET name = ?, payload = ? WHERE id = ?', name, encryptJson(userId, profile), row.id);
  audit(userId, 'template.update', row.id, { fields: Object.keys(input) }, null);
  return { template: shape(get('SELECT * FROM character_templates WHERE id = ?', row.id), userId) };
}

export function deleteTemplate(userId, id) {
  const row = get('SELECT * FROM character_templates WHERE id = ? AND user_id = ?', String(id || ''), userId);
  if (!row) throw notFound('模板不存在', 'template_not_found');
  run('DELETE FROM character_templates WHERE id = ?', row.id);
  audit(userId, 'template.delete', row.id, null, null);
  return { ok: true, id: row.id };
}

/** 一键用模板创建角色（复用 characters.createCharacter） */
export function applyTemplate(userId, id, input = {}) {
  const template = getTemplate(userId, id);
  const overrides = {};
  for (const field of PROFILE_FIELDS) {
    if (input[field] !== undefined && String(input[field]).trim() !== '') overrides[field] = String(input[field]);
  }
  const profile = sanitizeProfile({ ...template.profile, ...overrides });
  const character = createCharacter(userId, {
    ...profile,
    ...(input.settings && typeof input.settings === 'object' ? { settings: input.settings } : {}),
  });
  audit(userId, 'template.apply', character.id, { templateId: template.id }, null);
  return { character, templateId: template.id };
}

/** 把模板发布到广场（kind=template） */
export function publishTemplate(userId, id, input = {}) {
  const template = getTemplate(userId, id);
  const resource = createResource(userId, {
    kind: 'template',
    title: input.title || template.name,
    description: input.description || template.profile.personality || '',
    visibility: input.visibility,
    targetShareIds: input.targetShareIds,
    tokenSoft: input.tokenSoft,
    tokenHard: input.tokenHard,
    permanent: input.permanent,
    startsAt: input.startsAt,
    expiresAt: input.expiresAt,
    profile: template.profile,
  });
  audit(userId, 'template.publish', resource.id, { templateId: template.id, visibility: resource.visibility }, null);
  return { resource };
}

/** 从广场资源落成本地模板（去重） */
export function templateFromPlaza(userId, resourceId) {
  const resource = getResource(userId, resourceId);
  if (resource.kind !== 'template') throw badRequest('该资源不是人设模板', 'plaza_kind_mismatch');
  const profile = sanitizeProfile(resource.profile || {});
  const hash = profileHash(profile);
  const dup = findDuplicate(userId, hash);
  if (dup) {
    return { template: shape(get('SELECT * FROM character_templates WHERE id = ?', dup.id), userId), duplicate: true };
  }
  const { id, createdAt } = insertTemplate(userId, { name: (resource.title || profile.name).slice(0, 60), profile });
  audit(userId, 'template.from_plaza', id, { resourceId: resource.id }, null);
  return { template: { id, name: resource.title || profile.name, profile, createdAt, hash }, duplicate: false };
}

/** 广场资源「一键使用」的模板分支：返回人设 + 本地模板落库 */
export function usePlazaTemplate(userId, resourceId, { save = true } = {}) {
  const used = useResource(userId, resourceId);
  if (used.kind !== 'template') throw badRequest('该资源不是人设模板', 'plaza_kind_mismatch');
  let saved = null;
  if (save) {
    try {
      saved = templateFromPlaza(userId, resourceId);
    } catch {
      saved = null;
    }
  }
  return { ...used, savedTemplate: saved?.template || null, duplicate: Boolean(saved?.duplicate) };
}

export function templateSourcesFor(userId) {
  return listCharacters(userId).map((c) => ({ characterId: c.id, name: c.name }));
}

export default {
  listTemplates,
  getTemplate,
  createTemplate,
  importFromCharacter,
  updateTemplate,
  deleteTemplate,
  applyTemplate,
  publishTemplate,
  templateFromPlaza,
  usePlazaTemplate,
  profileHash,
  sanitizeProfile,
};
