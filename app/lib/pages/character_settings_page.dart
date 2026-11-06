import 'package:flutter/material.dart';
import '../core/layout.dart';

import '../core/api_client.dart';
import '../core/app_state.dart';
import '../core/global.dart';
import '../core/json_utils.dart';
import '../core/theme.dart';
import '../models/character.dart';
import '../widgets/common.dart';

/// 角色设置：RSS 源、创作标签、创作频率、作息、状态刷新、主动回复。
class CharacterSettingsPage extends StatefulWidget {
  const CharacterSettingsPage({super.key, required this.character});

  final Character character;

  @override
  State<CharacterSettingsPage> createState() => _CharacterSettingsPageState();
}

class _CharacterSettingsPageState extends State<CharacterSettingsPage> {
  late CharacterSettings _settings;
  bool _loading = true;
  bool _saving = false;
  final TextEditingController _tagCtrl = TextEditingController();
  final TextEditingController _userAddress = TextEditingController();
  final TextEditingController _weatherCity = TextEditingController();

  static const List<String> _freqLabels = <String>['off', 'hourly', 'daily', 'weekly'];
  static const Map<String, String> _freqText = <String, String>{
    'off': '关闭创作',
    'hourly': '每小时',
    'daily': '每天',
    'weekly': '每周',
  };

  @override
  void initState() {
    super.initState();
    _settings = widget.character.settings;
    _userAddress.text = _settings.userAddress;
    _weatherCity.text = _settings.weatherCity;
    _load();
  }

  @override
  void dispose() {
    _tagCtrl.dispose();
    _userAddress.dispose();
    _weatherCity.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final AppState state = AppScope.read(context);
    try {
      final CharacterSettings s = await state.characterService
          .getSettings(widget.character.id);
      if (mounted) {
        setState(() {
          _settings = s;
          _userAddress.text = s.userAddress;
          _weatherCity.text = s.weatherCity;
        });
      }
    } catch (_) {
      // 用列表里的缓存值兜底
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _save({bool confirmReplace = false, bool quiet = false}) async {
    final AppState state = AppScope.read(context);
    setState(() => _saving = true);
    try {
      final CharacterSettings saved = await state.characterService.saveSettings(
        widget.character.id,
        <String, dynamic>{
          'rss': _settings.rss.map((RssFeed f) => f.toJson()).toList(),
          'creationTags': _settings.creationTags,
          'creationFrequency': _settings.creationFrequency,
          'statusIntervalMin': _settings.statusIntervalMin,
          'activeReply': _settings.activeReply,
          'timezone': _settings.timezone,
          'qzoneEnabled': _settings.qzoneEnabled,
          'userAddress': _userAddress.text.trim(),
          'weatherCity': _weatherCity.text.trim().isEmpty
              ? '宣城'
              : _weatherCity.text.trim(),
          'qqEnabled': _settings.qqEnabled,
          if (confirmReplace) 'confirmReplace': true,
        },
      );
      if (!mounted) return;
      setState(() {
        _settings = saved;
        _userAddress.text = saved.userAddress;
        _weatherCity.text = saved.weatherCity;
      });
      if (!quiet) {
        showToast(confirmReplace ? 'QQ 接入角色已更换' : '角色设置已保存');
      }
    } on ApiException catch (e) {
      if (e.code == 'qq_binding_conflict') {
        if (mounted) setState(() => _saving = false);
        await _handleBindingConflict(e);
        return;
      }
      showToast(e.message, isError: true);
    } catch (e) {
      showToast('保存失败：$e', isError: true);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _toggleEnabled(bool value) async {
    final AppState state = AppScope.read(context);
    setState(() => _settings = _settings.copyWith(enabled: value));
    try {
      final CharacterSettings saved = await state.characterService.saveSettings(
        widget.character.id,
        <String, dynamic>{'enabled': value},
      );
      if (mounted) setState(() => _settings = saved);
      showToast(value ? '角色已恢复运行' : '角色已暂停，所有活动与消耗已停止');
    } catch (e) {
      if (mounted) {
        setState(() => _settings = _settings.copyWith(enabled: !value));
        showToast('保存失败：$e', isError: true);
      }
    }
  }

  Future<void> _handleBindingConflict(ApiException e) async {
    final Map<String, dynamic> detail = asMap(e.detail);
    final Map<String, dynamic> current = asMap(detail['current']);
    final Map<String, dynamic> next = asMap(detail['next']);
    final String currentName = asString(current['name'], '原角色');
    final String nextName = asString(next['name'], widget.character.name);
    final bool? ok = await showDialog<bool>(
      context: context,
      builder: (BuildContext ctx) => AlertDialog(
        title: const Text('是否更换接入对象？'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            const Text(
              'QQ 当前已接入另一位角色。确认后将切换为当前角色，原角色会自动关闭接入。',
              style: TextStyle(fontSize: 11.5, color: AppColors.inkSoft, height: 1.5),
            ),
            const SizedBox(height: 12),
            Center(
              child: Text(
                '$currentName >>>> $nextName',
                style: const TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w700,
                  color: AppColors.cocoa,
                ),
              ),
            ),
          ],
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('确认更换'),
          ),
        ],
      ),
    );
    if (ok == true) {
      await _save(confirmReplace: true);
    }
  }

  Future<void> _addRss() async {
    final TextEditingController urlCtrl = TextEditingController();
    final TextEditingController nameCtrl = TextEditingController();
    final bool? ok = await showDialog<bool>(
      context: context,
      builder: (BuildContext ctx) => AlertDialog(
        title: const Text('添加 RSS 源'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            TextField(
              controller: urlCtrl,
              keyboardType: TextInputType.url,
              decoration: const InputDecoration(
                labelText: 'RSS 地址',
                hintText: 'https://example.com/feed.xml',
              ),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: nameCtrl,
              decoration: const InputDecoration(labelText: '名称（可选）'),
            ),
          ],
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('添加'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    final String url = urlCtrl.text.trim();
    if (url.isEmpty) return;
    setState(() {
      _settings = _settings.copyWith(
        rss: <RssFeed>[
          ..._settings.rss,
          RssFeed(name: nameCtrl.text.trim().isEmpty ? url : nameCtrl.text.trim(), url: url),
        ],
      );
    });
    urlCtrl.dispose();
    nameCtrl.dispose();
  }

  Widget _bubble(String label, bool value, ValueChanged<bool> onChanged) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Text(
              label,
              style: const TextStyle(fontSize: 12.5, color: AppColors.ink),
            ),
          ),
          Switch(
            value: value,
            onChanged: (bool v) {
              onChanged(v);
              _save(quiet: true);
            },
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return Scaffold(
        appBar: AppBar(title: Text('${widget.character.name} · 角色设置')),
        body: const LoadingView(),
      );
    }
    return Scaffold(
      appBar: AppBar(
        title: Text('${widget.character.name} · 角色设置'),
        actions: <Widget>[
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
        padding: pagePadding(context, top: 0, bottom: 30),
        children: <Widget>[
          SectionCard(
            title: 'RSS 订阅源',
            trailing: IconButton(
              icon: const Icon(Icons.add, size: 18),
              onPressed: _addRss,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                if (_settings.rss.isEmpty)
                  const Text(
                    '还没有订阅源，角色将无法阅读外部新闻',
                    style: TextStyle(fontSize: 11.5, color: AppColors.inkSoft),
                  ),
                ..._settings.rss.asMap().entries.map((MapEntry<int, RssFeed> e) {
                  final RssFeed feed = e.value;
                  return Row(
                    children: <Widget>[
                      Switch(
                        value: feed.enabled,
                        onChanged: (bool v) {
                          final List<RssFeed> next =
                              List<RssFeed>.from(_settings.rss);
                          next[e.key] = feed.copyWith(enabled: v);
                          setState(() {
                            _settings = _settings.copyWith(rss: next);
                          });
                        },
                      ),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: <Widget>[
                            Text(
                              feed.name,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontSize: 12.5),
                            ),
                            Text(
                              feed.url,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                fontSize: 10,
                                color: AppColors.inkSoft,
                              ),
                            ),
                          ],
                        ),
                      ),
                      IconButton(
                        icon: const Icon(Icons.delete_outline, size: 17),
                        onPressed: () {
                          final List<RssFeed> next =
                              List<RssFeed>.from(_settings.rss)..removeAt(e.key);
                          setState(() {
                            _settings = _settings.copyWith(rss: next);
                          });
                        },
                      ),
                    ],
                  );
                }),
              ],
            ),
          ),
          SectionCard(
            title: '称呼与 QQ',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                TextField(
                  controller: _userAddress,
                  decoration: const InputDecoration(
                    labelText: '对我的称呼',
                    hintText: '留空则使用昵称',
                    helperText: '角色会用这个称呼称呼你',
                  ),
                ),
                const SizedBox(height: 6),
                _bubble('接入 QQ', _settings.qqEnabled, (bool v) {
                  setState(() {
                    _settings = _settings.copyWith(qqEnabled: v);
                  });
                }),
                const SizedBox(height: 6),
                TextField(
                  controller: _weatherCity,
                  decoration: const InputDecoration(
                    labelText: '天气城市',
                    hintText: '默认 宣城',
                    helperText: '用于角色所在世界的天气，仅对本角色生效',
                  ),
                ),
                const Text(
                  '全账号仅一位角色可接入 QQ；若已有其他角色接入，保存时会询问是否更换接入对象。',
                  style: TextStyle(fontSize: 10.5, color: AppColors.inkSoft),
                ),
              ],
            ),
          ),
          SectionCard(
            title: '运行状态',
            child: SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('角色运行', style: TextStyle(fontSize: 13)),
              subtitle: Text(
                _settings.enabled
                    ? '运行中：聊天、状态刷新、主动回复与创作按设置进行'
                    : '已暂停：停止所有活动与 token 消耗；聊天页将显示暂停提示',
                style: const TextStyle(fontSize: 10.5, color: AppColors.inkSoft),
              ),
              value: _settings.enabled,
              onChanged: _toggleEnabled,
            ),
          ),
          SectionCard(
            title: '创作标签',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Wrap(
                  children: _settings.creationTags
                      .map((String tag) => PillTag(
                            text: tag,
                            onDelete: () {
                              setState(() {
                                _settings = _settings.copyWith(
                                  creationTags: _settings.creationTags
                                      .where((String t) => t != tag)
                                      .toList(),
                                );
                              });
                            },
                          ))
                      .toList(),
                ),
                Row(
                  children: <Widget>[
                    Expanded(
                      child: TextField(
                        controller: _tagCtrl,
                        decoration: const InputDecoration(
                          hintText: '添加标签，如 日常 / 幻想',
                          isDense: true,
                        ),
                        onSubmitted: (String v) {
                          final String tag = v.trim();
                          if (tag.isEmpty) return;
                          setState(() {
                            _settings = _settings.copyWith(
                              creationTags: <String>[
                                ..._settings.creationTags,
                                tag,
                              ],
                            );
                          });
                          _tagCtrl.clear();
                        },
                      ),
                    ),
                    const SizedBox(width: 8),
                    IconButton(
                      icon: const Icon(Icons.add_circle_outline, size: 20),
                      onPressed: () {
                        final String tag = _tagCtrl.text.trim();
                        if (tag.isEmpty) return;
                        setState(() {
                          _settings = _settings.copyWith(
                            creationTags: <String>[
                              ..._settings.creationTags,
                              tag,
                            ],
                          );
                        });
                        _tagCtrl.clear();
                      },
                    ),
                  ],
                ),
              ],
            ),
          ),
          SectionCard(
            title: '创作频率',
            child: Wrap(
              spacing: 8,
              children: _freqLabels.map((String key) {
                final bool active = _settings.creationFrequency == key;
                return ChoiceChip(
                  label: Text(_freqText[key] ?? key),
                  selected: active,
                  onSelected: (_) => setState(() {
                    _settings = _settings.copyWith(creationFrequency: key);
                  }),
                );
              }).toList(),
            ),
          ),
          SectionCard(
            title: '状态与主动回复',
            child: Column(
              children: <Widget>[
                Row(
                  children: <Widget>[
                    const Expanded(
                      child: Text(
                        '状态刷新间隔',
                        style: TextStyle(fontSize: 12.5),
                      ),
                    ),
                    DropdownButton<int>(
                      value: _settings.statusIntervalMin <= 0
                          ? 10
                          : _settings.statusIntervalMin,
                      items: <int>[5, 10, 15, 30, 60, 120, 240]
                          .map(
                            (int v) => DropdownMenuItem<int>(
                              value: v,
                              child: Text('$v 分钟',
                                  style: const TextStyle(fontSize: 12.5)),
                            ),
                          )
                          .toList(),
                      onChanged: (int? v) {
                        if (v == null) return;
                        setState(() {
                          _settings = _settings.copyWith(statusIntervalMin: v);
                        });
                        _save(quiet: true);
                      },
                    ),
                  ],
                ),
                _bubble('主动回复', _settings.activeReply, (bool v) {
                  setState(() {
                    _settings = _settings.copyWith(activeReply: v);
                  });
                }),
                const Text(
                  '开启后角色会在等待期结束后主动追问或发来消息。',
                  style: TextStyle(fontSize: 10.5, color: AppColors.inkSoft),
                ),
                const Divider(height: 14),
                _bubble('允许角色发 QQ 动态', _settings.qzoneEnabled, (bool v) {
                  setState(() {
                    _settings = _settings.copyWith(qzoneEnabled: v);
                  });
                }),
                const Text(
                  '开启后角色可把创作/阅读感想以动态形式发到绑定的 QQ 空间（需管理员配置 NapCat）。',
                  style: TextStyle(fontSize: 10.5, color: AppColors.inkSoft),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
            child: FilledButton(
              onPressed: _saving ? null : _save,
              child: const Text('保存角色设置'),
            ),
          ),
        ],
      ),
    );
  }
}
