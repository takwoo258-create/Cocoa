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
