// v1.3.0 统一模型配置与多提供源
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cocoa-sysmodels-'));
process.env.COCOA_DATA_DIR = DATA_DIR;
process.env.COCOA_LOG_LEVEL = 'error';

const { createApp } = await import('../src/app.js');
const { run } = await import('../src/db/index.js');
const { hashPassword, signToken, sha256 } = await import('../src/core/crypto.js');
const { setAdminSetting, getUserApi } = await import('../src/services/settings.js');

const now = new Date().toISOString();
const { hash, salt } = hashPassword('Passw0rd!');
run("INSERT INTO users(id,username,email,password_hash,password_salt,created_at) VALUES(?,?,?,?,?,?)", 'u_sys', 'sysuser', 'sys@test.local', hash, salt, now);
run("UPDATE users SET code = 1 WHERE id = 'u_sys'");
const userToken = signToken({ uid: 'u_sys', role: 'user' });
run('INSERT INTO auth_tokens(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)', sha256(userToken), 'u_sys', now, new Date(Date.now()+86400000).toISOString());
const adminToken = signToken({ uid: 'u_sys', role: 'admin' });
run('INSERT INTO auth_tokens(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)', sha256(adminToken), 'u_sys', now, new Date(Date.now()+86400000).toISOString());

setAdminSetting('system_models', {
  enabled: true,
  providers: [
    { id: 'sys-ds', name: 'Cocoa DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-system-secret', models: { chat: 'deepseek-chat', embedding: 'text-embedding-3-small' } },
  ],
});

const app = createApp();
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function api(pathname, { method = 'GET', body, token = userToken } = {}) {
  const res = await fetch(base + pathname, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

test('统一模型：用户可用系统提供源，密钥不泄露', async () => {
  const cfg = await api('/api/config');
  assert.equal(cfg.status, 200);
  assert.equal(cfg.json.systemModels.enabled, true);
  assert.equal(cfg.json.systemModels.providers[0].apiKey, '****');
  assert.doesNotMatch(JSON.stringify(cfg.json), /sk-system-secret/);

  const saved = await api('/api/config/api', { method: 'PUT', body: { modelSource: 'system', systemProviderId: 'sys-ds' } });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.ready.chat, true);
  assert.equal(saved.json.api.modelSource, 'system');
  const effective = getUserApi('u_sys');
  assert.equal(effective.chat.model, 'deepseek-chat');
  assert.equal(effective.chat.apiKey, 'sk-system-secret');
  assert.equal(effective.providerMeta.chat.source, 'system');
});

test('多配置：同一服务可保存多条配置并切换生效', async () => {
  const saved = await api('/api/config/api', {
    method: 'PUT',
    body: {
      modelSource: 'own',
      profiles: {
        chat: [
          { id: 'p1', name: '源一', baseUrl: 'https://a.example/v1', apiKey: 'sk-one', model: 'model-a', contextWindow: 64000 },
          { id: 'p2', name: '源二', baseUrl: 'https://b.example/v1', apiKey: 'sk-two', model: 'model-b', contextWindow: 128000 },
        ],
        embedding: [
          { id: 'e1', name: '嵌入', baseUrl: 'https://b.example/v1', apiKey: 'sk-two', model: 'embed-b' },
        ],
      },
      active: { chat: 'p2' },
    },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.api.profiles.chat.length, 2);
  assert.equal(saved.json.api.active.chat, 'p2');
  assert.match(saved.json.api.profiles.chat[1].apiKeyMasked, /\*\*\*\*/);
  assert.doesNotMatch(JSON.stringify(saved.json), /sk-one|sk-two/);
  const effective = getUserApi('u_sys');
  assert.equal(effective.chat.model, 'model-b');
  assert.equal(effective.chat.contextWindow, 128000);
  assert.equal(effective.providerMeta.chat.profileId, 'p2');
  assert.equal(effective.embedding.model, 'embed-b');

  // 再次保存时传 **** 保持旧 key
  const keep = await api('/api/config/api', {
    method: 'PUT',
    body: { profiles: { chat: saved.json.api.profiles.chat.map((p) => ({ ...p, apiKey: '****' })) } },
  });
  assert.equal(keep.status, 200, JSON.stringify(keep.json));
  const again = getUserApi('u_sys');
  assert.equal(again.chat.apiKey, 'sk-two');
  assert.equal(again.chat.model, 'model-b');
});

test('管理端可读写系统模型配置并掩码', async () => {
  run("UPDATE users SET role='admin' WHERE id='u_sys'");
  const r = await api('/api/admin/settings', { token: adminToken });
  assert.equal(r.status, 200);
  assert.equal(r.json.systemModels.enabled, true);
  assert.equal(r.json.systemModels.providers[0].apiKey, '****');
  const put = await api('/api/admin/settings', {
    method: 'PUT', token: adminToken,
    body: { systemModels: { enabled: false, providers: r.json.systemModels.providers } },
  });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  assert.equal(put.json.systemModels.enabled, false);
  assert.equal(put.json.systemModels.providers[0].apiKey, '****');
});

test.after(() => {
  server.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});
