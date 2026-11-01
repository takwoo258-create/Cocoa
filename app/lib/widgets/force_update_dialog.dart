import 'package:flutter/material.dart';

import '../core/global.dart';
import '../core/native.dart';
import '../core/theme.dart';
import '../models/version_info.dart';

/// v1.1.0：需要更新的对话框（不可关闭、无忽略按钮）。
class ForceUpdateDialog {
  static bool _showing = false;

  static Future<void> show(
    BuildContext context, {
    required LatestVersion latest,
    required String reason,
    required String minVersion,
  }) async {
    if (_showing) return;
    _showing = true;
    final String reasonText = switch (reason) {
      'admin' => '管理员已将该版本设为必须更新',
      'min_version' => '当前版本低于最低支持版本${minVersion.isEmpty ? '' : ' $minVersion'}',
      'release' => '该版本说明要求更新',
      _ => '当前版本已不再受支持',
    };
    try {
      await showDialog<void>(
        context: context,
        barrierDismissible: false,
        useSafeArea: true,
        builder: (BuildContext ctx) => PopScope(
          canPop: false,
          child: AlertDialog(
            icon: const Icon(
              Icons.system_update_alt,
              color: AppColors.danger,
              size: 28,
            ),
            title: const Text(
              '需要更新后才能继续',
              textAlign: TextAlign.center,
              style: TextStyle(fontWeight: FontWeight.w700),
            ),
            content: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 460),
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      '新版本 v${latest.version}',
                      style: const TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      reasonText,
                      style: const TextStyle(
                        fontSize: 11.5,
                        color: AppColors.warn,
                        height: 1.5,
                      ),
                    ),
                    if (latest.formattedNotes.isNotEmpty) ...<Widget>[
                      const SizedBox(height: 10),
                      const Text(
                        '更新内容',
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        latest.formattedNotes,
                        maxLines: 8,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 11.5,
                          height: 1.55,
                          color: AppColors.inkSoft,
                        ),
                      ),
                    ],
                    const SizedBox(height: 10),
                    const Text(
                      '下载并安装完成后，请重新打开 Cocoa。',
                      style: TextStyle(fontSize: 11, color: AppColors.inkSoft),
                    ),
                  ],
                ),
              ),
            ),
            actions: <Widget>[
              SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  onPressed: () async {
                    final bool ok = await openExternalUrl(latest.downloadUrl);
                    if (!ok) {
                      showToast(
                        '无法打开下载链接：${latest.downloadUrl}',
                        isError: true,
                      );
                      return;
                    }
                    showToast('安装完成后请重新打开 Cocoa');
                  },
                  icon: const Icon(Icons.download, size: 17),
                  label: const Text('下载并安装'),
                ),
              ),
            ],
          ),
        ),
      );
    } finally {
      _showing = false;
    }
  }
}
