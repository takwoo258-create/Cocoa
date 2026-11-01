import '../core/api_client.dart';
import '../core/json_utils.dart';
import '../models/chat_message.dart';

class ChatService {
  ChatService(this.api);

  final ApiClient api;

  Future<SendMessageResult> send({
    required String characterId,
    required String kind,
    String text = '',
    String? mediaId,
    Map<String, dynamic>? meta,
  }) async {
    final dynamic r = await api.post(
      '/characters/$characterId/messages',
      body: <String, dynamic>{
        'kind': kind,
        'text': text,
        'mediaId': mediaId,
        'meta': <String, dynamic>{
          'clientTs': DateTime.now().toUtc().toIso8601String(),
          ...?meta,
        },
      },
    );
    return SendMessageResult.fromJson(asMap(r));
  }

  Future<List<ChatMessage>> history(
    String characterId, {
    String? before,
    int limit = 50,
  }) async {
    final dynamic r = await api.get(
      '/characters/$characterId/messages',
      query: <String, dynamic>{'before': before, 'limit': limit},
    );
    final List<dynamic> raw = r is List ? r : asList(asMap(r)['items']);
    return asMapList(raw)
        .map((Map<String, dynamic> j) => ChatMessage.fromJson(j))
        .toList();
  }

  Future<Map<String, dynamic>> activeReply(String characterId) async {
    return asMap(await api.post('/characters/$characterId/active-reply'));
  }

  /// 叫醒：返回 wakeup=1 表示模型接受并会生成回复。
  Future<int> wake(String characterId) async {
    final dynamic r = await api.post('/characters/$characterId/wake');
    return asInt(asMap(r)['wakeup']);
  }

  Future<ContextUsage> context(String characterId) async {
    final dynamic r = await api.get(
      '/characters/$characterId/context',
      silent: true,
    );
    final Map<String, dynamic> m = asMap(r);
    final dynamic c = m['context'];
    return ContextUsage.fromJson(c is Map ? asMap(c) : m);
  }
}
