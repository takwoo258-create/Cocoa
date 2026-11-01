// 基座测试：加密、鉴权闭环、配置掩码（无需外部依赖）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cocoa-foundation-'));
process.env.COCOA_DATA_DIR = DATA_DIR;
process.env.COCOA_LOG_LEVEL = 'error';
process.env.COCOA_ADMIN_EMAIL = 'admin@cocoa.test';
process.env.COCOA_ADMIN_PASSWORD = 'Admin123456';

const { decryptText, encryptText, signToken, verifyToken, hashPassword, verifyPassword } = await import('../src/core/crypto.js');
const { createApp } = await import('../src/app.js');
const { ensureBootstrapAdmin } = await import('../src/services/bootstrap.js');

ensureBootstrapAdmin();
const app = createApp();
const server = app.listen(0);
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
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

test('双层加密：同用户可解，跨用户不可解', () => {
  const blob = encryptText('user-a', '可可喜欢喝热可可');
  assert.match(blob, /^c2\./);
  assert.equal(decryptText('user-a', blob), '可可喜欢喝热可可');
  assert.throws(() => decryptText('user-b', blob));
});

test('令牌签名与过期', () => {
  const token = signToken({ uid: 'u1', role: 'user' }, 60);
  const payload = verifyToken(token);
  assert.equal(payload.uid, 'u1');
  assert.equal(verifyToken(token.slice(0, -2) + 'zz'), null);
  const expired = signToken({ uid: 'u1' }, -1);
  assert.equal(verifyToken(expired), null);
});

test('口令散列', () => {
  const { hash, salt } = hashPassword('Pa55word!');
  assert.equal(verifyPassword('Pa55word!', hash, salt), true);
  assert.equal(verifyPassword('pa55word!', hash, salt), false);
});

test('注册-登录-配置 全链路', async () => {
  const email = 'alice@cocoa.test';
  const codeRes = await api('/api/auth/send-code', { method: 'POST', body: { email, purpose: 'register' } });
  assert.equal(codeRes.status, 200, JSON.stringify(codeRes.json));
  const code = codeRes.json.devCode;
  assert.match(code, /^\d{6}$/);

  // 60 秒内重复获取应被限流
  const again = await api('/api/auth/send-code', { method: 'POST', body: { email, purpose: 'register' } });
  assert.equal(again.status, 400);

  const reg = await api('/api/auth/register', {
    method: 'POST',
    body: {
      username: 'alice', email, password: 'Passw0rd!', confirmPassword: 'Passw0rd!',
      qq: '10001', code,
    },
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.json));
  assert.ok(reg.json.token);
  assert.equal(reg.json.user.role, 'user');

  const me = await api('/api/auth/me', { token: reg.json.token });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.email, email);

  // 重复邮箱
  const dup = await api('/api/auth/register', {
    method: 'POST',
    body: { username: 'alice2', email, password: 'Passw0rd!', confirmPassword: 'Passw0rd!', qq: '10002', code: '000000' },
  });
  assert.equal(dup.status, 409);

  // 密码错误
  const bad = await api('/api/auth/login', { method: 'POST', body: { identifier: email, mode: 'password', password: 'wrong' } });
  assert.equal(bad.status, 401);

  // 密码登录
  const login = await api('/api/auth/login', { method: 'POST', body: { identifier: email, mode: 'password', password: 'Passw0rd!' } });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  const token = login.json.token;

  // 配置读取：apiKey 不回显
  const cfg0 = await api('/api/config', { token });
  assert.equal(cfg0.status, 200);
  assert.equal(cfg0.json.api.chat.apiKeySet, false);

  const save = await api('/api/config/api', {
    method: 'PUT',
    token,
    body: { chat: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-test-1234567890', model: 'deepseek-chat' } },
  });
  assert.equal(save.status, 200, JSON.stringify(save.json));
  assert.equal(save.json.api.chat.apiKeySet, true);
  assert.doesNotMatch(JSON.stringify(save.json), /sk-test-1234567890/);

  // **** 表示保持不变
  const keep = await api('/api/config/api', {
    method: 'PUT',
    token,
    body: { chat: { apiKey: '****', model: 'deepseek-chat' } },
  });
  assert.equal(keep.status, 200);
  assert.equal(keep.json.api.chat.apiKeySet, true);

  const prefs = await api('/api/config/preferences', {
    method: 'PUT', token, body: { debug: true, limits: { hardTokens: 100000 } },
  });
  assert.equal(prefs.json.preferences.debug, true);
  assert.equal(prefs.json.preferences.limits.hardTokens, 100000);

  // 登出后令牌失效
  const out = await api('/api/auth/logout', { method: 'POST', token });
  assert.equal(out.status, 200);
  const after = await api('/api/auth/me', { token });
  assert.equal(after.status, 401);
});

test('管理员账号初始化与权限', async () => {
  const login = await api('/api/auth/login', {
    method: 'POST', body: { identifier: 'admin@cocoa.test', mode: 'password', password: 'Admin123456' },
  });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  assert.equal(login.json.user.role, 'admin');
});

test.after(() => {
  server.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});
