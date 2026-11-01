import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'constants.dart';

/// token 存 secure storage；服务地址与偏好存 shared_preferences。
class StorageService {
  static const FlutterSecureStorage _secure = FlutterSecureStorage();
  static const String _kToken = 'cocoa.token';
  static const String _kBaseUrl = 'cocoa.baseUrl';
  static const String _kDebug = 'cocoa.debug';
  static const String _kThinking = 'cocoa.thinking';
  static const String _kLastCharacter = 'cocoa.lastCharacterId';
  static const String _kLastTab = 'cocoa.lastTab';

  Future<SharedPreferences> get _prefs => SharedPreferences.getInstance();

  Future<String?> readToken() async {
    try {
      final String? t = await _secure.read(key: _kToken);
      if (t != null && t.isNotEmpty) return t;
    } catch (_) {
      // secure storage 在部分设备上可能不可用，降级到 prefs。
    }
    try {
      final SharedPreferences p = await _prefs;
      return p.getString(_kToken);
    } catch (_) {
      return null;
    }
  }

  Future<void> writeToken(String token) async {
    try {
      await _secure.write(key: _kToken, value: token);
    } catch (_) {
      // ignore
    }
    final SharedPreferences p = await _prefs;
    await p.setString(_kToken, token);
  }

  Future<void> clearToken() async {
    try {
      await _secure.delete(key: _kToken);
    } catch (_) {
      // ignore
    }
    final SharedPreferences p = await _prefs;
    await p.remove(_kToken);
  }

  Future<String> readBaseUrl() async {
    final SharedPreferences p = await _prefs;
    final String? v = p.getString(_kBaseUrl);
    if (v == null || v.trim().isEmpty) return kDefaultBaseUrl;
    return v;
  }

  Future<void> writeBaseUrl(String url) async {
    final SharedPreferences p = await _prefs;
    await p.setString(_kBaseUrl, url.trim());
  }

  Future<bool> readDebug() async {
    final SharedPreferences p = await _prefs;
    return p.getBool(_kDebug) ?? false;
  }

  Future<bool> readThinking() async {
    final SharedPreferences p = await _prefs;
    return p.getBool(_kThinking) ?? false;
  }

  Future<void> writeDebug(bool v) async {
    final SharedPreferences p = await _prefs;
    await p.setBool(_kDebug, v);
  }

  Future<void> writeThinking(bool v) async {
    final SharedPreferences p = await _prefs;
    await p.setBool(_kThinking, v);
  }

  Future<String?> readLastCharacter() async {
    final SharedPreferences p = await _prefs;
    return p.getString(_kLastCharacter);
  }

  Future<void> writeLastCharacter(String? id) async {
    final SharedPreferences p = await _prefs;
    if (id == null) {
      await p.remove(_kLastCharacter);
    } else {
      await p.setString(_kLastCharacter, id);
    }
  }

  Future<int> readLastTab() async {
    final SharedPreferences p = await _prefs;
    return p.getInt(_kLastTab) ?? 0;
  }

  Future<void> writeLastTab(int index) async {
    final SharedPreferences p = await _prefs;
    await p.setInt(_kLastTab, index);
  }
}
