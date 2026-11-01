// 新闻阅读：微博热搜 + RSS 多源，取前几条热门与几条不温不火，写感想入书架与当日上下文
import { XMLParser } from 'fast-xml-parser';
import { all, run } from '../db/index.js';
import { encryptText, encryptJson, decryptText } from '../core/crypto.js';
import { nowIso, uuid, dayKey, truncate } from '../core/util.js';
import logger from '../core/logger.js';
import { chatText } from './provider.js';
import { recordUsage } from './usage.js';
import { getCharacter, getSettings } from '../services/characters.js';
import {
  jobContext,
  limitState,
  promptText,
  parseJsonLoose,
  appendSystemMessage,
  cleanupSystemContext,
} from './memory.js';

const log = logger;

const WEIBO_ENDPOINTS = [
  'https://weibo.com/ajax/side/hotSearch',
  'https://weibo.com/ajax/statuses/hot_band',
];
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const NEWS_REFLECT_FALLBACK = `你是角色的扮演者。阅读今天挑出来的几条新闻，以角色口吻写一段 80-150 字的感想，可以联系自己的生活与用户，不要复述新闻全文，不要评论政治敏感细节。
只输出 JSON：{"content":"感想"}。`;

function stripHtml(input) {
  return String(input ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d) || 32))
    .replace(/\s+/g, ' ')
    .trim();
}

function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (Array.isArray(value)) return textOf(value[0]);
  if (typeof value === 'object') return textOf(value['#text'] ?? value.__cdata ?? value.value ?? '');
  return '';
}

function linkOf(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return linkOf(value[0]);
  if (typeof value === 'object') {
    return String(value['@_href'] || value['@_url'] || value['#text'] || value.url || '').trim();
  }
  return '';
}

function withTimeout(ms) {
  return AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
}

/** 微博热搜公开接口（失败返回空数组，不抛） */
export async function fetchWeiboHot({ timeoutMs = 6000, limit = 20 } = {}) {
  for (const endpoint of WEIBO_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        headers: { 'user-agent': UA, referer: 'https://weibo.com/', accept: 'application/json, text/plain, */*' },
        signal: withTimeout(timeoutMs),
      });
      if (!res.ok) {
        log.warn('微博热搜接口异常', endpoint, res.status);
        continue;
      }
      const data = await res.json();
      const raw = data?.data?.realtime || data?.data?.band_list || [];
      const items = [];
      for (const item of raw) {
        const title = stripHtml(item.word || item.note || item.word_scheme || '');
        if (!title) continue;
        items.push({
          title,
          summary: stripHtml(item.note || ''),
          url: `https://s.weibo.com/weibo?q=%23${encodeURIComponent(item.word || title)}%23`,
          hot: Number(item.num || item.raw_hot || 0) || null,
          source: 'weibo',
        });
        if (items.length >= limit) break;
      }
      if (items.length) return items;
    } catch (err) {
      log.warn('微博热搜抓取失败', endpoint, err?.message);
    }
  }
  return [];
}

/** 纯函数：解析 RSS / Atom / RDF 文本（单测无需联网） */
export function rssItemsFromXml(xml, sourceUrl = '') {
  if (!xml || typeof xml !== 'string') return [];
  let doc;
  try {
    doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', trimValues: true }).parse(xml);
  } catch (err) {
    log.warn('RSS 解析失败', sourceUrl, err?.message);
    return [];
  }
  const channel = doc?.rss?.channel || doc?.['rdf:RDF'] || doc?.RDF || doc?.feed || {};
  let raw = channel.item ?? channel.entry ?? doc?.feed?.entry ?? doc?.['rdf:RDF']?.item ?? [];
  if (!Array.isArray(raw)) raw = [raw];
  const items = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const title = stripHtml(textOf(entry.title));
    if (!title) continue;
    const summary = stripHtml(
      textOf(entry.description) || textOf(entry.summary) || textOf(entry.content) || textOf(entry['content:encoded']),
    );
    items.push({
      title,
      summary: truncate(summary, 200),
      url: linkOf(entry.link) || sourceUrl,
      hot: null,
      source: sourceUrl || 'rss',
    });
  }
  return items;
}

/** 拉取多个 RSS 源（失败源跳过） */
export async function fetchRss(urls = [], { timeoutMs = 8000, perFeed = 8 } = {}) {
  const feeds = (Array.isArray(urls) ? urls : [urls])
    .map((u) => (typeof u === 'string' ? u : u?.url))
    .map((u) => String(u || '').trim())
    .filter((u) => /^https?:\/\//i.test(u));
  if (!feeds.length) return [];
  const results = await Promise.allSettled(
    feeds.map(async (url) => {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'application/rss+xml, application/xml, text/xml, */*' },
        signal: withTimeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const xml = await res.text();
      return rssItemsFromXml(xml, url).slice(0, perFeed);
    }),
  );
  const items = [];
  for (const r of results) {
    if (r.status === 'fulfilled') items.push(...r.value);
    else log.warn('RSS 源抓取失败', r.reason?.message);
  }
  return items;
}

function sample(arr, n, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

/** 纯函数：前 top 条热门 + 中位区间随机 mid 条「不温不火」 */
export function pickItems(items = [], { top = 3, mid = 2, rng = Math.random } = {}) {
  const list = (Array.isArray(items) ? items : []).filter((it) => it && it.title);
  if (!list.length) return { hot: [], mid: [], all: [] };
  const hot = list.slice(0, Math.min(top, list.length));
  const rest = list.slice(hot.length);
  let picked = [];
  if (rest.length && mid > 0) {
    const lo = Math.floor(rest.length * 0.25);
    const hi = Math.max(lo + 1, Math.floor(rest.length * 0.75));
    const band = rest.slice(lo, hi);
    const pool = band.length ? band : rest;
    picked = sample(pool, Math.min(mid, pool.length), rng);
  }
  return { hot, mid: picked, all: [...hot, ...picked] };
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = String(it.title || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function reflectText(result) {
  const data = parseJsonLoose(result?.text);
  const content = data?.content ?? data?.text;
  if (typeof content === 'string' && content.trim()) return content.trim();
  const raw = String(result?.text || '').trim();
  return raw && !raw.startsWith('{') ? raw : '';
}

function insertBook(userId, characterId, { type, title, content, day, meta }) {
  const id = `bk_${uuid().replace(/-/g, '').slice(0, 16)}`;
  const now = nowIso();
  run(
    `INSERT INTO books(id, user_id, character_id, type, title, content, day, meta, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    id,
    userId,
    characterId,
    type,
    encryptText(userId, title),
    encryptText(userId, content),
    day,
    encryptJson(userId, meta || {}),
    now,
    now,
  );
  return id;
}

/**
 * 新闻阅读任务：多源抓取 -> 挑选 -> 生成感想 -> 写 books(type='news') + 当日 system 上下文。
 * 软/硬限额时跳过；LLM 不可用时返回 null。
 */
export async function runNews(job, payload = {}) {
  const ctx = jobContext(job, payload);
  const { userId, characterId } = ctx;
  try {
    if (!userId || !characterId) {
      log.warn('新闻任务缺少 userId/characterId，跳过', { userId, characterId });
      return { skipped: true, reason: 'missing_context' };
    }
    const limit = limitState(userId);
    if (limit.state !== 'ok') {
      log.warn('限额生效，跳过新闻阅读', { userId, characterId, state: limit.state });
      return { skipped: true, reason: `${limit.state}_limit`, inserted: 0 };
    }
    const character = getCharacter(userId, characterId);
    if (!character) {
      log.warn('新闻任务找不到角色', { userId, characterId });
      return { skipped: true, reason: 'character_not_found' };
    }
    const settings = getSettings(characterId, userId);

    const [weibo, rss] = await Promise.all([
      fetchWeiboHot().catch((err) => {
        log.warn('微博热搜不可用', err?.message);
        return [];
      }),
      fetchRss(settings.rss || []).catch((err) => {
        log.warn('RSS 不可用', err?.message);
        return [];
      }),
    ]);

    const allItems = dedupe([...weibo, ...rss]);
    if (!allItems.length) {
      log.warn('新闻源均无结果（可能无外网/接口变更），跳过本次阅读', { userId, characterId });
      return null;
    }

    const selected = pickItems(allItems, { top: 3, mid: 2 });
    const sources = [...new Set(selected.all.map((it) => it.source).filter(Boolean))];
    const digest = selected.all
      .map((it, i) => `${i + 1}. ${it.title}${it.summary ? `｜${truncate(it.summary, 90)}` : ''}`)
      .join('\n');

    const system = promptText('NEWS_REFLECT', NEWS_REFLECT_FALLBACK, { character, items: selected.all });
    const result = await chatText(userId, {
      task: 'news',
      json: true,
      temperature: 0.85,
      maxTokens: 600,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `今天挑出来阅读的新闻：\n${digest}` },
      ],
    });
    recordUsage({ userId, characterId, kind: 'news', model: result.model, usage: result.usage, cost: result.cost });

    const reflection = reflectText(result);
    if (!reflection) {
      log.warn('新闻感想为空，本次不写入书架', { userId, characterId });
      return null;
    }

    const day = dayKey();
    const content = `【感想】\n${reflection}\n\n【今日浏览】\n${digest}`;
    const bookId = insertBook(userId, characterId, {
      type: 'news',
      title: `新闻浏览 · ${day}`,
      content,
      day,
      meta: {
        source: sources.join(','),
        url: selected.all[0]?.url || '',
        hot: selected.all[0]?.hot || null,
        items: selected.all.map((it) => ({ title: it.title, url: it.url, hot: it.hot, source: it.source })),
        reflection,
      },
    });

    // 写入当日 system 上下文（最多保留三天）
    appendSystemMessage(userId, characterId, {
      tag: 'news',
      kind: 'news',
      role: 'system',
      content: `今日浏览（${day}）：\n${digest}\n我的感想：${truncate(reflection, 300)}`,
      meta: { bookId, day, items: selected.all.length },
    });
    cleanupSystemContext(userId, characterId, { days: 3 });

    log.info('新闻阅读完成', { userId, characterId, bookId, count: selected.all.length, sources });
    return { ok: true, bookId, count: selected.all.length, hot: selected.hot.length, mid: selected.mid.length, sources, day };
  } catch (err) {
    log.warn('新闻阅读失败', err?.message);
    return null;
  }
}

/** 书架里的新闻记录（解密后的摘要），供创作/画像引用 */
export function todayNewsDigest(userId, characterId, day = dayKey()) {
  const rows = all(
    "SELECT id, title, content FROM books WHERE user_id = ? AND character_id = ? AND type = 'news' AND day = ? ORDER BY created_at DESC LIMIT 3",
    userId,
    characterId,
    day,
  );
  return rows.map((r) => ({
    id: r.id,
    title: truncate(safeDecrypt(userId, r.title), 120),
    content: truncate(safeDecrypt(userId, r.content), 400),
  }));
}

function safeDecrypt(userId, blob) {
  try {
    return decryptText(userId, String(blob ?? ''));
  } catch {
    return String(blob ?? '');
  }
}

export default { runNews, fetchWeiboHot, fetchRss, rssItemsFromXml, pickItems, todayNewsDigest };
