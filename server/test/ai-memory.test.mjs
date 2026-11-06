// 记忆 / 画像 / 新闻 / 创作 / 书架 单测（node:test）
// 运行：COCOA_DATA_DIR=/data/dsh/home/.tmp/cocoa-mem node --test server/test/ai-memory.test.mjs
// 不访问外网：LLM/嵌入调用在此环境必然因「未配置 API」提前失败，用于验证安全降级。
import fs from 'node:fs';
import { once } from 'node:events';
import test, { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const ENV_DIR = String(process.env.COCOA_DATA_DIR || '');
const DATA_DIR =
  ENV_DIR && (ENV_DIR.startsWith('/tmp/') || ENV_DIR.includes('/.tmp/')) ? ENV_DIR : '/tmp/cocoa-ai-memory';
const PORT = 18083;

fs.rmSync(DATA_DIR, { recursive: true, force: true });
process.env.COCOA_DATA_DIR = DATA_DIR;
process.env.PORT = String(PORT);
process.env.COCOA_LOG_LEVEL = 'error';
// 避免宿主机 .env 里的嵌入/搜索 key 让单测打到外网
process.env.COCOA_EMBEDDING_API_KEY = '';
process.env.COCOA_EMBEDDING_BASE_URL = '';
process.env.COCOA_SEARCH_API_KEY = '';

const { run, get } = await import('../src/db/index.js');
const { signToken, sha256, hashPassword, encryptText } = await import('../src/core/crypto.js');
const { nowIso, uuid, dayKey } = await import('../src/core/util.js');
const memory = await import('../src/ai/memory.js');
const {
  runMemoryExtraction,
  buildGraph,
  insertMemory,
  memoryDetail,
  searchMemories,
  deleteMemory,
  limitState,
  parseMemoryItems,
  recallForChat,
  bootstrapAiMemoryJobs,
} = memory;
const { runPortrait, maybeTriggerPortrait, portraitDue, diffPortraits } = await import('../src/ai/portrait.js');
const { runNews, rssItemsFromXml, pickItems } = await import('../src/ai/news.js');
const { runCreation, sanitizeCreation, creationDue } = await import('../src/ai/creation.js');
const { createCharacter, verifyDiaryPassword } = await import('../src/services/characters.js');
const { savePrefs } = await import('../src/services/settings.js');
const { recordUsage } = await import('../src/ai/usage.js');
const memoryRouter = (await import('../src/routes/memory.js')).default;
const booksRouter = (await import('../src/routes/books.js')).default;

// ---------------------------------------------------------------- 种子数据

function createUser(label) {
  const id = `u_${uuid().replace(/-/g, '').slice(0, 12)}`;
  run(
    `INSERT INTO users(id, username, email, password_hash, password_salt, role, email_verified, status, created_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    id,
    label,
    `${label}@cocoa.test`,
    'hash',
    'salt',
    'user',
    1,
    'active',
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

const userA = createUser('mema');
const userB = createUser('memb');
const userC = createUser('memc');
const charA = createCharacter(userA.id, { name: '可可', gender: '女', personality: '温柔又有点别扭', relation: '恋人' });
const charB = createCharacter(userB.id, { name: '阿岚', gender: '男', personality: '寡言', relation: '朋友' });
const charC = createCharacter(userC.id, { name: '小满', gender: '女', personality: '活泼', relation: '同学' });

const memA1 = insertMemory(userA.id, charA.id, {
  big: '喜好',
  small: '食物',
  content: '用户无辣不欢，最爱重庆火锅',
  weight: 0.6,
  embedding: [0.02, 0.99, 0.05],
  source: 'chat',
});
const memA2 = insertMemory(userA.id, charA.id, {
  big: '喜好',
  small: '食物',
  content: '用户不吃香菜，闻到就皱眉',
  weight: 0.45,
  source: 'chat',
});
const memA3 = insertMemory(userA.id, charA.id, {
  big: '喜好',
  small: '音乐',
  content: '用户喜欢后摇与城市夜晚的噪音',
  weight: 0.4,
  embedding: [0.9, 0.1, 0.2],
});
const memA4 = insertMemory(userA.id, charA.id, {
  big: '雷点',
  small: '称呼',
  content: '用户讨厌被叫小朋友',
  weight: 0.8,
  embedding: [0.88, 0.12, 0.19],
});
const memB1 = insertMemory(userB.id, charB.id, {
  big: '特长',
  small: '乐器',
  content: '用户会弹一点吉他',
  weight: 0.5,
});

// 一条近期用户消息，供记忆抽取/画像使用
run(
  `INSERT INTO messages(id, conversation_id, character_id, user_id, role, kind, content, meta, tokens_in, tokens_out, created_at)
   VALUES(?,?,?,?,?,?,?,?,0,0,?)`,
  `m_${uuid()}`,
  `conv_${uuid()}`,
  charA.id,
  userA.id,
  'user',
  'text',
  encryptText(userA.id, '我最近迷上了手冲咖啡，每天都要磨豆子'),
  null,
  nowIso(),
);

// ---------------------------------------------------------------- HTTP

const app = express();
app.use(express.json());
app.use('/api/memory', memoryRouter());
app.use('/api/books', booksRouter());
// 与 app.js 一致的错误形状
app.use((err, _req, res, _next) => {
  res.status(err.status || 500).json({
    error: {
      code: err.code || 'internal_error',
      message: err.message || '服务器内部错误',
      ...(err.extra ? { detail: err.extra } : {}),
    },
  });
});
const server = app.listen(PORT);
await once(server, 'listening');

after(() => {
  server.close();
});

async function api(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

// ---------------------------------------------------------------- 记忆图

describe('记忆图结构', () => {
  it('返回 agent -> 大类 -> 小类 -> 记忆点 四层节点', async () => {
    const { status, json } = await api(`/api/memory/graph?characterId=${charA.id}`, { token: userA.token });
    assert.equal(status, 200);
    const agent = json.nodes.find((n) => n.type === 'agent');
    assert.equal(agent.id, 'agent');
    assert.equal(agent.label, '可可');

    const big = json.nodes.find((n) => n.type === 'category' && n.big === true && n.label === '喜好');
    assert.ok(big, '缺少大类节点');
    assert.equal(big.parent, 'agent');
    const small = json.nodes.find((n) => n.type === 'category' && n.big === false && n.label === '食物');
    assert.ok(small, '缺少小类节点');
    assert.equal(small.parent, big.id);

    const memNodes = json.nodes.filter((n) => n.type === 'memory');
    assert.equal(memNodes.length, 4);
    assert.ok(json.nodes.some((n) => n.type === 'memory' && n.id === memA1.id));

    // 类目层级连线非虚线，记忆点挂在最小类目下
    assert.ok(json.links.some((l) => l.source === 'agent' && l.target === big.id && l.dashed === false));
    assert.ok(json.links.some((l) => l.source === big.id && l.target === small.id && l.dashed === false));
    assert.ok(json.links.some((l) => l.source === `${big.id}/${small.label}` && l.target === memA1.id && l.dashed === false));
    assert.equal(json.counts.memories, 4);
    // 节点 id 稳定，便于客户端展开/折叠
    assert.equal(big.id, 'cat:喜好');
    assert.equal(small.id, 'cat:喜好/食物');
  });

  it('记忆点不带颜色字段，亮度 = weight，白色由 paletteHint 提供', async () => {
    const { json } = await api(`/api/memory/graph?characterId=${charA.id}`, { token: userA.token });
    for (const node of json.nodes) assert.equal(node.color, undefined, '后端不应返回颜色');
    const memNode = json.nodes.find((n) => n.id === memA1.id);
    assert.equal(memNode.brightness, memNode.weight);
    assert.equal(json.paletteHint.memory, '#ffffff');
    assert.ok(memNode.preview.includes('火锅'));
    assert.ok(memNode.label.length <= 17);
  });

  it('相似记忆用虚线关联并带 score，写入时获得关联加成', async () => {
    const { json } = await api(`/api/memory/graph?characterId=${charA.id}`, { token: userA.token });
    const dashed = json.links.filter((l) => l.dashed === true && String(l.source).startsWith('mem_'));
    assert.ok(dashed.length >= 1, '相似记忆应产生虚线关联');
    const pair = dashed.find(
      (l) => [l.source, l.target].includes(memA3.id) && [l.source, l.target].includes(memA4.id),
    );
    assert.ok(pair, 'memA3 与 memA4 应有关联');
    assert.ok(pair.score > memory.LINK_THRESHOLD);
    // 无向去重：同一对只出现一次
    const key = [pair.source, pair.target].sort().join('|');
    assert.equal(dashed.filter((l) => [l.source, l.target].sort().join('|') === key).length, 1);
    // 关联加成后权重高于基础值
    assert.ok(memA4.weight > 0.8, `权重应被加成: ${memA4.weight}`);
  });

  it('记忆详情包含创建时间、大小类目与关联列表', async () => {
    const { status, json } = await api(`/api/memory/${memA4.id}`, { token: userA.token });
    assert.equal(status, 200);
    const m = json.memory;
    assert.equal(m.big, '雷点');
    assert.equal(m.small, '称呼');
    assert.ok(m.createdAt);
    assert.ok(m.links.length >= 1);
    assert.ok(m.links[0].dashed === true);
    assert.ok(m.links.some((l) => l.id === memA3.id));
  });
});

// ---------------------------------------------------------------- 隔离 / 检索

describe('记忆隔离与检索', () => {
  it('不能读取他人的角色图与记忆', async () => {
    const graph = await api(`/api/memory/graph?characterId=${charA.id}`, { token: userB.token });
    assert.equal(graph.status, 404);
    const detail = await api(`/api/memory/${memA1.id}`, { token: userB.token });
    assert.equal(detail.status, 404);
    const search = await api(`/api/memory/search?characterId=${charA.id}&q=火锅`, { token: userB.token });
    assert.equal(search.status, 404);
  });

  it('无嵌入 key 时语义检索退化为关键词匹配', async () => {
    const { status, json } = await api(`/api/memory/search?characterId=${charA.id}&q=火锅`, { token: userA.token });
    assert.equal(status, 200);
    assert.equal(json.mode, 'keyword');
    assert.equal(json.items.length, 1);
    assert.equal(json.items[0].id, memA1.id);
    // 只返回本角色记忆
    const other = await api(`/api/memory/search?characterId=${charB.id}&q=火锅`, { token: userB.token });
    assert.equal(other.json.items.length, 0);
  });

  it('删除记忆后不再可读，且关联一并清理', async () => {
    const temp = insertMemory(userA.id, charA.id, {
      big: '经历',
      small: '旅行',
      content: '用户去过一次海边',
      weight: 0.3,
    });
    const del = await api(`/api/memory/${temp.id}`, { token: userA.token, method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal(del.json.ok, true);
    const afterDel = await api(`/api/memory/${temp.id}`, { token: userA.token });
    assert.equal(afterDel.status, 404);
    assert.equal(deleteMemory(userA.id, temp.id), false);
    assert.equal(deleteMemory(userB.id, memA1.id), false);
  });
});

// ---------------------------------------------------------------- 画像

describe('人物画像', () => {
  it('触发条件：累计 200 次对话或距上次 3 天', () => {
    const now = Date.parse('2026-11-01T12:00:00.000Z');
    assert.equal(portraitDue({ chat_count_since_portrait: 200 }, { now }).due, true);
    assert.equal(portraitDue({ chat_count_since_portrait: 200 }, { now }).reason, 'chat_count');
    const recent = new Date(now - 1 * 86400000).toISOString();
    assert.equal(portraitDue({ chat_count_since_portrait: 10, last_portrait_at: recent }, { now }).due, false);
    const old = new Date(now - 4 * 86400000).toISOString();
    assert.equal(portraitDue({ chat_count_since_portrait: 10, last_portrait_at: old }, { now }).due, true);
    // 首次画像：陪伴满 3 天且对话量足够
    const companion = new Date(now - 5 * 86400000).toISOString();
    assert.equal(portraitDue({ chat_count_since_portrait: 5, companion_since: companion }, { now }).due, false);
    assert.equal(portraitDue({ chat_count_since_portrait: 25, companion_since: companion }, { now }).due, true);
  });

  it('与上一版做差异化对比，无上一版写「首次画像」', () => {
    assert.equal(diffPortraits('', '新版画像'), '首次画像');
    const prev = '用户喜欢安静。用户最近睡眠不足。';
    const next = '用户喜欢安静。用户最近睡眠不足。用户开始每天手冲咖啡。';
    const diff = diffPortraits(prev, next);
    assert.ok(diff.includes('新增 1 处'));
    assert.ok(diff.includes('手冲咖啡'));
    assert.equal(diffPortraits(prev, prev), '与上一版一致，暂无新变化');
  });

  it('未达阈值时不排任务（节流且可重复调用）', () => {
    const result = maybeTriggerPortrait(userA.id, charA.id, { force: false });
    assert.equal(result.triggered, false);
    assert.equal(result.reason, 'not_enough');
    // 第二次调用被节流
    assert.equal(maybeTriggerPortrait(userA.id, charA.id).reason, 'throttled');
  });

  it('LLM 不可用时返回 null 且不抛错，也不清零计数', async () => {
    const out = await runPortrait({ user_id: userA.id, character_id: charA.id }, { characterId: charA.id });
    assert.equal(out, null);
    const state = get('SELECT * FROM character_state WHERE character_id = ?', charA.id);
    assert.equal(state.chat_count_since_portrait, 0);
    assert.equal(state.last_portrait_at, null);
    assert.equal(get('SELECT COUNT(*) c FROM portraits WHERE character_id = ?', charA.id).c, 0);
  });
});

// ---------------------------------------------------------------- 记忆抽取

describe('记忆抽取', () => {
  it('解析模型返回的 JSON 条目并规范化类别/权重', () => {
    const items = parseMemoryItems(
      '```json\n{"memories":[{"big":"喜好","small":"咖啡","content":"用户每天手冲咖啡","weight":1.7},' +
        '{"big":"","small":"作息","content":"用户习惯熬夜","weight":"0.4"},{"content":""}]}\n```',
    );
    assert.equal(items.length, 2);
    assert.equal(items[0].big, '喜好');
    assert.equal(items[0].weight, 1);
    assert.equal(items[1].big, '其他');
    assert.equal(items[1].weight, 0.4);
  });

  it('无可用模型时返回 null，不向调度器抛错', async () => {
    const out = await runMemoryExtraction({ user_id: userA.id, character_id: charA.id }, { characterId: charA.id });
    assert.equal(out, null);
  });

  it('硬限额时直接跳过，不调用模型', async () => {
    savePrefs(userC.id, { limits: { hardTokens: 1, softTokens: 0 } });
    recordUsage({ userId: userC.id, characterId: charC.id, kind: 'main', model: 'gpt-4o-mini', usage: { input: 10, output: 10 } });
    assert.equal(limitState(userC.id).state, 'hard');
    const out = await runMemoryExtraction({ user_id: userC.id, character_id: charC.id }, { characterId: charC.id });
    assert.equal(out.skipped, true);
    assert.equal(out.reason, 'hard_limit');
  });
});

// ---------------------------------------------------------------- 日记 / 书架

const DIARY_CODE = '246810';
const DIARY_DAY = dayKey();
const DIARY_TEXT = '今天他把咖啡磨得比平时细，屋子里的味道让人安心。';
const diaryBookId = `bk_${uuid().replace(/-/g, '').slice(0, 16)}`;
run(
  `INSERT INTO books(id, user_id, character_id, type, title, content, day, meta, created_at, updated_at)
   VALUES(?,?,?,?,?,?,?,?,?,?)`,
  diaryBookId,
  userA.id,
  charA.id,
  'diary',
  encryptText(userA.id, '十一月一日：磨豆子的声音'),
  encryptText(userA.id, DIARY_TEXT),
  DIARY_DAY,
  encryptText(userA.id, '{}'),
  nowIso(),
  nowIso(),
);
{
  const { hash, salt } = hashPassword(DIARY_CODE);
  run(
    'INSERT INTO diary_locks(character_id, day, hash, salt, hint, created_at) VALUES(?,?,?,?,?,?)',
    charA.id,
    DIARY_DAY,
    hash,
    salt,
    encryptText(userA.id, '线索藏在磨豆机旁的便签上'),
    nowIso(),
  );
}

describe('书架与日记', () => {
  it('列表不含日记正文与未解锁内容', async () => {
    const { status, json } = await api(`/api/books?characterId=${charA.id}&type=diary`, { token: userA.token });
    assert.equal(status, 200);
    assert.equal(json.items.length, 1);
    const item = json.items[0];
    assert.equal(item.type, 'diary');
    assert.equal(item.locked, true);
    assert.equal(item.content, undefined);
    assert.equal(item.excerpt, null);
    assert.ok(item.title.includes('磨豆子'));
  });

  it('未带密码读取详情返回 401，错误密码返回 400', async () => {
    const noPwd = await api(`/api/books/${diaryBookId}`, { token: userA.token });
    assert.equal(noPwd.status, 401);
    assert.equal(noPwd.json.error.code, 'diary_locked');
    assert.ok(noPwd.json.error.detail.hint.includes('便签'));

    const wrong = await api(`/api/books/${diaryBookId}?password=000000`, { token: userA.token });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.json.error.code, 'diary_password_invalid');
  });

  it('正确密码解锁并返回当日日记内容', async () => {
    const wrong = await api('/api/books/diary/unlock', {
      token: userA.token,
      method: 'POST',
      body: { characterId: charA.id, password: '123456' },
    });
    assert.equal(wrong.status, 400);

    const ok = await api('/api/books/diary/unlock', {
      token: userA.token,
      method: 'POST',
      body: { characterId: charA.id, password: DIARY_CODE },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    assert.equal(ok.json.day, DIARY_DAY);
    assert.equal(ok.json.diary.content, DIARY_TEXT);
    // 任何响应都不回传密码
    assert.ok(!JSON.stringify(ok.json).includes(DIARY_CODE));

    const verdict = verifyDiaryPassword(charA.id, DIARY_DAY, DIARY_CODE);
    assert.equal(verdict.ok, true);
  });

  it('密码只存哈希：台账内没有明文密码', () => {
    const row = get('SELECT * FROM diary_locks WHERE character_id = ? AND day = ?', charA.id, DIARY_DAY);
    assert.ok(row.hash && row.hash !== DIARY_CODE);
    assert.notEqual(row.salt, DIARY_CODE);
    assert.ok(!JSON.stringify(row).includes(DIARY_CODE));
  });

  it('lock-status 返回 locked/day/hint 且不含密码', async () => {
    const { status, json } = await api(`/api/books/diary/lock-status?characterId=${charA.id}`, { token: userA.token });
    assert.equal(status, 200);
    assert.equal(json.locked, true);
    assert.equal(json.day, DIARY_DAY);
    assert.equal(json.hint, '线索藏在磨豆机旁的便签上');
    assert.equal(json.diaryId, diaryBookId);
    assert.equal(json.password, undefined);
    assert.ok(!JSON.stringify(json).includes(DIARY_CODE));
  });

  it('日记与其他角色/用户隔离', async () => {
    const other = await api(`/api/books/${diaryBookId}`, { token: userB.token });
    assert.equal(other.status, 404);
    const otherUnlock = await api('/api/books/diary/unlock', {
      token: userB.token,
      method: 'POST',
      body: { characterId: charA.id, password: DIARY_CODE },
    });
    assert.equal(otherUnlock.status, 404);
  });

  it('手动创作入库，正文加密且返回解密内容', async () => {
    const created = await api('/api/books', {
      token: userA.token,
      method: 'POST',
      body: { characterId: charA.id, type: 'essay', title: '磨豆机的清晨', content: '清晨的光落在磨豆机上。' },
    });
    assert.equal(created.status, 201);
    assert.equal(created.json.book.type, 'essay');
    assert.equal(created.json.book.content, '清晨的光落在磨豆机上。');
    const row = get('SELECT content FROM books WHERE id = ?', created.json.book.id);
    assert.ok(row.content.startsWith('c2.'), '正文必须加密存储');
  });
});

// ---------------------------------------------------------------- 限额

describe('限额降级', () => {
  it('软限额跳过新闻阅读与创作', async () => {
    savePrefs(userA.id, { limits: { softTokens: 1, hardTokens: 0 } });
    recordUsage({ userId: userA.id, characterId: charA.id, kind: 'main', model: 'gpt-4o-mini', usage: { input: 5, output: 5 } });
    assert.equal(limitState(userA.id).state, 'soft');

    const news = await runNews({ user_id: userA.id, character_id: charA.id }, { characterId: charA.id });
    assert.equal(news.skipped, true);
    assert.equal(news.reason, 'soft_limit');

    const diary = await runCreation({ user_id: userA.id, character_id: charA.id }, { characterId: charA.id, type: 'diary' });
    assert.equal(diary.skipped, true);
    assert.equal(diary.reason, 'soft_limit');

    const novel = await runCreation({ user_id: userA.id, character_id: charA.id }, { characterId: charA.id, type: 'novel' });
    assert.equal(novel.skipped, true);

    // 恢复限额，避免影响后续
    savePrefs(userA.id, { limits: { softTokens: 0, hardTokens: 0 } });
    assert.equal(limitState(userA.id).state, 'ok');
  });
});

// ---------------------------------------------------------------- 纯逻辑

describe('新闻与创作纯逻辑', () => {
  it('解析 RSS 与 Atom', () => {
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>
      <item><title>城市里的猫</title><link>https://example.com/1</link><description>&lt;p&gt;一只猫的故事&lt;/p&gt;</description></item>
      <item><title>夜跑手记</title><link>https://example.com/2</link><description>跑步</description></item>
    </channel></rss>`;
    const rssItems = rssItemsFromXml(rss, 'https://example.com/rss');
    assert.equal(rssItems.length, 2);
    assert.equal(rssItems[0].title, '城市里的猫');
    assert.equal(rssItems[0].url, 'https://example.com/1');
    assert.equal(rssItems[0].summary, '一只猫的故事');
    assert.equal(rssItems[0].source, 'https://example.com/rss');

    const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>A</title>
      <entry><title>Atom 条目</title><link href="https://example.com/a"/><summary>摘要内容</summary></entry></feed>`;
    const atomItems = rssItemsFromXml(atom, 'https://example.com/atom');
    assert.equal(atomItems.length, 1);
    assert.equal(atomItems[0].title, 'Atom 条目');
    assert.equal(atomItems[0].url, 'https://example.com/a');
    assert.equal(atomItems[0].summary, '摘要内容');

    assert.deepEqual(rssItemsFromXml('不是 xml', 'x'), []);
  });

  it('只取前几条热门 + 中位区间随机几条，不重复', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ title: `hot-${i}`, url: `u${i}`, hot: 100 - i }));
    const picked = pickItems(items, { top: 3, mid: 2, rng: () => 0 });
    assert.equal(picked.all.length, 5);
    assert.deepEqual(picked.hot.map((i) => i.title), ['hot-0', 'hot-1', 'hot-2']);
    assert.equal(picked.mid.length, 2);
    for (const it of picked.mid) assert.ok(!picked.hot.includes(it));
    assert.equal(new Set(picked.all.map((i) => i.title)).size, 5);
    assert.deepEqual(pickItems([], {}).all, []);
  });

  it('创作内容过滤色情/暴力/未成年，保留正常段落', () => {
    const safe = sanitizeCreation('夜色很安静。\n他们开始做爱的描写。\n她笑了笑，把灯调暗。');
    assert.equal(safe.filtered, true);
    assert.equal(safe.hits, 1);
    assert.ok(!safe.text.includes('做爱'));
    assert.ok(safe.text.includes('夜色很安静'));
    assert.ok(safe.text.includes('她笑了笑'));

    const allBad = sanitizeCreation('血腥的肢解描写。');
    assert.equal(allBad.text.length > 0, true);
    assert.ok(!allBad.text.includes('肢解'));

    const clean = sanitizeCreation('城市在雨里慢慢亮起来。');
    assert.equal(clean.filtered, false);
    assert.equal(clean.text, '城市在雨里慢慢亮起来。');
  });

  it('创作频率判定：off 关闭、daily 每日、hourly 约每小时', () => {
    const now = Date.parse('2026-11-01T12:00:00.000Z');
    assert.equal(creationDue({ creationFrequency: 'off' }, { lastAt: null, now }).due, false);
    assert.equal(creationDue({ creationFrequency: 'daily' }, { lastAt: null, now }).due, true);
    assert.equal(
      creationDue({ creationFrequency: 'daily' }, { lastAt: new Date(now - 3600000).toISOString(), now }).due,
      false,
    );
    assert.equal(
      creationDue({ creationFrequency: 'daily' }, { lastAt: new Date(now - 86400000).toISOString(), now }).due,
      true,
    );
    assert.equal(
      creationDue({ creationFrequency: 'hourly' }, { lastAt: new Date(now - 10 * 60000).toISOString(), now }).due,
      false,
    );
  });

  it('图构建函数在空角色上返回单节点，语义检索可降级', async () => {
    const graph = buildGraph(userC.id, charC.id, '小满');
    assert.equal(graph.nodes.length, 1);
    assert.equal(graph.nodes[0].id, 'agent');
    assert.deepEqual(graph.links, [], '空态应返回 links: []');
    const detail = memoryDetail(userB.id, memB1.id);
    assert.ok(detail);
    assert.equal(detail.links.length, 0);
    // 语义检索在无嵌入配置下不抛错
    const res = await searchMemories(userB.id, charB.id, '吉他');
    assert.equal(res.mode, 'keyword');
    assert.equal(res.items[0].id, memB1.id);
  });
});


// ---------------------------------------------------------------- 调度器兼容

describe('调度器兼容与巡检', () => {
  it('兼容 scheduler 的 {job,payload,userId,characterId} 调用约定', async () => {
    const ctx = {
      job: { id: 'j_test', type: 'memory', user_id: userC.id, character_id: charC.id },
      payload: {},
      userId: userC.id,
      characterId: charC.id,
    };
    const out = await runMemoryExtraction(ctx);
    assert.equal(out.skipped, true);
    assert.equal(out.reason, 'hard_limit');
    // 传统两参调用同样可用
    const direct = await runMemoryExtraction({ user_id: userC.id, character_id: charC.id }, { characterId: charC.id });
    assert.equal(direct.skipped, true);
  });

  it('recallForChat 同时支持对象/位置参数，返回 big/small：content 文本', async () => {
    const text = await recallForChat({ userId: userA.id, characterId: charA.id, query: '火锅' });
    assert.ok(text.includes('火锅'), '应召回含关键词的记忆');
    assert.match(text, /^喜好\/食物：/m, '行格式为 大类/小类：内容');
    assert.equal(text.split('\n').length >= 1, true);

    const positional = await recallForChat(userA.id, charA.id, '火锅', { limit: 2 });
    assert.ok(positional.includes('火锅'));
    // 记忆行 ≤ limit，另加 1 行当日日记密码上下文
    assert.ok(positional.split('\n').length <= 3);

    // 有记忆但无命中：按权重补足 topN，保证角色始终「记得」用户（无记忆才返回 ''）
    const fallback = await recallForChat(userA.id, charA.id, '绝无此词');
    assert.ok(fallback.includes('喜好/'), '无命中应退回按权重补足');
    assert.ok(fallback.split('\n').length <= 9);
    assert.equal(await recallForChat({ userId: userC.id, characterId: charC.id, query: '随便' }), '');
    assert.equal(await recallForChat(null, null, null), '');
  });

  it('job 缺字段时四类处理器返回 skipped 而不抛错', async () => {
    for (const fn of [runMemoryExtraction, runPortrait, runNews, runCreation]) {
      const out = await fn(null, {});
      assert.equal(out.skipped, true);
      assert.equal(out.reason, 'missing_context');
      const out2 = await fn({ user_id: userA.id }, {});
      assert.equal(out2.skipped, true);
    }
  });

  it('巡检补排新闻/创作任务且重复调用去重', async () => {
    const first = await bootstrapAiMemoryJobs();
    assert.ok(first.characters >= 3);
    assert.ok(first.news >= 1, '应为无当日浏览记录的角色排新闻任务');
    assert.ok(first.creation >= 1, '应按频率排创作任务');
    const second = await bootstrapAiMemoryJobs();
    assert.equal(second.news, 0);
    assert.equal(second.creation, 0);
  });
});
