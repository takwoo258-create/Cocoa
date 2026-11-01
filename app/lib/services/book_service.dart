import '../core/api_client.dart';
import '../core/json_utils.dart';
import '../models/book.dart';

class BookService {
  BookService(this.api);

  final ApiClient api;

  Future<List<Book>> list({
    required String characterId,
    required String type,
  }) async {
    final dynamic r = await api.get(
      '/books',
      query: <String, dynamic>{'characterId': characterId, 'type': type},
    );
    final List<dynamic> raw = r is List ? r : asList(asMap(r)['items']);
    return asMapList(raw)
        .map((Map<String, dynamic> j) => Book.fromJson(j))
        .toList();
  }

  Future<Book> detail(String id, {String? password}) async {
    final dynamic r = await api.get(
      '/books/$id',
      query: <String, dynamic>{'password': password},
    );
    final Map<String, dynamic> m = asMap(r);
    final dynamic b = m['book'] ?? m['item'];
    return Book.fromJson(b is Map ? asMap(b) : m);
  }

  Future<Book> create({
    required String characterId,
    required String type,
    required String title,
    String content = '',
  }) async {
    final dynamic r = await api.post('/books', body: <String, dynamic>{
      'characterId': characterId,
      'type': type,
      'title': title,
      'content': content,
    });
    final Map<String, dynamic> m = asMap(r);
    return Book.fromJson(asMap(m['book'] ?? m));
  }

  Future<DiaryLockStatus> lockStatus(String characterId) async {
    final dynamic r = await api.get(
      '/books/diary/lock-status',
      query: <String, dynamic>{'characterId': characterId},
    );
    final Map<String, dynamic> m = asMap(r);
    final dynamic s = m['status'];
    return DiaryLockStatus.fromJson(s is Map ? asMap(s) : m);
  }

  Future<DiaryUnlockResult> unlockDiary({
    required String characterId,
    required String password,
  }) async {
    final dynamic r = await api.post(
      '/books/diary/unlock',
      body: <String, dynamic>{
        'characterId': characterId,
        'password': password,
      },
      silent: true,
    );
    return DiaryUnlockResult.fromJson(asMap(r));
  }
}
