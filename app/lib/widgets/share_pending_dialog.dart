import 'package:flutter/material.dart';

import '../core/api_client.dart';
import '../core/app_state.dart';
import '../core/global.dart';
import '../core/constants.dart';
import '../core/theme.dart';
import '../models/model_share.dart';

/// v1.2.0：启动/收到分享请求时的待处理弹窗（可接受/拒绝/稍后处理）。
Future<void> showSharePendingDialog(
  BuildContext context, {
  required List<ModelShare> shares,
}) async {
  final AppState state = AppScope.read(context);
  final List<ModelShare> items = List<ModelShare>.of(shares);
  if (items.isEmpty) return;

  await showDialog<void>(
    context: context,
    builder: (BuildContext ctx) => StatefulBuilder(
      builder: (BuildContext ctx, StateSetter setSt) {
        Future<void> respond(ModelShare share, bool accept) async {
          try {
            await state.shareService.respond(share.id, accept);
            if (!ctx.mounted) return;
            setSt(() => items.removeWhere((ModelShare s) => s.id == share.id));
            showToast(accept ? '已接受分享' : '已拒绝分享');
            if (items.isEmpty && ctx.mounted) Navigator.of(ctx).pop();
          } on ApiException catch (e) {
            showToast(e.message, isError: true);
          } catch (e) {
            showToast('操作失败：$e', isError: true);
          }
        }

        return AlertDialog(
          title: Row(
            children: <Widget>[
              const Icon(Icons.swap_horiz, size: 20, color: AppColors.cocoa),
              const SizedBox(width: 8),
              Text(
                '待处理的模型分享（${items.length}）',
                style: const TextStyle(fontSize: 15),
              ),
            ],
          ),
          content: SizedBox(
            width: 460,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: items.map((ModelShare s) {
                  final String from = s.owner.label;
                  final String services = s.services
                      .map((String v) => kServiceLabels[v] ?? v)
                      .join('、');
                  return Container(
                    margin: const EdgeInsets.only(bottom: 8),
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: AppColors.cream,
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: AppColors.sand),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(
                          s.direction == 'request'
                              ? '$from 向你索要模型'
                              : '$from 与你分享模型',
                          style: const TextStyle(fontSize: 12.5),
                        ),
                        const SizedBox(height: 3),
                        Text(
                          '服务：$services · ${s.timeLabel}',
                          style: const TextStyle(
                            fontSize: 10.5,
                            color: AppColors.inkSoft,
                          ),
                        ),
                        if (s.note.isNotEmpty)
                          Text(
                            '备注：${s.note}',
                            style: const TextStyle(
                              fontSize: 10.5,
                              color: AppColors.inkSoft,
                            ),
                          ),
                        const SizedBox(height: 6),
                        Row(
                          children: <Widget>[
                            TextButton(
                              onPressed: () => respond(s, false),
                              style: TextButton.styleFrom(
                                minimumSize: const Size(0, 32),
                                foregroundColor: AppColors.danger,
                                textStyle: const TextStyle(fontSize: 11.5),
                              ),
                              child: const Text('拒绝'),
                            ),
                            const SizedBox(width: 6),
                            FilledButton(
                              onPressed: () => respond(s, true),
                              style: FilledButton.styleFrom(
                                minimumSize: const Size(0, 32),
                                padding:
                                    const EdgeInsets.symmetric(horizontal: 14),
                                textStyle: const TextStyle(fontSize: 11.5),
                              ),
                              child: const Text('接受'),
                            ),
                          ],
                        ),
                      ],
                    ),
                  );
                }).toList(),
              ),
            ),
          ),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: const Text('稍后处理'),
            ),
          ],
        );
      },
    ),
  );
}
