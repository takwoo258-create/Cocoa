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

/// v1.3.0：应用内下载 APK（Android DownloadManager），失败由调用方回退浏览器。
Future<bool> downloadApk(String url, String filename) async {
  if (url.isEmpty) return false;
  try {
    final dynamic ok = await _nativeChannel.invokeMethod<dynamic>(
      'downloadApk',
      <String, dynamic>{'url': url, 'filename': filename},
    );
    return ok == true;
  } on MissingPluginException {
    return false;
  } on PlatformException {
    return false;
  }
}

/// v1.5.0：选择本地 ttf/otf 字体，返回应用私有目录路径。
Future<String?> pickFontFile() async {
  try {
    return await _nativeChannel.invokeMethod<String>('pickFont');
  } on MissingPluginException {
    return null;
  } on PlatformException {
    return null;
  }
}
