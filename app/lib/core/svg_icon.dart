import 'package:flutter/material.dart';

/// 轻量 SVG path 渲染器：不引入 flutter_svg，直接解析 d 属性子集
/// （M/L/H/V/C/Q/Z，绝对与相对指令），以描边方式绘制 24x24 图标。
class SvgPathIcon extends StatelessWidget {
  const SvgPathIcon({
    super.key,
    required this.paths,
    this.size = 18,
    this.color = Colors.black,
    this.strokeWidth = 1.8,
  });

  final List<String> paths;
  final double size;
  final Color color;
  final double strokeWidth;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: size,
      height: size,
      child: CustomPaint(
        painter: _SvgPainter(
          paths: paths,
          color: color,
          strokeWidth: strokeWidth,
          size: size,
        ),
      ),
    );
  }
}

/// 各能力图标（24x24 视图框内的 SVG path 数据）。
class SvgIcons {
  static const List<String> text = <String>[
    'M4 5h16v3.2h-6.3V19h-3.4V8.2H4z',
  ];

  static const List<String> image = <String>[
    'M3.5 5.5h17v13h-17z',
    'M6.6 8.6h2.6v2.6H6.6z',
    'M4.8 17.5l4.6-5.6l3.6 3.6l2-2.1l3.4 4.1z',
  ];

  static const List<String> audio = <String>[
    'M4 10h3.2l4-3.6v11.2l-4-3.6H4z',
    'M15 8.4q3 3.6 0 7.2',
    'M17.6 5.8q5 6.2 0 12.4',
  ];

  static const List<String> clock = <String>[
    'M12 3.6a8.4 8.4 0 1 0 0.1 0z',
    'M12 7.4v5l3.4 2',
  ];
}

class _SvgPainter extends CustomPainter {
  _SvgPainter({
    required this.paths,
    required this.color,
    required this.strokeWidth,
    required this.size,
  });

  final List<String> paths;
  final Color color;
  final double strokeWidth;
  final double size;

  @override
  void paint(Canvas canvas, Size s) {
    final double scale = s.width / 24.0;
    final Paint paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = strokeWidth * (size / 18).clamp(0.7, 1.6)
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..color = color;
    for (final String d in paths) {
      final Path p = MiniSvg.parse(d, scale);
      canvas.drawPath(p, paint);
    }
  }

  @override
  bool shouldRepaint(covariant _SvgPainter old) =>
      old.color != color ||
      old.paths != paths ||
      old.size != size ||
      old.strokeWidth != strokeWidth;
}

/// 只支持图标所需的 SVG path 指令子集。
class MiniSvg {
  static final RegExp _token = RegExp(r'[MmLlHhVvCcQqZz]|-?\d*\.?\d+(?:[eE][-+]?\d+)?');

  static Path parse(String d, double scale) {
    final Path path = Path();
    final List<String> tokens = _token
        .allMatches(d)
        .map((RegExpMatch m) => m.group(0)!)
        .toList(growable: false);
    if (tokens.isEmpty) return path;

    int i = 0;
    String cmd = '';
    double cx = 0, cy = 0, sx = 0, sy = 0;

    bool isCommand(String t) => RegExp(r'^[A-Za-z]$').hasMatch(t);
    bool hasNumber() => i < tokens.length && !isCommand(tokens[i]);
    double next() => double.parse(tokens[i++]);

    void move(double x, double y) {
      sx = x;
      sy = y;
      cx = x;
      cy = y;
      path.moveTo(x * scale, y * scale);
    }

    void line(double x, double y) {
      cx = x;
      cy = y;
      path.lineTo(x * scale, y * scale);
    }

    int guard = 0;
    while (i < tokens.length) {
      if (++guard > 2000) break;
      if (isCommand(tokens[i])) {
        cmd = tokens[i];
        i++;
        if (cmd == 'Z' || cmd == 'z') {
          path.close();
          cx = sx;
          cy = sy;
          continue;
        }
      }
      if (!hasNumber()) continue;

      switch (cmd) {
        case 'M':
        case 'm':
          final double x = next();
          final double y = next();
          move(cmd == 'm' ? cx + x : x, cmd == 'm' ? cy + y : y);
          cmd = cmd == 'm' ? 'l' : 'L';
          break;
        case 'L':
        case 'l':
          final double x = next();
          final double y = next();
          line(cmd == 'l' ? cx + x : x, cmd == 'l' ? cy + y : y);
          break;
        case 'H':
        case 'h':
          final double x = next();
          line(cmd == 'h' ? cx + x : x, cy);
          break;
        case 'V':
        case 'v':
          final double y = next();
          line(cx, cmd == 'v' ? cy + y : y);
          break;
        case 'C':
        case 'c':
          final double x1 = next(), y1 = next();
          final double x2 = next(), y2 = next();
          final double x = next(), y = next();
          final bool rel = cmd == 'c';
          path.cubicTo(
            (rel ? cx + x1 : x1) * scale,
            (rel ? cy + y1 : y1) * scale,
            (rel ? cx + x2 : x2) * scale,
            (rel ? cy + y2 : y2) * scale,
            (rel ? cx + x : x) * scale,
            (rel ? cy + y : y) * scale,
          );
          cx = rel ? cx + x : x;
          cy = rel ? cy + y : y;
          break;
        case 'Q':
        case 'q':
          final double x1 = next(), y1 = next();
          final double x = next(), y = next();
          final bool rel = cmd == 'q';
          path.quadraticBezierTo(
            (rel ? cx + x1 : x1) * scale,
            (rel ? cy + y1 : y1) * scale,
            (rel ? cx + x : x) * scale,
            (rel ? cy + y : y) * scale,
          );
          cx = rel ? cx + x : x;
          cy = rel ? cy + y : y;
          break;
        default:
          i++;
          break;
      }
    }
    return path;
  }
}
