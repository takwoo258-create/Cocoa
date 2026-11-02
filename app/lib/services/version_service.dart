import '../core/api_client.dart';
import '../core/json_utils.dart';
import '../models/version_info.dart';

/// 版本检查（公开接口，无需登录）。
class VersionService {
  VersionService(this.api);

  final ApiClient api;

  Future<VersionCheckResult> check({required String current}) async {
    final dynamic r = await api.get(
      '/version/latest',
      query: <String, dynamic>{'current': current},
      silent: true,
    );
    return VersionCheckResult.fromJson(asMap(r));
  }

  /// v1.3.0：多版本更新列表；失败时回退旧接口。
  Future<VersionCheckResult> checkUpdates({required String current}) async {
    try {
      final dynamic r = await api.get(
        '/version/updates',
        query: <String, dynamic>{'current': current},
        silent: true,
      );
      return VersionCheckResult.fromJson(asMap(r));
    } catch (_) {
      return check(current: current);
    }
  }
}
