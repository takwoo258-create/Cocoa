import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart';

typedef ErrorCallback = void Function(String message);

/// 后端统一错误：`{ "error": { "code", "message", "detail" } }`。
class ApiException implements Exception {
  ApiException(this.statusCode, this.code, this.message, [this.detail]);

  final int statusCode;
  final String code;
  final String message;
  final dynamic detail;

  @override
  String toString() => message;
}

/// 统一 HTTP 客户端：token 注入、错误 toast、401 自动登出。
class ApiClient {
  ApiClient({
    required this.baseUrl,
    this.token,
    this.onUnauthorized,
    this.onError,
  });

  String baseUrl;
  String? token;
  void Function()? onUnauthorized;
  ErrorCallback? onError;

  static String normalizeBase(String raw) {
    String v = raw.trim();
    if (v.isEmpty) return '';
    if (!v.startsWith('http://') && !v.startsWith('https://')) {
      v = 'http://$v';
    }
    while (v.endsWith('/')) {
      v = v.substring(0, v.length - 1);
    }
    if (v.endsWith('/api')) {
      v = v.substring(0, v.length - 4);
    }
    return v;
  }

  Uri buildUri(String path, [Map<String, dynamic>? query]) {
    final String base = normalizeBase(baseUrl);
    final Uri uri = Uri.parse('$base/api$path');
    if (query == null || query.isEmpty) return uri;
    final Map<String, String> q = <String, String>{};
    query.forEach((String k, dynamic v) {
      if (v == null) return;
      final String s = v.toString();
      if (s.isEmpty) return;
      q[k] = s;
    });
    if (q.isEmpty) return uri;
    return uri.replace(queryParameters: <String, String>{
      ...uri.queryParameters,
      ...q,
    });
  }

  Map<String, String> get authHeaders {
    final Map<String, String> h = <String, String>{
      'Accept': 'application/json',
    };
    if (token != null && token!.isNotEmpty) {
      h['Authorization'] = 'Bearer $token';
    }
    return h;
  }

  Map<String, String> get jsonHeaders => <String, String>{
        ...authHeaders,
        'Content-Type': 'application/json; charset=utf-8',
      };

  Future<dynamic> _run(
    Future<http.Response> Function() send, {
    bool silent = false,
    bool logoutOn401 = true,
  }) async {
    http.Response res;
    try {
      res = await send().timeout(const Duration(seconds: 45));
    } catch (e) {
      final String msg = '网络请求失败：$e';
      if (!silent) onError?.call(msg);
      throw ApiException(0, 'network_error', msg);
    }

    dynamic body;
    if (res.body.isNotEmpty) {
      try {
        body = jsonDecode(utf8.decode(res.bodyBytes));
      } catch (_) {
        body = res.body;
      }
    }

    if (res.statusCode >= 200 && res.statusCode < 300) {
      return body;
    }

    String code = 'http_${res.statusCode}';
    String message = '请求失败（${res.statusCode}）';
    dynamic detail;
    if (body is Map && body['error'] is Map) {
      final Map err = body['error'] as Map;
      code = (err['code'] ?? code).toString();
      message = (err['message'] ?? message).toString();
      detail = err['detail'];
    } else if (body is Map && body['message'] is String) {
      // v1.0.1：onebot/qzone 等接口用顶层 { ok, reason, message } 返回错误
      message = body['message'] as String;
      if (body['reason'] is String) code = body['reason'] as String;
    } else if (body is String && body.isNotEmpty) {
      message = body;
    }

    if (res.statusCode == 401 && logoutOn401) {
      onUnauthorized?.call();
    }
    if (!silent) onError?.call(message);
    throw ApiException(res.statusCode, code, message, detail);
  }

  Future<dynamic> get(
    String path, {
    Map<String, dynamic>? query,
    bool silent = false,
  }) {
    return _run(
      () => http.get(buildUri(path, query), headers: authHeaders),
      silent: silent,
    );
  }

  Future<dynamic> post(
    String path, {
    Object? body,
    Map<String, dynamic>? query,
    bool silent = false,
    bool logoutOn401 = true,
  }) {
    return _run(
      () => http.post(
        buildUri(path, query),
        headers: jsonHeaders,
        body: body == null ? '{}' : jsonEncode(body),
      ),
      silent: silent,
      logoutOn401: logoutOn401,
    );
  }

  Future<dynamic> put(
    String path, {
    Object? body,
    Map<String, dynamic>? query,
    bool silent = false,
  }) {
    return _run(
      () => http.put(
        buildUri(path, query),
        headers: jsonHeaders,
        body: body == null ? '{}' : jsonEncode(body),
      ),
      silent: silent,
    );
  }

  Future<dynamic> delete(
    String path, {
    Map<String, dynamic>? query,
    bool silent = false,
  }) {
    return _run(
      () => http.delete(buildUri(path, query), headers: authHeaders),
      silent: silent,
    );
  }

  /// multipart 上传（媒体）。字段：file、kind、characterId。
  Future<dynamic> upload(
    String path, {
    required String filePath,
    required String field,
    Map<String, String> fields = const <String, String>{},
    bool silent = false,
    String? contentType,
  }) {
    return _run(() async {
      final http.MultipartRequest req =
          http.MultipartRequest('POST', buildUri(path));
      req.headers.addAll(authHeaders);
      req.fields.addAll(fields);
      req.files.add(await http.MultipartFile.fromPath(
        field,
        filePath,
        contentType: contentType == null ? null : MediaType.parse(contentType),
      ));
      final http.StreamedResponse streamed = await req.send();
      return http.Response.fromStream(streamed);
    }, silent: silent);
  }

  Future<dynamic> uploadBytes(
    String path, {
    required List<int> bytes,
    required String filename,
    required String field,
    Map<String, String> fields = const <String, String>{},
    bool silent = false,
    String? contentType,
  }) {
    return _run(() async {
      final http.MultipartRequest req =
          http.MultipartRequest('POST', buildUri(path));
      req.headers.addAll(authHeaders);
      req.fields.addAll(fields);
      req.files.add(http.MultipartFile.fromBytes(
        field,
        bytes,
        filename: filename,
        contentType: contentType == null ? null : MediaType.parse(contentType),
      ));
      final http.StreamedResponse streamed = await req.send();
      return http.Response.fromStream(streamed);
    }, silent: silent);
  }

  /// 带鉴权的文件 URL（用于图片/音频播放）；audio 播放器另用 header 请求。
  Uri mediaUri(String mediaId) => buildUri('/media/$mediaId');

  Map<String, String> get mediaHeaders => authHeaders;

  /// ws(s) 地址推导。
  Uri webSocketUri(String path, [Map<String, String>? query]) {
    final String base = normalizeBase(baseUrl);
    final Uri httpUri = Uri.parse(base);
    final Uri wsBase = httpUri.replace(
      scheme: httpUri.scheme == 'https' ? 'wss' : 'ws',
      path: '',
    );
    final Uri uri = wsBase.resolve(path);
    if (query == null || query.isEmpty) return uri;
    return uri.replace(queryParameters: <String, String>{
      ...uri.queryParameters,
      ...query,
    });
  }
}
