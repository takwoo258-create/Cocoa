// v1.5.0 统计与管理端测试：费用估算 / 分页 / 分页模型聚合 / 会话搜索 / 服务器状态 / 邮件模板覆盖
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

const BASE_DIR = process.env.COCOA_DATA_DIR || '/tmp/cocoa-platform';
const DATA_DIR = path.join(BASE_DIR, `stats-${process.pid}`);
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

process.env.COCOA_DATA_DIR = DATA_DIR;
process.env.NODE_ENV = 'test';
process.env.COCOA_LOG_LEVEL = process.env.COCOA_LOG_LEVEL || 'error';

const usageMod = await import('../src/ai/usage.js');
const mail = await import('../src/mail/sender.js');
const cryptoMod = await import('../src/core/crypto.js');
const db = await import('../src/db/index.js');
const settings = await import('../src/services/settings.js');
const chars = await import('../src/services/characters.js');
const { createApp } = await import('../src/app.js');

const app = createApp();
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function api(pathname, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + pathname, { method, headers, body: payload });
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
  const id = `u_stats_${Math.random().toString(36).slice(2, 10)}`;
  const { hash, salt } = cryptoMod.hashPassword('Passw0rd!123');
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO users(id, username, email, password_hash, password_salt, role, code, email_verified, status, created_at, last_active_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    username,
    `${username}@test.local`,
    hash,
    salt,
    role,
    Math.floor(Math.random() * 9000) + 1000,
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
  return { id, token, role, username };
}

const admin = makeUser({ username: 'stats_admin', role: 'admin' });
const alice = makeUser({ username: 'stats_alice' });
const character = chars.createCharacter(alice.id, { name: '统计角色', personality: '安静' });

// 三笔已知模型 + 一笔未知模型（用于验证兜底费用）
usageMod.recordUsage({ userId: alice.id, characterId: character.id, model: 'gpt-4o-mini', usage: { input: 1000, cached: 200, output: 300 }, cost: 0.001 });
usageMod.recordUsage({ userId: alice.id, characterId: character.id, model: 'deepseek-chat', usage: { input: 500, cached: 0, output: 100 }, cost: 0.0005 });
usageMod.recordUsage({ userId: alice.id, characterId: character.id, model: 'qwen-plus', usage: { input: 800, cached: 0, output: 200 }, cost: 0.002 });
const unknownUsage = usageMod.recordUsage({
  userId: alice.id,
  characterId: character.id,
  model: 'some-selfhosted-llm',
  usage: { input: 1000, cached: 0, output: 1000 },
});

// ═════════════════ 1. 费用估算 ═════════════════
test('费用估算：已知模型走价格表，未知模型按 0.6 元/百万 token 兜底', () => {
  const known = usageMod.estimateCost('gpt-4o-mini', 1_000_000, 0, 0);
  assert.ok(known > 0, '已知模型应有价格');

  const unknown = usageMod.estimateCost('some-selfhosted-llm', 1_000_000, 1_000_000);
  assert.equal(Math.round(unknown * 1e6) / 1e6, 1.2, '未知模型 200 万 token → 1.2 元');

  assert.equal(usageMod.estimateCost('unknown', 0, 0), 0);
  assert.equal(unknownUsage.cost, 0.0012, 'recordUsage 应写入兜底费用而不是 0');
  const row = db.get('SELECT cost FROM usage_records WHERE model = ?', 'some-selfhosted-llm');
  assert.equal(row.cost, 0.0012);
});

// ═════════════════ 2. /stats/usage：range=today / 分页 / 模型筛选 ═════════════════
test('统计用量：range=today 按小时分桶、model 筛选、page/pageSize 分页', async () => {
  const today = await api('/api/stats/usage?range=today&bucket=hour', { token: alice.token });
  assert.equal(today.status, 200);
  assert.equal(today.json.range, 'today', '返回请求的区间别名');
  assert.equal(today.json.bucket, 'hour');
  assert.ok(today.json.series.length >= 1);
  assert.ok(today.json.series.every((point) => point.key.length === 13));
  assert.equal(today.json.totals.calls, 4);
  assert.ok(today.json.totals.cost > 0, '消费不应再恒为 0');

  const byModel = await api('/api/stats/usage?range=all&model=deepseek-chat', { token: alice.token });
  assert.equal(byModel.json.totals.calls, 1);
  assert.equal(byModel.json.models.length, 1);
  assert.equal(byModel.json.model, 'deepseek-chat');

  const page1 = await api('/api/stats/usage?range=all&page=1&pageSize=2', { token: alice.token });
  assert.equal(page1.status, 200);
  assert.equal(page1.json.page, 1);
  assert.equal(page1.json.pageSize, 2);
  assert.equal(page1.json.models.length, 2);
  assert.equal(page1.json.pagination.models.total, 4);
  assert.equal(page1.json.pagination.models.pages, 2);

  const page2 = await api('/api/stats/usage?range=all&page=2&pageSize=2', { token: alice.token });
  assert.equal(page2.json.models.length, 2);
  assert.notDeepEqual(
    page1.json.models.map((m) => m.model),
    page2.json.models.map((m) => m.model),
  );

  const weekly = await api('/api/stats/usage?range=7d&bucket=day', { token: alice.token });
  assert.equal(weekly.json.range, '7d');
  assert.ok(weekly.json.series.every((point) => point.key.length === 10));
});

// ═════════════════ 3. /stats/models 与 overview 分组 ═════════════════
test('按模型聚合与概览分组：consumption / companion 两组数据', async () => {
  const models = await api('/api/stats/models?range=all&pageSize=10', { token: alice.token });
  assert.equal(models.status, 200);
  assert.equal(models.json.total, 4);
  const mini = models.json.items.find((item) => item.model === 'gpt-4o-mini');
  assert.equal(mini.input, 1000);
  assert.equal(mini.inputHit, 200);
  assert.equal(mini.inputMiss, 800);
  assert.equal(mini.total, 1300);
  assert.ok(mini.cost > 0);
  assert.ok(models.json.items[0].cost >= models.json.items[1].cost, '按消费倒序');

  const overview = await api(`/api/stats/overview?characterId=${character.id}`, { token: alice.token });
  assert.equal(overview.status, 200);
  assert.equal(overview.json.consumption.calls, 4);
  assert.ok(overview.json.consumption.total > 0);
  assert.ok(overview.json.consumption.cost > 0);
  assert.ok(Array.isArray(overview.json.consumption.byModel));
  assert.equal(overview.json.companion.days, overview.json.companionDays);
  assert.ok(overview.json.companion.days >= 1);
  // 兼容旧字段
  assert.ok(overview.json.companionDays >= 1);
  assert.ok(Array.isArray(overview.json.callsByModel));
});

// ═════════════════ 4. 管理端：用量/会话搜索不再报「用户不存在」 ═════════════════
test('管理端用量与会话：未知用户返回空结果，按代号/昵称可搜索', async () => {
  const missingUsage = await api('/api/admin/usage?userId=not-exists', { token: admin.token });
  assert.equal(missingUsage.status, 200, '未知用户不应 404');
  assert.equal(missingUsage.json.user, null);
  assert.equal(missingUsage.json.totals.calls, 0);

  const knownUsage = await api(`/api/admin/usage?userId=${alice.id}`, { token: admin.token });
  assert.equal(knownUsage.json.totals.calls, 4);
  assert.equal(knownUsage.json.user.username, 'stats_alice');

  const now = new Date().toISOString();
  db.run(
    'INSERT INTO conversations(id, character_id, user_id, kind, title, created_at, updated_at, token_used, context_limit, active) VALUES(?,?,?,?,?,?,?,?,?,?)',
    'cv_stats_1',
    character.id,
    alice.id,
    'main',
    null,
    now,
    now,
    120,
    128000,
    1,
  );

  const byCode = await api(`/api/admin/conversations?q=${db.get('SELECT code FROM users WHERE id = ?', alice.id).code}`, {
    token: admin.token,
  });
  assert.equal(byCode.status, 200);
  assert.equal(byCode.json.total, 1);
  assert.equal(byCode.json.items[0].userId, alice.id);
  assert.ok(byCode.json.items[0].userCode != null);
  assert.equal(byCode.json.items[0].nickname, 'stats_alice');

  const byNickname = await api('/api/admin/conversations?q=stats_alice', { token: admin.token });
  assert.equal(byNickname.json.total, 1);

  const noUser = await api('/api/admin/conversations?userId=ghost-user', { token: admin.token });
  assert.equal(noUser.status, 200);
  assert.deepEqual(noUser.json.items, [], '找不到用户时返回空数组');
  assert.equal(noUser.json.total, 0);

  const noMatch = await api('/api/admin/conversations?q=不存在的昵称xyz', { token: admin.token });
  assert.equal(noMatch.status, 200);
  assert.deepEqual(noMatch.json.items, []);
});

// ═════════════════ 5. 管理端服务器状态 ═════════════════
test('服务器状态补齐版本 / 连接数 / 数据库大小', async () => {
  const res = await api('/api/admin/server-status', { token: admin.token });
  assert.equal(res.status, 200);
  assert.match(res.json.version, /^\d+\.\d+\.\d+/);
  assert.equal(typeof res.json.onlineConnections, 'number');
  assert.ok(res.json.database.total > 0);
  assert.equal(res.json.database.path, process.env.COCOA_DB_PATH || res.json.database.path);
  assert.ok(res.json.disk.total > 0);
  assert.ok(res.json.memory.total > 0);
  assert.ok(res.json.cpu.cores >= 1);
  assert.ok(res.json.uptime > 0);
});

// ═════════════════ 6. 开关立即生效 + 邮件模板覆盖 ═════════════════
test('管理端开关立即生效（无需二次确认）且返回合并配置', async () => {
  const saved = await api('/api/admin/settings', {
    method: 'PUT',
    token: admin.token,
    body: { update: { force: true, autoUpgrade: false, minVersion: '1.5.0' } },
  });
  assert.equal(saved.status, 200);
  assert.ok(saved.json.changed.includes('update'));
  assert.equal(saved.json.update.force, true);
  assert.equal(saved.json.update.autoUpgrade, false);
  assert.equal(saved.json.merged.update.force, true, '应返回合并后的完整配置');
  assert.equal(saved.json.switches.updateForce, true);

  const read = await api('/api/admin/settings', { token: admin.token });
  assert.equal(read.json.update.force, true);
  assert.equal(read.json.switches.autoUpgrade, false);
});

test('邮件模板覆盖：subject/body 支持 {{name}} {{shareId}} {{expiresAt}} {{time}} {{reason}}', async () => {
  const saved = await api('/api/admin/settings', {
    method: 'PUT',
    token: admin.token,
    body: {
      mailTemplates: {
        quota: {
          subject: '额度提醒：{{name}}（{{shareId}}）',
          body: '你在 {{time}} 触发了 {{reason}}，授权到期：{{expiresAt}}',
        },
        ban: { subject: '禁用通知 {{shareId}}', body: '原因：{{reason}}，解除：{{expiresAt}}' },
      },
    },
  });
  assert.equal(saved.status, 200, saved.text);
  assert.ok(saved.json.changed.includes('mailTemplates'));
  assert.equal(saved.json.mailTemplates.quota.subject, '额度提醒：{{name}}（{{shareId}}）');

  const tpl = mail.quotaNoticeTemplate({
    name: '小砂',
    shareId: 'AbCd1234',
    level: 'hard',
    usedTokens: 100,
    tokenHard: 100,
    expiresAt: '2026-12-01 20:00:00',
  });
  assert.equal(tpl.subject, '额度提醒：小砂（AbCd1234）');
  assert.match(tpl.text, /已达硬限额/);
  assert.match(tpl.text, /2026-12-01 20:00/);
  assert.match(tpl.html, /#6b4a35/, '仍然使用品牌模板');

  const ban = mail.banNoticeTemplate({ name: '小砂', shareId: 'AbCd1234', reason: '滥用', until: '永久' });
  assert.equal(ban.subject, '禁用通知 AbCd1234');
  assert.match(ban.text, /原因：滥用/);

  const bad = await api('/api/admin/settings', {
    method: 'PUT',
    token: admin.token,
    body: { mailTemplates: { unknownKind: { subject: 'x' } } },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'mail_template_kind_invalid');

  // 清理覆盖，避免影响其他用例
  await api('/api/admin/settings', {
    method: 'PUT',
    token: admin.token,
    body: { mailTemplates: { quota: null, ban: null } },
  });
  const after = await api('/api/admin/settings', { token: admin.token });
  assert.equal(after.json.mailTemplates.quota, undefined);
});
