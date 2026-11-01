// 模型能力与上下文窗口注册表（OpenAI 兼容网关亦可命中前缀规则）
const WINDOWS = [
  [/gpt-4\.1-nano/i, 1_047_576],
  [/gpt-4\.1/i, 1_047_576],
  [/gpt-4o-mini/i, 128_000],
  [/gpt-4o/i, 128_000],
  [/gpt-4-turbo/i, 128_000],
  [/gpt-4-/i, 8_192],
  [/gpt-3\.5/i, 16_385],
  [/gpt-5/i, 400_000],
  [/o[134](-mini|-pro)?/i, 200_000],
  [/deepseek-reasoner/i, 131_072],
  [/deepseek-chat/i, 131_072],
  [/deepseek/i, 65_536],
  [/qwen3-max|qwen-max|qwen-plus|qwen-turbo/i, 131_072],
  [/qwen.*vl/i, 131_072],
  [/glm-4(\.5)?/i, 131_072],
  [/moonshot|kimi/i, 131_072],
  [/claude.*(opus|sonnet)/i, 200_000],
  [/gemini-2\.5/i, 1_048_576],
  [/doubao/i, 131_072],
  [/ernie|hunyuan|spark/i, 32_768],
  [/text-embedding-3-large/i, 8_191],
  [/text-embedding-3-small/i, 8_191],
  [/text-embedding-ada-002/i, 8_191],
  [/embed/i, 8_192],
];
const IMAGE = [
  /gpt-4o(?!-audio|-realtime)/i, /gpt-4\.1/i, /gpt-4-turbo/i, /gpt-4-vision/i, /gpt-5/i, /o[34]/i,
  /vision/i, /vl/i, /multimodal/i, /gemini/i, /claude.*(opus|sonnet|haiku)/i, /glm-4(v|\.5v|\.1v)/i,
  /doubao.*(vision|1\.5-vision)/i, /step-1v/i, /internvl/i, /llava/i,
];
const AUDIO_IN = [/whisper/i, /transcribe/i, /audio/i, /speech/i, /sensevoice/i, /paraformer/i, /mimo/i];
const AUDIO_OUT = [/tts/i, /audio-preview/i, /realtime/i, /speech/i, /breeze/i, /cosyvoice/i];
const REASONING = [/^o[134]/i, /gpt-5/i, /deepseek-reasoner/i, /qwq/i, /reasoning/i, /\br1\b/i, /thinking/i];

const PRICING = [
  [/gpt-4o-mini/i, { in: 0.15, cached: 0.075, out: 0.6 }],
  [/gpt-4o/i, { in: 2.5, cached: 1.25, out: 10 }],
  [/gpt-4\.1-nano/i, { in: 0.1, cached: 0.025, out: 0.4 }],
  [/gpt-4\.1-mini/i, { in: 0.4, cached: 0.1, out: 1.6 }],
  [/gpt-4\.1/i, { in: 2, cached: 0.5, out: 8 }],
  [/gpt-5/i, { in: 1.25, cached: 0.125, out: 10 }],
  [/deepseek-chat/i, { in: 0.27, cached: 0.07, out: 1.1 }],
  [/deepseek-reasoner/i, { in: 0.55, cached: 0.14, out: 2.19 }],
  [/qwen-plus/i, { in: 0.4, cached: 0.4, out: 1.2 }],
  [/qwen-max/i, { in: 1.6, cached: 1.6, out: 6.4 }],
  [/qwen-turbo/i, { in: 0.05, cached: 0.05, out: 0.2 }],
  [/embedding/i, { in: 0.02, cached: 0.02, out: 0 }],
  [/whisper/i, { in: 6, cached: 6, out: 0 }],
];

const DEFAULT_WINDOW = 32_768;

export function describeModel(id = '') {
  const name = String(id);
  const window = WINDOWS.find(([re]) => re.test(name))?.[1] || DEFAULT_WINDOW;
  const image = IMAGE.some((re) => re.test(name));
  const audioIn = AUDIO_IN.some((re) => re.test(name));
  const audioOut = AUDIO_OUT.some((re) => re.test(name));
  const reasoning = REASONING.some((re) => re.test(name));
  const embedding = /embed/i.test(name);
  // 语音能力：模型若同时支持输入与输出则归为 audio
  const audio = audioIn || audioOut;
  const modalities = [];
  if (!embedding) modalities.push('text');
  if (image) modalities.push('image');
  if (audio) modalities.push('audio');
  return {
    id: name,
    modalities,
    capabilities: { text: !embedding, image, audio, audioIn, audioOut, reasoning, embedding },
    contextWindow: window,
    svg: {
      text: !embedding ? 'svg:text' : null,
      image: image ? 'svg:image' : null,
      audio: audio ? 'svg:audio' : null,
    },
  };
}

export function contextWindowFor(id) {
  return describeModel(id).contextWindow;
}

export function estimateCost(model, inputTokens = 0, cachedTokens = 0, outputTokens = 0) {
  const price = PRICING.find(([re]) => re.test(String(model)))?.[1] || { in: 0, cached: 0, out: 0 };
  const fresh = Math.max(0, inputTokens - cachedTokens);
  return (
    (fresh * price.in + cachedTokens * price.cached + outputTokens * price.out) / 1_000_000
  );
}

export function supportsThinkingToggle(model) {
  return describeModel(model).capabilities.reasoning;
}

export const DEFAULT_MODELS = [
  'gpt-4o-mini',
  'gpt-4o',
  'gpt-4.1',
  'gpt-5',
  'deepseek-chat',
  'deepseek-reasoner',
  'qwen-plus',
  'qwen-vl-max',
  'text-embedding-3-small',
];
