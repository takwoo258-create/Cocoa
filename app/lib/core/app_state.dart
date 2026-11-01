import 'package:flutter/widgets.dart';

import '../models/config_models.dart';
import '../models/user.dart';
import '../models/version_info.dart';
import '../services/admin_service.dart';
import '../services/auth_service.dart';
import '../services/book_service.dart';
import '../services/character_service.dart';
import '../services/chat_service.dart';
import '../services/config_service.dart';
import '../services/media_service.dart';
import '../services/memory_service.dart';
import '../services/social_service.dart';
import '../services/stats_service.dart';
import '../services/version_service.dart';
import 'api_client.dart';
import 'constants.dart';
import 'global.dart';
import 'json_utils.dart';
import 'storage_service.dart';
import 'ws_service.dart';

/// 全局会话与配置状态。ChangeNotifier + InheritedNotifier，不引入状态管理库。
class AppState extends ChangeNotifier {
  AppState() {
    _buildApi(kDefaultBaseUrl, null);
  }

  final StorageService storage = StorageService();
  final WebSocketService ws = WebSocketService();

  late ApiClient api;
  late AuthService authService;
  late ConfigService configService;
  late CharacterService characterService;
  late ChatService chatService;
  late MediaService mediaService;
  late MemoryService memoryService;
  late BookService bookService;
  late StatsService statsService;
  late AdminService adminService;
  late VersionService versionService;
  late SocialService socialService;

  User? user;
  AppConfig? config;
  String baseUrl = kDefaultBaseUrl;
  String? token;
  bool booting = true;
  bool chatReady = false;
  bool embeddingReady = false;
  bool debugMode = false;
  bool thinkingMode = false;
  Map<String, dynamic> preferences = <String, dynamic>{};
  String? activeCharacterId;

  /// v1.0.1：版本推送状态。
  VersionCheckResult? versionCheck;
  String? ignoredVersionTag;
  bool versionChecking = false;
  DateTime? _lastVersionCheckAt;

  /// 由根 Widget 注入：会话失效时回到登录页。
  void Function()? onNeedLogin;

  bool _resetting = false;

  bool get loggedIn => (token?.isNotEmpty ?? false) && user != null;
  bool get isAdmin => user?.isAdmin ?? false;
  bool get segmentEnabled => asBool(preferences['segmentEnabled'], true);
  bool get activeReplyEnabled => asBool(preferences['activeReply'], true);
  Map<String, String> get modelRouting => asStringMap(preferences['modelRouting']);
  int get hardTokens => asInt(asMap(preferences['limits'])['hardTokens']);
  int get softTokens => asInt(asMap(preferences['limits'])['softTokens']);
  bool get limitsEnabled => asBool(asMap(preferences['limits'])['enabled'], true);

  /// v1.1.0：强制更新优先，忽略版本不能绕过。
  bool get forceUpdateAvailable => versionCheck?.forceUpdate ?? false;

  bool get updateAvailable {
    final VersionCheckResult? r = versionCheck;
    if (r == null || !r.updateAvailable) return false;
    if (r.forceUpdate) return false;
    final String tag = r.latest.tag;
    return tag.isEmpty || tag != ignoredVersionTag;
  }

  void _buildApi(String url, String? tk) {
    api = ApiClient(
      baseUrl: url,
      token: tk,
      onUnauthorized: _onUnauthorized,
      onError: (String message) {
        if (!booting) showError(message);
      },
    );
    authService = AuthService(api);
    configService = ConfigService(api);
    characterService = CharacterService(api);
    chatService = ChatService(api);
    mediaService = MediaService(api);
    memoryService = MemoryService(api);
    bookService = BookService(api);
    statsService = StatsService(api);
    adminService = AdminService(api);
    versionService = VersionService(api);
    socialService = SocialService(api);
  }

  Future<void> boot() async {
    baseUrl = await storage.readBaseUrl();
    token = await storage.readToken();
    debugMode = await storage.readDebug();
    thinkingMode = await storage.readThinking();
    ignoredVersionTag = await storage.readIgnoredVersionTag();
    _buildApi(baseUrl, token);

    if (token != null && token!.isNotEmpty) {
      try {
        user = await authService.me();
        await refreshConfig(notify: false);
        activeCharacterId = await storage.readLastCharacter();
      } catch (_) {
        await storage.clearToken();
        token = null;
        user = null;
      }
    }
    booting = false;
    notifyListeners();
    // 公开接口，不阻塞启动；主页也会在加载时再触发一次（10 分钟节流）。
    checkVersion();
  }

  Future<void>? _versionCheckFuture;

  /// GET /api/version/latest?current=1.1.0。
  /// 并发调用共享同一个 Future，便于主页等待启动时的检查结果。
  Future<void> checkVersion({bool force = false}) {
    final Future<void>? inFlight = _versionCheckFuture;
    if (inFlight != null) return inFlight;
    final DateTime now = DateTime.now();
    if (!force &&
        _lastVersionCheckAt != null &&
        now.difference(_lastVersionCheckAt!) < const Duration(minutes: 10)) {
      return Future<void>.value();
    }
    final Future<void> future = _runVersionCheck();
    _versionCheckFuture = future;
    return future.whenComplete(() {
      _versionCheckFuture = null;
    });
  }

  Future<void> _runVersionCheck() async {
    versionChecking = true;
    notifyListeners();
    try {
      versionCheck = await versionService.check(current: kAppVersion);
      _lastVersionCheckAt = DateTime.now();
    } catch (_) {
      // 版本检查失败不打扰用户
    } finally {
      versionChecking = false;
      notifyListeners();
    }
  }

  Future<void> ignoreVersion(String tag) async {
    ignoredVersionTag = tag;
    await storage.writeIgnoredVersionTag(tag);
    notifyListeners();
  }

  void _applyConfig(AppConfig c) {
    config = c;
    preferences = c.preferences;
    chatReady = c.readyChat;
    embeddingReady = c.readyEmbedding;
    if (c.preferences.containsKey('debug')) {
      debugMode = c.debug;
      storage.writeDebug(debugMode);
    }
    if (c.preferences.containsKey('thinking')) {
      thinkingMode = c.thinking;
      storage.writeThinking(thinkingMode);
    }
  }

  Future<AppConfig?> refreshConfig({bool notify = true}) async {
    try {
      final AppConfig c = await configService.getConfig();
      _applyConfig(c);
      if (notify) notifyListeners();
      return c;
    } catch (_) {
      return null;
    }
  }

  void _onUnauthorized() {
    if (_resetting || token == null) return;
    _resetting = true;
    clearSession(navigate: true).whenComplete(() => _resetting = false);
  }

  Future<void> onLogin(AuthResult result) async {
    token = result.token;
    user = result.user;
    api.token = result.token;
    await storage.writeToken(result.token);
    await refreshConfig(notify: false);
    activeCharacterId = await storage.readLastCharacter();
    notifyListeners();
    connectWs();
  }

  Future<void> connectWs() async {
    if (token == null || token!.isEmpty) return;
    ws.connect(baseUrl: baseUrl, token: token!);
  }

  Future<void> setBaseUrl(String url) async {
    final String normalized = ApiClient.normalizeBase(url);
    if (normalized.isEmpty || normalized == baseUrl) return;
    baseUrl = normalized;
    await storage.writeBaseUrl(normalized);
    api.baseUrl = normalized;
    await ws.close();
    notifyListeners();
    if (loggedIn) {
      connectWs();
    }
  }

  Future<bool> verifySession() async {
    if (token == null) return false;
    try {
      user = await authService.me();
      await refreshConfig(notify: false);
      notifyListeners();
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<void> setDebugMode(bool value) async {
    debugMode = value;
    notifyListeners();
    await storage.writeDebug(value);
    await savePreferences(<String, dynamic>{'debug': value}, notify: false);
  }

  Future<void> setThinkingMode(bool value) async {
    thinkingMode = value;
    notifyListeners();
    await storage.writeThinking(value);
    await savePreferences(<String, dynamic>{'thinking': value}, notify: false);
  }

  Future<void> savePreferences(
    Map<String, dynamic> patch, {
    bool notify = true,
  }) async {
    preferences = <String, dynamic>{...preferences, ...patch};
    if (notify) notifyListeners();
    try {
      final Map<String, dynamic> saved =
          await configService.savePreferences(patch);
      preferences = <String, dynamic>{...preferences, ...saved};
      if (notify) notifyListeners();
    } catch (_) {
      // 本地已生效，失败下轮刷新修正。
    }
  }

  Future<void> setActiveCharacter(String? id) async {
    activeCharacterId = id;
    await storage.writeLastCharacter(id);
    notifyListeners();
  }

  Future<void> logout({bool navigate = true}) async {
    try {
      await authService.logout();
    } catch (_) {
      // ignore
    }
    await clearSession(navigate: navigate);
  }

  Future<void> clearSession({bool navigate = true}) async {
    await ws.close();
    await storage.clearToken();
    token = null;
    user = null;
    config = null;
    chatReady = false;
    embeddingReady = false;
    preferences = <String, dynamic>{};
    activeCharacterId = null;
    api.token = null;
    notifyListeners();
    if (navigate) onNeedLogin?.call();
  }

  @override
  void dispose() {
    ws.dispose();
    super.dispose();
  }
}

/// 便捷读取：AppScope.of(context) 依赖重建，AppScope.read(context) 不重建。
class AppScope extends InheritedNotifier<AppState> {
  const AppScope({
    super.key,
    required AppState state,
    required super.child,
  }) : super(notifier: state);

  static AppState of(BuildContext context) {
    final AppScope? scope =
        context.dependOnInheritedWidgetOfExactType<AppScope>();
    assert(scope != null, 'AppScope 未挂载');
    return scope!.notifier!;
  }

  static AppState read(BuildContext context) {
    final AppScope? scope =
        context.getInheritedWidgetOfExactType<AppScope>();
    assert(scope != null, 'AppScope 未挂载');
    return scope!.notifier!;
  }
}
