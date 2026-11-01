// platform 集成测试：服务器状态 / 后端升级 / 集成 API（天气·热榜）/ 邮件模板 / TTS·STT
// 约束：不联网。UAPI 用本地 http server 模拟（COCOA_UAPI_BASE），GitHub 用注入 fetch，
//       升级用 COCOA_UPGRADE_SCRIPT 指向临时假脚本（写 status/running → 1.2s → success）。
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

// 独立数据目录：避免与其他开发线并发测试互相删库/删媒体文件。
// 升级测试需要可执行脚本（部分容器 /tmp 挂载 noexec），因此优先选可执行目录。
function execCapable(dir) {
  try {
    const probe = path.join(dir, `.exec-probe-${process.pid}.sh`);
    fs.writeFileSync(probe, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    execFileSync(probe, { stdio: 'ignore', timeout: 5_000 });
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

function pickBase() {
  // 注意：express 的 res.sendFile 默认拒绝含点号目录（dotfile）的路径，
  // 因此数据目录（media 落盘处）必须避开 .tmp 这类目录；升级脚本则要求可执行文件系统。
  const hasDotSegment = (p) => path.resolve(p).split(path.sep).some((seg) => seg.startsWith('.'));
  const candidates = [
    process.env.COCOA_PLATFORM_TEST_DIR,
    '/data/dsh/home/cocoa-platform',
    os.homedir(),
    os.tmpdir(),
  ].filter((dir) => dir && !hasDotSegment(dir));
  let writable = null;
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
    } catch {
      continue;
    }
    if (!writable) writable = dir;
    if (execCapable(dir)) return { base: dir, exec: true };
  }
  return { base: writable || os.tmpdir(), exec: false };
}

const PICKED = pickBase();
const DATA_DIR = path.join(PICKED.base, `cocoa-platform-${process.pid}`);
const EXEC_OK = PICKED.exec;
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
console.log(`[platform-test] COCOA_DATA_DIR=${DATA_DIR} exec=${EXEC_OK}`);

const skipSpawn = EXEC_OK ? false : '当前文件系统不支持执行脚本（noexec），跳过真实 spawn 用例';

process.env.COCOA_DATA_DIR = DATA_DIR;
process.env.NODE_ENV = 'test';
process.env.COCOA_LOG_LEVEL = process.env.COCOA_LOG_LEVEL || 'error';
process.env.COCOA_UPGRADE_SCRIPT = path.join(DATA_DIR, 'fake-upgrade.sh');
process.env.COCOA_UPGRADE_STATUS = path.join(DATA_DIR, 'upgrade-status.json');
delete process.env.UAPI_KEY; // 测试不读真实 key
delete process.env.SMTP_HOST;
delete process.env.SMTP_USER;

// ---------- 假升级脚本（模拟 ops 的 /opt/cocoa/deploy/upgrade.sh） ----------
const FAKE_SCRIPT = `#!/bin/sh
set -u
TAG="$1"
LOG="\${COCOA_UPGRADE_LOG:-/dev/null}"
STATUS="\${COCOA_UPGRADE_STATUS:?missing status path}"
mkdir -p "$(dirname "$STATUS")"
printf 'starting upgrade to %s\\n' "$TAG" >> "$LOG"
cat > "$STATUS" <<EOF
{"running":true,"status":"running","tag":"$TAG","fromVersion":"\${COCOA_UPGRADE_FROM:-}","toVersion":"$TAG","message":"installing","progress":10,"log":"$LOG","startedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF
sleep 1.2
printf 'copying files\\n' >> "$LOG"
cat > "$STATUS" <<EOF
{"running":false,"status":"success","tag":"$TAG","fromVersion":"\${COCOA_UPGRADE_FROM:-}","toVersion":"$TAG","message":"fake upgrade done","progress":100,"log":"$LOG","startedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","finishedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF
printf 'done\\n' >> "$LOG"
`;
fs.writeFileSync(process.env.COCOA_UPGRADE_SCRIPT, FAKE_SCRIPT, { mode: 0o755 });

// ---------- 本地模拟 UAPI（天气 / 热榜 / STT / TTS） ----------
let uapiHits = 0;
const AUDIO_BYTES = Buffer.from('ID3fake-mp3-bytes-for-cocoa-tts-test');

const mock = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (status, body, type = 'application/json') => {
    const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
  };
  req.resume(); // 丢弃请求体，避免 socket 阻塞

  if (url.pathname === '/api/v1/misc/weather') {
    uapiHits += 1;
    const city = url.searchParams.get('city') || '宣城';
    return send(200, {
      province: '安徽省',
      city: `${city}市`,
      adcode: '341800',
      weather: '阴',
      weather_icon: '104',
      temperature: 21,
      wind_direction: '西风',
      wind_power: '3级',
      humidity: 87,
      report_time: '5 分钟前发布',
      alerts: [{ title: '大雾黄色预警', type: '大雾', level: '黄色', text: '能见度小于 500 米', publish_time: '2026-11-01 08:00:00', publisher: '宣城市气象台' }],
    });
  }
  if (url.pathname === '/api/v1/misc/hotboard') {
    uapiHits += 1;
    const type = url.searchParams.get('type') || 'weibo';
    if (!['weibo', 'zhihu', 'douyin', 'bilibili', 'toutiao', 'baidu'].includes(type)) {
      return send(400, { code: 'INVALID_PARAMETER', message: 'invalid hotboard type' });
    }
    return send(200, {
      type,
      update_time: '2026-11-01T15:20:20.351Z',
      list: [
        { index: 1, title: '榜首新闻标题', url: 'https://s.weibo.com/weibo?q=1', hot_value: '1188070', extra: { desc: '热榜第一条' } },
        { index: 2, title: '第二条新闻', url: 'https://s.weibo.com/weibo?q=2', hot_value: '900000', extra: {} },
      ],
    });
  }
  if (url.pathname === '/v1/audio/transcriptions') {
    return send(200, { text: '你好呀，这是语音转写结果' });
  }
  if (url.pathname === '/v1/audio/speech') {
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': AUDIO_BYTES.length });
    return res.end(AUDIO_BYTES);
  }
  return send(404, { error: 'not_found', path: url.pathname });
});

await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
const MOCK_BASE = `http://127.0.0.1:${mock.address().port}`;
process.env.COCOA_UAPI_BASE = MOCK_BASE;

// ---------- 加载被测模块（env 必须已设置） ----------
const statusSvc = await import('../src/services/server-status.js');
const upgradeSvc = await import('../src/services/upgrade.js');
const integrationsSvc = await import('../src/services/integrations.js');
const mail = await import('../src/mail/sender.js');
const cryptoMod = await import('../src/core/crypto.js');
const db = await import('../src/db/index.js');
const { saveUserApi } = await import('../src/services/settings.js');
const { persistTtsAudio } = await import('../src/routes/config-test.js');
const env = (await import('../src/env.js')).default;

/** app.js 若被其他开发线临时改坏，退化为最小挂载（保证本线测试可独立运行） */
let appSource = '';
try {
  appSource = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
} catch {
  appSource = '';
}

async function buildApp() {
  try {
    const { createApp } = await import('../src/app.js');
    const app = createApp();
    app.__realApp = true;
    return app;
  } catch (err) {
    console.warn('[platform-test] app.js 不可用，改用最小挂载：', err.message);
    const express = (await import('express')).default;
    const { AppError } = await import('../src/core/errors.js');
    const app = express();
    app.use(express.json({ limit: '4mb' }));
    app.use('/api/config', (await import('../src/routes/config-test.js')).default());
    app.use('/api/config', (await import('../src/routes/config.js')).default());
    app.use('/api/admin', (await import('../src/routes/admin.js')).default());
    app.use('/api/media', (await import('../src/routes/media.js')).default());
    app.use('/api/integrations', (await import('../src/routes/integrations.js')).default());
    app.use((req, _res, next) => next(new AppError(404, 'not_found', `接口不存在：${req.method} ${req.path}`)));
    app.use((err, _req, res, _next) => {
      const status = err.status || 500;
      res.status(status).json({ error: { code: err.code || 'internal_error', message: err.message } });
    });
    return app;
  }
}

const app = await buildApp();
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => mock.close(resolve));
  if (!process.env.COCOA_PLATFORM_KEEP) {
    try {
      fs.rmSync(DATA_DIR, { recursive: true, force: true });
      fs.rmdirSync(PICKED.base); // 仅在空目录时成功，不影响其他并发运行
    } catch {
      /* 清理失败不影响结论 */
    }
  }
});

// ---------- 工具 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, { method = 'GET', token, body, form, raw = false } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + pathname, { method, headers, body: payload });
  if (raw) return res;
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text, headers: res.headers };
}

async function waitFor(fn, { timeout = 8_000, interval = 100 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeout) return null;
    await sleep(interval);
  }
}

function makeUser({ username, role = 'user', qq = null }) {
  const id = `u_plat_${Math.random().toString(36).slice(2, 10)}`;
  const { hash, salt } = cryptoMod.hashPassword('Passw0rd!123');
  const now = new Date().toISOString();
  db.run(
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
    'active',
    now,
    now,
  );
  const token = cryptoMod.signToken({ uid: id, role });
  db.run(
    'INSERT INTO auth_tokens(token_hash, user_id, created_at, expires_at, user_agent) VALUES(?,?,?,?,?)',
    cryptoMod.sha256(token),
    id,
    now,
    new Date(Date.now() + 86400_000).toISOString(),
    'platform-test',
  );
  return { id, token, role, username };
}

const admin = makeUser({ username: 'plat_admin', role: 'admin' });
const normal = makeUser({ username: 'plat_user', role: 'user' });

// ══════════════════════ 1. 服务器状态 ══════════════════════
test('server-status：管理员拿到 CPU/内存/磁盘/网络，普通用户 403', async () => {
  const unauth = await api('/api/admin/server-status');
  assert.equal(unauth.status, 401);

  const forbidden = await api('/api/admin/server-status', { token: normal.token });
  assert.equal(forbidden.status, 403);

  const { status, json: s } = await api('/api/admin/server-status', { token: admin.token });
  assert.equal(status, 200);
  assert.equal(typeof s.cpu.percent, 'number');
  assert.ok(s.cpu.percent >= 0 && s.cpu.percent <= 100, `cpu.percent=${s.cpu.percent}`);
  assert.ok(s.cpu.cores >= 1);
  assert.ok(Array.isArray(s.cpu.load) && s.cpu.load.length === 3);
  assert.equal(typeof s.cpu.estimated, 'boolean');

  assert.ok(s.memory.total > 0);
  assert.ok(s.memory.used >= 0);
  assert.ok(s.memory.percent >= 0 && s.memory.percent <= 100);

  assert.ok(s.disk.total > 0);
  assert.ok(s.disk.free >= 0);
  assert.ok(s.disk.percent >= 0 && s.disk.percent <= 100);

  assert.ok(s.network.rxBytes >= 0);
  assert.ok(s.network.txBytes >= 0);
  assert.equal(typeof s.network.rxRate, 'number');
  assert.equal(typeof s.network.txRate, 'number');

  assert.ok(s.uptime > 0);
  assert.match(s.node, /^v\d+\./);
  assert.ok(!Number.isNaN(Date.parse(s.time)));

  // 单元层：两次采样都返回合法百分比
  const first = await statusSvc.collectServerStatus({ force: true });
  await sleep(1100);
  const second = await statusSvc.collectServerStatus({ force: true });
  for (const sample of [first, second]) {
    assert.equal(typeof sample.cpu.percent, 'number');
    assert.ok(sample.cpu.percent >= 0 && sample.cpu.percent <= 100);
  }
});

// ══════════════════════ 2. 版本列表（注入 fetch） ══════════════════════
let ghCalls = 0;
const ghReleases = [
  {
    tag_name: 'v1.3.0',
    name: 'Cocoa 1.3.0',
    body: '+ 新功能\n[force]',
    published_at: '2026-11-01T00:00:00Z',
    prerelease: false,
    draft: false,
    html_url: 'https://github.com/takwoo258-create/Cocoa/releases/tag/v1.3.0',
    assets: [
      { name: 'cocoa-backend-v1.3.0.zip', size: 2048, browser_download_url: 'https://example.com/cocoa-backend-v1.3.0.zip' },
      { name: 'cocoa-1.3.0.apk', size: 1024, browser_download_url: 'https://example.com/cocoa.apk' },
    ],
  },
  {
    tag_name: 'v1.2.3',
    name: 'Cocoa 1.2.3',
    body: '修复若干问题',
    published_at: '2026-10-20T00:00:00Z',
    prerelease: false,
    draft: false,
    html_url: 'https://github.com/takwoo258-create/Cocoa/releases/tag/v1.2.3',
    assets: [{ name: 'cocoa-1.2.3.apk', size: 1024, browser_download_url: 'https://example.com/cocoa-1.2.3.apk' }],
  },
];

function githubResponse(list) {
  return new Response(JSON.stringify(list), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('upgrade/versions：GitHub Releases 解析 + 10 分钟缓存', async () => {
  ghCalls = 0;
  upgradeSvc.setFetcher(async () => {
    ghCalls += 1;
    return githubResponse(ghReleases);
  });

  const first = await api('/api/admin/upgrade/versions', { token: admin.token });
  assert.equal(first.status, 200);
  assert.ok(Array.isArray(first.json), '文档约定返回数组');
  assert.equal(first.json.length, 2);
  const latest = first.json[0];
  assert.equal(latest.tag, 'v1.3.0');
  assert.equal(latest.version, '1.3.0');
  assert.equal(latest.name, 'Cocoa 1.3.0');
  assert.match(latest.notes, /\[force\]/);
  assert.equal(latest.publishedAt, '2026-11-01T00:00:00Z');
  assert.equal(latest.hasBackend, true);
  assert.equal(latest.asset.name, 'cocoa-backend-v1.3.0.zip');
  assert.equal(latest.asset.size, 2048);
  assert.equal(first.json[1].hasBackend, false);
  assert.equal(first.json[1].asset, null);

  const second = await api('/api/admin/upgrade/versions', { token: admin.token });
  assert.equal(second.status, 200);
  assert.equal(ghCalls, 1, '10 分钟缓存内不应重复请求 GitHub');
});

test('upgrade/versions：GitHub 失败时回退缓存；无缓存则 502', async () => {
  // 内存缓存被 setFetcher 清空，但 meta 持久化缓存仍在 → 回退成功
  upgradeSvc.setFetcher(async () => {
    throw new Error('network down');
  });
  const fallback = await api('/api/admin/upgrade/versions', { token: admin.token });
  assert.equal(fallback.status, 200);
  assert.ok(Array.isArray(fallback.json));
  assert.ok(fallback.json.length >= 2, '应回退到持久化缓存');

  // 删除持久化缓存后，无任何缓存 → 502
  db.run("DELETE FROM meta WHERE key = 'upgrade_versions_cache'");
  upgradeSvc.resetUpgradeCache();
  const failed = await api('/api/admin/upgrade/versions', { token: admin.token });
  assert.equal(failed.status, 502);
  assert.equal(failed.json.error.code, 'github_unavailable');

  // 恢复可用 fetcher，供后续用例使用
  upgradeSvc.setFetcher(async () => githubResponse(ghReleases));
});

test('upgrade：tag 校验（拒绝非 semver / 注入形态）', async () => {
  for (const tag of ['v1.2.3', 'v1.2.3-rc.1', 'v10.0.0']) {
    assert.equal(upgradeSvc.isValidTag(tag), true, `${tag} 应合法`);
  }
  for (const tag of ['1.2.3', 'v1.2', 'v1.2.3.4', 'v1.2.3; rm -rf /', '../v1.2.3', 'v1.2.3$(id)', '']) {
    assert.equal(upgradeSvc.isValidTag(tag), false, `${tag} 应被拒绝`);
  }

  const bad = await api('/api/admin/upgrade', { method: 'POST', token: admin.token, body: { tag: '1.2.3' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'upgrade_tag_invalid');

  const inject = await api('/api/admin/upgrade', { method: 'POST', token: admin.token, body: { tag: 'v1.2.3; rm -rf /' } });
  assert.equal(inject.status, 400);
  assert.equal(inject.json.error.code, 'upgrade_tag_invalid');

  const missing = await api('/api/admin/upgrade', { method: 'POST', token: admin.token, body: { tag: 'v9.9.9' } });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error.code, 'upgrade_tag_not_found');
});

test('upgrade：触发假脚本 → running → success，重复触发返回 409', { skip: skipSpawn }, async () => {
  const started = await api('/api/admin/upgrade', { method: 'POST', token: admin.token, body: { tag: 'v1.3.0' } });
  assert.equal(started.status, 202);
  assert.equal(started.json.accepted, true);
  assert.match(started.json.logId, /^up_/);
  assert.equal(started.json.tag, 'v1.3.0');
  assert.equal(started.json.fromVersion, upgradeSvc.currentVersion());

  // 脚本先写 running → 期间再次触发应 409
  const running = await waitFor(async () => {
    const r = await api('/api/admin/upgrade/status', { token: admin.token });
    return r.json?.running ? r.json : null;
  }, { timeout: 3_000 });
  assert.ok(running, '假脚本应写入 running 状态');
  assert.equal(running.currentVersion, upgradeSvc.currentVersion());

  const conflict = await api('/api/admin/upgrade', { method: 'POST', token: admin.token, body: { tag: 'v1.3.0' } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error.code, 'upgrade_running');

  const done = await waitFor(async () => {
    const r = await api('/api/admin/upgrade/status', { token: admin.token });
    return r.json?.status === 'success' && r.json?.running === false ? r.json : null;
  });
  assert.ok(done, '升级状态应变为 success');
  assert.equal(done.toVersion, 'v1.3.0');
  assert.match(done.log, /starting upgrade to v1\.3\.0/);
  assert.ok(done.history.length >= 1);
  assert.ok(done.logPath.endsWith('.log'));

  const row = db.get('SELECT * FROM upgrade_logs WHERE id = ?', started.json.logId);
  assert.ok(row, 'upgrade_logs 应写入记录');
  assert.equal(row.to_version, 'v1.3.0');
  assert.equal(row.actor_id, admin.id);

  const audited = db.get("SELECT * FROM audit_logs WHERE action = 'admin.upgrade.start' AND target = ?", started.json.logId);
  assert.ok(audited, '触发升级应写审计日志');
});

test('upgrade：update.autoUpgrade 持久化 + maybeAutoUpgrade 只触发一次', { skip: skipSpawn }, async () => {
  const saved = await api('/api/admin/settings', {
    method: 'PUT',
    token: admin.token,
    body: { update: { autoUpgrade: true, force: false, minVersion: '1.2.0' } },
  });
  assert.equal(saved.status, 200);
  assert.ok(saved.json.changed.includes('update'));
  assert.equal(saved.json.update.autoUpgrade, true);

  const read = await api('/api/admin/settings', { token: admin.token });
  assert.equal(read.json.update.autoUpgrade, true);
  assert.equal(read.json.update.minVersion, '1.2.0');
  assert.equal(read.json.integrations.uapiKeySet, false);

  // 让自动升级看到 v9.9.9
  upgradeSvc.setFetcher(async () =>
    githubResponse([
      {
        tag_name: 'v9.9.9',
        name: 'Cocoa 9.9.9',
        body: 'auto',
        published_at: '2026-11-02T00:00:00Z',
        prerelease: false,
        draft: false,
        assets: [{ name: 'cocoa-backend-v9.9.9.zip', size: 10, browser_download_url: 'https://example.com/b.zip' }],
      },
    ]),
  );

  const first = await upgradeSvc.maybeAutoUpgrade();
  assert.equal(first.triggered, true, JSON.stringify(first));
  assert.equal(first.tag, 'v9.9.9');

  const second = await upgradeSvc.maybeAutoUpgrade();
  assert.equal(second.triggered, false);
  assert.ok(['running', 'cooldown'].includes(second.reason), `reason=${second.reason}`);

  const finished = await waitFor(async () => {
    const r = await api('/api/admin/upgrade/status', { token: admin.token });
    return r.json?.status === 'success' && r.json?.tag === 'v9.9.9' ? r.json : null;
  });
  assert.ok(finished, '自动升级应完成');

  // 关闭自动升级，避免影响后续用例
  await api('/api/admin/settings', { method: 'PUT', token: admin.token, body: { update: { autoUpgrade: false } } });
  upgradeSvc.setFetcher(async () => githubResponse(ghReleases));
});

// ══════════════════════ 3. 集成 API（天气 / 热榜） ══════════════════════
test('integrations：天气默认宣城 + 缓存 + 鉴权', async () => {
  const unauth = await api('/api/integrations/weather');
  assert.equal(unauth.status, 401);

  integrationsSvc.clearCache();
  const hitsBefore = uapiHits;
  const first = await api('/api/integrations/weather', { token: normal.token });
  assert.equal(first.status, 200);
  assert.equal(first.json.ok, true);
  assert.equal(first.json.city, '宣城市');
  assert.equal(first.json.province, '安徽省');
  assert.equal(first.json.temperature, 21);
  assert.equal(first.json.weather, '阴');
  assert.equal(first.json.humidity, 87);
  assert.equal(first.json.windDirection, '西风');
  assert.equal(first.json.alerts.length, 1);
  assert.equal(first.json.alerts[0].title, '大雾黄色预警');
  assert.ok(!Number.isNaN(Date.parse(first.json.fetchedAt)));
  assert.equal(uapiHits, hitsBefore + 1);

  const cached = await api('/api/integrations/weather', { token: normal.token });
  assert.equal(cached.status, 200);
  assert.equal(uapiHits, hitsBefore + 1, '10 分钟缓存内不应重复请求 UAPI');

  const other = await api('/api/integrations/weather?city=合肥', { token: normal.token });
  assert.equal(other.status, 200);
  assert.equal(other.json.city, '合肥市');
  assert.equal(uapiHits, hitsBefore + 2);
});

test('integrations：热榜解析 + 类型白名单 + 缓存', async () => {
  integrationsSvc.clearCache();
  const before = uapiHits;
  const r = await api('/api/integrations/hotboard?type=weibo', { token: normal.token });
  assert.equal(r.status, 200);
  assert.equal(r.json.type, 'weibo');
  assert.equal(r.json.items.length, 2);
  assert.equal(r.json.items[0].rank, 1);
  assert.equal(r.json.items[0].title, '榜首新闻标题');
  assert.equal(r.json.items[0].hot, 1188070);
  assert.equal(r.json.items[0].desc, '热榜第一条');
  assert.ok(r.json.items[0].url.startsWith('https://'));
  assert.equal(uapiHits, before + 1);

  await api('/api/integrations/hotboard?type=weibo', { token: normal.token });
  assert.equal(uapiHits, before + 1, '5 分钟缓存内不应重复请求');

  const invalid = await api('/api/integrations/hotboard?type=wechat', { token: normal.token });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error.code, 'hotboard_type_invalid');

  const status = await api('/api/integrations/status', { token: normal.token });
  assert.equal(status.json.ok, true);
  assert.deepEqual(status.json.hotboardTypes, ['weibo', 'zhihu', 'douyin', 'bilibili', 'toutiao', 'baidu']);
});

test('integrations：上游失败返回 502 且不清空缓存', async () => {
  integrationsSvc.clearCache();
  await api('/api/integrations/weather', { token: normal.token }); // 先填充缓存

  integrationsSvc.setFetcher(async () => {
    throw new Error('uapi boom');
  });
  const failed = await api('/api/integrations/weather?refresh=1', { token: normal.token });
  assert.equal(failed.status, 502);
  assert.equal(failed.json.error.code, 'uapi_unavailable');

  integrationsSvc.setFetcher(null); // 恢复真实 fetch（指向本地 mock）
  const afterFail = await api('/api/integrations/weather', { token: normal.token });
  assert.equal(afterFail.status, 200);
  assert.equal(afterFail.json.city, '宣城市', '失败不应清除旧缓存');

  // 上游 4xx/5xx 也映射为 502
  integrationsSvc.setFetcher(async () => new Response(JSON.stringify({ code: 'INVALID_PARAMETER', message: 'bad city' }), {
    status: 500,
    headers: { 'content-type': 'application/json' },
  }));
  const upstreamErr = await api('/api/integrations/weather?refresh=1', { token: normal.token });
  assert.equal(upstreamErr.status, 502);
  assert.equal(upstreamErr.json.error.code, 'uapi_error');
  integrationsSvc.setFetcher(null);
});

// ══════════════════════ 4. 邮件模板 ══════════════════════
test('邮件模板：品牌化 HTML + 纯文本 fallback + 转义', () => {
  const rendered = mail.renderEmail({
    title: '测试标题',
    preheader: '预览摘要',
    paragraphs: ['第一段正文', '<script>alert(1)</script>'],
    code: '246810',
    meta: [['用途', '注册']],
    action: { label: '打开 Cocoa', url: 'https://cocoa.example.com' },
    notice: '若非本人操作请忽略',
    footerNote: '页脚备注',
  });
  assert.match(rendered.html, /#6b4a35/, '应含可可色');
  assert.match(rendered.html, /#fbf3ea/, '应含米色');
  assert.match(rendered.html, /测试标题/);
  assert.match(rendered.html, /Cocoa · Sand Salt/, '页脚品牌');
  assert.match(rendered.html, /246810/);
  assert.match(rendered.html, /打开 Cocoa/);
  assert.match(rendered.html, /https:\/\/cocoa\.example\.com/);
  assert.ok(!rendered.html.includes('<script>alert(1)</script>'), '正文需转义');
  assert.match(rendered.html, /&lt;script&gt;/);
  assert.match(rendered.text, /246810/);
  assert.match(rendered.text, /Cocoa · Sand Salt/);
  assert.ok(!rendered.text.includes('<html'));

  const codeTpl = mail.codeEmailTemplate({ code: '135790', purpose: 'login', email: 'a@b.com' });
  assert.match(codeTpl.subject, /验证码/);
  assert.match(codeTpl.html, /135790/);
  assert.match(codeTpl.text, /135790/);

  const shareTpl = mail.shareNoticeTemplate({
    direction: 'request',
    ownerName: '小砂',
    targetName: '2',
    services: ['chat', 'tts'],
    expiresAt: '2026-12-01 20:00:00',
    note: '随便用',
  });
  assert.match(shareTpl.subject, /模型分享请求/);
  assert.match(shareTpl.html, /小砂/);
  assert.match(shareTpl.html, /2026-12-01 20:00（UTC\+8）/);
  assert.match(shareTpl.text, /对话、语音合成/);

  const incomingTpl = mail.shareNoticeTemplate({ direction: 'share', ownerName: '小砂', services: ['chat'] });
  assert.match(incomingTpl.subject, /收到模型分享/);
  assert.notEqual(incomingTpl.subject, shareTpl.subject);

  const expiryTpl = mail.expiryNoticeTemplate({
    ownerName: '小砂',
    targetName: '2',
    services: ['chat', 'embedding'],
    expiresAt: '2026-12-01 20:00:00',
  });
  assert.match(expiryTpl.subject, /已到期/);
  assert.match(expiryTpl.html, /2026-12-01 20:00/);
});

test('邮件发送：SMTP 未配置时返回 ok:false 而不是抛错（含管理端测试邮件接口）', async () => {
  const code = await mail.sendCodeEmail('someone@test.local', '111222', 'register');
  assert.equal(code.ok, false);
  assert.equal(code.reason, 'smtp_not_configured');

  const share = await mail.sendShareNotice('someone@test.local', { direction: 'share', ownerName: 'a', services: ['chat'] });
  assert.equal(share.ok, false);
  assert.equal(share.reason, 'smtp_not_configured');

  const expiry = await mail.sendExpiryNotice('someone@test.local', { ownerName: 'a', services: ['chat'], expiresAt: '2026-12-01 20:00:00' });
  assert.equal(expiry.ok, false);
  assert.equal(expiry.reason, 'smtp_not_configured');

  const viaAdmin = await api('/api/admin/settings/test-mail', {
    method: 'POST',
    token: admin.token,
    body: { to: 'someone@test.local' },
  });
  assert.equal(viaAdmin.status, 400);
  assert.equal(viaAdmin.json.error.code, 'smtp_not_configured');
});

// ══════════════════════ 5. TTS / STT ══════════════════════
test('TTS：未配置返回 400 api_not_configured（不是 500）', async () => {
  const unauth = await api('/api/config/test-tts', { method: 'POST', body: { text: '你好' } });
  assert.equal(unauth.status, 401);

  const r = await api('/api/config/test-tts', { method: 'POST', token: normal.token, body: { text: '你好' } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'api_not_configured');

  const tooLong = await api('/api/config/test-tts', {
    method: 'POST',
    token: normal.token,
    body: { text: '喵'.repeat(501) },
  });
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.json.error.code, 'tts_text_too_long');
});

test('TTS：配置后合成音频 → 落盘 + media 登记 + 可下载', async () => {
  saveUserApi(normal.id, {
    tts: { apiKey: 'test-tts-key', baseUrl: `${MOCK_BASE}/v1`, model: 'tts-1', voice: 'default', extra: { mode: 'openai' } },
  });

  const r = await api('/api/config/test-tts', { method: 'POST', token: normal.token, body: { text: '语音测试' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true);
  assert.match(r.json.url, /^\/api\/media\/md_/);
  assert.equal(r.json.mime, 'audio/mpeg');
  assert.equal(r.json.bytes, AUDIO_BYTES.length);
  assert.equal(r.json.text, '语音测试');

  const row = db.get('SELECT * FROM media WHERE id = ?', r.json.id);
  assert.ok(row, 'TTS 音频应登记 media');
  assert.equal(row.kind, 'voice');
  assert.equal(row.user_id, normal.id);
  assert.ok(fs.existsSync(path.join(env.mediaDir, row.path)), '音频文件应落盘');

  const download = await api(r.json.url, { token: normal.token, raw: true });
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-type') || '', /audio\/mpeg/);
  const buf = Buffer.from(await download.arrayBuffer());
  assert.equal(buf.length, AUDIO_BYTES.length);

  // 恢复未配置状态，验证回退
  saveUserApi(normal.id, { tts: { apiKey: '', baseUrl: '' } });
});

test('TTS：persistTtsAudio 直接落库（无 provider 时也能验证存储链路）', () => {
  const saved = persistTtsAudio(normal.id, Buffer.from('fake-audio'), 'audio/wav', { voice: 'v1', model: 'm1' });
  assert.match(saved.url, /^\/api\/media\/md_/);
  assert.equal(saved.mime, 'audio/wav');
  assert.equal(saved.bytes, 10);
  const row = db.get('SELECT * FROM media WHERE id = ?', saved.id);
  assert.equal(row.mime, 'audio/wav');
  assert.ok(fs.existsSync(path.join(env.mediaDir, row.path)));
});

test('STT：未配置 400；缺文件/格式错误 400；配置后返回转写文本', async () => {
  // 未配置 → 400
  const form1 = new FormData();
  form1.append('file', new Blob([Buffer.from('RIFF0000')], { type: 'audio/wav' }), 'a.wav');
  const notConfigured = await api('/api/config/test-stt', { method: 'POST', token: normal.token, form: form1 });
  assert.equal(notConfigured.status, 400);
  assert.equal(notConfigured.json.error.code, 'api_not_configured');

  // 缺文件 → 400 audio_required
  const empty = new FormData();
  const missing = await api('/api/config/test-stt', { method: 'POST', token: normal.token, form: empty });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error.code, 'audio_required');

  // 非音频 → 400 audio_mime_invalid
  const form2 = new FormData();
  form2.append('file', new Blob([Buffer.from('hello')], { type: 'text/plain' }), 'a.txt');
  const badMime = await api('/api/config/test-stt', { method: 'POST', token: normal.token, form: form2 });
  assert.equal(badMime.status, 400);
  assert.equal(badMime.json.error.code, 'audio_mime_invalid');

  // 配置到本地 mock（OpenAI 兼容 /v1/audio/transcriptions）→ 200
  saveUserApi(normal.id, { stt: { apiKey: 'test-stt-key', baseUrl: `${MOCK_BASE}/v1`, model: 'mimo-audio' } });
  const form3 = new FormData();
  form3.append('file', new Blob([Buffer.from('RIFF0000WAVEfmt ') ], { type: 'audio/wav' }), 'hello.wav');
  const ok = await api('/api/config/test-stt', { method: 'POST', token: normal.token, form: form3 });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.text, '你好呀，这是语音转写结果');
  assert.equal(ok.json.model, 'mimo-audio');
  assert.ok(ok.json.bytes > 0);

  saveUserApi(normal.id, { stt: { apiKey: '', baseUrl: '' } });
});

// ══════════════════════ 6. 挂载契约（lead 的 app.js） ══════════════════════
test('app.js 已挂载 /api/integrations 与 config-test 路由', () => {
  assert.match(appSource, /routes\/integrations\.js/, 'app.js 应 import integrations 路由');
  assert.match(appSource, /routes\/config-test\.js/, 'app.js 应 import config-test 路由');
  assert.match(appSource, /app\.use\('\/api\/integrations'/, 'app.js 应挂载 /api/integrations');
  assert.match(appSource, /app\.use\('\/api\/config', configTestRouter\(\)\)/, 'app.js 应在 configRouter 之前挂载 configTestRouter');
});
