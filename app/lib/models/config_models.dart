import '../core/constants.dart';
import '../core/json_utils.dart';

/// 单个模型服务的配置。apiKey 只回显 apiKeySet / apiKeyMasked。
class ServiceConfig {
  const ServiceConfig({
    this.baseUrl = '',
    this.apiKey = '',
    this.model = '',
    this.voice = '',
    this.extra = const <String, dynamic>{},
    this.apiKeySet = false,
    this.apiKeyMasked = '',
  });

  final String baseUrl;
  final String apiKey;
  final String model;
  final String voice;
  final Map<String, dynamic> extra;
  final bool apiKeySet;
  final String apiKeyMasked;

  static const ServiceConfig empty = ServiceConfig();

  bool get configured =>
      baseUrl.trim().isNotEmpty && (apiKeySet || apiKey.trim().isNotEmpty);

  factory ServiceConfig.fromJson(Map<String, dynamic> j) => ServiceConfig(
        baseUrl: asString(j['baseUrl']),
        apiKey: asString(j['apiKey']),
        model: asString(j['model']),
        voice: asString(j['voice']),
        extra: asMap(j['extra']),
        apiKeySet: asBool(j['apiKeySet'], asString(j['apiKey']).isNotEmpty),
        apiKeyMasked: asString(j['apiKeyMasked']),
      );

  Map<String, dynamic> toJson() => <String, dynamic>{
        'baseUrl': baseUrl,
        'apiKey': apiKey,
        'model': model,
        if (voice.isNotEmpty) 'voice': voice,
        if (extra.isNotEmpty) 'extra': extra,
      };

  ServiceConfig copyWith({
    String? baseUrl,
    String? apiKey,
    String? model,
    String? voice,
    Map<String, dynamic>? extra,
    bool? apiKeySet,
    String? apiKeyMasked,
  }) =>
      ServiceConfig(
        baseUrl: baseUrl ?? this.baseUrl,
        apiKey: apiKey ?? this.apiKey,
        model: model ?? this.model,
        voice: voice ?? this.voice,
        extra: extra ?? this.extra,
        apiKeySet: apiKeySet ?? this.apiKeySet,
        apiKeyMasked: apiKeyMasked ?? this.apiKeyMasked,
      );
}

/// /api/config 聚合结果。
class AppConfig {
  const AppConfig({
    this.services = const <String, ServiceConfig>{},
    this.preferences = const <String, dynamic>{},
    this.readyChat = false,
    this.readyEmbedding = false,
    this.readyStt = false,
    this.readyTts = false,
    this.readySearch = false,
    this.shared = const <String, dynamic>{},
    this.raw = const <String, dynamic>{},
  });

  final Map<String, ServiceConfig> services;
  final Map<String, dynamic> preferences;
  final bool readyChat;
  final bool readyEmbedding;
  final bool readyStt;
  final bool readyTts;
  final bool readySearch;

  /// v1.2.0：他人分享的可用服务 {chat:{shareId,ownerCode,...,expiresAt,model}}。
  final Map<String, dynamic> shared;
  final Map<String, dynamic> raw;

  ServiceConfig service(String name) => services[name] ?? ServiceConfig.empty;

  bool get debug => asBool(preferences['debug']);
  bool get thinking => asBool(preferences['thinking']);
  bool get activeReply => asBool(preferences['activeReply'], true);
  bool get segmentEnabled => asBool(preferences['segmentEnabled'], true);
  Map<String, String> get modelRouting => asStringMap(preferences['modelRouting']);
  int get hardTokens => asInt(asMap(preferences['limits'])['hardTokens']);
  int get softTokens => asInt(asMap(preferences['limits'])['softTokens']);
  bool get limitsEnabled => asBool(asMap(preferences['limits'])['enabled'], true);

  /// 手动上下文长度覆盖（模型键或 default）。
  Map<String, dynamic> get contextLimits => asMap(preferences['contextLimits']);

  int? contextLimitFor(String model) {
    final Map<String, dynamic> limits = contextLimits;
    if (limits[model] != null) return asInt(limits[model]);
    if (limits['default'] != null) return asInt(limits['default']);
    return null;
  }

  factory AppConfig.fromJson(Map<String, dynamic> j) {
    final Map<String, dynamic> api = asMap(j['api']);
    final Map<String, ServiceConfig> services = <String, ServiceConfig>{};
    api.forEach((String k, dynamic v) {
      if (v is Map) {
        services[k] = ServiceConfig.fromJson(asMap(v));
      }
    });
    final Map<String, dynamic> ready = asMap(j['ready']);
    return AppConfig(
      services: services,
      preferences: asMap(j['preferences']),
      readyChat: asBool(ready['chat']),
      readyEmbedding: asBool(ready['embedding']),
      readyStt: asBool(ready['stt']),
      readyTts: asBool(ready['tts']),
      readySearch: asBool(ready['search']),
      shared: asMap(j['shared']),
      raw: j,
    );
  }
}

/// 模型能力条目。
class ModelInfo {
  const ModelInfo({
    required this.id,
    this.modalities = const <String>[],
    this.capabilities = const <String, dynamic>{},
    this.contextWindow = 0,
    this.contextWindowSource = '',
    this.contextOverride,
    this.svg = const <String, String>{},
  });

  final String id;
  final List<String> modalities;
  final Map<String, dynamic> capabilities;
  final int contextWindow;

  /// remote / table / default（v1.0.1）。
  final String contextWindowSource;

  /// GET /api/config/model-info 返回的手动覆盖值。
  final int? contextOverride;
  final Map<String, String> svg;

  factory ModelInfo.fromJson(Map<String, dynamic> j) => ModelInfo(
        id: asString(j['id']),
        modalities: asStringList(j['modalities']),
        capabilities: asMap(j['capabilities']),
        contextWindow: asInt(j['contextWindow']),
        contextWindowSource: asString(j['contextWindowSource']),
        contextOverride: j['override'] == null ? null : asInt(j['override']),
        svg: asStringMap(j['svg']),
      );

  String get contextSourceLabel => contextWindowSource.isEmpty
      ? ''
      : (kContextSourceLabels[contextWindowSource] ?? contextWindowSource);

  bool get supportsText {
    if (capabilities.containsKey('text')) {
      return asBool(capabilities['text'], true);
    }
    if (modalities.isEmpty) return true;
    return modalities.any((String m) {
      final String s = m.toLowerCase();
      return s == 'text' || s == 'input_text';
    });
  }

  bool get supportsImage {
    if (capabilities.containsKey('image')) {
      return asBool(capabilities['image']);
    }
    return modalities.any((String m) => m.toLowerCase().contains('image'));
  }

  bool get supportsAudio {
    if (capabilities.containsKey('audio')) {
      return asBool(capabilities['audio']) ||
          asBool(capabilities['audioIn']) ||
          asBool(capabilities['audioOut']);
    }
    return modalities.any((String m) {
      final String s = m.toLowerCase();
      return s.contains('audio') || s.contains('speech') || s.contains('voice');
    });
  }

  bool get isReasoning => asBool(capabilities['reasoning']);
  bool get isEmbedding => asBool(capabilities['embedding']);

  String get contextLabel {
    if (contextWindow <= 0) return '上下文未知';
    if (contextWindow >= 1000000) {
      return '${(contextWindow / 1000000).toStringAsFixed(1)}M 上下文';
    }
    if (contextWindow >= 1000) {
      return '${(contextWindow / 1000).round()}K 上下文';
    }
    return '$contextWindow 上下文';
  }
}

class ModelListResult {
  const ModelListResult({
    this.models = const <ModelInfo>[],
    this.source = '',
    this.warning = '',
    this.attempts = const <Map<String, dynamic>>[],
  });

  final List<ModelInfo> models;
  final String source;
  final String warning;
  final List<Map<String, dynamic>> attempts;

  bool get isFallback => warning.isNotEmpty || source == 'fallback';

  factory ModelListResult.fromJson(Map<String, dynamic> j) => ModelListResult(
        models: asMapList(j['models'])
            .map((Map<String, dynamic> m) => ModelInfo.fromJson(m))
            .where((ModelInfo m) => m.id.isNotEmpty)
            .toList(),
        source: asString(j['source']),
        warning: asString(j['warning']),
        attempts: asMapList(j['attempts']),
      );
}

class TestConnectionResult {
  const TestConnectionResult({
    required this.ok,
    this.latencyMs = 0,
    this.detail,
  });

  final bool ok;
  final int latencyMs;
  final dynamic detail;

  factory TestConnectionResult.fromJson(Map<String, dynamic> j) =>
      TestConnectionResult(
        ok: asBool(j['ok']),
        latencyMs: asInt(j['latencyMs']),
        detail: j['detail'],
      );

  String get detailText {
    if (detail == null) return '';
    if (detail is String) return detail as String;
    return detail.toString();
  }
}

/// 模型能力汇总（用于 SVG 图标行）。
class ModelCapabilities {
  const ModelCapabilities({
    required this.text,
    required this.image,
    required this.audio,
  });

  final bool text;
  final bool image;
  final bool audio;

  factory ModelCapabilities.of(ModelInfo? m) {
    if (m == null) {
      return const ModelCapabilities(text: true, image: false, audio: false);
    }
    return ModelCapabilities(
      text: m.supportsText,
      image: m.supportsImage,
      audio: m.supportsAudio,
    );
  }
}
