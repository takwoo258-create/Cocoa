import 'package:flutter/material.dart';

import '../core/api_client.dart';
import '../core/app_state.dart';
import '../core/global.dart';
import '../core/theme.dart';
import '../core/utils.dart';
import '../models/character.dart';
import '../widgets/common.dart';
import '../widgets/status_card.dart';

/// v1.0.1：独立角色状态页（动作/心理/心情/健康/睡眠/亲密度/陪伴天数，刷新与叫醒）。
class CharacterStatusPage extends StatefulWidget {
  const CharacterStatusPage({
    super.key,
    required this.character,
    this.initialState,
  });

  final Character character;
  final CharacterState? initialState;

  @override
  State<CharacterStatusPage> createState() => _CharacterStatusPageState();
}

class _CharacterStatusPageState extends State<CharacterStatusPage> {
  late CharacterState _state;
  bool _loading = true;
  bool _waking = false;

  @override
  void initState() {
    super.initState();
    _state = widget.initialState ?? widget.character.state;
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    final AppState state = AppScope.read(context);
    try {
      final CharacterState latest =
          await state.characterService.getState(widget.character.id);
      if (!mounted) return;
      setState(() {
        _state = latest;
        _loading = false;
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _loading = false);
      showToast(e.message, isError: true);
    } catch (e) {
      if (mounted) setState(() => _loading = false);
      showToast('状态刷新失败：$e', isError: true);
    }
  }

  Future<void> _wake() async {
    final AppState state = AppScope.read(context);
    setState(() => _waking = true);
    try {
      final int wakeup = await state.chatService.wake(widget.character.id);
      if (!mounted) return;
      showToast(wakeup == 1 ? '已经去叫 ta 了，等等看…' : 'ta 还在睡，暂时没有回应');
      await _load();
    } on ApiException catch (e) {
      showToast(e.message, isError: true);
    } catch (e) {
      showToast('叫醒失败：$e', isError: true);
    } finally {
      if (mounted) setState(() => _waking = false);
    }
  }

  Widget _kvRow(String label, String value, {IconData? icon}) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          if (icon != null) ...<Widget>[
            Icon(icon, size: 15, color: AppColors.rose),
            const SizedBox(width: 6),
          ],
          SizedBox(
            width: 58,
            child: Text(
              label,
              style: const TextStyle(fontSize: 11.5, color: AppColors.inkSoft),
            ),
          ),
          Expanded(
            child: Text(
              value.trim().isEmpty ? '—' : value,
              style: const TextStyle(fontSize: 12.5, height: 1.5),
            ),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('${widget.character.name} · 状态'),
        actions: <Widget>[
          IconButton(
            tooltip: '刷新',
            icon: const Icon(Icons.refresh, size: 20),
            onPressed: _load,
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.only(bottom: 24),
          children: <Widget>[
            CharacterStatusCard(
              characterName: widget.character.name,
              state: _state,
            ),
            if (_loading)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 6),
                child: LinearProgressIndicator(minHeight: 2),
              ),
            SectionCard(
              title: '此刻的状态',
              child: Column(
                children: <Widget>[
                  _kvRow('动作', _state.motion, icon: Icons.directions_run),
                  _kvRow('心理', _state.psychology, icon: Icons.psychology_outlined),
                  _kvRow('心情', _state.mood, icon: Icons.mood_outlined),
                  _kvRow('健康', _state.health, icon: Icons.healing_outlined),
                  _kvRow('睡眠', _state.sleepLabel, icon: Icons.bedtime_outlined),
                  _kvRow(
                    '更新于',
                    formatDateTime(_state.updatedAt),
                    icon: Icons.schedule,
                  ),
                ],
              ),
            ),
            SectionCard(
              title: '陪伴',
              child: Column(
                children: <Widget>[
                  _kvRow(
                    '亲密度',
                    '${_state.intimacy.toStringAsFixed(1)} / 100',
                    icon: Icons.favorite,
                  ),
                  Padding(
                    padding: const EdgeInsets.only(left: 21, bottom: 6),
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(5),
                      child: LinearProgressIndicator(
                        value: (_state.intimacy / 100).clamp(0.0, 1.0),
                        minHeight: 7,
                        backgroundColor: AppColors.sand,
                      ),
                    ),
                  ),
                  _kvRow(
                    '陪伴天数',
                    '${_state.companionDays} 天',
                    icon: Icons.calendar_today_outlined,
                  ),
                  _kvRow(
                    '对话数',
                    '${_state.chatCount} 句',
                    icon: Icons.chat_bubble_outline,
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
              child: Row(
                children: <Widget>[
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: _loading ? null : _load,
                      icon: const Icon(Icons.refresh, size: 17),
                      label: const Text('刷新状态'),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: FilledButton.icon(
                      onPressed: _waking ? null : _wake,
                      style: FilledButton.styleFrom(
                        backgroundColor:
                            _state.resting ? AppColors.warn : AppColors.cocoa,
                      ),
                      icon: _waking
                          ? const SizedBox(
                              width: 14,
                              height: 14,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                                color: Colors.white,
                              ),
                            )
                          : const Icon(Icons.notifications_active_outlined,
                              size: 17),
                      label: const Text('强行叫醒'),
                    ),
                  ),
                ],
              ),
            ),
            const Padding(
              padding: EdgeInsets.fromLTRB(16, 10, 16, 0),
              child: Text(
                '角色每 10 分钟根据人设、世界与身体状态刷新一次；休息时强行叫醒可能带来不必要的麻烦。',
                style: TextStyle(
                  fontSize: 10.5,
                  color: AppColors.inkSoft,
                  height: 1.5,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
