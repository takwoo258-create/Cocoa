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
}
