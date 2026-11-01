// 本地 OpenAI 兼容假服务：用于离线端到端测试（chat / embeddings / audio）
import http from 'node:http';

const REPLY_POOL = [
  '在呢，刚刚在给你热牛奶。',
  '嗯……你今天好像有点累，要不要靠过来一点？',
  '我记得你喜欢这个味道，特意多放了一点糖。',
  '别急，慢慢说，我在听。',
];

function estimateTokens(text) {
  const s = String(text ?? '');
  return Math.max(1, Math.ceil(s.length * 0.75));
}

function lastUserText(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content.map((c) => (c.type === 'text' ? c.text : '[图片]')).join(' ');
    }
  }
  return '';
}

function systemText(messages = []) {
  return messages.filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
}

function decide(messages) {
  const sys = systemText(messages);
  const user = lastUserText(messages);
  if (/句子完整性判断器/.test(sys) || /只允许回答 yes 或 no/.test(sys)) return 'yes';
  if (/角色设定扩写助手/.test(sys)) {
    return JSON.stringify({
      name: '可可', age: '21', race: '人类', gender: '女',
      personality: '温柔而有点小倔强，喜欢用食物表达关心',
      worldview: '现代都市，一家深夜营业的咖啡店',
      hobbies: '烘焙、听黑胶、收集杯子',
      relation: '住在隔壁的青梅竹马',
      appearance: '栗色长发，围裙口袋里总揣着一颗糖',
      occupation: '咖啡店店长',
    });
  }
  if (/内在状态生成器/.test(sys)) {
    return JSON.stringify({ type: 'status', motion: '（正在擦杯子）', psychology: '想着他今天会不会来', mood: '平静', health: '健康' });
  }
  if (/人物画像/.test(sys) || /二次提炼/.test(sys)) {
    return JSON.stringify({ type: 'profile', content: '用户偏爱安静的陪伴，习惯在深夜倾诉；对甜食没有抵抗力，讨厌被敷衍。' });
  }
  if (/用户特征抽取器/.test(sys)) {
    return JSON.stringify({ memories: [
      { big: '喜好', small: '食物', content: '用户喜欢吃辣，尤其火锅', weight: 0.82 },
      { big: '雷点', small: '沟通', content: '用户讨厌被已读不回', weight: 0.7 },
    ] });
  }
  if (/写今天的日记/.test(sys)) {
    return JSON.stringify({ title: '十月三十一日', content: '今天他来得比平时晚，我把牛奶热了两次。' });
  }
  if (/正在创作一篇小说/.test(sys)) {
    return JSON.stringify({ title: '杯子里的海', content: '她把最后一颗方糖放进杯底，听见门外风铃响了一声。' });
  }
  if (/主动找用户说话的时刻/.test(sys)) {
    return JSON.stringify({ type: 'subjective', content: '你那边下雨了吗？我留了灯。', sendsec: 20 });
  }
  if (/是否需要叫醒角色/.test(sys)) return JSON.stringify({ wakeup: 1 });
  if (/网页检索助手/.test(sys)) return JSON.stringify({ query: user, results: [{ title: '示例新闻', url: 'https://example.com', snippet: '示例摘要' }] });
  if (/刚浏览到这些新闻/.test(sys)) return JSON.stringify({ content: '看到这条新闻时，我忽然想给你发条消息。' });
  const reply = REPLY_POOL[Math.floor(Math.random() * REPLY_POOL.length)];
  // 偶尔分段，验证 wait 队列
  if (Math.random() < 0.25) {
    return JSON.stringify({ type: 'message', content: reply + '要喝点什么吗？', agent: [{ content: reply, wait: 1 }, { content: '要喝点什么吗？', wait: 2 }], devide: 2 });
  }
  return JSON.stringify({ type: 'message', content: reply });
}

function send(res, status, obj, headers = {}) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(body);
}

export function createMockOpenAI() {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname.replace(/^\/v1/, '');
      if (req.method === 'GET' && pathname === '/models') {
        return send(res, 200, {
          object: 'list',
          data: [
            { id: 'gpt-4o-mini', object: 'model', owned_by: 'mock', context_length: 128000 },
            { id: 'gpt-4o', object: 'model', owned_by: 'mock', context_length: 128000 },
            { id: 'deepseek-chat', object: 'model', owned_by: 'mock', context_length: 131072 },
            { id: 'custom-long', object: 'model', owned_by: 'mock', context_window: 64000 },
            { id: 'text-embedding-3-small', object: 'model', owned_by: 'mock' },
            { id: 'whisper-1', object: 'model', owned_by: 'mock' },
          ],
        });
      }
      if (req.method === 'POST' && pathname === '/chat/completions') {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch {}
        const content = decide(body.messages || []);
        const promptTokens = estimateTokens((body.messages || []).map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join(' '));
        const completionTokens = estimateTokens(content);
        return send(res, 200, {
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model || 'gpt-4o-mini',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
            prompt_tokens_details: { cached_tokens: Math.floor(promptTokens * 0.1) },
          },
        });
      }
      if (req.method === 'POST' && pathname === '/embeddings') {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch {}
        const input = Array.isArray(body.input) ? body.input : [body.input || ''];
        return send(res, 200, {
          object: 'list',
          model: body.model || 'text-embedding-3-small',
          data: input.map((text, index) => ({
            object: 'embedding',
            index,
            embedding: Array.from({ length: 16 }, (_, i) => {
              let h = 0;
              const s = String(text) + i;
              for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) % 1000;
              return (h / 1000) * 2 - 1;
            }),
          })),
          usage: { prompt_tokens: input.reduce((n, t) => n + estimateTokens(t), 0), total_tokens: 0 },
        });
      }
      if (req.method === 'POST' && pathname === '/audio/transcriptions') {
        return send(res, 200, { text: '这是语音转写的内容，我今天有点累。' });
      }
      if (req.method === 'POST' && pathname === '/audio/speech') {
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        return res.end(Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]));
      }
      return send(res, 404, { error: { message: `mock 不支持 ${req.method} ${url.pathname}` } });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, baseUrl: `http://127.0.0.1:${port}/v1`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const m = await createMockOpenAI();
  console.log(`mock OpenAI 已启动: ${m.baseUrl}`);
  process.on('SIGINT', async () => { await m.close(); process.exit(0); });
}
