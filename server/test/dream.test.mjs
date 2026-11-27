// v2.0.0 梦境生成单测：排期 / 生成 / 上限 / 限额 / 唤醒提及
// 运行：node --test server/test/dream.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.COCOA_DATA_DIR = process.env.COCOA_DATA_DIR || '/tmp/cocoa-dream-test';
process.env.PORT = process.env.PORT || '18092';
process.env.COCOA_LOG_LEVEL = 'error';
process.env.COCOA_DISABLE_WEATHER = '1';
process.env.COCOA_EMBEDDING_API_KEY = '';
process.env.COCOA_EMBEDDING_BASE_URL = '';
fs.rmSync(process.env.COCOA_DATA_DIR, { recursive: true, force: true });

const { run, get, all } = await import('../src/db/index.js');
const { nowIso, uuid, dayKey } = await import('../src/core/util.js');
const { encryptText, decryptText, encryptJson, decryptJson } = await import('../src/core/crypto.js');
const { createCharacter, getSettings, updateState, ensureState } = await import('../src/services/characters.js');
const { saveUserApi, savePrefs } = await import('../src/services/settings.js');
const { enqueue, nextJob, jobPayload } = await import('../src/services/jobs.js');
const { recordUsage } = await import('../src/ai/usage.js');
const chat = await import('../src/ai/chat.js');
const active = await import('../src/ai/active.js');
const dream = await import('../src/ai/dream.js');

const userId = 'u_dream_test';
if (!get('SELECT id FROM users WHERE id = ?', userId)) {
  run(
    'INSERT INTO users(id, username, email, password_hash, password_salt, created_at) VALUES(?,?,?,?,?,?)',
    userId, userId, `${userId}@example.com`, 'hash', 'salt', nowIso(),
  );
}
saveUserApi(userId, { chat: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-test', model: 'gpt-4o-mini' } });
savePrefs(userId, { limits: { enabled: true, hardTokens: 0, softTokens: 0 }, contextLimits: {} });

function freshCharacter(sleepState = 'sleeping') {
  const character = createCharacter(userId, { name: '梦梦', relation: '恋人', personality: '温柔' });
  updateState(character.id, { sleepState });
  return character;
}

function insertDreamBook(characterId, day = dayKey()) {
  const id = `bk_${uuid().replace(/-/g, '').slice(0, 16)}`;
  run(
    'INSERT INTO books(id, user_id, character_id, type, title, content, day, meta, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    id, userId, characterId, 'dream', encryptText(userId, `梦境 · ${day}`),
    encryptText(userId, '梦里下了一场安静的雪。'), day, encryptJson(userId, { mode: 'sleeping', mood: '平静' }), nowIso(), nowIso(),
  );
  return id;
}

const dreamProvider = {
  async chatText(uid, opts) {
    assert.equal(opts.task, 'dream');
    return {
      text: JSON.stringify({ type: 'dream', content: '我梦见我们把星星装进玻璃罐，挂在窗台上，风一碰就叮当作响。', mood: '温柔' }),
      usage: { input: 30, output: 40 },
      model: 'fake-dream',
    };
  },
};

// ---------------- 排期 ----------------

test('dreamDueMs：夜间梦落在入睡与预计醒来之间', () => {
  const now = Date.parse('2026-11-27T23:30:00+08:00');
  const wakeAt = new Date(now + 7 * 3600_000).toISOString();
  for (const r of [0, 0.3, 0.9, 1]) {
    const due = dream.dreamDueMs({ now, mode: 'sleeping', wakeAt, rng: () => r });
    assert.ok(due > now && due <= Date.parse(wakeAt), `due=${due} 应在睡眠窗口内`);
  }
  // 无预计醒来时间：不超过 8 小时
  const due = dream.dreamDueMs({ now, mode: 'sleeping', wakeAt: null, rng: () => 1 });
  assert.ok(due <= now + 8 * 3600_000);
  // 午睡：5–40 分钟内
  const nap = dream.dreamDueMs({ now, mode: 'napping', rng: () => 0.5 });
  assert.ok(nap >= now + 5 * 60_000 && nap <= now + 40 * 60_000);
});

test('scheduleDream：入睡排期、pending 去重、午睡概率', () => {
  const character = freshCharacter('sleeping');
  const out = dream.scheduleDream({ userId, characterId: character.id, mode: 'sleeping', rng: () => 0.5 });
  assert.equal(out.scheduled, true);
  const job = nextJob(character.id, 'dream');
  assert.ok(job, '应排入 dream 任务');
  assert.equal(jobPayload(job).mode, 'sleeping');

  const again = dream.scheduleDream({ userId, characterId: character.id, mode: 'sleeping', rng: () => 0.5 });
  assert.equal(again.scheduled, false);
  assert.equal(again.reason, 'pending');

  // 午睡：rng 0.5 > 0.3 不做梦；0.1 做梦
  const napper = freshCharacter('napping');
  const skip = dream.scheduleDream({ userId, characterId: napper.id, mode: 'napping', rng: () => 0.5 });
  assert.equal(skip.scheduled, false);
  assert.equal(skip.reason, 'nap_skip');
  const napOk = dream.scheduleDream({ userId, characterId: napper.id, mode: 'napping', rng: () => 0.1 });
  assert.equal(napOk.scheduled, true);
});

test('scheduleDream：每日上限与硬限额', () => {
  const character = freshCharacter('sleeping');
  insertDreamBook(character.id);
  insertDreamBook(character.id);
  const capped = dream.scheduleDream({ userId, characterId: character.id, mode: 'sleeping' });
  assert.equal(capped.scheduled, false);
  assert.equal(capped.reason, 'daily_cap');

  const other = freshCharacter('sleeping');
  savePrefs(userId, { limits: { enabled: true, hardTokens: 10, softTokens: 0 } });
  recordUsage({ userId, characterId: other.id, kind: 'main', model: 'x', usage: { input: 20, output: 20 } });
  const limited = dream.scheduleDream({ userId, characterId: other.id, mode: 'sleeping' });
  assert.equal(limited.scheduled, false);
  assert.equal(limited.reason, 'hard_limit');
  savePrefs(userId, { limits: { enabled: true, hardTokens: 0, softTokens: 0 } });
});

// ---------------- 生成 ----------------

test('runDream：生成梦境入书架、写系统上下文、记账', async () => {
  const character = freshCharacter('sleeping');
  const job = { user_id: userId, character_id: character.id };
  const out = await dream.runDream(job, { mode: 'sleeping', provider: dreamProvider });
  assert.equal(out.ok, true);
  assert.ok(out.bookId);
  const row = get('SELECT * FROM books WHERE id = ?', out.bookId);
  assert.equal(row.type, 'dream');
  assert.equal(decryptText(userId, row.content), '我梦见我们把星星装进玻璃罐，挂在窗台上，风一碰就叮当作响。');
  assert.equal(decryptJson(userId, row.meta).mood, '温柔');
  const sys = all(
    "SELECT m.* FROM messages m JOIN conversations c ON m.conversation_id = c.id WHERE c.user_id = ? AND c.character_id = ? AND c.kind = 'system' AND m.kind = 'dream'",
    userId, character.id,
  );
  assert.ok(sys.length >= 1, '梦境应写入系统上下文');
  const usage = get("SELECT * FROM usage_records WHERE user_id = ? AND kind = 'dream' ORDER BY created_at DESC LIMIT 1", userId);
  assert.ok(usage, '梦境消耗应记账');
});

test('runDream：清醒/软限额/每日上限时跳过', async () => {
  const awake = freshCharacter('awake');
  const outAwake = await dream.runDream({ user_id: userId, character_id: awake.id }, { mode: 'sleeping', provider: dreamProvider });
  assert.equal(outAwake.ok, false);
  assert.equal(outAwake.reason, 'not_asleep');

  const capped = freshCharacter('sleeping');
  insertDreamBook(capped.id);
  insertDreamBook(capped.id);
  const outCap = await dream.runDream({ user_id: userId, character_id: capped.id }, { mode: 'sleeping', provider: dreamProvider });
  assert.equal(outCap.ok, false);
  assert.equal(outCap.reason, 'daily_cap');

  const soft = freshCharacter('sleeping');
  savePrefs(userId, { limits: { enabled: true, hardTokens: 0, softTokens: 10 } });
  recordUsage({ userId, characterId: soft.id, kind: 'main', model: 'x', usage: { input: 20, output: 20 } });
  const outSoft = await dream.runDream({ user_id: userId, character_id: soft.id }, { mode: 'sleeping', provider: dreamProvider });
  assert.equal(outSoft.ok, false);
  assert.equal(outSoft.reason, 'soft_limit');
  savePrefs(userId, { limits: { enabled: true, hardTokens: 0, softTokens: 0 } });
});

// ---------------- 唤醒提及 ----------------

test('planDreamMention：有梦才排期主动提及（2–10 分钟）', () => {
  const character = freshCharacter('awake');
  const none = dream.planDreamMention({ userId, characterId: character.id, rng: () => 0.5 });
  assert.equal(none.scheduled, false);

  insertDreamBook(character.id);
  const now = Date.now();
  const out = dream.planDreamMention({ userId, characterId: character.id, rng: () => 0.5, now });
  assert.equal(out.scheduled, true);
  const job = nextJob(character.id, 'active_reply');
  assert.ok(job);
  const payload = jobPayload(job);
  assert.equal(payload.kind, 'dream_mention');
  assert.ok(payload.dreamContent.includes('雪'));
  const due = Date.parse(job.due_at);
  assert.ok(due >= now + 2 * 60_000 - 1000 && due <= now + 10 * 60_000 + 1000);
});

test('handleActiveReplyJob：dream_mention 走生成管道', async () => {
  const character = freshCharacter('awake');
  chat.setChatProvider({
    async chatText(uid, opts) {
      return { text: JSON.stringify({ type: 'message', content: '昨晚做了个奇怪的梦，想讲给你听' }), usage: { input: 10, output: 10 }, model: 'fake' };
    },
  });
  const out = await active.handleActiveReplyJob({
    userId, characterId: character.id,
    payload: { kind: 'dream_mention', dreamContent: '梦里下了一场安静的雪。' },
  });
  assert.equal(out.ok, true);
  const agents = all("SELECT * FROM messages WHERE character_id = ? AND role = 'agent' ORDER BY created_at DESC LIMIT 1", character.id);
  assert.ok(agents.length >= 1);
});