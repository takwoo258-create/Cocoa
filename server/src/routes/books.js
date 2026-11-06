// 书架接口：小说/文集/日记/浏览记录；日记正文需当日 6 位密码（密码只存哈希，接口永不回传）
import { Router } from 'express';
import { all, get, run } from '../db/index.js';
import { encryptText, encryptJson, decryptText, decryptJson } from '../core/crypto.js';
import { nowIso, uuid, dayKey, truncate } from '../core/util.js';
import { AppError, asyncHandler, badRequest, notFound, tooMany } from '../core/errors.js';
import { rateLimit } from '../core/ratelimit.js';
import { requireAuth } from '../auth/middleware.js';
import {
  getCharacter,
  defaultCharacterId,
  ensureDiaryLock,
  verifyDiaryPassword,
} from '../services/characters.js';
import { enqueue } from '../services/jobs.js';
import { sanitizeCreation } from '../ai/creation.js';

const BOOK_TYPES = ['novel', 'diary', 'essay', 'news'];
const MANUAL_TYPES = ['novel', 'essay'];

function safeDec(userId, blob) {
  try {
    return decryptText(userId, String(blob ?? ''));
  } catch {
    return String(blob ?? '');
  }
}

function resolveCharacter(req) {
  const requested = String(req.query.characterId || req.body?.characterId || '').trim();
  const characterId = requested || defaultCharacterId(req.userId);
  if (!characterId) throw badRequest('请先创建角色，或提供 characterId', 'character_required');
  const character = getCharacter(req.userId, characterId);
  if (!character) throw notFound('角色不存在', 'character_not_found');
  return character;
}

function shapeBook(userId, row, { withContent = true, unlocked = false } = {}) {
  const meta = decryptJson(userId, row.meta, {}) || {};
  const out = {
    id: row.id,
    characterId: row.character_id,
    type: row.type,
    title: safeDec(userId, row.title),
    day: row.day,
    seriesId: row.series_id || null,
    sessionId: row.session_id || null,
    words: Number(meta.words || 0),
    chapter: Number(meta.chapter || 0) || null,
    short: Boolean(meta.short),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    meta,
    locked: row.type === 'diary' && !unlocked,
  };
  if (withContent) out.content = safeDec(userId, row.content);
  else if (row.type !== 'diary') out.excerpt = truncate(safeDec(userId, row.content).replace(/\s+/g, ' '), 140);
  else out.excerpt = null;
  return out;
}

/** 列表里的连载分组：小说/散文按 series_id 聚合章节数 */
function seriesSummary(items) {
  const map = new Map();
  for (const it of items) {
    if (!it.seriesId || it.type === 'diary' || it.type === 'news') continue;
    const cur = map.get(it.seriesId) || { seriesId: it.seriesId, type: it.type, count: 0, latestAt: '', title: it.title };
    cur.count += 1;
    if (!cur.latestAt || it.createdAt > cur.latestAt) {
      cur.latestAt = it.createdAt;
      cur.title = it.title;
    }
    map.set(it.seriesId, cur);
  }
  return [...map.values()].sort((a, b) => b.latestAt.localeCompare(a.latestAt));
}

function currentHint(userId, characterId, day) {
  const row = get('SELECT hint FROM diary_locks WHERE character_id = ? AND day = ?', characterId, day);
  return row?.hint ? safeDec(userId, row.hint) : '';
}

function findBookForDay(userId, characterId, day) {
  return get(
    "SELECT * FROM books WHERE user_id = ? AND character_id = ? AND type = 'diary' AND day = ? ORDER BY created_at DESC LIMIT 1",
    userId,
    characterId,
    day,
  );
}

function findDiaryLockRow(characterId, day) {
  return get('SELECT * FROM diary_locks WHERE character_id = ? AND day = ?', characterId, day);
}

export default function register() {
  const r = Router();
  r.use(requireAuth);

  // 列表：不含日记正文与未解锁内容
  r.get(
    '/',
    asyncHandler(async (req, res) => {
      const character = resolveCharacter(req);
      const type = String(req.query.type || '').trim();
      if (type && !BOOK_TYPES.includes(type)) throw badRequest('type 只能是 novel/diary/essay/news', 'type_invalid');
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
      const seriesId = String(req.query.seriesId || '').trim();
      const where = ['user_id = ?', 'character_id = ?'];
      const params = [req.userId, character.id];
      if (type) {
        where.push('type = ?');
        params.push(type);
      }
      if (seriesId) {
        where.push('series_id = ?');
        params.push(seriesId);
      }
      const rows = all(
        `SELECT * FROM books WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
        ...params,
        limit,
      );
      const items = rows.map((row) => shapeBook(req.userId, row, { withContent: false }));
      const counts = {};
      for (const it of items) counts[it.type] = (counts[it.type] || 0) + 1;
      res.json({ characterId: character.id, items, counts, series: seriesSummary(items), total: items.length });
    }),
  );

  // 日记锁状态（只返回线索，不返回密码）
  r.get(
    '/diary/lock-status',
    asyncHandler(async (req, res) => {
      const character = resolveCharacter(req);
      const today = dayKey();
      const diary = findBookForDay(req.userId, character.id, today);
      const lockRow = findDiaryLockRow(character.id, today);
      let hint = '';
      if (diary || lockRow) hint = ensureDiaryLock(character.id, req.userId).hint || '';
      res.json({
        characterId: character.id,
        locked: Boolean(diary),
        day: today,
        hint,
        hasDiary: Boolean(diary),
        diaryId: diary?.id || null,
      });
    }),
  );

  // 日记解锁：校验当日密码并返回当日日记正文
  r.post(
    '/diary/unlock',
    asyncHandler(async (req, res) => {
      const character = resolveCharacter(req);
      const password = String(req.body?.password ?? '').trim();
      if (!/^\d{6}$/.test(password)) throw badRequest('请输入 6 位数字密码', 'diary_password_format');
      const limit = rateLimit({ key: `diary:${req.userId}:${character.id}`, limit: 8, windowMs: 60_000 });
      if (!limit.ok) throw tooMany('尝试次数过多，请一分钟后再试', 'diary_locked_temp');

      const today = dayKey();
      let lockRow = findDiaryLockRow(character.id, today);
      if (!lockRow) {
        const latest = get(
          "SELECT day FROM books WHERE user_id = ? AND character_id = ? AND type = 'diary' ORDER BY created_at DESC LIMIT 1",
          req.userId,
          character.id,
        );
        if (latest?.day) lockRow = findDiaryLockRow(character.id, latest.day);
      }
      if (!lockRow) throw badRequest('这本日记还没有上锁，先让角色写一篇吧', 'diary_lock_missing');

      const verdict = verifyDiaryPassword(character.id, lockRow.day, password);
      if (!verdict.ok) {
        if (verdict.reason === 'lock_missing') throw badRequest('这本日记还没有上锁，先让角色写一篇吧', 'diary_lock_missing');
        throw badRequest('密码不对哦，再想想看？', 'diary_password_invalid');
      }

      const diary = findBookForDay(req.userId, character.id, lockRow.day);
      if (!diary) throw notFound('这一天的日记还没有写下', 'diary_missing');
      res.json({
        ok: true,
        characterId: character.id,
        day: lockRow.day,
        hint: currentHint(req.userId, character.id, lockRow.day),
        diary: shapeBook(req.userId, diary, { unlocked: true }),
      });
    }),
  );

  // 手动创作：带正文直接入库；不带正文则排队交给角色生成
  r.post(
    '/',
    asyncHandler(async (req, res) => {
      const character = resolveCharacter(req);
      const type = String(req.body?.type || '').trim();
      if (!BOOK_TYPES.includes(type)) throw badRequest('type 只能是 novel/diary/essay/news', 'type_invalid');
      if (!MANUAL_TYPES.includes(type)) {
        throw badRequest('日记与浏览记录由角色自动生成，手动创作仅支持 novel/essay', 'type_manual_unsupported');
      }
      const rawContent = String(req.body?.content || '').trim();
      const tags = Array.isArray(req.body?.tags) ? req.body.tags.map((t) => String(t)).slice(0, 8) : [];

      const seriesId = String(req.body?.seriesId || '').trim() || null;
      if (!rawContent) {
        const jobId = enqueue(
          'creation',
          new Date(),
          { characterId: character.id, type, force: true, tags, seriesId },
          { userId: req.userId, characterId: character.id },
        );
        return res.status(202).json({ queued: true, jobId, type, characterId: character.id, seriesId });
      }

      const safe = sanitizeCreation(rawContent);
      const title = String(req.body?.title || '').trim() || truncate(safe.text.replace(/\s+/g, ' '), 18) || '无题';
      const day = dayKey();
      const id = `bk_${uuid().replace(/-/g, '').slice(0, 16)}`;
      const now = nowIso();
      const chapter = seriesId
        ? Number(get('SELECT COUNT(*) n FROM books WHERE user_id = ? AND character_id = ? AND series_id = ?', req.userId, character.id, seriesId)?.n || 0) + 1
        : null;
      run(
        `INSERT INTO books(id, user_id, character_id, type, title, content, day, meta, series_id, session_id, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,NULL,?,?)`,
        id,
        req.userId,
        character.id,
        type,
        encryptText(req.userId, title.slice(0, 60)),
        encryptText(req.userId, safe.text),
        day,
        encryptJson(req.userId, { manual: true, tags, words: safe.text.length, filtered: safe.filtered, chapter }),
        seriesId,
        now,
        now,
      );
      const row = get('SELECT * FROM books WHERE id = ? AND user_id = ?', id, req.userId);
      res.status(201).json({ book: shapeBook(req.userId, row) });
    }),
  );

  // 详情：日记需 password 查询参数（或先调用 unlock）
  r.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const row = get('SELECT * FROM books WHERE id = ? AND user_id = ?', req.params.id, req.userId);
      if (!row) throw notFound('内容不存在', 'book_not_found');

      if (row.type === 'diary') {
        const password = String(req.query.password ?? '').trim();
        const day = row.day || dayKey();
        if (!password) {
          throw new AppError(401, 'diary_locked', '日记本已上锁，请先输入 6 位密码', {
            day,
            hint: currentHint(req.userId, row.character_id, day),
          });
        }
        if (!/^\d{6}$/.test(password)) throw badRequest('请输入 6 位数字密码', 'diary_password_format');
        const attempt = rateLimit({ key: `diary-detail:${req.userId}:${row.character_id}`, limit: 8, windowMs: 60_000 });
        if (!attempt.ok) throw tooMany('尝试次数过多，请一分钟后再试', 'diary_locked_temp');
        if (!findDiaryLockRow(row.character_id, day)) ensureDiaryLock(row.character_id, req.userId);
        const verdict = verifyDiaryPassword(row.character_id, day, password);
        if (!verdict.ok) throw badRequest('密码不对哦，再想想看？', 'diary_password_invalid');
      }
      res.json({ book: shapeBook(req.userId, row, { unlocked: row.type === 'diary' }) });
    }),
  );

  return r;
}
