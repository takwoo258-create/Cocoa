import '../core/api_client.dart';
import '../core/json_utils.dart';
import '../models/stats_models.dart';

class StatsService {
  StatsService(this.api);

  final ApiClient api;

  Future<UsageResult> usage({
    String range = '7d',
    String? from,
    String? to,
    String? model,
    String? bucket,
    String? userId,
  }) async {
    final String path = userId == null ? '/stats/usage' : '/admin/usage';
    final dynamic r = await api.get(
      path,
      query: <String, dynamic>{
        'range': range,
        'from': from,
        'to': to,
        'model': model,
        'bucket': bucket,
        'userId': userId,
      },
    );
    return UsageResult.fromJson(asMap(r));
  }

  Future<IntimacyResult> intimacy({
    required String characterId,
    String range = '7d',
    String? from,
    String? to,
  }) async {
    final dynamic r = await api.get(
      '/stats/intimacy',
      query: <String, dynamic>{
        'characterId': characterId,
        'range': range,
        'from': from,
        'to': to,
      },
    );
    return IntimacyResult.fromJson(asMap(r));
  }

  Future<CharacterOverview> overview(String characterId) async {
    final dynamic r = await api.get(
      '/stats/overview',
      query: <String, dynamic>{'characterId': characterId},
    );
    final Map<String, dynamic> m = asMap(r);
    final dynamic o = m['overview'];
    return CharacterOverview.fromJson(o is Map ? asMap(o) : m);
  }
}
