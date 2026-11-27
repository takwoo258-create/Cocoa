// v2.0.0 对话等待参数单测：默认值回归需求书（30s / 60–80s）＋角色级可配置
// 运行：node --test server/test/dialogue-timing.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.COCOA_DATA_DIR = process.env.COCOA_DATA_DIR || '/tmp/cocoa-dialogue-timing';
process.env.PORT = process.env.PORT || '18091';
process.env.COCOA_LOG_LEVEL = 'error';
fs.rmSync(process.env.COCOA_DATA_DIR, { recursive: true, force: true });

const { run, get } = await import('../src/db/index.js');
const { nowIso } = await import('../src/core/util.js');
const { createCharacter, getSettings, saveSettings } = await import('../src/services/characters.js');
const sentence = await import('../src/ai/sentence.js');
const active = await import('../src/ai/active.js');

const userId = 'u_dialogue_timing';
if (!get('SELECT id FROM users WHERE id = ?', userId)) {
  run(
    'INSERT INTO users(id, username, email, password_hash, password_salt, created_at) VALUES(?,?,?,?,?,?)',
    userId, userId, `${userId}@example.com`, 'hash', 'salt', nowIso(),
  );
}

test('默认值回归需求书：碎片等待 30s、总上限 60s', () => {
  assert.equal(sentence.SENTENCE_WAIT_MS, 30_000);
  assert.equal(sentence.SENTENCE_MAX_WAIT_MS, 60_000);
});

test('默认值回归需求书：主动等待 60–80s', () => {
  assert.equal(active.WAIT_MIN_MS, 60_000);
  assert.equal(active.WAIT_MAX_MS, 80_000);
  assert.equal(active.nextWaitMs(() => 0), 60_000);
  assert.equal(active.nextWaitMs(() => 1), 80_000);
  assert.equal(active.nextWaitMs(() => 0.5), 70_000);
});

test('sentenceWaitDueMs：默认 30s，连续输入受 60s 总上限约束', () => {
  const now = 1_000_000;
  assert.equal(sentence.sentenceWaitDueMs({ now, firstAt: null }), now + 30_000);
  assert.equal(sentence.sentenceWaitDueMs({ now, firstAt: now - 10_000 }), now + 30_000);
  // 首条碎片起算已 40s：剩余只允许 20s
  assert.equal(sentence.sentenceWaitDueMs({ now, firstAt: now - 40_000 }), now + 20_000);
  // 已超过总上限：不再等待
  assert.equal(sentence.sentenceWaitDueMs({ now, firstAt: now - 70_000 }), now - 10_000);
});

test('sentenceWaitDueMs：支持自定义等待与总上限', () => {
  const now = 1_000_000;
  assert.equal(
    sentence.sentenceWaitDueMs({ now, firstAt: null, waitMs: 10_000, maxWaitMs: 20_000 }),
    now + 10_000,
  );
  assert.equal(
    sentence.sentenceWaitDueMs({ now, firstAt: now - 15_000, waitMs: 10_000, maxWaitMs: 20_000 }),
    now + 5_000,
  );
});

test('sentenceTiming：从角色 settings.dialogue 推导等待参数并钳制', () => {
  assert.deepEqual(sentence.sentenceTiming(null), { waitMs: 30_000, maxWaitMs: 60_000 });
  assert.deepEqual(sentence.sentenceTiming({}), { waitMs: 30_000, maxWaitMs: 60_000 });
  assert.deepEqual(
    sentence.sentenceTiming({ dialogue: { sentenceWaitSec: 10 } }),
    { waitMs: 10_000, maxWaitMs: 20_000 },
  );
  assert.deepEqual(
    sentence.sentenceTiming({ dialogue: { sentenceWaitSec: 10, sentenceMaxWaitSec: 45 } }),
    { waitMs: 10_000, maxWaitMs: 45_000 },
  );
  // 钳制：3–120 秒；总上限不低于单段等待
  assert.deepEqual(
    sentence.sentenceTiming({ dialogue: { sentenceWaitSec: 1 } }),
    { waitMs: 3_000, maxWaitMs: 6_000 },
  );
  assert.deepEqual(
    sentence.sentenceTiming({ dialogue: { sentenceWaitSec: 500 } }),
    { waitMs: 120_000, maxWaitMs: 240_000 },
  );
  assert.deepEqual(
    sentence.sentenceTiming({ dialogue: { sentenceWaitSec: 20, sentenceMaxWaitSec: 5 } }),
    { waitMs: 20_000, maxWaitMs: 20_000 },
  );
});

test('activeWaitRange：从角色 settings.dialogue 推导区间并钳制', () => {
  assert.deepEqual(active.activeWaitRange(null), { minMs: 60_000, maxMs: 80_000 });
  assert.deepEqual(
    active.activeWaitRange({ dialogue: { activeWaitMinSec: 45, activeWaitMaxSec: 90 } }),
    { minMs: 45_000, maxMs: 90_000 },
  );
  // 钳制 30–600；min>max 时交换
  assert.deepEqual(
    active.activeWaitRange({ dialogue: { activeWaitMinSec: 5, activeWaitMaxSec: 9000 } }),
    { minMs: 30_000, maxMs: 600_000 },
  );
  assert.deepEqual(
    active.activeWaitRange({ dialogue: { activeWaitMinSec: 120, activeWaitMaxSec: 60 } }),
    { minMs: 60_000, maxMs: 120_000 },
  );
  assert.equal(active.nextWaitMs(() => 0.5, { minMs: 45_000, maxMs: 90_000 }), 67_500);
});

test('角色设置：dialogue 默认值、合并与钳制', () => {
  const character = createCharacter(userId, { name: '等待测试', relation: '朋友' });
  const defaults = getSettings(character.id, userId);
  assert.deepEqual(defaults.dialogue, {
    sentenceWaitSec: 30, sentenceMaxWaitSec: 60, activeWaitMinSec: 60, activeWaitMaxSec: 80,
  });
  const saved = saveSettings(character.id, userId, { dialogue: { sentenceWaitSec: 15 } });
  assert.equal(saved.dialogue.sentenceWaitSec, 15);
  assert.equal(saved.dialogue.sentenceMaxWaitSec, 60); // 未指定时保留
  assert.equal(saved.dialogue.activeWaitMinSec, 60);
  const clamped = saveSettings(character.id, userId, { dialogue: { sentenceWaitSec: 999, activeWaitMinSec: 10, activeWaitMaxSec: 99999 } });
  assert.equal(clamped.dialogue.sentenceWaitSec, 120);
  assert.equal(clamped.dialogue.activeWaitMinSec, 30);
  assert.equal(clamped.dialogue.activeWaitMaxSec, 600);
});