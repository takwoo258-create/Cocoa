import 'package:flutter/material.dart';
import '../core/layout.dart';

import '../core/api_client.dart';
import '../core/app_state.dart';
import '../core/global.dart';
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
    _load();
  }

  @override
  void dispose() {
    _tagCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final AppState state = AppScope.read(context);
    try {
      final CharacterSettings s = await state.characterService
          .getSettings(widget.character.id);
      if (mounted) setState(() => _settings = s);
    } catch (_) {
      // 用列表里的缓存值兜底
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _save() async {
    final AppState state = AppScope.read(context);
    setState(() => _saving = true);
    try {
      final CharacterSettings saved = await state.characterService.saveSettings(
        widget.character.id,
        <String, dynamic>{
          'rss': _settings.rss.map((RssFeed f) => f.toJson()).toList(),
          'creationTags': _settings.creationTags,
          'creationFrequency': _settings.creationFrequency,
          'sleep': _settings.sleep.toJson(),
          'statusIntervalMin': _settings.statusIntervalMin,
          'activeReply': _settings.activeReply,
          'timezone': _settings.timezone,
          'qzoneEnabled': _settings.qzoneEnabled,
        },
      );
      if (!mounted) return;
      setState(() => _settings = saved);
      showToast('角色设置已保存');
    } on ApiException catch (e) {
      showToast(e.message, isError: true);
    } catch (e) {
      showToast('保存失败：$e', isError: true);
    } finally {
      if (mounted) setState(() => _saving = false);
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

  Future<void> _pickTime(String current, ValueChanged<String> onPicked) async {
    final List<String> parts = current.split(':');
    final TimeOfDay initial = TimeOfDay(
      hour: int.tryParse(parts.isNotEmpty ? parts[0] : '0') ?? 0,
      minute: int.tryParse(parts.length > 1 ? parts[1] : '0') ?? 0,
    );
    final TimeOfDay? picked = await showTimePicker(
      context: context,
      initialTime: initial,
      helpText: '选择时间',
    );
    if (picked == null) return;
    final String v =
        '${picked.hour.toString().padLeft(2, '0')}:${picked.minute.toString().padLeft(2, '0')}';
    setState(() => onPicked(v));
  }

  Widget _timeRow(String label, String value, ValueChanged<String> onPicked) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        children: <Widget>[
          SizedBox(
            width: 76,
            child: Text(
              label,
              style: const TextStyle(fontSize: 12.5, color: AppColors.inkSoft),
            ),
          ),
          OutlinedButton(
            onPressed: () => _pickTime(value, onPicked),
            style: OutlinedButton.styleFrom(
              minimumSize: const Size(0, 36),
              padding: const EdgeInsets.symmetric(horizontal: 14),
            ),
            child: Text(value, style: const TextStyle(fontSize: 13)),
          ),
        ],
      ),
    );
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
          Switch(value: value, onChanged: onChanged),
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
    final SleepSchedule sleep = _settings.sleep;
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
            title: '作息规划',
            child: Column(
              children: <Widget>[
                _bubble('启用作息', sleep.enabled, (bool v) {
                  setState(() {
                    _settings = _settings.copyWith(
                      sleep: sleep.copyWith(enabled: v),
                    );
                  });
                }),
                const Divider(height: 10),
                _timeRow('入睡', sleep.start, (String v) {
                  _settings = _settings.copyWith(sleep: sleep.copyWith(start: v));
                }),
                _timeRow('起床', sleep.end, (String v) {
                  _settings = _settings.copyWith(sleep: sleep.copyWith(end: v));
                }),
                _timeRow('午睡开始', sleep.napStart, (String v) {
                  _settings = _settings.copyWith(
                    sleep: sleep.copyWith(napStart: v),
                  );
                }),
                _timeRow('午睡结束', sleep.napEnd, (String v) {
                  _settings = _settings.copyWith(
                    sleep: sleep.copyWith(napEnd: v),
                  );
                }),
                const SizedBox(height: 4),
                const Text(
                  '角色休息时不会回复消息，凌晨提示「夜深了…」，午睡提示「在休息哦…」。',
                  style: TextStyle(fontSize: 10.5, color: AppColors.inkSoft),
                ),
              ],
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
