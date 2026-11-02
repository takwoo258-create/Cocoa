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

  /// v1.3.0：保存多提供源 / 统一模型来源。
  Future<AppConfig> saveModelConfig({
    String? modelSource,
    String? systemProviderId,
    List<Map<String, dynamic>>? providers,
    Map<String, String>? activeProviderId,
  }) async {
    await api.put('/config/api', body: <String, dynamic>{
      if (modelSource != null) 'modelSource': modelSource,
      if (systemProviderId != null) 'systemProviderId': systemProviderId,
      if (providers != null) 'providers': providers,
      if (activeProviderId != null) 'activeProviderId': activeProviderId,
    });
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
    // v1.0.1：兼容扁平响应 { id?, contextWindow, contextWindowSource, override }
    if (m.containsKey('contextWindow') ||
        m.containsKey('contextWindowSource') ||
        m.containsKey('override')) {
      return ModelInfo.fromJson(m);
    }
    return null;
  }

  /// v1.2.0：TTS 测试（返回音频 URL）。
  Future<Map<String, dynamic>> testTts(String text) async {
    return asMap(await api.post(
      '/config/test-tts',
      body: <String, dynamic>{'text': text},
      silent: true,
    ));
  }

  /// v1.2.0：STT 测试（multipart file）。
  Future<Map<String, dynamic>> testStt(String filePath) async {
    return asMap(await api.upload(
      '/config/test-stt',
      filePath: filePath,
      field: 'file',
      silent: true,
    ));
  }

  Future<Map<String, dynamic>> health() async {
    return asMap(await api.get('/health', silent: true));
  }
}
