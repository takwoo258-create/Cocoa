import 'package:flutter/material.dart';

import '../core/theme.dart';

/// v1.5.0：广场发布表单（标题/描述/可见范围/时间/token 限额）。
Future<Map<String, dynamic>?> showPlazaPublishDialog(
  BuildContext context, {
  required String kind,
  String title = '',
}) async {
  final TextEditingController titleCtrl = TextEditingController(text: title);
  final TextEditingController desc = TextEditingController();
  final TextEditingController targets = TextEditingController();
  final TextEditingController soft = TextEditingController();
  final TextEditingController hard = TextEditingController();
  String visibility = 'server';
  bool permanent = false;
  DateTime start = DateTime.now();
  DateTime end = DateTime.now().add(const Duration(days: 7));
  String? error;

  String fmt(DateTime d) {
    String two(int v) => v < 10 ? '0$v' : '$v';
    return '${d.year}-${two(d.month)}-${two(d.day)} '
        '${two(d.hour)}:${two(d.minute)}:${two(d.second)}';
  }

  Future<void> pick(bool isStart, StateSetter setSt) async {
    final DateTime base = isStart ? start : end;
    final DateTime? date = await showDatePicker(
      context: context,
      firstDate: DateTime.now().subtract(const Duration(days: 1)),
      lastDate: DateTime.now().add(const Duration(days: 3650)),
      initialDate: base,
    );
    if (date == null) return;
    final TimeOfDay? time =
        await showTimePicker(context: context, initialTime: TimeOfDay.fromDateTime(base));
    if (time == null) return;
    setSt(() {
      final DateTime picked = DateTime(
        date.year,
        date.month,
        date.day,
        time.hour,
        time.minute,
      );
      if (isStart) {
        start = picked;
      } else {
        end = picked;
      }
    });
  }

  final Map<String, dynamic>? result =
      await showDialog<Map<String, dynamic>>(
    context: context,
    builder: (BuildContext ctx) => StatefulBuilder(
      builder: (BuildContext ctx, StateSetter setSt) => AlertDialog(
        title: Text(kind == 'model' ? '公开模型使用权' : '发布人设模板'),
        content: SizedBox(
          width: 520,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                TextField(
                  controller: titleCtrl,
                  decoration: const InputDecoration(labelText: '标题'),
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: desc,
                  maxLines: 3,
                  decoration: const InputDecoration(
                    labelText: '描述',
                    alignLabelWithHint: true,
                  ),
                ),
                const SizedBox(height: 10),
                const Text('可见范围', style: TextStyle(fontSize: 12)),
                SegmentedButton<String>(
                  segments: const <ButtonSegment<String>>[
                    ButtonSegment<String>(value: 'server', label: Text('本服')),
                    ButtonSegment<String>(value: 'global', label: Text('全球')),
                    ButtonSegment<String>(value: 'users', label: Text('指定用户')),
                  ],
                  selected: <String>{visibility},
                  onSelectionChanged: (Set<String> v) =>
                      setSt(() => visibility = v.first),
                ),
                if (visibility == 'users') ...<Widget>[
                  const SizedBox(height: 8),
                  TextField(
                    controller: targets,
                    decoration: const InputDecoration(
                      labelText: '目标 share ID（逗号分隔）',
                    ),
                  ),
                ],
                const SizedBox(height: 10),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  dense: true,
                  title: const Text('永久展示', style: TextStyle(fontSize: 12)),
                  value: permanent,
                  onChanged: (bool v) => setSt(() => permanent = v),
                ),
                if (!permanent) ...<Widget>[
                  Row(
                    children: <Widget>[
                      Expanded(
                        child: OutlinedButton(
                          onPressed: () => pick(true, setSt),
                          child: Text('开始 ${fmt(start)}',
                              style: const TextStyle(fontSize: 10.5)),
                        ),
                      ),
                      const SizedBox(width: 6),
                      Expanded(
                        child: OutlinedButton(
                          onPressed: () => pick(false, setSt),
                          child: Text('结束 ${fmt(end)}',
                              style: const TextStyle(fontSize: 10.5)),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  const Text(
                    '时间按 UTC+8，格式 YYYY-MM-DD HH:mm:ss',
                    style: TextStyle(fontSize: 9.5, color: AppColors.inkSoft),
                  ),
                ],
                const SizedBox(height: 8),
                Row(
                  children: <Widget>[
                    Expanded(
                      child: TextField(
                        controller: soft,
                        keyboardType: TextInputType.number,
                        decoration:
                            const InputDecoration(labelText: 'token 软限额'),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: TextField(
                        controller: hard,
                        keyboardType: TextInputType.number,
                        decoration:
                            const InputDecoration(labelText: 'token 硬限额'),
                      ),
                    ),
                  ],
                ),
                if (error != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Text(
                      error!,
                      style: const TextStyle(fontSize: 10.5, color: AppColors.danger),
                    ),
                  ),
              ],
            ),
          ),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () {
              if (titleCtrl.text.trim().isEmpty) {
                setSt(() => error = '请填写标题');
                return;
              }
              if (visibility == 'users' &&
                  targets.text.trim().isEmpty) {
                setSt(() => error = '指定用户必须填写 share ID');
                return;
              }
              Navigator.of(ctx).pop(<String, dynamic>{
                'title': titleCtrl.text.trim(),
                'description': desc.text.trim(),
                'visibility': visibility,
                if (visibility == 'users')
                  'targetShareIds': targets.text
                      .split(',')
                      .map((String s) => s.trim())
                      .where((String s) => s.isNotEmpty)
                      .toList(),
                'permanent': permanent,
                if (!permanent) 'startsAt': fmt(start),
                if (!permanent) 'expiresAt': fmt(end),
                if (int.tryParse(soft.text.trim()) != null)
                  'tokenSoft': int.parse(soft.text.trim()),
                if (int.tryParse(hard.text.trim()) != null)
                  'tokenHard': int.parse(hard.text.trim()),
              });
            },
            child: const Text('发布'),
          ),
        ],
      ),
    ),
  );
  titleCtrl.dispose();
  desc.dispose();
  targets.dispose();
  soft.dispose();
  hard.dispose();
  return result;
}
