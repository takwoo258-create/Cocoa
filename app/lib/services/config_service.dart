import '../core/api_client.dart';
import '../core/json_utils.dart';
import '../models/config_models.dart';

class ConfigService {
  ConfigService(this.api);

  final ApiClient api;

  Future<AppConfig> getConfig() async {
    return AppConfig.fromJson(asMap(await api.get('/config')));
  }

  /// 保存服务配置：apiKey 传 "****" 保持不变，传 "" 清除。
  Future<AppConfig> saveApi(Map<String, dynamic> services) async {
    await api.put('/config/api', body: services);
    return getConfig();
  }

  Future<ModelListResult> listModels(String service) async {
    final dynamic r = await api.post(
      '/config/models',
      body: <String, dynamic>{'service': service},
    );
    return ModelListResult.fromJson(asMap(r));
  }

  Future<TestConnectionResult> testConnection(String service) async {
    try {
      final dynamic r = await api.post(
        '/config/test',
        body: <String, dynamic>{'service': service},
        silent: true,
      );
      return TestConnectionResult.fromJson(asMap(r));
    } on ApiException catch (e) {
      // 后端测试失败返回 502 + {ok:false,...}
      if (e.detail is Map) {
        return TestConnectionResult.fromJson(asMap(e.detail));
      }
      return TestConnectionResult(ok: false, detail: e.message);
    }
  }

  Future<Map<String, dynamic>> getPreferences() async {
    final dynamic r = await api.get('/config/preferences');
    return asMap(asMap(r)['preferences']);
  }

  /// 后端对 preferences 做深合并，请求体即扁平的偏置对象。
  Future<Map<String, dynamic>> savePreferences(
    Map<String, dynamic> patch,
  ) async {
    final dynamic r = await api.put('/config/preferences', body: patch);
    final Map<String, dynamic> m = asMap(r);
    if (m['preferences'] is Map) return asMap(m['preferences']);
    return patch;
  }

  Future<ModelInfo?> modelInfo({String id = '', String task = ''}) async {
    final dynamic r = await api.get(
      '/config/model-info',
      query: <String, dynamic>{'id': id, 'task': task},
      silent: true,
    );
    final Map<String, dynamic> m = asMap(r);
    final dynamic model = m['model'];
    if (model is Map) {
      return ModelInfo.fromJson(asMap(model));
    }
    return null;
  }

  Future<Map<String, dynamic>> health() async {
    return asMap(await api.get('/health', silent: true));
  }
}
