import '../core/api_client.dart';
import '../core/json_utils.dart';
import '../models/plaza.dart';

class PlazaService {
  PlazaService(this.api);
  final ApiClient api;

  Future<PlazaMeta> meta() async =>
      PlazaMeta.fromJson(asMap(await api.get('/plaza/meta', silent: true)));

  Future<String> shareId() async =>
      asString(asMap(await api.get('/plaza/share-id', silent: true))['shareId']);

  Future<String> rotateShareId() async => asString(
        asMap(await api.post('/plaza/share-id/rotate', silent: true))['shareId'],
      );

  Future<PlazaListResult> resources({
    String scope = 'server',
    String q = '',
    String kind = '',
    String shareId = '',
    String sort = 'latest',
    int page = 1,
    int pageSize = 20,
  }) async =>
      PlazaListResult.fromJson(asMap(await api.get(
        '/plaza/resources',
        query: <String, dynamic>{
          'scope': scope,
          'q': q,
          'kind': kind,
          'shareId': shareId,
          'sort': sort,
          'page': page,
          'pageSize': pageSize,
        },
        silent: true,
      )));

  Future<PlazaListResult> globalList({
    String q = '',
    String kind = '',
    String sort = 'latest',
    int page = 1,
    int pageSize = 20,
  }) async =>
      PlazaListResult.fromJson(asMap(await api.get(
        '/plaza/global/list',
        query: <String, dynamic>{
          'q': q,
          'kind': kind,
          'sort': sort,
          'page': page,
          'pageSize': pageSize,
        },
        silent: true,
      )));

  Future<dynamic> publish(Map<String, dynamic> body, {required bool global}) =>
      api.post(global ? '/plaza/global/publish' : '/plaza/resources', body: body);

  Future<PlazaListResult> mine({String box = 'published'}) async =>
      PlazaListResult.fromJson(asMap(await api.get(
        '/plaza/mine',
        query: <String, dynamic>{'box': box},
        silent: true,
      )));

  Future<void> like(String id, {required bool global}) =>
      api.post(global ? '/plaza/global/$id/like' : '/plaza/resources/$id/like',
          silent: true);

  Future<Map<String, dynamic>> use(String id, {required bool global}) async =>
      asMap(await api.post(global ? '/plaza/global/$id/use' : '/plaza/$id/use'));

  Future<void> deleteResource(String id) =>
      api.delete('/plaza/resources/$id');

  Future<PlazaListResult> grants() async =>
      PlazaListResult.fromJson(asMap(await api.get('/plaza/grants', silent: true)));

  Future<List<Map<String, dynamic>>> grantsRaw() async {
    final dynamic r = await api.get('/plaza/grants', silent: true);
    return asMapList(asMap(r)['items']);
  }

  Future<Map<String, dynamic>> grantDetail(String id) async =>
      asMap(await api.get('/plaza/grants/$id', silent: true));

  Future<List<PlazaLegacyShare>> legacyShares() async {
    final dynamic r = await api.get('/plaza/legacy-shares', silent: true);
    return asMapList(asMap(r)['items']).map(PlazaLegacyShare.fromJson).toList();
  }
}
