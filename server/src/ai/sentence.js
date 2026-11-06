// 句子完整性检查（build.md 二.4）
// 文字消息先交给后台模型判断：强制非思考模式、temperature 0、只允许 yes/no 且无标点。
// 判定为 no → 等待 30 秒（新消息到达即取消）；判定为 yes 或判定失败 → 直接生成回复。
import * as defaultProvider from './provider.js';

// v1.5.0：连续碎片最多等待 6 秒（从第一条未完成消息起算），新消息到达重置/取消
export const SENTENCE_WAIT_MS = 6_000;
export const SENTENCE_MAX_WAIT_MS = 6_000;
export const SENTENCE_MAX_TOKENS = 4;

/**
 * 同一段连续输入的等待上限：从第一条未完成消息起算最多等 6s；新消息沿用同一 firstAt。
 * @returns {number} 毫秒时间戳
 */
export function sentenceWaitDueMs({ now = Date.now(), firstAt = null } = {}) {
  const start = Number(firstAt) > 0 ? Number(firstAt) : Number(now);
  return Math.min(Number(now) + SENTENCE_WAIT_MS, start + SENTENCE_MAX_WAIT_MS);
}

export const SENTENCE_SYSTEM_PROMPT = [
  '你是句子完整性判断器，只做一件事：判断用户这句话是否已经表达完整、可以自然地结束（不需要用户继续补充）。',
  '判定标准：',
  '- 语义完整、能独立成句 → yes',
  '- 明显说到一半、缺少宾语/谓语、以“的/了/和/然后/就是”等悬空收尾 → no',
  '输出规则（必须严格遵守）：',
  '- 只允许输出一个单词：yes 或 no，全部小写',
  '- 不允许任何标点、空格、换行、解释、代码块或多余文字',
].join('\n');

/** 清洗判定结果：容忍 "Yes."、"```text\nyes\n```"、多余空白等噪声 */
export function cleanVerdict(raw) {
  const s = String(raw ?? '').toLowerCase();
  if (!s.trim()) return null;
  // 去掉代码块围栏后按非字母切词，取第一个 yes/no 单词
  const stripped = s.replace(/```[a-z]*/g, ' ').replace(/[^a-z]+/g, ' ').trim();
  if (!stripped) return null;
  const tokens = stripped.split(/\s+/);
  for (const token of tokens) {
    if (token === 'yes') return 'yes';
    if (token === 'no') return 'no';
  }
  // 兼容 "yes." "no!" 等附着标点已被切词处理；再兜底首词前缀
  if (/^yes/.test(stripped)) return 'yes';
  if (/^no/.test(stripped)) return 'no';
  return null;
}

/**
 * @returns {Promise<{complete:boolean, verdict:'yes'|'no', failed:boolean, raw:string, error?:string}>}
 * 判定失败按 yes 处理（build.md：失败时直接生成，避免用户被永久挂起）。
 */
export async function checkSentenceComplete(userId, text, { provider = defaultProvider, model = null } = {}) {
  const content = String(text ?? '').trim();
  if (!content) return { complete: true, verdict: 'yes', failed: false, raw: '' };
  try {
    const res = await provider.chatText(userId, {
      task: 'sentence',
      ...(model ? { model } : {}),
      temperature: 0,
      maxTokens: SENTENCE_MAX_TOKENS,
      thinking: false,
      messages: [
        { role: 'system', content: SENTENCE_SYSTEM_PROMPT },
        { role: 'user', content: `用户句子：\n"""${content}"""` },
      ],
    });
    const verdict = cleanVerdict(res?.text);
    if (!verdict) {
      return { complete: true, verdict: 'yes', failed: true, raw: String(res?.text ?? '') };
    }
    return { complete: verdict === 'yes', verdict, failed: false, raw: String(res.text ?? '') };
  } catch (err) {
    return {
      complete: true,
      verdict: 'yes',
      failed: true,
      raw: '',
      error: err?.message || 'sentence_check_failed',
    };
  }
}

/** 纯文本消息（或语音转写结果）才需要做完整性检查；纯图片描述不需要 */
export function needsSentenceCheck({ kind = 'text', text = '', hasTranscript = false } = {}) {
  if (String(text || '').trim()) return true;
  if (kind === 'voice' && hasTranscript) return true;
  return false;
}

export default { checkSentenceComplete, cleanVerdict, needsSentenceCheck, sentenceWaitDueMs, SENTENCE_WAIT_MS, SENTENCE_MAX_WAIT_MS };
