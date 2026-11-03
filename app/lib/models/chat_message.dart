import '../core/json_utils.dart';

/// 聊天消息。role: user / agent / notice / subjective。
class ChatMessage {
  ChatMessage({
    required this.id,
    required this.role,
    this.kind = 'text',
    this.content = '',
    this.createdAt = '',
    this.meta = const <String, dynamic>{},
    this.pending = false,
    this.localMediaPath,
    this.sendAt,
  });

  final String id;
  final String role;
  final String kind;
  final String content;
  final String createdAt;
  final Map<String, dynamic> meta;

  /// 本地乐观发送标记（灰显 + 转圈）。
  final bool pending;

  /// 本地图片预览路径。
  final String? localMediaPath;

  /// 主动回复的排队发送时间（用于 UI 倒计时展示）。
  final DateTime? sendAt;

  factory ChatMessage.fromJson(Map<String, dynamic> j) => ChatMessage(
        id: asString(j['id'], 'm_${DateTime.now().microsecondsSinceEpoch}'),
        role: asString(j['role'], 'agent'),
        kind: asString(j['kind'], 'text'),
        content: asString(j['content']),
        createdAt: asString(j['createdAt']),
        meta: asMap(j['meta']),
      );

  factory ChatMessage.notice(String text) => ChatMessage(
        id: 'notice_${DateTime.now().microsecondsSinceEpoch}',
        role: 'notice',
        content: text,
      );

  bool get fromUser => role == 'user';
  bool get fromAgent => role == 'agent';
  bool get isNotice => role == 'notice';
  bool get isSubjective => role == 'subjective';
  bool get isImage => kind == 'image';
  bool get isVoice => kind == 'voice';

  int? get segment {
    final dynamic v = meta['segment'];
    return v == null ? null : asInt(v);
  }

  int? get segments {
    final dynamic v = meta['segments'];
    return v == null ? null : asInt(v);
  }

  int? get wait {
    final dynamic v = meta['wait'];
    return v == null ? null : asInt(v);
  }

  String? get mediaId {
    final dynamic v = meta['mediaId'] ?? meta['media_id'] ?? meta['voiceMediaId'];
    if (v == null) return null;
    final String s = v.toString();
    return s.isEmpty ? null : s;
  }

  String? get mediaUrl =>
      asStringOrNull(meta['url']) ??
      asStringOrNull(meta['mediaUrl']) ??
      asStringOrNull(meta['voiceUrl']);

  ChatMessage copyWith({
    String? id,
    String? role,
    String? kind,
    String? content,
    String? createdAt,
    Map<String, dynamic>? meta,
    bool? pending,
    String? localMediaPath,
    DateTime? sendAt,
  }) =>
      ChatMessage(
        id: id ?? this.id,
        role: role ?? this.role,
        kind: kind ?? this.kind,
        content: content ?? this.content,
        createdAt: createdAt ?? this.createdAt,
        meta: meta ?? this.meta,
        pending: pending ?? this.pending,
        localMediaPath: localMediaPath ?? this.localMediaPath,
        sendAt: sendAt ?? this.sendAt,
      );

  Map<String, dynamic> toJson() => <String, dynamic>{
        'id': id,
        'role': role,
        'kind': kind,
        'content': content,
        'createdAt': createdAt,
        'meta': meta,
      };
}

/// 发送用户消息的响应。
class SendMessageResult {
  const SendMessageResult({
    required this.accepted,
    required this.queued,
    this.notice,
    this.userMessage,
  });

  final bool accepted;
  final bool queued;
  final String? notice;
  final ChatMessage? userMessage;

  factory SendMessageResult.fromJson(Map<String, dynamic> j) =>
      SendMessageResult(
        accepted: asBool(j['accepted']),
        queued: asBool(j['queued']),
        notice: asStringOrNull(j['notice']),
        userMessage: j['userMessage'] is Map
            ? ChatMessage.fromJson(asMap(j['userMessage']))
            : null,
      );
}

/// 上下文占用（调试模式进度圈）。
class ContextUsage {
  const ContextUsage({
    this.used = 0,
    this.limit = 0,
    this.percent = 0,
    this.compressing = false,
  });

  final int used;
  final int limit;
  final double percent;
  final bool compressing;

  double get ratio {
    if (percent > 0) return percent > 1 ? percent / 100 : percent;
    if (limit <= 0) return 0;
    return used / limit;
  }

  factory ContextUsage.fromJson(Map<String, dynamic> j) => ContextUsage(
        used: asInt(j['used']),
        limit: asInt(j['limit']),
        percent: asDouble(j['percent']),
        compressing: asBool(j['compressing']),
      );
}
