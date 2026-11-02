import '../core/json_utils.dart';
import '../core/utils.dart';

/// GET /api/version/latest 的版本信息。
class LatestVersion {
  const LatestVersion({
    this.version = '',
    this.tag = '',
    this.name = '',
    this.notes = '',
    this.publishedAt = '',
    this.url = '',
    this.apkName = '',
    this.apkSize = 0,
    this.apkUrl = '',
    this.apkDirectUrl = '',
    this.label = '',
    this.baseVersion = '',
    this.beta = false,
    this.betaNumber = 0,
    this.force = false,
    this.forceReason = '',
  });

  final String version;
  final String tag;
  final String name;
  final String notes;
  final String publishedAt;
  final String url;
  final String apkName;
  final int apkSize;
  final String apkUrl;
  final String apkDirectUrl;

  /// v1.3.0：展示标签（Beta 等）与需要更新标记。
  final String label;
  final String baseVersion;
  final bool beta;
  final int betaNumber;
  final bool force;
  final String forceReason;

  static const LatestVersion empty = LatestVersion();

  String get displayLabel {
    if (label.isNotEmpty) return label;
    return parseVersionLabel(version);
  }

  bool get latestBadge => !beta;

  factory LatestVersion.fromJson(Map<String, dynamic> j) {
    final Map<String, dynamic> apk = asMap(j['apk']);
    return LatestVersion(
      version: asString(j['version']),
      tag: asString(j['tag'], asString(j['version'])),
      name: asString(j['name']),
      notes: asString(j['notes']),
      publishedAt: asString(j['publishedAt']),
      url: asString(j['url']),
      apkName: asString(apk['name']),
      apkSize: asInt(apk['size']),
      apkUrl: asString(apk['url']),
      apkDirectUrl: asString(apk['directUrl']),
      label: asString(j['label']),
      baseVersion: asString(j['baseVersion']),
      beta: asBool(j['beta']),
      betaNumber: asInt(j['betaNumber']),
      force: asBool(j['force']),
      forceReason: asString(j['forceReason']),
    );
  }

  String get downloadUrl {
    if (apkUrl.isNotEmpty) return apkUrl;
    if (apkDirectUrl.isNotEmpty) return apkDirectUrl;
    return url;
  }

  /// v1.2.0：+ / - / ± 转为 新增 / 删除 / 修改。
  String get formattedNotes => formatUpdateNotes(notes);

  String get notesSummary {
    final String flat = formattedNotes.replaceAll(RegExp(r'\s+'), ' ').trim();
    if (flat.length <= 120) return flat;
    return '${flat.substring(0, 120)}…';
  }
}

/// 版本检查聚合结果。
class VersionCheckResult {
  const VersionCheckResult({
    this.ok = false,
    this.current = '',
    this.source = '',
    this.latest = LatestVersion.empty,
    this.updateAvailable = false,
    this.forceUpdate = false,
    this.forceReason = '',
    this.minVersion = '',
    this.proxy = '',
    this.checkedAt = '',
    this.releases = const <LatestVersion>[],
    this.requiredVersion = '',
  });

  final bool ok;
  final String current;
  final String source;
  final LatestVersion latest;
  final bool updateAvailable;

  /// v1.1.0：需要更新（忽略版本不能绕过）。
  final bool forceUpdate;
  final String forceReason;
  final String minVersion;
  final String proxy;
  final String checkedAt;

  /// v1.3.0：多版本更新列表（后端顺序，高版本在前）。
  final List<LatestVersion> releases;
  final String requiredVersion;

  static const VersionCheckResult empty = VersionCheckResult();

  factory VersionCheckResult.fromJson(Map<String, dynamic> j) => VersionCheckResult(
        ok: asBool(j['ok']),
        current: asString(j['current']),
        source: asString(j['source']),
        latest: LatestVersion.fromJson(asMap(j['latest'])),
        updateAvailable: asBool(j['updateAvailable']),
        forceUpdate: asBool(j['forceUpdate']),
        forceReason: asString(j['forceReason']),
        minVersion: asString(j['minVersion']),
        proxy: asString(j['proxy']),
        checkedAt: asString(j['checkedAt']),
        releases: asMapList(j['releases'])
            .map(LatestVersion.fromJson)
            .toList(),
        requiredVersion: asString(j['requiredVersion']),
      );
}


/// v1.3.0：解析 1.3.1+++Beta 1 / 1.3.1-beta.1，展示为 1.3.1 Beta 1。
String parseVersionLabel(String version) {
  final String v = version.trim();
  if (v.isEmpty) return v;
  final RegExpMatch? plus = RegExp(
    r'^(.*?)\+\+\+Beta\s*(\d+)$',
    caseSensitive: false,
  ).firstMatch(v);
  final RegExpMatch? dot = RegExp(
    r'^(.*?)[-_.]beta[.\s-]*(\d+)$',
    caseSensitive: false,
  ).firstMatch(v);
  final RegExpMatch? hit = plus ?? dot;
  if (hit == null) return v;
  return '${hit.group(1)!.trim()} Beta ${hit.group(2)}';
}
