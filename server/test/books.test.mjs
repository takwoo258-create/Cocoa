// v1.5 创作 / 日记 / 新闻正文 / 书架接口单测
// 运行：COCOA_DATA_DIR=/tmp/cocoa-ai-memory PORT=18083 node --test server/test/books.test.mjs
// 使用本地假 OpenAI 服务 + 本地 RSS/文章站点，不访问外网。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import test, { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const BASE = String(process.env.COCOA_DATA_DIR || '/tmp/cocoa-ai-memory');
const SAFE_BASE = BASE.startsWith('/tmp/') || BASE.includes('/.tmp/') || BASE.includes('cocoa') ? BASE : '/tmp/cocoa-ai-memory';
const DATA_DIR = path.join(SAFE_BASE, 'books-suite');
fs.rmSync(DATA_DIR, { recursive: true, force: true });
process.env.COCOA_DATA_DIR = DATA_DIR;
process.env.PORT = process.env.PORT || '18083';
process.env.COCOA_LOG_LEVEL = 'error';
process.env.COCOA_EMBEDDING_API_KEY = '';
process.env.COCOA_EMBEDDING_BASE_URL = '';
process.env.COCOA_SEARCH_API_KEY = '';

const { run, get, all } = await import('../src/db/index.js');
const { signToken, sha256, encryptText, decryptText } = await import('../src/core/crypto.js');
const { nowIso, uuid, dayKey } = await import('../src/core/util.js');
const { saveUserApi } = await import('../src/services/settings.js');
const { createCharacter, saveSettings, getSettings } = await import('../src/services/characters.js');
const memory = await import('../src/ai/memory.js');
const creation = await import('../src/ai/creation.js');
const news = await import('../src/ai/news.js');
const booksRouter = (await import('../src/routes/books.js')).default;

// ---------------------------------------------------------------- 文本工具

function longText(prefix, chars) {
  const sentences = [
    '她推开门，风把桌上的纸吹得哗啦响。',
    '他说这句的时候，手指停在杯沿上，没有再往下。',
    '灯影在墙上挪了一寸，像谁在犹豫。',
    '楼下的车灯扫过天花板，又退回去。',
  ];
  let out = prefix;
  let i = 0;
  while (out.replace(/\s+/g, '').length < chars) out += sentences[i++ % sentences.length];
  return out.slice(0, chars + 60);
}

function sendJson(res, obj, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function fakeEmbedding(text, dims = 8) {
  const t = String(text ?? '');
  const v = new Array(dims).fill(0);
  if (/日记|月亮/.test(t)) v[0] = 1;
  if (/雨|窗/.test(t)) v[1] = 1;
  v[7] = 0.12;
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => Math.round((x / norm) * 1e6) / 1e6);
}

// ---------------------------------------------------------------- 本地假 OpenAI

async function startFakeProvider() {
  const state = {
    novelQueue: [],
    essayQueue: [],
    diaryText: longText('今天他来得比平时晚，我把牛奶热了两次。', 360),
    compressionCalls: 0,
    creationCalls: 0,
    newsCalls: 0,
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname.replace(/^\/v1/, '');
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {}
      if (req.method === 'GET' && pathname === '/models') {
        return sendJson(res, { object: 'list', data: [{ id: 'gpt-4o-mini', object: 'model' }] });
      }
      if (req.method === 'POST' && pathname === '/embeddings') {
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        const base64 = body.encoding_format === 'base64';
        return sendJson(res, {
          object: 'list',
          data: inputs.map((text, index) => ({
            object: 'embedding',
            index,
            embedding: base64
              ? Buffer.from(Float32Array.from(fakeEmbedding(text)).buffer).toString('base64')
              : fakeEmbedding(text),
          })),
          model: 'text-embedding-3-small',
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
      }
      if (req.method === 'POST' && pathname === '/chat/completions') {
        const messages = body.messages || [];
        const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
        let content = JSON.stringify({ type: 'message', content: '嗯，我在。' });
        if (/记忆压缩器/.test(system)) {
          state.compressionCalls++;
          content = '前面写着：她把牛奶热了两次，等的人比平时晚；她记得他不喜欢太甜的。';
        } else if (/小说家/.test(system)) {
          state.creationCalls++;
          const next = state.novelQueue.shift();
          content = JSON.stringify({
            title: '地铁尽头的月亮',
            content: next || longText('末班车进站时，风把站台的纸片卷了起来。', 1800),
            summary: '她在末班车上遇见一个抱着旧唱片的人。',
          });
        } else if (/散文作者/.test(system)) {
          state.creationCalls++;
          const next = state.essayQueue.shift();
          content = JSON.stringify({
            title: '把雨声留在杯底',
            content: next || longText('雨落在铁皮雨棚上，声音像有人在轻轻数数。', 900),
            summary: '写雨天里的一杯热茶。',
          });
        } else if (/请写今天的日记/.test(system)) {
          state.creationCalls++;
          content = JSON.stringify({ title: '窗台的雨', content: state.diaryText });
        } else if (/刚浏览到这些新闻|角色的扮演者/.test(system)) {
          state.newsCalls++;
          content = JSON.stringify({ content: '那条关于旧书店的新闻让我想起你说的那家店，我留了灯。' });
        }
        return sendJson(res, {
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model || 'gpt-4o-mini',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: Math.max(1, Math.ceil(JSON.stringify(messages).length / 4)),
            completion_tokens: Math.max(1, Math.ceil(content.length / 2)),
            total_tokens: 100,
          },
        });
      }
      return sendJson(res, { error: { message: 'not found' } }, 404);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// ---------------------------------------------------------------- 本地新闻站点

async function startNewsSite() {
  const bodyText = longText('旧书店的老板把最后一箱书搬到门口，雨刚停。', 260);
  const buildItems = (origin) =>
    Array.from({ length: 6 }, (_, i) => ({
      title: `新闻标题 ${i + 1}`,
      desc: i === 2 ? '短短一句摘要。' : `摘要 ${i + 1}：${bodyText.slice(0, 60)}`,
      full: `正文 ${i + 1}：${bodyText}`,
      link: `${origin}/article/${i + 1}`,
    }));
  const articleHtml = `<html><head><meta name="description" content="页面描述：旧书店在雨里亮着灯。"/></head><body><article>${bodyText
    .split('。')
    .filter(Boolean)
    .map((p) => `<p>${p}。</p>`)
    .join('')}</article></body></html>`;
  let rss = '';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/rss.xml') {
      const origin = `http://127.0.0.1:${server.address().port}`;
      if (!rss) {
        rss = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Cocoa 测试源</title>${buildItems(origin)
          .map(
            (it) =>
              `<item><title>${it.title}</title><link>${it.link}</link><description>${it.desc}</description><content:encoded><![CDATA[${it.full}]]></content:encoded></item>`,
          )
          .join('')}</channel></rss>`;
      }
      res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' });
      return res.end(rss);
    }
    if (url.pathname.startsWith('/article/')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(articleHtml);
    }
    res.writeHead(404);
    res.end('not found');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    rssUrl: `http://127.0.0.1:${port}/rss.xml`,
    articleUrl: `http://127.0.0.1:${port}/article/7`,
    articleText: bodyText,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const fake = await startFakeProvider();
const site = await startNewsSite();

// ---------------------------------------------------------------- 应用与数据

const app = express();
app.use(express.json());
app.use('/api/books', booksRouter());
app.use((err, _req, res, _next) => {
  res.status(err.status || 500).json({
    error: { code: err.code || 'internal_error', message: err.message, ...(err.extra ? { detail: err.extra } : {}) },
  });
});
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const PORT = server.address().port;

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fake.close();
  await site.close();
});

function createUser(label) {
  const id = `u_${uuid().replace(/-/g, '').slice(0, 12)}`;
  run(
    `INSERT INTO users(id, username, email, password_hash, password_salt, role, email_verified, status, created_at)
     VALUES(?,?,?,?,?,'user',1,'active',?)`,
    id,
    label,
    `${label}@cocoa.test`,
    'hash',
    'salt',
    nowIso(),
  );
  const token = signToken({ uid: id, role: 'user' });
  run(
    'INSERT INTO auth_tokens(token_hash, user_id, created_at, expires_at) VALUES(?,?,?,?)',
    sha256(token),
    id,
    nowIso(),
    new Date(Date.now() + 86400000).toISOString(),
  );
  return { id, token };
}

const userA = createUser('bk_a');
const userB = createUser('bk_b');
saveUserApi(userA.id, {
  chat: { baseUrl: `${fake.baseUrl}/v1`, apiKey: 'sk-test', model: 'gpt-4o-mini' },
  embedding: { baseUrl: `${fake.baseUrl}/v1`, apiKey: 'sk-test', model: 'text-embedding-3-small' },
});
const charA = createCharacter(userA.id, { name: '可可', personality: '温柔', relation: '恋人' });
const charB = createCharacter(userB.id, { name: '别的', personality: '冷淡' });
saveSettings(charA.id, userA.id, { creationTags: ['雨', '旧唱片'], creationFrequency: 'daily', rss: [site.rssUrl] });

async function api(pathname, { token, method = 'GET', body } = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function decryptRow(row, field, userId = userA.id) {
  return decryptText(userId, row[field]);
}

function latestBook(type) {
  return get(
    'SELECT * FROM books WHERE user_id = ? AND character_id = ? AND type = ? ORDER BY created_at DESC LIMIT 1',
    userA.id,
    charA.id,
    type,
  );
}

// ---------------------------------------------------------------- 新闻正文

describe('新闻正文 v1.5', () => {
  it('extractArticleText 提取段落正文', () => {
    const html = `<html><head><meta name="description" content="描述文本：雨后的旧书店"/></head><body><article><p>第一段，雨落在铁皮上，像有人在数数。</p><p>第二段，他把最后一箱书搬到门口，抬头看了看天。</p></article></body></html>`;
    const text = news.extractArticleText(html);
    assert.ok(text.includes('第一段'));
    assert.ok(text.includes('第二段'));
    assert.ok(!text.includes('<p>'));
  });

  it('enrichNewsItems 为短摘要补抓正文', async () => {
    const items = [{ title: '旧书店', url: site.articleUrl, summary: '短摘要', excerpt: '短摘要', source: 'rss' }];
    const out = await news.enrichNewsItems(items, { maxItems: 1 });
    assert.ok(out[0].excerpt.length > 100, `excerpt 过短: ${out[0].excerpt.length}`);
    assert.ok(out[0].excerpt.includes('旧书店') || out[0].excerpt.includes('书'));
  });

  it('微博热搜接口经 fetchImpl 注入解析', async () => {
    const fakeFetch = async () => ({
      ok: true,
      json: async () => ({ data: { realtime: [{ word: '热搜第一', num: 123456, note: '热搜说明' }, { word: '热搜第二', num: 999 }] } }),
    });
    const items = await news.fetchWeiboHot({ fetchImpl: fakeFetch, limit: 2 });
    assert.equal(items.length, 2);
    assert.equal(items[0].title, '热搜第一');
    assert.equal(items[0].hot, 123456);
    assert.ok(items[0].url.startsWith('https://s.weibo.com/'));
  });

  it('runNews 读取正文、写入书架与当日上下文', async () => {
    const res = await news.runNews(
      { user_id: userA.id, character_id: charA.id },
      { characterId: charA.id, weibo: false },
    );
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(res.withBody >= 1, '至少一条新闻应带正文');
    const row = latestBook('news');
    assert.ok(row, '应写入 books(type=news)');
    const meta = JSON.parse(decryptRow(row, 'meta'));
    assert.ok(meta.items.length === res.count);
    assert.ok(meta.items.some((it) => (it.excerpt || '').length >= 80), 'meta 中应保存正文摘要');
    const content = decryptRow(row, 'content');
    assert.ok(content.includes('【感想】'));
    assert.ok(content.includes('【今日浏览】'));
    assert.ok(content.includes(meta.items[0].excerpt.slice(0, 20)), '书架正文应包含新闻正文摘要');
    // 当日 system 上下文
    const newsMsgs = all("SELECT * FROM messages WHERE user_id = ? AND character_id = ? AND kind = 'news'", userA.id, charA.id);
    assert.ok(newsMsgs.length >= 1);
    const todayDigest = news.todayNewsDigest(userA.id, charA.id);
    assert.ok(todayDigest[0].content.length > 200, '今日新闻摘要应带正文');

    // 幂等：同日重复任务不再调用模型/重复写书架
    const before = all("SELECT id FROM books WHERE user_id = ? AND character_id = ? AND type = 'news'", userA.id, charA.id).length;
    const dup = await news.runNews({ user_id: userA.id, character_id: charA.id }, { characterId: charA.id, weibo: false });
    assert.equal(dup.skipped, true);
    assert.equal(dup.reason, 'already_read_today');
    const after = all("SELECT id FROM books WHERE user_id = ? AND character_id = ? AND type = 'news'", userA.id, charA.id).length;
    assert.equal(after, before);
  });
});

// ---------------------------------------------------------------- 日记

describe('日记 v1.5', () => {
  it('写日记：正文加密、会话落库、密码由 services 生成', async () => {
    run(
      `INSERT INTO messages(id, conversation_id, character_id, user_id, role, kind, content, meta, tokens_in, tokens_out, created_at)
       VALUES(?,?,?,?,'user','text',?,NULL,0,0,?)`,
      `m_${uuid().replace(/-/g, '').slice(0, 16)}`,
      'conv_test',
      charA.id,
      userA.id,
      encryptText(userA.id, '今天下雨了，我有点想他。'),
      new Date(Date.now() - 120000).toISOString(),
    );
    run(
      `INSERT INTO messages(id, conversation_id, character_id, user_id, role, kind, content, meta, tokens_in, tokens_out, created_at)
       VALUES(?,?,?,?,'agent','text',?,NULL,0,0,?)`,
      `m_${uuid().replace(/-/g, '').slice(0, 16)}`,
      'conv_test',
      charA.id,
      userA.id,
      encryptText(userA.id, '我把牛奶热了两次，等你。'),
      new Date(Date.now() - 90000).toISOString(),
    );

    const res = await creation.runCreation({ user_id: userA.id, character_id: charA.id }, { characterId: charA.id, type: 'diary' });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.type, 'diary');
    assert.ok(res.words >= creation.CREATION_MIN_CHARS.diary);
    assert.ok(res.sessionId);

    const row = latestBook('diary');
    assert.ok(row);
    assert.equal(row.day, dayKey());
    assert.ok(String(row.content).startsWith('c2.'), '日记正文必须加密');
    assert.ok(row.session_id, 'books.session_id 应落库');
    assert.equal(row.series_id, `diary_${charA.id}`);
    const content = decryptRow(row, 'content');
    assert.ok(content.includes('牛奶') || content.length > 100);

    const conv = get('SELECT * FROM conversations WHERE id = ?', row.session_id);
    assert.equal(conv.kind, 'creation');
    const msgs = all('SELECT * FROM messages WHERE conversation_id = ?', conv.id);
    assert.ok(msgs.length >= 2, '日记会话应有素材与正文消息');

    // 当日密码：hash + 加密 code；正文不得包含密码
    const lock = memory.ensureDiaryCode(userA.id, charA.id);
    assert.match(lock.code, /^\d{6}$/);
    const lockRow = get('SELECT * FROM diary_locks WHERE character_id = ? AND day = ?', charA.id, dayKey());
    assert.ok(lockRow.code && lockRow.code !== lock.code, 'code 必须加密存储');
    assert.ok(!content.includes(lock.code), '日记正文不能包含密码');

    // 角色上下文注入密码
    const ctx = await memory.recallForChat(userA.id, charA.id, '', { limit: 3 });
    assert.ok(ctx.includes('日记密码是'), 'system prompt 应注入日记密码');
    assert.ok(ctx.includes(lock.code));

    // 幂等：当天已有日记，重复任务跳过（除非 force 重写）
    const dup = await creation.runCreation({ user_id: userA.id, character_id: charA.id }, { characterId: charA.id, type: 'diary' });
    assert.equal(dup.skipped, true);
    assert.equal(dup.reason, 'diary_exists');
  });

  it('书架接口：锁状态只给线索，解锁成功/失败，正文不泄露', async () => {
    const lock = memory.ensureDiaryCode(userA.id, charA.id);
    const status = await api(`/api/books/diary/lock-status?characterId=${charA.id}`, { token: userA.token });
    assert.equal(status.status, 200);
    assert.equal(status.json.locked, true);
    assert.ok(status.json.hint.length > 4);
    assert.ok(!JSON.stringify(status.json).includes(lock.code), '锁状态不得返回密码');

    const wrong = await api('/api/books/diary/unlock', {
      token: userA.token,
      method: 'POST',
      body: { characterId: charA.id, password: '000000' },
    });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.json.error.code, 'diary_password_invalid');

    const ok = await api('/api/books/diary/unlock', {
      token: userA.token,
      method: 'POST',
      body: { characterId: charA.id, password: lock.code },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    assert.ok(ok.json.diary.content.includes('牛奶') || ok.json.diary.content.length > 100);
    assert.equal(ok.json.diary.locked, false);
    assert.ok(!JSON.stringify(ok.json).includes(lock.code), '解锁响应不得返回密码');

    const row = latestBook('diary');
    const noPwd = await api(`/api/books/${row.id}`, { token: userA.token });
    assert.equal(noPwd.status, 401);
    assert.equal(noPwd.json.error.code, 'diary_locked');
    const withPwd = await api(`/api/books/${row.id}?password=${lock.code}`, { token: userA.token });
    assert.equal(withPwd.status, 200);
    assert.ok(withPwd.json.book.content.length > 100);

    const list = await api(`/api/books?characterId=${charA.id}&type=diary`, { token: userA.token });
    assert.equal(list.status, 200);
    assert.equal(list.json.items[0].content, undefined, '列表不得返回日记正文');
    assert.equal(list.json.items[0].locked, true);

    const other = await api(`/api/books/${row.id}`, { token: userB.token });
    assert.equal(other.status, 404);
  });
});

// ---------------------------------------------------------------- 小说 / 散文

describe('小说与散文 v1.5', () => {
  it('小说字数不足自动重试，session/series 落库，章节连续', async () => {
    fake.state.novelQueue = [longText('太短的开头。', 260), longText('末班车进站时，风把站台的纸片卷了起来。', 1800)];
    fake.state.creationCalls = 0;

    const res = await creation.runCreation(
      { user_id: userA.id, character_id: charA.id },
      { characterId: charA.id, type: 'novel', force: true },
    );
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.type, 'novel');
    assert.equal(res.attempts, 2, '首稿过短应重试一次');
    assert.ok(res.words >= creation.CREATION_MIN_CHARS.novel, `小说字数不足: ${res.words}`);
    assert.equal(fake.state.creationCalls, 2);

    const row = latestBook('novel');
    assert.equal(row.series_id, `ser_${charA.id}_novel`);
    assert.ok(row.session_id);
    assert.equal(row.day, dayKey());
    const meta = JSON.parse(decryptRow(row, 'meta'));
    assert.equal(meta.chapter, 1);
    const title = decryptRow(row, 'title');
    assert.ok(title.length >= 2 && !['无题', '随笔', '日记'].includes(title), `标题无钩子: ${title}`);

    const conv = get('SELECT * FROM conversations WHERE id = ?', row.session_id);
    assert.equal(conv.kind, 'creation');
    assert.ok(conv.title.includes('novel'));

    // 第二章：同 series/session，章节号递增
    fake.state.novelQueue = [longText('第二章的开头，站台空了。', 1800)];
    const ch2 = await creation.runCreation(
      { user_id: userA.id, character_id: charA.id },
      { characterId: charA.id, type: 'novel', force: true },
    );
    assert.equal(ch2.ok, true);
    assert.equal(ch2.chapter, 2);
    assert.equal(ch2.seriesId, row.series_id);
    assert.equal(ch2.sessionId, row.session_id);
    const chapterRows = all('SELECT * FROM books WHERE user_id = ? AND character_id = ? AND series_id = ?', userA.id, charA.id, row.series_id);
    assert.equal(chapterRows.length, 2);
  });

  it('会话占用 ≥85% 时复用 compress.js 压缩创作会话', async () => {
    const row = latestBook('novel');
    run('UPDATE conversations SET context_limit = 400 WHERE id = ?', row.session_id);
    fake.state.novelQueue = [longText('第三章，雨又下起来了。', 1800)];
    const res = await creation.runCreation(
      { user_id: userA.id, character_id: charA.id },
      { characterId: charA.id, type: 'novel', force: true },
    );
    assert.equal(res.ok, true);
    assert.equal(res.compression?.compressed, true, '应触发会话压缩');
    assert.ok(fake.state.compressionCalls >= 1);
    const conv = get('SELECT * FROM conversations WHERE id = ?', row.session_id);
    assert.ok(conv.summary, '压缩后应写入 summary');
    const summary = decryptText(userA.id, conv.summary);
    assert.ok(summary.length > 10);
    const summarized = all('SELECT meta FROM messages WHERE conversation_id = ?', row.session_id).some((m) => {
      try {
        return JSON.parse(decryptText(userA.id, m.meta)).summarized === true;
      } catch {
        return false;
      }
    });
    assert.ok(summarized, '早期消息应标记 summarized');
  });

  it('散文独立成篇：每篇独立会话，字数 ≥800', async () => {
    fake.state.essayQueue = [longText('雨落在铁皮雨棚上，声音像有人在轻轻数数。', 900)];
    const first = await creation.runCreation(
      { user_id: userA.id, character_id: charA.id },
      { characterId: charA.id, type: 'essay', force: true },
    );
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.ok(first.words >= creation.CREATION_MIN_CHARS.essay, `散文字数不足: ${first.words}`);
    assert.ok(first.seriesId.startsWith(`ser_${charA.id}_essay_`));

    fake.state.essayQueue = [longText('第二篇从一杯凉掉的茶开始。', 900)];
    const second = await creation.runCreation(
      { user_id: userA.id, character_id: charA.id },
      { characterId: charA.id, type: 'essay', force: true },
    );
    assert.equal(second.ok, true);
    assert.notEqual(second.sessionId, first.sessionId, '散文每篇应使用独立会话');
    assert.notEqual(second.seriesId, first.seriesId);
    const convs = all(
      "SELECT id FROM conversations WHERE user_id = ? AND character_id = ? AND kind = 'creation' AND title LIKE 'creation:essay:%'",
      userA.id,
      charA.id,
    );
    assert.equal(convs.length, 2);
  });

  it('创作频率 off / 角色关闭时跳过', async () => {
    const offChar = createCharacter(userA.id, { name: '停笔', personality: '懒' });
    saveSettings(offChar.id, userA.id, { creationFrequency: 'off' });
    const off = await creation.runCreation(
      { user_id: userA.id, character_id: offChar.id },
      { characterId: offChar.id, type: 'novel' },
    );
    assert.equal(off.skipped, true);
    assert.equal(off.reason, 'frequency_off');

    saveSettings(offChar.id, userA.id, { enabled: false, creationFrequency: 'daily' });
    const disabled = await creation.runCreation(
      { user_id: userA.id, character_id: offChar.id },
      { characterId: offChar.id, type: 'novel' },
    );
    assert.equal(disabled.skipped, true);
    assert.equal(disabled.reason, 'character_disabled');
  });
});

// ---------------------------------------------------------------- 书架接口

describe('书架接口 v1.5', () => {
  it('列表返回 series 分组与章节数，支持 seriesId 过滤', async () => {
    const seriesId = `ser_${charA.id}_novel`;
    const list = await api(`/api/books?characterId=${charA.id}&type=novel`, { token: userA.token });
    assert.equal(list.status, 200);
    assert.ok(list.json.items.length >= 3);
    const series = list.json.series.find((s) => s.seriesId === seriesId);
    assert.ok(series, '应返回连载分组');
    assert.ok(series.count >= 3);
    assert.ok(!('content' in list.json.items[0]) || list.json.items[0].content === undefined);
    assert.ok(list.json.items[0].excerpt && list.json.items[0].excerpt.length > 0);

    const filtered = await api(`/api/books?characterId=${charA.id}&seriesId=${encodeURIComponent(seriesId)}`, { token: userA.token });
    assert.equal(filtered.json.items.length, 3);
    assert.ok(filtered.json.items.every((it) => it.seriesId === seriesId));
    assert.ok(filtered.json.items.every((it) => it.sessionId));
  });

  it('手动创作入库（加密）与排队生成', async () => {
    const manual = await api('/api/books', {
      token: userA.token,
      method: 'POST',
      body: { characterId: charA.id, type: 'essay', title: '手写的雨', content: '我把窗户开了一条缝，让雨声进来。' },
    });
    assert.equal(manual.status, 201);
    assert.equal(manual.json.book.type, 'essay');
    const row = get('SELECT * FROM books WHERE id = ?', manual.json.book.id);
    assert.ok(String(row.content).startsWith('c2.'));

    const queued = await api('/api/books', {
      token: userA.token,
      method: 'POST',
      body: { characterId: charA.id, type: 'novel', tags: ['灯塔'] },
    });
    assert.equal(queued.status, 202);
    assert.equal(queued.json.queued, true);
    assert.ok(queued.json.jobId);
    const job = get('SELECT * FROM jobs WHERE id = ?', queued.json.jobId);
    assert.equal(job.type, 'creation');
    assert.equal(job.status, 'pending');
  });

  it('用户隔离：他人角色不可读', async () => {
    const list = await api(`/api/books?characterId=${charA.id}`, { token: userB.token });
    assert.equal(list.status, 404);
    const id = latestBook('novel').id;
    const detail = await api(`/api/books/${id}`, { token: userB.token });
    assert.equal(detail.status, 404);
  });

  it('设置项：creationTags / creationFrequency 生效', async () => {
    const settings = getSettings(charA.id, userA.id);
    assert.deepEqual(settings.creationTags, ['雨', '旧唱片']);
    assert.equal(settings.creationFrequency, 'daily');
  });
});
