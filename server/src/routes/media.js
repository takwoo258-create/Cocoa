// 媒体路由：图片/语音/头像上传与鉴权下载（单文件 ≤ 20MB）
import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler, badRequest, notFound, forbidden, AppError } from '../core/errors.js';
import { get, run } from '../db/index.js';
import { nowIso, uuid, dayKey } from '../core/util.js';
import env from '../env.js';
import { getCharacter } from '../services/characters.js';

const MAX_SIZE = 20 * 1024 * 1024;

const IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/heic',
  'image/heif',
]);
const AUDIO_MIMES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/opus',
  'audio/webm',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/amr',
  'audio/3gpp',
  'audio/flac',
]);
const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/webm': '.webm',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/amr': '.amr',
  'audio/3gpp': '.3gp',
  'audio/flac': '.flac',
};
const KINDS = new Set(['image', 'voice', 'avatar']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE, files: 1, fields: 20 },
});

function runUpload(req, res) {
  return new Promise((resolve, reject) => {
    upload.single('file')(req, res, (err) => {
      if (!err) return resolve();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return reject(new AppError(413, 'media_too_large', '媒体文件不得超过 20MB'));
      }
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        return reject(badRequest('一次只能上传一个文件，字段名需为 file', 'media_field_invalid'));
      }
      return reject(badRequest(err.message || '上传失败', 'media_upload_failed'));
    });
  });
}

function resolveKind(rawKind, mime) {
  const kind = KINDS.has(String(rawKind)) ? String(rawKind) : mime.startsWith('audio/') ? 'voice' : 'image';
  if (kind === 'voice' && !AUDIO_MIMES.has(mime)) throw badRequest('语音文件需为音频格式（mp3/wav/ogg/m4a/amr 等）', 'media_mime_invalid');
  if ((kind === 'image' || kind === 'avatar') && !IMAGE_MIMES.has(mime)) {
    throw badRequest('图片文件需为 jpg/png/gif/webp 等常见图片格式', 'media_mime_invalid');
  }
  return kind;
}

function mediaPathFor(row) {
  const abs = path.resolve(env.mediaDir, row.path);
  const root = path.resolve(env.mediaDir) + path.sep;
  return abs.startsWith(root) ? abs : null;
}

/** 供其他模块（对话链路）按 id 取媒体；失败返回 null */
export function resolveMedia(userId, id, { characterId = null } = {}) {
  const row = get('SELECT * FROM media WHERE id = ?', String(id || ''));
  if (!row || row.user_id !== userId) return null;
  if (characterId && row.character_id && row.character_id !== characterId) return null;
  const abs = mediaPathFor(row);
  if (!abs || !fs.existsSync(abs)) return null;
  return { ...row, absPath: abs, url: `/api/media/${row.id}` };
}

function shapeMedia(row) {
  return {
    id: row.id,
    url: `/api/media/${row.id}`,
    mime: row.mime,
    size: row.size,
    kind: row.kind,
    characterId: row.character_id || null,
    createdAt: row.created_at,
  };
}

export default function register() {
  const r = Router();
  r.use(requireAuth);

  r.post(
    '/',
    asyncHandler(async (req, res) => {
      await runUpload(req, res);
      const file = req.file;
      if (!file || !file.buffer?.length) throw badRequest('请选择要上传的文件（字段名 file）', 'media_file_required');

      const mime = String(file.mimetype || '').toLowerCase();
      if (!IMAGE_MIMES.has(mime) && !AUDIO_MIMES.has(mime)) {
        throw badRequest('仅支持图片（image/*）与音频（audio/*）', 'media_mime_invalid');
      }
      const kind = resolveKind(req.body?.kind, mime);

      const characterId = req.body?.characterId ? String(req.body.characterId) : null;
      if (characterId) {
        const character = getCharacter(req.userId, characterId, { includeArchived: true });
        if (!character) throw notFound('角色不存在或不属于当前账号', 'character_not_found');
      }

      const id = `md_${uuid().replace(/-/g, '').slice(0, 16)}`;
      const sub = dayKey();
      const dir = path.join(env.mediaDir, sub);
      fs.mkdirSync(dir, { recursive: true });
      const ext = EXT_BY_MIME[mime] || '.bin';
      const fileName = `${id}${ext}`;
      const absPath = path.join(dir, fileName);
      fs.writeFileSync(absPath, file.buffer, { mode: 0o600 });
      const relPath = `${sub}/${fileName}`;
      const createdAt = nowIso();
      const size = file.size || file.buffer.length;

      run(
        'INSERT INTO media(id, user_id, character_id, kind, path, mime, size, created_at) VALUES(?,?,?,?,?,?,?,?)',
        id,
        req.userId,
        characterId,
        kind,
        relPath,
        mime,
        size,
        createdAt,
      );

      res.status(201).json({ id, url: `/api/media/${id}`, mime, size, kind, characterId, createdAt });
    }),
  );

  r.get('/:id', (req, res) => {
    const row = get('SELECT * FROM media WHERE id = ?', String(req.params.id));
    if (!row) throw notFound('媒体不存在', 'media_not_found');
    if (row.user_id !== req.userId) throw forbidden('无权访问该媒体', 'media_forbidden');
    const abs = mediaPathFor(row);
    if (!abs) throw notFound('媒体不存在', 'media_not_found');
    if (!fs.existsSync(abs)) throw notFound('媒体文件已丢失', 'media_missing');
    res.setHeader('Content-Type', row.mime || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.sendFile(abs);
  });

  return r;
}
