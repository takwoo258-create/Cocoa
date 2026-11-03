// v1.2.0 分享/QQ 单角色接入/调用统计 集成测试
// 运行：COCOA_DATA_DIR=/data/dsh/home/.tmp/cocoa-core PORT=18081 node --test server/test/shares.test.mjs
import fs from 'node:fs';
import http from 'node:http';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

const DATA_DIR = process.env.COCOA_DATA_DIR || '/data/dsh/home/.tmp/cocoa-core';
process.env.COCOA_DATA_DIR = DATA_DIR;
process.env.PORT = process.env.PORT || '18081';
process.env.NODE_ENV = 'test';
process.env.COCOA_LOG_LEVEL = process.env.COCOA_LOG_LEVEL || 'error';

fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
// 避免宿主机 .env 里的真实 key 影响断言
process.env.COCOA_EMBEDDING_API_KEY = '';
process.env.COCOA_EMBEDDING_BASE_URL = '';
process.env.COCOA_SEARCH_API_KEY = '';
process.env.SMTP_HOST = '';
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';

const { createApp } = await import('../src/app.js');
const { get, run } = await import('../src/db/index.js');
const cryptoMod = await import('../src/core/crypto.js');
const { attachWebSocket } = await import('../src/realtime/hub.js');
const { getUserApi, invalidateShareCache } = await import('../src/services/settings.js');
const { expireDueShares, startShareExpiryWatcher, stopShareExpiryWatcher } = await import('../src/services/shares.js');

const app = createApp();
const server = http.createServer(app);
attachWebSocket(server, '/ws');
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

function makeUser({ username, code, qq, role = 'user' }) {
  const id = `u_${username}_${Math.random().toString(36).slice(2, 8)}`;
  const { hash, salt } = cryptoMod.hashPassword('Passw0rd!123');
  const now = new Date().toISOString();
  run(
    `INSERT INTO users(id, username, email, password_hash, password_salt, role, qq, code, email_verified, status, created_at, last_active_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    username,
    `${username}@test.local`,
    hash,
    salt,
    role,
    qq,
    code,
    1,
    'active',
    now,
    now,
  );
  const token = cryptoMod.signToken({ uid: id, role });
  run(
    'INSERT INTO auth_tokens(token_hash, user_id, created_at, expires_at, last_renew_at, user_agent) VALUES(?,?,?,?,?,?)',
    cryptoMod.sha256(token),
    id,
    now,
    new Date(Date.now() + 3 * 86400_000).toISOString(),
    now,
    'shares-test',
  );
  return { id, token, username, code, qq };
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
  return { status: res.status, body: json, text };
}

async function setChatConfig(user, { key, baseUrl = 'https://api.shared.test/v1', model = 'gpt-4o-mini' }, extra = {}) {
  const r = await api('/api/config/api', {
    method: 'PUT',
    token: user.token,
    body: { chat: { baseUrl, apiKey: key, model }, ...extra },
  });
  assert.equal(r.status, 200, r.text);
  return r;
}

const alice = makeUser({ username: 'alice', code: 1, qq: '10001' });
const bob = makeUser({ username: 'bob', code: 2, qq: '10002' });
const carol = makeUser({ username: 'carol', code: 3, qq: '10003' });
const dave = makeUser({ username: 'dave', code: 4, qq: '10004' });

let aliceChar1 = null;
let aliceChar2 = null;
let bobChar = null;

// WS 事件收集（qq_binding / share_request / share_result / share_expired）
const wsEvents = [];
let ws = null;
{
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${alice.token}`);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.on('message', (raw) => {
    try {
      wsEvents.push(JSON.parse(String(raw)));
    } catch {
      /* 忽略非 JSON */
    }
  });
}

async function waitForEvent(pred, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = wsEvents.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 40));
  }
  return null;
}

after(async () => {
  try {
    stopShareExpiryWatcher();
  } catch {}
  try {
    ws?.close();
  } catch {}
  await new Promise((resolve) => server.close(resolve));
});

test('准备：配置模型与角色', async () => {
  await setChatConfig(alice, { key: 'sk-alice-secret' }, {
    embedding: { baseUrl: 'https://api.shared.test/v1', apiKey: 'sk-alice-embed', model: 'text-embedding-3-small' },
  });
  await setChatConfig(bob, { key: 'sk-bob-secret', baseUrl: 'https://api.bob.test/v1', model: 'deepseek-chat' });

  const created = await api('/api/characters', {
    method: 'POST',
    token: alice.token,
    body: { name: '可可', gender: '女', relation: '恋人' },
  });
  assert.equal(created.status, 201);
  aliceChar1 = created.body.character;

  const created2 = await api('/api/characters', {
    method: 'POST',
    token: alice.token,
    body: { name: '小满', gender: '女', relation: '朋友' },
  });
  assert.equal(created2.status, 201);
  aliceChar2 = created2.body.character;

  const created3 = await api('/api/characters', {
    method: 'POST',
    token: bob.token,
    body: { name: '阿岚', gender: '女', relation: '朋友' },
  });
  assert.equal(created3.status, 201);
  bobChar = created3.body.character;

  // 默认值：userAddress 空、qqEnabled false
  const char = await api(`/api/characters/${aliceChar1.id}`, { token: alice.token });
  assert.equal(char.body.character.qqEnabled, false);
  assert.equal(char.body.character.settings.userAddress, '');
});

test('分享：创建 → 待处理 → 接受 → 共享配置生效', async () => {
  const created = await api('/api/shares', {
    method: 'POST',
    token: alice.token,
    body: {
      target: '3',
      direction: 'share',
      services: ['chat', 'embedding'],
      duration: { years: 0, months: 0, weeks: 0, days: 3, hours: 2, minutes: 30 },
      note: '拿去用',
    },
  });
  assert.equal(created.status, 201, created.text);
  const share = created.body.share;
  assert.equal(share.status, 'pending');
  assert.equal(share.direction, 'share');
  assert.equal(share.owner.code, 1);
  assert.equal(share.target.code, 3);
  assert.deepEqual(share.services.sort(), ['chat', 'embedding']);
  assert.equal(share.permanent, false);
  assert.deepEqual(share.duration, { years: 0, months: 0, weeks: 0, days: 3, hours: 2, minutes: 30 });
  assert.equal(share.canRespond, false);
  assert.equal(share.canRevoke, true);

  const pending = await api('/api/shares/pending', { token: carol.token });
  assert.equal(pending.status, 200);
  assert.equal(pending.body.total, 1);
  assert.equal(pending.body.items[0].id, share.id);
  assert.equal(pending.body.items[0].canRespond, true);
  assert.equal(pending.body.items[0].seen, true);

  // 越权：bob 不是目标，不能响应
  const alien = await api(`/api/shares/${share.id}/respond`, {
    method: 'POST',
    token: bob.token,
    body: { accept: true },
  });
  assert.equal(alien.status, 403);

  const accepted = await api(`/api/shares/${share.id}/respond`, {
    method: 'POST',
    token: carol.token,
    body: { accept: true },
  });
  assert.equal(accepted.status, 200, accepted.text);
  assert.equal(accepted.body.share.status, 'accepted');
  assert.ok(accepted.body.share.expiresAt, '接受后应计算到期时间');
  const remain = new Date(accepted.body.share.expiresAt).getTime() - Date.now();
  assert.ok(remain > 2 * 86400_000 && remain < 4 * 86400_000, `到期时间应约为 3 天，实际 ${remain}`);

  // 客户端配置：shared 元信息 + 密钥不回传
  const cfg = await api('/api/config', { token: carol.token });
  assert.equal(cfg.status, 200);
  assert.equal(cfg.body.ready.chat, true);
  assert.equal(cfg.body.ready.embedding, true);
  assert.equal(cfg.body.api.chat.shared.ownerCode, 1);
  assert.equal(cfg.body.api.chat.shared.ownerNickname, 'alice');
  assert.equal(cfg.body.api.chat.shared.shareId, share.id);
  assert.equal(cfg.body.api.chat.shared.model, 'gpt-4o-mini');
  assert.equal(cfg.body.api.chat.apiKeyMasked, '****');
  assert.equal(cfg.body.shared.chat.shareId, share.id);
  assert.ok(!JSON.stringify(cfg.body).includes('sk-alice-secret'), '不得返回分享者的密钥');
  assert.ok(!JSON.stringify(cfg.body).includes('sk-alice-embed'));

  // 服务端实际生效
  const effective = getUserApi(carol.id);
  assert.equal(effective.chat.apiKey, 'sk-alice-secret');
  assert.equal(effective.embedding.apiKey, 'sk-alice-embed');
  assert.equal(getUserApi(bob.id).chat.apiKey, 'sk-bob-secret', '未参与分享的用户不受影响');

  const active = await api('/api/shares?box=active', { token: carol.token });
  assert.equal(active.body.total, 1);
  assert.equal(active.body.items[0].status, 'accepted');
  assert.equal(active.body.items[0].side, 'target');

  const aliceActive = await api('/api/shares?box=active', { token: alice.token });
  assert.ok(aliceActive.body.items.some((s) => s.id === share.id && s.side === 'owner'));

  const carolPending = await api('/api/shares?box=incoming', { token: carol.token });
  assert.equal(carolPending.body.total, 0);

  // 撤销后共享立即失效
  const revoked = await api(`/api/shares/${share.id}/revoke`, { method: 'POST', token: alice.token });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.share.status, 'revoked');
  const afterRevoke = await api('/api/config', { token: carol.token });
  assert.equal(afterRevoke.body.ready.chat, false);
  assert.equal(getUserApi(carol.id).chat.apiKey, '');

  // 非参与方不能撤销
  const alienRevoke = await api(`/api/shares/${share.id}/revoke`, { method: 'POST', token: bob.token });
  assert.equal(alienRevoke.status, 403);
});

test('分享：拒绝 / 索要方向 / 目标方撤销 / 跨用户隔离', async () => {
  const share = await api('/api/shares', {
    method: 'POST',
    token: alice.token,
    body: { target: 'dave@test.local', direction: 'share', services: ['chat'], duration: { minutes: 30 } },
  });
  assert.equal(share.status, 201, share.text);
  assert.equal(share.body.share.target.code, 4);

  const rejected = await api(`/api/shares/${share.body.share.id}/respond`, {
    method: 'POST',
    token: dave.token,
    body: { accept: false },
  });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.share.status, 'rejected');
  assert.equal((await api('/api/config', { token: dave.token })).body.ready.chat, false);

  // 索要：dave 向 bob 索要 chat（bob 提供配置）
  const request = await api('/api/shares', {
    method: 'POST',
    token: dave.token,
    body: { target: '2', direction: 'request', services: ['chat'], duration: { hours: 1 } },
  });
  assert.equal(request.status, 201, request.text);
  assert.equal(request.body.share.direction, 'request');
  assert.equal(request.body.share.owner.code, 4);
  assert.equal(request.body.share.target.code, 2);

  const accepted = await api(`/api/shares/${request.body.share.id}/respond`, {
    method: 'POST',
    token: bob.token,
    body: { accept: true },
  });
  assert.equal(accepted.status, 200, accepted.text);
  assert.equal(accepted.body.share.status, 'accepted');
  assert.equal(getUserApi(dave.id).chat.apiKey, 'sk-bob-secret', '索要方向应使用被索要方的配置');

  // 目标方（bob）也可撤销
  const revoked = await api(`/api/shares/${request.body.share.id}/revoke`, { method: 'POST', token: bob.token });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.share.status, 'revoked');
  assert.equal(getUserApi(dave.id).chat.apiKey, '');

  // 跨用户隔离：carol 看不到 alice↔dave 的记录
  const carolHistory = await api('/api/shares?box=history', { token: carol.token });
  const ids = carolHistory.body.items.map((s) => s.id);
  assert.ok(!ids.includes(share.body.share.id));
  assert.ok(!ids.includes(request.body.share.id));
});

test('分享：到期巡检（expired）与配置失效', async () => {
  const future = new Date(Date.now() + 3600_000).toISOString();
  run(
    `INSERT INTO model_shares(id, owner_id, target_id, direction, services, payload, status, permanent, duration, expires_at, note, seen, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,0,?)`,
    'sh_expire_test',
    alice.id,
    dave.id,
    'share',
    JSON.stringify(['chat']),
    cryptoMod.encryptJson(alice.id, {
      chat: { baseUrl: 'https://api.shared.test/v1', apiKey: 'sk-alice-secret', model: 'gpt-4o-mini' },
    }),
    'accepted',
    0,
    null,
    future,
    null,
    new Date().toISOString(),
  );
  invalidateShareCache(dave.id);
  assert.equal(getUserApi(dave.id).chat.apiKey, 'sk-alice-secret', '未到期前应生效');

  const n = expireDueShares(new Date(Date.now() + 2 * 3600_000));
  assert.ok(n >= 1, '应至少标记一条到期分享');
  assert.equal(get('SELECT status FROM model_shares WHERE id = ?', 'sh_expire_test').status, 'expired');
  assert.equal(getUserApi(dave.id).chat.apiKey, '', '到期后共享配置失效');

  const history = await api('/api/shares?box=history', { token: dave.token });
  assert.ok(history.body.items.some((s) => s.id === 'sh_expire_test' && s.status === 'expired'));

  const expiredEvent = await waitForEvent((e) => e.type === 'share_expired' && e.share?.id === 'sh_expire_test');
  assert.ok(expiredEvent, '到期应推送 WS share_expired');

  const timer = startShareExpiryWatcher();
  assert.ok(timer, '到期巡检应返回定时器');
  stopShareExpiryWatcher();
});

test('角色称呼与 QQ 单角色接入（冲突 409 / 确认切换 / WS 推送）', async () => {
  const bind1 = await api(`/api/characters/${aliceChar1.id}/settings`, {
    method: 'PUT',
    token: alice.token,
    body: { userAddress: '主人', qqEnabled: true },
  });
  assert.equal(bind1.status, 200, bind1.text);
  assert.equal(bind1.body.settings.userAddress, '主人');
  assert.equal(bind1.body.settings.qqEnabled, true);

  const char1 = await api(`/api/characters/${aliceChar1.id}`, { token: alice.token });
  assert.equal(char1.body.character.qqEnabled, true);
  assert.equal(char1.body.character.settings.userAddress, '主人');

  const robot1 = await api('/api/onebot/robot', { token: alice.token });
  assert.equal(robot1.status, 200);
  assert.equal(robot1.body.boundCharacterId, aliceChar1.id);
  assert.equal(robot1.body.boundCharacterName, '可可');
  assert.equal(typeof robot1.body.selfId, 'string');
  assert.equal(robot1.body.wsPath, '/onebot/ws');

  // 冲突：另一角色接入但未确认
  const conflict = await api(`/api/characters/${aliceChar2.id}/settings`, {
    method: 'PUT',
    token: alice.token,
    body: { qqEnabled: true },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'qq_binding_conflict');
  assert.equal(conflict.body.error.message, '是否更换接入对象？');
  assert.equal(conflict.body.error.detail.current.id, aliceChar1.id);
  assert.equal(conflict.body.error.detail.next.id, aliceChar2.id);

  // 未确认时不改变绑定
  assert.equal(get('SELECT qq_enabled FROM characters WHERE id = ?', aliceChar1.id).qq_enabled, 1);
  assert.equal(get('SELECT qq_enabled FROM characters WHERE id = ?', aliceChar2.id).qq_enabled, 0);

  // 确认切换
  const switched = await api(`/api/characters/${aliceChar2.id}/settings`, {
    method: 'PUT',
    token: alice.token,
    body: { qqEnabled: true, confirmReplace: true },
  });
  assert.equal(switched.status, 200, switched.text);
  assert.equal(switched.body.settings.qqEnabled, true);
  assert.equal(switched.body.binding.current.id, aliceChar1.id);
  assert.equal(switched.body.binding.next.id, aliceChar2.id);
  assert.equal(get('SELECT qq_enabled FROM characters WHERE id = ?', aliceChar1.id).qq_enabled, 0);
  assert.equal(get('SELECT qq_enabled FROM characters WHERE id = ?', aliceChar2.id).qq_enabled, 1);

  const char1After = await api(`/api/characters/${aliceChar1.id}`, { token: alice.token });
  assert.equal(char1After.body.character.qqEnabled, false);
  const robot2 = await api('/api/onebot/robot', { token: alice.token });
  assert.equal(robot2.body.boundCharacterId, aliceChar2.id);
  assert.equal(robot2.body.boundCharacterName, '小满');

  const boundEvent = await waitForEvent(
    (e) => e.type === 'qq_binding' && e.next?.id === aliceChar2.id && e.current?.id === aliceChar1.id,
  );
  assert.ok(boundEvent, '切换成功应推送 WS qq_binding');

  // 关闭接入
  const unbind = await api(`/api/characters/${aliceChar2.id}/settings`, {
    method: 'PUT',
    token: alice.token,
    body: { qqEnabled: false },
  });
  assert.equal(unbind.status, 200);
  assert.equal(unbind.body.settings.qqEnabled, false);
  assert.equal(get('SELECT COUNT(*) AS n FROM characters WHERE user_id = ? AND qq_enabled = 1', alice.id).n, 0);
  const robot3 = await api('/api/onebot/robot', { token: alice.token });
  assert.equal(robot3.body.boundCharacterId, null);

  // 称呼长度校验
  const tooLong = await api(`/api/characters/${aliceChar1.id}/settings`, {
    method: 'PUT',
    token: alice.token,
    body: { userAddress: 'x'.repeat(21) },
  });
  assert.equal(tooLong.status, 400);
});

test('OneBot：忽略 notice / 输入状态 / 空消息，提示未接入 QQ，QQ 内处理分享', async () => {
  const notice = await api('/onebot/event', {
    method: 'POST',
    body: { post_type: 'notice', notice_type: 'input_status', user_id: Number(alice.qq), user_id_str: alice.qq },
  });
  assert.equal(notice.status, 200);
  assert.equal(notice.body.ignored, true);
  assert.equal(notice.body.reply, null);

  const sent = await api('/onebot/event', {
    method: 'POST',
    body: { post_type: 'message_sent', message_type: 'private', user_id: Number(alice.qq), raw_message: '我自己发的' },
  });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.ignored, true);

  const empty = await api('/onebot/event', {
    method: 'POST',
    body: { post_type: 'message', message_type: 'private', user_id: Number(bob.qq), message: [] },
  });
  assert.equal(empty.status, 200);
  assert.equal(empty.body.ignored, true);
  assert.equal(empty.body.reason, 'empty_message');

  // bob 有对话模型配置但没有接入 QQ 的角色
  const notBound = await api('/onebot/event', {
    method: 'POST',
    body: { post_type: 'message', message_type: 'private', user_id: Number(bob.qq), message: '你好' },
  });
  assert.equal(notBound.status, 200);
  assert.equal(notBound.body.reply, '角色还未接入QQ，请在角色设置中开启');
  assert.equal(notBound.body.reason, 'character_not_bound');

  // 接入 bob 的角色后再发空消息仍忽略（不触发聊天）
  const bindBob = await api(`/api/characters/${bobChar.id}/settings`, {
    method: 'PUT',
    token: bob.token,
    body: { qqEnabled: true },
  });
  assert.equal(bindBob.status, 200);

  // QQ 内回复「同意」处理待办分享
  const pending = await api('/api/shares', {
    method: 'POST',
    token: alice.token,
    body: { target: '2', direction: 'share', services: ['chat'], duration: { minutes: 20 } },
  });
  assert.equal(pending.status, 201, pending.text);

  const agree = await api('/onebot/event', {
    method: 'POST',
    body: { post_type: 'message', message_type: 'private', user_id: Number(bob.qq), raw_message: '同意' },
  });
  assert.equal(agree.status, 200, agree.text);
  assert.equal(agree.body.reason, 'share_accepted');
  assert.match(agree.body.reply, /已接受模型分享/);
  assert.equal(get('SELECT status FROM model_shares WHERE id = ?', pending.body.share.id).status, 'accepted');

  // bob 自己有 chat 配置：分享不覆盖自有配置，但仍应能看到收到的分享来源
  const bobCfg = await api('/api/config', { token: bob.token });
  assert.equal(bobCfg.body.shared.chat.ownerNickname, 'alice', '应展示收到的分享元信息');
  assert.equal(bobCfg.body.api.chat.shared, null, '自有配置生效时不标记为使用分享');
  assert.equal(getUserApi(bob.id).chat.apiKey, 'sk-bob-secret');

  // 已无待办时「同意」按普通消息处理（bob 已接入角色且有配置 → 会走对话，这里只校验不返回 400）
  const again = await api('/onebot/event', {
    method: 'POST',
    body: { post_type: 'message', message_type: 'private', user_id: Number(dave.qq), raw_message: '同意' },
  });
  assert.equal(again.status, 200);
  assert.notEqual(again.body.reason, 'share_accepted');
});

test('统计概览：新增 calls 与 callsByModel', async () => {
  const now = new Date().toISOString();
  const rows = [
    ['ur_shares_1', 'gpt-4o-mini', 100, 10, 50],
    ['ur_shares_2', 'gpt-4o-mini', 200, 0, 80],
    ['ur_shares_3', 'deepseek-chat', 300, 0, 120],
  ];
  for (const [id, model, input, cached, output] of rows) {
    run(
      'INSERT INTO usage_records(id, user_id, character_id, kind, model, input_tokens, cached_tokens, output_tokens, cost, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      id,
      alice.id,
      aliceChar1.id,
      'main',
      model,
      input,
      cached,
      output,
      0.001,
      now,
    );
  }

  const overview = await api(`/api/stats/overview?characterId=${aliceChar1.id}`, { token: alice.token });
  assert.equal(overview.status, 200);
  assert.equal(overview.body.calls, 3);
  assert.ok(Array.isArray(overview.body.callsByModel));
  const mini = overview.body.callsByModel.find((m) => m.model === 'gpt-4o-mini');
  const deepseek = overview.body.callsByModel.find((m) => m.model === 'deepseek-chat');
  assert.equal(mini.calls, 2);
  assert.equal(deepseek.calls, 1);
  assert.equal(overview.body.callsByModel[0].calls, 2, '应按调用次数倒序');

  const other = await api(`/api/stats/overview?characterId=${bobChar.id}`, { token: bob.token });
  assert.equal(other.body.calls, 0);
  assert.deepEqual(other.body.callsByModel, []);
});

test('分享参数校验：目标 / 服务 / 截止时间（UTC+8）/ 永久', async () => {
  const badTarget = await api('/api/shares', {
    method: 'POST',
    token: alice.token,
    body: { target: '9999', direction: 'share', services: ['chat'], duration: { days: 1 } },
  });
  assert.equal(badTarget.status, 404);
  assert.equal(badTarget.body.error.code, 'share_target_not_found');

  const selfShare = await api('/api/shares', {
    method: 'POST',
    token: alice.token,
    body: { target: '1', direction: 'share', services: ['chat'], duration: { days: 1 } },
  });
  assert.equal(selfShare.status, 400);
  assert.equal(selfShare.body.error.code, 'share_self');

  const noServices = await api('/api/shares', {
    method: 'POST',
    token: alice.token,
    body: { target: '3', direction: 'share', services: [], duration: { days: 1 } },
  });
  assert.equal(noServices.status, 400);
  assert.equal(noServices.body.error.code, 'services_required');

  const noExpiry = await api('/api/shares', {
    method: 'POST',
    token: alice.token,
    body: { target: '3', direction: 'share', services: ['chat'] },
  });
  assert.equal(noExpiry.status, 400);
  assert.equal(noExpiry.body.error.code, 'share_expiry_required');

  const badFormat = await api('/api/shares', {
    method: 'POST',
    token: alice.token,
    body: { target: '3', direction: 'share', services: ['chat'], expiresAt: '2026/12/01 20:00:00' },
  });
  assert.equal(badFormat.status, 400);
  assert.equal(badFormat.body.error.code, 'expires_at_invalid');

  const past = await api('/api/shares', {
    method: 'POST',
    token: alice.token,
    body: { target: '3', direction: 'share', services: ['chat'], expiresAt: '2020-01-01 00:00:00' },
  });
  assert.equal(past.status, 400);
  assert.equal(past.body.error.code, 'expires_at_past');

  // UTC+8 20:00 → UTC 12:00
  const absolute = await api('/api/shares', {
    method: 'POST',
    token: alice.token,
    body: { target: '3', direction: 'share', services: ['chat'], expiresAt: '2030-12-01 20:00:00' },
  });
  assert.equal(absolute.status, 201, absolute.text);
  assert.equal(absolute.body.share.expiresAt, '2030-12-01T12:00:00.000Z');

  const permanent = await api('/api/shares', {
    method: 'POST',
    token: alice.token,
    body: { target: '3', direction: 'share', services: ['chat'], permanent: true },
  });
  assert.equal(permanent.status, 201, permanent.text);
  assert.equal(permanent.body.share.permanent, true);
  assert.equal(permanent.body.share.expiresAt, null);
});
