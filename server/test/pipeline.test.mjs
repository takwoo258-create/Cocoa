// 端到端管线：对话 → 记忆抽取 → 画像 → 创作 → 记忆图（全部本地 mock，无外网）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cocoa-pipeline-'));
process.env.COCOA_DATA_DIR = DATA_DIR;
process.env.COCOA_LOG_LEVEL = 'error';
process.env.COCOA_ADMIN_EMAIL = 'admin@pipeline.test';
process.env.COCOA_ADMIN_PASSWORD = 'Admin123456';

const { createMockOpenAI } = await import('./mock-openai.mjs');
const { createApp } = await import('../src/app.js');
const { attachWebSocket } = await import('../src/realtime/hub.js');
const { ensureBootstrapAdmin } = await import('../src/services/bootstrap.js');
const { enqueue } = await import('../src/services/jobs.js');
const { tick } = await import('../src/ai/scheduler.js');
const { all } = await import('../src/db/index.js');

const mock = await createMockOpenAI();
ensureBootstrapAdmin();
const server = http.createServer(createApp());
attachWebSocket(server, '/ws');
server.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function api(pathname, { method = 'GET', body, token } = {}) {
  const res = await fetch(base + pathname, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

test('对话→记忆→画像→创作 全链路', { timeout: 150_000 }, async () => {
  const code = (await api('/api/auth/send-code', { method: 'POST', body: { email: 'p@pipeline.test', purpose: 'register' } })).json.devCode;
  const reg = await api('/api/auth/register', {
    method: 'POST',
    body: { username: 'pipeline', email: 'p@pipeline.test', password: 'Passw0rd!', confirmPassword: 'Passw0rd!', qq: '55555', code },
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.json));
  const token = reg.json.token;
  const userId = reg.json.user.id;

  const cfg = await api('/api/config/api', {
    method: 'PUT',
    token,
    body: {
      chat: { baseUrl: mock.baseUrl, apiKey: 'sk-mock', model: 'gpt-4o-mini' },
      embedding: { baseUrl: mock.baseUrl, apiKey: 'sk-mock', model: 'text-embedding-3-small' },
      stt: { baseUrl: mock.baseUrl, apiKey: 'sk-mock', model: 'whisper-1' },
      tts: { baseUrl: mock.baseUrl, apiKey: 'sk-mock', model: 'tts-1' },
      deepseek: { baseUrl: mock.baseUrl, apiKey: 'sk-mock', model: 'deepseek-chat' },
      search: { baseUrl: mock.baseUrl, apiKey: 'sk-mock', model: 'deepseek-chat' },
    },
  });
  assert.equal(cfg.status, 200);

  const created = await api('/api/characters', {
    method: 'POST',
    token,
    body: {
      name: '可可', age: '20', race: '人类', gender: '女', personality: '温柔', worldview: '都市',
      hobbies: '烘焙', relation: '恋人', appearance: '黑发', occupation: '店长',
      settings: { sleep: { enabled: false } },
    },
  });
  assert.equal(created.status, 201);
  const characterId = created.json.character.id;

  const sent = await api(`/api/characters/${characterId}/messages`, {
    method: 'POST', token, body: { kind: 'text', text: '我最喜欢吃火锅，讨厌被敷衍。' },
  });
  assert.ok([200, 201].includes(sent.status), JSON.stringify(sent.json));
  assert.equal(sent.json.accepted, true);

  // 等智能体回复落库（mock 即时返回，CPU 紧张时放宽到 90s）
  let agentMessages = 0;
  for (let i = 0; i < 180; i++) {
    await new Promise((r) => setTimeout(r, 500));
    agentMessages = all("SELECT id FROM messages WHERE role = 'agent' AND character_id = ?", characterId).length;
    if (agentMessages > 0) break;
  }
  assert.ok(agentMessages > 0, '未生成智能体回复');

  // 手动触发后台任务并跑一轮调度
  enqueue('memory_extract', new Date().toISOString(), {}, { userId, characterId });
  enqueue('portrait', new Date().toISOString(), { force: true }, { userId, characterId });
  enqueue('creation', new Date().toISOString(), { type: 'diary' }, { userId, characterId });
  const result = await tick({ limit: 10 });
  assert.ok(result.processed >= 3, `调度处理任务过少: ${JSON.stringify(result)}`);

  const memories = all('SELECT big, small, weight FROM memories WHERE character_id = ?', characterId);
  assert.ok(memories.length >= 1, '记忆抽取未写入');

  const portraits = all('SELECT id FROM portraits WHERE character_id = ?', characterId);
  assert.ok(portraits.length >= 1, '画像未生成');

  const diaries = all("SELECT id FROM books WHERE character_id = ? AND type = 'diary'", characterId);
  assert.ok(diaries.length >= 1, '日记未生成');

  const graph = await api(`/api/memory/graph?characterId=${characterId}`, { token });
  assert.equal(graph.status, 200);
  const types = new Set(graph.json.nodes.map((n) => n.type));
  assert.ok(types.has('agent') && types.has('category') && types.has('memory'), `图节点类型缺失: ${[...types]}`);
  assert.ok(graph.json.links.length >= 1, '缺少连线');

  const lock = await api(`/api/books/diary/lock-status?characterId=${characterId}`, { token });
  assert.equal(lock.status, 200);

  // 会话隔离：另一个用户看不到该角色
  const code2 = (await api('/api/auth/send-code', { method: 'POST', body: { email: 'q@pipeline.test', purpose: 'register' } })).json.devCode;
  const reg2 = await api('/api/auth/register', {
    method: 'POST',
    body: { username: 'other', email: 'q@pipeline.test', password: 'Passw0rd!', confirmPassword: 'Passw0rd!', qq: '55556', code: code2 },
  });
  const otherToken = reg2.json.token;
  const peek = await api(`/api/memory/graph?characterId=${characterId}`, { token: otherToken });
  assert.equal(peek.status, 404, '跨用户访问记忆应 404');
});

test.after(async () => {
  server.close();
  await mock.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});
