import 'package:flutter/material.dart';

import '../core/svg_icon.dart';
import '../core/theme.dart';
import '../models/config_models.dart';

/// 用 SVG 图标展示模型的文本 / 图片 / 语音能力。
class CapabilityIcons extends StatelessWidget {
  const CapabilityIcons({
    super.key,
    required this.capabilities,
    this.size = 16,
    this.showLabels = false,
  });

  final ModelCapabilities capabilities;
  final double size;
  final bool showLabels;

  Widget _item(List<String> paths, bool enabled, String label) {
    final Color color = enabled ? AppColors.cocoa : AppColors.inkSoft.withAlpha(90);
    final Widget icon = SvgPathIcon(
      paths: paths,
      size: size,
      color: color,
      strokeWidth: enabled ? 1.9 : 1.4,
    );
    if (!showLabels) return icon;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        icon,
        const SizedBox(width: 4),
        Text(
          label,
          style: TextStyle(
            fontSize: size * 0.72,
            color: color,
            fontWeight: enabled ? FontWeight.w600 : FontWeight.w400,
          ),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        _item(SvgIcons.text, capabilities.text, '文本'),
        SizedBox(width: showLabels ? 10 : 5),
        _item(SvgIcons.image, capabilities.image, '图片'),
        SizedBox(width: showLabels ? 10 : 5),
        _item(SvgIcons.audio, capabilities.audio, '语音'),
      ],
    );
  }
}

/// 带文字说明的能力徽标（模型列表行内使用）。
class CapabilityBadge extends StatelessWidget {
  const CapabilityBadge({super.key, required this.model, this.dense = false});

  final ModelInfo model;
  final bool dense;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: AppColors.sand,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          CapabilityIcons(
            capabilities: ModelCapabilities.of(model),
            size: dense ? 13 : 15,
          ),
          if (!dense) ...<Widget>[
            const SizedBox(width: 8),
            Text(
              model.contextLabel,
              style: const TextStyle(fontSize: 11, color: AppColors.inkSoft),
            ),
          ],
        ],
      ),
    );
  }
}
