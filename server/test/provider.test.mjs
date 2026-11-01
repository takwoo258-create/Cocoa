// 模型列表与上下文解析（v1.0.1）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cocoa-provider-'));
process.env.COCOA_DATA_DIR = DATA_DIR;
process.env.COCOA_LOG_LEVEL = 'error';

const { createMockOpenAI } = await import('./mock-openai.mjs');
const { listModels, baseUrlCandidates, parseModelListPayload } = await import('../src/ai/provider.js');
const { saveUserApi } = await import('../src/services/settings.js');
const { run } = await import('../src/db/index.js');
const { hashPassword } = await import('../src/core/crypto.js');

const now = new Date().toISOString();
const { hash, salt } = hashPassword('Passw0rd!');
run(
  "INSERT INTO users(id,username,email,password_hash,password_salt,created_at) VALUES(?,?,?,?,?,?)",
  'u_provider', 'provider', 'provider@test.local', hash, salt, now,
);

const mock = await createMockOpenAI();

test('baseURL 候选：自动补齐 /v1', () => {
  assert.deepEqual(baseUrlCandidates('https://api.deepseek.com'), [
    'https://api.deepseek.com/v1',
    'https://api.deepseek.com',
  ]);
  assert.deepEqual(baseUrlCandidates('https://api.deepseek.com/v1'), ['https://api.deepseek.com/v1']);
});

test('parseModelListPayload 解析远程上下文', () => {
  const list = parseModelListPayload({
    data: [
      { id: 'gpt-4o', context_length: 128000 },
      { id: 'custom', context_window: 64000 },
      { id: 'deepseek-chat' },
    ],
  });
  assert.equal(list.find((m) => m.id === 'gpt-4o').contextWindowSource, 'remote');
  assert.equal(list.find((m) => m.id === 'custom').contextWindow, 64000);
  assert.equal(list.find((m) => m.id === 'deepseek-chat').contextWindowSource, 'table');
});

test('listModels：未带 /v1 的 baseURL 也能拿到远程列表', async () => {
  const baseWithoutV1 = mock.baseUrl.replace(/\/v1$/, '');
  saveUserApi('u_provider', { chat: { baseUrl: baseWithoutV1, apiKey: 'sk-mock', model: 'gpt-4o-mini' } });
  const result = await listModels('u_provider', 'chat');
  assert.equal(result.source, 'remote', JSON.stringify(result.attempts));
  const ids = result.models.map((m) => m.id);
  assert.ok(ids.includes('gpt-4o'));
  const custom = result.models.find((m) => m.id === 'custom-long');
  assert.equal(custom.contextWindow, 64000);
  assert.equal(custom.contextWindowSource, 'remote');
});

test('listModels：远端不可达时返回内置候选并给出 warning', async () => {
  saveUserApi('u_provider', { chat: { baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-bad', model: 'gpt-4o-mini' } });
  const result = await listModels('u_provider', 'chat');
  assert.equal(result.source, 'fallback');
  assert.ok(result.models.length > 0);
  assert.ok(result.warning);
  assert.ok(result.attempts.length >= 1);
});

test('版本比较', async () => {
  const { compareVersion } = await import('../src/routes/version.js');
  assert.equal(compareVersion('1.0.1', '1.0.0'), 1);
  assert.equal(compareVersion('v1.0.0', '1.0.1'), -1);
  assert.equal(compareVersion('1.0.1', '1.0.1'), 0);
});

test.after(async () => {
  await mock.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});
