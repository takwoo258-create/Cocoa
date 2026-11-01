import 'package:flutter/material.dart';

import '../../core/api_client.dart';
import '../../core/app_state.dart';
import '../../core/constants.dart';
import '../../core/global.dart';
import '../../core/layout.dart';
import '../../core/theme.dart';
import '../../models/model_share.dart';
import '../../widgets/common.dart';

/// v1.2.0：模型分享/索要管理。
class SharesPage extends StatefulWidget {
  const SharesPage({super.key});

  @override
  State<SharesPage> createState() => _SharesPageState();
}

class _SharesPageState extends State<SharesPage>
    with SingleTickerProviderStateMixin {
  static const List<String> _boxes = <String>['outgoing', 'incoming', 'pending'];
  static const List<String> _titles = <String>['我的分享', '收到的分享', '待处理'];

  late final TabController _tab;
  final Map<String, List<ModelShare>> _data = <String, List<ModelShare>>{};
  final Set<String> _loading = <String>{};

  @override
  void initState() {
    super.initState();
    _tab = TabController(length: _boxes.length, vsync: this);
    _tab.addListener(_onTab);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      for (final String box in _boxes) {
        _load(box);
      }
    });
  }

  @override
  void dispose() {
    _tab.removeListener(_onTab);
    _tab.dispose();
    super.dispose();
  }

  void _onTab() {
    if (_tab.indexIsChanging) return;
    _load(_boxes[_tab.index]);
  }

  Future<void> _load(String box) async {
    final AppState state = AppScope.read(context);
    if (mounted) setState(() => _loading.add(box));
    try {
      final List<ModelShare> list =
          await state.shareService.list(box: box);
      if (!mounted) return;
      setState(() => _data[box] = list);
    } on ApiException catch (e) {
      if (mounted) showToast(e.message, isError: true);
    } catch (e) {
      if (mounted) showToast('分享列表加载失败：$e', isError: true);
    } finally {
      if (mounted) setState(() => _loading.remove(box));
    }
  }

  Future<void> _reloadAll() async {
    for (final String box in _boxes) {
      await _load(box);
    }
  }

  Future<void> _respond(ModelShare share, bool accept) async {
    final AppState state = AppScope.read(context);
    try {
      await state.shareService.respond(share.id, accept);
      if (!mounted) return;
      showToast(accept ? '已接受分享' : '已拒绝分享');
      await _reloadAll();
    } on ApiException catch (e) {
      showToast(e.message, isError: true);
    }
  }

  Future<void> _revoke(ModelShare share) async {
    final bool ok = await confirmDialog(
      context,
      title: '撤销分享',
      message: '撤销后对方将不再能使用该服务，确定撤销吗？',
      confirmText: '撤销',
      danger: true,
    );
    if (!ok) return;
    final AppState state = AppScope.read(context);
    try {
      await state.shareService.revoke(share.id);
      if (!mounted) return;
      showToast('已撤销');
      await _reloadAll();
    } on ApiException catch (e) {
      showToast(e.message, isError: true);
    }
  }

  Future<void> _create() async {
    final bool? created = await showDialog<bool>(
      context: context,
      builder: (_) => const _ShareCreateDialog(),
    );
    if (created == true) await _reloadAll();
  }

  Widget _shareCard(ModelShare share, String box) {
    final bool request = share.direction == 'request' || share.direction == 'incoming';
    final bool incoming = box == 'incoming' || request;
    final String other =
        box == 'outgoing' ? share.target.label : share.owner.label;
    final String relation;
    if (box == 'incoming') {
      relation = request ? '$other 向你索要' : '来自 $other';
    } else if (box == 'outgoing') {
      relation = request ? '向 $other 索要' : '分享给 $other';
    } else {
      relation = request ? '$other 向你索要' : '来自 $other';
    }
    final List<String> serviceLabels = share.services
        .map((String s) => kServiceLabels[s] ?? s)
        .toList();
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 6, 12, 6),
      padding: const EdgeInsets.all(13),
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
              Icon(
                incoming ? Icons.call_received : Icons.call_made,
                size: 16,
                color: incoming ? AppColors.rose : AppColors.cocoa,
              ),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  relation,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                decoration: BoxDecoration(
                  color: share.isPending
                      ? AppColors.warn.withAlpha(28)
                      : AppColors.sand,
                  borderRadius: BorderRadius.circular(7),
                ),
                child: Text(
                  share.statusLabel,
                  style: TextStyle(
                    fontSize: 9.5,
                    color: share.isPending ? AppColors.warn : AppColors.inkSoft,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            '服务：${serviceLabels.isEmpty ? '—' : serviceLabels.join('、')}',
            style: const TextStyle(fontSize: 11.5, color: AppColors.inkSoft),
          ),
          const SizedBox(height: 3),
          Text(
            '有效期：${share.timeLabel}',
            style: const TextStyle(fontSize: 11.5, color: AppColors.inkSoft),
          ),
          if (share.note.isNotEmpty) ...<Widget>[
            const SizedBox(height: 3),
            Text(
              '备注：${share.note}',
              style: const TextStyle(fontSize: 11, color: AppColors.inkSoft),
            ),
          ],
          if (share.canRespond && share.isPending) ...<Widget>[
            const SizedBox(height: 8),
            Row(
              children: <Widget>[
                Expanded(
                  child: OutlinedButton(
                    onPressed: () => _respond(share, false),
                    style: OutlinedButton.styleFrom(
                      minimumSize: const Size(0, 36),
                      foregroundColor: AppColors.danger,
                      side: const BorderSide(color: AppColors.danger),
                    ),
                    child: const Text('拒绝'),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: FilledButton(
                    onPressed: () => _respond(share, true),
                    style: FilledButton.styleFrom(
                      minimumSize: const Size(0, 36),
                    ),
                    child: const Text('接受'),
                  ),
                ),
              ],
            ),
          ],
          if (box == 'outgoing' &&
              (share.isPending || share.isAccepted)) ...<Widget>[
            const SizedBox(height: 6),
            Align(
              alignment: Alignment.centerRight,
              child: TextButton(
                onPressed: () => _revoke(share),
                style: TextButton.styleFrom(
                  minimumSize: const Size(0, 30),
                  foregroundColor: AppColors.danger,
                  textStyle: const TextStyle(fontSize: 11.5),
                ),
                child: const Text('撤销分享'),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _list(String box) {
    if (_loading.contains(box) && !_data.containsKey(box)) {
      return const LoadingView();
    }
    final List<ModelShare> items = _data[box] ?? const <ModelShare>[];
    if (items.isEmpty) {
      return EmptyView(
        text: box == 'pending'
            ? '没有待处理的分享请求'
            : '还没有${_titles[_boxes.indexOf(box)]}',
        icon: Icons.swap_horiz,
      );
    }
    return RefreshIndicator(
      onRefresh: () => _load(box),
      child: ListView.builder(
        padding: const EdgeInsets.only(bottom: 90),
        itemCount: items.length,
        itemBuilder: (BuildContext ctx, int i) => _shareCard(items[i], box),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('模型分享'),
        actions: <Widget>[
          IconButton(
            tooltip: '刷新',
            icon: const Icon(Icons.refresh, size: 20),
            onPressed: _reloadAll,
          ),
        ],
        bottom: TabBar(
          controller: _tab,
          tabs: _titles.map((String t) => Tab(text: t)).toList(),
        ),
      ),
      body: ContentFrame(
        maxWidth: 760,
        child: TabBarView(
          controller: _tab,
          children: _boxes.map(_list).toList(),
        ),
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _create,
        backgroundColor: AppColors.cocoa,
        foregroundColor: Colors.white,
        icon: const Icon(Icons.add, size: 20),
        label: const Text('新建分享/索要'),
      ),
    );
  }
}

/// 新建分享/索要对话框。
class _ShareCreateDialog extends StatefulWidget {
  const _ShareCreateDialog();

  @override
  State<_ShareCreateDialog> createState() => _ShareCreateDialogState();
}

class _ShareCreateDialogState extends State<_ShareCreateDialog> {
  final TextEditingController _target = TextEditingController();
  final TextEditingController _note = TextEditingController();
  final TextEditingController _seconds = TextEditingController(text: '0');
  final Map<String, TextEditingController> _duration = <String, TextEditingController>{
    'years': TextEditingController(),
    'months': TextEditingController(),
    'weeks': TextEditingController(),
    'days': TextEditingController(),
    'hours': TextEditingController(),
    'minutes': TextEditingController(),
  };
  String _direction = 'share';
  String _mode = 'duration';
  final Set<String> _services = <String>{'chat'};
  DateTime? _deadline;
  bool _busy = false;

  @override
  void dispose() {
    _target.dispose();
    _note.dispose();
    _seconds.dispose();
    for (final TextEditingController c in _duration.values) {
      c.dispose();
    }
    super.dispose();
  }

  int _value(String key) => int.tryParse(_duration[key]!.text.trim()) ?? 0;

  /// 用户选择的是 UTC+8 墙上时间，直接按选择值格式化，不随设备时区偏移。
  String _utc8Text(DateTime local) {
    final int sec = (int.tryParse(_seconds.text.trim()) ?? 0).clamp(0, 59);
    String two(int v) => v < 10 ? '0$v' : '$v';
    return '${local.year}-${two(local.month)}-${two(local.day)} '
        '${two(local.hour)}:${two(local.minute)}:${two(sec)}';
  }

  Future<void> _pickDeadline() async {
    final DateTime now = DateTime.now();
    final DateTime? date = await showDatePicker(
      context: context,
      firstDate: now,
      lastDate: now.add(const Duration(days: 3650)),
      initialDate: _deadline ?? now.add(const Duration(days: 7)),
    );
    if (date == null || !mounted) return;
    final TimeOfDay? time = await showTimePicker(
      context: context,
      initialTime: TimeOfDay.fromDateTime(_deadline ?? now),
    );
    if (time == null) return;
    setState(() {
      _deadline = DateTime(
        date.year,
        date.month,
        date.day,
        time.hour,
        time.minute,
      );
    });
  }

  Future<void> _submit() async {
    final AppState state = AppScope.read(context);
    final String target = _target.text.trim();
    if (target.isEmpty) {
      showToast('请输入对方代号或邮箱');
      return;
    }
    if (_services.isEmpty) {
      showToast('请至少选择一项服务');
      return;
    }
    final ShareDuration duration = ShareDuration(
      years: _value('years'),
      months: _value('months'),
      weeks: _value('weeks'),
      days: _value('days'),
      hours: _value('hours'),
      minutes: _value('minutes'),
    );
    if (_mode == 'duration' && duration.isZero) {
      showToast('请填写分享时长');
      return;
    }
    if (_mode == 'deadline' && _deadline == null) {
      showToast('请选择截止时间');
      return;
    }
    setState(() => _busy = true);
    try {
      await state.shareService.create(
        target: target,
        direction: _direction,
        services: _services.toList(),
        permanent: _mode == 'permanent',
        duration: _mode == 'duration' ? duration : null,
        expiresAt: _mode == 'deadline' && _deadline != null
            ? _utc8Text(_deadline!)
            : null,
        note: _note.text.trim(),
      );
      if (!mounted) return;
      Navigator.of(context).pop(true);
      showToast('分享请求已发送');
    } on ApiException catch (e) {
      showToast(e.message, isError: true);
    } catch (e) {
      showToast('创建失败：$e', isError: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _durationField(String key, String label) {
    return SizedBox(
      width: 82,
      child: TextField(
        controller: _duration[key],
        keyboardType: TextInputType.number,
        decoration: InputDecoration(labelText: label, isDense: true),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('新建分享 / 索要'),
      content: SizedBox(
        width: 480,
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              SegmentedButton<String>(
                segments: const <ButtonSegment<String>>[
                  ButtonSegment<String>(value: 'share', label: Text('分享')),
                  ButtonSegment<String>(value: 'request', label: Text('索要')),
                ],
                selected: <String>{_direction},
                onSelectionChanged: (Set<String> v) =>
                    setState(() => _direction = v.first),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _target,
                decoration: const InputDecoration(
                  labelText: '对方代号或邮箱',
                  hintText: '例如 2 或 someone@example.com',
                ),
              ),
              const SizedBox(height: 10),
              const Text('服务', style: TextStyle(fontSize: 12)),
              Wrap(
                spacing: 8,
                children: kServices.map((String s) {
                  final bool selected = _services.contains(s);
                  return FilterChip(
                    label: Text(
                      kServiceLabels[s] ?? s,
                      style: const TextStyle(fontSize: 11),
                    ),
                    selected: selected,
                    onSelected: (bool v) {
                      setState(() {
                        if (v) {
                          _services.add(s);
                        } else {
                          _services.remove(s);
                        }
                      });
                    },
                  );
                }).toList(),
              ),
              const SizedBox(height: 8),
              SegmentedButton<String>(
                segments: const <ButtonSegment<String>>[
                  ButtonSegment<String>(value: 'duration', label: Text('时长')),
                  ButtonSegment<String>(value: 'deadline', label: Text('截止时间')),
                  ButtonSegment<String>(value: 'permanent', label: Text('永久')),
                ],
                selected: <String>{_mode},
                onSelectionChanged: (Set<String> v) =>
                    setState(() => _mode = v.first),
              ),
              const SizedBox(height: 10),
              if (_mode == 'duration')
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: <Widget>[
                    _durationField('years', '年'),
                    _durationField('months', '月'),
                    _durationField('weeks', '周'),
                    _durationField('days', '天'),
                    _durationField('hours', '小时'),
                    _durationField('minutes', '分钟'),
                  ],
                )
              else if (_mode == 'deadline')
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Row(
                      children: <Widget>[
                        Expanded(
                          child: Text(
                            _deadline == null
                                ? '未选择截止时间（UTC+8）'
                                : '截止：${_utc8Text(_deadline!)}（UTC+8）',
                            style: const TextStyle(fontSize: 11.5),
                          ),
                        ),
                        SizedBox(
                          width: 64,
                          child: TextField(
                            controller: _seconds,
                            keyboardType: TextInputType.number,
                            decoration: const InputDecoration(
                              labelText: '秒',
                              isDense: true,
                            ),
                            onChanged: (_) => setState(() {}),
                          ),
                        ),
                        const SizedBox(width: 6),
                        OutlinedButton(
                          onPressed: _pickDeadline,
                          style: OutlinedButton.styleFrom(
                            minimumSize: const Size(0, 34),
                            padding: const EdgeInsets.symmetric(horizontal: 10),
                          ),
                          child: const Text('选择'),
                        ),
                      ],
                    ),
                  ],
                )
              else
                const Text(
                  '永久有效，直到任一方撤销。',
                  style: TextStyle(fontSize: 11.5, color: AppColors.inkSoft),
                ),
              const SizedBox(height: 10),
              TextField(
                controller: _note,
                maxLines: 3,
                decoration: const InputDecoration(
                  labelText: '备注（可选）',
                  alignLabelWithHint: true,
                ),
              ),
            ],
          ),
        ),
      ),
      actions: <Widget>[
        TextButton(
          onPressed: _busy ? null : () => Navigator.of(context).pop(false),
          child: const Text('取消'),
        ),
        FilledButton(
          onPressed: _busy ? null : _submit,
          child: _busy
              ? const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: Colors.white,
                  ),
                )
              : const Text('发送请求'),
        ),
      ],
    );
  }
}
