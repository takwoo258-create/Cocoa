import 'dart:async';

import 'package:flutter/material.dart';
import '../core/layout.dart';

import '../core/api_client.dart';
import '../core/app_state.dart';
import '../core/global.dart';
import '../core/json_utils.dart';
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
  bool _refreshing = false;
  bool _enabled = true;
  Timer? _cooldownTimer;
  int _cooldownSec = 0;

  @override
  void initState() {
    super.initState();
    _state = widget.initialState ?? widget.character.state;
    _enabled = widget.character.settings.enabled;
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    final AppState state = AppScope.read(context);
    try {
      final CharacterState latest =
          await state.characterService.getState(widget.character.id);
      bool enabled = _enabled;
      try {
        final CharacterSettings settings =
            await state.characterService.getSettings(widget.character.id);
        enabled = settings.enabled;
      } catch (_) {}
      if (!mounted) return;
      setState(() {
        _state = latest;
        _enabled = enabled;
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
      final WakeResult result =
          await state.chatService.wake(widget.character.id);
      if (!mounted) return;
      setState(() {
        if (result.state != null) _state = result.state!;
      });
      showToast('${widget.character.name}被叫醒了');
      if (result.reply.trim().isNotEmpty) {
        await showDialog<void>(
          context: context,
          builder: (BuildContext ctx) => AlertDialog(
            title: Text('${widget.character.name} 醒了'),
            content: SingleChildScrollView(
              child: Text(
                result.reply,
                style: const TextStyle(fontSize: 13, height: 1.6),
              ),
            ),
            actions: <Widget>[
              TextButton(
                onPressed: () => Navigator.of(ctx).pop(),
                child: const Text('知道啦'),
              ),
            ],
          ),
        );
      } else {
        showToast('叫醒成功');
      }
      await _load();
    } on ApiException catch (e) {
      showToast(e.message, isError: true);
    } catch (e) {
      showToast('叫醒失败：$e', isError: true);
    } finally {
      if (mounted) setState(() => _waking = false);
    }
  }

  @override
  void dispose() {
    _cooldownTimer?.cancel();
    super.dispose();
  }

  void _applyCooldown(String? nextAllowedAt, {int fallbackSec = 300}) {
    DateTime? next = nextAllowedAt == null ? null : parseUtc8(nextAllowedAt);
    next ??= DateTime.now().add(Duration(seconds: fallbackSec));
    final int seconds = next.difference(DateTime.now()).inSeconds;
    _cooldownTimer?.cancel();
    setState(() => _cooldownSec = seconds > 0 ? seconds : 0);
    if (_cooldownSec <= 0) return;
    _cooldownTimer = Timer.periodic(const Duration(seconds: 1), (Timer t) {
      if (!mounted) {
        t.cancel();
        return;
      }
      setState(() {
        _cooldownSec -= 1;
        if (_cooldownSec <= 0) {
          _cooldownSec = 0;
          t.cancel();
        }
      });
    });
  }

  Future<void> _refreshStatus() async {
    final AppState state = AppScope.read(context);
    setState(() => _refreshing = true);
    try {
      final StatusRefreshResult r =
          await state.chatService.refreshStatus(widget.character.id);
      if (!mounted) return;
      setState(() {
        if (r.state != null) _state = r.state!;
        _loading = false;
      });
      _applyCooldown(r.nextAllowedAt);
      showToast('角色状态已刷新');
    } on ApiException catch (e) {
      if (!mounted) return;
      if (e.code == 'status_cooldown') {
        final Map<String, dynamic> detail = asMap(e.detail);
        final int retry = asInt(detail['retryAfterSec'], 300);
        _applyCooldown(
          asStringOrNull(detail['nextAllowedAt']),
          fallbackSec: retry,
        );
        showToast(
          '状态刷新冷却中，还需 ${retry ~/ 60} 分 ${retry % 60} 秒',
          isError: true,
        );
      } else {
        showToast(e.message, isError: true);
      }
    } catch (e) {
      showToast('状态刷新失败：$e', isError: true);
    } finally {
      if (mounted) setState(() => _refreshing = false);
    }
  }

  String get _cooldownLabel {
    final int m = _cooldownSec ~/ 60;
    final String sec = (_cooldownSec % 60).toString().padLeft(2, '0');
    return '冷却 $m:$sec';
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
          padding: pagePadding(context),
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
            if (!_enabled)
              Container(
                margin: const EdgeInsets.fromLTRB(12, 8, 12, 0),
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: AppColors.warn.withAlpha(22),
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: AppColors.warn.withAlpha(80)),
                ),
                child: const Text(
                  '角色已暂停：状态刷新与叫醒已禁用。',
                  style: TextStyle(fontSize: 11, color: AppColors.warn),
                ),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
              child: Row(
                children: <Widget>[
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: (!_enabled || _refreshing || _cooldownSec > 0)
                          ? null
                          : _refreshStatus,
                      icon: _refreshing
                          ? const SizedBox(
                              width: 14,
                              height: 14,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.refresh, size: 17),
                      label: Text(
                        _cooldownSec > 0 ? _cooldownLabel : '刷新状态',
                      ),
                    ),
                  ),
                  if (_state.resting) ...<Widget>[
                    const SizedBox(width: 10),
                    Expanded(
                      child: FilledButton.icon(
                        onPressed: (!_enabled || _waking) ? null : _wake,
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
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 10, 16, 0),
              child: Text(
                _cooldownSec > 0
                    ? '状态刷新冷却中（5 分钟），还需 ${_cooldownSec ~/ 60} 分 ${_cooldownSec % 60} 秒。'
                    : '角色每 10 分钟自动刷新状态；手动刷新会立即请求模型，冷却 5 分钟。休息时强行叫醒可能带来不必要的麻烦。',
                style: const TextStyle(
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
