import 'package:flutter/material.dart';

import '../core/theme.dart';
import '../core/utils.dart';
import '../models/chat_message.dart';

/// 调试模式：输入框下方的圆形上下文占用进度 + 百分比。
class ContextGauge extends StatelessWidget {
  const ContextGauge({super.key, required this.usage});

  final ContextUsage usage;

  Color _color(double ratio) {
    if (usage.compressing) return AppColors.warn;
    if (ratio >= 0.85) return AppColors.danger;
    if (ratio >= 0.6) return AppColors.warn;
    return AppColors.cocoa;
  }

  @override
  Widget build(BuildContext context) {
    final double ratio = usage.ratio.clamp(0.0, 1.0);
    final double percent = ratio * 100;
    final Color color = _color(ratio);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 2, 16, 4),
      child: Row(
        children: <Widget>[
          SizedBox(
            width: 22,
            height: 22,
            child: Stack(
              alignment: Alignment.center,
              children: <Widget>[
                CircularProgressIndicator(
                  value: ratio,
                  strokeWidth: 2.6,
                  backgroundColor: AppColors.sand,
                  valueColor: AlwaysStoppedAnimation<Color>(color),
                ),
                Text(
                  '${percent.round()}',
                  style: TextStyle(
                    fontSize: 7,
                    fontWeight: FontWeight.w700,
                    color: color,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Text(
            '上下文 ${percent.toStringAsFixed(1)}%',
            style: TextStyle(
              fontSize: 10.5,
              color: color,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(width: 8),
          if (usage.limit > 0)
            Text(
              '${compactNumber(usage.used)} / ${compactNumber(usage.limit)}',
              style: const TextStyle(fontSize: 10, color: AppColors.inkSoft),
            ),
          if (usage.compressing) ...<Widget>[
            const SizedBox(width: 8),
            const Text(
              '压缩中…',
              style: TextStyle(fontSize: 10, color: AppColors.warn),
            ),
          ],
          const Spacer(),
          const Text(
            '调试模式',
            style: TextStyle(fontSize: 9, color: AppColors.inkSoft),
          ),
        ],
      ),
    );
  }
}
