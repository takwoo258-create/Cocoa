// v1.5 记忆系统单测：抽取/去重/补向量/召回/访问回写/三维图/接口隔离
// 运行：COCOA_DATA_DIR=/tmp/cocoa-ai-memory PORT=18083 node --test server/test/memory.test.mjs
// 使用本地假 OpenAI 服务（chat + embeddings），不访问外网。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import test, { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const BASE = String(process.env.COCOA_DATA_DIR || '/tmp/cocoa-ai-memory');
const SAFE_BASE = BASE.startsWith('/tmp/') || BASE.includes('/.tmp/') || BASE.includes('cocoa') ? BASE : '/tmp/cocoa-ai-memory';
const DATA_DIR = path.join(SAFE_BASE, 'memory-suite');
fs.rmSync(DATA_DIR, { recursive: true, force: true });
process.env.COCOA_DATA_DIR = DATA_DIR;
process.env.PORT = process.env.PORT || '18083';
process.env.COCOA_LOG_LEVEL = 'error';
process.env.COCOA_EMBEDDING_API_KEY = '';
process.env.COCOA_EMBEDDING_BASE_URL = '';
process.env.COCOA_SEARCH_API_KEY = '';

// ---------------------------------------------------------------- 假 OpenAI 服务

function sendJson(res, obj, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

/** 确定性向量：按主题落维，便于精确断言相似/不相似 */
export function fakeEmbedding(text, dims = 8) {
  const t = String(text ?? '');
  const v = new Array(dims).fill(0);
  if (/香菜/.test(t)) v[3] = 1;
  else if (/火锅|辣|花椒/.test(t)) v[0] = 1;
  if (/咖啡|豆子|手冲/.test(t)) v[1] = 1;
  if (/后摇|音乐|夜晚/.test(t)) v[2] = 1;
  if (/称呼|小朋友|叫/.test(t)) v[4] = 1;
  if (/加班|焦虑|工作/.test(t)) v[5] = 1;
  if (/猫|狗|宠物/.test(t)) v[6] = 1;
  v[7] = 0.12;
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => Math.round((x / norm) * 1e6) / 1e6);
}

function extractionReply(state) {
  if (state.extractMode === 'invalid-then-valid') {
    if (!state.invalidSent) {
      state.invalidSent = true;
      return '抱歉，这次没有可记录的内容。';
    }
    return JSON.stringify({
      memories: [
        { type: 'preference', big: '喜好', small: '咖啡', content: '用户每天手冲咖啡，偏爱浅烘', weight: 0.62, emotion: '喜爱', keywords: ['咖啡', '手冲'] },
      ],
    });
  }
  if (state.extractMode === 'merge') {
    return JSON.stringify({
      memories: [
        { type: 'preference', big: '喜好', small: '食物', content: '用户特别爱吃辣，火锅是最爱', weight: 0.75, emotion: '喜爱', keywords: ['火锅', '辣'] },
      ],
    });
  }
  return JSON.stringify({
    memories: [
      { type: 'preference', big: '喜好', small: '食物', content: '用户爱吃辣，火锅是首选', weight: 0.72, emotion: '喜爱', keywords: ['火锅', '辣'] },
      { type: 'preference', big: '喜好', small: '食物', content: '用户不吃香菜，闻到就皱眉', weight: 0.6, emotion: '厌恶', keywords: ['香菜'] },
      { type: 'dislike', big: '雷点', small: '称呼', content: '用户讨厌被叫小朋友', weight: 0.8, emotion: '厌恶', keywords: ['称呼'] },
    ],
  });
}

async function startFakeProvider() {
  const state = { extractMode: 'structured', invalidSent: false };
  const counters = { chat: 0, embed: 0, extract: 0 };
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
        return sendJson(res, {
          object: 'list',
          data: [
            { id: 'gpt-4o-mini', object: 'model' },
            { id: 'text-embedding-3-small', object: 'model' },
          ],
        });
      }
      if (req.method === 'POST' && pathname === '/embeddings') {
        counters.embed++;
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
          model: body.model || 'text-embedding-3-small',
          usage: { prompt_tokens: inputs.join('').length, total_tokens: inputs.join('').length },
        });
      }
      if (req.method === 'POST' && pathname === '/chat/completions') {
        counters.chat++;
        const messages = body.messages || [];
        const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
        let content = JSON.stringify({ type: 'message', content: '嗯，我在。' });
        if (/记忆压缩器/.test(system)) {
          content = '他今天聊了火锅和咖啡，心情不错；记得他讨厌被叫小朋友。';
        } else if (/用户特征抽取器/.test(system)) {
          counters.extract++;
          content = extractionReply(state);
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
    counters,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const fake = await startFakeProvider();

// ---------------------------------------------------------------- 模块与数据

const { run, get, all } = await import('../src/db/index.js');
const { signToken, sha256, encryptText, decryptText } = await import('../src/core/crypto.js');
const { nowIso, uuid, dayKey } = await import('../src/core/util.js');
const memory = await import('../src/ai/memory.js');
const { saveUserApi, savePrefs } = await import('../src/services/settings.js');
const { createCharacter, saveSettings } = await import('../src/services/characters.js');
const memoryRouter = (await import('../src/routes/memory.js')).default;
const portrait = await import('../src/ai/portrait.js');

const app = express();
app.use(express.json());
app.use('/api/memory', memoryRouter());
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

async function api(p, { token, method = 'GET', body } = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function configureApi(userId) {
  saveUserApi(userId, {
    chat: { baseUrl: `${fake.baseUrl}/v1`, apiKey: 'sk-test', model: 'gpt-4o-mini' },
    embedding: { baseUrl: `${fake.baseUrl}/v1`, apiKey: 'sk-test', model: 'text-embedding-3-small' },
  });
}

function insertMessage(userId, characterId, role, content, { secondsAgo = 0, kind = 'text' } = {}) {
  run(
    `INSERT INTO messages(id, conversation_id, character_id, user_id, role, kind, content, meta, tokens_in, tokens_out, created_at)
     VALUES(?,?,?,?,?,?,?,NULL,0,0,?)`,
    `m_${uuid().replace(/-/g, '').slice(0, 16)}`,
    'conv_test',
    characterId,
    userId,
    role,
    kind,
    encryptText(userId, content),
    new Date(Date.now() - secondsAgo * 1000).toISOString(),
  );
}

const userA = createUser('mem_a');
const userB = createUser('mem_b');
configureApi(userA.id);
configureApi(userB.id);
const charA = createCharacter(userA.id, { name: '可可', personality: '温柔', relation: '恋人' });
const charB = createCharacter(userB.id, { name: '青禾', personality: '冷淡' });

// ---------------------------------------------------------------- 抽取

describe('记忆抽取 v1.5', () => {
  it('首次抽取：结构化 JSON（type/情绪/权重）落库并生成向量与关联', async () => {
    insertMessage(userA.id, charA.id, 'user', '我超爱吃火锅，无辣不欢', { secondsAgo: 90 });
    insertMessage(userA.id, charA.id, 'agent', '那我记住啦，下次带你去吃最辣的那家', { secondsAgo: 60 });
    fake.state.extractMode = 'structured';
    fake.counters.extract = 0;

    const res = await memory.runMemoryExtraction({ user_id: userA.id, character_id: charA.id }, {});
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.inserted, 3);
    assert.equal(res.merged, 0);
    assert.equal(fake.counters.extract, 1);

    const rows = all('SELECT * FROM memories WHERE user_id = ? AND character_id = ?', userA.id, charA.id);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.embedding && r.embedding.length > 0), '每条记忆都要有向量');
    assert.ok(rows.every((r) => String(r.content).startsWith('c2.')), '记忆内容必须加密');
    const hotpot = rows.find((r) => memory.safeDecrypt(userA.id, r.content).includes('火锅'));
    assert.equal(hotpot.big, '喜好');
    assert.equal(hotpot.small, '食物');
    assert.equal(hotpot.emotion, '喜爱');
    assert.ok(hotpot.weight >= 0.72);
    assert.equal(hotpot.use_count, 0);
    assert.equal(hotpot.last_used_at, null);
    const dislike = rows.find((r) => r.big === '雷点');
    assert.equal(dislike.emotion, '厌恶');

    // 同类目小类下自动建链（同类/同实体）
    const links = all('SELECT * FROM memory_links');
    const ids = rows.map((r) => r.id);
    assert.ok(links.some((l) => ids.includes(l.a) && ids.includes(l.b) && l.score >= 0.55), '同类记忆应建立关联');

    // 游标推进
    m_assertCursor(userA.id, charA.id);
  });

  it('未达触发阈值（1 条新消息且 <5 分钟）时跳过', async () => {
    insertMessage(userA.id, charA.id, 'user', '今天好热', { secondsAgo: 0 });
    const res = await memory.runMemoryExtraction({ user_id: userA.id, character_id: charA.id }, {});
    assert.equal(res.skipped, true);
    assert.equal(res.reason, 'below_threshold');
  });

  it('≥2 条新用户消息时再次抽取，并去重合并（embedding 相近）', async () => {
    insertMessage(userA.id, charA.id, 'user', '今天又去吃了火锅，超辣', { secondsAgo: -8 });
    insertMessage(userA.id, charA.id, 'user', '辣得我直冒汗，但是好爽', { secondsAgo: -5 });
    fake.state.extractMode = 'merge';
    const before = all('SELECT id, weight, use_count FROM memories WHERE user_id = ? AND character_id = ?', userA.id, charA.id);
    const hotpotBefore = before.find((r) => memory.safeDecrypt(userA.id, get('SELECT content FROM memories WHERE id = ?', r.id).content).includes('火锅'));
    assert.ok(hotpotBefore, '抽取前应已有火锅记忆');

    const res = await memory.runMemoryExtraction({ user_id: userA.id, character_id: charA.id }, {});
    assert.equal(res.ok, true);
    assert.equal(res.merged, 1);
    assert.equal(res.inserted, 0);

    const afterRows = all('SELECT * FROM memories WHERE user_id = ? AND character_id = ?', userA.id, charA.id);
    assert.equal(afterRows.length, before.length, '合并后条数不增加');
    const hotpot = afterRows.find((r) => memory.safeDecrypt(userA.id, r.content).includes('火锅'));
    assert.ok(hotpot, '火锅记忆仍在');
    assert.equal(hotpot.id, hotpotBefore.id, '应合并到原记忆而不是新建');
    assert.ok(hotpot.weight > hotpotBefore.weight, `合并后权重应抬高: ${hotpot.weight}`);
    assert.ok(hotpot.use_count >= 1, '合并视为一次访问');
    assert.ok(memory.safeDecrypt(userA.id, hotpot.content).includes('最爱'), '内容应合并新细节');
  });

  it('模型输出非法 JSON 时自动重试一次', async () => {
    const u = createUser('mem_retry');
    configureApi(u.id);
    const c = createCharacter(u.id, { name: '迟', personality: '安静' });
    insertMessage(u.id, c.id, 'user', '我每天早上都手冲咖啡', { secondsAgo: 30 });
    insertMessage(u.id, c.id, 'user', '浅烘的豆子更香', { secondsAgo: 20 });
    fake.state.extractMode = 'invalid-then-valid';
    fake.state.invalidSent = false;
    fake.counters.extract = 0;

    const res = await memory.runMemoryExtraction({ user_id: u.id, character_id: c.id }, {});
    assert.equal(res.ok, true);
    assert.equal(fake.counters.extract, 2, '应重试一次');
    const rows = all('SELECT * FROM memories WHERE user_id = ? AND character_id = ?', u.id, c.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].small, '咖啡');
  });

  it('prefs.autoMemory=false 时自动抽取跳过', async () => {
    const u = createUser('mem_off');
    configureApi(u.id);
    const c = createCharacter(u.id, { name: '眠', personality: '困' });
    insertMessage(u.id, c.id, 'user', '我喜欢下雨天', { secondsAgo: 10 });
    savePrefs(u.id, { autoMemory: false });
    assert.equal(memory.autoMemoryEnabled(u.id), false);
    const res = await memory.runMemoryExtraction({ user_id: u.id, character_id: c.id }, {});
    assert.equal(res.skipped, true);
    assert.equal(res.reason, 'auto_memory_off');
    // 手动 force 仍可执行（用户显式要求）
    const forced = await memory.runMemoryExtraction({ user_id: u.id, character_id: c.id }, { force: true });
    assert.equal(forced.ok, true);
  });

  it('角色关闭（settings.enabled=false）时跳过', async () => {
    const u = createUser('mem_disabled');
    configureApi(u.id);
    const c = createCharacter(u.id, { name: '闭', personality: '睡' });
    insertMessage(u.id, c.id, 'user', '在吗', { secondsAgo: 10 });
    saveSettings(c.id, u.id, { enabled: false });
    const res = await memory.runMemoryExtraction({ user_id: u.id, character_id: c.id }, {});
    assert.equal(res.skipped, true);
    assert.equal(res.reason, 'character_disabled');
  });

  it('缺失向量自动补齐并建立关联', async () => {
    const rows = all('SELECT id FROM memories WHERE user_id = ? AND character_id = ?', userA.id, charA.id).slice(0, 1);
    run('UPDATE memories SET embedding = NULL WHERE id = ?', rows[0].id);
    const res = await memory.backfillEmbeddings({ userId: userA.id, characterId: charA.id });
    assert.ok(res.filled >= 1, JSON.stringify(res));
    const row = get('SELECT embedding FROM memories WHERE id = ?', rows[0].id);
    assert.ok(row.embedding && row.embedding.length > 0);
  });
});

function m_assertCursor(userId, characterId) {
  const cursor = get('SELECT value FROM meta WHERE key = ?', `memory:since:${userId}:${characterId}`);
  assert.ok(cursor?.value, '应写入抽取游标');
  const lastAt = get('SELECT value FROM meta WHERE key = ?', `memory:last_at:${userId}:${characterId}`);
  assert.ok(lastAt?.value, '应写入触发时间戳');
}


// ---------------------------------------------------------------- 召回

describe('记忆召回 v1.5', () => {
  it('语义检索命中 + 高权重兜底 + 访问回写', async () => {
    const rowsBefore = all('SELECT id, use_count, last_used_at, weight FROM memories WHERE user_id = ? AND character_id = ?', userA.id, charA.id);
    const text = await memory.recallForChat(userA.id, charA.id, '火锅', { limit: 6 });
    assert.ok(text.includes('喜好/食物：'), '格式为 大类/小类：内容');
    assert.ok(text.includes('火锅'));
    const lines = text.split('\n').filter(Boolean);
    assert.ok(lines.length <= 6, `注入条数不应超过 limit: ${lines.length}`);
    assert.ok(lines.length >= 3, '应包含高权重兜底');

    const rowsAfter = all('SELECT id, use_count, last_used_at, weight FROM memories WHERE user_id = ? AND character_id = ?', userA.id, charA.id);
    const touched = rowsAfter.filter((r) => r.use_count > (rowsBefore.find((b) => b.id === r.id)?.use_count || 0));
    assert.ok(touched.length >= 1, '召回命中应回写 use_count');
    assert.ok(touched.every((r) => r.last_used_at), '召回命中应回写 last_used_at');
    assert.ok(touched.every((r) => r.weight >= (rowsBefore.find((b) => b.id === r.id)?.weight || 0)), '访问应提升或保持权重');
  });

  it('无查询词时注入高权重 top-k', async () => {
    const total = get('SELECT COUNT(*) n FROM memories WHERE user_id = ? AND character_id = ?', userA.id, charA.id).n;
    const text = await memory.recallForChat(userA.id, charA.id, '', { limit: 4 });
    const lines = text.split('\n').filter(Boolean);
    assert.equal(lines.length, Math.min(4, total));
    assert.ok(lines.every((l) => l.includes('/')));
  });

  it('日记密码注入：角色知道密码但只能暗示；密码不写进记忆表', async () => {
    const day = dayKey();
    run(
      `INSERT INTO books(id, user_id, character_id, type, title, content, day, meta, created_at, updated_at)
       VALUES(?,?,?,'diary',?,?,?,?,?,?)`,
      `bk_${uuid().replace(/-/g, '').slice(0, 16)}`,
      userA.id,
      charA.id,
      encryptText(userA.id, '今天的日记'),
      encryptText(userA.id, '雨下了一整天，我把窗台擦干净了。'),
      day,
      encryptText(userA.id, '{}'),
      nowIso(),
      nowIso(),
    );
    const lock = memory.ensureDiaryCode(userA.id, charA.id);
    assert.match(lock.code, /^\d{6}$/);
    assert.ok(lock.hint && lock.hint.length > 4);
    const code = lock.code;
    const text = await memory.recallForChat(userA.id, charA.id, '今天写了什么', { limit: 6 });
    assert.ok(text.includes('日记密码是'), '应注入密码上下文');
    assert.ok(text.includes(code), '应包含当日密码');
    assert.ok(text.includes('绝不能直接说出'), '应包含不可直说的约束');
    // 数据库中不得出现明文密码
    const memTexts = all('SELECT content FROM memories WHERE user_id = ?', userA.id)
      .map((r) => memory.safeDecrypt(userA.id, r.content))
      .join('\n');
    assert.ok(!memTexts.includes(code), '密码不能写入记忆表');
  });

  it('其他用户不能召回该角色的记忆', async () => {
    const text = await memory.recallForChat(userB.id, charA.id, '火锅', { limit: 4 });
    assert.equal(text, '');
  });
});

// ---------------------------------------------------------------- 三维图

describe('记忆三维图 v1.5', () => {
  it('坐标稳定、按质心居中、含 level/weight/glow', () => {
    const g1 = memory.buildGraph(userA.id, charA.id, '可可');
    const g2 = memory.buildGraph(userA.id, charA.id, '可可');
    assert.deepEqual(
      g1.nodes.map((n) => [n.id, n.x, n.y, n.z]),
      g2.nodes.map((n) => [n.id, n.x, n.y, n.z]),
      '同一份数据两次请求坐标必须完全一致',
    );
    assert.equal(g1.layout.centered, true);
    assert.equal(g1.layout.type, 'sphere');

    const sum = g1.nodes.reduce((acc, n) => ({ x: acc.x + n.x, y: acc.y + n.y, z: acc.z + n.z }), { x: 0, y: 0, z: 0 });
    assert.ok(Math.abs(sum.x / g1.nodes.length) < 0.02);
    assert.ok(Math.abs(sum.y / g1.nodes.length) < 0.02);
    assert.ok(Math.abs(sum.z / g1.nodes.length) < 0.02);

    for (const n of g1.nodes) {
      assert.equal(typeof n.x, 'number');
      assert.equal(typeof n.y, 'number');
      assert.equal(typeof n.z, 'number');
      assert.ok(n.glow > 0 && n.glow <= 1);
      assert.ok(['agent', 'category', 'memory'].includes(n.type));
    }
    const levels = new Set(g1.nodes.map((n) => n.level));
    assert.ok(levels.has(0) && levels.has(1) && levels.has(2) && levels.has(3));
    assert.ok(g1.nodes.filter((n) => n.type === 'memory').every((n) => n.brightness === n.weight));
    assert.equal(g1.paletteHint.memory, '#ffffff');
  });

  it('空角色返回 agent 单节点且坐标归零', () => {
    const g = memory.buildGraph(userB.id, charB.id, '青禾');
    assert.equal(g.nodes.length, 1);
    assert.equal(g.nodes[0].id, 'agent');
    assert.equal(g.nodes[0].x, 0);
    assert.equal(g.nodes[0].y, 0);
    assert.equal(g.nodes[0].z, 0);
    assert.deepEqual(g.links, []);
  });

  it('GET /api/memory/graph 返回 3D 字段且用户隔离', async () => {
    const { status, json } = await api(`/api/memory/graph?characterId=${charA.id}`, { token: userA.token });
    assert.equal(status, 200);
    assert.ok(json.nodes.every((n) => typeof n.x === 'number'));
    assert.equal(json.layout.type, 'sphere');
    const other = await api(`/api/memory/graph?characterId=${charA.id}`, { token: userB.token });
    assert.equal(other.status, 404);
  });
});

// ---------------------------------------------------------------- 检索与接口

describe('检索 / 详情 / 删除 / 偏好', () => {
  it('语义检索返回 semantic 模式，详情含情绪与访问信息', async () => {
    const { status, json } = await api(`/api/memory/search?characterId=${charA.id}&q=火锅`, { token: userA.token });
    assert.equal(status, 200);
    assert.equal(json.mode, 'semantic');
    assert.ok(json.items.length >= 1);
    assert.ok(json.items[0].content.includes('火锅'));

    const detail = await api(`/api/memory/${json.items[0].id}`, { token: userA.token });
    assert.equal(detail.status, 200);
    assert.ok(detail.json.memory.createdAt);
    assert.ok(detail.json.memory.lastUsedAt, '详情应包含访问时间');
    assert.ok(detail.json.memory.useCount >= 1);
    assert.ok(detail.json.memory.links.length >= 1, '详情应包含关联列表');
  });

  it('无嵌入 key 时检索退化为关键词', async () => {
    saveUserApi(userA.id, { embedding: { apiKey: '', baseUrl: '', model: 'text-embedding-3-small' } });
    const { json } = await api(`/api/memory/search?characterId=${charA.id}&q=火锅`, { token: userA.token });
    assert.equal(json.mode, 'keyword');
    assert.ok(json.items.length >= 1);
    configureApi(userA.id);
  });

  it('自动抽取偏好读写', async () => {
    const cur = await api('/api/memory/preferences', { token: userA.token });
    assert.equal(cur.json.autoMemory, true);
    const off = await api('/api/memory/preferences', { token: userA.token, method: 'PUT', body: { autoMemory: false } });
    assert.equal(off.json.autoMemory, false);
    assert.equal(memory.autoMemoryEnabled(userA.id), false);
    await api('/api/memory/preferences', { token: userA.token, method: 'PUT', body: { autoMemory: true } });
    assert.equal(memory.autoMemoryEnabled(userA.id), true);
  });

  it('删除记忆后不可读且关联清理', async () => {
    const rows = all('SELECT id FROM memories WHERE user_id = ? AND character_id = ?', userA.id, charA.id);
    const target = rows[rows.length - 1];
    const del = await api(`/api/memory/${target.id}`, { token: userA.token, method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal(del.json.ok, true);
    const gone = await api(`/api/memory/${target.id}`, { token: userA.token });
    assert.equal(gone.status, 404);
    const links = all('SELECT * FROM memory_links WHERE a = ? OR b = ?', target.id, target.id);
    assert.equal(links.length, 0);
    const other = await api(`/api/memory/${target.id}`, { token: userB.token, method: 'DELETE' });
    assert.equal(other.status, 404);
  });
});

// ---------------------------------------------------------------- 画像幂等

describe('画像任务幂等', () => {
  it('一小时内不重复生成，force 可绕过', async () => {
    run('UPDATE character_state SET last_portrait_at = ? WHERE character_id = ?', nowIso(), charA.id);
    const out = await portrait.runPortrait({ user_id: userA.id, character_id: charA.id }, {});
    assert.equal(out.skipped, true);
    assert.equal(out.reason, 'recent_portrait');
    // force 会进入生成流程（本环境无画像模型输出时安全返回 null 或结果，但不应再是 recent_portrait）
    const forced = await portrait.runPortrait({ user_id: userA.id, character_id: charA.id }, { force: true });
    assert.notEqual(forced?.reason, 'recent_portrait');
  });
});
