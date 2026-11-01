import 'dart:async';

import 'package:flutter/material.dart';

import 'theme.dart';

/// 全局 Navigator / ScaffoldMessenger，供 ApiClient 与后台任务使用。
final GlobalKey<NavigatorState> appNavigatorKey = GlobalKey<NavigatorState>();
final GlobalKey<ScaffoldMessengerState> appMessengerKey =
    GlobalKey<ScaffoldMessengerState>();

OverlayEntry? _toastEntry;
Timer? _toastTimer;

/// v1.0.1：顶部浮层提示（SlideTransition），错误红色、普通深色，避开键盘与 AppBar。
void showToast(String message, {bool isError = false}) {
  final OverlayState? overlay = appNavigatorKey.currentState?.overlay;
  if (overlay == null) {
    debugPrint('[toast] $message');
    return;
  }
  _toastTimer?.cancel();
  _removeToastEntry();
  final OverlayEntry entry = OverlayEntry(
    builder: (BuildContext context) => _TopToast(
      message: message,
      isError: isError,
      onDismiss: hideToast,
    ),
  );
  _toastEntry = entry;
  overlay.insert(entry);
  _toastTimer = Timer(
    Duration(milliseconds: isError ? 4200 : 2600),
    hideToast,
  );
}

void hideToast() {
  _toastTimer?.cancel();
  _toastTimer = null;
  _removeToastEntry();
}

void _removeToastEntry() {
  final OverlayEntry? entry = _toastEntry;
  _toastEntry = null;
  if (entry == null) return;
  try {
    entry.remove();
  } catch (_) {
    // overlay 已销毁时忽略
  }
}

void showError(String message) => showToast(message, isError: true);

class _TopToast extends StatefulWidget {
  const _TopToast({
    required this.message,
    required this.isError,
    required this.onDismiss,
  });

  final String message;
  final bool isError;
  final VoidCallback onDismiss;

  @override
  State<_TopToast> createState() => _TopToastState();
}

class _TopToastState extends State<_TopToast>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 220),
    )..forward();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final double topInset = MediaQuery.of(context).padding.top;
    final Color bg =
        widget.isError ? AppColors.danger : AppColors.ink.withAlpha(235);
    return Positioned(
      top: topInset + 64,
      left: 12,
      right: 12,
      child: SlideTransition(
        position: Tween<Offset>(
          begin: const Offset(0, -1.1),
          end: Offset.zero,
        ).animate(CurvedAnimation(
          parent: _controller,
          curve: Curves.easeOutCubic,
        )),
        child: FadeTransition(
          opacity: _controller,
          child: GestureDetector(
            onTap: widget.onDismiss,
            child: Material(
              color: Colors.transparent,
              child: Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
                decoration: BoxDecoration(
                  color: bg,
                  borderRadius: BorderRadius.circular(14),
                  boxShadow: <BoxShadow>[
                    BoxShadow(
                      color: Colors.black.withAlpha(50),
                      blurRadius: 16,
                      offset: const Offset(0, 6),
                    ),
                  ],
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Icon(
                      widget.isError
                          ? Icons.error_outline
                          : Icons.info_outline,
                      size: 16,
                      color: Colors.white,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        widget.message,
                        maxLines: 4,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: Colors.white,
                          fontSize: 12.5,
                          height: 1.45,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 统一的确认对话框。
Future<bool> confirmDialog(
  BuildContext context, {
  required String title,
  required String message,
  String confirmText = '确定',
  String cancelText = '取消',
  bool danger = false,
}) async {
  final bool? ok = await showDialog<bool>(
    context: context,
    builder: (BuildContext ctx) => AlertDialog(
      title: Text(title),
      content: Text(message),
      actions: <Widget>[
        TextButton(
          onPressed: () => Navigator.of(ctx).pop(false),
          child: Text(cancelText),
        ),
        FilledButton(
          style: danger
              ? FilledButton.styleFrom(backgroundColor: AppColors.danger)
              : null,
          onPressed: () => Navigator.of(ctx).pop(true),
          child: Text(confirmText),
        ),
      ],
    ),
  );
  return ok ?? false;
}
