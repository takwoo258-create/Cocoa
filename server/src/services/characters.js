// 角色域：人设字段加解密、状态、设置、隔离校验（用户-角色）
import { get, all, run, tx } from '../db/index.js';
import { encryptText, decryptText, encryptJson, decryptJson, hashPassword, verifyPassword } from '../core/crypto.js';
import { nowIso, uuid, parseJson, randomInt, dayKey } from '../core/util.js';
import { getPrefs } from './settings.js';

export const PROFILE_FIELDS = [
  'name', 'age', 'race', 'gender', 'personality', 'worldview',
  'hobbies', 'relation', 'appearance', 'occupation',
];
const ENCRYPTED_FIELDS = [...PROFILE_FIELDS, 'avatar'];

export const DEFAULT_CHARACTER_SETTINGS = {
  rss: [],
  creationTags: [],
  creationFrequency: 'daily', // daily | hourly | off
  sleep: { enabled: true, start: '23:30', end: '07:00', napStart: '13:00', napEnd: '14:30' },
  // v1.5.0：状态刷新间隔（分钟，5..43200；0 = 永久不自动刷新）；运行开关关闭后暂停一切活动
  statusIntervalMin: 30,
  enabled: true,
  activeReply: true,
  qzoneEnabled: false,
  // v1.2.0：角色对用户的称呼（空则用用户昵称）、是否接入 QQ（全账号仅一个角色可为 true）
  userAddress: '',
  qqEnabled: false,
  timezone: 'Asia/Shanghai',
  // v1.5.0：角色所在世界的天气城市（减少天气接口调用，同一城市 30 分钟内复用）
  weatherCity: '宣城',
  modelRouting: {},
  searchProvider: 'deepseek',
  diaryHintEnabled: true,
};

export function decryptRow(row) {
  if (!row) return null;
  const out = { ...row };
  for (const f of ENCRYPTED_FIELDS) {
    if (row[f] != null) {
      try {
        out[f] = decryptText(row.user_id, row[f]);
      } catch {
        out[f] = '';
      }
    }
  }
  out.archived = Boolean(row.archived);
  return out;
}

export function ensureState(characterId, userId) {
  let state = get('SELECT * FROM character_state WHERE character_id = ?', characterId);
  if (!state) {
    run(
      `INSERT INTO character_state(character_id, motion, psychology, mood, health, sleep_state, companion_since, updated_at)
       VALUES(?,?,?,?,?,'awake',?,?)`,
      characterId,
      '安静地待着',
      '想着今天要做的事',
      '平静',
      '健康',
      nowIso(),
      nowIso(),
    );
    state = get('SELECT * FROM character_state WHERE character_id = ?', characterId);
  }
  return state;
}

export function getSettings(characterId, userId) {
  const row = get('SELECT payload FROM character_settings WHERE character_id = ?', characterId);
  const saved = row ? decryptJson(userId, row.payload, {}) : {};
  return { ...DEFAULT_CHARACTER_SETTINGS, ...saved, sleep: { ...DEFAULT_CHARACTER_SETTINGS.sleep, ...(saved.sleep || {}) } };
}

export function saveSettings(characterId, userId, patch) {
  const current = getSettings(characterId, userId);
  const next = { ...current, ...(patch || {}), sleep: { ...current.sleep, ...(patch?.sleep || {}) } };
  run(
    'INSERT INTO character_settings(character_id, payload, updated_at) VALUES(?,?,?) ON CONFLICT(character_id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at',
    characterId,
    encryptJson(userId, next),
    nowIso(),
  );
  return next;
}

export function createCharacter(userId, data) {
  const id = `c_${uuid().replace(/-/g, '').slice(0, 16)}`;
  const values = {};
  for (const f of PROFILE_FIELDS) values[f] = encryptText(userId, String(data?.[f] ?? ''));
  const now = nowIso();
  tx(() => {
    run(
      `INSERT INTO characters(id, user_id, name, age, race, gender, personality, worldview, hobbies, relation, appearance, occupation, avatar, created_at, updated_at, archived)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
      id,
      userId,
      values.name,
      values.age,
      values.race,
      values.gender,
      values.personality,
      values.worldview,
      values.hobbies,
      values.relation,
      values.appearance,
      values.occupation,
      data?.avatar ? encryptText(userId, data.avatar) : null,
      now,
      now,
    );
    run(
      `INSERT INTO character_state(character_id, motion, psychology, mood, health, sleep_state, companion_since, updated_at)
       VALUES(?,?,?,?,?,'awake',?,?)`,
      id,
      '安静地待着',
      '想着今天要做的事',
      '平静',
      '健康',
      now,
      now,
    );
    if (data?.settings) saveSettings(id, userId, data.settings);
  });
  return getCharacter(userId, id);
}

export function getCharacterRow(userId, id, { includeArchived = false } = {}) {
  const row = get('SELECT * FROM characters WHERE id = ? AND user_id = ?', id, userId);
  if (!row) return null;
  if (row.archived && !includeArchived) return null;
  return row;
}

export function getCharacter(userId, id, opts) {
  const row = getCharacterRow(userId, id, opts);
  if (!row) return null;
  return shapeCharacter(row, userId);
}

export function shapeCharacter(row, userId) {
  const c = decryptRow(row);
  const state = ensureState(row.id, userId);
  const settings = getSettings(row.id, userId);
  // v1.2.0：QQ 接入以 characters.qq_enabled 列为准（全账号唯一）
  settings.qqEnabled = Boolean(row.qq_enabled);
  const companionDays = state.companion_since
    ? Math.max(1, Math.floor((Date.now() - new Date(state.companion_since).getTime()) / 86400000) + 1)
    : 0;
  return {
    id: c.id,
    name: c.name,
    age: c.age,
    race: c.race,
    gender: c.gender,
    personality: c.personality,
    worldview: c.worldview,
    hobbies: c.hobbies,
    relation: c.relation,
    appearance: c.appearance,
    occupation: c.occupation,
    avatar: c.avatar || null,
    qqEnabled: Boolean(row.qq_enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archived: Boolean(row.archived),
    state: {
      motion: state.motion,
      psychology: state.psychology,
      mood: state.mood,
      health: state.health,
      sleepState: state.sleep_state,
      updatedAt: state.updated_at,
      intimacy: Math.round((state.intimacy || 0) * 10) / 10,
      companionDays,
      chatCount: state.chat_count || 0,
    },
    settings,
  };
}

export function listCharacters(userId, { includeArchived = false } = {}) {
  const rows = includeArchived
    ? all('SELECT * FROM characters WHERE user_id = ? ORDER BY created_at ASC', userId)
    : all('SELECT * FROM characters WHERE user_id = ? AND archived = 0 ORDER BY created_at ASC', userId);
  return rows.map((r) => shapeCharacter(r, userId));
}

export function updateCharacter(userId, id, patch) {
  const row = getCharacterRow(userId, id, { includeArchived: true });
  if (!row) return null;
  const sets = [];
  const vals = [];
  for (const f of PROFILE_FIELDS) {
    if (patch?.[f] !== undefined) {
      sets.push(`${f} = ?`);
      vals.push(encryptText(userId, String(patch[f] ?? '')));
    }
  }
  if (patch?.avatar !== undefined) {
    sets.push('avatar = ?');
    vals.push(patch.avatar ? encryptText(userId, String(patch.avatar)) : null);
  }
  if (patch?.archived !== undefined) {
    sets.push('archived = ?');
    vals.push(patch.archived ? 1 : 0);
  }
  if (sets.length) {
    sets.push('updated_at = ?');
    vals.push(nowIso());
    run(`UPDATE characters SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`, ...vals, id, userId);
  }
  if (patch?.settings) saveSettings(id, userId, patch.settings);
  return getCharacter(userId, id, { includeArchived: true });
}

export function deleteCharacter(userId, id) {
  const row = getCharacterRow(userId, id, { includeArchived: true });
  if (!row) return false;
  tx(() => {
    const convs = all('SELECT id FROM conversations WHERE character_id = ?', id);
    for (const c of convs) run('DELETE FROM messages WHERE conversation_id = ?', c.id);
    run('DELETE FROM conversations WHERE character_id = ?', id);
    run('DELETE FROM messages WHERE character_id = ?', id);
    run('DELETE FROM memories WHERE character_id = ?', id);
    run('DELETE FROM memory_links WHERE a IN (SELECT id FROM memories WHERE character_id = ?) OR b IN (SELECT id FROM memories WHERE character_id = ?)', id, id);
    run('DELETE FROM books WHERE character_id = ?', id);
    run('DELETE FROM portraits WHERE character_id = ?', id);
    run('DELETE FROM changelogs WHERE character_id = ?', id);
    run('DELETE FROM diary_locks WHERE character_id = ?', id);
    run('DELETE FROM wait_states WHERE character_id = ?', id);
    run('DELETE FROM intimacy_log WHERE character_id = ?', id);
    run('DELETE FROM character_settings WHERE character_id = ?', id);
    run('DELETE FROM character_state WHERE character_id = ?', id);
    run('DELETE FROM characters WHERE id = ?', id);
  });
  return true;
}

export function updateState(characterId, patch) {
  const state = get('SELECT * FROM character_state WHERE character_id = ?', characterId);
  if (!state) return null;
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined) continue;
    const col = {
      motion: 'motion', psychology: 'psychology', mood: 'mood', health: 'health',
      sleepState: 'sleep_state', chatCount: 'chat_count', intimacy: 'intimacy',
      lastPortraitAt: 'last_portrait_at', chatSincePortrait: 'chat_count_since_portrait',
    }[k] || k;
    sets.push(`${col} = ?`);
    vals.push(v);
  }
  sets.push('updated_at = ?');
  vals.push(nowIso());
  run(`UPDATE character_state SET ${sets.join(', ')} WHERE character_id = ?`, ...vals, characterId);
  return get('SELECT * FROM character_state WHERE character_id = ?', characterId);
}

export function defaultCharacterId(userId) {
  const row = get('SELECT id FROM characters WHERE user_id = ? AND archived = 0 ORDER BY created_at ASC LIMIT 1', userId);
  return row?.id || null;
}

/**
 * 角色日记密码（每日随机 6 位）
 * - 对外只返回线索与哈希校验结果；密码原文加密存放在 diary_locks.code，仅供角色上下文使用
 * - 旧锁没有 code 列内容时保持原样，只给线索，重建密码会让已记住的答案失效
 */
export function ensureDiaryLock(characterId, userId) {
  const day = dayKey();
  const existing = get('SELECT * FROM diary_locks WHERE character_id = ? AND day = ?', characterId, day);
  if (existing) {
    return {
      day,
      fresh: false,
      hint: existing.hint ? decryptText(userId, existing.hint) : '',
      code: readDiaryCode(userId, existing),
    };
  }
  const code = String(randomInt(100000, 999999));
  const { hash, salt } = hashPassword(code);
  const digits = code.split('').map(Number);
  const sum = digits.reduce((a, b) => a + b, 0);
  const even = digits.filter((d) => d % 2 === 0).length;
  const hints = [
    `六个数位加起来是 ${sum}，你慢慢算`,
    `里面藏着 ${even} 个偶数，剩下的都是奇数`,
    `第一位比最后一位${digits[0] > digits[5] ? '大' : '小'}，中间两位是一对`,
    `把它倒过来念，会比原来${Number(code.split('').reverse().join('')) > Number(code) ? '大' : '小'}`,
    `今天它和我说的某句话押韵，共六个音`,
    `它比 ${Number(code.slice(0, 2)) * 10000} 大，比 ${(Number(code.slice(0, 2)) + 1) * 10000} 小`,
  ];
  const hint = hints[randomInt(0, hints.length - 1)];
  run(
    'INSERT INTO diary_locks(character_id, day, hash, salt, hint, created_at, code) VALUES(?,?,?,?,?,?,?)',
    characterId,
    day,
    hash,
    salt,
    encryptText(userId, hint),
    nowIso(),
    encryptText(userId, code),
  );
  return { day, fresh: true, hint, code };
}

function readDiaryCode(userId, row) {
  if (!row?.code) return '';
  try {
    return decryptText(userId, row.code);
  } catch {
    return '';
  }
}

/** 当日日记密码原文（仅服务端内部/角色上下文使用，绝不返回客户端） */
export function getDiaryCode(characterId, userId) {
  const row = get('SELECT * FROM diary_locks WHERE character_id = ? AND day = ?', characterId, dayKey());
  return readDiaryCode(userId, row);
}

export function verifyDiaryPassword(characterId, day, password) {
  const row = get('SELECT * FROM diary_locks WHERE character_id = ? AND day = ?', characterId, day);
  if (!row) return { ok: false, reason: 'lock_missing' };
  return { ok: verifyPassword(String(password), row.hash, row.salt), row };
}
