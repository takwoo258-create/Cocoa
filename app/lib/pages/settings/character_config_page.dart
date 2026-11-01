import 'package:flutter/material.dart';

import '../../core/api_client.dart';
import '../../core/app_state.dart';
import '../../core/global.dart';
import '../../models/character.dart';
import '../../widgets/common.dart';
import '../character_settings_page.dart';

/// 角色配置二级页：选择角色后进入其 RSS / 创作 / 作息 / QQ 动态设置。
class CharacterConfigPage extends StatefulWidget {
  const CharacterConfigPage({super.key});

  @override
  State<CharacterConfigPage> createState() => _CharacterConfigPageState();
}

class _CharacterConfigPageState extends State<CharacterConfigPage> {
  List<Character> _characters = <Character>[];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    final AppState state = AppScope.read(context);
    if (mounted) setState(() => _loading = true);
    try {
      final List<Character> list = await state.characterService.list();
      if (!mounted) return;
      setState(() {
        _characters = list;
        _loading = false;
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _loading = false);
      showToast(e.message, isError: true);
    } catch (e) {
      if (mounted) setState(() => _loading = false);
      showToast('角色加载失败：$e', isError: true);
    }
  }

  Future<void> _open(Character c) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => CharacterSettingsPage(character: c),
      ),
    );
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('角色配置'),
        actions: <Widget>[
          IconButton(
            icon: const Icon(Icons.refresh, size: 20),
            onPressed: _load,
          ),
        ],
      ),
      body: _loading
          ? const LoadingView()
          : _characters.isEmpty
              ? const EmptyView(
                  text: '还没有角色\n请先在「角色」页创建一位角色',
                  icon: Icons.favorite_border,
                )
              : ListView(
                  padding: const EdgeInsets.fromLTRB(12, 8, 12, 20),
                  children: <Widget>[
                    const Padding(
                      padding: EdgeInsets.fromLTRB(4, 0, 4, 8),
                      child: Text(
                        '每个角色的设置相互独立：RSS 源、创作标签/频率、作息、主动回复、QQ 动态开关。',
                        style: TextStyle(
                          fontSize: 10.5,
                          color: Color(0xFF7A6558),
                          height: 1.5,
                        ),
                      ),
                    ),
                    ..._characters.map(
                      (Character c) => Container(
                        margin: const EdgeInsets.only(bottom: 10),
                        decoration: BoxDecoration(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(14),
                          border: Border.all(color: const Color(0xFFF0E1D0)),
                        ),
                        child: ListTile(
                          leading: CircleAvatar(
                            radius: 18,
                            backgroundColor: const Color(0xFF6F4E37),
                            child: Text(
                              c.name.isEmpty ? '?' : c.name.characters.first,
                              style: const TextStyle(
                                color: Colors.white,
                                fontSize: 14,
                              ),
                            ),
                          ),
                          title: Text(
                            c.name,
                            style: const TextStyle(fontSize: 13.5),
                          ),
                          subtitle: Text(
                            c.subtitle.isEmpty ? '尚未填写人设' : c.subtitle,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontSize: 10.5),
                          ),
                          trailing: const Icon(Icons.chevron_right, size: 18),
                          onTap: () => _open(c),
                        ),
                      ),
                    ),
                  ],
                ),
    );
  }
}
