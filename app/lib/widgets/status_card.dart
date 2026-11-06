import 'package:flutter/material.dart';

import '../core/theme.dart';
import '../models/character.dart';

/// 聊天页顶部状态卡：动作 / 心理 / 心情 / 健康 / 睡眠。
class CharacterStatusCard extends StatelessWidget {
  const CharacterStatusCard({
    super.key,
    required this.characterName,
    required this.state,
    this.compact = false,
  });

  final String characterName;
  final CharacterState state;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 8, 12, 4),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        gradient: kRoseGradient,
        borderRadius: BorderRadius.circular(18),
        boxShadow: <BoxShadow>[
          BoxShadow(
            color: AppColors.rose.withAlpha(50),
            blurRadius: 12,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Text(
                '${state.moodEmoji}  $characterName',
                style: const TextStyle(
                  color: AppColors.ink,
                  fontSize: 15,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const Spacer(),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: AppColors.white.withAlpha(160),
                  borderRadius: BorderRadius.circular(9),
                ),
                child: Text(
                  state.sleepLabel,
                  style: const TextStyle(fontSize: 11, color: AppColors.ink),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          if (compact)
            Text(
              shortLine(
                <String>[
                  state.motion,
                  state.psychology,
                  state.mood,
                  state.health,
                ],
              ),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 12, color: AppColors.ink),
            )
          else
            Wrap(
              spacing: 8,
              runSpacing: 6,
              children: <Widget>[
                _chip('动作', state.motion),
                _chip('心理', state.psychology),
                _chip('心情', state.mood),
                _chip('健康', state.health),
              ],
            ),
        ],
      ),
    );
  }

  String shortLine(List<String> parts) {
    final List<String> kept = parts
        .where((String p) => p.trim().isNotEmpty)
        .map((String p) => p.trim())
        .toList();
    if (kept.isEmpty) return '正在发呆…';
    return kept.join(' · ');
  }

  Widget _chip(String label, String value) {
    if (value.trim().isEmpty) return const SizedBox.shrink();
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
      constraints: const BoxConstraints(maxWidth: 260),
      decoration: BoxDecoration(
        color: AppColors.white.withAlpha(150),
        borderRadius: BorderRadius.circular(11),
      ),
      child: RichText(
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
        text: TextSpan(
          style: const TextStyle(fontSize: 11.5, color: AppColors.ink),
          children: <TextSpan>[
            TextSpan(
              text: '$label ',
              style: const TextStyle(
                fontWeight: FontWeight.w700,
                color: AppColors.cocoa,
              ),
            ),
            TextSpan(text: value),
          ],
        ),
      ),
    );
  }
}

/// v1.0.1：聊天页顶部紧凑状态条，点击进入独立角色状态页。
class CharacterStatusBar extends StatelessWidget {
  const CharacterStatusBar({
    super.key,
    required this.characterName,
    required this.state,
    this.onTap,
  });

  final String characterName;
  final CharacterState state;
  final VoidCallback? onTap;

  String get _summary {
    final List<String> parts = <String>[
      if (state.motion.trim().isNotEmpty) state.motion.trim(),
      if (state.mood.trim().isNotEmpty) state.mood.trim(),
      if (state.resting) state.sleepLabel,
    ];
    if (parts.isEmpty) return '正在发呆…';
    return parts.join(' · ');
  }

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Container(
        margin: const EdgeInsets.fromLTRB(12, 8, 12, 4),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
        decoration: BoxDecoration(
          gradient: state.resting
              ? const LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: <Color>[Color(0xFF1B2430), Color(0xFF2E2A3E)],
                )
              : kRoseGradient,
          borderRadius: BorderRadius.circular(14),
          boxShadow: <BoxShadow>[
            BoxShadow(
              color: (state.resting ? Colors.black : AppColors.rose)
                  .withAlpha(40),
              blurRadius: 8,
              offset: const Offset(0, 3),
            ),
          ],
        ),
        child: Row(
          children: <Widget>[
            Text(state.moodEmoji, style: const TextStyle(fontSize: 15)),
            const SizedBox(width: 6),
            Text(
              characterName,
              style: TextStyle(
                fontSize: 12.5,
                fontWeight: FontWeight.w700,
                color: state.resting ? Colors.white : AppColors.ink,
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                _summary,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 11,
                  color: state.resting ? Colors.white70 : AppColors.ink,
                ),
              ),
            ),
            if (state.resting)
              Container(
                margin: const EdgeInsets.only(right: 4),
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: AppColors.white.withAlpha(150),
                  borderRadius: BorderRadius.circular(7),
                ),
                child: Text(
                  state.sleepLabel,
                  style: const TextStyle(fontSize: 9, color: AppColors.ink),
                ),
              ),
            Icon(
              Icons.chevron_right,
              size: 16,
              color: state.resting ? Colors.white70 : AppColors.ink,
            ),
          ],
        ),
      ),
    );
  }
}
