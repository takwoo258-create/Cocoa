// v1.5.0 状态核心单测：模型作息 / 刷新间隔 / 手动冷却 / 停用 / 亲密度衰减 / 天气缓存
// 运行：COCOA_DATA_DIR=/tmp/cocoa-status-test PORT=18082 node --test server/test/status.test.mjs
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.COCOA_DATA_DIR = process.env.COCOA_DATA_DIR || '/tmp/cocoa-status-test';
process.env.PORT = process.env.PORT || '18082';
process.env.COCOA_DISABLE_WEATHER = '1';
process.env.COCOA_LOG_LEVEL = 'error';
const DATA_DIR = process.env.COCOA_DATA_DIR;
fs.rmSync(DATA_DIR, { recursive: true, force: true });

const { run, get, all } = await import('../src/db/index.js');
const { nowIso } = await import('../src/core/util.js');
const { createCharacter, getCharacter, updateCharacter, updateState, ensureState } = await import('../src/services/characters.js');
const { saveUserApi, savePrefs } = await import('../src/services/settings.js');
const { enqueue } = await import('../src/services/jobs.js');
const context = await import('../src/ai/context.js');
const status = await import('../src/ai/status.js');
const chat = await import('../src/ai/chat.js');
const scheduler = await import('../src/ai/scheduler.js');

const userId = 'u_status_test';

function seedUser(id) {
  if (get('SELECT id FROM users WHERE id = ?', id)) return;
  run(
    'INSERT INTO users(id, username, email, password_hash, password_salt, created_at) VALUES(?,?,?,?,?,?)',
    id,
    id,
    `${id}@example.com`,
    'hash',
    'salt',
    nowIso(),
  );
}

seedUser(userId);
saveUserApi(userId, { chat: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-test', model: 'gpt-4o-mini' } });
savePrefs(userId, { limits: { enabled: true, hardTokens: 0, softTokens: 0 }, contextLimits: {} });

function freshCharacter(settingsPatch = {}) {
  const character = createCharacter(userId, { name: '可可', relation: '恋人', personality: '温柔' });
  updateCharacter(userId, character.id, {
    settings: { enabled: true, statusIntervalSec: 600, activeReply: true, ...settingsPatch },
  });
  updateState(character.id, { sleepState: 'awake', intimacy: 0 });
  run(
    'UPDATE character_state SET sleep_schedule = NULL, sleep_since = NULL, next_sleep_change = NULL, last_manual_refresh_at = NULL WHERE character_id = ?',
    character.id,
  );
  return getCharacter(userId, character.id);
}

function statusProvider(statusText) {
  return {
    async chatText(uid, opts) {
      if (opts.task === 'status') return { text: statusText, usage: { input: 5, output: 5 }, model: 'fake-status' };
      return { text: JSON.stringify({ type: 'message', content: '嗯' }), usage: { input: 1, output: 1 }, model: 'fake' };
    },
  };
}

beforeEach(() => {
  run("UPDATE jobs SET status = 'cancelled' WHERE status = 'pending'");
  chat.resetRuntime();
  context.clearCompressing();
});

test('status: 模型 sleepState/sleepSchedule 写入 state 与 sleep_since/next_sleep_change', async () => {
  const character = freshCharacter();
  const provider = statusProvider(
    JSON.stringify({
      type: 'status',
      motion: '窝在沙发里',
      psychology: '有点困',
      mood: '困倦',
      health: '健康',
      sleepState: 'sleeping',
      sleepSchedule: { sleepAt: '23:00', wakeAt: '07:00', napStart: null, napEnd: null },
    }),
  );
  const out = await status.refreshStatus({ userId, characterId: character.id, provider });
  assert.equal(out.ok, true);
  assert.equal(out.sleepState, 'sleeping');
  assert.equal(out.state.sleep.state, 'sleeping');

  const row = ensureState(character.id, userId);
  assert.equal(row.sleep_state, 'sleeping');
  const meta = status.readSleepMeta(row);
  assert.equal(meta.schedule.wakeAt, '07:00');
  assert.ok(meta.since, '入睡应记录 sleep_since');
  assert.ok(meta.nextChange, '应计算 next_sleep_change');
  const next = new Date(meta.nextChange);
  assert.equal((next.getUTCHours() + 8) % 24, 7, '睡眠中的下一次变化应是起床 07:00（UTC+8）');
  assert.equal(status.effectiveSleep(getCharacter(userId, character.id), row).mode, 'sleeping');

  // 状态未变化 → 第二次刷新不再重复写消息
  const again = await status.refreshStatus({ userId, characterId: character.id, provider });
  assert.equal(again.ok, true);
  assert.equal(again.duplicate, true);
  assert.equal(again.messageId, null);
});

test('status: 刷新间隔 5 分钟~永久（statusIntervalSec；null/0 不自动刷新）', async () => {
  const character = freshCharacter({ statusIntervalSec: 300 });
  const jobsBefore = all("SELECT id FROM jobs WHERE character_id = ? AND type = 'status_refresh' AND status = 'pending'", character.id).length;
  const first = status.scheduleStatusRefresh({ userId, characterId: character.id });
  assert.equal(first.scheduled, true);
  assert.ok(first.delayMs >= 295_000 && first.delayMs <= 301_000, `5 分钟间隔，实际 ${first.delayMs}`);
  assert.ok(jobsBefore <= 1);

  updateCharacter(userId, character.id, { settings: { statusIntervalSec: null } });
  run("UPDATE character_state SET next_sleep_change = NULL WHERE character_id = ?", character.id);
  const off = status.scheduleStatusRefresh({ userId, characterId: character.id });
  assert.equal(off.scheduled, false);
  assert.equal(off.reason, 'interval_off');

  // 旧的 statusIntervalMin 兼容
  assert.equal(status.statusIntervalSecFor({ statusIntervalMin: 5 }), 300);
  assert.equal(status.statusIntervalSecFor({ statusIntervalSec: 86_400 * 90 }), 86_400 * 30);
});

test('status: 手动刷新冷却秒数准确，且与自动刷新解耦', async () => {
  const character = freshCharacter({ statusIntervalSec: 600 });
  run(
    'UPDATE character_state SET last_manual_refresh_at = ? WHERE character_id = ?',
    new Date(Date.now() - (4 * 60_000 + 900)).toISOString(),
    character.id,
  );
  const cooldown = status.manualRefreshCooldown(userId, character.id);
  assert.equal(cooldown.allowed, false);
  assert.ok(cooldown.retryAfterSec >= 60 && cooldown.retryAfterSec <= 62, `剩余秒数应约 61s，实际 ${cooldown.retryAfterSec}`);
  assert.ok(cooldown.retryAfterMs > 59_000 && cooldown.retryAfterMs <= 61_000);
  assert.ok(Date.parse(cooldown.nextAllowedAt) > Date.now());

  // 冷却结束后手动刷新成功
  run('UPDATE character_state SET last_manual_refresh_at = NULL WHERE character_id = ?', character.id);
  const provider = statusProvider(JSON.stringify({ type: 'status', motion: '看书', psychology: '平静', mood: '开心', health: '健康', sleepState: 'awake' }));
  const out = await status.refreshStatusNow({ userId, characterId: character.id, provider });
  assert.equal(out.ok, true);
  assert.ok(out.nextAllowedAt);
  const after = status.manualRefreshCooldown(userId, character.id);
  assert.equal(after.allowed, false);
  assert.ok(after.retryAfterSec >= 295 && after.retryAfterSec <= 301);

  // 自动刷新任务仍按角色间隔，不被手动刷新改写
  const pending = all("SELECT * FROM jobs WHERE character_id = ? AND type = 'status_refresh' AND status = 'pending'", character.id);
  assert.equal(pending.length, 1);
  const delay = Date.parse(pending[0].due_at) - Date.now();
  assert.ok(delay > 500_000, `自动刷新仍应在约 10 分钟后，实际 ${delay}`);
});

test('status: 角色关闭运行后刷新/入队都跳过（409 语义）', async () => {
  const character = freshCharacter({ enabled: false });
  const provider = statusProvider('{"type":"status"}');
  const out = await status.refreshStatus({ userId, characterId: character.id, provider });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'character_disabled');

  const now = await status.refreshStatusNow({ userId, characterId: character.id, provider });
  assert.equal(now.ok, false);
  assert.equal(now.reason, 'character_disabled');
  assert.equal(now.status, 409);

  const scheduled = status.scheduleStatusRefresh({ userId, characterId: character.id });
  assert.equal(scheduled.scheduled, false);
  assert.equal(scheduled.reason, 'character_disabled');
  // 恢复开启后由巡检重新补排
  updateCharacter(userId, character.id, { settings: { enabled: true } });
  assert.equal(status.scheduleStatusRefresh({ userId, characterId: character.id }).scheduled, true);
});

test('status: nextSleepChangeAt 与作息窗口（跨零点）', () => {
  const schedule = { sleepAt: '23:30', wakeAt: '07:10', napStart: null, napEnd: null };
  const awakeNext = new Date(status.nextSleepChangeAt(schedule, 'awake', Date.now()));
  assert.equal((awakeNext.getUTCHours() + 8) % 24, 23);
  assert.equal(awakeNext.getUTCMinutes(), 30);
  const sleepNext = new Date(status.nextSleepChangeAt(schedule, 'sleeping', Date.now()));
  assert.equal((sleepNext.getUTCHours() + 8) % 24, 7);
  assert.equal(sleepNext.getUTCMinutes(), 10);
  assert.equal(status.nextSleepChangeAt(null, 'awake'), null);
});

test('intimacy: 7 天无对话按 -0.5/天衰减并写 decay log，同日不重复', async () => {
  const character = freshCharacter();
  updateState(character.id, { intimacy: 5 });
  const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
  run(
    'INSERT INTO messages(id, conversation_id, character_id, user_id, role, kind, content, meta, tokens_in, tokens_out, created_at) VALUES(?,?,?,?,?,?,?,?,0,0,?)',
    'm_status_old',
    context.ensureMainConversation(userId, character.id).id,
    character.id,
    userId,
    'user',
    'text',
    '很久以前的消息',
    null,
    old,
  );
  const first = await scheduler.runIntimacyDecay();
  assert.ok(first.applied >= 1);
  const after = ensureState(character.id, userId);
  assert.ok(Number(after.intimacy) < 5, '应发生衰减');
  assert.ok(Number(after.intimacy) >= 0);
  const logs = all("SELECT * FROM intimacy_log WHERE character_id = ? AND source = 'decay'", character.id);
  assert.ok(logs.length >= 1);

  const second = await scheduler.runIntimacyDecay();
  assert.equal(second.applied, 0, '同一天不重复衰减');
});

test('weather: 30 分钟缓存 + 单飞（同城市并发只请求一次）', async () => {
  const prev = process.env.COCOA_DISABLE_WEATHER;
  delete process.env.COCOA_DISABLE_WEATHER;
  try {
    status.clearWeatherCache();
    let calls = 0;
    const fetcher = async (city) => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return `${city} 晴 20°C`;
    };
    const [a, b] = await Promise.all([
      status.cachedWeatherPrompt({ weatherCity: '宣城' }, { fetcher }),
      status.cachedWeatherPrompt({ weatherCity: '宣城' }, { fetcher }),
    ]);
    assert.equal(a, '宣城 晴 20°C');
    assert.equal(b, a);
    assert.equal(calls, 1, '并发只应触发一次请求');
    const cached = await status.cachedWeatherPrompt({ weatherCity: '宣城' }, { fetcher });
    assert.equal(cached, a);
    assert.equal(calls, 1, '30 分钟内使用缓存');
    await status.cachedWeatherPrompt({ weatherCity: '合肥' }, { fetcher });
    assert.equal(calls, 2, '不同城市独立缓存');
    const noFetch = await status.cachedWeatherPrompt({ weatherCity: '宣城' }, { fetcher, fetchIfMissing: false });
    assert.equal(noFetch, a);
    assert.equal(calls, 2, '对话侧不允许主动请求');
  } finally {
    if (prev === undefined) delete process.env.COCOA_DISABLE_WEATHER;
    else process.env.COCOA_DISABLE_WEATHER = prev;
  }
});
