import 'package:flutter/material.dart';

import '../core/api_client.dart';
import '../core/app_state.dart';
import '../core/global.dart';
import '../core/json_utils.dart';
import '../core/layout.dart';
import '../core/theme.dart';
import '../core/utils.dart';
import '../models/character.dart';
import '../widgets/common.dart';
import 'api_setup_dialog.dart';
import 'character_edit_page.dart';
import 'character_settings_page.dart';
import 'character_status_page.dart';
import 'chat_page.dart';
import 'memory_page.dart';

class CharacterListPage extends StatefulWidget {
  const CharacterListPage({super.key});

  @override
  CharacterListPageState createState() => CharacterListPageState();
}

class CharacterListPageState extends State<CharacterListPage> {
  List<Character> _characters = <Character>[];
  bool _loading = true;
  String? _error;
  String _botQQ = '';
  bool _botConnected = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> reload() => _load(showLoading: false);

  Future<void> _load({bool showLoading = true}) async {
    final AppState state = AppScope.read(context);
    if (!state.loggedIn) {
      if (mounted) setState(() => _loading = false);
      return;
    }
    if (showLoading && mounted) setState(() => _loading = true);
    try {
      final List<Character> list = await state.characterService.list();
      if (!mounted) return;
      setState(() {
        _characters = list;
        _error = null;
      });
      if (list.isNotEmpty) {
        final bool exists = list
            .any((Character c) => c.id == state.activeCharacterId);
        if (!exists) {
          await state.setActiveCharacter(list.first.id);
        }
      }
      await _loadOnebotStatus(state);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _loadOnebotStatus(AppState state) async {
    try {
      final Map<String, dynamic> status = await state.socialService.onebotStatus();
      if (!mounted) return;
      setState(() {
        _botQQ = asString(status['selfId']);
        final bool online = status.containsKey('connected')
            ? asBool(status['connected'])
            : asBool(status['online'], true);
        _botConnected = _botQQ.isNotEmpty && online;
      });
    } catch (_) {
      if (mounted) {
        setState(() {
          _botQQ = '';
          _botConnected = false;
        });
      }
    }
  }

  Future<void> createCharacter({Map<String, dynamic>? initialProfile}) async {
    final bool? created = await Navigator.of(context).push<bool>(
      MaterialPageRoute<bool>(
        builder: (_) => CharacterEditPage(initialProfile: initialProfile),
      ),
    );
    if (created == true) await _load(showLoading: false);
  }

  Future<void> _openChat(Character c) async {
    final AppState state = AppScope.read(context);
    if (!state.chatReady) {
      await ApiSetupDialog.show(context, force: true);
      if (!state.chatReady) return;
    }
    await state.setActiveCharacter(c.id);
    if (!mounted) return;
    await Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => ChatPage(character: c)),
    );
    if (mounted) await _load(showLoading: false);
  }

  Future<void> _openSettings(Character c) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => CharacterSettingsPage(character: c),
      ),
    );
    if (mounted) await _load(showLoading: false);
  }

  Future<void> _openMemory(Character c) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => MemoryPage(character: c)),
    );
  }

  Future<void> _openStatus(Character c) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => CharacterStatusPage(character: c),
      ),
    );
  }

  Future<void> _edit(Character c) async {
    final bool? updated = await Navigator.of(context).push<bool>(
      MaterialPageRoute<bool>(builder: (_) => CharacterEditPage(character: c)),
    );
    if (updated == true) await _load(showLoading: false);
  }

  Future<void> _delete(Character c) async {
    final AppState state = AppScope.read(context);
    final bool ok = await confirmDialog(
      context,
      title: '删除角色',
      message: '确定删除「${c.name}」吗？该角色的记忆、创作、对话记录会一并删除，无法恢复。',
      confirmText: '删除',
      danger: true,
    );
    if (!ok) return;
    try {
      await state.characterService.delete(c.id);
      showToast('已删除「${c.name}」');
      if (state.activeCharacterId == c.id) {
        await state.setActiveCharacter(null);
      }
      await _load(showLoading: false);
    } on ApiException catch (e) {
      showToast(e.message, isError: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final AppState state = AppScope.of(context);
    if (!state.chatReady) {
      return Column(
        children: <Widget>[
          _configBanner(state),
          Expanded(child: _body(state)),
        ],
      );
    }
    return _body(state);
  }

  Widget _configBanner(AppState state) {
    return GestureDetector(
      onTap: () async {
        await ApiSetupDialog.show(context, force: true);
        await _load(showLoading: false);
      },
      child: Container(
        margin: const EdgeInsets.fromLTRB(12, 8, 12, 2),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          color: AppColors.warn.withAlpha(24),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: AppColors.warn.withAlpha(90)),
        ),
        child: const Row(
          children: <Widget>[
            Icon(Icons.key_outlined, size: 16, color: AppColors.warn),
            SizedBox(width: 8),
            Expanded(
              child: Text(
                '模型服务尚未配置，点击完成配置后才能开始对话',
                style: TextStyle(fontSize: 12, color: AppColors.warn),
              ),
            ),
            Icon(Icons.chevron_right, size: 16, color: AppColors.warn),
          ],
        ),
      ),
    );
  }

  Widget _body(AppState state) {
    if (_loading) return const LoadingView();
    if (_error != null) {
      return EmptyView(
        text: '角色加载失败\n$_error',
        icon: Icons.cloud_off,
        action: OutlinedButton(
          onPressed: () => _load(),
          child: const Text('重试'),
        ),
      );
    }
    if (_characters.isEmpty) {
      return EmptyView(
        text: '还没有角色\n创建第一个角色，开始你们的陪伴日常',
        icon: Icons.favorite_border,
        action: FilledButton.icon(
          onPressed: () => createCharacter(),
          icon: const Icon(Icons.add, size: 18),
          label: const Text('创建角色'),
        ),
      );
    }
    final Widget header = Padding(
      padding: const EdgeInsets.only(bottom: 8, left: 2),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Text(
              '${greeting()}，${state.user?.displayName ?? ''} · 共 ${_characters.length} 位角色',
              style: const TextStyle(fontSize: 12, color: AppColors.inkSoft),
            ),
          ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            decoration: BoxDecoration(
              color: _botConnected
                  ? AppColors.success.withAlpha(24)
                  : AppColors.sand,
              borderRadius: BorderRadius.circular(8),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Icon(
                  Icons.smart_toy_outlined,
                  size: 12,
                  color: _botConnected ? AppColors.success : AppColors.inkSoft,
                ),
                const SizedBox(width: 4),
                Text(
                  _botConnected && _botQQ.isNotEmpty ? 'QQ $_botQQ' : '未连接',
                  style: TextStyle(
                    fontSize: 10,
                    color: _botConnected ? AppColors.success : AppColors.inkSoft,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
    final int cols = responsiveColumns(context);
    return ContentFrame(
      maxWidth: 1200,
      child: RefreshIndicator(
        onRefresh: () => _load(showLoading: false),
        child: LayoutBuilder(
          builder: (BuildContext context, BoxConstraints c) {
            if (cols <= 1) {
              return ListView.builder(
                padding: const EdgeInsets.fromLTRB(12, 8, 12, 20),
                itemCount: _characters.length + 1,
                itemBuilder: (BuildContext context, int i) {
                  if (i == 0) return header;
                  return _card(_characters[i - 1]);
                },
              );
            }
            final double itemWidth =
                (c.maxWidth - 24 - (cols - 1) * 12) / cols;
            return ListView(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 20),
              children: <Widget>[
                header,
                Wrap(
                  spacing: 12,
                  runSpacing: 12,
                  children: _characters
                      .map(
                        (Character ch) => SizedBox(
                          width: itemWidth,
                          child: _card(ch),
                        ),
                      )
                      .toList(),
                ),
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _card(Character c) {
    final bool sleeping = c.state.resting;
    return GestureDetector(
      onTap: () => _openChat(c),
      onLongPress: () => _showActions(c),
      child: Container(
        margin: const EdgeInsets.only(bottom: 12),
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: <Color>[AppColors.white, AppColors.sand.withAlpha(120)],
          ),
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: AppColors.sand),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                Container(
                  width: 52,
                  height: 52,
                  decoration: const BoxDecoration(
                    gradient: kCocoaGradient,
                    shape: BoxShape.circle,
                  ),
                  child: Center(
                    child: Text(
                      c.name.isEmpty ? '?' : c.name.characters.first,
                      style: const TextStyle(
                        color: Colors.white,
                        fontSize: 20,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Row(
                        children: <Widget>[
                          Text(
                            c.name,
                            style: const TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          const SizedBox(width: 6),
                          if (sleeping)
                            Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 6,
                                vertical: 2,
                              ),
                              decoration: BoxDecoration(
                                color: AppColors.inkSoft.withAlpha(30),
                                borderRadius: BorderRadius.circular(6),
                              ),
                              child: Text(
                                c.state.sleepLabel,
                                style: const TextStyle(
                                  fontSize: 9.5,
                                  color: AppColors.inkSoft,
                                ),
                              ),
                            ),
                        ],
                      ),
                      const SizedBox(height: 3),
                      Text(
                        c.subtitle.isEmpty ? '尚未填写人设' : c.subtitle,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 11.5,
                          color: AppColors.inkSoft,
                        ),
                      ),
                    ],
                  ),
                ),
                IconButton(
                  visualDensity: VisualDensity.compact,
                  icon: const Icon(Icons.more_horiz, size: 20),
                  onPressed: () => _showActions(c),
                ),
              ],
            ),
            if (c.state.motion.isNotEmpty || c.state.mood.isNotEmpty) ...<Widget>[
              const SizedBox(height: 10),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
                decoration: BoxDecoration(
                  color: AppColors.white.withAlpha(150),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Text(
                  '${c.state.moodEmoji} ${c.state.motion}${c.state.mood.isEmpty ? '' : ' · ${c.state.mood}'}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 11.5, color: AppColors.ink),
                ),
              ),
            ],
            const SizedBox(height: 10),
            Row(
              children: <Widget>[
                _metric(Icons.favorite, '亲密度 ${c.state.intimacy.toStringAsFixed(0)}'),
                const SizedBox(width: 14),
                _metric(Icons.calendar_today_outlined, '陪伴 ${c.state.companionDays} 天'),
                const SizedBox(width: 14),
                _metric(Icons.chat_bubble_outline, '${c.state.chatCount} 句'),
                const Spacer(),
                if (c.archived)
                  const Text(
                    '已归档',
                    style: TextStyle(fontSize: 10, color: AppColors.inkSoft),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _metric(IconData icon, String text) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Icon(icon, size: 12, color: AppColors.rose),
        const SizedBox(width: 3),
        Text(
          text,
          style: const TextStyle(fontSize: 10.5, color: AppColors.inkSoft),
        ),
      ],
    );
  }

  void _showActions(Character c) {
    showModalBottomSheet<void>(
      context: context,
      builder: (BuildContext ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            ListTile(
              leading: const Icon(Icons.chat_bubble_outline),
              title: const Text('开始对话'),
              onTap: () {
                Navigator.of(ctx).pop();
                _openChat(c);
              },
            ),
            ListTile(
              leading: const Icon(Icons.edit_outlined),
              title: const Text('编辑人设'),
              onTap: () {
                Navigator.of(ctx).pop();
                _edit(c);
              },
            ),
            ListTile(
              leading: const Icon(Icons.tune),
              title: const Text('角色设置'),
              onTap: () {
                Navigator.of(ctx).pop();
                _openSettings(c);
              },
            ),
            ListTile(
              leading: const Icon(Icons.monitor_heart_outlined),
              title: const Text('角色状态'),
              onTap: () {
                Navigator.of(ctx).pop();
                _openStatus(c);
              },
            ),
            ListTile(
              leading: const Icon(Icons.hub_outlined),
              title: const Text('记忆图谱'),
              onTap: () {
                Navigator.of(ctx).pop();
                _openMemory(c);
              },
            ),
            ListTile(
              leading: const Icon(Icons.copy_all_outlined),
              title: const Text('另存为模板'),
              onTap: () async {
                Navigator.of(ctx).pop();
                await _saveAsTemplate(c);
              },
            ),
            ListTile(
              leading: const Icon(Icons.delete_outline, color: AppColors.danger),
              title: const Text(
                '删除角色',
                style: TextStyle(color: AppColors.danger),
              ),
              onTap: () {
                Navigator.of(ctx).pop();
                _delete(c);
              },
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _saveAsTemplate(Character c) async {
    final AppState state = AppScope.read(context);
    final TextEditingController nameCtrl =
        TextEditingController(text: '${c.name} 模板');
    final bool? ok = await showDialog<bool>(
      context: context,
      builder: (BuildContext ctx) => AlertDialog(
        title: const Text('另存为模板'),
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
        profile: c.profileJson(),
      );
      showToast('模板已保存');
    } on ApiException catch (e) {
      showToast(e.message, isError: true);
    }
  }
}
