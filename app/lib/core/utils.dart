import 'constants.dart';

/// 后端时间统一 ISO-8601 UTC，展示按 UTC+8。
DateTime? parseUtc8(String? raw) {
  if (raw == null || raw.trim().isEmpty) return null;
  final DateTime? parsed = DateTime.tryParse(raw.trim());
  if (parsed == null) return null;
  if (parsed.isUtc) {
    return parsed.add(const Duration(hours: 8));
  }
  return parsed;
}

String two(int v) => v < 10 ? '0$v' : '$v';

String formatDate(String? raw) {
  final DateTime? d = parseUtc8(raw);
  if (d == null) return raw ?? '';
  return '${d.year}-${two(d.month)}-${two(d.day)}';
}

String formatDateTime(String? raw) {
  final DateTime? d = parseUtc8(raw);
  if (d == null) return raw ?? '';
  return '${d.year}-${two(d.month)}-${two(d.day)} ${two(d.hour)}:${two(d.minute)}';
}

String formatClock(String? raw) {
  final DateTime? d = parseUtc8(raw);
  if (d == null) return '';
  return '${two(d.hour)}:${two(d.minute)}';
}

String formatTodayLabel() {
  final DateTime now = DateTime.now().toUtc().add(const Duration(hours: 8));
  return '${now.year}年${now.month}月${now.day}日';
}

String compactNumber(num value) {
  final double v = value.toDouble();
  if (v.abs() >= 100000000) {
    return '${(v / 100000000).toStringAsFixed(2)}亿';
  }
  if (v.abs() >= 10000) {
    return '${(v / 10000).toStringAsFixed(2)}万';
  }
  if (v.abs() >= 1000) {
    return v.toStringAsFixed(0);
  }
  if (v == v.roundToDouble()) return v.toStringAsFixed(0);
  return v.toStringAsFixed(2);
}

String formatCost(double cost) {
  if (cost <= 0) return '¥0.00';
  if (cost < 0.01) return '¥${cost.toStringAsFixed(4)}';
  return '¥${cost.toStringAsFixed(2)}';
}

String formatBytes(num bytes) {
  double v = bytes.toDouble();
  const List<String> units = <String>['B', 'KB', 'MB', 'GB', 'TB'];
  int i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return '${v.toStringAsFixed(i == 0 ? 0 : 2)} ${units[i]}';
}

String rangeLabel(String range) => kRangeLabels[range] ?? range;

String sleepHint(String name, String sleepState) {
  if (sleepState == 'sleep') {
    return '夜深了，明天再来找他/她吧，你也要早点睡哦。$kForceWakeSuffix';
  }
  if (sleepState == 'nap') {
    return '$name在休息哦，要稍后再来找他/她吧。$kForceWakeSuffix';
  }
  return '';
}

String greeting() {
  final DateTime now = DateTime.now().toUtc().add(const Duration(hours: 8));
  final int h = now.hour;
  if (h < 5) return '夜深了';
  if (h < 11) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

String shortText(String input, int max) {
  final String flat = input.replaceAll(RegExp(r'\s+'), ' ').trim();
  if (flat.length <= max) return flat;
  return '${flat.substring(0, max)}…';
}

/// v1.2.0：把更新日志以 + / - / ± 开头的行转换为 新增 / 删除 / 修改。
String formatUpdateNotes(String notes) {
  if (notes.trim().isEmpty) return notes;
  final List<String> out = <String>[];
  for (final String raw in notes.split('\n')) {
    final String line = raw.trimRight();
    final String trimmed = line.trimLeft();
    if (trimmed.startsWith('±')) {
      out.add('修改 ${trimmed.substring(1).trim()}');
    } else if (trimmed.startsWith('+')) {
      out.add('新增 ${trimmed.substring(1).trim()}');
    } else if (trimmed.startsWith('-')) {
      out.add('删除 ${trimmed.substring(1).trim()}');
    } else {
      out.add(line);
    }
  }
  return out.join('\n');
}
