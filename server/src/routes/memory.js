// 记忆接口（v1.5）：四层网状图（稳定三维坐标）、记忆详情/删除、语义检索、自动抽取偏好
// 全部按 userId + characterId 隔离；日记密码永不经由任何接口返回。
import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler, badRequest, notFound } from '../core/errors.js';
import { getCharacter, defaultCharacterId } from '../services/characters.js';
import { savePrefs } from '../services/settings.js';
import {
  buildGraph,
  memoryDetail,
  deleteMemory,
  searchMemories,
  autoMemoryEnabled,
  RELATED_THRESHOLD,
} from '../ai/memory.js';

function resolveCharacter(req) {
  const requested = String(req.query.characterId || req.body?.characterId || '').trim();
  const characterId = requested || defaultCharacterId(req.userId);
  if (!characterId) throw badRequest('请先创建角色，或提供 characterId', 'character_required');
  const character = getCharacter(req.userId, characterId);
  if (!character) throw notFound('角色不存在', 'character_not_found');
  return character;
}

export default function register() {
  const r = Router();
  r.use(requireAuth);

  // 网状图：agent -> 大类目 -> 小类目 -> 记忆点
  // 节点附带稳定 x/y/z、level、weight、glow（已按图质心居中），旧字段保持兼容。
  r.get(
    '/graph',
    asyncHandler(async (req, res) => {
      const character = resolveCharacter(req);
      const graph = buildGraph(req.userId, character.id, character.name);
      res.json({
        character: { id: character.id, name: character.name },
        ...graph,
      });
    }),
  );

  // 语义检索：有嵌入服务用 cosine（相关性阈值 0.35），无 key 退化为关键词匹配
  r.get(
    '/search',
    asyncHandler(async (req, res) => {
      const character = resolveCharacter(req);
      const q = String(req.query.q ?? req.query.query ?? '').trim();
      if (!q) throw badRequest('缺少检索关键词 q', 'query_required');
      const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
      const rawThreshold = Number(req.query.threshold);
      const threshold = Number.isFinite(rawThreshold) ? Math.min(0.99, Math.max(0, rawThreshold)) : RELATED_THRESHOLD;
      const result = await searchMemories(req.userId, character.id, q, { limit, threshold });
      res.json({ characterId: character.id, ...result, threshold });
    }),
  );

  // 用户特征自动抽取偏好（prefs.autoMemory，默认 true）
  r.get(
    '/preferences',
    asyncHandler(async (req, res) => {
      res.json({ autoMemory: autoMemoryEnabled(req.userId) });
    }),
  );

  r.put(
    '/preferences',
    asyncHandler(async (req, res) => {
      const value = req.body?.autoMemory;
      if (typeof value !== 'boolean') throw badRequest('autoMemory 必须是布尔值', 'invalid_pref');
      savePrefs(req.userId, { autoMemory: value });
      res.json({ autoMemory: autoMemoryEnabled(req.userId) });
    }),
  );

  // 记忆详情：创建时间、大小类目、内容、情绪、访问情况、关联记忆
  r.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const detail = memoryDetail(req.userId, req.params.id);
      if (!detail) throw notFound('记忆不存在', 'memory_not_found');
      res.json({ memory: detail });
    }),
  );

  r.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const ok = deleteMemory(req.userId, req.params.id);
      if (!ok) throw notFound('记忆不存在', 'memory_not_found');
      res.json({ ok: true, id: req.params.id });
    }),
  );

  return r;
}
