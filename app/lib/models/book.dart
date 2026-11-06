import '../core/json_utils.dart';

/// 书架条目：novel / essay / diary / news。
class Book {
  const Book({
    required this.id,
    required this.type,
    required this.title,
    this.characterId = '',
    this.content = '',
    this.summary = '',
    this.createdAt = '',
    this.updatedAt = '',
    this.meta = const <String, dynamic>{},
    this.locked = false,
    this.seriesId = '',
    this.sessionId = '',
    this.words = 0,
    this.chapter = 0,
    this.short = false,
  });

  final String id;
  final String type;
  final String title;
  final String characterId;
  final String content;
  final String summary;
  final String createdAt;
  final String updatedAt;
  final Map<String, dynamic> meta;
  final bool locked;

  /// v1.5.0：连载 / 会话 / 字数 / 章节 / 短篇标记。
  final String seriesId;
  final String sessionId;
  final int words;
  final int chapter;
  final bool short;

  bool get isDiary => type == 'diary';

  factory Book.fromJson(Map<String, dynamic> j) => Book(
        id: asString(j['id']),
        type: asString(j['type'], 'novel'),
        title: asString(j['title'], '无标题'),
        characterId: asString(j['characterId']),
        content: asString(j['content']),
        summary: asString(j['summary']),
        createdAt: asString(j['createdAt']),
        updatedAt: asString(j['updatedAt']),
        meta: asMap(j['meta']),
        locked: asBool(j['locked']),
        seriesId: asString(j['seriesId']),
        sessionId: asString(j['sessionId']),
        words: asInt(j['words']),
        chapter: asInt(j['chapter']),
        short: asBool(j['short']),
      );

  String get displayDate {
    final String raw = createdAt.isNotEmpty ? createdAt : updatedAt;
    if (raw.isEmpty) return '';
    return raw;
  }

  String get previewText {
    if (summary.isNotEmpty) return summary;
    final String flat = content.replaceAll(RegExp(r'\s+'), ' ');
    return flat.length > 80 ? '${flat.substring(0, 80)}…' : flat;
  }
}

class DiaryLockStatus {
  const DiaryLockStatus({
    this.locked = true,
    this.hint = '',
    this.day = '',
    this.hasDiary = false,
    this.diaryId,
  });

  final bool locked;
  final String hint;
  final String day;
  final bool hasDiary;
  final String? diaryId;

  factory DiaryLockStatus.fromJson(Map<String, dynamic> j) => DiaryLockStatus(
        locked: asBool(j['locked'], true),
        hint: asString(j['hint']),
        day: asString(j['day']),
        hasDiary: asBool(j['hasDiary']),
        diaryId: asStringOrNull(j['diaryId']),
      );
}

class DiaryUnlockResult {
  const DiaryUnlockResult({required this.ok, this.diary});

  final bool ok;
  final Book? diary;

  factory DiaryUnlockResult.fromJson(Map<String, dynamic> j) {
    final dynamic d = j['diary'] ?? j['book'];
    return DiaryUnlockResult(
      ok: asBool(j['ok']),
      diary: d is Map ? Book.fromJson(asMap(d)) : null,
    );
  }
}

class BookSeries {
  const BookSeries({
    required this.id,
    this.title = '',
    this.type = '',
    this.count = 0,
    this.latest = '',
  });
  final String id;
  final String title;
  final String type;
  final int count;
  final String latest;

  factory BookSeries.fromJson(Map<String, dynamic> j) => BookSeries(
        id: asString(j['id']),
        title: asString(j['title'], asString(j['name'])),
        type: asString(j['type']),
        count: asInt(j['count'], asInt(j['chapters'])),
        latest: asString(j['latest'], asString(j['latestAt'])),
      );
}

class BookListResult {
  const BookListResult({this.books = const <Book>[], this.series = const <BookSeries>[]});
  final List<Book> books;
  final List<BookSeries> series;

  factory BookListResult.fromJson(Map<String, dynamic> j) => BookListResult(
        books: asMapList(j['items']).map(Book.fromJson).toList(),
        series: asMapList(j['series']).map(BookSeries.fromJson).toList(),
      );
}
