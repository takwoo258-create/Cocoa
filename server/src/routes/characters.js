// 角色路由：列表/创建/详情/更新/删除/扩写/模板/设置/状态
import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler, badRequest, notFound } from '../core/errors.js';
import { get, all, run } from '../db/index.js';
import { nowIso, uuid, asInt, clamp, truncate } from '../core/util.js';
import { encryptJson, decryptJson } from '../core/crypto.js';
import {
  PROFILE_FIELDS,
  listCharacters,
  getCharacter,
  createCharacter,
  updateCharacter,
  deleteCharacter,
  getSettings,
  saveSettings,
  ensureState,
} from '../services/characters.js';
import { chatText } from '../ai/provider.js';
import { recordUsage } from '../ai/usage.js';
import { audit } from '../services/audit.js';
import logger from '../core/logger.js';

const FIELD_CN = {
  name: '姓名',
  age: '年龄',
  race: '种族',
  gender: '性别',
  personality: '性格特征',
  worldview: '世界观',
  hobbies: '爱好',
  relation: '与本人的关系',
  appearance: '外观特征',
  occupation: '职业设定',
};

const CREATION_FREQ = new Set(['off', 'hourly', 'daily', 'weekly']);
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const TIMEZONE_RE = /^[A-Za-z0-9_+\-/]{1,64}$/;

function requireCharacter(req, { includeArchived = true } = {}) {
  const character = getCharacter(req.userId, req.params.id, { includeArchived });
  if (!character) throw notFound('角色不存在或不属于当前账号', 'character_not_found');
  return character;
}

function pickProfile(body) {
  const nested = body?.profile && typeof body.profile === 'object' ? body.profile : {};
  const out = {};
  for (const f of PROFILE_FIELDS) {
    const v = body?.[f] !== undefined ? body[f] : nested[f];
    if (v === undefined || v === null) continue;
    out[f] = String(v).trim().slice(0, 4000);
  }
  if (body?.avatar !== undefined) out.avatar = body.avatar ? String(body.avatar).slice(0, 2000) : '';
  return out;
}

function validateName(profile) {
  const name = String(profile?.name || '').trim();
  if (!name) throw badRequest('请填写角色姓名', 'name_required');
  if (name.length > 40) throw badRequest('角色姓名不得超过 40 个字符', 'name_too_long');
  profile.name = name;
  return profile;
}

function sanitizeSettings(input = {}) {
  const patch = {};
  if (input == null || typeof input !== 'object') return patch;

  if (Array.isArray(input.rss)) {
    patch.rss = input.rss
      .map((item) => {
        if (typeof item === 'string') {
          const url = item.trim();
          return url ? { name: url.slice(0, 80), url: url.slice(0, 500), enabled: true } : null;
        }
        if (item && typeof item === 'object') {
          const url = String(item.url || '').trim();
          if (!url) return null;
          return {
            name: String(item.name || url).trim().slice(0, 80),
            url: url.slice(0, 500),
            enabled: item.enabled === undefined ? true : Boolean(item.enabled),
          };
        }
        return null;
      })
      .filter(Boolean)
      .slice(0, 50);
  }
  if (Array.isArray(input.creationTags)) {
    patch.creationTags = [...new Set(input.creationTags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 20);
  }
  if (input.creationFrequency !== undefined) {
    const freq = String(input.creationFrequency);
    if (!CREATION_FREQ.has(freq)) throw badRequest('创作频率仅支持 off/hourly/daily/weekly', 'creation_frequency_invalid');
    patch.creationFrequency = freq;
  }
  if (input.sleep !== undefined) {
    if (input.sleep !== null && typeof input.sleep !== 'object') throw badRequest('作息配置格式不正确', 'sleep_invalid');
    const s = input.sleep || {};
    const sleep = {};
    if (s.enabled !== undefined) sleep.enabled = Boolean(s.enabled);
    for (const key of ['start', 'end', 'napStart', 'napEnd']) {
      if (s[key] === undefined || s[key] === null || s[key] === '') continue;
      const v = String(s[key]);
      if (!HHMM_RE.test(v)) throw badRequest(`作息时间 ${key} 需为 HH:mm`, 'sleep_time_invalid');
      sleep[key] = v;
    }
    patch.sleep = sleep;
  }
  if (input.statusIntervalMin !== undefined) {
    patch.statusIntervalMin = clamp(asInt(input.statusIntervalMin, 10), 1, 240);
  }
  if (input.activeReply !== undefined) patch.activeReply = Boolean(input.activeReply);
  if (input.qzoneEnabled !== undefined) patch.qzoneEnabled = Boolean(input.qzoneEnabled);
  if (input.timezone !== undefined) {
    const tz = String(input.timezone || '').trim();
    if (!tz || !TIMEZONE_RE.test(tz)) throw badRequest('时区格式不正确', 'timezone_invalid');
    patch.timezone = tz;
  }
  if (input.modelRouting !== undefined) {
    if (input.modelRouting !== null && typeof input.modelRouting !== 'object') {
      throw badRequest('模型路由格式不正确', 'model_routing_invalid');
    }
    const routing = {};
    for (const [k, v] of Object.entries(input.modelRouting || {})) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(k)) continue;
      routing[k] = String(v ?? '').trim().slice(0, 120);
    }
    patch.modelRouting = routing;
  }
  if (input.searchProvider !== undefined) patch.searchProvider = String(input.searchProvider || 'deepseek').slice(0, 32);
  if (input.diaryHintEnabled !== undefined) patch.diaryHintEnabled = Boolean(input.diaryHintEnabled);
  return patch;
}

function listTemplates(userId) {
  return all('SELECT id, name, payload, created_at FROM character_templates WHERE user_id = ? ORDER BY created_at DESC', userId).map(
    (row) => ({
      id: row.id,
      name: row.name,
      profile: decryptJson(userId, row.payload, {}),
      createdAt: row.created_at,
    }),
  );
}

// ---------- LLM 扩写 ----------
const EXPAND_SYSTEM = [
  '你是 Cocoa 的角色人设扩写助手。根据用户给出的模糊描述，扩写成一个完整、具体、可直接扮演的中文角色设定。',
  '只输出一个 JSON 对象，不要 Markdown 代码块，不要任何解释。',
  'JSON 必须包含且仅包含这些字段：name, age, race, gender, personality, worldview, hobbies, relation, appearance, occupation。',
  '每个字段都是中文自然语言字符串；age 用数字字符串（如 "20"）；name 为 2-12 字的人名。',
  '字段缺失时由你合理补全，保持与描述一致，不要出现性行为、暴力或政治敏感内容。',
].join('\n');

function extractJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  for (const c of [fenced?.[1], raw]) {
    if (!c) continue;
    const start = c.indexOf('{');
    const end = c.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      const obj = JSON.parse(c.slice(start, end + 1));
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    } catch {
      /* 尝试下一个候选 */
    }
  }
  return null;
}

/** 本地降级扩写：把模糊输入按字段拆分补全，保证 LLM 不可用时仍可创建角色 */
export function localExpand(prompt) {
  const p = String(prompt || '').trim().replace(/\s+/g, ' ').slice(0, 600);
  const nameHit =
    p.match(/(?:名字|姓名|叫作|叫做|叫)\s*[「“"']?([\u4e00-\u9fa5A-Za-z0-9·]{1,12}?)(?=[的，,。；;\s」”"']|$)/) ||
    p.match(/^([\u4e00-\u9fa5]{2,4})(?:，|,|\s|是)/);
  const name = (nameHit?.[1] || '小可').replace(/[「」“”"']/g, '');
  const gender = /(男|少年|哥哥|先生|男友)/.test(p) && !/(女|少女|姐姐|小姐|女友)/.test(p) ? '男' : '女';
  const ageHit = p.match(/(\d{1,3})\s*(?:岁|years?)/);
  const age = ageHit ? ageHit[1] : /学生|高中|大学/.test(p) ? '19' : '23';
  const race = /(猫|狐|狼|龙|精灵|吸血鬼|机器人|AI|恶魔|天使)/.exec(p)?.[0] || '人类';
  const relation = /(恋人|女朋友|男朋友|情侣|爱人|老婆|老公)/.test(p)
    ? '恋人'
    : /(青梅竹马|青梅)/.test(p)
      ? '青梅竹马'
      : /(同事|上司|下属)/.test(p)
        ? '同事'
        : /(朋友|好友)/.test(p)
          ? '朋友'
          : '亲密的朋友';
  const occupation = /(医生|护士)/.test(p)
    ? '医生'
    : /(老师|教师|教授)/.test(p)
      ? '教师'
      : /(程序员|工程师|开发)/.test(p)
        ? '程序员'
        : /(歌手|偶像|演员|主播)/.test(p)
          ? '艺人'
          : /(学生)/.test(p)
            ? '学生'
            : /(咖啡|店主|老板)/.test(p)
              ? '咖啡店店主'
              : '自由职业者';
  const seed = truncate(p || '温和安静的日常陪伴', 120);
  return {
    name,
    age,
    race,
    gender,
    personality: `${seed}。性格温和细腻，会在意对方的情绪变化；开心时会直接表达，被冷落时会小声抱怨；习惯用简短口语回应，偶尔撒娇，但不会过度黏人。`,
    worldview: '相信日常里的细小温柔比宏大的誓言更可靠；认为陪伴是彼此慢慢熟悉的过程，愿意把生活里的琐碎讲给对方听。',
    hobbies: seed.includes('猫') ? '逗猫、晒太阳、收集毛绒小物' : '听歌、散步、记录生活里的小事、研究新菜谱',
    relation,
    appearance: `${gender === '女' ? '身形纤细' : '身形清瘦'}，${
      race === '人类' ? '黑发微卷，眼睛干净明亮' : `带着${race}特有的气质与细节`
    }；常穿宽松的针织衫与长裤，笑起来有明显的亲和力。`,
    occupation,
  };
}

function localExpandBudget(prompt) {
  const base = localExpand(prompt);
  const out = {};
  for (const f of PROFILE_FIELDS) out[f] = String(base[f] ?? '').trim() || `${FIELD_CN[f]}待补充`;
  return out;
}

/** 调 LLM 扩写；任何失败（未配置 API/网络/解析失败）都降级为本地扩写 */
export async function expandProfile(userId, prompt) {
  const fallback = localExpandBudget(prompt);
  let text = '';
  let model = 'unknown';
  let usage = {};
  let cost = null;
  try {
    const out = await chatText(userId, {
      task: 'main',
      messages: [
        { role: 'system', content: EXPAND_SYSTEM },
        { role: 'user', content: String(prompt).slice(0, 600) },
      ],
      json: true,
      temperature: 0.9,
      maxTokens: 900,
      thinking: false,
      timeoutMs: 45_000,
    });
    text = out?.text || '';
    model = out?.model || model;
    usage = out?.usage || usage;
    cost = out?.cost ?? cost;
    try {
      recordUsage({ userId, kind: 'expand', model, usage, cost });
    } catch (err) {
      logger.debug('expand 用量记录失败', err.message);
    }
  } catch (err) {
    logger.info('角色扩写降级为本地模板', err.code || err.message);
    return { profile: fallback, source: 'local', reason: err.code || 'llm_unavailable' };
  }
  const parsed = extractJson(text);
  if (!parsed) return { profile: fallback, source: 'local', reason: 'invalid_json' };
  const merged = { ...fallback };
  for (const f of PROFILE_FIELDS) {
    const v = parsed[f];
    if (v === undefined || v === null) continue;
    const s = String(typeof v === 'object' ? JSON.stringify(v) : v).trim();
    if (s) merged[f] = s.slice(0, 4000);
  }
  return { profile: merged, source: 'llm' };
}

export default function register() {
  const r = Router();
  r.use(requireAuth);

  // ---------- 模板（必须声明在 /:id 之前） ----------
  r.get('/templates', (req, res) => {
    const items = listTemplates(req.userId);
    res.json({ items, total: items.length });
  });

  r.post('/templates', (req, res) => {
    const name = String(req.body?.name || '').trim();
    const profile = req.body?.profile && typeof req.body.profile === 'object' ? req.body.profile : null;
    if (!name) throw badRequest('请填写模板名称', 'template_name_required');
    if (!profile) throw badRequest('缺少模板人设内容', 'template_profile_required');
    const clean = {};
    for (const f of PROFILE_FIELDS) clean[f] = String(profile[f] ?? '').slice(0, 4000);
    if (!clean.name) throw badRequest('模板缺少角色姓名', 'template_name_missing');
    const id = `tpl_${uuid().replace(/-/g, '').slice(0, 16)}`;
    const createdAt = nowIso();
    run(
      'INSERT INTO character_templates(id, user_id, name, payload, created_at) VALUES(?,?,?,?,?)',
      id,
      req.userId,
      name.slice(0, 60),
      encryptJson(req.userId, clean),
      createdAt,
    );
    res.status(201).json({ template: { id, name: name.slice(0, 60), profile: clean, createdAt } });
  });

  // ---------- 扩写 ----------
  r.post(
    '/expand',
    asyncHandler(async (req, res) => {
      const prompt = String(req.body?.prompt || req.body?.input || '').trim();
      if (!prompt) throw badRequest('请输入便捷设定的描述', 'prompt_required');
      if (prompt.length > 2000) throw badRequest('描述过长，请精简到 2000 字以内', 'prompt_too_long');
      const { profile, source, reason } = await expandProfile(req.userId, prompt);
      res.json({ profile, source, ...(reason ? { reason } : {}) });
    }),
  );

  // ---------- 列表 / 创建 ----------
  r.get('/', (req, res) => {
    const includeArchived = req.query.includeArchived === '1' || req.query.includeArchived === 'true';
    const items = listCharacters(req.userId, { includeArchived });
    res.json({ items, total: items.length });
  });

  r.post('/', (req, res) => {
    const body = req.body || {};
    const profile = pickProfile(body);

    // 模板沿用：模板内容作为底稿，请求中的字段覆盖
    if (body.templateId) {
      const row = get('SELECT * FROM character_templates WHERE id = ? AND user_id = ?', String(body.templateId), req.userId);
      if (!row) throw notFound('角色模板不存在', 'template_not_found');
      const tplProfile = decryptJson(req.userId, row.payload, {}) || {};
      for (const f of PROFILE_FIELDS) {
        if (profile[f] !== undefined && profile[f] !== '') continue;
        if (tplProfile[f] !== undefined) profile[f] = String(tplProfile[f]).slice(0, 4000);
      }
    }

    validateName(profile);
    const settings = body.settings ? sanitizeSettings(body.settings) : undefined;
    const character = createCharacter(req.userId, { ...profile, ...(settings ? { settings } : {}) });
    audit(req.userId, 'character.create', character.id, { name: character.name }, req.ip);
    res.status(201).json({ character });
  });

  // ---------- 详情 / 更新 / 删除 ----------
  r.get('/:id', (req, res) => {
    res.json({ character: requireCharacter(req) });
  });

  r.put('/:id', (req, res) => {
    const existing = requireCharacter(req);
    const body = req.body || {};
    const patch = pickProfile(body);
    if (patch.name !== undefined) validateName(patch);
    if (body.archived !== undefined) patch.archived = Boolean(body.archived);
    if (body.settings !== undefined) patch.settings = sanitizeSettings(body.settings);
    if (!Object.keys(patch).length) throw badRequest('没有可更新的人设字段', 'empty_patch');
    const character = updateCharacter(req.userId, existing.id, patch);
    if (!character) throw notFound('角色不存在', 'character_not_found');
    audit(req.userId, 'character.update', character.id, { fields: Object.keys(patch) }, req.ip);
    res.json({ character });
  });

  r.delete('/:id', (req, res) => {
    const existing = requireCharacter(req);
    const ok = deleteCharacter(req.userId, existing.id);
    if (!ok) throw notFound('角色不存在', 'character_not_found');
    audit(req.userId, 'character.delete', existing.id, { name: existing.name }, req.ip);
    res.json({ ok: true, id: existing.id, deleted: true });
  });

  // ---------- 设置 ----------
  r.get('/:id/settings', (req, res) => {
    const character = requireCharacter(req);
    res.json({ characterId: character.id, settings: getSettings(character.id, req.userId) });
  });

  r.put('/:id/settings', (req, res) => {
    const character = requireCharacter(req);
    const patch = sanitizeSettings(req.body || {});
    if (!Object.keys(patch).length) throw badRequest('没有可保存的设置项', 'empty_patch');
    const settings = saveSettings(character.id, req.userId, patch);
    audit(req.userId, 'character.settings', character.id, { fields: Object.keys(patch) }, req.ip);
    res.json({ characterId: character.id, settings });
  });

  // ---------- 状态 ----------
  r.get('/:id/state', (req, res) => {
    const character = requireCharacter(req);
    ensureState(character.id, req.userId);
    const fresh = getCharacter(req.userId, character.id, { includeArchived: true });
    res.json({ characterId: fresh.id, state: fresh.state });
  });

  return r;
}
