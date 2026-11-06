// v1.5.0 人设模板路由：本服模板 CRUD / 角色导入 / 一键建角 / 发布到广场
import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { badRequest } from '../core/errors.js';
import {
  listTemplates,
  getTemplate,
  createTemplate,
  importFromCharacter,
  updateTemplate,
  deleteTemplate,
  applyTemplate,
  publishTemplate,
  templateFromPlaza,
  usePlazaTemplate,
  templateSourcesFor,
} from '../services/templates.js';

export default function register() {
  const r = Router();
  r.use(requireAuth);

  r.get('/', (req, res) => {
    const items = listTemplates(req.userId);
    res.json({ ok: true, items, total: items.length });
  });

  // 可导入的角色列表（「从角色导入」选择器）
  r.get('/sources', (req, res) => {
    const items = templateSourcesFor(req.userId);
    res.json({ ok: true, items, total: items.length });
  });

  r.post('/', (req, res) => {
    const { template } = createTemplate(req.userId, req.body || {});
    res.status(201).json({ ok: true, template });
  });

  // 从角色导入（重复导入 → 409 template_duplicate）
  r.post('/import', (req, res) => {
    const characterId = req.body?.characterId || req.body?.character_id;
    if (!characterId) throw badRequest('缺少 characterId', 'character_id_required');
    const result = importFromCharacter(req.userId, characterId);
    res.status(201).json({ ok: true, ...result });
  });

  // 从广场资源保存为本地模板（重复则返回已有模板）
  r.post('/from-plaza', (req, res) => {
    const resourceId = req.body?.resourceId || req.body?.id;
    if (!resourceId) throw badRequest('缺少 resourceId', 'resource_id_required');
    const result = templateFromPlaza(req.userId, resourceId);
    res.status(result.duplicate ? 200 : 201).json({ ok: true, ...result });
  });

  r.get('/:id', (req, res) => {
    res.json({ ok: true, template: getTemplate(req.userId, req.params.id) });
  });

  r.patch('/:id', (req, res) => {
    res.json({ ok: true, ...updateTemplate(req.userId, req.params.id, req.body || {}) });
  });

  r.delete('/:id', (req, res) => {
    res.json(deleteTemplate(req.userId, req.params.id));
  });

  // 一键用模板创建角色
  r.post('/:id/apply', (req, res) => {
    const result = applyTemplate(req.userId, req.params.id, req.body || {});
    res.status(201).json({ ok: true, ...result });
  });

  // 把模板发布到广场
  r.post('/:id/publish', (req, res) => {
    const result = publishTemplate(req.userId, req.params.id, req.body || {});
    res.status(201).json({ ok: true, ...result });
  });

  // 广场模板「一键使用」：返回人设 + 自动落成本地模板
  r.post('/:id/use-plaza', (req, res) => {
    const result = usePlazaTemplate(req.userId, req.params.id, { save: req.body?.save !== false });
    res.json({ ok: true, ...result });
  });

  return r;
}
