import '../core/json_utils.dart';

class User {
  const User({
    required this.id,
    required this.username,
    required this.email,
    required this.qq,
    required this.role,
    required this.emailVerified,
    required this.status,
    this.code = 0,
    this.nickname = '',
    this.createdAt,
    this.lastLoginAt,
    this.lastActiveAt,
  });

  final String id;
  final String username;
  final String email;
  final String qq;
  final String role;
  final bool emailVerified;
  final String status;

  /// v1.2.0：注册顺序代号 1..N（只读）。
  final int code;

  /// 展示用昵称（后端 nickname=username）。
  final String nickname;
  final String? createdAt;
  final String? lastLoginAt;
  final String? lastActiveAt;

  bool get isAdmin => role == 'admin';

  String get displayName => nickname.isNotEmpty ? nickname : username;

  String get codeLabel => code > 0 ? '#$code' : '';

  factory User.fromJson(Map<String, dynamic> j) => User(
        id: asString(j['id']),
        username: asString(j['username']),
        email: asString(j['email']),
        qq: asString(j['qq']),
        role: asString(j['role'], 'user'),
        emailVerified: asBool(j['emailVerified']),
        status: asString(j['status'], 'active'),
        code: asInt(j['code']),
        nickname: asString(j['nickname'], asString(j['username'])),
        createdAt: asStringOrNull(j['createdAt']),
        lastLoginAt: asStringOrNull(j['lastLoginAt']),
        lastActiveAt: asStringOrNull(j['lastActiveAt']),
      );

  static const User anonymous = User(
    id: '',
    username: '',
    email: '',
    qq: '',
    role: 'user',
    emailVerified: false,
    status: 'active',
  );

  Map<String, dynamic> toJson() => <String, dynamic>{
        'id': id,
        'username': username,
        'email': email,
        'qq': qq,
        'role': role,
        'emailVerified': emailVerified,
        'status': status,
        'code': code,
        'nickname': nickname,
        'createdAt': createdAt,
        'lastLoginAt': lastLoginAt,
        'lastActiveAt': lastActiveAt,
      };
}
