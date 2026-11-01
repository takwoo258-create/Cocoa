// v1.2.0 用户代号与登录令牌续期
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cocoa-auth120-'));
process.env.COCOA_DATA_DIR = DATA_DIR;
process.env.COCOA_LOG_LEVEL = 'error';

const { createApp } = await import('../src/app.js');
const { get, run } = await import('../src/db/index.js');
const { sha256 } = await import('../src/core/crypto.js');

const app = createApp();
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function api(pathname, { method = 'GET', body, token } = {}) {
  const res = await fetch(base + pathname, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function register(email, qq) {
  const code = (await api('/api/auth/send-code', { method: 'POST', body: { email, purpose: 'register' } })).json.devCode;
  return api('/api/auth/register', {
    method: 'POST',
    body: { username: email.split('@')[0], email, password: 'Passw0rd!', confirmPassword: 'Passw0rd!', qq, code },
  });
}

test('注册按顺序分配用户代号，昵称与 code 返回', async () => {
  const a = await register('alice@v120.test', '10001');
  const b = await register('bob@v120.test', '10002');
  assert.equal(a.status, 201, JSON.stringify(a.json));
  assert.equal(a.json.user.code, 1);
  assert.equal(b.json.user.code, 2);
  assert.equal(a.json.user.nickname, 'alice');
});

test('登录令牌初始 3 天，每日首次访问延长，最长 4 天', async () => {
  const r = await api('/api/auth/login', {
    method: 'POST',
    body: { identifier: 'alice@v120.test', mode: 'password', password: 'Passw0rd!' },
  });
  assert.equal(r.status, 200);
  const token = r.json.token;
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  assert.equal(Math.round((payload.exp - payload.iat) / 86400000), 3);

  const th = sha256(token);
  const before = get('SELECT expires_at FROM auth_tokens WHERE token_hash = ?', th);
  await api('/api/auth/me', { token });
  const after = get('SELECT expires_at FROM auth_tokens WHERE token_hash = ?', th);
  // 首次访问会延长 1 天（同日只延长一次）
  assert.ok(new Date(after.expires_at) > new Date(before.expires_at));

  // 模拟“明天打开”：把 last_renew_at 拨回昨天，再次访问最多到 4 天
  run('UPDATE auth_tokens SET last_renew_at = ? WHERE token_hash = ?', new Date(Date.now() - 86400000).toISOString(), th);
  await api('/api/auth/me', { token });
  const later = get('SELECT expires_at FROM auth_tokens WHERE token_hash = ?', th);
  const days = (new Date(later.expires_at) - Date.now()) / 86400000;
  assert.ok(days <= 4.01, `续期超过 4 天: ${days}`);
});

test.after(() => {
  server.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});
