// Cocoa 端到端冒烟：真实 HTTP + WS + 假 OpenAI 服务，无需外部 API Key
// 用法: node server/test/smoke.mjs
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createMockOpenAI } from './mock-openai.mjs';

const DATA_ROOT = '/data/dsh/home/.tmp';
fs.mkdirSync(DATA_ROOT, { recursive: true });
const DATA_DIR = fs.mkdtempSync(path.join(DATA_ROOT, 'cocoa-smoke-'));
process.env.COCOA_DATA_DIR = DATA_DIR;
process.env.COCOA_LOG_LEVEL = process.env.COCOA_LOG_LEVEL || 'error';
process.env.COCOA_ADMIN_EMAIL = 'admin@cocoa.test';
process.env.COCOA_ADMIN_PASSWORD = 'Admin123456';
process.env.COCOA_ALLOW_REGISTER = '1';

const results = [];
function record(name, status, detail = '') {
  results.push({ name, status, detail });
  const icon = status === 'PASS' ? '✔' : status === 'SKIP' ? '○' : '✘';
  console.log(`${icon} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function step(name, fn) {
  try {
    const detail = await fn();
    record(name, 'PASS', typeof detail === 'string' ? detail : '');
  } catch (err) {
    if (err?.skip) record(name, 'SKIP', err.message);
    else record(name, 'FAIL', err.message);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function skip(msg) {
  const e = new Error(msg);
  e.skip = true;
  throw e;
}

const mock = await createMockOpenAI();
const http = await import('node:http');
const { createApp } = await import('../src/app.js');
const { attachWebSocket } = await import('../src/realtime/hub.js');
const { ensureBootstrapAdmin } = await import('../src/services/bootstrap.js');
const { get, all } = await import('../src/db/index.js');
const { decryptJson } = await import('../src/core/crypto.js');
ensureBootstrapAdmin();

const app = createApp();
const server = http.createServer(app);
attachWebSocket(server, '/ws');
server.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

const state = { token: null, adminToken: null, characterId: null };

async function api(pathname, { method = 'GET', body, token, raw = false } = {}) {
  const res = await fetch(base + pathname, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (res.status === 501) skip(`${pathname} 尚未实现`);
  return { status: res.status, json, text, headers: res.headers };
}

async function openWs() {
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws?token=${encodeURIComponent(state.token)}`);
  const queue = [];
  const waiters = [];
  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(String(buf)); } catch { return; }
    queue.push(msg);
    if (process.env.DEBUG_WS) console.log('WS>', JSON.stringify(msg).slice(0, 200));
    for (const w of [...waiters]) {
      if (w.predicate(msg)) {
        clearTimeout(w.timer);
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  // 等待服务端 ready，确保后续广播不会早于订阅
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS ready 超时')), 5000);
    const check = setInterval(() => {
      const hit = queue.find((m) => m.type === 'ready');
      if (hit) { clearInterval(check); clearTimeout(timer); resolve(); }
    }, 20);
  });
  return {
    ws,
    waitFor(predicate, timeoutMs = 40_000) {
      const hit = queue.find(predicate);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('等待 WS 事件超时')), timeoutMs);
        waiters.push({ predicate, resolve, timer });
      });
    },
    close: () => ws.close(),
  };
}

try {
  await step('健康检查', async () => {
    const r = await api('/api/health');
    assert(r.status === 200 && r.json.ok, 'health 非 200');
    return `v${r.json.version}`;
  });

  await step('发送注册验证码', async () => {
    const r = await api('/api/auth/send-code', { method: 'POST', body: { email: 'smoke@cocoa.test', purpose: 'register' } });
    assert(r.status === 200, JSON.stringify(r.json));
    assert(/^\d{6}$/.test(r.json.devCode || ''), '未拿到开发验证码');
    state.code = r.json.devCode;
    return 'devCode 已获取';
  });

  await step('注册并登录', async () => {
    const r = await api('/api/auth/register', {
      method: 'POST',
      body: {
        username: 'smoke', email: 'smoke@cocoa.test', password: 'Passw0rd!',
        confirmPassword: 'Passw0rd!', qq: '123456789', code: state.code,
      },
    });
    assert(r.status === 201, JSON.stringify(r.json));
    state.token = r.json.token;
    const me = await api('/api/auth/me', { token: state.token });
    assert(me.status === 200 && me.json.user.qq === '123456789', 'me 异常');
    return state.token ? 'token 已签发' : '';
  });

  await step('管理员登录', async () => {
    const r = await api('/api/auth/login', { method: 'POST', body: { identifier: 'admin@cocoa.test', mode: 'password', password: 'Admin123456' } });
    assert(r.status === 200, JSON.stringify(r.json));
    state.adminToken = r.json.token;
    return r.json.user.role;
  });

  await step('保存模型配置（指向本地 mock）', async () => {
    const r = await api('/api/config/api', {
      method: 'PUT',
      token: state.token,
      body: {
        chat: { baseUrl: mock.baseUrl, apiKey: 'sk-mock-key', model: 'gpt-4o-mini' },
        embedding: { baseUrl: mock.baseUrl, apiKey: 'sk-mock-key', model: 'text-embedding-3-small' },
        deepseek: { baseUrl: mock.baseUrl, apiKey: 'sk-mock-key', model: 'deepseek-chat' },
        stt: { baseUrl: mock.baseUrl, apiKey: 'sk-mock-key', model: 'whisper-1' },
        tts: { baseUrl: mock.baseUrl, apiKey: 'sk-mock-key', model: 'tts-1' },
        search: { baseUrl: mock.baseUrl, apiKey: 'sk-mock-key', model: 'deepseek-chat' },
      },
    });
    assert(r.status === 200 && r.json.api.chat.apiKeySet, JSON.stringify(r.json));
    return 'key 已保存（响应已脱敏）';
  });

  await step('模型列表与能力标记', async () => {
    const r = await api('/api/config/models', { method: 'POST', token: state.token, body: { service: 'chat' } });
    assert(r.status === 200 && r.json.models.length > 0, JSON.stringify(r.json).slice(0, 200));
    const mini = r.json.models.find((m) => m.id === 'gpt-4o-mini');
    assert(mini && Array.isArray(mini.modalities), '缺少 modalities');
    return `${r.json.models.length} 个模型 / ${mini.modalities.join(',')} / ctx ${mini.contextWindow}`;
  });

  await step('连接测试', async () => {
    const r = await api('/api/config/test', { method: 'POST', token: state.token, body: { service: 'chat' } });
    assert(r.status === 200 && r.json.ok, JSON.stringify(r.json));
    return `${r.json.latencyMs}ms`;
  });

  await step('创建角色', async () => {
    const r = await api('/api/characters', {
      method: 'POST',
      token: state.token,
      body: {
        name: '可可', age: '21', race: '人类', gender: '女',
        personality: '温柔而有点小倔强', worldview: '现代都市的深夜咖啡店',
        hobbies: '烘焙、听黑胶', relation: '住在隔壁的青梅竹马',
        appearance: '栗色长发', occupation: '咖啡店店长',
      },
    });
    assert(r.status === 201 || r.status === 200, `${r.status} ${JSON.stringify(r.json)}`);
    const ch = r.json.character || r.json;
    assert(ch.id, '缺少角色 id');
    state.characterId = ch.id;
    return ch.id;
  });

  await step('便捷生成人设（expand）', async () => {
    const r = await api('/api/characters/expand', { method: 'POST', token: state.token, body: { prompt: '温柔的女店长' } });
    assert(r.status === 200, JSON.stringify(r.json));
    const p = r.json.profile || r.json;
    assert(p.name || p.personality, '扩写结果为空');
    return Object.keys(p).join(',');
  });

  await step('发送消息并收到智能体回复（WS）', async () => {
    const socket = await openWs();
    try {
      const reply = socket.waitFor((m) => m.type === 'message' && m.message?.role === 'agent', 150_000);
      const send = await api(`/api/characters/${state.characterId}/messages`, {
        method: 'POST', token: state.token, body: { kind: 'text', text: '在吗？今天有点累。' },
      });
      assert([200, 201].includes(send.status), JSON.stringify(send.json));
      if (send.json.notice) return `提示：${send.json.notice}`;
      const event = await reply;
      state.agentMessage = event.message;
      return (event.message.content || '').slice(0, 30);
    } finally {
      socket.close();
    }
  });

  await step('历史消息', async () => {
    const r = await api(`/api/characters/${state.characterId}/messages?limit=50`, { token: state.token });
    assert(r.status === 200, JSON.stringify(r.json));
    const list = r.json.messages || r.json.items || r.json;
    assert(Array.isArray(list) && list.length >= 1, '历史为空');
    assert(list.some((m) => m.role === 'user'), '缺少用户消息');
    return `${list.length} 条`;
  });

  await step('上下文占用', async () => {
    const r = await api(`/api/characters/${state.characterId}/context`, { token: state.token });
    assert(r.status === 200, JSON.stringify(r.json));
    assert(typeof r.json.used === 'number' && typeof r.json.limit === 'number', '字段缺失');
    return `used=${r.json.used} limit=${r.json.limit}`;
  });

  await step('记忆图谱', async () => {
    const r = await api(`/api/memory/graph?characterId=${state.characterId}`, { token: state.token });
    assert(r.status === 200, JSON.stringify(r.json));
    const nodes = r.json.nodes || [];
    assert(nodes.some((n) => n.type === 'agent'), '缺少 agent 节点');
    const memories = nodes.filter((n) => n.type === 'memory');
    if (memories.length) {
      assert(nodes.some((n) => n.type === 'category'), '有记忆点但缺少类目节点');
      assert(memories.every((n) => n.type === 'memory' && (n.brightness ?? n.weight) >= 0), '记忆点缺少亮度');
    }
    return `${nodes.length} 节点（记忆 ${memories.length}） / ${(r.json.links || []).length} 连线`;
  });

  await step('日记锁状态', async () => {
    const r = await api(`/api/books/diary/lock-status?characterId=${state.characterId}`, { token: state.token });
    assert(r.status === 200, JSON.stringify(r.json));
    return r.json.hint ? '已生成线索' : '无线索';
  });

  await step('日记错误密码被拒', async () => {
    const r = await api('/api/books/diary/unlock', { method: 'POST', token: state.token, body: { characterId: state.characterId, password: '000000' } });
    assert(r.status === 400 || r.status === 401 || r.status === 403, `居然放行了: ${r.status}`);
    return `HTTP ${r.status}`;
  });

  await step('书架列表', async () => {
    const r = await api(`/api/books?characterId=${state.characterId}`, { token: state.token });
    assert(r.status === 200, JSON.stringify(r.json));
    const list = r.json.books || r.json.items || r.json;
    assert(Array.isArray(list), '返回不是数组');
    return `${list.length} 本`;
  });

  await step('用量统计', async () => {
    const r = await api(`/api/stats/usage?range=7d`, { token: state.token });
    assert(r.status === 200, JSON.stringify(r.json));
    assert(r.json.totals && typeof r.json.totals.cost === 'number', 'totals 缺失');
    assert(Array.isArray(r.json.series), 'series 缺失');
    return `total=${r.json.totals.total} cost=${r.json.totals.cost}`;
  });

  await step('统计概览', async () => {
    const r = await api(`/api/stats/overview?characterId=${state.characterId}`, { token: state.token });
    assert(r.status === 200, JSON.stringify(r.json));
    return JSON.stringify(r.json).slice(0, 120);
  });

  await step('管理端概览', async () => {
    const r = await api('/api/admin/overview', { token: state.adminToken });
    assert(r.status === 200, JSON.stringify(r.json));
    return JSON.stringify(r.json).slice(0, 120);
  });

  await step('普通用户禁止访问管理端', async () => {
    const r = await api('/api/admin/overview', { token: state.token });
    assert(r.status === 403, `期望 403，实际 ${r.status}`);
    return '403';
  });

  await step('OneBot 未注册 QQ 文案', async () => {
    const r = await api('/onebot/event', {
      method: 'POST',
      body: { post_type: 'message', message_type: 'private', user_id: 99999999, raw_message: '你好', self_id: 1000000 },
    });
    assert(r.status === 200, JSON.stringify(r.json));
    const text = JSON.stringify(r.json);
    assert(text.includes('账号未注册') || text.includes('花名册'), `文案不符：${text.slice(0, 160)}`);
    return '文案正确';
  });

  await step('数据落盘与加密', async () => {
    const row = get('SELECT content FROM messages WHERE character_id = ? LIMIT 1', state.characterId);
    if (!row) skip('无消息');
    assert(String(row.content).startsWith('c2.'), '消息未加密存储');
    const ch = get('SELECT name FROM characters WHERE id = ?', state.characterId);
    assert(String(ch.name).startsWith('c2.'), '人设未加密存储');
    return 'message/character 均为 c2. 密文';
  });
} finally {
  const failed = results.filter((r) => r.status === 'FAIL');
  const passed = results.filter((r) => r.status === 'PASS').length;
  const skipped = results.filter((r) => r.status === 'SKIP').length;
  console.log(`\n结果：${passed} 通过 / ${failed.length} 失败 / ${skipped} 跳过`);
  if (failed.length) {
    for (const f of failed) console.log(`  ✘ ${f.name}: ${f.detail}`);
  }
  server.close();
  await mock.close();
  if (!process.env.KEEP_DATA) { try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {} } else { console.log('数据保留:', DATA_DIR); }
  process.exit(failed.length ? 1 : 0);
}
