// 记忆接口：四层网状图、记忆详情/删除、语义检索（全部按 userId + characterId 隔离）
import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler, badRequest, notFound } from '../core/errors.js';
import { getCharacter, defaultCharacterId } from '../services/characters.js';
import { buildGraph, memoryDetail, deleteMemory, searchMemories } from '../ai/memory.js';

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

  // 语义检索：有嵌入服务用 cosine，无 key 退化为关键词匹配
  r.get(
    '/search',
    asyncHandler(async (req, res) => {
      const character = resolveCharacter(req);
      const q = String(req.query.q ?? req.query.query ?? '').trim();
      if (!q) throw badRequest('缺少检索关键词 q', 'query_required');
      const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
      const result = await searchMemories(req.userId, character.id, q, { limit });
      res.json({ characterId: character.id, ...result });
    }),
  );

  // 记忆详情：创建时间、大小类目、内容、关联记忆
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
