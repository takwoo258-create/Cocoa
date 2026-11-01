import 'package:flutter/services.dart';

const MethodChannel _nativeChannel = MethodChannel('cocoa/native');

/// 用系统浏览器打开链接（MainActivity 实现 openUrl，避免引入 url_launcher）。
Future<bool> openExternalUrl(String url) async {
  if (url.isEmpty) return false;
  try {
    final dynamic ok = await _nativeChannel.invokeMethod<dynamic>(
      'openUrl',
      <String, dynamic>{'url': url},
    );
    return ok != false;
  } on MissingPluginException {
    return false;
  } on PlatformException {
    return false;
  }
}
