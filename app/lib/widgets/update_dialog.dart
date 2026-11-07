import 'package:flutter/material.dart';

import '../core/app_state.dart';
import '../core/global.dart';
import '../core/native.dart';
import '../core/theme.dart';
import '../core/utils.dart';
import '../models/version_info.dart';

/// v1.3.0：多版本更新弹窗（含 Beta、需要更新版本、应用内下载、推迟）。
class UpdateDialog extends StatefulWidget {
  const UpdateDialog({super.key, required this.check});

  final VersionCheckResult check;

  static bool _showing = false;

  static Future<void> show(
    BuildContext context, {
    required VersionCheckResult check,
  }) async {
    if (_showing) return;
    _showing = true;
    final bool force =
        check.forceUpdate || check.requiredVersion.isNotEmpty;
    try {
      await showDialog<void>(
        context: context,
        barrierDismissible: !force,
        useSafeArea: true,
        builder: (BuildContext ctx) => PopScope(
          canPop: !force,
          child: UpdateDialog(check: check),
        ),
      );
    } finally {
      _showing = false;
    }
  }

  @override
  State<UpdateDialog> createState() => _UpdateDialogState();
}

class _UpdateDialogState extends State<UpdateDialog> {
  String _selectedVersion = '';
  bool _expanded = false;

  VersionCheckResult get check => widget.check;
  bool get force => check.forceUpdate || check.requiredVersion.isNotEmpty;

  LatestVersion? get required {
    if (check.requiredVersion.isEmpty) return null;
    for (final LatestVersion v in check.releases) {
      if (v.version == check.requiredVersion || v.tag == check.requiredVersion) {
        return v;
      }
    }
    return check.latest;
  }

  List<LatestVersion> get options {
    final List<LatestVersion> all = check.releases.isNotEmpty
        ? check.releases
        : (check.latest.version.isEmpty
            ? const <LatestVersion>[]
            : <LatestVersion>[check.latest]);
    final LatestVersion? req = required;
    if (force && req != null) {
      final int idx = all.indexWhere(
        (LatestVersion v) => v.version == req.version || v.tag == req.version,
      );
      // 强制场景：包含 requiredVersion 本身与所有更高版本，默认选 required。
      if (idx >= 0) return all.sublist(0, idx + 1);
    }
    return all;
  }

  LatestVersion? get selected {
    final List<LatestVersion> list = options;
    if (_selectedVersion.isNotEmpty) {
      for (final LatestVersion v in list) {
        if (v.version == _selectedVersion) return v;
      }
    }
    if (list.isNotEmpty) return list.first;
    return required;
  }

  @override
  void initState() {
    super.initState();
    final LatestVersion? req = required;
    _selectedVersion = force && req != null
        ? req.version
        : (check.latest.version.isNotEmpty ? check.latest.version : '');
    if (options.isEmpty && req != null) {
      _selectedVersion = req.version;
    }
  }

  Future<void> _download(LatestVersion version) async {
    final String safe = version.version.replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '-');
    final String filename = 'Cocoa-$safe.apk';
    final bool ok = await downloadApk(version.downloadUrl, filename);
    if (!ok) {
      final bool opened = await openExternalUrl(version.downloadUrl);
      if (!mounted) return;
      showToast(
        opened ? '已打开浏览器下载' : '无法打开下载链接：${version.downloadUrl}',
        isError: !opened,
      );
      return;
    }
    if (mounted) showToast('已开始下载 ${version.displayLabel}，安装后请重新打开 Cocoa');
  }

  Future<void> _browser(LatestVersion version) async {
    final bool ok = await openExternalUrl(version.downloadUrl);
    if (mounted && !ok) {
      showToast('无法打开下载链接：${version.downloadUrl}', isError: true);
    }
  }

  Widget _releaseCard(LatestVersion v, {bool isRequired = false}) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: isRequired ? AppColors.warn.withAlpha(20) : AppColors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: isRequired ? AppColors.warn.withAlpha(120) : AppColors.sand,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Text(
                v.displayLabel,
                style: const TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(width: 6),
              if (v.beta)
                _badge('Beta', AppColors.rose)
              else if (!isRequired && v.version == check.latest.version)
                _badge('最新版', AppColors.cocoa),
              if (isRequired) ...<Widget>[
                const SizedBox(width: 6),
                _badge('需要更新', AppColors.warn),
              ],
              const Spacer(),
              if (v.publishedAt.isNotEmpty)
                Text(
                  formatDate(v.publishedAt),
                  style: const TextStyle(
                    fontSize: 10,
                    color: AppColors.inkSoft,
                  ),
                ),
            ],
          ),
          if (v.notes.isNotEmpty) ...<Widget>[
            const SizedBox(height: 6),
            Text(
              _expanded ? v.formattedNotes : v.notesSummary,
              maxLines: _expanded ? 30 : 3,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: 11,
                height: 1.55,
                color: AppColors.inkSoft,
              ),
            ),
            TextButton(
              onPressed: () => setState(() => _expanded = !_expanded),
              style: TextButton.styleFrom(
                minimumSize: const Size(0, 28),
                padding: EdgeInsets.zero,
                textStyle: const TextStyle(fontSize: 11),
              ),
              child: Text(_expanded ? '收起详情' : '展开详情'),
            ),
          ],
        ],
      ),
    );
  }

  Widget _badge(String text, Color color) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: color.withAlpha(28),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        text,
        style: TextStyle(
          fontSize: 9,
          color: color,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final AppState state = AppScope.read(context);
    final LatestVersion? req = required;
    final LatestVersion? chosen = selected;
    final List<LatestVersion> selectable = options;
    return AlertDialog(
      title: Text(force ? '需要更新' : '发现新版本'),
      content: SizedBox(
        width: 500,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              if (req != null) ...<Widget>[
                _releaseCard(req, isRequired: true),
                const SizedBox(height: 10),
              ],
              if (selectable.length > 1) ...<Widget>[
                const Text(
                  '可更新版本',
                  style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
                ),
                const SizedBox(height: 4),
                DropdownButtonFormField<String>(
                  initialValue: chosen?.version,
                  isExpanded: true,
                  decoration: const InputDecoration(isDense: true),
                  items: selectable
                      .map(
                        (LatestVersion v) => DropdownMenuItem<String>(
                          value: v.version,
                          child: Text(
                            '${v.displayLabel}'
                            '${v.version == required?.version ? '（需要更新）' : (v.version == check.latest.version ? '（最新版）' : '')}',
                            style: const TextStyle(fontSize: 12.5),
                          ),
                        ),
                      )
                      .toList(),
                  onChanged: (String? value) {
                    if (value == null) return;
                    setState(() => _selectedVersion = value);
                  },
                ),
                const SizedBox(height: 8),
              ],
              if (chosen != null && chosen.version != req?.version)
                _releaseCard(chosen),
              if (chosen != null && chosen.version != req?.version) ...<Widget>[
                if (selectable.length <= 1) const SizedBox(height: 6),
                Align(
                  alignment: Alignment.centerRight,
                  child: Text(
                    '将更新到 ${chosen.displayLabel}',
                    style: const TextStyle(
                      fontSize: 11,
                      color: AppColors.inkSoft,
                    ),
                  ),
                ),
              ],
              const SizedBox(height: 8),
              if (chosen != null)
                Row(
                  children: <Widget>[
                    Expanded(
                      child: FilledButton.icon(
                        onPressed: () => _download(chosen),
                        icon: const Icon(Icons.download, size: 17),
                        label: const Text('立即更新'),
                      ),
                    ),
                    const SizedBox(width: 8),
                    OutlinedButton(
                      onPressed: () => _browser(chosen),
                      style: OutlinedButton.styleFrom(
                        minimumSize: const Size(0, 46),
                        padding: const EdgeInsets.symmetric(horizontal: 12),
                      ),
                      child: const Text('浏览器下载'),
                    ),
                  ],
                ),
              if (!force) ...<Widget>[
                const SizedBox(height: 10),
                Row(
                  children: <Widget>[
                    TextButton(
                      onPressed: () async {
                        await state.snoozeUpdatesToday();
                        if (context.mounted) Navigator.of(context).pop();
                      },
                      child: const Text('今日不再提醒'),
                    ),
                    TextButton(
                      onPressed: () async {
                        await state.ignoreLatestUpdate();
                        if (context.mounted) Navigator.of(context).pop();
                      },
                      child: const Text('下次有更新再提醒'),
                    ),
                  ],
                ),
              ],
            ],
          ),
        ),
      ),
      actions: <Widget>[
        if (!force)
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('稍后'),
          ),
      ],
    );
  }
}
