import '../core/api_client.dart';
import '../core/json_utils.dart';
import '../models/model_share.dart';

/// v1.2.0：模型分享/索要。
class ShareService {
  ShareService(this.api);

  final ApiClient api;

  List<ModelShare> _parse(dynamic r) {
    final List<dynamic> raw = r is List ? r : asList(asMap(r)['items']);
    return asMapList(raw).map(ModelShare.fromJson).toList();
  }

  Future<List<ModelShare>> pending() async {
    final dynamic r = await api.get('/shares/pending', silent: true);
    return _parse(r);
  }

  Future<List<ModelShare>> list({String box = 'outgoing'}) async {
    final dynamic r = await api.get(
      '/shares',
      query: <String, dynamic>{'box': box},
      silent: true,
    );
    return _parse(r);
  }

  Future<ModelShare> create({
    required String target,
    required String direction,
    required List<String> services,
    ShareDuration? duration,
    String? expiresAt,
    bool permanent = false,
    String note = '',
  }) async {
    final dynamic r = await api.post('/shares', body: <String, dynamic>{
      'target': target,
      'direction': direction,
      'services': services,
      if (permanent) 'permanent': true,
      if (!permanent && expiresAt != null) 'expiresAt': expiresAt,
      if (!permanent && expiresAt == null && duration != null)
        'duration': duration.toJson(),
      if (note.isNotEmpty) 'note': note,
    });
    final Map<String, dynamic> m = asMap(r);
    final dynamic share = m['share'] ?? m;
    return ModelShare.fromJson(asMap(share));
  }

  Future<void> respond(String id, bool accept) async {
    await api.post(
      '/shares/$id/respond',
      body: <String, dynamic>{'accept': accept},
    );
  }

  Future<void> revoke(String id) async {
    await api.post('/shares/$id/revoke');
  }
}
