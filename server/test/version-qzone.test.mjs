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
run("UPDATE users SET role = 'admin' WHERE id = ?", 'u_v101');
const adminToken = signToken({ uid: 'u_v101', role: 'admin' });
run('INSERT INTO auth_tokens(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)', sha256(token), 'u_v101', now, new Date(Date.now()+86400000).toISOString());
run('INSERT INTO auth_tokens(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)', sha256(adminToken), 'u_v101', now, new Date(Date.now()+86400000).toISOString());

const app = createApp();
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function api(pathname, { method = 'GET', body, auth = true, tokenOverride = null } = {}) {
  const res = await fetch(base + pathname, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(auth ? { authorization: `Bearer ${tokenOverride || token}` } : {}),
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

test('多版本更新：强制版本 + 更高可选版本 + Beta 排序（v1.3.0）', async () => {
  const { buildUpdateState, compareVersion } = await import('../src/routes/version.js');
  const releases = [
    { version: '1.2.5', tag: 'v1.2.5', beta: false, notes: '[force]', apk: {} },
    { version: '1.3.0+++Beta 1', tag: 'v1.3.0+++Beta1', beta: true, notes: '', apk: {} },
    { version: '1.3.0', tag: 'v1.3.0', beta: false, notes: '', apk: {} },
    { version: '1.2.1', tag: 'v1.2.1', beta: false, notes: '', apk: {} },
  ];
  assert.equal(compareVersion('1.3.0', '1.3.0+++Beta 1'), 1);
  assert.equal(compareVersion('1.3.0+++Beta 2', '1.3.0+++Beta 1'), 1);
  const state = buildUpdateState(releases, '1.2.1', {});
  assert.equal(state.latest.version, '1.3.0');
  assert.equal(state.required.version, '1.2.5');
  assert.equal(state.forceUpdate, true);
  assert.equal(state.releases.find((r) => r.version === '1.3.0').force, false);
  const cfgForce = buildUpdateState(releases, '1.2.1', { minVersion: '1.3.0' });
  assert.equal(cfgForce.required.version, '1.3.0');
  assert.equal(cfgForce.forceUpdate, true);
  assert.equal(cfgForce.releases.find((r) => r.version === '1.3.0+++Beta 1').force, false, '更高可选 Beta 不应被标记为必须');
});

test('更新接口：返回多版本列表', async () => {
  const r = await api('/api/version/updates?current=1.0.0', { auth: false });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.releases));
  if (r.json.latest) assert.ok(r.json.latest.version);
});

test('版本更新要求：Release 说明标记解析', async () => {
  const { releaseForcesUpdate } = await import('../src/routes/version.js');
  assert.equal(releaseForcesUpdate('普通更新'), false);
  assert.equal(releaseForcesUpdate('重要 [force] 请立刻更新'), true);
  assert.equal(releaseForcesUpdate('<!-- cocoa:force -->'), true);
  assert.equal(releaseForcesUpdate('本版支持版本更新要求能力，但不强制'), false);
  assert.equal(releaseForcesUpdate('[版本更新要求] 最低 1.1.0'), true);
  assert.equal(releaseForcesUpdate('说明：在 Release 正文写 `[force]` 才会强制'), false);
  assert.equal(releaseForcesUpdate('[版本更新要求] 最低 1.1.0'), true);
  assert.equal(releaseForcesUpdate('```\n[force]\n```'), false);
});

test('版本更新要求：管理端 update.force 生效', async () => {
  const save = await api('/api/admin/settings', {
    method: 'PUT', tokenOverride: adminToken,
    body: { update: { force: true, minVersion: '1.1.0' } },
  });
  assert.equal(save.status, 200, JSON.stringify(save.json));
  assert.equal(save.json.update.force, true);
  assert.equal(save.json.update.minVersion, '1.1.0');

  const check = await api('/api/version/latest?current=1.0.1', { auth: false });
  assert.equal(check.status, 200);
  if (check.json.updateAvailable) {
    assert.equal(check.json.forceUpdate, true);
    assert.equal(check.json.forceReason, 'admin');
    assert.equal(check.json.requiredVersion, check.json.latest.version);
  }
  const cfg = await api('/api/admin/settings', { tokenOverride: adminToken });
  assert.equal(cfg.json.update.force, true);
});

test.after(() => {
  server.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});
