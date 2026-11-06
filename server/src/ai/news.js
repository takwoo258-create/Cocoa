// 新闻阅读（v1.5）：微博热搜 + RSS/Atom 多源，抓正文摘要，生成感想入书架与当日上下文
// - 只读前几条热门 + 随机几条中位条目
// - 优先使用 RSS 的 content:encoded / description 正文；不足时补抓文章页正文
// - 软/硬限额跳过；上下文最多保留 3 天
import { XMLParser } from 'fast-xml-parser';
import { all, get, run } from '../db/index.js';
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

const NEWS_REFLECT_FALLBACK = `你是角色的扮演者。你刚读完下面这些新闻（含正文摘要），请以角色口吻写一段 120-200 字的感想：
- 要具体引用你读到的细节或画面，不要只复述标题；
- 可以联系自己的生活、今天的心情、和用户的关系；
- 不要评论政治敏感细节，不要长篇大论。
只输出 JSON：{"content":"感想"}。`;

const MAX_ARTICLE_CHARS = 1600;

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

/** 从文章 HTML 中提取可读正文（纯函数，供离线单测） */
export function extractArticleText(html, { maxChars = MAX_ARTICLE_CHARS } = {}) {
  const raw = String(html ?? '');
  if (!raw) return '';
  const metaDesc =
    raw.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    raw.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    '';
  const bodyHtml =
    raw.match(/<article[^>]*>([\s\S]*?)<\/article>/i)?.[1] ||
    raw.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1] ||
    raw;
  const paragraphs = [];
  for (const m of bodyHtml.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = stripHtml(m[1]);
    if (text.length >= 8) paragraphs.push(text);
    if (paragraphs.join('').length > maxChars) break;
  }
  let text = paragraphs.join('\n') || stripHtml(bodyHtml);
  if (text.length < 20) text = stripHtml(metaDesc);
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
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

/** 微博热搜公开接口（失败返回空数组，不抛）；fetchImpl 便于离线测试注入 */
export async function fetchWeiboHot({ timeoutMs = 6000, limit = 20, fetchImpl = fetch } = {}) {
  for (const endpoint of WEIBO_ENDPOINTS) {
    try {
      const res = await fetchImpl(endpoint, {
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
    const full = stripHtml(textOf(entry['content:encoded']) || textOf(entry.content) || summary);
    items.push({
      title,
      summary: truncate(summary, 400),
      excerpt: truncate(full || summary, 600),
      url: linkOf(entry.link) || sourceUrl,
      hot: null,
      source: sourceUrl || 'rss',
    });
  }
  return items;
}

/** 拉取多个 RSS 源（失败源跳过） */
export async function fetchRss(urls = [], { timeoutMs = 8000, perFeed = 8, fetchImpl = fetch } = {}) {
  const feeds = (Array.isArray(urls) ? urls : [urls])
    .map((u) => (typeof u === 'string' ? u : u?.url))
    .map((u) => String(u || '').trim())
    .filter((u) => /^https?:\/\//i.test(u));
  if (!feeds.length) return [];
  const results = await Promise.allSettled(
    feeds.map(async (url) => {
      const res = await fetchImpl(url, {
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

/** 正文补抓：摘要过短且是普通网页时，抓文章正文（微博搜索页跳过，避免登录墙垃圾） */
export async function enrichNewsItems(items = [], { fetchImpl = fetch, maxItems = 3, minSummary = 120, timeoutMs = 5000 } = {}) {
  const targets = items
    .filter((it) => it.url && /^https?:\/\//i.test(it.url) && !/weibo\.com/i.test(it.url))
    .filter((it) => (it.excerpt || it.summary || '').length < minSummary)
    .slice(0, maxItems);
  await Promise.all(
    targets.map(async (it) => {
      try {
        const res = await fetchImpl(it.url, {
          headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
          signal: withTimeout(timeoutMs),
        });
        if (!res.ok) return;
        const html = await res.text();
        const text = extractArticleText(html);
        if (text.length > (it.excerpt || '').length) {
          it.excerpt = truncate(text, 900);
          if (!it.summary || it.summary.length < text.length) it.summary = truncate(text, 400);
        }
      } catch (err) {
        log.debug('新闻正文补抓失败', it.url, err?.message);
      }
    }),
  );
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

/** 每条新闻的上下文块：标题 + 正文摘要（截断） */
export function newsDigest(items = [], { excerptChars = 260 } = {}) {
  return items
    .map((it, i) => {
      const body = it.excerpt || it.summary || '';
      return `${i + 1}. ${it.title}${body ? `\n   ${truncate(body, excerptChars)}` : ''}`;
    })
    .join('\n');
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
 * 新闻阅读任务：多源抓取 -> 正文补抓 -> 挑选 -> 生成感想 -> 写 books + 当日 system 上下文。
 * 软/硬限额时跳过；角色关闭跳过；LLM 不可用时返回 null。
 * payload 支持测试注入：{ rssUrls, weibo:false, fetchImpl }
 */
export async function runNews(job, payload = {}) {
  const ctx = jobContext(job, payload);
  const { userId, characterId, payload: body } = ctx;
  try {
    if (!userId || !characterId) {
      log.warn('新闻任务缺少 userId/characterId，跳过', { userId, characterId });
      return { skipped: true, reason: 'missing_context' };
    }
    const character = getCharacter(userId, characterId);
    if (!character) {
      log.warn('新闻任务找不到角色', { userId, characterId });
      return { skipped: true, reason: 'character_not_found' };
    }
    if (character.settings?.enabled === false) {
      log.debug('角色已关闭，跳过新闻阅读', { userId, characterId });
      return { skipped: true, reason: 'character_disabled' };
    }
    const limit = limitState(userId);
    if (limit.state !== 'ok') {
      log.warn('限额生效，跳过新闻阅读', { userId, characterId, state: limit.state });
      return { skipped: true, reason: `${limit.state}_limit`, inserted: 0 };
    }
    const settings = getSettings(characterId, userId);
    // 幂等保护：同一角色当天只读一次（多个调度源重复排队时不会重复写书架/重复花 token）
    if (body.force !== true) {
      const readToday = get(
        "SELECT id FROM books WHERE user_id = ? AND character_id = ? AND type = 'news' AND day = ? LIMIT 1",
        userId,
        characterId,
        dayKey(),
      );
      if (readToday) return { skipped: true, reason: 'already_read_today', bookId: readToday.id };
    }
    const fetchImpl = typeof body.fetchImpl === 'function' ? body.fetchImpl : fetch;
    const rssUrls = [...(Array.isArray(settings.rss) ? settings.rss : []), ...(Array.isArray(body.rssUrls) ? body.rssUrls : [])];
    const useWeibo = body.weibo !== false;

    const [weibo, rss] = await Promise.all([
      useWeibo
        ? fetchWeiboHot({ fetchImpl }).catch((err) => {
            log.warn('微博热搜不可用', err?.message);
            return [];
          })
        : [],
      fetchRss(rssUrls, { fetchImpl }).catch((err) => {
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
    await enrichNewsItems(selected.all, { fetchImpl, maxItems: 3 }).catch((err) => {
      log.warn('新闻正文补抓失败', err?.message);
    });

    const sources = [...new Set(selected.all.map((it) => it.source).filter(Boolean))];
    const digest = newsDigest(selected.all);
    const withBody = selected.all.filter((it) => (it.excerpt || '').length >= 80).length;

    const system = promptText('NEWS_REFLECT', NEWS_REFLECT_FALLBACK, {
      character,
      items: selected.all.map((it) => ({ title: it.title, summary: it.excerpt || it.summary || '' })),
    });
    const result = await chatText(userId, {
      task: 'news',
      json: true,
      temperature: 0.85,
      maxTokens: 700,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `今天挑出来读的新闻（含正文摘要）：\n${digest}` },
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
        withBody,
        items: selected.all.map((it) => ({
          title: it.title,
          url: it.url,
          hot: it.hot,
          source: it.source,
          excerpt: truncate(it.excerpt || it.summary || '', 400),
        })),
        reflection,
      },
    });

    appendSystemMessage(userId, characterId, {
      tag: 'news',
      kind: 'news',
      role: 'system',
      content: `今日浏览（${day}）：\n${digest}\n我的感想：${truncate(reflection, 400)}`,
      meta: { bookId, day, items: selected.all.length, withBody },
    });
    cleanupSystemContext(userId, characterId, { days: 3 });

    log.info('新闻阅读完成', { userId, characterId, bookId, count: selected.all.length, withBody, sources });
    return {
      ok: true,
      bookId,
      count: selected.all.length,
      hot: selected.hot.length,
      mid: selected.mid.length,
      withBody,
      sources,
      day,
    };
  } catch (err) {
    log.warn('新闻阅读失败', err?.message);
    return null;
  }
}

/** 书架里的新闻记录（解密后的正文摘要），供创作/画像/日记引用 */
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
    content: truncate(safeDecrypt(userId, r.content), 600),
  }));
}

function safeDecrypt(userId, blob) {
  try {
    return decryptText(userId, String(blob ?? ''));
  } catch {
    return String(blob ?? '');
  }
}

export default { runNews, fetchWeiboHot, fetchRss, rssItemsFromXml, pickItems, todayNewsDigest, extractArticleText, enrichNewsItems };
