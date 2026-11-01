/// JSON 取值工具：后端字段可能缺失或类型漂移，全部容错。
library cocoa.core.json_utils;

String asString(dynamic v, [String def = '']) {
  if (v == null) return def;
  if (v is String) return v;
  return v.toString();
}

String? asStringOrNull(dynamic v) {
  if (v == null) return null;
  final String s = v.toString();
  return s.isEmpty ? null : s;
}

int asInt(dynamic v, [int def = 0]) {
  if (v == null) return def;
  if (v is int) return v;
  if (v is num) return v.toInt();
  if (v is bool) return v ? 1 : 0;
  return int.tryParse(v.toString()) ?? def;
}

double asDouble(dynamic v, [double def = 0]) {
  if (v == null) return def;
  if (v is double) return v;
  if (v is num) return v.toDouble();
  return double.tryParse(v.toString()) ?? def;
}

bool asBool(dynamic v, [bool def = false]) {
  if (v == null) return def;
  if (v is bool) return v;
  if (v is num) return v != 0;
  final String s = v.toString().toLowerCase();
  if (s == 'true' || s == '1' || s == 'yes') return true;
  if (s == 'false' || s == '0' || s == 'no') return false;
  return def;
}

Map<String, dynamic> asMap(dynamic v) {
  if (v is Map) {
    return v.map((dynamic k, dynamic val) => MapEntry<String, dynamic>(
          k.toString(),
          val,
        ));
  }
  return <String, dynamic>{};
}

List<dynamic> asList(dynamic v) {
  if (v is List) return v;
  if (v == null) return <dynamic>[];
  return <dynamic>[v];
}

List<Map<String, dynamic>> asMapList(dynamic v) {
  return asList(v).whereType<Map<dynamic, dynamic>>().map(asMap).toList();
}

List<String> asStringList(dynamic v) {
  return asList(v)
      .where((dynamic e) => e != null)
      .map((dynamic e) => e.toString())
      .toList();
}

Map<String, String> asStringMap(dynamic v) {
  final Map<String, dynamic> m = asMap(v);
  return m.map((String k, dynamic val) => MapEntry<String, String>(
        k,
        val == null ? '' : val.toString(),
      ));
}
