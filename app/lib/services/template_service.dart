import '../core/api_client.dart';
import '../core/json_utils.dart';
import '../models/character.dart';

class TemplateService {
  TemplateService(this.api);
  final ApiClient api;

  Future<List<CharacterTemplate>> list() async {
    final dynamic r = await api.get('/templates', silent: true);
    return asMapList(r is List ? r : asMap(r)['items'])
        .map(CharacterTemplate.fromJson)
        .toList();
  }

  Future<List<Map<String, dynamic>>> sources() async {
    final dynamic r = await api.get('/templates/sources', silent: true);
    return asMapList(asMap(r)['items']);
  }

  Future<CharacterTemplate> create({
    required Map<String, dynamic> profile,
    String name = '',
  }) async {
    final dynamic r = await api.post('/templates', body: <String, dynamic>{
      if (name.isNotEmpty) 'name': name,
      'profile': profile,
    });
    return CharacterTemplate.fromJson(asMap(asMap(r)['template'] ?? r));
  }

  Future<CharacterTemplate> importCharacter(String characterId) async {
    final dynamic r = await api.post(
      '/templates/import',
      body: <String, dynamic>{'characterId': characterId},
    );
    return CharacterTemplate.fromJson(asMap(asMap(r)['template'] ?? r));
  }

  Future<CharacterTemplate> fromPlaza(String resourceId) async {
    final dynamic r = await api.post(
      '/templates/from-plaza',
      body: <String, dynamic>{'resourceId': resourceId},
    );
    return CharacterTemplate.fromJson(asMap(asMap(r)['template'] ?? r));
  }

  Future<Character> apply(String id, {String? name}) async {
    final dynamic r = await api.post(
      '/templates/$id/apply',
      body: <String, dynamic>{
        if (name != null && name.isNotEmpty) 'name': name,
      },
    );
    final Map<String, dynamic> m = asMap(r);
    return Character.fromJson(asMap(m['character'] ?? m));
  }

  Future<void> publish(String id, Map<String, dynamic> body) =>
      api.post('/templates/$id/publish', body: body);

  Future<void> delete(String id) => api.delete('/templates/$id');
}
