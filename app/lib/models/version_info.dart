import '../core/json_utils.dart';

/// GET /api/version/latest 的最新版本信息。
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

  static const LatestVersion empty = LatestVersion();

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
    );
  }

  String get downloadUrl {
    if (apkUrl.isNotEmpty) return apkUrl;
    if (apkDirectUrl.isNotEmpty) return apkDirectUrl;
    return url;
  }

  String get notesSummary {
    final String flat = notes.replaceAll(RegExp(r'\s+'), ' ').trim();
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
  });

  final bool ok;
  final String current;
  final String source;
  final LatestVersion latest;
  final bool updateAvailable;

  /// v1.1.0：强制更新（忽略版本不能绕过）。
  final bool forceUpdate;
  final String forceReason;
  final String minVersion;
  final String proxy;
  final String checkedAt;

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
      );
}
