import '../core/api_client.dart';
import '../core/json_utils.dart';
import '../models/user.dart';

class AuthResult {
  const AuthResult({
    required this.token,
    required this.user,
    this.expiresAt = '',
    this.needsApiConfig = false,
  });

  final String token;
  final User user;
  final String expiresAt;
  final bool needsApiConfig;

  factory AuthResult.fromJson(Map<String, dynamic> j) => AuthResult(
        token: asString(j['token']),
        user: User.fromJson(asMap(j['user'])),
        expiresAt: asString(j['expiresAt']),
        needsApiConfig: asBool(j['needsApiConfig']),
      );
}

class SendCodeResult {
  const SendCodeResult({this.sent = false, this.devCode, this.warning});

  final bool sent;
  final String? devCode;
  final String? warning;
}

class AuthService {
  AuthService(this.api);

  final ApiClient api;

  /// 发送邮箱验证码；SMTP 未配置时后端会回显 devCode。
  Future<SendCodeResult> sendCode(String email, String purpose) async {
    final dynamic r = await api.post(
      '/auth/send-code',
      body: <String, dynamic>{'email': email, 'purpose': purpose},
    );
    final Map<String, dynamic> m = asMap(r);
    return SendCodeResult(
      sent: asBool(m['sent']),
      devCode: asStringOrNull(m['devCode']),
      warning: asStringOrNull(m['warning']),
    );
  }

  Future<AuthResult> register({
    required String username,
    required String email,
    required String password,
    required String confirmPassword,
    required String qq,
    required String code,
  }) async {
    final dynamic r = await api.post('/auth/register', body: <String, dynamic>{
      'username': username,
      'email': email,
      'password': password,
      'confirmPassword': confirmPassword,
      'qq': qq,
      'code': code,
    });
    return AuthResult.fromJson(asMap(r));
  }

  Future<AuthResult> login({
    required String identifier,
    required String mode,
    String password = '',
    String code = '',
  }) async {
    final dynamic r = await api.post('/auth/login', body: <String, dynamic>{
      'identifier': identifier,
      'mode': mode,
      if (mode == 'password') 'password': password,
      if (mode == 'code') 'code': code,
    });
    return AuthResult.fromJson(asMap(r));
  }

  Future<User> me() async {
    final dynamic r = await api.get('/auth/me');
    return User.fromJson(asMap(asMap(r)['user']));
  }

  Future<Map<String, dynamic>> profile() async {
    final dynamic r = await api.get('/users/me');
    return asMap(r);
  }

  Future<User> updateProfile({
    String? username,
    String? email,
    String? qq,
    String? oldPassword,
    String? newPassword,
  }) async {
    final dynamic r = await api.put('/users/me', body: <String, dynamic>{
      if (username != null) 'username': username,
      if (email != null) 'email': email,
      if (qq != null) 'qq': qq,
      if (oldPassword != null) 'oldPassword': oldPassword,
      if (newPassword != null) 'newPassword': newPassword,
    });
    return User.fromJson(asMap(asMap(r)['user']));
  }

  Future<void> logout() async {
    try {
      await api.post('/auth/logout', silent: true);
    } catch (_) {
      // 忽略网络错误：本地照常清理 token。
    }
  }

  Future<void> logoutAll() async {
    await api.post('/auth/logout-all');
  }
}
