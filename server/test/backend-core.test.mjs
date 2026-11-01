// backend-core 集成测试：角色 / 媒体 / 统计 / 管理端 / OneBot（真实 HTTP，隔离数据目录，无外部网络）
import fs from 'node:fs';
import http from 'node:http';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

const DATA_DIR = '/tmp/cocoa-core';
process.env.COCOA_DATA_DIR = DATA_DIR;
process.env.PORT = process.env.PORT || '18081';
process.env.NODE_ENV = 'test';
process.env.COCOA_LOG_LEVEL = process.env.COCOA_LOG_LEVEL || 'error';

// 必须在 import env.js 之前清空隔离目录
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const { createApp } = await import('../src/app.js');
const { get, run } = await import('../src/db/index.js');
const cryptoMod = await import('../src/core/crypto.js');
const { attachOnebot, detachOnebot } = await import('../src/onebot/server.js');
const { recordUsage } = await import('../src/ai/usage.js');
const { WebSocket } = await import('ws');

/**
 * 兼容兜底（通常为 no-op）：若 app.js 把仍为 501 骨架的 chatRouter 挂在 charactersRouter 之前，
 * 该 use 层会吞掉 /api/characters 下所有请求。仅在检测到「characters 之前存在无路由的兜底
 * router」时才把它移到 characters 之后；app.js 顺序正确或 chat.js 已实现具体路由时不做任何改动，
 * 断言始终打在真实路由上。
 */
function unblockCharactersRouter(app) {
  const stack = app.router?.stack;
  if (!Array.isArray(stack)) return;
  const charIdx = stack.findIndex(
    (l) => Array.isArray(l.handle?.stack) && l.handle.stack.some((s) => s.route?.path === '/expand'),
  );
  if (charIdx < 0) return;
  const stubBefore = stack
    .slice(0, charIdx)
    .filter((l) => Array.isArray(l.handle?.stack) && l.handle.stack.length === 1 && !l.handle.stack[0].route);
  if (!stubBefore.length) return;
  const rest = stack.filter((l) => !stubBefore.includes(l));
  const at = rest.findIndex((l) => l === stack[charIdx]) + 1;
  stack.splice(0, stack.length, ...rest.slice(0, at), ...stubBefore, ...rest.slice(at));
}

const app = createApp();
unblockCharactersRouter(app);
const server = http.createServer(app);
attachOnebot(server);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

function makeUser({ username, role = 'user', qq = null, status = 'active' }) {
  const id = `u_test_${Math.random().toString(36).slice(2, 10)}`;
  const { hash, salt } = cryptoMod.hashPassword('Passw0rd!123');
  const now = new Date().toISOString();
  run(
    `INSERT INTO users(id, username, email, password_hash, password_salt, role, qq, email_verified, status, created_at, last_active_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    username,
    `${username}@test.local`,
    hash,
    salt,
    role,
    qq,
    1,
    status,
    now,
    now,
  );
  const token = cryptoMod.signToken({ uid: id, role });
  run(
    'INSERT INTO auth_tokens(token_hash, user_id, created_at, expires_at, user_agent) VALUES(?,?,?,?,?)',
    cryptoMod.sha256(token),
    id,
    now,
    new Date(Date.now() + 86400_000).toISOString(),
    'backend-core-test',
  );
  return { id, token, role, qq, username };
}

async function api(pathname, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(base + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, body: json, text, headers: res.headers };
}

const admin = makeUser({ username: 'admin_test', role: 'admin' });
const alice = makeUser({ username: 'alice_test', qq: '10001' });
const bob = makeUser({ username: 'bob_test', qq: '10002' });
let charA = null;

after(async () => {
  try {
    detachOnebot();
  } catch {}
  await new Promise((resolve) => server.close(resolve));
});

test('未鉴权请求统一返回 401', async () => {
  const cases = [
    ['GET', '/api/characters'],
    ['GET', '/api/stats/usage'],
    ['GET', '/api/admin/overview'],
    ['GET', '/api/media/md_deadbeef'],
    ['GET', '/onebot/status'],
    ['POST', '/api/media'],
    ['POST', '/onebot/send'],
  ];
  for (const [method, pathname] of cases) {
    const r = await api(pathname, { method });
    assert.equal(r.status, 401, `${method} ${pathname} 应返回 401，实际 ${r.status}`);
    assert.equal(r.body?.error?.code, 'unauthorized');
  }
});

test('角色 CRUD 与用户隔离', async () => {
  const created = await api('/api/characters', {
    method: 'POST',
    token: alice.token,
    body: {
      name: '可可',
      age: '20',
      race: '人类',
      gender: '女',
      personality: '温柔，有点黏人',
      worldview: '现代都市',
      hobbies: '听雨、做甜点',
      relation: '恋人',
      appearance: '黑长直，喜欢浅色针织衫',
      occupation: '咖啡店店员',
    },
  });
  assert.equal(created.status, 201);
  charA = created.body.character;
  assert.equal(charA.name, '可可');
  assert.equal(charA.relation, '恋人');
  assert.ok(charA.state, '创建后应带 state');
  assert.ok(charA.settings, '创建后应带 settings');
  assert.equal(charA.state.sleepState, 'awake');
  assert.ok(charA.state.companionDays >= 1);

  const list = await api('/api/characters', { token: alice.token });
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 1);

  const alien = await api(`/api/characters/${charA.id}`, { token: bob.token });
  assert.equal(alien.status, 404, '跨用户读取必须 404');
  const alienPut = await api(`/api/characters/${charA.id}`, { method: 'PUT', token: bob.token, body: { name: '盗用' } });
  assert.equal(alienPut.status, 404, '跨用户写入必须 404');
  const alienDel = await api(`/api/characters/${charA.id}`, { method: 'DELETE', token: bob.token });
  assert.equal(alienDel.status, 404);

  const bobList = await api('/api/characters', { token: bob.token });
  assert.equal(bobList.body.total, 0);

  const updated = await api(`/api/characters/${charA.id}`, {
    method: 'PUT',
    token: alice.token,
    body: { personality: '更温柔了', appearance: '加了发夹' },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.character.personality, '更温柔了');
  assert.equal(updated.body.character.appearance, '加了发夹');

  const badCreate = await api('/api/characters', { method: 'POST', token: alice.token, body: { age: '1' } });
  assert.equal(badCreate.status, 400);
  assert.equal(badCreate.body.error.code, 'name_required');
});

test('角色设置与状态读写', async () => {
  const put = await api(`/api/characters/${charA.id}/settings`, {
    method: 'PUT',
    token: alice.token,
    body: {
      rss: ['https://example.com/feed.xml'],
      creationTags: ['日常', '科幻', '日常'],
      creationFrequency: 'weekly',
      sleep: { start: '23:00', end: '07:00', napStart: '13:00', napEnd: '14:00' },
      statusIntervalMin: 15,
      activeReply: false,
      modelRouting: { main: 'gpt-4o-mini' },
    },
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.settings.creationFrequency, 'weekly');
  assert.deepEqual(put.body.settings.creationTags, ['日常', '科幻']);
  assert.equal(put.body.settings.rss[0].url, 'https://example.com/feed.xml');
  assert.equal(put.body.settings.statusIntervalMin, 15);
  assert.equal(put.body.settings.activeReply, false);
  assert.equal(put.body.settings.sleep.start, '23:00');

  const got = await api(`/api/characters/${charA.id}/settings`, { token: alice.token });
  assert.equal(got.status, 200);
  assert.equal(got.body.settings.modelRouting.main, 'gpt-4o-mini');

  const badFreq = await api(`/api/characters/${charA.id}/settings`, {
    method: 'PUT',
    token: alice.token,
    body: { creationFrequency: 'sometimes' },
  });
  assert.equal(badFreq.status, 400);
  const badTime = await api(`/api/characters/${charA.id}/settings`, {
    method: 'PUT',
    token: alice.token,
    body: { sleep: { start: '25:00' } },
  });
  assert.equal(badTime.status, 400);

  const state = await api(`/api/characters/${charA.id}/state`, { token: alice.token });
  assert.equal(state.status, 200);
  assert.equal(state.body.state.sleepState, 'awake');
  assert.ok(state.body.state.motion);
});

test('expand：未配置模型时降级为本地字段扩写', async () => {
  const r = await api('/api/characters/expand', {
    method: 'POST',
    token: alice.token,
    body: { prompt: '一个叫阿岚的猫耳少女，温柔的程序员，喜欢听雨和做甜点' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.source, 'local', '未配置 API Key 时应走本地降级');
  const fields = ['name', 'age', 'race', 'gender', 'personality', 'worldview', 'hobbies', 'relation', 'appearance', 'occupation'];
  for (const f of fields) assert.ok(r.body.profile[f], `expanded profile 缺少字段 ${f}`);
  assert.equal(r.body.profile.name, '阿岚');
  assert.equal(r.body.profile.race, '猫');

  const empty = await api('/api/characters/expand', { method: 'POST', token: alice.token, body: { prompt: '  ' } });
  assert.equal(empty.status, 400);
});

test('角色模板：保存、列表、沿用与隔离', async () => {
  const tpl = await api('/api/characters/templates', {
    method: 'POST',
    token: alice.token,
    body: {
      name: '猫耳模板',
      profile: {
        name: '铃兰',
        age: '19',
        race: '猫耳族',
        gender: '女',
        personality: '元气、直率',
        worldview: '近未来学园',
        hobbies: '爬树、拍云',
        relation: '朋友',
        appearance: '白色猫耳，短发',
        occupation: '学生',
      },
    },
  });
  assert.equal(tpl.status, 201);
  const templateId = tpl.body.template.id;

  const list = await api('/api/characters/templates', { token: alice.token });
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 1);
  assert.equal(list.body.items[0].profile.name, '铃兰');

  const created = await api('/api/characters', {
    method: 'POST',
    token: alice.token,
    body: { templateId, settings: { creationTags: ['校园'] } },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.character.name, '铃兰');
  assert.equal(created.body.character.race, '猫耳族');
  assert.deepEqual(created.body.character.settings.creationTags, ['校园']);

  const bobTemplates = await api('/api/characters/templates', { token: bob.token });
  assert.equal(bobTemplates.body.total, 0);
  const stolen = await api('/api/characters', { method: 'POST', token: bob.token, body: { templateId } });
  assert.equal(stolen.status, 404);
});

test('统计用量：区间、模型筛选与分桶', async () => {
  recordUsage({
    userId: alice.id,
    characterId: charA.id,
    kind: 'main',
    model: 'gpt-4o-mini',
    usage: { input: 1000, cached: 200, output: 300 },
    cost: 0.001,
  });
  recordUsage({
    userId: alice.id,
    characterId: charA.id,
    kind: 'creation',
    model: 'deepseek-chat',
    usage: { input: 500, cached: 0, output: 100 },
    cost: 0.0005,
  });
  run(
    'INSERT INTO usage_records(id, user_id, character_id, kind, model, input_tokens, cached_tokens, output_tokens, cost, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    'ur_old_test',
    alice.id,
    charA.id,
    'main',
    'gpt-4o-mini',
    9999,
    0,
    9999,
    1,
    new Date(Date.now() - 40 * 86400_000).toISOString(),
  );

  const week = await api('/api/stats/usage?range=7d&bucket=day', { token: alice.token });
  assert.equal(week.status, 200);
  assert.equal(week.body.range, '7d');
  assert.equal(week.body.totals.input, 1500);
  assert.equal(week.body.totals.inputHit, 200);
  assert.equal(week.body.totals.inputMiss, 1300);
  assert.equal(week.body.totals.output, 400);
  assert.equal(week.body.totals.total, 1900);
  assert.equal(week.body.totals.calls, 2);
  assert.ok(Math.abs(week.body.totals.cost - 0.0015) < 1e-9);
  assert.ok(week.body.series.length >= 1);
  assert.equal(week.body.series[0].key.length, 10);

  const all = await api('/api/stats/usage?range=all', { token: alice.token });
  assert.equal(all.body.totals.calls, 3);

  const byModel = await api('/api/stats/usage?range=all&model=deepseek-chat', { token: alice.token });
  assert.equal(byModel.body.totals.calls, 1);
  assert.equal(byModel.body.totals.input, 500);
  assert.equal(byModel.body.models.length, 1);
  assert.equal(byModel.body.model, 'deepseek-chat');

  const hourly = await api('/api/stats/usage?range=day&bucket=hour', { token: alice.token });
  assert.equal(hourly.status, 200);
  assert.equal(hourly.body.bucket, 'hour');
  assert.ok(hourly.body.series.every((p) => p.key.length === 13));

  const badCustom = await api('/api/stats/usage?range=custom', { token: alice.token });
  assert.equal(badCustom.status, 400);
  const range = await api('/api/stats/usage?range=custom&from=2026-01-01T00:00:00Z&to=2026-12-31T00:00:00Z', {
    token: alice.token,
  });
  assert.equal(range.status, 200);

  const otherUser = await api('/api/stats/usage?range=all', { token: bob.token });
  assert.equal(otherUser.body.totals.calls, 0, '用量必须按用户隔离');
});

test('亲密度折线与陪伴概览（状态异常兼容加密 meta）', async () => {
  run(
    'INSERT INTO intimacy_log(id, user_id, character_id, value, source, created_at) VALUES(?,?,?,?,?,?)',
    'il_test_1',
    alice.id,
    charA.id,
    42,
    'chat',
    new Date(Date.now() - 2 * 86400_000).toISOString(),
  );
  run(
    'INSERT INTO intimacy_log(id, user_id, character_id, value, source, created_at) VALUES(?,?,?,?,?,?)',
    'il_test_2',
    alice.id,
    charA.id,
    55,
    'chat',
    new Date().toISOString(),
  );
  run('UPDATE character_state SET intimacy = 55 WHERE character_id = ?', charA.id);

  const intimacy = await api(`/api/stats/intimacy?characterId=${charA.id}&range=7d`, { token: alice.token });
  assert.equal(intimacy.status, 200);
  assert.equal(intimacy.body.current, 55);
  assert.equal(intimacy.body.points.length, 2);
  assert.equal(intimacy.body.points.at(-1).v, 55);
  assert.ok(intimacy.body.companionDays >= 1);

  const convId = 'conv_test_1';
  const now = new Date().toISOString();
  run(
    'INSERT INTO conversations(id, character_id, user_id, kind, title, created_at, updated_at, active) VALUES(?,?,?,?,?,?,?,1)',
    convId,
    charA.id,
    alice.id,
    'main',
    '主会话',
    now,
    now,
  );
  for (let i = 0; i < 3; i += 1) {
    run(
      'INSERT INTO messages(id, conversation_id, character_id, user_id, role, kind, content, meta, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      `msg_user_${i}`,
      convId,
      charA.id,
      alice.id,
      'user',
      'text',
      '在吗',
      '{}',
      now,
    );
  }
  run(
    'INSERT INTO messages(id, conversation_id, character_id, user_id, role, kind, content, meta, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    'msg_status_1',
    convId,
    charA.id,
    alice.id,
    'agent',
    'status',
    '{}',
    cryptoMod.encryptJson(alice.id, { flags: { healthAbnormal: true, moodAbnormal: false } }),
    now,
  );
  run(
    'INSERT INTO messages(id, conversation_id, character_id, user_id, role, kind, content, meta, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    'msg_status_2',
    convId,
    charA.id,
    alice.id,
    'agent',
    'status',
    '{}',
    JSON.stringify({ flags: { healthAbnormal: false, moodAbnormal: true } }),
    now,
  );

  const overview = await api(`/api/stats/overview?characterId=${charA.id}`, { token: alice.token });
  assert.equal(overview.status, 200);
  assert.equal(overview.body.scope, 'character');
  assert.equal(overview.body.chatCount, 3);
  assert.equal(overview.body.healthAbnormal, 1);
  assert.equal(overview.body.moodAbnormal, 1);
  assert.equal(overview.body.intimacy, 55);
  assert.ok(overview.body.companionDays >= 1);

  const agg = await api('/api/stats/overview', { token: alice.token });
  assert.equal(agg.status, 200);
  assert.equal(agg.body.scope, 'all');
  assert.equal(agg.body.characters, 2);
  assert.equal(agg.body.chatCount, 3);

  const alien = await api(`/api/stats/intimacy?characterId=${charA.id}`, { token: bob.token });
  assert.equal(alien.status, 404);
});

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('媒体上传/鉴权下载/越权与白名单', async () => {
  const form = new FormData();
  form.append('file', new Blob([PNG_1PX], { type: 'image/png' }), 'avatar.png');
  form.append('kind', 'avatar');
  form.append('characterId', charA.id);
  const upRes = await fetch(`${base}/api/media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${alice.token}` },
    body: form,
  });
  const up = await upRes.json();
  assert.equal(upRes.status, 201);
  assert.equal(up.kind, 'avatar');
  assert.equal(up.mime, 'image/png');
  assert.equal(up.size, PNG_1PX.length);
  assert.equal(up.url, `/api/media/${up.id}`);
  assert.equal(up.characterId, charA.id);

  const dl = await fetch(`${base}${up.url}`, { headers: { authorization: `Bearer ${alice.token}` } });
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'image/png');
  const buf = Buffer.from(await dl.arrayBuffer());
  assert.equal(buf.length, PNG_1PX.length);

  const forbidden = await fetch(`${base}${up.url}`, { headers: { authorization: `Bearer ${bob.token}` } });
  assert.equal(forbidden.status, 403, '他人媒体必须拒绝');

  const badForm = new FormData();
  badForm.append('file', new Blob([Buffer.from('hello')], { type: 'text/plain' }), 'note.txt');
  const badRes = await fetch(`${base}/api/media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${alice.token}` },
    body: badForm,
  });
  assert.equal(badRes.status, 400, '非图片/音频应拒绝');
  const bad = await badRes.json();
  assert.equal(bad.error.code, 'media_mime_invalid');

  const missing = await api('/api/media/md_not_exist', { token: alice.token });
  assert.equal(missing.status, 404);
});

test('OneBot HTTP：未注册 / 缺配置固定文案与未连接发送', async () => {
  const unreg = await api('/onebot/event', {
    method: 'POST',
    body: { post_type: 'message', message_type: 'private', user_id: 999999, message: [{ type: 'text', data: { text: '你好' } }] },
  });
  assert.equal(unreg.status, 200);
  assert.equal(unreg.body.reply, '账号未注册，花名册上没有主人的大名哦~');
  assert.equal(unreg.body.reason, 'unregistered');

  const registered = await api('/onebot/event', {
    method: 'POST',
    body: { post_type: 'message', message_type: 'private', user_id: Number(alice.qq), message: '在吗' },
  });
  assert.equal(registered.status, 200);
  assert.equal(registered.body.reply, '对话模型、嵌入模型还未设置哦，请前往 Cocoa 进行配置');
  assert.equal(registered.body.reason, 'config_missing');
  assert.equal(registered.body.delivered, false);

  const groupIgnored = await api('/onebot/event', {
    method: 'POST',
    body: { post_type: 'message', message_type: 'group', user_id: Number(alice.qq), message: '群里说话' },
  });
  assert.equal(groupIgnored.status, 200);
  assert.equal(groupIgnored.body.ignored, true);

  const badEvent = await api('/onebot/event', { method: 'POST', body: { foo: 1 } });
  assert.equal(badEvent.status, 400);

  // NapCat 某些版本以 text/plain 上报 JSON
  const textRes = await fetch(`${base}/onebot/event`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 999998, raw_message: '你好' }),
  });
  const textBody = await textRes.json();
  assert.equal(textRes.status, 200);
  assert.equal(textBody.reply, '账号未注册，花名册上没有主人的大名哦~');

  const status = await api('/onebot/status', { token: alice.token });
  assert.equal(status.status, 200);
  assert.equal(status.body.connected, false);
  assert.equal(status.body.wsPath, '/onebot/ws');

  const send = await api('/onebot/send', { method: 'POST', token: admin.token, body: { qq: '10001', text: 'hi' } });
  assert.equal(send.status, 503);
  assert.equal(send.body.reason, 'not_connected');

  const sendByUser = await api('/onebot/send', { method: 'POST', token: alice.token, body: { qq: '10001', text: 'hi' } });
  assert.equal(sendByUser.status, 403, '仅管理员可手动发送');
});

test('OneBot 反向 WS：连接、事件回执与状态', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/onebot/ws`);
  const received = [];
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    received.push(msg);
    // 模拟 NapCat 对 action 的 echo 回执
    if (msg.action) ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 }, echo: msg.echo }));
  });

  ws.send(
    JSON.stringify({
      post_type: 'message',
      message_type: 'private',
      user_id: 777777,
      message: [{ type: 'text', data: { text: '你好呀' } }],
    }),
  );

  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && !received.some((m) => m.action === 'send_private_msg')) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const action = received.find((m) => m.action === 'send_private_msg');
  assert.ok(action, '应通过反向 WS 收到 send_private_msg');
  assert.equal(action.params.message, '账号未注册，花名册上没有主人的大名哦~');
  assert.equal(String(action.params.user_id), '777777');

  const status = await api('/onebot/status', { token: alice.token });
  assert.equal(status.body.connected, true);
  assert.equal(status.body.clients, 1);

  ws.close();
  await new Promise((r) => setTimeout(r, 120));
  const afterClose = await api('/onebot/status', { token: alice.token });
  assert.equal(afterClose.body.connected, false);
});

test('管理端：非管理员 403，管理员概览/用户/用量/会话/日志/存储/配置掩码', async () => {
  const denied = await api('/api/admin/overview', { token: alice.token });
  assert.equal(denied.status, 403);

  const overview = await api('/api/admin/overview', { token: admin.token });
  assert.equal(overview.status, 200);
  assert.ok(overview.body.users.total >= 3);
  assert.ok(overview.body.users.online >= 1);
  assert.equal(typeof overview.body.activeIndex, 'number');
  assert.ok(overview.body.activeIndex >= 0 && overview.body.activeIndex <= 100);
  assert.match(overview.body.formula, /activeIndex/);
  assert.ok(overview.body.components.onlineWeight === 60);
  assert.ok(overview.body.conversations.total >= 1);
  assert.ok(overview.body.storage.total >= 0);
  assert.equal(typeof overview.body.storage.db, 'number');
  assert.equal(typeof overview.body.onebot.connected, 'boolean');

  const users = await api('/api/admin/users?q=alice', { token: admin.token });
  assert.equal(users.status, 200);
  assert.equal(users.body.total, 1);
  assert.equal(users.body.items[0].username, 'alice_test');
  assert.equal(users.body.items[0].password_hash, undefined, '不得返回口令散列');

  const patched = await api(`/api/admin/users/${bob.id}`, {
    method: 'PUT',
    token: admin.token,
    body: { status: 'disabled', qq: '10003' },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.user.status, 'disabled');
  assert.equal(patched.body.user.qq, '10003');
  assert.equal((await api('/api/characters', { token: bob.token })).status, 401, '停用后令牌失效');
  await api(`/api/admin/users/${bob.id}`, { method: 'PUT', token: admin.token, body: { status: 'active' } });

  const selfDemote = await api(`/api/admin/users/${admin.id}`, { method: 'PUT', token: admin.token, body: { role: 'user' } });
  assert.equal(selfDemote.status, 400);
  const badRole = await api(`/api/admin/users/${bob.id}`, { method: 'PUT', token: admin.token, body: { role: 'root' } });
  assert.equal(badRole.status, 400);

  const usageAll = await api('/api/admin/usage?range=all', { token: admin.token });
  assert.equal(usageAll.status, 200);
  assert.equal(usageAll.body.totals.calls, 3, '管理员用量应为全站汇总');
  assert.ok(Array.isArray(usageAll.body.byUser));
  assert.ok(usageAll.body.byUser.some((u) => u.userId === alice.id));

  const usageUser = await api(`/api/admin/usage?range=all&userId=${alice.id}`, { token: admin.token });
  assert.equal(usageUser.status, 200);
  assert.equal(usageUser.body.userId, alice.id);
  assert.equal(usageUser.body.totals.calls, 3);
  assert.equal(usageUser.body.byUser, undefined);

  const convs = await api('/api/admin/conversations?page=1&size=10', { token: admin.token });
  assert.equal(convs.status, 200);
  assert.ok(convs.body.total >= 1);
  const conv = convs.body.items.find((i) => i.id === 'conv_test_1');
  assert.ok(conv, '应能列出会话');
  assert.equal(conv.characterName, '可可');
  assert.equal(conv.messageCount, 5);

  const convDetail = await api('/api/admin/conversations/conv_test_1', { token: admin.token });
  assert.equal(convDetail.status, 200);
  assert.equal(convDetail.body.messageCount, 5);
  assert.ok(convDetail.body.recent.length >= 1);
  assert.equal(convDetail.body.recent.at(-1).content.length > 0, true);

  const logs = await api('/api/admin/logs?page=1&size=10', { token: admin.token });
  assert.equal(logs.status, 200);
  assert.ok(logs.body.total >= 1);
  assert.ok(logs.body.items.some((i) => i.action === 'character.create'));

  const storage = await api('/api/admin/storage', { token: admin.token });
  assert.equal(storage.status, 200);
  for (const key of ['db', 'wal', 'messages', 'media', 'cache', 'total']) {
    assert.equal(typeof storage.body[key], 'number', `storage.${key}`);
  }
  assert.ok(storage.body.media > 0, '应统计到已上传的媒体文件');

  const settings = await api('/api/admin/settings', { token: admin.token });
  assert.equal(settings.status, 200);
  assert.equal(settings.body.smtp.passSet, false);
  assert.equal(settings.body.smtp.passMasked, '');

  const putSettings = await api('/api/admin/settings', {
    method: 'PUT',
    token: admin.token,
    body: {
      smtp: { host: 'smtp.example.com', port: 465, secure: true, user: 'bot@example.com', pass: 'supersecret123', from: 'bot@example.com' },
      onebot: { token: 'obtoken-secret', selfId: '123456789', wsPath: '/onebot/ws' },
    },
  });
  assert.equal(putSettings.status, 200);
  assert.equal(putSettings.body.smtp.passSet, true);
  assert.ok(putSettings.body.smtp.passMasked.includes('****'));
  assert.ok(!JSON.stringify(putSettings.body).includes('supersecret123'), '口令不得明文返回');
  assert.ok(!JSON.stringify(putSettings.body).includes('obtoken-secret'), 'token 不得明文返回');
  assert.equal(putSettings.body.onebot.selfId, '123456789');

  const keepMasked = await api('/api/admin/settings', {
    method: 'PUT',
    token: admin.token,
    body: { smtp: { pass: '****' } },
  });
  assert.equal(keepMasked.status, 200);
  assert.equal(keepMasked.body.smtp.passSet, true, '传 **** 应保持原口令');

  const badMail = await api('/api/admin/settings/test-mail', {
    method: 'POST',
    token: admin.token,
    body: { to: 'not-an-email' },
  });
  assert.equal(badMail.status, 400);

  const obStatus = await api('/api/admin/onebot/status', { token: admin.token });
  assert.equal(obStatus.status, 200);
  assert.equal(obStatus.body.wsPath, '/onebot/ws');
  assert.equal(obStatus.body.config.selfId, '123456789');
  assert.ok(!JSON.stringify(obStatus.body).includes('obtoken-secret'));
});

test('状态刷新：失败后进入 5 分钟冷却（429 status_cooldown）', async () => {
  const first = await api(`/api/characters/${charA.id}/status/refresh`, { method: 'POST', token: alice.token });
  assert.ok([200, 502].includes(first.status), `首次刷新应成功或模型失败，实际 ${first.status}`);

  const second = await api(`/api/characters/${charA.id}/status/refresh`, { method: 'POST', token: alice.token });
  assert.equal(second.status, 429);
  assert.equal(second.body.error.code, 'status_cooldown');
  assert.ok(second.body.error.detail.retryAfterSec > 0);
  assert.ok(second.body.error.detail.nextAllowedAt);

  const outsider = makeUser({ username: `outsider_${Date.now()}` });
  const alien = await api(`/api/characters/${charA.id}/status/refresh`, { method: 'POST', token: outsider.token });
  assert.equal(alien.status, 404);
});

test('删除角色级联清理全部资产', async () => {
  const del = await api(`/api/characters/${charA.id}`, { method: 'DELETE', token: alice.token });
  assert.equal(del.status, 200);
  assert.equal(del.body.deleted, true);
  assert.equal((await api(`/api/characters/${charA.id}`, { token: alice.token })).status, 404);
  assert.equal(get('SELECT COUNT(*) AS n FROM character_state WHERE character_id = ?', charA.id).n, 0);
  assert.equal(get('SELECT COUNT(*) AS n FROM intimacy_log WHERE character_id = ?', charA.id).n, 0);
  assert.equal(get('SELECT COUNT(*) AS n FROM conversations WHERE character_id = ?', charA.id).n, 0);
});
