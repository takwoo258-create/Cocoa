import '../core/json_utils.dart';

/// 分享相关用户（代号/昵称）。
class ShareUser {
  const ShareUser({this.id = '', this.code = 0, this.nickname = ''});

  final String id;
  final int code;
  final String nickname;

  String get label {
    final String name = nickname.isEmpty ? id : nickname;
    return code > 0 ? '#$code $name' : name;
  }

  factory ShareUser.fromJson(Map<String, dynamic> j) => ShareUser(
        id: asString(j['id']),
        code: asInt(j['code']),
        nickname: asString(j['nickname'], asString(j['username'])),
      );
}

/// 可组合的分享时长（后端按年/月/周/天/小时/分钟）。
class ShareDuration {
  const ShareDuration({
    this.years = 0,
    this.months = 0,
    this.weeks = 0,
    this.days = 0,
    this.hours = 0,
    this.minutes = 0,
  });

  final int years;
  final int months;
  final int weeks;
  final int days;
  final int hours;
  final int minutes;

  bool get isZero =>
      years == 0 && months == 0 && weeks == 0 && days == 0 && hours == 0 && minutes == 0;

  Map<String, dynamic> toJson() => <String, dynamic>{
        'years': years,
        'months': months,
        'weeks': weeks,
        'days': days,
        'hours': hours,
        'minutes': minutes,
      };

  String get label {
    final List<String> parts = <String>[
      if (years > 0) '$years 年',
      if (months > 0) '$months 月',
      if (weeks > 0) '$weeks 周',
      if (days > 0) '$days 天',
      if (hours > 0) '$hours 小时',
      if (minutes > 0) '$minutes 分钟',
    ];
    return parts.isEmpty ? '0 分钟' : parts.join(' ');
  }

  factory ShareDuration.fromJson(Map<String, dynamic> j) => ShareDuration(
        years: asInt(j['years']),
        months: asInt(j['months']),
        weeks: asInt(j['weeks']),
        days: asInt(j['days']),
        hours: asInt(j['hours']),
        minutes: asInt(j['minutes']),
      );
}

/// 模型分享/索要记录。
class ModelShare {
  const ModelShare({
    required this.id,
    this.direction = 'share',
    this.status = 'pending',
    this.owner = const ShareUser(),
    this.target = const ShareUser(),
    this.services = const <String>[],
    this.permanent = false,
    this.duration,
    this.expiresAt = '',
    this.note = '',
    this.createdAt = '',
    this.canRespond = false,
    this.canRevoke = false,
    this.side = '',
    this.effective = false,
  });

  final String id;

  /// share=我分享给别人 / request=我向别人索要。
  final String direction;

  /// pending/accepted/rejected/revoked/expired。
  final String status;
  final ShareUser owner;
  final ShareUser target;
  final List<String> services;
  final bool permanent;
  final ShareDuration? duration;
  final String expiresAt;
  final String note;
  final String createdAt;
  final bool canRespond;
  final bool canRevoke;
  final String side;
  final bool effective;

  bool get isPending => status == 'pending';
  bool get isAccepted => status == 'accepted';
  bool get isIncoming => direction == 'request' || direction == 'incoming';

  String get statusLabel {
    switch (status) {
      case 'pending':
        return '待处理';
      case 'accepted':
        return effective ? '生效中' : '已接受';
      case 'rejected':
        return '已拒绝';
      case 'revoked':
        return '已撤销';
      case 'expired':
        return '已到期';
      default:
        return status;
    }
  }

  String get directionLabel {
    switch (direction) {
      case 'share':
      case 'outgoing':
        return '分享给';
      case 'request':
      case 'incoming':
        return '向';
      default:
        return direction;
    }
  }

  String get timeLabel {
    if (permanent) return '永久';
    if (expiresAt.isNotEmpty) return '至 $expiresAt';
    if (duration != null) return '时长 ${duration!.label}';
    return '—';
  }

  factory ModelShare.fromJson(Map<String, dynamic> j) => ModelShare(
        id: asString(j['id']),
        direction: asString(j['direction'], 'share'),
        status: asString(j['status'], 'pending'),
        owner: ShareUser.fromJson(asMap(j['owner'])),
        target: ShareUser.fromJson(asMap(j['target'])),
        services: asStringList(j['services']),
        permanent: asBool(j['permanent']),
        duration: j['duration'] is Map
            ? ShareDuration.fromJson(asMap(j['duration']))
            : null,
        expiresAt: asString(j['expiresAt']),
        note: asString(j['note']),
        createdAt: asString(j['createdAt']),
        canRespond: asBool(j['canRespond']),
        canRevoke: asBool(j['canRevoke']),
        side: asString(j['side']),
        effective: asBool(j['effective']) || asString(j['status']) == 'accepted',
      );
}
