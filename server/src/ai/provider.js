// OpenAI 兼容提供层：客户端缓存、模型列表、连通性测试、多模态/嵌入调用
import OpenAI from 'openai';
import fs from 'node:fs';
import path from 'node:path';
import { getUserApi, getPrefs } from '../services/settings.js';
import { describeModel, DEFAULT_MODELS, estimateCost } from './models.js';
import { AppError, badRequest, upstream } from '../core/errors.js';
import logger from '../core/logger.js';

const log = logger;
const clientCache = new Map();

function serviceConfig(userId, service) {
  const cfg = getUserApi(userId);
  const conf = cfg[service] || {};
  if (!conf.apiKey && !conf.baseUrl) {
    throw new AppError(400, 'api_not_configured', `尚未配置「${serviceLabel(service)}」服务，请前往配置页填写 API Key 与地址`);
  }
  return conf;
}

function serviceLabel(service) {
  return {
    chat: '对话模型',
    embedding: '嵌入模型',
    deepseek: 'DeepSeek',
    stt: '语音识别',
    tts: '语音合成',
    search: '网页搜索',
  }[service] || service;
}

export function makeClient(conf) {
  const key = `${conf.baseUrl || 'default'}|${conf.apiKey || 'none'}`;
  if (clientCache.has(key)) return clientCache.get(key);
  const client = new OpenAI({
    apiKey: conf.apiKey || 'sk-no-key',
    baseURL: conf.baseUrl && conf.baseUrl.trim() ? conf.baseUrl.replace(/\/+$/, '') : undefined,
    timeout: Number(conf.timeoutMs || 120_000),
    maxRetries: 1,
  });
  if (clientCache.size > 30) clientCache.clear();
  clientCache.set(key, client);
  return client;
}

export function clientFor(userId, service = 'chat') {
  return makeClient(serviceConfig(userId, service));
}

export function resolveModel(userId, task = 'main', explicit = null) {
  const prefs = getPrefs(userId);
  const routing = prefs.modelRouting || {};
  const cfg = getUserApi(userId);
  if (explicit) return explicit;
  if (routing[task]) return routing[task];
  if (task === 'embedding') return cfg.embedding.model || 'text-embedding-3-small';
  if (task === 'stt') return cfg.stt.model || 'mimo-audio';
  if (task === 'tts') return cfg.tts.model || 'breeze-tts-2';
  if (task === 'search') return cfg.search.model || cfg.deepseek.model || 'deepseek-chat';
  if (task === 'vision') {
    if (routing.vision) return routing.vision;
    if (cfg.chat.model && describeModel(cfg.chat.model).capabilities.image) return cfg.chat.model;
    return cfg.chat.model || 'gpt-4o-mini';
  }
  return cfg.chat.model || DEFAULT_MODELS[0];
}

function usageOf(usage) {
  const input = Number(usage?.prompt_tokens || usage?.input_tokens || 0);
  const output = Number(usage?.completion_tokens || usage?.output_tokens || 0);
  const cached = Number(
    usage?.prompt_tokens_details?.cached_tokens ?? usage?.input_tokens_details?.cached_tokens ?? usage?.cached_tokens ?? 0,
  );
  return { input, output, cached, total: input + output };
}

function providerExtras({ model, baseUrl, thinking }) {
  const extras = {};
  const target = `${baseUrl || ''} ${model || ''}`;
  if (thinking === false) {
    if (/dashscope|aliyuncs|qwen/i.test(target)) extras.enable_thinking = false;
    if (/^(gpt-5|o[1-4])/i.test(model || '')) extras.reasoning_effort = 'minimal';
  }
  if (thinking === true && /^(gpt-5)/i.test(model || '')) extras.reasoning_effort = 'medium';
  return extras;
}

/** 一次性文本对话（非流式）。返回 { text, usage, model, finishReason } */
export async function chatText(userId, opts = {}) {
  const {
    task = 'main',
    model = resolveModel(userId, task, opts.model),
    messages = [],
    temperature = 0.8,
    maxTokens = 1200,
    thinking = false,
    json = false,
    timeoutMs = 120_000,
    service = 'chat',
    returnRaw = false,
  } = opts;

  const conf = serviceConfig(userId, service);
  const client = makeClient(conf);
  const baseBody = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    ...providerExtras({ model, baseUrl: conf.baseUrl, thinking }),
  };
  if (json) baseBody.response_format = { type: 'json_object' };

  async function call(body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await client.chat.completions.create(body, { signal: controller.signal, timeout: timeoutMs });
    } finally {
      clearTimeout(timer);
    }
  }

  let res;
  try {
    res = await call(baseBody);
  } catch (err) {
    // provider 不认扩展参数/JSON 模式时降级重试一次
    const stripped = { ...baseBody };
    delete stripped.enable_thinking;
    delete stripped.reasoning_effort;
    delete stripped.response_format;
    if (Object.keys(stripped).length === Object.keys(baseBody).length) throw wrap(err);
    try {
      res = await call(stripped);
    } catch (err2) {
      // 第三层兼容：部分模型不接受 max_tokens / temperature（如推理模型）
      const msg = String(err2?.message || err2?.error?.message || '');
      if (/max_tokens|max_completion_tokens|temperature|unsupported|invalid/i.test(msg)) {
        const alt = { ...stripped };
        delete alt.temperature;
        if (alt.max_tokens !== undefined) {
          alt.max_completion_tokens = alt.max_tokens;
          delete alt.max_tokens;
        }
        try {
          res = await call(alt);
        } catch (err3) {
          throw wrap(err3);
        }
      } else {
        throw wrap(err2);
      }
    }
  }

  const choice = res.choices?.[0];
  const text = choice?.message?.content ?? '';
  const usage = usageOf(res.usage);
  const out = {
    text: typeof text === 'string' ? text : JSON.stringify(text),
    reasoning: choice?.message?.reasoning_content || null,
    usage,
    model,
    finishReason: choice?.finish_reason || 'stop',
    cost: estimateCost(model, usage.input, usage.cached, usage.output),
  };
  if (returnRaw) out.raw = res;
  return out;
}

function wrap(err) {
  if (err instanceof AppError) return err;
  const status = err?.status || err?.response?.status;
  const msg =
    err?.error?.message || err?.response?.data?.error?.message || err?.message || '模型服务调用失败';
  if (status === 401 || status === 403) return new AppError(400, 'api_unauthorized', 'API Key 无效或无权限');
  if (status === 404) return new AppError(400, 'model_not_found', `模型或接口不存在：${msg}`);
  if (status === 429) return new AppError(429, 'upstream_rate_limited', '模型服务限流，请稍后重试');
  return upstream(`模型服务异常：${msg}`, 'upstream_error', { status });
}

/** 多模态图片描述（图片转文字，供主模型使用） */
export async function visionDescribe(userId, imageUrlOrData, prompt = '请用中文详细描述这张图片的内容、氛围与可见文字。') {
  const model = resolveModel(userId, 'vision');
  return chatText(userId, {
    task: 'vision',
    model,
    maxTokens: 600,
    temperature: 0.5,
    thinking: false,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageUrlOrData } },
        ],
      },
    ],
  });
}

/** 语音转写：小米 MiMo 开放接口（OpenAI 兼容 /audio/transcriptions，失败时尝试 chat audio 兼容） */
export async function transcribe(userId, filePath, { language = 'zh' } = {}) {
  const conf = serviceConfig(userId, 'stt');
  const client = makeClient(conf);
  const mode = conf.extra?.mode || 'openai';
  if (mode === 'openai') {
    try {
      const audio = fs.createReadStream(filePath);
      const res = await client.audio.transcriptions.create({
        file: audio,
        model: conf.model || 'mimo-audio',
        language,
      });
      return { text: res.text || '', model: conf.model, raw: res };
    } catch (err) {
      log.warn('STT 转写失败，尝试 chat audio 兼容模式', err?.message);
    }
  }
  // 兼容：把音频以 input_audio 形式送 chat completions（MiMo / 部分网关支持）
  try {
    const buf = fs.readFileSync(filePath);
    const ext = path.extname(filePath).replace('.', '') || 'wav';
    const res = await chatText(userId, {
      service: 'stt',
      task: 'stt',
      model: conf.model || 'mimo-v2.6-pro',
      maxTokens: 800,
      temperature: 0,
      thinking: false,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '请把这段语音逐字转写为文字，只输出转写结果，不要解释。' },
            { type: 'input_audio', input_audio: { data: buf.toString('base64'), format: ext } },
          ],
        },
      ],
    });
    return { text: res.text.trim(), model: conf.model, usage: res.usage };
  } catch (err) {
    throw wrap(err);
  }
}

/** 语音合成：Breeze TTS 2（默认）或 OpenAI 兼容 /audio/speech */
export async function synthesize(userId, text, { voice } = {}) {
  const conf = serviceConfig(userId, 'tts');
  const mode = conf.extra?.mode || (/breeze/i.test(conf.baseUrl || '') || /breeze/i.test(conf.model || '') ? 'breeze' : 'openai');
  const voiceId = voice || conf.voice || conf.extra?.voiceId || '';
  if (mode === 'breeze') {
    const base = (conf.baseUrl || 'https://api.breezeblue.ai').replace(/\/+$/, '').replace(/\/v1$/, '');
    const url = `${base}/v1/text-to-speech/${encodeURIComponent(voiceId || 'default')}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${conf.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text, output_format: conf.extra?.format || 'mp3' }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Breeze TTS HTTP ${res.status} ${detail.slice(0, 200)}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const mime = res.headers.get('content-type') || 'audio/mpeg';
      return { buffer: buf, mime, provider: 'breeze' };
    } catch (err) {
      throw wrap(err);
    }
  }
  const client = makeClient(conf);
  try {
    const res = await client.audio.speech.create({
      model: conf.model || 'tts-1',
      voice: voiceId || 'default',
      input: text,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return { buffer: buf, mime: 'audio/mpeg', provider: 'openai' };
  } catch (err) {
    throw wrap(err);
  }
}

/** 文本嵌入 */
export async function embed(userId, input, { model } = {}) {
  const conf = serviceConfig(userId, 'embedding');
  const client = makeClient(conf);
  const texts = Array.isArray(input) ? input : [input];
  try {
    const res = await client.embeddings.create({ model: model || conf.model || 'text-embedding-3-small', input: texts });
    return {
      vectors: res.data.map((d) => d.embedding),
      model: model || conf.model,
      usage: usageOf(res.usage),
    };
  } catch (err) {
    throw wrap(err);
  }
}

/** 获取模型列表（含能力与上下文窗口） */
export async function listModels(userId, service = 'chat') {
  const conf = serviceConfig(userId, service);
  const client = makeClient(conf);
  try {
    const res = await client.models.list();
    const items = (res.data || []).map((m) => {
      const desc = describeModel(m.id);
      return { ...desc, ownedBy: m.owned_by || null };
    });
    items.sort((a, b) => a.id.localeCompare(b.id));
    return { models: items, source: 'remote' };
  } catch (err) {
    log.warn('模型列表获取失败，返回内置候选', err?.message);
    const fallback = DEFAULT_MODELS.filter((id) =>
      service === 'embedding' ? /embed/i.test(id) : !/embed/i.test(id),
    ).map((id) => ({ ...describeModel(id), ownedBy: null }));
    return { models: fallback, source: 'fallback', warning: err?.message };
  }
}

/** 连通性测试 */
export async function testConnection(userId, service = 'chat') {
  const started = Date.now();
  try {
    if (service === 'embedding') {
      const r = await embed(userId, 'cocoa connectivity test');
      return { ok: true, latencyMs: Date.now() - started, detail: `向量维度 ${r.vectors[0]?.length || 0}` };
    }
    if (service === 'stt' || service === 'tts') {
      const conf = serviceConfig(userId, service);
      const client = makeClient(conf);
      const res = await client.models.list();
      return {
        ok: true,
        latencyMs: Date.now() - started,
        detail: `可用模型 ${res.data?.length || 0} 个`,
      };
    }
    const model = resolveModel(userId, service === 'deepseek' ? 'search' : 'main');
    const r = await chatText(userId, {
      service: service === 'deepseek' ? 'deepseek' : 'chat',
      model,
      messages: [{ role: 'user', content: 'ping，只回答 pong' }],
      maxTokens: 16,
      temperature: 0,
      thinking: false,
    });
    return { ok: true, latencyMs: Date.now() - started, detail: r.text.slice(0, 40) || 'ok', model };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, detail: err.message, code: err.code };
  }
}

/** 搜索：DeepSeek 提供 search/fetch 能力；未配置时由上层询问 key */
export async function webSearch(userId, query, { maxResults = 5 } = {}) {
  const cfg = getUserApi(userId);
  if (!cfg.search.apiKey) throw new AppError(400, 'search_not_configured', '网页搜索需要 DeepSeek API Key，请前往配置');
  const model = cfg.search.model || 'deepseek-chat';
  const r = await chatText(userId, {
    service: 'search',
    task: 'search',
    model,
    maxTokens: 900,
    temperature: 0.3,
    thinking: false,
    messages: [
      {
        role: 'system',
        content:
          '你是网页检索助手。请根据用户查询返回 JSON：{"query":"","results":[{"title":"","url":"","snippet":""}]}。' +
          `结果不超过 ${maxResults} 条；无法检索时返回空数组。仅输出 JSON。`,
      },
      { role: 'user', content: String(query) },
    ],
    json: true,
  });
  try {
    const data = JSON.parse(r.text);
    return { ...data, usage: r.usage, model };
  } catch {
    return { query, results: [], raw: r.text, usage: r.usage, model };
  }
}

export function saveAudioBuffer(buffer, ext = 'mp3') {
  return { buffer, ext };
}

export { serviceConfig, usageOf, estimateCost };
export default { chatText, embed, listModels, testConnection, clientFor, resolveModel };
