// 生图：调用 image 服务生成图片并落媒体库（kind=image）
import fs from 'node:fs';
import path from 'node:path';
import env from '../env.js';
import { run } from '../db/index.js';
import { nowIso, uuid, dayKey } from '../core/util.js';
import { badRequest } from '../core/errors.js';
import { generateImage } from './provider.js';

const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

/**
 * 生成一张图片并保存到媒体目录，登记 media 表。
 * 返回 { id, url, mime, size, kind, characterId, prompt, revisedPrompt, createdAt }
 */
export async function generateAndSaveImage(userId, { characterId = null, prompt, size, style, quality, n = 1, serviceConf = null } = {}) {
  const text = String(prompt || '').trim().slice(0, 4000);
  if (!text) throw badRequest('缺少画面描述', 'image_prompt_required');
  const items = await generateImage(userId, { prompt: text, size, style, quality, n, serviceConf });
  const first = items[0];
  if (!first?.buffer?.length) throw badRequest('生图服务没有返回图片', 'image_empty');

  const id = `md_${uuid().replace(/-/g, '').slice(0, 16)}`;
  const sub = dayKey();
  const dir = path.join(env.mediaDir, sub);
  fs.mkdirSync(dir, { recursive: true });
  const mime = first.mime || 'image/png';
  const ext = EXT_BY_MIME[mime] || '.png';
  const fileName = `${id}${ext}`;
  fs.writeFileSync(path.join(dir, fileName), first.buffer, { mode: 0o600 });
  const createdAt = nowIso();
  run(
    'INSERT INTO media(id, user_id, character_id, kind, path, mime, size, created_at) VALUES(?,?,?,?,?,?,?,?)',
    id,
    userId,
    characterId,
    'image',
    `${sub}/${fileName}`,
    mime,
    first.buffer.length,
    createdAt,
  );
  return {
    id,
    mediaId: id,
    url: `/api/media/${id}`,
    mime,
    size: first.buffer.length,
    kind: 'image',
    characterId,
    prompt: text,
    revisedPrompt: first.revisedPrompt || '',
    createdAt,
  };
}

export default { generateAndSaveImage };
