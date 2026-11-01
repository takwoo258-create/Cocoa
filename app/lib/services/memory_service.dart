import '../core/api_client.dart';
import '../core/json_utils.dart';
import '../models/memory_graph.dart';

class MemoryService {
  MemoryService(this.api);

  final ApiClient api;

  Future<MemoryGraph> graph(String characterId) async {
    final dynamic r = await api.get(
      '/memory/graph',
      query: <String, dynamic>{'characterId': characterId},
    );
    return MemoryGraph.fromJson(asMap(r));
  }

  Future<MemoryDetail> detail(String id) async {
    final dynamic r = await api.get('/memory/$id');
    return MemoryDetail.fromJson(asMap(r));
  }

  Future<void> delete(String id) async {
    await api.delete('/memory/$id');
  }

  Future<List<MemoryNode>> search({
    required String characterId,
    required String q,
  }) async {
    final dynamic r = await api.get(
      '/memory/search',
      query: <String, dynamic>{'characterId': characterId, 'q': q},
    );
    final List<dynamic> raw = r is List ? r : asList(asMap(r)['items']);
    return asMapList(raw)
        .map((Map<String, dynamic> j) => MemoryNode.fromJson(j))
        .toList();
  }
}
