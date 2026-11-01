import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// v1.1.0 断点：最短边 >=600dp 视为平板；宽度 >=900dp 为宽屏。
class Breakpoints {
  static const double tablet = 600;
  static const double wide = 900;

  static bool isTablet(BuildContext context) =>
      MediaQuery.sizeOf(context).shortestSide >= tablet;

  static bool isWide(BuildContext context) =>
      MediaQuery.sizeOf(context).width >= wide;
}

/// 手机锁竖屏、平板允许横竖屏；在尺寸/方向变化时重新应用（didChangeMetrics）。
/// 不依赖 AndroidManifest 的 screenOrientation。
class OrientationGate extends StatefulWidget {
  const OrientationGate({super.key, required this.child});

  final Widget child;

  @override
  State<OrientationGate> createState() => _OrientationGateState();
}

class _OrientationGateState extends State<OrientationGate>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) => _apply());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeMetrics() {
    WidgetsBinding.instance.addPostFrameCallback((_) => _apply());
  }

  void _apply() {
    if (!mounted) return;
    final Size size = MediaQuery.sizeOf(context);
    final bool tablet = size.shortestSide >= Breakpoints.tablet;
    if (tablet) {
      SystemChrome.setPreferredOrientations(<DeviceOrientation>[
        DeviceOrientation.portraitUp,
        DeviceOrientation.landscapeLeft,
        DeviceOrientation.landscapeRight,
      ]);
    } else {
      SystemChrome.setPreferredOrientations(<DeviceOrientation>[
        DeviceOrientation.portraitUp,
      ]);
    }
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

/// 内容限宽并居中：宽屏下避免内容被拉得过宽。
class ContentFrame extends StatelessWidget {
  const ContentFrame({
    super.key,
    required this.maxWidth,
    required this.child,
    this.alignment = Alignment.topCenter,
  });

  final double maxWidth;
  final Widget child;
  final Alignment alignment;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: alignment,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: maxWidth),
        child: child,
      ),
    );
  }
}

/// 平板/横屏下的列数（角色网格等）。
int responsiveColumns(BuildContext context, {double minItemWidth = 300}) {
  final double width = MediaQuery.sizeOf(context).width;
  if (width < Breakpoints.tablet) return 1;
  final int cols = (width / minItemWidth).floor();
  return cols.clamp(2, 3);
}

/// 列表页内容限宽：宽度超过 [maxWidth] 时左右增加留白，使内容居中。
EdgeInsets pagePadding(
  BuildContext context, {
  double maxWidth = 760,
  double top = 8,
  double bottom = 24,
  double side = 12,
}) {
  final double width = MediaQuery.sizeOf(context).width;
  final double horizontal =
      width > maxWidth ? (width - maxWidth) / 2 + side : side;
  return EdgeInsets.fromLTRB(horizontal, top, horizontal, bottom);
}
