import 'package:flutter/material.dart';

import '../core/api_client.dart';
import '../core/app_state.dart';
import '../core/constants.dart';
import '../core/global.dart';
import '../core/theme.dart';
import '../models/character.dart';

/// 新建 / 编辑角色：10 个人设字段 + 便捷输入扩写 + 模板沿用。
class CharacterEditPage extends StatefulWidget {
  const CharacterEditPage({super.key, this.character, this.initialProfile});

  final Character? character;
  final Map<String, dynamic>? initialProfile;

  @override
  State<CharacterEditPage> createState() => _CharacterEditPageState();
}

class _CharacterEditPageState extends State<CharacterEditPage> {
  final Map<String, TextEditingController> _fields =
      <String, TextEditingController>{};
  final TextEditingController _quick = TextEditingController();
  bool _saving = false;
  bool _expanding = false;
  bool _loadingTemplates = false;

  bool get _isEdit => widget.character != null;

  @override
  void initState() {
    super.initState();
    final Map<String, dynamic> source = widget.character != null
        ? widget.character!.profileJson()
        : (widget.initialProfile ?? <String, dynamic>{});
    for (final String field in kProfileFields) {
      _fields[field] = TextEditingController(
        text: source[field]?.toString() ?? '',
      );
    }
  }

  @override
  void dispose() {
    for (final TextEditingController c in _fields.values) {
      c.dispose();
    }
    _quick.dispose();
    super.dispose();
  }

  void _applyProfile(Map<String, dynamic> profile) {
    for (final String field in kProfileFields) {
      final dynamic v = profile[field];
      if (v == null) continue;
      final String text = v.toString().trim();
      if (text.isEmpty) continue;
      _fields[field]?.text = text;
    }
    setState(() {});
  }

  Future<void> _expand() async {
    final AppState state = AppScope.read(context);
    final String prompt = _quick.text.trim();
    if (prompt.isEmpty) {
      showToast('先写一句模糊的人设描述吧');
      return;
    }
    setState(() => _expanding = true);
    try {
      final result = await state.characterService.expand(prompt);
      _applyProfile(result.profile);
      showToast(
        result.isLocal ? '模型未就绪，已用本地模板补全' : '已自动填入人设',
      );
    } on ApiException catch (e) {
      showToast(e.message, isError: true);
    } catch (e) {
      showToast('扩写失败：$e', isError: true);
    } finally {
      if (mounted) setState(() => _expanding = false);
    }
  }

  Future<void> _pickTemplate() async {
    final AppState state = AppScope.read(context);
    setState(() => _loadingTemplates = true);
    try {
      final List<CharacterTemplate> templates =
          await state.characterService.templates();
      if (!mounted) return;
      if (templates.isEmpty) {
        showToast('还没有保存过角色模板');
        return;
      }
      final CharacterTemplate? picked =
          await showModalBottomSheet<CharacterTemplate>(
        context: context,
        builder: (BuildContext ctx) => SafeArea(
          child: ListView(
            shrinkWrap: true,
            children: <Widget>[
              const Padding(
                padding: EdgeInsets.all(14),
                child: Text(
                  '选择角色模板',
                  style: TextStyle(fontWeight: FontWeight.w700),
                ),
              ),
              ...templates.map(
                (CharacterTemplate t) => ListTile(
                  leading: const Icon(Icons.description_outlined),
                  title: Text(t.name),
                  subtitle: Text(
                    t.profile['personality']?.toString() ?? '',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  onTap: () => Navigator.of(ctx).pop(t),
                ),
              ),
            ],
          ),
        ),
      );
      if (picked != null) {
        _applyProfile(picked.profile);
        showToast('已沿用模板「${picked.name}」');
      }
    } on ApiException catch (e) {
      showToast(e.message, isError: true);
    } finally {
      if (mounted) setState(() => _loadingTemplates = false);
    }
  }

  Future<void> _saveAsTemplate() async {
    final AppState state = AppScope.read(context);
    final TextEditingController nameCtrl = TextEditingController(
      text: '${_fields['name']?.text.trim() ?? ''} 模板',
    );
    final bool? ok = await showDialog<bool>(
      context: context,
      builder: (BuildContext ctx) => AlertDialog(
        title: const Text('保存为模板'),
        content: TextField(
          controller: nameCtrl,
          decoration: const InputDecoration(labelText: '模板名称'),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('保存'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await state.characterService.saveTemplate(
        name: nameCtrl.text.trim(),
        profile: _profile(),
      );
      showToast('模板已保存');
    } on ApiException catch (e) {
      showToast(e.message, isError: true);
    }
  }

  Map<String, dynamic> _profile() {
    final Map<String, dynamic> out = <String, dynamic>{};
    for (final String field in kProfileFields) {
      out[field] = _fields[field]?.text.trim() ?? '';
    }
    return out;
  }

  Future<void> _save() async {
    final AppState state = AppScope.read(context);
    if ((_fields['name']?.text.trim() ?? '').isEmpty) {
      showToast('请填写角色姓名');
      return;
    }
    setState(() => _saving = true);
    try {
      if (_isEdit) {
        await state.characterService.update(
          widget.character!.id,
          profile: _profile(),
        );
      } else {
        final Character created =
            await state.characterService.create(profile: _profile());
        await state.setActiveCharacter(created.id);
      }
      if (!mounted) return;
      showToast(_isEdit ? '人设已更新' : '角色创建成功');
      Navigator.of(context).pop(true);
    } on ApiException catch (e) {
      showToast(e.message, isError: true);
    } catch (e) {
      showToast('保存失败：$e', isError: true);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Widget _field(String field) {
    final bool multiline =
        <String>['personality', 'worldview', 'appearance', 'hobbies']
            .contains(field);
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: TextField(
        controller: _fields[field],
        maxLines: multiline ? 4 : 1,
        minLines: multiline ? 2 : 1,
        decoration: InputDecoration(
          labelText: kProfileLabels[field],
          hintText: kProfileHints[field],
          alignLabelWithHint: multiline,
        ),
        style: const TextStyle(fontSize: 13, height: 1.4),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(_isEdit ? '编辑人设' : '创建角色'),
        actions: <Widget>[
          if (_isEdit)
            IconButton(
              tooltip: '另存为模板',
              icon: const Icon(Icons.bookmark_add_outlined, size: 20),
              onPressed: _saveAsTemplate,
            ),
          TextButton(
            onPressed: _saving ? null : _save,
            child: _saving
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Text('保存'),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 24),
        children: <Widget>[
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              gradient: const LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: <Color>[Color(0xFFF7E7D8), Color(0xFFFBF3E9)],
              ),
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: AppColors.sand),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    const Icon(Icons.auto_fix_high,
                        size: 16, color: AppColors.cocoa),
                    const SizedBox(width: 6),
                    const Text(
                      '便捷输入',
                      style: TextStyle(
                        fontSize: 13.5,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const Spacer(),
                    TextButton.icon(
                      onPressed: _loadingTemplates ? null : _pickTemplate,
                      icon: const Icon(Icons.copy_all_outlined, size: 14),
                      label: const Text(
                        '沿用模板',
                        style: TextStyle(fontSize: 11.5),
                      ),
                      style: TextButton.styleFrom(
                        minimumSize: const Size(0, 30),
                        padding: const EdgeInsets.symmetric(horizontal: 6),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 4),
                const Text(
                  '写下模糊的设定词，模型会扩写润色并自动填入下方表单。',
                  style: TextStyle(fontSize: 11, color: AppColors.inkSoft),
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: _quick,
                  maxLines: 3,
                  minLines: 2,
                  decoration: const InputDecoration(
                    hintText: '例如：一个温柔的猫娘，喜欢晒太阳，和我同居',
                    isDense: true,
                  ),
                  style: const TextStyle(fontSize: 13, height: 1.4),
                ),
                const SizedBox(height: 8),
                Align(
                  alignment: Alignment.centerRight,
                  child: FilledButton.icon(
                    onPressed: _expanding ? null : _expand,
                    icon: _expanding
                        ? const SizedBox(
                            width: 14,
                            height: 14,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: Colors.white,
                            ),
                          )
                        : const Icon(Icons.auto_awesome, size: 15),
                    label: Text(_expanding ? '生成中…' : '生成并填表'),
                    style: FilledButton.styleFrom(
                      minimumSize: const Size(0, 38),
                      padding: const EdgeInsets.symmetric(horizontal: 14),
                      textStyle: const TextStyle(fontSize: 12.5),
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          ...kProfileFields.map(_field),
          const SizedBox(height: 4),
          const Text(
            '角色之间的记忆、人设与资产完全独立，互不互通。',
            style: TextStyle(fontSize: 10.5, color: AppColors.inkSoft),
          ),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: _saving ? null : _save,
            child: Text(_isEdit ? '保存人设' : '创建角色'),
          ),
        ],
      ),
    );
  }
}
