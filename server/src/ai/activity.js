// 角色运行开关（v1.5.0）：settings.enabled 缺省为 true。
// 关闭后角色不参与任何自动活动、不产生 token 消耗；scheduler 在入队与执行两处都会检查。
import { getCharacter, getSettings } from '../services/characters.js';

/** 角色是否处于运行状态（缺省 true；归档角色视为不可用） */
export function isCharacterActive(character) {
  if (!character) return false;
  if (character.archived) return false;
  const settings = character.settings || {};
  return settings.enabled !== false;
}

/** 按 id 读取（每次实时读 settings，不缓存，PUT 后立即生效） */
export function isCharacterIdActive(userId, characterId, { includeArchived = true } = {}) {
  if (!userId || !characterId) return false;
  const character = getCharacter(userId, characterId, { includeArchived });
  return isCharacterActive(character);
}

/** 调度器只有 characterId/userId 时使用（只解密 settings） */
export function isCharacterActiveById(userId, characterId) {
  if (!userId || !characterId) return false;
  try {
    const settings = getSettings(characterId, userId);
    return settings?.enabled !== false;
  } catch {
    return false;
  }
}

/** 关闭运行时的固定提示（不调用模型、不产生 usage） */
export function disabledNotice(name) {
  const who = String(name || '这个角色');
  return `「${who}」现在暂停运行啦，稍后再来找 TA 说话吧。`;
}

export default { isCharacterActive, isCharacterIdActive, isCharacterActiveById, disabledNotice };
