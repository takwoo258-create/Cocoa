import '../core/json_utils.dart';

/// v1.5.0：单个服务的命名模型配置（api.profiles.<service>[]）。
class ModelProfile {
  const ModelProfile({
    this.id = '',
    this.name = '',
    this.baseUrl = '',
    this.apiKey = '',
    this.apiKeySet = false,
    this.apiKeyMasked = '',
    this.model = '',
    this.voice = '',
    this.contextWindow = 0,
    this.ready = false,
    this.extra = const <String, dynamic>{},
  });

  final String id;
  final String name;
  final String baseUrl;
  final String apiKey;
  final bool apiKeySet;
  final String apiKeyMasked;
  final String model;
  final String voice;
  final int contextWindow;
  final bool ready;
  final Map<String, dynamic> extra;

  factory ModelProfile.fromJson(Map<String, dynamic> j) => ModelProfile(
        id: asString(j['id']),
        name: asString(j['name']),
        baseUrl: asString(j['baseUrl']),
        apiKey: asString(j['apiKey']),
        apiKeySet: asBool(j['apiKeySet'], asString(j['apiKeyMasked']).isNotEmpty),
        apiKeyMasked: asString(j['apiKeyMasked'], asString(j['apiKey'])),
        model: asString(j['model']),
        voice: asString(j['voice']),
        contextWindow: asInt(j['contextWindow']),
        ready: asBool(j['ready']),
        extra: asMap(j['extra']),
      );

  /// PUT 保存格式；apiKey 为 **** 表示保持、空表示清空、其它覆盖。
  Map<String, dynamic> toPutJson() => <String, dynamic>{
        'id': id,
        'name': name,
        'baseUrl': baseUrl,
        'apiKey': apiKey,
        'model': model,
        'voice': voice,
        'contextWindow': contextWindow,
      };

  ModelProfile copyWith({
    String? id,
    String? name,
    String? baseUrl,
    String? apiKey,
    bool? apiKeySet,
    String? apiKeyMasked,
    String? model,
    String? voice,
    int? contextWindow,
    bool? ready,
    Map<String, dynamic>? extra,
  }) =>
      ModelProfile(
        id: id ?? this.id,
        name: name ?? this.name,
        baseUrl: baseUrl ?? this.baseUrl,
        apiKey: apiKey ?? this.apiKey,
        apiKeySet: apiKeySet ?? this.apiKeySet,
        apiKeyMasked: apiKeyMasked ?? this.apiKeyMasked,
        model: model ?? this.model,
        voice: voice ?? this.voice,
        contextWindow: contextWindow ?? this.contextWindow,
        ready: ready ?? this.ready,
        extra: extra ?? this.extra,
      );
}

/// 服务分组顺序（与后端 defaults.services 对齐）。
const List<String> kModelServiceGroups = <String>[
  'chat',
  'vision',
  'tts',
  'stt',
  'embedding',
  'search',
];

const Map<String, String> kModelServiceLabels = <String, String>{
  'chat': '对话模型',
  'vision': '视觉模型',
  'tts': '语音合成',
  'stt': '语音识别',
  'embedding': '记忆嵌入',
  'search': '网页搜索',
};

String modelServiceLabel(String service, Map<String, dynamic> defaults) {
  final Map<String, dynamic> labels = asMap(defaults['labels']);
  return asString(labels[service], kModelServiceLabels[service] ?? service);
}
