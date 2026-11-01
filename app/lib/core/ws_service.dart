import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/status.dart' as ws_status;
import 'package:web_socket_channel/web_socket_channel.dart';

import 'api_client.dart';

enum WsStatus { idle, connecting, open, closed }

class WsEvent {
  const WsEvent(this.type, this.data);

  final String type;
  final Map<String, dynamic> data;
}

/// /ws?token= 实时通道：自动重连（指数退避，上限 15s）。
class WebSocketService {
  final StreamController<WsEvent> _events =
      StreamController<WsEvent>.broadcast();
  Stream<WsEvent> get events => _events.stream;

  final ValueNotifier<WsStatus> status = ValueNotifier<WsStatus>(WsStatus.idle);

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _sub;
  Timer? _retryTimer;
  String _baseUrl = '';
  String _token = '';
  bool _closed = true;
  int _attempt = 0;

  bool get connected => status.value == WsStatus.open;

  void connect({required String baseUrl, required String token}) {
    if (baseUrl.isEmpty || token.isEmpty) return;
    if (_baseUrl == baseUrl && _token == token && !_closed) return;
    _baseUrl = baseUrl;
    _token = token;
    _closed = false;
    _attempt = 0;
    _open();
  }

  Future<void> _open() async {
    if (_closed) return;
    _retryTimer?.cancel();
    await _sub?.cancel();
    _sub = null;
    try {
      await _channel?.sink.close(ws_status.normalClosure);
    } catch (_) {
      // ignore
    }
    _channel = null;
    status.value = WsStatus.connecting;

    final Uri uri = ApiClient(baseUrl: _baseUrl)
        .webSocketUri('/ws', <String, String>{'token': _token});
    try {
      final WebSocketChannel channel = WebSocketChannel.connect(uri);
      _channel = channel;
      _sub = channel.stream.listen(
        _onData,
        onError: (Object error, StackTrace stack) => _onClosed(),
        onDone: _onClosed,
        cancelOnError: true,
      );
      await channel.ready.timeout(const Duration(seconds: 12));
      if (_closed) {
        await channel.sink.close(ws_status.normalClosure);
        return;
      }
      status.value = WsStatus.open;
      _attempt = 0;
    } catch (_) {
      _onClosed();
    }
  }

  void _onData(dynamic raw) {
    if (raw is! String) return;
    dynamic decoded;
    try {
      decoded = jsonDecode(raw);
    } catch (_) {
      return;
    }
    if (decoded is! Map) return;
    final Map<String, dynamic> data =
        decoded.map((dynamic k, dynamic v) => MapEntry<String, dynamic>(
              k.toString(),
              v,
            ));
    final String type = (data['type'] ?? '').toString();
    if (type.isEmpty) return;
    if (!_events.isClosed) _events.add(WsEvent(type, data));
  }

  void _onClosed() {
    if (_closed) return;
    status.value = WsStatus.closed;
    _retryTimer?.cancel();
    final int delay = switch (_attempt) {
      0 => 1,
      1 => 2,
      2 => 4,
      3 => 8,
      _ => 15,
    };
    _attempt = (_attempt + 1).clamp(0, 6);
    _retryTimer = Timer(Duration(seconds: delay), () {
      _open();
    });
  }

  Future<void> close() async {
    _closed = true;
    _retryTimer?.cancel();
    _retryTimer = null;
    await _sub?.cancel();
    _sub = null;
    try {
      await _channel?.sink.close(ws_status.normalClosure);
    } catch (_) {
      // ignore
    }
    _channel = null;
    status.value = WsStatus.idle;
  }

  void dispose() {
    close();
    status.dispose();
    _events.close();
  }
}
