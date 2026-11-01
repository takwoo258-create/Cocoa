// 对话主链路单元测试（离线；本地假 provider，无外网调用）
// 运行：COCOA_DATA_DIR=/tmp/cocoa-ai-chat PORT=18082 node --test server/test/ai-chat.test.mjs
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

process.env.COCOA_DATA_DIR = process.env.COCOA_DATA_DIR || '/tmp/cocoa-ai-chat';
process.env.PORT = process.env.PORT || '18082';
const DATA_DIR = process.env.COCOA_DATA_DIR;
fs.rmSync(DATA_DIR, { recursive: true, force: true });

const { run, get, all } = await import('../src/db/index.js');
const env = (await import('../src/env.js')).default;
const { nowIso, dayKey } = await import('../src/core/util.js');
const { encryptText, decryptText, decryptJson, sha256, signToken } = await import('../src/core/crypto.js');
const { createCharacter, getCharacter, updateState, ensureState, updateCharacter } = await import('../src/services/characters.js');
const { saveUserApi, savePrefs, getPrefs } = await import('../src/services/settings.js');
const { enqueue, jobPayload, markJob } = await import('../src/services/jobs.js');
const { recordUsage } = await import('../src/services/usage.js').catch(() => import('../src/ai/usage.js'));
const reply = await import('../src/ai/reply.js');
const context = await import('../src/ai/context.js');
const sentence = await import('../src/ai/sentence.js');
const status = await import('../src/ai/status.js');
const active = await import('../src/ai/active.js');
const chat = await import('../src/ai/chat.js');
const scheduler = await import('../src/ai/scheduler.js');
const { chatRoutes } = await import('../src/routes/chat.js');

// ---------------- 测试基座 ----------------

const userId = 'u_ai_chat_test';
const otherUserId = 'u_ai_chat_other';

function seedUser(id, qq = null) {
  if (get('SELECT id FROM users WHERE id = ?', id)) return;
  run(
    'INSERT INTO users(id, username, email, password_hash, password_salt, qq, created_at) VALUES(?,?,?,?,?,?,?)',
    id,
    id,
    `${id}@example.com`,
    'hash',
    'salt',
    qq,
    nowIso(),
  );
}

seedUser(userId, '10086');
seedUser(otherUserId);
saveUserApi(userId, { chat: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-test', model: 'gpt-4o-mini' } });

function freshCharacter(extra = {}) {
  const character = createCharacter(userId, {
    name: '可可',
    age: '20',
    race: '人类',
    gender: '女',
    personality: '温柔、爱撒娇',
    worldview: '现代都市',
    hobbies: '看书画画',
    relation: '恋人',
    appearance: '黑长直',
    occupation: '大学生',
    ...extra,
  });
  // 测试默认关闭作息，避免依赖真实时钟
  updateCharacter(userId, character.id, { settings: { sleep: { enabled: false }, activeReply: true } });
  updateState(character.id, { sleepState: 'awake' });
  return getCharacter(userId, character.id);
}

function makeMedia(kind, { content = 'fake-bytes', ext = kind === 'image' ? 'png' : 'mp3', mime = null } = {}) {
  const id = `md_test_${Math.random().toString(36).slice(2, 10)}`;
  const filename = `${id}.${ext}`;
  fs.mkdirSync(env.mediaDir, { recursive: true });
  fs.writeFileSync(path.join(env.mediaDir, filename), Buffer.from(content));
  run(
    'INSERT INTO media(id, user_id, character_id, kind, path, mime, size, created_at) VALUES(?,?,?,?,?,?,?,?)',
    id,
    userId,
    null,
    kind,
    filename,
    mime || (kind === 'image' ? 'image/png' : 'audio/mpeg'),
    content.length,
    nowIso(),
  );
  return id;
}

function fakeProvider(overrides = {}) {
  const state = { sentence: 'yes', calls: [], searchCalls: [], lastSystemText: '' };
  const impl = {
    async chatText(userIdArg, opts) {
      state.calls.push({ task: opts.task, thinking: opts.thinking, temperature: opts.temperature, maxTokens: opts.maxTokens });
      const systemText = (opts.messages || [])
        .filter((m) => m.role === 'system')
        .map((m) => String(m.content || ''))
        .join('\n');
      state.lastSystemText = systemText;
      if (opts.task === 'sentence') {
        return { text: state.sentence, usage: { input: 3, output: 1 }, model: 'fake-sentence' };
      }
      if (opts.task === 'status') {
        return {
          text: JSON.stringify({
            type: 'status',
            motion: '趴在桌上打盹',
            psychology: '有点想你',
            mood: '开心',
            health: '健康',
            healthAbnormal: false,
            moodAbnormal: false,
          }),
          usage: { input: 10, output: 10 },
          model: 'fake-status',
        };
      }
      if (systemText.includes('记忆压缩器')) {
        return { text: '摘要：用户和可可聊过天，用户喜欢猫。', usage: { input: 50, output: 20 }, model: 'fake-compress' };
      }
      if (systemText.includes('判断角色是否要为用户醒来')) {
        return { text: JSON.stringify({ type: 'wakeup', wakeup: 1 }), usage: { input: 5, output: 2 }, model: 'fake-wake' };
      }
      if (systemText.includes('被用户强行叫醒')) {
        return {
          text: JSON.stringify({ type: 'message', content: '唔…我醒了，怎么啦', agent: [{ content: '唔…我醒了，怎么啦', wait: 0 }] }),
          usage: { input: 10, output: 8 },
          model: 'fake-main',
        };
      }
      if (systemText.includes('超过等待期仍未回复')) {
        return {
          text: JSON.stringify({ type: 'subjective', content: '下一次主动消息', sendsec: 60 }),
          usage: { input: 10, output: 8 },
          model: 'fake-main',
        };
      }
      if (systemText.includes('现在由你主动开启一段对话')) {
        return {
          text: JSON.stringify({ type: 'subjective', content: '我突然想起你啦', sendsec: 0 }),
          usage: { input: 10, output: 8 },
          model: 'fake-main',
        };
      }
      if (typeof overrides.main === 'function') {
        const custom = await overrides.main({ systemText, opts, state });
        if (custom !== undefined) return custom;
      }
      return {
        text: JSON.stringify({ type: 'message', content: '我在呢', devide: 1, agent: [{ content: '我在呢', wait: 0 }] }),
        usage: { input: 20, output: 5 },
        model: 'fake-main',
      };
    },
    async transcribe() {
      if (overrides.transcribeFails) throw new Error('stt down');
      return { text: '这是语音里的内容', model: 'fake-stt' };
    },
    async visionDescribe() {
      if (overrides.visionFails) throw new Error('vision down');
      return { text: '照片里有一只橘猫', model: 'fake-vision', usage: { input: 5, output: 5 } };
    },
    async synthesize() {
      if (overrides.ttsFails) throw new Error('tts down');
      return { buffer: Buffer.from('fake-mp3-bytes'), mime: 'audio/mpeg' };
    },
    async webSearch(userIdArg, query, opts) {
      state.searchCalls.push({ userId: userIdArg, query, opts });
      if (overrides.searchFails) throw new Error('search down');
      return {
        query,
        model: 'fake-search',
        usage: { input: 7, output: 3 },
        results: overrides.searchResults || [],
      };
    },
  };
  return { provider: impl, state };
}

async function waitFor(predicate, { timeout = 5000, interval = 20 } = {}) {
  const started = Date.now();
  for (;;) {
    const out = await predicate();
    if (out) return out;
    if (Date.now() - started > timeout) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, interval));
  }
}

function makeDue(characterId, type) {
  const past = new Date(Date.now() - 1000).toISOString();
  run(
    "UPDATE jobs SET due_at = ? WHERE character_id = ? AND type = ? AND status = 'pending'",
    past,
    characterId,
    type,
  );
}

function pendingJobs(characterId, type) {
  return all(
    "SELECT * FROM jobs WHERE character_id = ? AND type = ? AND status = 'pending' ORDER BY due_at ASC",
    characterId,
    type,
  );
}

// 每个用例开始前清空历史 pending 任务与进程内运行时状态，保证用例互不干扰
beforeEach(() => {
  run("UPDATE jobs SET status = 'cancelled' WHERE status = 'pending'");
  chat.resetRuntime();
  context.clearCompressing();
  chat.setChatProvider(null);
});

function lastAgentMessage(characterId) {
  const row = get(
    "SELECT * FROM messages WHERE character_id = ? AND role = 'agent' ORDER BY created_at DESC LIMIT 1",
    characterId,
  );
  if (!row) return null;
  return { ...row, plain: decryptText(userId, row.content), meta: decryptJson(userId, row.meta, {}) };
}

// ---------------- 纯函数：回复协议 ----------------

test('reply: 解析标准 JSON、代码块包裹与前后噪声', () => {
  const plain = reply.parseReply(JSON.stringify({ type: 'message', content: '你好呀', devide: 2, agent: [{ content: '你好呀', wait: 1 }, { content: '在忙吗', wait: 3 }] }));
  assert.equal(plain.type, 'message');
  assert.equal(plain.segments.length, 2);
  assert.equal(plain.segments[1].wait, 3);
  assert.equal(plain.parsed, true);

  const fenced = reply.parseReply('好的，这是回复：\n```json\n{"type":"message","content":"喵","agent":[{"content":"喵","wait":0}]}\n```\n以上。');
  assert.equal(fenced.type, 'message');
  assert.equal(fenced.content, '喵');

  const noisy = reply.parseReply('前言 {"type":"message","content":"{\\"a\\":1} 带括号","agent":[]} 后记');
  assert.equal(noisy.segments.length, 1);
  assert.equal(noisy.content, '{"a":1} 带括号');
});

test('reply: wait 限制 0-8、纯文本降级、分段能力开关', () => {
  const clamped = reply.parseReply(JSON.stringify({ type: 'message', content: 'a', devide: 3, agent: [{ content: 'a', wait: 99 }, { content: 'b', wait: -5 }, { content: 'c', wait: 2.6 }] }));
  assert.deepEqual(clamped.segments.map((s) => s.wait), [8, 0, 3]);

  const fallback = reply.parseReply('模型今天不想返回 JSON，就说了这句话。');
  assert.equal(fallback.fallback, true);
  assert.equal(fallback.type, 'message');
  assert.equal(fallback.segments[0].content, '模型今天不想返回 JSON，就说了这句话。');

  const single = reply.parseReply(JSON.stringify({ type: 'message', content: '合并', agent: [{ content: '一', wait: 1 }, { content: '二', wait: 2 }] }), { segmentEnabled: false });
  assert.equal(single.segments.length, 1);
  assert.equal(single.content, '合并');
});

test('reply: subjective/status/wakeup 字段规范化', () => {
  const sub = reply.parseReply(JSON.stringify({ type: 'subjective', content: '来啦', sendsec: '30' }));
  assert.equal(sub.type, 'subjective');
  assert.equal(sub.sendsec, 30);

  const statusReply = reply.parseReply(JSON.stringify({ type: 'status', motion: '走', psychology: '想', mood: '烦闷', health: '发烧', healthAbnormal: true }));
  assert.equal(statusReply.type, 'status');
  assert.equal(statusReply.fields.health, '发烧');
  assert.equal(statusReply.flags.healthAbnormal, true);

  const wake = reply.parseReply('{"type":"wakeup","wakeup":1}');
  assert.equal(wake.wakeup, 1);
  assert.equal(reply.parseReply('{"type":"wakeup","wakeup":"0"}').wakeup, 0);
});

// ---------------- 纯函数：token 估算 / 上下文 ----------------

test('context: 中文≈字符数*0.9、英文≈字符/4，并计入图片描述', () => {
  assert.equal(context.estimateTextTokens('你好世界'), 4); // 4*0.9=3.6 → 4
  assert.equal(context.estimateTextTokens('hello world'), 3); // 11/4=2.75 → 3
  const imageDesc = context.estimateTextTokens('【图片描述】照片里有一只橘猫');
  assert.ok(imageDesc > 5);
  const messages = context.estimateMessagesTokens([
    { role: 'user', content: '你好' },
    { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:...' } }] },
  ]);
  assert.ok(messages >= context.estimateTextTokens('你好') + 85);
});

test('context: 主会话复用、context_limit 取 prefs.contextLimits、占用百分比', () => {
  const character = freshCharacter();
  savePrefs(userId, { contextLimits: { [character.id]: 1000 } });
  const conv1 = context.ensureMainConversation(userId, character.id);
  const conv2 = context.ensureMainConversation(userId, character.id);
  assert.equal(conv1.id, conv2.id);
  assert.equal(Number(conv1.context_limit), 1000);

  run(
    "INSERT INTO messages(id, conversation_id, character_id, user_id, role, kind, content, meta, tokens_in, tokens_out, created_at) VALUES(?,?,?,?,?,?,?,?,0,0,?)",
    'm_ctx_1',
    conv1.id,
    character.id,
    userId,
    'user',
    'text',
    encryptText(userId, '喵喵喵'),
    null,
    nowIso(),
  );
  const info = chat.getContextInfo(userId, character.id);
  assert.equal(info.limit, 1000);
  assert.ok(info.used > 0);
  assert.ok(info.percent > 0 && info.percent < 1);
  assert.equal(context.isCompressing(conv1.id), false);
});

// ---------------- 纯函数：句子检查 / 作息 / 异常 ----------------

test('sentence: cleanVerdict 容错，no 判定为未完成，失败按 yes', async () => {
  assert.equal(sentence.cleanVerdict('yes'), 'yes');
  assert.equal(sentence.cleanVerdict('Yes.'), 'yes');
  assert.equal(sentence.cleanVerdict('```text\nno\n```'), 'no');
  assert.equal(sentence.cleanVerdict('maybe'), null);
  assert.equal(sentence.cleanVerdict(''), null);

  const character = freshCharacter();
  const { provider, state } = fakeProvider();
  state.sentence = 'No.';
  const incomplete = await sentence.checkSentenceComplete(userId, '我今天想说', { provider });
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.verdict, 'no');
  assert.equal(incomplete.failed, false);

  state.sentence = 'yes';
  const complete = await sentence.checkSentenceComplete(userId, '我今天想说说我的事', { provider });
  assert.equal(complete.complete, true);

  const broken = {
    async chatText() {
      throw new Error('network down');
    },
  };
  const failed = await sentence.checkSentenceComplete(userId, '任意句子', { provider: broken });
  assert.equal(failed.complete, true);
  assert.equal(failed.failed, true);
  assert.ok(character.id);
});

test('status: 作息判定（跨零点睡眠、午睡、关闭）与固定文案', () => {
  const settings = {
    sleep: { enabled: true, start: '23:30', end: '07:00', napStart: '13:00', napEnd: '14:30' },
  };
  assert.equal(status.sleepMode(settings, new Date('2026-10-31T23:45:00+08:00')).mode, 'sleep');
  assert.equal(status.sleepMode(settings, new Date('2026-11-01T02:00:00+08:00')).mode, 'sleep');
  assert.equal(status.sleepMode(settings, new Date('2026-11-01T06:59:00+08:00')).mode, 'sleep');
  assert.equal(status.sleepMode(settings, new Date('2026-11-01T07:00:00+08:00')).mode, 'awake');
  assert.equal(status.sleepMode(settings, new Date('2026-11-01T13:10:00+08:00')).mode, 'nap');
  assert.equal(status.sleepMode({ sleep: { ...settings.sleep, enabled: false } }, new Date('2026-11-01T02:00:00+08:00')).mode, 'awake');

  const nap = status.sleepNotice('可可', 'nap');
  assert.ok(nap.includes('可可在休息哦，要稍后再来找他/她吧'));
  assert.ok(nap.includes('若强行叫醒的话，可能会带来不必要的麻烦哦'));
  const night = status.sleepNotice('可可', 'sleep');
  assert.ok(night.includes('夜深了，明天再来找他/她吧，你也要早点睡哦'));
  assert.ok(night.includes('若强行叫醒的话，可能会带来不必要的麻烦哦'));
  assert.equal(status.sleepNotice('可可', 'awake'), '');
});

test('status: 异常判定与软限额下的 4 小时间隔', () => {
  assert.equal(status.detectAbnormal({ health: '健康', mood: '开心', psychology: '平静' }).healthAbnormal, false);
  assert.equal(status.detectAbnormal({ health: '有点发烧', mood: '开心' }).healthAbnormal, true);
  assert.equal(status.detectAbnormal({ health: '健康', mood: '烦闷' }).moodAbnormal, true);
  assert.equal(status.detectAbnormal({ health: '健康', mood: '平静', healthAbnormal: true }).healthAbnormal, true);
  assert.equal(status.statusIntervalMs({ statusIntervalMin: 10 }, false), 10 * 60_000);
  assert.equal(status.statusIntervalMs({ statusIntervalMin: 10 }, true), 4 * 3600_000);
});

// ---------------- 状态刷新（假 provider） ----------------

test('status: 刷新状态写 state + messages.kind=status（meta.flags 加密）+ 排下一次任务', async () => {
  const character = freshCharacter();
  const { provider } = fakeProvider();
  const out = await status.refreshStatus({ userId, characterId: character.id, provider });
  assert.equal(out.ok, true);
  assert.ok(out.state.motion);
  assert.equal(out.flags.healthAbnormal, false);
  assert.equal(out.flags.moodAbnormal, false);

  const stateRow = ensureState(character.id, userId);
  assert.equal(stateRow.motion, '趴在桌上打盹');

  const statusRow = get("SELECT * FROM messages WHERE character_id = ? AND kind = 'status' ORDER BY created_at DESC LIMIT 1", character.id);
  assert.ok(statusRow, '应写入 kind=status 的消息');
  const meta = decryptJson(userId, statusRow.meta, {});
  assert.equal(meta.flags.healthAbnormal, false);
  assert.equal(meta.flags.moodAbnormal, false);
  assert.ok(statusRow.content.startsWith('c2.'), '状态消息正文应加密');

  const jobs = pendingJobs(character.id, 'status_refresh');
  assert.equal(jobs.length, 1);
});

test('status: 健康异常时 flags 为 true 且写入加密 meta', async () => {
  const character = freshCharacter();
  const fake = fakeProvider();
  const provider = {
    ...fake.provider,
    async chatText(userIdArg, opts) {
      if (opts.task === 'status') {
        return {
          text: JSON.stringify({ type: 'status', motion: '缩在被子里', psychology: '难受', mood: '烦闷', health: '发烧了', healthAbnormal: true, moodAbnormal: true }),
          usage: { input: 8, output: 8 },
          model: 'fake-status',
        };
      }
      return fake.provider.chatText(userIdArg, opts);
    },
  };
  const out = await status.refreshStatus({ userId, characterId: character.id, provider });
  assert.equal(out.ok, true);
  assert.equal(out.flags.healthAbnormal, true);
  assert.equal(out.flags.moodAbnormal, true);
  const row = get("SELECT * FROM messages WHERE character_id = ? AND kind = 'status' ORDER BY created_at DESC LIMIT 1", character.id);
  const meta = decryptJson(userId, row.meta, {});
  assert.equal(meta.flags.healthAbnormal, true);
  assert.equal(meta.flags.moodAbnormal, true);
});

// ---------------- 主链路：文本 / 多模态 / TTS ----------------

test('chat: 文本消息落库加密、生成回复、分段任务与等待期', async () => {
  const character = freshCharacter();
  const fake = fakeProvider({
    main: async () => ({
      text: JSON.stringify({
        type: 'message',
        content: '我在呢，怎么啦',
        devide: 2,
        agent: [{ content: '我在呢', wait: 0 }, { content: '怎么啦', wait: 2 }],
      }),
      usage: { input: 20, output: 10 },
      model: 'fake-main',
    }),
  });
  chat.setChatProvider(fake.provider);

  const out = await chat.submitUserMessage({ userId, characterId: character.id, content: '在吗', kind: 'text' });
  assert.equal(out.accepted, true);
  assert.equal(out.queued, false);
  assert.ok(out.userMessage.id);

  const userRow = get('SELECT * FROM messages WHERE id = ?', out.messageId);
  assert.ok(userRow.content.startsWith('c2.'), '用户消息应加密存储');
  assert.equal(decryptText(userId, userRow.content), '在吗');

  const result = await out.waitForReply;
  assert.equal(result.ok, true);
  assert.equal(result.sent, true);

  const agent = lastAgentMessage(character.id);
  assert.equal(agent.plain, '我在呢');
  assert.equal(agent.meta.segment, 1);
  assert.equal(agent.meta.segments, 2);

  const segJobs = pendingJobs(character.id, 'segment_send');
  assert.equal(segJobs.length, 1);
  const payload = jobPayload(segJobs[0]);
  assert.equal(payload.content, '怎么啦');
  assert.equal(payload.wait, 2);

  // 等待期：60-80 秒 + active_reply 任务
  const ws = active.getWaitState(userId, character.id);
  assert.equal(ws.mode, 'waiting');
  const delay = new Date(ws.deadline).getTime() - new Date(ws.last_agent_at).getTime();
  assert.ok(delay >= 59_000 && delay <= 81_000, `等待期应在 60-80s，实际 ${delay}ms`);
  assert.equal(pendingJobs(character.id, 'active_reply').length, 1);

  // 分段任务到点发送
  makeDue(character.id, 'segment_send');
  const tick1 = await scheduler.tick({ sweep: false });
  assert.ok(tick1.processed >= 1);
  const segments = all("SELECT * FROM messages WHERE character_id = ? AND role = 'agent' ORDER BY created_at ASC", character.id);
  assert.equal(segments.length, 2);
  assert.equal(decryptText(userId, segments[1].content), '怎么啦');
});

test('chat: 语音消息先转写再并入用户消息，并合成语音回复', async () => {
  const character = freshCharacter();
  const fake = fakeProvider();
  chat.setChatProvider(fake.provider);
  const mediaId = makeMedia('voice');

  const out = await chat.submitUserMessage({ userId, characterId: character.id, content: '', kind: 'voice', mediaId });
  assert.equal(out.accepted, true);
  const userRow = get('SELECT * FROM messages WHERE id = ?', out.messageId);
  const userText = decryptText(userId, userRow.content);
  assert.ok(userText.includes('【语音转写】这是语音里的内容'));

  const result = await out.waitForReply;
  assert.equal(result.sent, true);
  const agent = lastAgentMessage(character.id);
  assert.ok(agent.meta.voiceMediaId, '语音消息应带语音回复 mediaId');
  assert.ok(agent.meta.voiceUrl.startsWith('/api/media/'));
  const mediaRow = get('SELECT * FROM media WHERE id = ?', agent.meta.voiceMediaId);
  assert.equal(mediaRow.kind, 'voice');
  assert.ok(fs.existsSync(path.join(env.mediaDir, mediaRow.path)));
});

test('chat: 图片消息走 visionDescribe；STT/视觉失败降级为文字占位不崩溃', async () => {
  const character = freshCharacter();
  const fake = fakeProvider({ visionFails: true, transcribeFails: true });
  chat.setChatProvider(fake.provider);

  const imageId = makeMedia('image');
  const imageOut = await chat.submitUserMessage({ userId, characterId: character.id, content: '看看这个', kind: 'image', mediaId: imageId });
  assert.equal(imageOut.accepted, true);
  const imageText = decryptText(userId, get('SELECT * FROM messages WHERE id = ?', imageOut.messageId).content);
  assert.ok(imageText.includes('〔图片消息，识别失败，按文字占位处理〕'));
  const imageResult = await imageOut.waitForReply;
  assert.equal(imageResult.sent, true, '视觉失败仍应继续生成回复');

  const voiceId = makeMedia('voice');
  const voiceOut = await chat.submitUserMessage({ userId, characterId: character.id, content: '听听', kind: 'voice', mediaId: voiceId });
  const voiceText = decryptText(userId, get('SELECT * FROM messages WHERE id = ?', voiceOut.messageId).content);
  assert.ok(voiceText.includes('〔语音消息，转写失败，按文字占位处理〕'));
  const voiceResult = await voiceOut.waitForReply;
  assert.equal(voiceResult.sent, true);
});

test('chat: 无 API key 时返回 accepted:false + notice，不抛 500；无媒体时报 400', async () => {
  const noKeyUser = 'u_ai_chat_nokey';
  seedUser(noKeyUser);
  const character = createCharacter(noKeyUser, { name: '无钥', relation: '朋友' });
  updateCharacter(noKeyUser, character.id, { settings: { sleep: { enabled: false } } });
  chat.setChatProvider(fakeProvider().provider);

  const out = await chat.submitUserMessage({ userId: noKeyUser, characterId: character.id, content: '在吗' });
  assert.equal(out.accepted, false);
  assert.ok(out.notice.includes('尚未配置对话模型'));
  assert.equal(out.reason, 'api_not_configured');
  assert.equal(get('SELECT COUNT(*) c FROM messages WHERE character_id = ?', character.id).c, 0);

  const character2 = freshCharacter();
  await assert.rejects(
    () => chat.submitUserMessage({ userId, characterId: character2.id, content: '', kind: 'image', mediaId: null }),
    (err) => err.status === 400,
  );
  await assert.rejects(
    () => chat.submitUserMessage({ userId, characterId: 'c_not_mine', content: 'hi' }),
    (err) => err.status === 404,
  );
});

test('chat: 句子未完整时等 30 秒（新消息可取消），到点再生成', async () => {
  const character = freshCharacter();
  const fake = fakeProvider();
  fake.state.sentence = 'no';
  chat.setChatProvider(fake.provider);
  savePrefs(userId, { thinking: false, segmentEnabled: true, contextLimits: {} });

  const first = await chat.submitUserMessage({ userId, characterId: character.id, content: '我今天想说' });
  assert.equal(first.accepted, true);
  assert.equal(first.reason, 'sentence_wait');
  const jobs = pendingJobs(character.id, 'sentence_wait');
  assert.equal(jobs.length, 1);
  const delay = new Date(jobs[0].due_at).getTime() - Date.now();
  assert.ok(delay > 25_000 && delay <= 30_500, `等待应约 30s，实际 ${delay}ms`);

  // 新消息取消旧计时
  fake.state.sentence = 'yes';
  const second = await chat.submitUserMessage({ userId, characterId: character.id, content: '我今天想说的是我升职了' });
  assert.equal(second.reason, 'generating');
  assert.equal(pendingJobs(character.id, 'sentence_wait').length, 0, '新消息应取消旧的 30s 等待');
  await second.waitForReply;

  // 再验证到点触发
  fake.state.sentence = 'no';
  const third = await chat.submitUserMessage({ userId, characterId: character.id, content: '那个' });
  assert.equal(third.reason, 'sentence_wait');
  makeDue(character.id, 'sentence_wait');
  const before = all("SELECT id FROM messages WHERE character_id = ? AND role = 'agent'", character.id).length;
  await scheduler.tick({ sweep: false });
  await waitFor(() => all("SELECT id FROM messages WHERE character_id = ? AND role = 'agent'", character.id).length > before);
});

test('chat: 思考模式默认关、触发词与 prefs.thinking 开启', async () => {
  const character = freshCharacter();
  const fake = fakeProvider();
  chat.setChatProvider(fake.provider);
  savePrefs(userId, { thinking: false, contextLimits: {} });

  const normal = await chat.submitUserMessage({ userId, characterId: character.id, content: '今天天气不错' });
  await normal.waitForReply;
  const normalCall = [...fake.state.calls].reverse().find((c) => c.task === 'main');
  assert.equal(normalCall.thinking, false);

  const trigger = await chat.submitUserMessage({ userId, characterId: character.id, content: '你再仔细想一想刚才的话' });
  await trigger.waitForReply;
  const triggerCall = [...fake.state.calls].reverse().find((c) => c.task === 'main');
  assert.equal(triggerCall.thinking, true);

  savePrefs(userId, { thinking: true });
  const prefsOn = await chat.submitUserMessage({ userId, characterId: character.id, content: '随便聊聊' });
  await prefsOn.waitForReply;
  const prefsCall = [...fake.state.calls].reverse().find((c) => c.task === 'main');
  assert.equal(prefsCall.thinking, true);
  savePrefs(userId, { thinking: false });

  assert.equal(chat.shouldThink('好好想想'), true);
  assert.equal(chat.shouldThink('吃了吗'), false);
});

// ---------------- 网页搜索（build.md 2.12） ----------------

test('chat: 需要联网但未配置搜索 key 时降级：回复不中断、notice 同会话去重', { timeout: 20_000 }, async () => {
  const user = 'u_ai_chat_nosearch';
  seedUser(user, '30011');
  saveUserApi(user, { chat: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-chat', model: 'gpt-4o-mini' } });
  const character = createCharacter(user, { name: '查查', relation: '朋友' });
  updateCharacter(user, character.id, { settings: { sleep: { enabled: false } } });
  const fake = fakeProvider();
  chat.setChatProvider(fake.provider);
  chat.resetSearchNotices();

  assert.equal(chat.needsWebSearch('帮我查一下最近的新闻'), true);
  assert.equal(chat.needsWebSearch('看看这个 https://example.com/a'), true);
  assert.equal(chat.needsWebSearch('今天吃什么'), false);
  assert.equal(chat.buildSearchContext([]), '');

  const first = await chat.submitUserMessage({ userId: user, characterId: character.id, content: '帮我查一下最近的新闻' });
  const out = await first.waitForReply;
  assert.equal(out.sent, true, '缺搜索配置不应中断回复');
  assert.equal(fake.state.searchCalls.length, 0, '无 key 时不应调用搜索');

  const notices = chat.getSearchNotices();
  assert.equal(notices.length, 1, '应推送一次搜索配置缺失提示');
  assert.ok(notices[0].content.includes('网页搜索还没设置哦'));

  const second = await chat.submitUserMessage({ userId: user, characterId: character.id, content: '网上说的那个是真的吗' });
  await second.waitForReply;
  assert.equal(chat.getSearchNotices().length, 1, '同一会话只提示一次');
});

test('chat: 有搜索 key 时注入外部资料并记录 search 用量', { timeout: 20_000 }, async () => {
  const user = 'u_ai_chat_search';
  seedUser(user, '30012');
  saveUserApi(user, {
    chat: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-chat', model: 'gpt-4o-mini' },
    search: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-search', model: 'deepseek-chat' },
  });
  const character = createCharacter(user, { name: '资料', relation: '朋友' });
  updateCharacter(user, character.id, { settings: { sleep: { enabled: false } } });
  const fake = fakeProvider({
    searchResults: [{ title: '今日头条', url: 'https://example.com/news/1', snippet: '今天的新闻摘要' }],
  });
  chat.setChatProvider(fake.provider);
  chat.resetSearchNotices();

  const submitted = await chat.submitUserMessage({ userId: user, characterId: character.id, content: '帮我查一下今天的新闻' });
  const out = await submitted.waitForReply;
  assert.equal(out.sent, true);
  assert.equal(out.search, true, '应标记本次生成使用了搜索结果');
  assert.equal(fake.state.searchCalls.length, 1, '应调用一次网页搜索');
  assert.ok(fake.state.searchCalls[0].query.includes('帮我查一下今天的新闻'));
  assert.ok(fake.state.lastSystemText.includes('外部资料（仅供你参考，不要照读）'));
  assert.ok(fake.state.lastSystemText.includes('今日头条'));
  assert.ok(fake.state.lastSystemText.includes('https://example.com/news/1'));
  assert.equal(chat.getSearchNotices().length, 0, '有 key 时不应提示配置缺失');

  const usage = get("SELECT COUNT(*) AS c FROM usage_records WHERE user_id = ? AND kind = 'search'", user);
  assert.ok(usage.c >= 1, '应记录 kind=search 的用量');
});

// ---------------- 上下文压缩 ----------------

test('chat: ≥85% 回复后压缩，压缩期间排队并提示，压缩完成处理排队消息', { timeout: 20_000 }, async () => {
  const character = freshCharacter();
  const fake = fakeProvider();
  chat.setChatProvider(fake.provider);
  const content = '聊'.repeat(100); // 中文 ≈ 90 tokens
  const userTokens = context.estimateTextTokens(content);
  const replyTokens = context.estimateTextTokens('我在呢');
  // 让「用户消息」低于 85%、加上回复后越过 85%
  const limit = Math.ceil((userTokens + replyTokens / 2) / 0.85);
  savePrefs(userId, { contextLimits: { [character.id]: limit } });

  const first = await chat.submitUserMessage({ userId, characterId: character.id, content });
  assert.equal(first.reason, 'generating', '提交时不应提前触发压缩');
  await first.waitForReply;

  const scheduled = pendingJobs(character.id, 'context_compress');
  assert.equal(scheduled.length, 1, '回复完成后应排压缩任务');
  const conv = context.ensureMainConversation(userId, character.id);
  assert.equal(context.isCompressing(conv.id), true);

  const queued = await chat.submitUserMessage({ userId, characterId: character.id, content: '压缩的时候我说话会被排队吧' });
  assert.equal(queued.accepted, true);
  assert.equal(queued.queued, true);
  assert.equal(queued.notice, '在回味之前的记忆喵~');
  assert.equal(queued.reason, 'compressing');

  makeDue(character.id, 'context_compress');
  const tickOut = await scheduler.tick({ sweep: false });
  assert.ok(tickOut.processed >= 1);
  await waitFor(() => {
    const agentRows = all("SELECT * FROM messages WHERE character_id = ? AND role = 'agent'", character.id);
    return agentRows.filter((r) => decryptText(userId, r.content).includes('我在呢')).length >= 2;
  });

  const convRow = get('SELECT * FROM conversations WHERE id = ?', conv.id);
  assert.ok(convRow.summary, '压缩后应写入摘要');
  assert.ok(convRow.compressed_at);
  const summary = decryptText(userId, convRow.summary);
  assert.ok(summary.includes('摘要'), '假 provider 的摘要应被写入');
  assert.equal(context.isCompressing(conv.id), false);

  // 摘要 + 最近消息的占用应低于压缩前
  const info = chat.getContextInfo(userId, character.id);
  assert.ok(info.used < userTokens + replyTokens + context.estimateTextTokens('压缩的时候我说话会被排队吧'), '压缩后有效上下文应下降');
  savePrefs(userId, { contextLimits: {} });
});

// ---------------- 主动回复与唤醒 ----------------

test('active: 等待期超时喂「用户未回复」，不追问则安排下一次主动消息', { timeout: 20_000 }, async () => {
  const character = freshCharacter();
  const fake = fakeProvider();
  chat.setChatProvider(fake.provider);

  const out = await chat.submitUserMessage({ userId, characterId: character.id, content: '我先去忙了' });
  await out.waitForReply;

  const ws = active.getWaitState(userId, character.id);
  run('UPDATE wait_states SET deadline = ? WHERE user_id = ? AND character_id = ?', new Date(Date.now() - 1000).toISOString(), userId, character.id);
  makeDue(character.id, 'active_reply');
  const tickOut = await scheduler.tick({ sweep: false });
  assert.ok(tickOut.processed >= 1);

  const subjectiveJobs = pendingJobs(character.id, 'active_reply');
  assert.equal(subjectiveJobs.length, 1, '模型选择不追问时应安排下一次主动消息');
  const payload = jobPayload(subjectiveJobs[0]);
  assert.equal(payload.kind, 'subjective');
  assert.equal(payload.content, '下一次主动消息');
  assert.ok(payload.sendsec >= 60);

  // 到点发送主动消息
  makeDue(character.id, 'active_reply');
  await scheduler.tick({ sweep: false });
  await waitFor(() => all("SELECT * FROM messages WHERE character_id = ? AND role = 'agent'", character.id)
    .some((r) => decryptText(userId, r.content) === '下一次主动消息'));
  const afterSend = active.getWaitState(userId, character.id);
  assert.equal(afterSend.mode, 'waiting', '主动消息发出后重新进入等待期');
  assert.ok(ws.last_agent_at);
});

test('active: 用户发消息取消等待期；POST active-reply 立即生成主动消息', async () => {
  const character = freshCharacter();
  const fake = fakeProvider();
  chat.setChatProvider(fake.provider);

  const out = await chat.submitUserMessage({ userId, characterId: character.id, content: '在吗' });
  await out.waitForReply;
  assert.equal(active.getWaitState(userId, character.id).mode, 'waiting');

  const again = await chat.submitUserMessage({ userId, characterId: character.id, content: '我又来了' });
  await again.waitForReply;
  assert.equal(pendingJobs(character.id, 'active_reply').length, 1, '新消息后只保留最新等待期任务');

  const activeOut = await active.triggerActiveReply({ userId, characterId: character.id });
  assert.equal(activeOut.ok, true);
  assert.ok(activeOut.sent || activeOut.parsed);
  const rows = all("SELECT * FROM messages WHERE character_id = ? AND role = 'agent'", character.id);
  assert.ok(rows.some((r) => decryptText(userId, r.content).includes('我突然想起你啦')));
});

test('active: 角色午睡时拒绝发送并返回固定文案，wakeup=1 后调整状态并回复', async () => {
  const character = freshCharacter();
  const fake = fakeProvider();
  chat.setChatProvider(fake.provider);

  // 构造覆盖当前 UTC+8 时刻的睡眠窗口
  const parts = status.tzParts(new Date());
  const pad = (n) => String(n).padStart(2, '0');
  const startMin = (parts.minutesOfDay - 60 + 1440) % 1440;
  const endMin = (parts.minutesOfDay + 60) % 1440;
  const window = { enabled: true, start: `${pad(Math.floor(startMin / 60))}:${pad(startMin % 60)}`, end: `${pad(Math.floor(endMin / 60))}:${pad(endMin % 60)}`, napStart: '00:00', napEnd: '00:00' };
  updateCharacter(userId, character.id, { settings: { sleep: window } });
  const refreshed = getCharacter(userId, character.id);
  assert.equal(status.sleepMode(refreshed.settings, new Date()).mode, 'sleep');

  const out = await chat.submitUserMessage({ userId, characterId: character.id, content: '睡了吗' });
  assert.equal(out.accepted, false);
  assert.equal(out.reason, 'sleep');
  assert.ok(out.notice.includes('夜深了，明天再来找他/她吧，你也要早点睡哦'));
  assert.ok(out.notice.includes('若强行叫醒的话，可能会带来不必要的麻烦哦'));
  assert.equal(out.userMessage.content, '睡了吗');

  // 模型判断可以叫醒 → 调整状态并生成回复
  assert.equal(out.wakeJobId != null, true);
  makeDue(character.id, 'wake_judge');
  await scheduler.tick({ sweep: false });
  await waitFor(() => {
    const stateRow = ensureState(character.id, userId);
    const agentRows = all("SELECT * FROM messages WHERE character_id = ? AND role = 'agent'", character.id);
    return stateRow.sleep_state === 'awake_override' && agentRows.length > 0;
  });
  const agent = lastAgentMessage(character.id);
  assert.ok(agent.plain.includes('我醒了'));
  assert.equal(status.effectiveSleep(getCharacter(userId, character.id), ensureState(character.id, userId), new Date()).mode, 'awake');
});

test('limits: 硬限额拒绝主会话并提示；软限额只影响状态刷新频率', async () => {
  const character = freshCharacter();
  const fake = fakeProvider();
  chat.setChatProvider(fake.provider);
  savePrefs(userId, { limits: { hardTokens: 1, softTokens: 0 } });
  recordUsage({ userId, characterId: character.id, kind: 'main', model: 'fake-main', usage: { input: 100, output: 0 }, cost: 0 });

  const out = await chat.submitUserMessage({ userId, characterId: character.id, content: '在吗' });
  assert.equal(out.accepted, false);
  assert.equal(out.reason, 'hard_limit');
  assert.ok(out.notice.includes('Token 已达硬性限额'));

  savePrefs(userId, { limits: { hardTokens: 0, softTokens: 1 } });
  const limits = context.limitState(userId);
  assert.equal(limits.hardLimited, false);
  assert.equal(limits.softLimited, true);
  const scheduled = status.scheduleStatusRefresh({ userId, characterId: character.id });
  assert.equal(scheduled.delayMs, 4 * 3600_000, '软限额下状态刷新应降为 4 小时');
  savePrefs(userId, { limits: { hardTokens: 0, softTokens: 0 } });
});

test('scheduler: 未知任务类型不崩溃，动态记忆线模块缺失时跳过', { timeout: 20_000 }, async () => {
  const jobId = enqueue('unknown_type_xyz', new Date(Date.now() - 1000).toISOString(), {}, { userId });
  const [job] = all('SELECT * FROM jobs WHERE id = ?', jobId);
  const out = await scheduler.dispatchJob(job);
  assert.equal(out.status, 'skipped');
  assert.equal(get('SELECT status FROM jobs WHERE id = ?', jobId).status, 'skipped');

  const portraitJob = enqueue('portrait_run', new Date(Date.now() - 1000).toISOString(), {}, { userId });
  const [pjob] = all('SELECT * FROM jobs WHERE id = ?', portraitJob);
  const pout = await scheduler.dispatchJob(pjob);
  assert.ok(['done', 'skipped', 'failed'].includes(pout.status));

  scheduler.startScheduler({ intervalMs: 60_000 });
  const timer = scheduler.startScheduler({ intervalMs: 60_000 });
  assert.ok(timer);
  await waitFor(() => scheduler.schedulerState().ticking === false, { timeout: 5_000 });
  scheduler.stopScheduler();
  assert.equal(scheduler.schedulerState().running, false);
});

// ---------------- 周期任务补排（记忆线接线） ----------------

test('scheduler: 周期任务补排 portrait/news_read/creation，且同类型 pending 去重', async () => {
  const character = freshCharacter();
  // 画像条件：累计 200 次对话（portraitDue 内部判定）
  updateState(character.id, { chatCount: 200, chatSincePortrait: 200 });

  const out = await scheduler.bootstrapPeriodicJobs();
  assert.ok(out.characters >= 1);

  const pending = all(
    "SELECT * FROM jobs WHERE character_id = ? AND status = 'pending'",
    character.id,
  );
  const types = pending.map((j) => j.type);
  assert.ok(types.includes('portrait'), '满足 200 次对话后应排画像任务');
  assert.ok(types.includes('news_read'), '应排新闻任务');
  assert.ok(types.includes('creation'), '应排创作任务');

  // 当天没有日记 → 必须优先排日记
  const creation = pending.find((j) => j.type === 'creation');
  const creationPayload = jobPayload(creation);
  assert.equal(creationPayload.type, 'diary', '当天缺日记时应优先日记，不能被小说挤掉');
  const due = new Date(creation.due_at);
  const nowMs = Date.now();
  const diaryAt = scheduler.todayUtc8At(22, 30, nowMs);
  if (diaryAt > nowMs) {
    assert.equal((due.getUTCHours() + 8) % 24, 22, '日记应排在 UTC+8 22:30');
    assert.equal(due.getUTCMinutes(), 30);
  } else {
    assert.ok(due.getTime() <= nowMs + 60_000, '当天 22:30 已过且缺日记时应立即补跑');
  }

  // 模拟当天日记已写：释放创作任务后应改排小说（daily → 20:00）
  run("UPDATE jobs SET status = 'cancelled' WHERE character_id = ? AND type = 'creation' AND status = 'pending'", character.id);
  run(
    'INSERT INTO books(id, user_id, character_id, type, title, content, day, meta, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    'bk_test_diary',
    userId,
    character.id,
    'diary',
    '今日日记',
    encryptText(userId, '今天很开心'),
    dayKey(),
    null,
    nowIso(),
    nowIso(),
  );
  await scheduler.bootstrapPeriodicJobs();
  const creation2 = all(
    "SELECT * FROM jobs WHERE character_id = ? AND type = 'creation' AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
    character.id,
  )[0];
  assert.ok(creation2, '日记已存在时应排小说任务');
  assert.equal(jobPayload(creation2).type, 'novel');
  const novelDue = new Date(creation2.due_at);
  assert.equal((novelDue.getUTCHours() + 8) % 24, 20, 'daily 小说应排在 UTC+8 20:00');
  assert.equal(novelDue.getUTCMinutes(), 0);

  const news = pending.find((j) => j.type === 'news_read');
  assert.ok(Date.parse(news.due_at) > Date.now() - 60_000);

  // 去重：再次巡检不应重复入队
  await scheduler.bootstrapPeriodicJobs();
  const pendingAgain = all(
    "SELECT type FROM jobs WHERE character_id = ? AND status = 'pending'",
    character.id,
  );
  for (const type of ['portrait', 'news_read', 'creation']) {
    assert.equal(pendingAgain.filter((j) => j.type === type).length, 1, `${type} 应只有一条 pending`);
  }

  // 不执行这些任务（会访问外网/模型），直接取消
  run("UPDATE jobs SET status = 'cancelled' WHERE character_id = ? AND status = 'pending'", character.id);
});

// ---------------- HTTP 路由（双前缀） ----------------

test('routes: /api/chat 与 /api/characters 双前缀、鉴权、历史/上下文/主动/唤醒', { timeout: 20_000 }, async () => {
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/chat', chatRoutes());
  app.use('/api/characters', chatRoutes());
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({ error: { code: err.code || 'internal_error', message: err.message } });
  });

  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.listen(Number(process.env.PORT) || 18082, '127.0.0.1', resolve);
    server.on('error', reject);
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const token = signToken({ uid: userId, role: 'user' });
  run(
    'INSERT INTO auth_tokens(token_hash, user_id, created_at, expires_at) VALUES(?,?,?,?)',
    sha256(token),
    userId,
    nowIso(),
    new Date(Date.now() + 3600_000).toISOString(),
  );
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Connection: 'close' };

  try {
    const character = freshCharacter();
    const fake = fakeProvider();
    chat.setChatProvider(fake.provider);
    savePrefs(userId, { contextLimits: {} });

    // 未鉴权
    const unauth = await fetch(`${base}/api/chat/${character.id}/context`);
    assert.equal(unauth.status, 401);

    // 发送消息（双前缀都可用）
    const send = await fetch(`${base}/api/characters/${character.id}/messages`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ kind: 'text', text: '在吗', meta: { clientTs: 'x' } }),
    });
    assert.equal(send.status, 201);
    const sent = await send.json();
    assert.equal(sent.accepted, true);
    assert.equal(sent.queued, false);
    assert.equal(sent.notice, null);
    assert.equal(sent.userMessage.content, '在吗');

    const sendChatPrefix = await fetch(`${base}/api/chat/${character.id}/messages`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ kind: 'text', text: '第二条' }),
    });
    assert.equal(sendChatPrefix.status, 201);
    await (await sendChatPrefix.json()).userMessage;

    await waitFor(() => all("SELECT id FROM messages WHERE character_id = ? AND role = 'agent'", character.id).length >= 2);

    // 历史
    const history = await fetch(`${base}/api/characters/${character.id}/messages?limit=10`, { headers: auth });
    assert.equal(history.status, 200);
    const hist = await history.json();
    assert.ok(Array.isArray(hist.items));
    assert.ok(hist.items.length >= 2);
    assert.ok(hist.items.every((m) => typeof m.content === 'string' && !m.content.startsWith('c2.')));
    const times = hist.items.map((m) => new Date(m.createdAt).getTime());
    assert.deepEqual(times, [...times].sort((a, b) => a - b), '历史应按时间正序');

    // 上下文
    const ctx = await fetch(`${base}/api/chat/${character.id}/context`, { headers: auth });
    assert.equal(ctx.status, 200);
    const ctxBody = await ctx.json();
    assert.equal(typeof ctxBody.used, 'number');
    assert.equal(typeof ctxBody.limit, 'number');
    assert.equal(typeof ctxBody.percent, 'number');
    assert.equal(ctxBody.compressing, false);

    // 主动回复
    const activeRes = await fetch(`${base}/api/characters/${character.id}/active-reply`, { method: 'POST', headers: auth });
    assert.equal(activeRes.status, 200);
    const activeBody = await activeRes.json();
    assert.equal(activeBody.ok, true);

    // 唤醒（清醒状态直接 wakeup=1）
    const wakeRes = await fetch(`${base}/api/chat/${character.id}/wake`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ text: '醒醒' }),
    });
    assert.equal(wakeRes.status, 200);
    const wakeBody = await wakeRes.json();
    assert.equal(wakeBody.ok, true);
    assert.equal(wakeBody.wakeup, 1);

    // 越权：别人的角色
    const otherCharacter = createCharacter(otherUserId, { name: '别人家的' });
    const forbidden = await fetch(`${base}/api/characters/${otherCharacter.id}/context`, { headers: auth });
    assert.equal(forbidden.status, 404);

    // 空消息 400
    const empty = await fetch(`${base}/api/characters/${character.id}/messages`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ kind: 'text', text: '   ' }),
    });
    assert.equal(empty.status, 400);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---------------- OneBot ----------------

test('onebot: 未注册 QQ / 缺配置 / 正常消息返回同步文本', { timeout: 20_000 }, async () => {
  chat.setChatProvider(fakeProvider().provider);

  const unregistered = await chat.handleOnebotIncoming({ qq: '999999', text: '在吗' });
  assert.equal(unregistered.ok, true);
  assert.equal(unregistered.reply, '账号未注册，花名册上没有主人的大名哦~');

  const noKeyUser = 'u_ai_chat_onebot';
  seedUser(noKeyUser, '20001');
  const character = createCharacter(noKeyUser, { name: 'QQ角色', relation: '朋友' });
  updateCharacter(noKeyUser, character.id, { settings: { sleep: { enabled: false } } });
  const missing = await chat.handleOnebotIncoming({ qq: '20001', text: '在吗' });
  assert.equal(missing.ok, true);
  assert.ok(missing.reply.includes('还未设置哦，请前往 Cocoa 进行配置'));

  saveUserApi(noKeyUser, { chat: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-test', model: 'gpt-4o-mini' } });
  const ok = await chat.handleOnebotIncoming({ qq: '20001', text: '在吗' });
  assert.equal(ok.ok, true);
  assert.equal(ok.reply, '我在呢');
});

// ---------------- 收尾 ----------------

after(async () => {
  chat.setChatProvider(null);
  chat.resetRuntime();
  context.clearCompressing();
  scheduler.stopScheduler();
  run("UPDATE jobs SET status = 'cancelled' WHERE status = 'pending'");
});
