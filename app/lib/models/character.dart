import '../core/json_utils.dart';

/// 角色运行状态（后端每 10 分钟刷新一次，经 WS state 事件推送）。
class CharacterState {
  const CharacterState({
    this.motion = '',
    this.psychology = '',
    this.mood = '',
    this.health = '',
    this.sleepState = 'awake',
    this.updatedAt = '',
    this.intimacy = 0,
    this.companionDays = 1,
    this.chatCount = 0,
  });

  final String motion;
  final String psychology;
  final String mood;
  final String health;
  final String sleepState;
  final String updatedAt;
  final double intimacy;
  final int companionDays;
  final int chatCount;

  static const CharacterState empty = CharacterState();

  bool get sleeping => sleepState == 'sleep';
  bool get napping => sleepState == 'nap';
  bool get resting => sleeping || napping;

  String get sleepLabel {
    switch (sleepState) {
      case 'sleep':
        return '睡眠中';
      case 'nap':
        return '午睡中';
      default:
        return '清醒';
    }
  }

  String get moodEmoji {
    if (mood.contains('开心') || mood.contains('高兴') || mood.contains('愉快')) {
      return '😊';
    }
    if (mood.contains('烦') || mood.contains('低落') || mood.contains('难过')) {
      return '🥺';
    }
    if (mood.contains('困') || mood.contains('累')) return '😪';
    if (mood.contains('生气') || mood.contains('怒')) return '😠';
    return '🙂';
  }

  factory CharacterState.fromJson(Map<String, dynamic> j) => CharacterState(
        motion: asString(j['motion']),
        psychology: asString(j['psychology']),
        mood: asString(j['mood']),
        health: asString(j['health']),
        sleepState: asString(j['sleepState'], 'awake'),
        updatedAt: asString(j['updatedAt']),
        intimacy: asDouble(j['intimacy']),
        companionDays: asInt(j['companionDays'], 1),
        chatCount: asInt(j['chatCount']),
      );

  Map<String, dynamic> toJson() => <String, dynamic>{
        'motion': motion,
        'psychology': psychology,
        'mood': mood,
        'health': health,
        'sleepState': sleepState,
        'updatedAt': updatedAt,
        'intimacy': intimacy,
        'companionDays': companionDays,
        'chatCount': chatCount,
      };
}

class SleepSchedule {
  const SleepSchedule({
    this.enabled = true,
    this.start = '23:30',
    this.end = '07:00',
    this.napStart = '13:00',
    this.napEnd = '14:30',
  });

  final bool enabled;
  final String start;
  final String end;
  final String napStart;
  final String napEnd;

  factory SleepSchedule.fromJson(Map<String, dynamic> j) => SleepSchedule(
        enabled: asBool(j['enabled'], true),
        start: asString(j['start'], '23:30'),
        end: asString(j['end'], '07:00'),
        napStart: asString(j['napStart'], '13:00'),
        napEnd: asString(j['napEnd'], '14:30'),
      );

  Map<String, dynamic> toJson() => <String, dynamic>{
        'enabled': enabled,
        'start': start,
        'end': end,
        'napStart': napStart,
        'napEnd': napEnd,
      };

  SleepSchedule copyWith({
    bool? enabled,
    String? start,
    String? end,
    String? napStart,
    String? napEnd,
  }) =>
      SleepSchedule(
        enabled: enabled ?? this.enabled,
        start: start ?? this.start,
        end: end ?? this.end,
        napStart: napStart ?? this.napStart,
        napEnd: napEnd ?? this.napEnd,
      );
}

class CharacterSettings {
  const CharacterSettings({
    this.rss = const <RssFeed>[],
    this.creationTags = const <String>[],
    this.creationFrequency = 'daily',
    this.sleep = const SleepSchedule(),
    this.statusIntervalMin = 10,
    this.activeReply = true,
    this.timezone = 'Asia/Shanghai',
    this.modelRouting = const <String, String>{},
    this.searchProvider = 'deepseek',
    this.diaryHintEnabled = true,
  });

  final List<RssFeed> rss;
  final List<String> creationTags;
  final String creationFrequency;
  final SleepSchedule sleep;
  final int statusIntervalMin;
  final bool activeReply;
  final String timezone;
  final Map<String, String> modelRouting;
  final String searchProvider;
  final bool diaryHintEnabled;

  static const CharacterSettings defaults = CharacterSettings();

  factory CharacterSettings.fromJson(Map<String, dynamic> j) =>
      CharacterSettings(
        rss: asList(j['rss']).map(RssFeed.fromAny).where((RssFeed f) => f.url.isNotEmpty).toList(),
        creationTags: asStringList(j['creationTags']),
        creationFrequency: asString(j['creationFrequency'], 'daily'),
        sleep: SleepSchedule.fromJson(asMap(j['sleep'])),
        statusIntervalMin: asInt(j['statusIntervalMin'], 10),
        activeReply: asBool(j['activeReply'], true),
        timezone: asString(j['timezone'], 'Asia/Shanghai'),
        modelRouting: asStringMap(j['modelRouting']),
        searchProvider: asString(j['searchProvider'], 'deepseek'),
        diaryHintEnabled: asBool(j['diaryHintEnabled'], true),
      );

  Map<String, dynamic> toJson() => <String, dynamic>{
        'rss': rss,
        'creationTags': creationTags,
        'creationFrequency': creationFrequency,
        'sleep': sleep.toJson(),
        'statusIntervalMin': statusIntervalMin,
        'activeReply': activeReply,
        'timezone': timezone,
        'modelRouting': modelRouting,
        'searchProvider': searchProvider,
        'diaryHintEnabled': diaryHintEnabled,
      };

  CharacterSettings copyWith({
    List<RssFeed>? rss,
    List<String>? creationTags,
    String? creationFrequency,
    SleepSchedule? sleep,
    int? statusIntervalMin,
    bool? activeReply,
    String? timezone,
    Map<String, String>? modelRouting,
    String? searchProvider,
    bool? diaryHintEnabled,
  }) =>
      CharacterSettings(
        rss: rss ?? this.rss,
        creationTags: creationTags ?? this.creationTags,
        creationFrequency: creationFrequency ?? this.creationFrequency,
        sleep: sleep ?? this.sleep,
        statusIntervalMin: statusIntervalMin ?? this.statusIntervalMin,
        activeReply: activeReply ?? this.activeReply,
        timezone: timezone ?? this.timezone,
        modelRouting: modelRouting ?? this.modelRouting,
        searchProvider: searchProvider ?? this.searchProvider,
        diaryHintEnabled: diaryHintEnabled ?? this.diaryHintEnabled,
      );
}

/// 角色（含 9 个人设字段 + 状态 + 设置）。每个角色资产完全隔离。
class Character {
  const Character({
    required this.id,
    required this.name,
    this.age = '',
    this.race = '',
    this.gender = '',
    this.personality = '',
    this.worldview = '',
    this.hobbies = '',
    this.relation = '',
    this.appearance = '',
    this.occupation = '',
    this.avatar,
    this.createdAt = '',
    this.updatedAt = '',
    this.archived = false,
    this.state = CharacterState.empty,
    this.settings = CharacterSettings.defaults,
  });

  final String id;
  final String name;
  final String age;
  final String race;
  final String gender;
  final String personality;
  final String worldview;
  final String hobbies;
  final String relation;
  final String appearance;
  final String occupation;
  final String? avatar;
  final String createdAt;
  final String updatedAt;
  final bool archived;
  final CharacterState state;
  final CharacterSettings settings;

  static const Character empty = Character(id: '', name: '');

  factory Character.fromJson(Map<String, dynamic> j) => Character(
        id: asString(j['id']),
        name: asString(j['name'], '未命名'),
        age: asString(j['age']),
        race: asString(j['race']),
        gender: asString(j['gender']),
        personality: asString(j['personality']),
        worldview: asString(j['worldview']),
        hobbies: asString(j['hobbies']),
        relation: asString(j['relation']),
        appearance: asString(j['appearance']),
        occupation: asString(j['occupation']),
        avatar: asStringOrNull(j['avatar']),
        createdAt: asString(j['createdAt']),
        updatedAt: asString(j['updatedAt']),
        archived: asBool(j['archived']),
        state: CharacterState.fromJson(asMap(j['state'])),
        settings: CharacterSettings.fromJson(asMap(j['settings'])),
      );

  /// 9（含姓名共 10）个人设字段，用于创建/编辑提交。
  Map<String, dynamic> profileJson() => <String, dynamic>{
        'name': name,
        'age': age,
        'race': race,
        'gender': gender,
        'personality': personality,
        'worldview': worldview,
        'hobbies': hobbies,
        'relation': relation,
        'appearance': appearance,
        'occupation': occupation,
      };

  Character copyWith({
    String? name,
    String? age,
    String? race,
    String? gender,
    String? personality,
    String? worldview,
    String? hobbies,
    String? relation,
    String? appearance,
    String? occupation,
    String? avatar,
    bool? archived,
    CharacterState? state,
    CharacterSettings? settings,
  }) =>
      Character(
        id: id,
        name: name ?? this.name,
        age: age ?? this.age,
        race: race ?? this.race,
        gender: gender ?? this.gender,
        personality: personality ?? this.personality,
        worldview: worldview ?? this.worldview,
        hobbies: hobbies ?? this.hobbies,
        relation: relation ?? this.relation,
        appearance: appearance ?? this.appearance,
        occupation: occupation ?? this.occupation,
        avatar: avatar ?? this.avatar,
        createdAt: createdAt,
        updatedAt: updatedAt,
        archived: archived ?? this.archived,
        state: state ?? this.state,
        settings: settings ?? this.settings,
      );

  String get subtitle {
    final List<String> parts = <String>[
      if (age.isNotEmpty) '$age 岁',
      if (race.isNotEmpty) race,
      if (gender.isNotEmpty) gender,
      if (relation.isNotEmpty) relation,
    ];
    return parts.join(' · ');
  }
}

/// 扮演标签页所需的资料完整性检查。
class ProfileCompleteness {
  static int filled(Character c) {
    int n = 0;
    final List<String> values = <String>[
      c.name,
      c.age,
      c.race,
      c.gender,
      c.personality,
      c.worldview,
      c.hobbies,
      c.relation,
      c.appearance,
      c.occupation,
    ];
    for (final String v in values) {
      if (v.trim().isNotEmpty) n++;
    }
    return n;
  }
}

/// 便捷输入扩写结果。
class CharacterTemplate {
  const CharacterTemplate({
    required this.id,
    required this.name,
    required this.profile,
    this.createdAt = '',
  });

  final String id;
  final String name;
  final Map<String, dynamic> profile;
  final String createdAt;

  factory CharacterTemplate.fromJson(Map<String, dynamic> j) =>
      CharacterTemplate(
        id: asString(j['id']),
        name: asString(j['name'], '未命名模板'),
        profile: asMap(j['profile']),
        createdAt: asString(j['createdAt']),
      );

  Character toCharacterProfile() => Character.fromJson(<String, dynamic>{
        'name': profile['name'] ?? name,
        'age': profile['age'],
        'race': profile['race'],
        'gender': profile['gender'],
        'personality': profile['personality'],
        'worldview': profile['worldview'],
        'hobbies': profile['hobbies'],
        'relation': profile['relation'],
        'appearance': profile['appearance'],
        'occupation': profile['occupation'],
      });
}


/// RSS 订阅源（后端 rss 为对象数组 {name,url,enabled}）。
class RssFeed {
  const RssFeed({required this.name, required this.url, this.enabled = true});

  final String name;
  final String url;
  final bool enabled;

  factory RssFeed.fromAny(dynamic v) {
    if (v is String) return RssFeed(name: v, url: v);
    final Map<String, dynamic> m = asMap(v);
    final String url = asString(m['url']);
    return RssFeed(
      name: asString(m['name'], url),
      url: url,
      enabled: asBool(m['enabled'], true),
    );
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
        'name': name,
        'url': url,
        'enabled': enabled,
      };

  RssFeed copyWith({String? name, String? url, bool? enabled}) => RssFeed(
        name: name ?? this.name,
        url: url ?? this.url,
        enabled: enabled ?? this.enabled,
      );
}
