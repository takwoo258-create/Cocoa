// v1.0.1 新接口：版本检查与 QQ 动态
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cocoa-v101-'));
process.env.COCOA_DATA_DIR = DATA_DIR;
process.env.COCOA_LOG_LEVEL = 'error';

const { createApp } = await import('../src/app.js');
const { run } = await import('../src/db/index.js');
const { hashPassword } = await import('../src/core/crypto.js');
const { signToken, sha256 } = await import('../src/core/crypto.js');

const now = new Date().toISOString();
const { hash, salt } = hashPassword('Passw0rd!');
run("INSERT INTO users(id,username,email,password_hash,password_salt,created_at) VALUES(?,?,?,?,?,?)",
  'u_v101', 'v101', 'v101@test.local', hash, salt, now);
const token = signToken({ uid: 'u_v101', role: 'user' });
run('INSERT INTO auth_tokens(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)', sha256(token), 'u_v101', now, new Date(Date.now()+86400000).toISOString());

const app = createApp();
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function api(pathname, { method = 'GET', body, auth = true } = {}) {
  const res = await fetch(base + pathname, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(auth ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

test('QQ 动态：未登录 401', async () => {
  const r = await api('/api/onebot/qzone', { method: 'POST', body: { content: 'hi' }, auth: false });
  assert.equal(r.status, 401);
});

test('QQ 动态：内容为空 400', async () => {
  const r = await api('/api/onebot/qzone', { method: 'POST', body: { content: '   ' } });
  assert.equal(r.status, 400);
});

test('QQ 动态：OneBot 未连接 503', async () => {
  const r = await api('/api/onebot/qzone', { method: 'POST', body: { content: '今天的花开了。' } });
  assert.equal(r.status, 503, JSON.stringify(r.json));
  assert.equal(r.json.ok, false);
  assert.match(r.json.message, /NapCat|OneBot/);
});

test('版本检查：返回结构完整（GitHub 不可用时也不 5xx）', async () => {
  const r = await api('/api/version/latest?current=1.0.0', { auth: false });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok('updateAvailable' in r.json);
  assert.equal(r.json.current, '1.0.0');
  if (r.json.latest) {
    assert.ok(r.json.latest.version);
    if (r.json.latest.apk) assert.match(r.json.latest.apk.url, /^https:\/\//);
  }
});

test.after(() => {
  server.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});
