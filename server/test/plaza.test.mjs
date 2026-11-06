// v1.5.0 共享广场集成测试：本服广场 / 人设模板 / 模型授权 / 全球签名接口 / 封禁 / 通知
// 不联网：全球接口调用本进程自身，邮件用本地最小 SMTP 服务捕获。
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

const BASE_DIR = process.env.COCOA_DATA_DIR || '/tmp/cocoa-platform';
const DATA_DIR = path.join(BASE_DIR, `plaza-${process.pid}`);
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

process.env.COCOA_DATA_DIR = DATA_DIR;
process.env.NODE_ENV = 'test';
process.env.COCOA_LOG_LEVEL = process.env.COCOA_LOG_LEVEL || 'error';
process.env.COCOA_PLAZA_GLOBAL_TOKEN = 'test-global-token-0123456789';
process.env.COCOA_PLAZA_GLOBAL_HOST = '1'; // 测试进程同时扮演全球主机
delete process.env.COCOA_GLOBAL_PLAZA_URL;

const plaza = await import('../src/services/plaza.js');
const templates = await import('../src/services/templates.js');
const mail = await import('../src/mail/sender.js');
const cryptoMod = await import('../src/core/crypto.js');
const db = await import('../src/db/index.js');
const settings = await import('../src/services/settings.js');
const chars = await import('../src/services/characters.js');
const shares = await import('../src/services/shares.js');
const { recordUsage } = await import('../src/ai/usage.js');
const { attachWebSocket } = await import('../src/realtime/hub.js');
const { createApp } = await import('../src/app.js');

// ---------- 最小 SMTP 捕获服务 ----------
const mails = [];
const smtp = net.createServer((socket) => {
  socket.setEncoding('utf8');
  socket.write('220 cocoa-test ESMTP\r\n');
  let buffer = '';
  let inData = false;
  let message = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const idx = buffer.indexOf('\r\n');
      if (idx < 0) break;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (inData) {
        if (line === '.') {
          inData = false;
          mails.push(message);
          message = '';
          socket.write('250 2.0.0 Ok\r\n');
        } else {
          message += line + '\n';
        }
        continue;
      }
      const upper = line.toUpperCase();
      if (upper.startsWith('EHLO') || upper.startsWith('HELO')) socket.write('250-cocoa-test\r\n250 8BITMIME\r\n');
      else if (upper.startsWith('MAIL FROM')) socket.write('250 2.1.0 Ok\r\n');
      else if (upper.startsWith('RCPT TO')) socket.write('250 2.1.5 Ok\r\n');
      else if (upper === 'DATA') {
        inData = true;
        socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
      } else if (upper === 'QUIT') {
        socket.write('221 Bye\r\n');
        socket.end();
      } else socket.write('250 Ok\r\n');
    }
  });
  socket.on('error', () => {});
});
await new Promise((resolve) => smtp.listen(0, '127.0.0.1', resolve));
settings.setAdminSetting('smtp', {
  host: '127.0.0.1',
  port: smtp.address().port,
  secure: false,
  user: 'bot@test.local',
  pass: 'test-pass',
  from: 'bot@test.local',
});

const app = createApp();
const server = http.createServer(app);
attachWebSocket(server, '/ws');
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => smtp.close(resolve));
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ---------- 工具 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, { method = 'GET', token, body, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    h['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + pathname, { method, headers: h, body: payload });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

function makeUser({ username, role = 'user' }) {
  const id = `u_plaza_${Math.random().toString(36).slice(2, 10)}`;
  const { hash, salt } = cryptoMod.hashPassword('Passw0rd!123');
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO users(id, username, email, password_hash, password_salt, role, email_verified, status, created_at, last_active_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    id,
    username,
    `${username}@test.local`,
    hash,
    salt,
    role,
    1,
    'active',
    now,
    now,
  );
  const token = cryptoMod.signToken({ uid: id, role });
  db.run(
    'INSERT INTO auth_tokens(token_hash, user_id, created_at, expires_at) VALUES(?,?,?,?)',
    cryptoMod.sha256(token),
    id,
    now,
    new Date(Date.now() + 86400_000).toISOString(),
  );
  db.run('UPDATE users SET share_id = ? WHERE id = ?', plaza.randomShareId(), id);
  return { id, token, role, username, email: `${username}@test.local`, shareId: plaza.ensureShareId(id) };
}

function profileOf(name, extra = {}) {
  return {
    name,
    age: '18',
    race: '猫耳族',
    gender: '女',
    personality: '温柔又有一点小傲娇',
    worldview: '住在海边的咖啡馆里',
    hobbies: '晒太阳、做甜点',
    relation: '同居的伙伴',
    appearance: '浅棕色长发，琥珀色眼睛',
    occupation: '咖啡馆店员',
    ...extra,
  };
}

function openWs(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    const timer = setTimeout(() => reject(new Error('WS 连接超时')), 4000);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitEvent(ws, type, timeout = 4000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      resolve(null);
    }, timeout);
    function onMessage(data) {
      let evt = null;
      try {
        evt = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (evt?.type === type) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(evt);
      }
    }
    ws.on('message', onMessage);
  });
}

function waitAny(ws, types, timeout = 4000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      resolve(null);
    }, timeout);
    function onMessage(data) {
      let evt = null;
      try {
        evt = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (types.includes(evt?.type)) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(evt);
      }
    }
    ws.on('message', onMessage);
  });
}

function signedHeaders(shareId, signed) {
  return { 'x-share-id': shareId, 'x-timestamp': signed.timestamp, 'x-nonce': signed.nonce, 'x-signature': signed.signature };
}

const admin = makeUser({ username: 'plaza_admin', role: 'admin' });
const alice = makeUser({ username: 'alice' });
const bob = makeUser({ username: 'bob' });
const carol = makeUser({ username: 'carol' });

// alice 拥有一份可公开的模型配置
settings.saveUserApi(alice.id, {
  chat: { apiKey: 'sk-alice-secret', baseUrl: 'https://api.example.com/v1', model: 'gpt-4o-mini' },
});

// ═════════════════ 1. meta / share ID ═════════════════
test('广场 meta 与 share ID：本服永远可用，全球未配置时不可用', async () => {
  const unauth = await api('/api/plaza/meta');
  assert.equal(unauth.status, 401);

  const meta = await api('/api/plaza/meta', { token: alice.token });
  assert.equal(meta.status, 200);
  assert.equal(meta.json.scopeServer, true);
  assert.equal(meta.json.globalAvailable, true, '未配置全球地址时回退到请求 origin');
  assert.equal(meta.json.globalUrl, base);
  assert.equal(meta.json.globalHost, true, '本机作为全球主机');
  assert.equal(meta.json.shareId, alice.shareId);
  assert.equal(meta.json.rateLimit.maxPerIp, 60);
  assert.deepEqual(meta.json.kinds, ['template', 'model']);

  const sid = await api('/api/plaza/share-id', { token: alice.token });
  assert.equal(sid.status, 200);
  assert.match(sid.json.shareId, /^[A-Za-z0-9]{8}$/);

  const rotated = await api('/api/plaza/share-id/rotate', { method: 'POST', token: alice.token, body: {} });
  assert.equal(rotated.status, 200);
  assert.match(rotated.json.shareId, /^[A-Za-z0-9]{8}$/);
  assert.notEqual(rotated.json.shareId, alice.shareId);
  alice.shareId = rotated.json.shareId;

  const again = await api('/api/plaza/share-id/rotate', { method: 'POST', token: alice.token, body: {} });
  assert.equal(again.status, 429);
  assert.equal(again.json.error.code, 'share_id_rotate_cooldown');
});

// ═════════════════ 2. 模板 CRUD / 导入去重 / 应用建角 ═════════════════
test('人设模板：CRUD、从角色导入去重、一键应用创建角色', async () => {
  const character = chars.createCharacter(alice.id, profileOf('铃兰'));

  const imported = await api('/api/templates/import', {
    method: 'POST',
    token: alice.token,
    body: { characterId: character.id },
  });
  assert.equal(imported.status, 201, imported.text);
  assert.equal(imported.json.template.profile.name, '铃兰');
  assert.match(imported.json.template.hash, /^[0-9a-f]{64}$/);

  const dupe = await api('/api/templates/import', {
    method: 'POST',
    token: alice.token,
    body: { characterId: character.id },
  });
  assert.equal(dupe.status, 409);
  assert.equal(dupe.json.error.code, 'template_duplicate');
  assert.equal(dupe.json.error.detail.templateId, imported.json.template.id);

  const created = await api('/api/templates', {
    method: 'POST',
    token: alice.token,
    body: { name: '海边少女', profile: profileOf('汐') },
  });
  assert.equal(created.status, 201);
  const templateId = created.json.template.id;

  const list = await api('/api/templates', { token: alice.token });
  assert.equal(list.status, 200);
  assert.equal(list.json.total, 2);

  const sources = await api('/api/templates/sources', { token: alice.token });
  assert.ok(sources.json.items.some((item) => item.characterId === character.id));

  const renamed = await api(`/api/templates/${templateId}`, {
    method: 'PATCH',
    token: alice.token,
    body: { name: '汐 · 海边' },
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.template.name, '汐 · 海边');

  const applied = await api(`/api/templates/${templateId}/apply`, {
    method: 'POST',
    token: alice.token,
    body: { name: '汐月' },
  });
  assert.equal(applied.status, 201);
  assert.equal(applied.json.character.name, '汐月');
  assert.equal(applied.json.character.race, '猫耳族');
  assert.equal(applied.json.templateId, templateId);

  const other = await api(`/api/templates/${templateId}`, { token: bob.token });
  assert.equal(other.status, 404, '模板按用户隔离');

  const deleted = await api(`/api/templates/${templateId}`, { method: 'DELETE', token: alice.token });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.json.ok, true);
});

// ═════════════════ 3. 发布 / 列表 / 搜索 / 点赞 / 自用限制 ═════════════════
let publishedTemplateId = null;

test('发布人设模板到本服广场：摘要不含密钥、列表可搜索、点赞、不能使用自己的资源', async () => {
  const res = await api('/api/plaza/resources', {
    method: 'POST',
    token: alice.token,
    body: {
      kind: 'template',
      title: '猫耳女仆 · 铃兰',
      description: '温柔又会做甜点的猫耳少女',
      visibility: 'server',
      permanent: true,
      profile: profileOf('铃兰'),
    },
  });
  assert.equal(res.status, 201, res.text);
  const resource = res.json.resource;
  publishedTemplateId = resource.id;
  assert.equal(resource.kind, 'template');
  assert.equal(resource.visibility, 'server');
  assert.equal(resource.owner.shareId, alice.shareId);
  assert.equal(resource.owner.nickname, 'alice');
  assert.equal(resource.profile.name, '铃兰');
  assert.equal(resource.status, 'active');
  assert.equal(resource.tokenHard, 0);
  assert.ok(!('payload' in resource), '不得返回加密 payload');

  const list = await api('/api/plaza/resources?scope=server&kind=template&q=铃兰', { token: bob.token });
  assert.equal(list.status, 200);
  assert.equal(list.json.total, 1);
  assert.equal(list.json.items[0].id, resource.id);
  assert.equal(list.json.items[0].mine, false);

  const byShare = await api(`/api/plaza/resources?shareId=${alice.shareId}`, { token: bob.token });
  assert.equal(byShare.json.total, 1);

  const liked = await api(`/api/plaza/resources/${resource.id}/like`, { method: 'POST', token: bob.token, body: {} });
  assert.equal(liked.status, 200);
  assert.equal(liked.json.liked, true);
  assert.equal(liked.json.likeCount, 1);
  const unliked = await api(`/api/plaza/resources/${resource.id}/like`, { method: 'POST', token: bob.token, body: {} });
  assert.equal(unliked.json.liked, false);
  assert.equal(unliked.json.likeCount, 0);

  const selfUse = await api(`/api/plaza/${resource.id}/use`, { method: 'POST', token: alice.token, body: {} });
  assert.equal(selfUse.status, 400);
  assert.equal(selfUse.json.error.code, 'plaza_self_use');

  const updated = await api(`/api/plaza/resources/${resource.id}`, {
    method: 'PATCH',
    token: alice.token,
    body: { title: '猫耳女仆 · 铃兰（改）' },
  });
  assert.equal(updated.status, 200);
  assert.match(updated.json.resource.title, /改/);

  const hidden = await api(`/api/plaza/resources/${resource.id}`, {
    method: 'PATCH',
    token: alice.token,
    body: { status: 'hidden' },
  });
  assert.equal(hidden.json.resource.status, 'hidden');
  const useHidden = await api(`/api/plaza/${resource.id}/use`, { method: 'POST', token: bob.token, body: {} });
  assert.equal(useHidden.status, 409);
  await api(`/api/plaza/resources/${resource.id}`, { method: 'PATCH', token: alice.token, body: { status: 'active' } });

  const invalid = await api('/api/plaza/resources', {
    method: 'POST',
    token: alice.token,
    body: { kind: 'template', title: 'x', visibility: 'users', permanent: true, profile: profileOf('x') },
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error.code, 'plaza_target_required');

  const badKind = await api('/api/plaza/resources', {
    method: 'POST',
    token: alice.token,
    body: { kind: 'book', title: 'x', permanent: true },
  });
  assert.equal(badKind.status, 400);
  assert.equal(badKind.json.error.code, 'plaza_kind_invalid');

  const badSid = await api('/api/plaza/resources', {
    method: 'POST',
    token: alice.token,
    body: { kind: 'template', title: 'x', visibility: 'users', targetShareIds: ['bad!'], permanent: true, profile: profileOf('x') },
  });
  assert.equal(badSid.status, 400);
  assert.equal(badSid.json.error.code, 'share_id_invalid');

  const past = await api('/api/plaza/resources', {
    method: 'POST',
    token: alice.token,
    body: { kind: 'template', title: 'x', expiresAt: '2020-01-01 00:00:00', profile: profileOf('x') },
  });
  assert.equal(past.status, 400);
  assert.equal(past.json.error.code, 'plaza_expires_past');
});

// ═════════════════ 4. 使用模板（应用内通知，不发邮件） ═════════════════
test('使用模板：返回人设、写入授权、通知发布者只走应用内（无邮件）', async () => {
  const mailBefore = mails.length;
  const ws = await openWs(alice.token);
  try {
    const eventPromise = waitEvent(ws, 'plaza_used');
    const used = await api(`/api/plaza/${publishedTemplateId}/use`, { method: 'POST', token: bob.token, body: {} });
    assert.equal(used.status, 200, used.text);
    assert.equal(used.json.kind, 'template');
    assert.equal(used.json.profile.name, '铃兰');
    assert.equal(used.json.resource.useCount, 1);
    assert.equal(used.json.grant.status, 'active');
    assert.equal(used.json.grant.ownerShareId, alice.shareId);

    const event = await eventPromise;
    assert.ok(event, '发布者应收到 plaza_used 应用内通知');
    assert.equal(event.resourceId, publishedTemplateId);
    assert.equal(event.by.shareId, bob.shareId);
    await sleep(150);
    assert.equal(mails.length, mailBefore, '资源被使用不应发送邮件');
  } finally {
    ws.close();
  }

  const mine = await api('/api/plaza/mine?box=grants', { token: bob.token });
  assert.equal(mine.status, 200);
  assert.equal(mine.json.total, 1);
  assert.equal(mine.json.items[0].resource.id, publishedTemplateId);

  const published = await api('/api/plaza/mine?box=published', { token: alice.token });
  assert.ok(published.json.items.some((item) => item.id === publishedTemplateId));
  assert.equal(published.json.items[0].useCount >= 1, true);
});

// ═════════════════ 5. 定向可见性 ═════════════════
test('定向分享：只有目标 share ID 可见/可用', async () => {
  const res = await api('/api/plaza/resources', {
    method: 'POST',
    token: alice.token,
    body: {
      kind: 'template',
      title: '只给 carol',
      visibility: 'users',
      targetShareIds: [carol.shareId],
      permanent: true,
      profile: profileOf('只给 carol'),
    },
  });
  assert.equal(res.status, 201, res.text);
  const id = res.json.resource.id;
  assert.deepEqual(res.json.resource.targetShareIds, [carol.shareId]);

  const bobList = await api('/api/plaza/resources?scope=server', { token: bob.token });
  assert.ok(!bobList.json.items.some((item) => item.id === id), '非目标用户列表不可见');

  const bobUse = await api(`/api/plaza/${id}/use`, { method: 'POST', token: bob.token, body: {} });
  assert.equal(bobUse.status, 403);
  assert.equal(bobUse.json.error.code, 'plaza_forbidden');

  const carolUse = await api(`/api/plaza/${id}/use`, { method: 'POST', token: carol.token, body: {} });
  assert.equal(carolUse.status, 200);
  assert.equal(carolUse.json.profile.name, '只给 carol');
});

// ═════════════════ 6. 模型授权：镜像生效 / 密钥不外泄 ═════════════════
let modelResourceId = null;

test('模型资源：发布不带密钥，使用后本机配置生效且客户端只拿 provider 引用', async () => {
  const res = await api('/api/plaza/resources', {
    method: 'POST',
    token: alice.token,
    body: {
      kind: 'model',
      title: 'GPT-4o-mini 使用权',
      description: '给朋友用的对话模型',
      visibility: 'server',
      permanent: true,
      services: ['chat'],
    },
  });
  assert.equal(res.status, 201, res.text);
  modelResourceId = res.json.resource.id;
  assert.deepEqual(res.json.resource.services, ['chat']);
  assert.ok(!res.text.includes('sk-alice-secret'), '接口响应不得包含 apiKey');
  assert.ok(!res.text.includes('apiKey'));

  const used = await api(`/api/plaza/${modelResourceId}/use`, { method: 'POST', token: bob.token, body: {} });
  assert.equal(used.status, 200, used.text);
  assert.equal(used.json.kind, 'model');
  assert.equal(used.json.providerRef.providerId, `plaza:${modelResourceId}`);
  assert.ok(!used.text.includes('sk-alice-secret'), '使用接口也不得返回密钥');
  assert.deepEqual(used.json.services, ['chat']);

  // 本机 AI 配置应已自动采用广场授权（服务端持有 key，客户端不可见）
  const cfg = settings.getUserApi(bob.id);
  assert.equal(cfg.chat.apiKey, 'sk-alice-secret');
  assert.equal(cfg.providerMeta.chat.source, 'shared');

  const mirror = db.get("SELECT * FROM model_shares WHERE target_id = ? AND note LIKE 'plaza:%'", bob.id);
  assert.ok(mirror, '应生成广场授权镜像行');
  assert.equal(mirror.status, 'accepted');

  // 「模型分享」列表不显示广场镜像
  const legacy = await api('/api/shares?box=active', { token: bob.token });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.json.items.length, 0, '广场授权不应污染旧分享列表');

  const legacyPlaza = await api('/api/plaza/legacy-shares', { token: bob.token });
  assert.equal(legacyPlaza.status, 200);
  assert.ok(Array.isArray(legacyPlaza.json.items));
});

// ═════════════════ 7. 额度：软/硬限额通知 + 镜像撤销 ═════════════════
test('模型额度：软限额应用内+邮件提示，硬限额停止生效并撤销授权', async () => {
  const res = await api('/api/plaza/resources', {
    method: 'POST',
    token: alice.token,
    body: {
      kind: 'model',
      title: '限量 GPT',
      visibility: 'server',
      permanent: true,
      services: ['chat'],
      tokenSoft: 100,
      tokenHard: 200,
    },
  });
  assert.equal(res.status, 201, res.text);
  const id = res.json.resource.id;

  const used = await api(`/api/plaza/${id}/use`, { method: 'POST', token: carol.token, body: {} });
  assert.equal(used.status, 200, used.text);
  assert.equal(settings.getUserApi(carol.id).chat.apiKey, 'sk-alice-secret');

  const ws = await openWs(carol.token);
  try {
    const mailBefore = mails.length;
    const softPromise = waitEvent(ws, 'plaza_quota');
    recordUsage({
      userId: carol.id,
      characterId: null,
      kind: 'main',
      model: 'gpt-4o-mini',
      usage: { input: 60, cached: 0, output: 60 },
    });
    const softEvent = await softPromise;
    assert.ok(softEvent, '应收到软限额应用内通知');
    assert.equal(softEvent.level, 'soft');
    assert.equal(db.get('SELECT status FROM plaza_grants WHERE resource_id = ? AND user_id = ?', id, carol.id).status, 'soft_limited');
    await sleep(200);
    assert.ok(mails.length > mailBefore, '软限额应发送邮件');

    const mailAfterSoft = mails.length;
    const hardPromise = waitEvent(ws, 'plaza_quota');
    const hardUsage = recordUsage({
      userId: carol.id,
      characterId: null,
      kind: 'main',
      model: 'gpt-4o-mini',
      usage: { input: 100, cached: 0, output: 100 },
    });
    assert.ok(hardUsage.cost >= 0);
    const hardEvent = await hardPromise;
    assert.ok(hardEvent, '应收到硬限额应用内通知');
    assert.equal(hardEvent.level, 'hard');
    const grant = db.get('SELECT * FROM plaza_grants WHERE resource_id = ? AND user_id = ?', id, carol.id);
    assert.equal(grant.status, 'exhausted');
    assert.ok(grant.used_tokens >= 200);
    await sleep(200);
    assert.ok(mails.length > mailAfterSoft, '硬限额应发送邮件');

    const mirror = db.get("SELECT * FROM model_shares WHERE target_id = ? AND note LIKE 'plaza:%' AND status = 'accepted'", carol.id);
    assert.equal(mirror, undefined, '硬限额后镜像授权应撤销');
    assert.ok(!settings.getUserApi(carol.id).chat.apiKey, '硬限额后不再自动使用广场模型');

    const reUse = await api(`/api/plaza/${id}/use`, { method: 'POST', token: carol.token, body: {} });
    assert.equal(reUse.status, 403);
    assert.equal(reUse.json.error.code, 'plaza_quota_exhausted');
  } finally {
    ws.close();
  }
});

// ═════════════════ 8. 封禁 ═════════════════
test('管理员禁用分享权：只能本服用户、发布被拒、应用内+邮件通知', async () => {
  const ws = await openWs(carol.token);
  try {
    const mailBefore = mails.length;
    const eventPromise = waitEvent(ws, 'plaza_banned');
    const created = await api('/api/admin/plaza/bans', {
      method: 'PUT',
      token: admin.token,
      body: {
        shareId: carol.shareId,
        scope: 'server',
        reason: '测试封禁',
        until: '2099-01-01 00:00:00',
      },
    });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.json.ban.user.shareId, carol.shareId);
    assert.equal(created.json.ban.scope, 'server');

    const event = await eventPromise;
    assert.ok(event, '被封禁用户应收到应用内通知');
    await sleep(200);
    assert.ok(mails.length > mailBefore, '封禁应发送邮件');

    const publish = await api('/api/plaza/resources', {
      method: 'POST',
      token: carol.token,
      body: { kind: 'template', title: 'x', permanent: true, profile: profileOf('x') },
    });
    assert.equal(publish.status, 403);
    assert.equal(publish.json.error.code, 'plaza_banned');

    const list = await api('/api/admin/plaza/bans?activeOnly=1', { token: admin.token });
    assert.ok(list.json.items.some((item) => item.user.shareId === carol.shareId));

    const missing = await api('/api/admin/plaza/bans', {
      method: 'PUT',
      token: admin.token,
      body: { shareId: 'ZZZZZZZZ', scope: 'all', permanent: true },
    });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, 'ban_user_not_found');

    const removed = await api(`/api/admin/plaza/bans/${created.json.ban.id}`, { method: 'DELETE', token: admin.token });
    assert.equal(removed.status, 200);
    assert.equal(db.get('SELECT id FROM plaza_bans WHERE id = ?', created.json.ban.id), undefined);
  } finally {
    ws.close();
  }
});

// ═════════════════ 9. 全球接口（签名） ═════════════════
test('全球广场：公开只读 + 服务间签名（nonce 防重放）+ 本服代理', async () => {
  process.env.COCOA_GLOBAL_PLAZA_URL = base;
  const remoteSid = 'AbCd1234'; // 外站发布者：本服没有该用户
  const remoteConsumer = 'QwEr5678'; // 外站使用者

  const meta = await api('/api/plaza/meta', { token: alice.token });
  assert.equal(meta.json.globalUrl, base);
  assert.equal(meta.json.globalAvailable, true);
  assert.equal(meta.json.globalHost, true);
  assert.equal(meta.json.scopeServer, true);
  assert.equal(meta.json.shareId, alice.shareId);

  const pathPublish = '/api/plaza/global/publish';
  const body = {
    kind: 'template',
    title: '全球模板',
    description: '跨服人设',
    permanent: true,
    profile: profileOf('露娜'),
    ownerShareId: remoteSid,
    originUrl: 'https://remote.example.com',
    ownerNickname: '远端小砂',
  };
  const bodyString = JSON.stringify(body);

  const unsigned = await api(pathPublish, { method: 'POST', body, headers: { 'x-share-id': remoteSid } });
  assert.equal(unsigned.status, 401);
  assert.equal(unsigned.json.error.code, 'plaza_signature_required');

  const noNonce = await api(pathPublish, {
    method: 'POST',
    body,
    headers: { 'x-share-id': remoteSid, 'x-timestamp': String(Date.now()), 'x-signature': 'deadbeef' },
  });
  assert.equal(noNonce.status, 401);
  assert.equal(noNonce.json.error.code, 'plaza_nonce_required');

  const stale = plaza.signGlobalRequest({ method: 'POST', path: pathPublish, bodyString, timestamp: Date.now() - 600_000 });
  const staleRes = await api(pathPublish, { method: 'POST', body, headers: signedHeaders(remoteSid, stale) });
  assert.equal(staleRes.status, 401);
  assert.equal(staleRes.json.error.code, 'plaza_signature_expired');

  const signed = plaza.signGlobalRequest({ method: 'POST', path: pathPublish, bodyString });
  const published = await api(pathPublish, { method: 'POST', body, headers: signedHeaders(remoteSid, signed) });
  assert.equal(published.status, 201, published.text);
  assert.equal(published.json.resource.visibility, 'global');
  assert.equal(published.json.resource.owner.shareId, remoteSid);
  const globalTemplateId = published.json.resource.id;

  // nonce 重放
  const replay = await api(pathPublish, { method: 'POST', body, headers: signedHeaders(remoteSid, signed) });
  assert.equal(replay.status, 401);
  assert.equal(replay.json.error.code, 'plaza_nonce_replay');

  // 公开只读列表：不登录、不带 share ID
  const publicList = await api('/api/plaza/global/list?scope=global');
  assert.equal(publicList.status, 200);
  assert.equal(publicList.json.ok, true);
  assert.equal(publicList.json.globalAvailable, true);
  const item = publicList.json.items.find((row) => row.id === globalTemplateId);
  assert.ok(item, '公开列表应包含全球资源');
  assert.equal(item.ownerShareId, remoteSid);
  assert.equal(item.ownerNickname, '远端小砂');
  assert.equal(item.kind, 'template');
  assert.equal(item.tokenHard, 0);
  assert.ok(!('payload' in item));
  assert.ok(!('profile' in item), '列表只返回摘要，不返回完整人设');
  assert.ok(!publicList.text.includes('@test.local'), '不得返回邮箱');
  assert.ok(!publicList.text.includes('apiKey'), '不得返回密钥');

  // 登录用户通过本服代理读取
  const proxied = await api('/api/plaza/global/list?kind=template', { token: bob.token });
  assert.equal(proxied.status, 200);
  assert.equal(proxied.json.ok, true);
  assert.equal(proxied.json.globalAvailable, true);

  // 全球使用模板（服务间签名）
  const pathUse = '/api/plaza/global/use';
  const useBody = { resourceId: globalTemplateId };
  const useSig = plaza.signGlobalRequest({ method: 'POST', path: pathUse, bodyString: JSON.stringify(useBody) });
  const used = await api(pathUse, {
    method: 'POST',
    body: useBody,
    headers: signedHeaders(remoteConsumer, useSig),
  });
  assert.equal(used.status, 200, used.text);
  assert.equal(used.json.kind, 'template');
  assert.equal(used.json.profile.name, '露娜');
  assert.ok(!used.text.includes('apiKey'));

  // 全球点赞（服务间签名）
  const likeBody = { resourceId: globalTemplateId };
  const likeSig = plaza.signGlobalRequest({ method: 'POST', path: '/api/plaza/global/like', bodyString: JSON.stringify(likeBody) });
  const liked = await api('/api/plaza/global/like', {
    method: 'POST',
    body: likeBody,
    headers: signedHeaders(remoteConsumer, likeSig),
  });
  assert.equal(liked.status, 200, liked.text);
  assert.equal(liked.json.liked, true);
  assert.ok(liked.json.likes >= 1);

  // 全球发布模型（sealedPayload 加密传输）
  const modelBody = {
    kind: 'model',
    title: '全球模型',
    permanent: true,
    sealedPayload: plaza.sealPayload({
      services: ['chat'],
      config: { chat: { apiKey: 'sk-global-secret', baseUrl: 'https://global.example.com/v1', model: 'gpt-4o-mini' } },
      models: { chat: 'gpt-4o-mini' },
    }),
  };
  const modelBodyString = JSON.stringify(modelBody);
  const modelSig = plaza.signGlobalRequest({ method: 'POST', path: pathPublish, bodyString: modelBodyString });
  const modelRes = await api(pathPublish, {
    method: 'POST',
    body: modelBody,
    headers: signedHeaders(remoteSid, modelSig),
  });
  assert.equal(modelRes.status, 201, modelRes.text);
  assert.ok(!modelRes.text.includes('sk-global-secret'), '全球发布响应不得出现明文 key');
  const globalModelId = modelRes.json.resource.id;

  // 本地用户通过本服代理使用全球模型：镜像生效，客户端只拿 provider 引用
  const proxyUse = await api(`/api/plaza/global/${globalModelId}/use`, { method: 'POST', token: carol.token, body: {} });
  assert.equal(proxyUse.status, 200, proxyUse.text);
  assert.equal(proxyUse.json.kind, 'model');
  assert.equal(proxyUse.json.providerRef.providerId, `plaza:${proxyUse.json.resource.id}`);
  assert.ok(!proxyUse.text.includes('sk-global-secret'), '代理使用不得把密钥返回客户端');
  assert.ok(!('sealedPayload' in proxyUse.json), '代理使用不得把服务间封装 payload 返回客户端');
  assert.equal(settings.getUserApi(carol.id).chat.apiKey, 'sk-global-secret');

  // 代理发布：本服用户发布全球资源
  const proxyPublish = await api('/api/plaza/global/publish', {
    method: 'POST',
    token: alice.token,
    body: { kind: 'template', title: '代理发布的模板', permanent: true, profile: profileOf('赛琳娜') },
  });
  assert.equal(proxyPublish.status, 201, proxyPublish.text);
  assert.equal(proxyPublish.json.resource.owner.shareId, alice.shareId);
  assert.equal(proxyPublish.json.resource.visibility, 'global');

  // 代理点赞
  const proxyLike = await api(`/api/plaza/global/${globalTemplateId}/like`, { method: 'POST', token: bob.token, body: {} });
  assert.equal(proxyLike.status, 200, proxyLike.text);
  assert.equal(typeof proxyLike.json.liked, 'boolean');

  const likedList = await api('/api/plaza/global/list?kind=template', { token: bob.token });
  const likedItem = likedList.json.items.find((row) => row.id === globalTemplateId);
  assert.ok(likedItem, '代理列表应能看到该资源');
  assert.equal(typeof likedItem.liked, 'boolean');

  // 兼容旧导入接口（等价于代理使用）
  const imported = await api(`/api/plaza/global/${globalTemplateId}/import`, { method: 'POST', token: bob.token, body: {} });
  assert.equal(imported.status, 200, imported.text);
  assert.equal(imported.json.kind, 'template');
  assert.equal(imported.json.profile.name, '露娜');
});

test('全球封禁：按 share ID 全局禁用（scope=global），代理发布被拒', async () => {
  const bannedSid = 'BanMe123';
  const created = await api('/api/admin/plaza/bans', {
    method: 'PUT',
    token: admin.token,
    body: { shareId: bannedSid, scope: 'global', reason: '跨服测试', permanent: true },
  });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json.ban.user.shareId, bannedSid);
  assert.equal(created.json.ban.scope, 'global');

  const pathPublish = '/api/plaza/global/publish';
  const body = { kind: 'template', title: '被封禁的发布', permanent: true, profile: profileOf('x') };
  const sig = plaza.signGlobalRequest({ method: 'POST', path: pathPublish, bodyString: JSON.stringify(body) });
  const res = await api(pathPublish, { method: 'POST', body, headers: signedHeaders(bannedSid, sig) });
  assert.equal(res.status, 403);
  assert.equal(res.json.error.code, 'plaza_banned');

  // 非 global 作用域不允许禁用外站用户
  const localOnly = await api('/api/admin/plaza/bans', {
    method: 'PUT',
    token: admin.token,
    body: { shareId: 'Remote999', scope: 'server', permanent: true },
  });
  assert.equal(localOnly.status, 404);
  assert.equal(localOnly.json.error.code, 'ban_user_not_found');

  await api(`/api/admin/plaza/bans/${created.json.ban.id}`, { method: 'DELETE', token: admin.token });
});

// ═════════════════ 11. 旧模型分享兼容 ═════════════════
test('旧 /api/shares 保留可用，广场列出旧 active 分享', async () => {
  const created = await api('/api/shares', {
    method: 'POST',
    token: alice.token,
    body: {
      target: bob.email,
      direction: 'share',
      services: ['chat'],
      permanent: true,
      note: '兼容测试',
    },
  });
  assert.equal(created.status, 201, created.text);
  const shareId = created.json.share.id;
  const accepted = await api(`/api/shares/${shareId}/respond`, {
    method: 'POST',
    token: bob.token,
    body: { accept: true },
  });
  assert.equal(accepted.status, 200);

  const legacy = await api('/api/plaza/legacy-shares', { token: bob.token });
  assert.equal(legacy.status, 200);
  assert.ok(legacy.json.items.some((item) => item.id === shareId && item.legacy === true));
});

// ═════════════════ 12. 到期巡检 ═════════════════
test('到期巡检：资源过期、授权到期通知（应用内 + 邮件）', async () => {
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const local = new Date(new Date(expiresAt).getTime() + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
  const res = await api('/api/plaza/resources', {
    method: 'POST',
    token: alice.token,
    body: { kind: 'template', title: '限时模板', visibility: 'server', expiresAt: local, profile: profileOf('限时') },
  });
  assert.equal(res.status, 201, res.text);
  const id = res.json.resource.id;

  const used = await api(`/api/plaza/${id}/use`, { method: 'POST', token: bob.token, body: {} });
  assert.equal(used.status, 200);
  const grantId = used.json.grant.id;

  const ws = await openWs(bob.token);
  try {
    const mailBefore = mails.length;
    const eventPromise = waitAny(ws, ['plaza_expiring', 'plaza_expired'], 4000);
    const future = new Date(Date.now() + 2 * 3600_000);
    const stats = plaza.expireDuePlaza(future);
    assert.ok(stats.resources >= 1);
    assert.ok(stats.grants >= 1 || stats.reminders >= 1);
    const event = await eventPromise;
    assert.ok(event, '到期前/到期应收到应用内通知');
    await sleep(250);
    assert.ok(mails.length > mailBefore, '到期通知应发送邮件');
    const grant = db.get('SELECT * FROM plaza_grants WHERE id = ?', grantId);
    assert.ok(['expiring', 'expired'].includes(grant.status));
    assert.equal(db.get('SELECT status FROM plaza_resources WHERE id = ?', id).status, 'expired');
  } finally {
    ws.close();
  }
});

// ═════════════════ 13. 全球不可用降级 ═════════════════
test('全球地址不可达时：代理列表降级为 ok:false（不 500）', async () => {
  const saved = process.env.COCOA_GLOBAL_PLAZA_URL;
  try {
    process.env.COCOA_GLOBAL_PLAZA_URL = 'http://127.0.0.1:1';
    const res = await api('/api/plaza/global/list?scope=global', { token: bob.token });
    assert.equal(res.status, 200, '代理接口不应 500');
    assert.equal(res.json.ok, false);
    assert.equal(res.json.globalAvailable, false);
    assert.deepEqual(res.json.items, []);

    const meta = await api('/api/plaza/meta', { token: bob.token });
    assert.equal(meta.json.globalUrl, 'http://127.0.0.1:1');
    assert.equal(meta.json.globalAvailable, true, '地址已配置即视为可尝试');
  } finally {
    if (saved === undefined) delete process.env.COCOA_GLOBAL_PLAZA_URL;
    else process.env.COCOA_GLOBAL_PLAZA_URL = saved;
  }
});

// ═════════════════ 14. 全球限流（放最后，消耗同 IP 配额） ═════════════════
test('全球接口限流：每分钟每 IP 60 次，超出返回 429', async () => {
  let hit429 = false;
  let last = null;
  for (let i = 0; i < 90; i++) {
    last = await api('/api/plaza/global/list?scope=global');
    if (last.status === 429) {
      hit429 = true;
      break;
    }
  }
  assert.ok(hit429, '连续请求应触发限流');
  assert.equal(last.json.error.code, 'rate_limited');
});
