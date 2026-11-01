import '../core/api_client.dart';
import '../core/json_utils.dart';
import '../models/character.dart';

/// 便捷输入扩写结果。
class CharacterExpandResult {
  const CharacterExpandResult({
    required this.profile,
    this.source = 'llm',
    this.reason,
  });

  final Map<String, dynamic> profile;
  final String source;
  final String? reason;

  bool get isLocal => source == 'local';
}

class CharacterService {
  CharacterService(this.api);

  final ApiClient api;

  Future<List<Character>> list({bool includeArchived = false}) async {
    final dynamic r = await api.get(
      '/characters',
      query: <String, dynamic>{'includeArchived': includeArchived},
    );
    final List<dynamic> raw = r is List ? r : asList(asMap(r)['items']);
    return asMapList(raw)
        .map((Map<String, dynamic> j) => Character.fromJson(j))
        .toList();
  }

  Future<Character> get(String id) async {
    final dynamic r = await api.get('/characters/$id');
    return Character.fromJson(asMap(asMap(r)['character']));
  }

  Future<Character> create({
    required Map<String, dynamic> profile,
    Map<String, dynamic>? settings,
    String? templateId,
  }) async {
    final dynamic r = await api.post('/characters', body: <String, dynamic>{
      ...profile,
      if (settings != null) 'settings': settings,
      if (templateId != null) 'templateId': templateId,
    });
    final Map<String, dynamic> m = asMap(r);
    final dynamic c = m['character'] ?? m;
    return Character.fromJson(asMap(c));
  }

  Future<Character> update(
    String id, {
    Map<String, dynamic>? profile,
    Map<String, dynamic>? settings,
    bool? archived,
  }) async {
    final dynamic r = await api.put('/characters/$id', body: <String, dynamic>{
      ...?profile,
      if (settings != null) 'settings': settings,
      if (archived != null) 'archived': archived,
    });
    final Map<String, dynamic> m = asMap(r);
    final dynamic c = m['character'] ?? m;
    return Character.fromJson(asMap(c));
  }

  Future<void> delete(String id) async {
    await api.delete('/characters/$id');
  }

  /// 便捷输入 → 大模型扩写 → 9 人设字段 JSON（失败时后端降级本地模板）。
  Future<CharacterExpandResult> expand(String prompt) async {
    final dynamic r = await api.post(
      '/characters/expand',
      body: <String, dynamic>{'prompt': prompt},
    );
    final Map<String, dynamic> m = asMap(r);
    final dynamic p = m['profile'];
    return CharacterExpandResult(
      profile: p is Map ? asMap(p) : m,
      source: asString(m['source'], 'llm'),
      reason: asStringOrNull(m['reason']),
    );
  }

  Future<List<CharacterTemplate>> templates() async {
    final dynamic r = await api.get('/characters/templates');
    final List<dynamic> raw = r is List ? r : asList(asMap(r)['items']);
    return asMapList(raw)
        .map((Map<String, dynamic> j) => CharacterTemplate.fromJson(j))
        .toList();
  }

  Future<CharacterTemplate> saveTemplate({
    required String name,
    required Map<String, dynamic> profile,
  }) async {
    final dynamic r = await api.post('/characters/templates', body: <String, dynamic>{
      'name': name,
      'profile': profile,
    });
    final Map<String, dynamic> m = asMap(r);
    return CharacterTemplate.fromJson(
      asMap(m['template'] ?? m),
    );
  }

  Future<CharacterSettings> getSettings(String id) async {
    final dynamic r = await api.get('/characters/$id/settings');
    final Map<String, dynamic> m = asMap(r);
    final dynamic s = m['settings'];
    return CharacterSettings.fromJson(s is Map ? asMap(s) : m);
  }

  Future<CharacterSettings> saveSettings(
    String id,
    Map<String, dynamic> patch,
  ) async {
    final dynamic r = await api.put(
      '/characters/$id/settings',
      body: patch,
    );
    final Map<String, dynamic> m = asMap(r);
    final dynamic s = m['settings'];
    return CharacterSettings.fromJson(s is Map ? asMap(s) : m);
  }

  Future<CharacterState> getState(String id) async {
    final dynamic r = await api.get('/characters/$id/state');
    final Map<String, dynamic> m = asMap(r);
    final dynamic s = m['state'];
    return CharacterState.fromJson(s is Map ? asMap(s) : m);
  }
}
