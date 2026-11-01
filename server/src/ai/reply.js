// 模型回复协议解析：容错提取 JSON、规范化分段/等待/主动消息字段，失败降级纯文本
//
// 协议（build.md 二.6 / docs/API.md §4）：
//   {"type":"message","content":"整段文本","devide":2,"agent":[{"content":"分段1","wait":2},{"content":"分段2","wait":0}]}
//   {"type":"profile","content":"人物画像文本"}
//   {"type":"status","motion":"","psychology":"","mood":"","health":""}
//   {"type":"subjective","content":"主动消息","sendsec":30}
//   {"type":"wakeup","wakeup":0|1}
// 约束：wait 取值 0-8 秒；仅智能体（agent）消息允许分段。

export const WAIT_MAX = 8;
export const WAIT_MIN = 0;
const TYPES = new Set(['message', 'profile', 'status', 'subjective', 'wakeup']);

function asText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

/** wait 秒数：0-8，四舍五入取整，非法值按 0 */
export function clampWait(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(WAIT_MIN, Math.min(WAIT_MAX, Math.round(n)));
}

/** sendsec 秒数：0-86400，保留整数；非法值按默认 60 */
export function clampSendSec(value, fallback = 60) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(86_400, Math.round(n));
}

/** 从 start 位置的 '{' 起找到配对的 '}'，跳过字符串内的括号；找不到返回 -1 */
export function matchBrace(text, start) {
  const s = String(text || '');
  if (s[start] !== '{') return -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function tryParseObject(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * 从模型输出中提取 JSON 对象：
 * 1) 整体就是 JSON；2) ```json / ``` 代码块；3) 前后噪声包裹的平衡括号对象。
 */
export function extractJson(text) {
  const raw = asText(text).trim();
  if (!raw) return null;
  const direct = tryParseObject(raw);
  if (direct) return direct;

  const fences = raw.matchAll(/```(?:json|JSON)?\s*([\s\S]*?)```/g);
  for (const f of fences) {
    const candidate = String(f[1] || '').trim();
    const parsed = tryParseObject(candidate);
    if (parsed) return parsed;
    const brace = candidate.indexOf('{');
    if (brace >= 0) {
      const end = matchBrace(candidate, brace);
      if (end > brace) {
        const inner = tryParseObject(candidate.slice(brace, end + 1));
        if (inner) return inner;
      }
    }
  }

  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '{') continue;
    const end = matchBrace(raw, i);
    if (end < 0) continue;
    const parsed = tryParseObject(raw.slice(i, end + 1));
    if (parsed) return parsed;
    i = end;
  }
  return null;
}

function normalizeSegmentsFromAgent(agent, content, segmentEnabled) {
  const items = Array.isArray(agent)
    ? agent
        .map((a) => ({ content: asText(a?.content).trim(), wait: clampWait(a?.wait) }))
        .filter((a) => a.content)
    : [];
  if (!items.length) return null;
  if (!segmentEnabled) {
    const joined = items.map((a) => a.content).join('');
    return [{ content: joined || content, wait: 0 }];
  }
  return items;
}

/** 仅当模型给出 devide+content（无 agent 数组）时，按空行/换行/句末尝试切分 */
function splitContentByDevide(content, devide, wait) {
  const text = asText(content).trim();
  const count = Math.max(1, Math.min(Number(devide) || 1, 12));
  if (count <= 1 || !text) return [{ content: text, wait: 0 }];
  let parts = text
    .split(/\n{2,}|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < count) {
    const sentenceParts = text
      .split(/(?<=[。！？!?…~～])/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (sentenceParts.length > parts.length) parts = sentenceParts;
  }
  if (parts.length <= 1) return [{ content: text, wait: 0 }];
  const groups = [];
  const per = Math.ceil(parts.length / count);
  for (let i = 0; i < parts.length; i += per) groups.push(parts.slice(i, i + per).join(''));
  return groups.slice(0, count).map((content2, idx) => ({ content: content2, wait: idx === 0 ? 0 : clampWait(wait) }));
}

/**
 * 规范化已经解析出的协议对象。
 * @returns {{type:'message'|'profile'|'status'|'subjective'|'wakeup',content:string,segments:Array,devide:number,wait:number,sendsec?:number,wakeup?:number,fields?:object}}
 */
export function normalizeReply(obj, { segmentEnabled = true, rawText = '' } = {}) {
  const src = obj && typeof obj === 'object' ? obj : {};
  const type = TYPES.has(String(src.type || '').toLowerCase()) ? String(src.type).toLowerCase() : 'message';
  const rawContent = asText(src.content).trim();
  const fallbackContent = rawContent || (type === 'message' ? asText(rawText).trim() : '');
  const devideRaw = Number(src.devide);
  const devide = Number.isFinite(devideRaw) && devideRaw > 1 ? Math.min(Math.round(devideRaw), 12) : 1;
  const topWait = clampWait(src.wait);

  if (type === 'profile') {
    return { type, content: fallbackContent, segments: [], devide: 1, wait: 0 };
  }

  if (type === 'status') {
    const fields = {
      motion: asText(src.motion).trim(),
      psychology: asText(src.psychology).trim(),
      mood: asText(src.mood).trim(),
      health: asText(src.health).trim(),
    };
    const flags = {};
    if (src.healthAbnormal !== undefined) flags.healthAbnormal = Boolean(src.healthAbnormal);
    if (src.moodAbnormal !== undefined) flags.moodAbnormal = Boolean(src.moodAbnormal);
    return { type, content: fallbackContent || JSON.stringify(fields), segments: [], devide: 1, wait: 0, fields, flags };
  }

  if (type === 'subjective') {
    return {
      type,
      content: fallbackContent,
      segments: [],
      devide: 1,
      wait: 0,
      sendsec: clampSendSec(src.sendsec, 60),
    };
  }

  if (type === 'wakeup') {
    const w = src.wakeup;
    const wakeup = w === 1 || w === '1' || w === true || String(w).toLowerCase() === 'true' ? 1 : 0;
    return { type, content: fallbackContent, segments: [], devide: 1, wait: 0, wakeup };
  }

  // message
  let segments = normalizeSegmentsFromAgent(src.agent, fallbackContent, segmentEnabled);
  if (!segments) segments = splitContentByDevide(fallbackContent, devide, topWait);
  const content = fallbackContent || segments.map((s) => s.content).join('');
  if (!segmentEnabled) segments = [{ content, wait: 0 }];
  return {
    type: 'message',
    content,
    segments,
    devide: segments.length,
    wait: topWait,
  };
}

/**
 * 解析模型原始输出。失败时降级为纯文本单段消息。
 * @returns 规范化结果 + {parsed, fallback}
 */
export function parseReply(text, { segmentEnabled = true } = {}) {
  const raw = asText(text);
  const obj = extractJson(raw);
  if (obj) {
    const normalized = normalizeReply(obj, { segmentEnabled, rawText: raw });
    return { ...normalized, parsed: true, fallback: false };
  }
  const plain = raw.trim();
  return {
    type: 'message',
    content: plain,
    segments: plain ? [{ content: plain, wait: 0 }] : [],
    devide: plain ? 1 : 0,
    wait: 0,
    parsed: false,
    fallback: true,
  };
}

/** 判断文本里是否带有可解析的协议对象（用于状态/唤醒等强类型场景） */
export function parseTypedReply(text, type) {
  const obj = extractJson(text);
  if (!obj) return null;
  const normalized = normalizeReply(obj);
  return normalized.type === type ? normalized : null;
}

export default { extractJson, parseReply, normalizeReply, parseTypedReply, clampWait, clampSendSec };
