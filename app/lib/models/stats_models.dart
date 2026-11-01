import '../core/json_utils.dart';

class UsageTotals {
  const UsageTotals({
    this.input = 0,
    this.inputHit = 0,
    this.inputMiss = 0,
    this.output = 0,
    this.total = 0,
    this.cost = 0,
    this.calls = 0,
  });

  final int input;
  final int inputHit;
  final int inputMiss;
  final int output;
  final int total;
  final double cost;
  final int calls;

  factory UsageTotals.fromJson(Map<String, dynamic> j) {
    final int input = asInt(j['input']);
    final int hit = asInt(j['inputHit']);
    final int miss = asInt(j['inputMiss']);
    return UsageTotals(
      input: input,
      inputHit: hit,
      inputMiss: miss,
      output: asInt(j['output']),
      total: asInt(j['total'], input + asInt(j['output'])),
      cost: asDouble(j['cost']),
      calls: asInt(j['calls']),
    );
  }

  static const UsageTotals zero = UsageTotals();
}

class UsagePoint {
  const UsagePoint({
    required this.key,
    this.input = 0,
    this.cached = 0,
    this.output = 0,
    this.cost = 0,
    this.calls = 0,
  });

  final String key;
  final int input;
  final int cached;
  final int output;
  final double cost;
  final int calls;

  int get total => input + output;

  factory UsagePoint.fromJson(Map<String, dynamic> j) => UsagePoint(
        key: asString(j['key'], asString(j['t'])),
        input: asInt(j['input']),
        cached: asInt(j['cached']),
        output: asInt(j['output']),
        cost: asDouble(j['cost']),
        calls: asInt(j['calls']),
      );
}

class ModelUsage {
  const ModelUsage({
    required this.model,
    this.input = 0,
    this.cached = 0,
    this.output = 0,
    this.cost = 0,
    this.calls = 0,
  });

  final String model;
  final int input;
  final int cached;
  final int output;
  final double cost;
  final int calls;

  int get total => input + output;

  factory ModelUsage.fromJson(Map<String, dynamic> j) => ModelUsage(
        model: asString(j['model'], '未知模型'),
        input: asInt(j['input']),
        cached: asInt(j['cached']),
        output: asInt(j['output']),
        cost: asDouble(j['cost']),
        calls: asInt(j['calls']),
      );
}

class UsageResult {
  const UsageResult({
    this.range = '7d',
    this.from = '',
    this.to = '',
    this.totals = UsageTotals.zero,
    this.series = const <UsagePoint>[],
    this.models = const <ModelUsage>[],
  });

  final String range;
  final String from;
  final String to;
  final UsageTotals totals;
  final List<UsagePoint> series;
  final List<ModelUsage> models;

  static const UsageResult empty = UsageResult();

  factory UsageResult.fromJson(Map<String, dynamic> j) => UsageResult(
        range: asString(j['range'], '7d'),
        from: asString(j['from']),
        to: asString(j['to']),
        totals: UsageTotals.fromJson(asMap(j['totals'])),
        series: asMapList(j['series'])
            .map((Map<String, dynamic> p) => UsagePoint.fromJson(p))
            .toList(),
        models: asMapList(j['models'])
            .map((Map<String, dynamic> m) => ModelUsage.fromJson(m))
            .toList(),
      );
}

class IntimacyPoint {
  const IntimacyPoint({required this.t, required this.v});

  final String t;
  final double v;

  factory IntimacyPoint.fromJson(Map<String, dynamic> j) => IntimacyPoint(
        t: asString(j['t']),
        v: asDouble(j['v']),
      );
}

class IntimacyResult {
  const IntimacyResult({
    this.current = 0,
    this.companionDays = 0,
    this.points = const <IntimacyPoint>[],
  });

  final double current;
  final int companionDays;
  final List<IntimacyPoint> points;

  static const IntimacyResult empty = IntimacyResult();

  factory IntimacyResult.fromJson(Map<String, dynamic> j) => IntimacyResult(
        current: asDouble(j['current']),
        companionDays: asInt(j['companionDays']),
        points: asMapList(j['points'])
            .map((Map<String, dynamic> p) => IntimacyPoint.fromJson(p))
            .toList(),
      );
}

class ModelCallCount {
  const ModelCallCount({required this.model, this.calls = 0});

  final String model;
  final int calls;

  factory ModelCallCount.fromJson(Map<String, dynamic> j) => ModelCallCount(
        model: asString(j['model'], '未知模型'),
        calls: asInt(j['calls']),
      );
}

class CharacterOverview {
  const CharacterOverview({
    this.chatCount = 0,
    this.bookCount = 0,
    this.healthAbnormal = 0,
    this.moodAbnormal = 0,
    this.companionDays = 0,
    this.intimacy = 0,
    this.calls = 0,
    this.callsByModel = const <ModelCallCount>[],
  });

  final int chatCount;
  final int bookCount;
  final int healthAbnormal;
  final int moodAbnormal;
  final int companionDays;
  final double intimacy;

  /// v1.2.0：模型调用次数。
  final int calls;
  final List<ModelCallCount> callsByModel;

  static const CharacterOverview empty = CharacterOverview();

  factory CharacterOverview.fromJson(Map<String, dynamic> j) =>
      CharacterOverview(
        chatCount: asInt(j['chatCount']),
        bookCount: asInt(j['bookCount']),
        healthAbnormal: asInt(j['healthAbnormal']),
        moodAbnormal: asInt(j['moodAbnormal']),
        companionDays: asInt(j['companionDays']),
        intimacy: asDouble(j['intimacy']),
        calls: asInt(j['calls']),
        callsByModel: asMapList(j['callsByModel'])
            .map(ModelCallCount.fromJson)
            .toList(),
      );
}

class StorageUsage {
  const StorageUsage({
    this.db = 0,
    this.wal = 0,
    this.messages = 0,
    this.media = 0,
    this.cache = 0,
    this.total = 0,
  });

  final int db;
  final int wal;
  final int messages;
  final int media;
  final int cache;
  final int total;

  static const StorageUsage empty = StorageUsage();

  factory StorageUsage.fromJson(Map<String, dynamic> j) => StorageUsage(
        db: asInt(j['db']),
        wal: asInt(j['wal']),
        messages: asInt(j['messages']),
        media: asInt(j['media']),
        cache: asInt(j['cache']),
        total: asInt(j['total']),
      );
}

class AdminOverview {
  const AdminOverview({
    this.users = 0,
    this.online = 0,
    this.active7d = 0,
    this.activeIndex = 0,
    this.conversations = 0,
    this.activeConversations = 0,
    this.characters = 0,
    this.messages = 0,
    this.usage = UsageTotals.zero,
    this.storage = StorageUsage.empty,
    this.onebot = const <String, dynamic>{},
    this.formula = '',
  });

  final int users;
  final int online;
  final int active7d;
  final double activeIndex;
  final int conversations;
  final int activeConversations;
  final int characters;
  final int messages;
  final UsageTotals usage;
  final StorageUsage storage;
  final Map<String, dynamic> onebot;
  final String formula;

  static const AdminOverview empty = AdminOverview();

  factory AdminOverview.fromJson(Map<String, dynamic> j) {
    final Map<String, dynamic> users = asMap(j['users']);
    final Map<String, dynamic> conv = asMap(j['conversations']);
    return AdminOverview(
      users: asInt(users['total'] ?? j['userCount'] ?? j['users']),
      online: asInt(users['online'] ?? j['online']),
      active7d: asInt(users['active7d']),
      activeIndex: asDouble(j['activeIndex'] ?? j['activity']),
      conversations: asInt(conv['total'] ?? j['sessionCount']),
      activeConversations: asInt(conv['active'] ?? j['activeSessions']),
      characters: asInt(j['characters']),
      messages: asInt(j['messages']),
      usage: UsageTotals.fromJson(asMap(j['usage'])),
      storage: StorageUsage.fromJson(asMap(j['storage'])),
      onebot: asMap(j['onebot']),
      formula: asString(j['formula']),
    );
  }
}
