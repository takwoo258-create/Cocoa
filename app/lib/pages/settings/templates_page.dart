import 'package:flutter/material.dart';

import '../../core/api_client.dart';
import '../../core/app_state.dart';
import '../../core/global.dart';
import '../../core/theme.dart';
import '../../models/character.dart';
import '../../widgets/common.dart';
import '../../widgets/plaza_publish_dialog.dart';

/// v1.5.0：人设模板保存 / 从角色导入 / 应用创建 / 发布广场。
class TemplatesPage extends StatefulWidget {
  const TemplatesPage({super.key});

  @override
  State<TemplatesPage> createState() => _TemplatesPageState();
}

class _TemplatesPageState extends State<TemplatesPage> {
  List<CharacterTemplate> _list = <CharacterTemplate>[];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    final AppState state = AppScope.read(context);
    try {
      final List<CharacterTemplate> list =
          await state.templateService.list();
      if (mounted) {
        setState(() {
          _list = list;
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() => _loading = false);
        showToast('模板加载失败：$e', isError: true);
      }
    }
  }

  Future<void> _saveActive() async {
    final AppState state = AppScope.read(context);
    final String? id = state.activeCharacterId;
    if (id == null || id.isEmpty) {
      showToast('先在角色页选择一个角色');
      return;
    }
    try {
      final Character c = await state.characterService.get(id);
      if (!mounted) return;
      final TextEditingController name =
          TextEditingController(text: '${c.name} 模板');
      final String? title = await showDialog<String>(
        context: context,
        builder: (BuildContext ctx) => AlertDialog(
          title: const Text('保存为人设模板'),
          content: TextField(
            controller: name,
            decoration: const InputDecoration(labelText: '模板名称'),
          ),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: () => Navigator.of(ctx).pop(name.text.trim()),
              child: const Text('保存'),
            ),
          ],
        ),
      );
      name.dispose();
      if (title == null) return;
      await state.templateService.create(
        name: title,
        profile: c.profileJson(),
      );
      if (mounted) {
        showToast('模板已保存');
        await _load();
      }
    } catch (e) {
      showToast('保存失败：$e', isError: true);
    }
  }

  Future<void> _import() async {
    final AppState state = AppScope.read(context);
    try {
      final List<Character> chars = await state.characterService.list();
      if (!mounted) return;
      if (chars.isEmpty) {
        showToast('没有可导入的角色');
        return;
      }
      final Character? picked = await showModalBottomSheet<Character>(
        context: context,
        builder: (BuildContext ctx) => SafeArea(
          child: ListView(
            shrinkWrap: true,
            children: chars
                .map(
                  (Character c) => ListTile(
                    title: Text(c.name, style: const TextStyle(fontSize: 13)),
                    subtitle: Text(
                      '${c.race} ${c.gender}',
                      style: const TextStyle(fontSize: 10.5),
                    ),
                    onTap: () => Navigator.of(ctx).pop(c),
                  ),
                )
                .toList(),
          ),
        ),
      );
      if (picked == null) return;
      await state.templateService.importCharacter(picked.id);
      if (mounted) {
        showToast('已导入');
        await _load();
      }
    } on ApiException catch (e) {
      if (e.code == 'template_duplicate') {
        showToast('该角色已存在模板，不能重复导入', isError: true);
      } else {
        showToast(e.message, isError: true);
      }
    } catch (e) {
      showToast('导入失败：$e', isError: true);
    }
  }

  Future<void> _apply(CharacterTemplate t) async {
    final AppState state = AppScope.read(context);
    try {
      await state.templateService.apply(t.id);
      if (mounted) {
        showToast('已用模板创建角色');
        await state.characterService.list();
      }
    } catch (e) {
      showToast('应用失败：$e', isError: true);
    }
  }

  Future<void> _publish(CharacterTemplate t) async {
    final Map<String, dynamic>? form = await showPlazaPublishDialog(
      context,
      kind: 'template',
      title: t.name,
    );
    if (form == null) return;
    final AppState state = AppScope.read(context);
    try {
      await state.templateService.publish(t.id, form);
      if (mounted) showToast('已发布到广场');
    } catch (e) {
      showToast('发布失败：$e', isError: true);
    }
  }

  Future<void> _batchShare() async {
    if (_list.isEmpty) return;
    final Set<String> selected = <String>{};
    final List<CharacterTemplate>? picked =
        await showDialog<List<CharacterTemplate>>(
      context: context,
      builder: (BuildContext ctx) => StatefulBuilder(
        builder: (BuildContext ctx, StateSetter setSt) => AlertDialog(
          title: const Text('批量分享模板'),
          content: SizedBox(
            width: 440,
            child: ListView(
              shrinkWrap: true,
              children: _list
                  .map(
                    (CharacterTemplate t) => CheckboxListTile(
                      dense: true,
                      title: Text(t.name, style: const TextStyle(fontSize: 12)),
                      value: selected.contains(t.id),
                      onChanged: (bool? v) => setSt(() {
                        if (v == true) {
                          selected.add(t.id);
                        } else {
                          selected.remove(t.id);
                        }
                      }),
                    ),
                  )
                  .toList(),
            ),
          ),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: selected.isEmpty
                  ? null
                  : () => Navigator.of(ctx).pop(
                        _list.where((CharacterTemplate t) => selected.contains(t.id)).toList(),
                      ),
              child: const Text('下一步'),
            ),
          ],
        ),
      ),
    );
    if (picked == null || picked.isEmpty || !mounted) return;
    final Map<String, dynamic>? form = await showPlazaPublishDialog(
      context,
      kind: 'template',
      title: '人设模板批量分享',
    );
    if (form == null) return;
    final AppState state = AppScope.read(context);
    int ok = 0;
    int fail = 0;
    for (final CharacterTemplate t in picked) {
      try {
        await state.templateService.publish(t.id, form);
        ok++;
      } catch (_) {
        fail++;
      }
    }
    if (mounted) {
      showToast('批量分享完成：成功 $ok，失败 $fail', isError: fail > 0);
    }
  }

  Future<void> _delete(CharacterTemplate t) async {
    final bool ok = await confirmDialog(
      context,
      title: '删除模板',
      message: '确定删除「${t.name}」吗？',
      confirmText: '删除',
      danger: true,
    );
    if (!ok) return;
    final AppState state = AppScope.read(context);
    try {
      await state.templateService.delete(t.id);
      await _load();
    } catch (e) {
      showToast('删除失败：$e', isError: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('人设模板'),
        actions: <Widget>[
          IconButton(
            tooltip: '保存当前角色',
            icon: const Icon(Icons.add, size: 20),
            onPressed: _saveActive,
          ),
          IconButton(
            tooltip: '从角色导入',
            icon: const Icon(Icons.download_outlined, size: 20),
            onPressed: _import,
          ),
          IconButton(
            tooltip: '批量分享',
            icon: const Icon(Icons.public, size: 20),
            onPressed: _batchShare,
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _list.isEmpty
              ? EmptyView(
                  text: '还没有人设模板\n可用右上角保存当前角色或从角色导入',
                  icon: Icons.bookmark_border,
                )
              : ListView.builder(
                  padding: const EdgeInsets.all(12),
                  itemCount: _list.length,
                  itemBuilder: (BuildContext ctx, int i) {
                    final CharacterTemplate t = _list[i];
                    return Container(
                      margin: const EdgeInsets.only(bottom: 8),
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: AppColors.white,
                        borderRadius: BorderRadius.circular(14),
                        border: Border.all(color: AppColors.sand),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Row(
                            children: <Widget>[
                              Expanded(
                                child: Text(
                                  t.name,
                                  style: const TextStyle(
                                    fontSize: 13,
                                    fontWeight: FontWeight.w600,
                                  ),
                                ),
                              ),
                              IconButton(
                                visualDensity: VisualDensity.compact,
                                icon: const Icon(Icons.ios_share, size: 17),
                                onPressed: () => _publish(t),
                              ),
                              IconButton(
                                visualDensity: VisualDensity.compact,
                                icon: const Icon(Icons.delete_outline, size: 17),
                                onPressed: () => _delete(t),
                              ),
                            ],
                          ),
                          Text(
                            '${t.profile['race'] ?? ''} ${t.profile['gender'] ?? ''}',
                            style: const TextStyle(
                              fontSize: 10.5,
                              color: AppColors.inkSoft,
                            ),
                          ),
                          Align(
                            alignment: Alignment.centerRight,
                            child: FilledButton(
                              onPressed: () => _apply(t),
                              style: FilledButton.styleFrom(
                                minimumSize: const Size(0, 34),
                                padding:
                                    const EdgeInsets.symmetric(horizontal: 12),
                              ),
                              child: const Text('应用创建角色'),
                            ),
                          ),
                        ],
                      ),
                    );
                  },
                ),
    );
  }
}
