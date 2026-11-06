import 'dart:io';

import 'package:flutter/material.dart';
import 'package:just_audio/just_audio.dart';

import '../core/api_client.dart';
import '../core/app_state.dart';
import '../core/json_utils.dart';
import '../core/theme.dart';
import '../core/utils.dart';
import '../models/chat_message.dart';

/// 聊天气泡：文本 / 图片 / 语音 / 提示 / 主动回复。
class MessageBubble extends StatelessWidget {
  const MessageBubble({
    super.key,
    required this.message,
    required this.baseUrl,
    required this.token,
  });

  final ChatMessage message;
  final String baseUrl;
  final String? token;

  String? _resolveUrl() {
    if (message.localMediaPath != null) return null;
    final String? raw = message.mediaUrl;
    if (raw != null && raw.isNotEmpty) {
      if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
      final String base = ApiClient.normalizeBase(baseUrl);
      return raw.startsWith('/') ? '$base$raw' : '$base/$raw';
    }
    final String? id = message.mediaId;
    if (id != null) {
      return '${ApiClient.normalizeBase(baseUrl)}/api/media/$id';
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    if (message.isNotice) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 24),
        child: Center(
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            decoration: BoxDecoration(
              color: AppColors.bubbleNotice,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                const Icon(Icons.auto_awesome, size: 12, color: AppColors.rose),
                const SizedBox(width: 5),
                Flexible(
                  child: Text(
                    message.content,
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      fontSize: 11.5,
                      color: AppColors.inkSoft,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      );
    }

    final bool mine = message.fromUser;
    final bool subject = message.isSubjective;
    final Color bg = mine
        ? AppColors.bubbleUser
        : subject
            ? AppColors.bubbleSubjective
            : AppColors.bubbleAgent;

    final Widget body = _content(context);

    return Padding(
      padding: EdgeInsets.fromLTRB(mine ? 52 : 12, 4, mine ? 12 : 52, 4),
      child: Column(
        crossAxisAlignment:
            mine ? CrossAxisAlignment.end : CrossAxisAlignment.start,
        children: <Widget>[
          if (subject)
            const Padding(
              padding: EdgeInsets.only(bottom: 4, left: 4),
              child: Text(
                '主动来信',
                style: TextStyle(
                  fontSize: 10,
                  color: AppColors.rose,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          Container(
            padding: message.isImage
                ? const EdgeInsets.all(4)
                : const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
            decoration: BoxDecoration(
              color: bg,
              borderRadius: BorderRadius.only(
                topLeft: const Radius.circular(16),
                topRight: const Radius.circular(16),
                bottomLeft: Radius.circular(mine ? 16 : 4),
                bottomRight: Radius.circular(mine ? 4 : 16),
              ),
              border: subject
                  ? Border.all(color: AppColors.rose.withAlpha(120))
                  : null,
            ),
            child: body,
          ),
          const SizedBox(height: 2),
          Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              if (message.pending)
                const Padding(
                  padding: EdgeInsets.only(right: 4),
                  child: SizedBox(
                    width: 9,
                    height: 9,
                    child: CircularProgressIndicator(strokeWidth: 1.4),
                  ),
                ),
              Text(
                mine ? '你' : (subject ? '主动回复' : '角色'),
                style: const TextStyle(fontSize: 9, color: AppColors.inkSoft),
              ),
              const SizedBox(width: 5),
              Text(
                formatClock(message.createdAt),
                style: const TextStyle(fontSize: 9, color: AppColors.inkSoft),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _content(BuildContext context) {
    if (message.isImage) {
      final String? url = _resolveUrl();
      final String? local = message.localMediaPath;
      Widget img;
      if (local != null && File(local).existsSync()) {
        img = Image.file(File(local), fit: BoxFit.cover);
      } else if (url != null) {
        img = Image.network(
          url,
          headers: token == null ? null : <String, String>{'Authorization': 'Bearer $token'},
          fit: BoxFit.cover,
          errorBuilder: (_, __, ___) => const _Broken(),
        );
      } else {
        img = const _Broken();
      }
      return ClipRRect(
        borderRadius: BorderRadius.circular(12),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: 220, maxWidth: 220),
          child: img,
        ),
      );
    }
    if (message.isVoice) {
      return _VoiceBubble(
        url: _resolveUrl(),
        localPath: message.localMediaPath,
        token: token,
        duration: message.meta['duration'],
      );
    }
    final String thinking = asString(message.meta['thinking']);
    if (message.fromAgent &&
        thinking.isNotEmpty &&
        AppScope.of(context).thinkingMode) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          _ThinkingPanel(thinking: thinking),
          const SizedBox(height: 6),
          Text(
            message.content,
            style: const TextStyle(
              fontSize: 14,
              height: 1.45,
              color: AppColors.ink,
            ),
          ),
        ],
      );
    }
    return Text(
      message.content,
      style: const TextStyle(fontSize: 14, height: 1.45, color: AppColors.ink),
    );
  }
}

class _Broken extends StatelessWidget {
  const _Broken();

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 120,
      height: 80,
      color: AppColors.sand,
      child: const Center(
        child: Icon(Icons.broken_image_outlined, color: AppColors.inkSoft),
      ),
    );
  }
}

class _VoiceBubble extends StatefulWidget {
  const _VoiceBubble({
    required this.url,
    required this.localPath,
    required this.token,
    this.duration,
  });

  final String? url;
  final String? localPath;
  final String? token;
  final dynamic duration;

  @override
  State<_VoiceBubble> createState() => _VoiceBubbleState();
}

class _VoiceBubbleState extends State<_VoiceBubble> {
  AudioPlayer? _player;
  bool _playing = false;

  @override
  void dispose() {
    _player?.dispose();
    super.dispose();
  }

  Future<void> _toggle() async {
    if (_playing) {
      await _player?.stop();
      if (mounted) setState(() => _playing = false);
      return;
    }
    final String? url = widget.url;
    if (url == null && widget.localPath == null) return;
    _player ??= AudioPlayer();
    try {
      if (widget.localPath != null && File(widget.localPath!).existsSync()) {
        await _player!.setFilePath(widget.localPath!);
      } else {
        await _player!.setUrl(
          url!,
          headers: widget.token == null
              ? null
              : <String, String>{'Authorization': 'Bearer ${widget.token}'},
        );
      }
      setState(() => _playing = true);
      await _player!.play();
    } catch (_) {
      if (mounted) setState(() => _playing = false);
    }
    if (mounted) setState(() => _playing = false);
  }

  @override
  Widget build(BuildContext context) {
    final int seconds =
        widget.duration is num ? (widget.duration as num).round() : 0;
    return InkWell(
      onTap: _toggle,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(
            _playing ? Icons.pause_circle_filled : Icons.play_circle_fill,
            size: 26,
            color: AppColors.cocoa,
          ),
          const SizedBox(width: 6),
          Text(
            seconds > 0 ? "语音 $seconds''" : '语音消息',
            style: const TextStyle(fontSize: 13, color: AppColors.ink),
          ),
        ],
      ),
    );
  }
}


/// v1.2.0：思考内容折叠面板（meta.thinking）。
class _ThinkingPanel extends StatefulWidget {
  const _ThinkingPanel({required this.thinking});

  final String thinking;

  @override
  State<_ThinkingPanel> createState() => _ThinkingPanelState();
}

class _ThinkingPanelState extends State<_ThinkingPanel> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 2),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: AppColors.sand.withAlpha(120),
        borderRadius: BorderRadius.circular(9),
        border: Border.all(color: AppColors.sand),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          InkWell(
            onTap: () => setState(() => _expanded = !_expanded),
            child: SizedBox(
              width: double.infinity,
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                const Icon(
                  Icons.psychology_outlined,
                  size: 13,
                  color: AppColors.rose,
                ),
                const SizedBox(width: 4),
                Text(
                  _expanded ? '收起思考' : '查看思考',
                  style: const TextStyle(
                    fontSize: 10.5,
                    color: AppColors.cocoa,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const Spacer(),
                Icon(
                  _expanded ? Icons.expand_less : Icons.expand_more,
                  size: 16,
                  color: AppColors.cocoa,
                ),
                const SizedBox(width: 4),
              ],
                ),
              ),
            ),
          ),
          AnimatedCrossFade(
            firstChild: const SizedBox(width: double.infinity),
            secondChild: Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                widget.thinking,
                style: const TextStyle(
                  fontSize: 11,
                  height: 1.55,
                  color: AppColors.inkSoft,
                ),
              ),
            ),
            crossFadeState: _expanded
                ? CrossFadeState.showSecond
                : CrossFadeState.showFirst,
            duration: const Duration(milliseconds: 160),
          ),
        ],
      ),
    );
  }
}
