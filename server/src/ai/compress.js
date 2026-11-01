// 上下文压缩（build.md 一.3 / 二 压缩提示语）
// 达到 85% 占用时，在本次回复完成后执行：
//   - 早期消息交给模型摘要，写入 conversations.summary
//   - 保留最近 keepRecent 条未摘要消息
//   - 摘要失败（无 key / 模型异常）时用本地拼接摘要降级，保证压缩链路不阻塞
import { all, get, run, tx } from '../db/index.js';
import { encryptText, encryptJson, decryptText, decryptJson } from '../core/crypto.js';
import { nowIso } from '../core/util.js';
import { recordUsage } from './usage.js';
import { refreshConversationUsage, COMPRESS_THRESHOLD } from './context.js';
import * as defaultProvider from './provider.js';
import logger from '../core/logger.js';

export const SUMMARY_MARKER = '记忆压缩器';
export const KEEP_RECENT_DEFAULT = 12;
const TRANSCRIPT_LIMIT = 12_000;
const SUMMARY_LIMIT = 6_000;

const SUMMARY_SYSTEM_PROMPT = [
  `你是${SUMMARY_MARKER}。请把下面这段「用户与角色的历史对话」压缩成一段可供角色长期记住的记忆摘要。`,
  '要求：',
  '1. 用第三人称中文叙述，保留人物关系、用户偏好/雷点、承诺、重要事件与情绪变化；',
  '2. 删除寒暄与重复内容，不要杜撰；',
  '3. 200-400 字，只输出摘要正文，不要 JSON、标题或解释。',
].join('\n');

export function shouldCompress(info, threshold = COMPRESS_THRESHOLD) {
  if (!info) return false;
  const ratio = Number(info.ratio ?? (info.limit > 0 ? info.used / info.limit : 0));
  return Number(info.limit) > 0 && ratio >= threshold;
}

function safeDecrypt(userId, blob) {
  try {
    return decryptText(userId, blob);
  } catch {
    return '';
  }
}

function roleLabel(role) {
  if (role === 'user') return '用户';
  if (role === 'agent') return '角色';
  return '系统';
}

/** 模型不可用时的本地摘要：按时间拼接早期消息，截断到合理长度 */
export function localSummary(userId, rows) {
  const lines = [];
  for (const row of rows) {
    const content = safeDecrypt(userId, row.content).replace(/\s+/g, ' ').trim();
    if (!content) continue;
    lines.push(`${roleLabel(row.role)}：${content.length > 160 ? content.slice(0, 160) + '…' : content}`);
  }
  const text = lines.join('\n');
  return text.length > 2000 ? text.slice(0, 1000) + '\n…\n' + text.slice(-1000) : text;
}

/**
 * 压缩会话上下文。
 * @returns {Promise<{ok:boolean, compressed:boolean, summary?:string, kept?:number, dropped?:number, model?:string, reason?:string}>}
 */
export async function compressConversation({
  userId,
  characterId,
  conversationId,
  keepRecent = KEEP_RECENT_DEFAULT,
  provider = defaultProvider,
} = {}) {
  const conv = get('SELECT * FROM conversations WHERE id = ?', conversationId);
  if (!conv) return { ok: false, compressed: false, reason: 'conversation_not_found' };

  const rows = all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC', conversationId);
  const pending = [];
  for (const row of rows) {
    const meta = row.meta ? decryptJson(userId, row.meta, null) : null;
    if (meta && meta.summarized) continue;
    pending.push(row);
  }
  const keep = (() => {
    let k = Math.max(2, Math.min(Number(keepRecent) || KEEP_RECENT_DEFAULT, Math.max(2, pending.length)));
    if (pending.length > 1 && pending.length - k <= 0) k = pending.length - 1;
    return Math.max(1, k);
  })();
  const older = pending.length > keep ? pending.slice(0, pending.length - keep) : [];
  const previousSummary = conv.summary ? safeDecrypt(userId, conv.summary) : '';

  if (!older.length) {
    const used = refreshConversationUsage(conversationId);
    return {
      ok: true,
      compressed: false,
      summary: previousSummary,
      kept: pending.length,
      dropped: 0,
      used,
      reason: 'nothing_to_compress',
    };
  }

  const transcript = older
    .map((row) => `${roleLabel(row.role)}：${safeDecrypt(userId, row.content)}`)
    .join('\n')
    .slice(-TRANSCRIPT_LIMIT);

  let summaryText = '';
  let model = 'local';
  try {
    const res = await provider.chatText(userId, {
      task: 'main',
      temperature: 0.3,
      maxTokens: 700,
      thinking: false,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: transcript },
      ],
    });
    summaryText = String(res?.text ?? '').trim();
    model = res?.model || 'unknown';
    recordUsage({ userId, characterId, kind: 'compress', model, usage: res?.usage || {}, cost: res?.cost });
    if (!summaryText) throw new Error('模型返回空摘要');
  } catch (err) {
    summaryText = localSummary(userId, older);
    model = 'local';
    logger.warn('上下文压缩降级为本地摘要', err?.message || err);
  }

  const combined = [previousSummary, summaryText].filter(Boolean).join('\n\n');
  const trimmed = combined.length > SUMMARY_LIMIT ? combined.slice(-SUMMARY_LIMIT) : combined;

  const now = nowIso();
  run(
    'UPDATE conversations SET summary = ?, compressed_at = ?, updated_at = ? WHERE id = ?',
    encryptText(userId, trimmed),
    now,
    now,
    conversationId,
  );
  tx(() => {
    for (const row of older) {
      const meta = row.meta ? decryptJson(userId, row.meta, {}) || {} : {};
      meta.summarized = true;
      run('UPDATE messages SET meta = ? WHERE id = ?', encryptJson(userId, meta), row.id);
    }
  });

  const used = refreshConversationUsage(conversationId);
  return {
    ok: true,
    compressed: true,
    summary: trimmed,
    kept: keep,
    dropped: older.length,
    model,
    used,
  };
}

export default { compressConversation, shouldCompress, localSummary, SUMMARY_MARKER };
