import 'package:flutter/material.dart';

import '../core/api_client.dart';
import '../core/app_state.dart';
import '../core/global.dart';
import '../core/json_utils.dart';

/// v1.0.1：分享到 QQ 空间动态（POST /api/onebot/qzone）。
Future<void> showQzoneShare(
  BuildContext context, {
  required String defaultContent,
  String? imageUrl,
}) async {
  final AppState state = AppScope.read(context);
  final String initial =
      defaultContent.length > 1000 ? defaultContent.substring(0, 1000) : defaultContent;
  final TextEditingController contentCtrl =
      TextEditingController(text: initial);
  final TextEditingController imageCtrl =
      TextEditingController(text: imageUrl ?? '');
  bool busy = false;

  await showDialog<void>(
    context: context,
    builder: (BuildContext ctx) => StatefulBuilder(
      builder: (BuildContext ctx, StateSetter setSt) {
        Future<void> share() async {
          final String content = contentCtrl.text.trim();
          if (content.isEmpty) {
            showToast('动态内容不能为空');
            return;
          }
          setSt(() => busy = true);
          try {
            final Map<String, dynamic> r = await state.socialService.shareQzone(
              content: content,
              images: imageCtrl.text.trim().isEmpty
                  ? const <String>[]
                  : <String>[imageCtrl.text.trim()],
            );
            final String tid = asString(r['tid']);
            if (!ctx.mounted) return;
            Navigator.of(ctx).pop();
            showToast(tid.isEmpty ? '已发布到 QQ 动态' : '已发布到 QQ 动态：$tid');
          } on ApiException catch (e) {
            if (!ctx.mounted) return;
            setSt(() => busy = false);
            showToast(
              e.statusCode == 503
                  ? 'NapCat 未连接，暂时无法发布 QQ 动态'
                  : e.message,
              isError: true,
            );
          } catch (e) {
            if (!ctx.mounted) return;
            setSt(() => busy = false);
            showToast('发布失败：$e', isError: true);
          }
        }

        return AlertDialog(
          title: const Text('分享到 QQ 动态'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                TextField(
                  controller: contentCtrl,
                  maxLines: 6,
                  maxLength: 1000,
                  decoration: const InputDecoration(
                    labelText: '动态内容',
                    helperText: '最多 1000 字，超出会被截断',
                    alignLabelWithHint: true,
                  ),
                ),
                const SizedBox(height: 6),
                TextField(
                  controller: imageCtrl,
                  keyboardType: TextInputType.url,
                  decoration: const InputDecoration(
                    labelText: '图片 URL（可选）',
                    hintText: 'https://…',
                  ),
                ),
                const SizedBox(height: 8),
                const Text(
                  '通过账号绑定的 NapCat 发布到 QQ 空间；未连接时会提示。',
                  style: TextStyle(fontSize: 10.5, color: Colors.grey),
                ),
              ],
            ),
          ),
          actions: <Widget>[
            TextButton(
              onPressed: busy ? null : () => Navigator.of(ctx).pop(),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: busy ? null : share,
              child: busy
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: Colors.white,
                      ),
                    )
                  : const Text('发布'),
            ),
          ],
        );
      },
    ),
  );
  contentCtrl.dispose();
  imageCtrl.dispose();
}
