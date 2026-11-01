// 语音测试路由：TTS / STT（挂载于 /api/config，需登录）
// TTS 结果落盘到媒体目录并登记 media（kind=voice），客户端可直接用 /api/media/:id 播放
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler, badRequest, AppError } from '../core/errors.js';
import { run } from '../db/index.js';
import { nowIso, uuid, dayKey } from '../core/util.js';
import env from '../env.js';
import { synthesize, transcribe } from '../ai/provider.js';
import { getUserApiRaw, DEFAULT_API } from '../services/settings.js';

const MAX_AUDIO_SIZE = 20 * 1024 * 1024;
const DEFAULT_TTS_TEXT = '你好呀，我是 Cocoa，这是一段语音合成测试。';
const TTS_TEXT_LIMIT = 500;
const SERVICE_LABEL = { tts: '语音合成', stt: '语音识别' };

/**
 * 配置前置检查：只填了默认 baseUrl（未填 key）视为未配置，直接 400，
 * 避免「点测试 → 等 60s 超时 → 502」这种体验。自建无鉴权端点填写了自定义 baseUrl 时放行。
 */
function ensureConfigured(userId, service) {
  const raw = getUserApiRaw(userId) || {};
  const conf = raw[service] || {};
  const defaultBase = String(DEFAULT_API[service]?.baseUrl || '');
  const customBase = Boolean(conf.baseUrl) && String(conf.baseUrl) !== defaultBase;
  if (!conf.apiKey && !customBase) {
    throw new AppError(
      400,
      'api_not_configured',
      `尚未配置「${SERVICE_LABEL[service]}」服务，请前往配置页填写 API Key 与地址`,
    );
  }
}

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
const AUDIO_EXT = {
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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_SIZE, files: 1, fields: 10 },
});

function runUpload(req, res) {
  return new Promise((resolve, reject) => {
    upload.single('file')(req, res, (err) => {
      if (!err) return resolve();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return reject(new AppError(413, 'audio_too_large', '音频文件不得超过 20MB'));
      }
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        return reject(badRequest('一次只能上传一个音频，字段名需为 file', 'audio_field_invalid'));
      }
      return reject(badRequest(err.message || '上传失败', 'audio_upload_failed'));
    });
  });
}

/** 保存 TTS 音频并登记 media；返回可直接访问的 url */
export function persistTtsAudio(userId, buffer, mime, { voice = '', model = '', characterId = null } = {}) {
  if (!buffer?.length) throw badRequest('语音内容为空', 'tts_empty_audio');
  const safeMime = AUDIO_MIMES.has(String(mime || '').toLowerCase()) ? String(mime).toLowerCase() : 'audio/mpeg';
  const id = `md_${uuid().replace(/-/g, '').slice(0, 16)}`;
  const sub = dayKey();
  const dir = path.join(env.mediaDir, sub);
  fs.mkdirSync(dir, { recursive: true });
  const ext = AUDIO_EXT[safeMime] || '.mp3';
  const fileName = `${id}${ext}`;
  fs.writeFileSync(path.join(dir, fileName), buffer, { mode: 0o600 });
  const size = buffer.length;
  run(
    'INSERT INTO media(id, user_id, character_id, kind, path, mime, size, created_at) VALUES(?,?,?,?,?,?,?,?)',
    id,
    userId,
    characterId,
    'voice',
    `${sub}/${fileName}`,
    safeMime,
    size,
    nowIso(),
  );
  return { id, url: `/api/media/${id}`, mime: safeMime, bytes: size, kind: 'voice', voice, model, createdAt: nowIso() };
}

export default function register() {
  const r = Router();
  r.use(requireAuth);

  // POST /api/config/test-tts {text?, voice?}
  r.post(
    '/test-tts',
    asyncHandler(async (req, res) => {
      const raw = req.body?.text;
      const inputText = typeof raw === 'string' ? raw.trim() : '';
      if (inputText.length > TTS_TEXT_LIMIT) {
        throw badRequest(`测试文本请控制在 ${TTS_TEXT_LIMIT} 字以内`, 'tts_text_too_long');
      }
      const text = inputText || DEFAULT_TTS_TEXT;
      const voice = req.body?.voice ? String(req.body.voice).trim().slice(0, 64) : undefined;
      ensureConfigured(req.userId, 'tts');

      // 未配置 TTS 时 provider 抛 400 api_not_configured（不是 500）
      const result = await synthesize(req.userId, text, { voice });
      const saved = persistTtsAudio(req.userId, result.buffer, result.mime, { voice: voice || '', model: result.model || '' });
      res.json({ ok: true, ...saved, provider: result.provider || '', text });
    }),
  );

  // POST /api/config/test-stt（multipart file，≤20MB，音频白名单）
  r.post(
    '/test-stt',
    asyncHandler(async (req, res) => {
      await runUpload(req, res);
      const file = req.file;
      if (!file || !file.buffer?.length) throw badRequest('请选择要识别的音频文件（字段名 file）', 'audio_required');
      const mime = String(file.mimetype || '').toLowerCase();
      if (!AUDIO_MIMES.has(mime)) {
        throw badRequest('仅支持音频文件（mp3/wav/ogg/m4a/amr 等）', 'audio_mime_invalid');
      }
      ensureConfigured(req.userId, 'stt');

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cocoa-stt-'));
      const tmpFile = path.join(tmpDir, `audio${AUDIO_EXT[mime] || '.wav'}`);
      fs.writeFileSync(tmpFile, file.buffer, { mode: 0o600 });
      try {
        // 未配置 STT 时 provider 抛 400 api_not_configured；上游异常为 502
        const result = await transcribe(req.userId, tmpFile, {
          language: req.body?.language ? String(req.body.language).slice(0, 8) : 'zh',
        });
        res.json({
          ok: true,
          text: String(result.text || ''),
          model: result.model || '',
          bytes: file.size || file.buffer.length,
          mime,
        });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }),
  );

  return r;
}
