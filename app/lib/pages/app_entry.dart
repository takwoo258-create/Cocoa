import 'package:flutter/material.dart';

import '../core/app_state.dart';
import '../core/global.dart';
import 'api_setup_dialog.dart';
import 'home_page.dart';

/// 登录/启动完成后的统一入口：缺模型配置则先强制配置，直到配置成功才进主页。
Future<void> enterApp(BuildContext context) async {
  final AppState state = AppScope.read(context);
  // v1.5.0：网络差时先重试健康检查，避免误判为“未配置”而跳到 API 配置页。
  if (!state.chatReady) {
    for (int i = 0; i < 3; i++) {
      try {
        final Map<String, dynamic> h = await state.configService.health();
        if (h['ok'] == true) {
          await state.refreshConfig();
          break;
        }
      } catch (_) {}
      await Future<void>.delayed(const Duration(milliseconds: 900));
    }
  }
  if (!state.chatReady && state.config == null) {
    if (!context.mounted) return;
    final bool retry = await showDialog<bool>(
          context: context,
          builder: (BuildContext ctx) => AlertDialog(
            title: const Text('网络连接失败'),
            content: const Text('暂时无法连接服务，请检查网络后重试。不会跳转到模型配置页。'),
            actions: <Widget>[
              TextButton(
                onPressed: () => Navigator.of(ctx).pop(false),
                child: const Text('返回'),
              ),
              FilledButton(
                onPressed: () => Navigator.of(ctx).pop(true),
                child: const Text('重试'),
              ),
            ],
          ),
        ) ??
        false;
    if (retry && context.mounted) await enterApp(context);
    return;
  }
  int guard = 0;
  while (!state.chatReady && guard < 8) {
    guard++;
    await ApiSetupDialog.show(context, force: true);
    if (!context.mounted) return;
    if (!state.chatReady) {
      showToast('需要完成对话模型配置才能开始使用');
      await Future<void>.delayed(const Duration(milliseconds: 250));
    }
  }
  if (!state.chatReady) return;
  if (!context.mounted) return;
  Navigator.of(context).pushAndRemoveUntil(
    MaterialPageRoute<void>(builder: (_) => const HomePage()),
    (Route<dynamic> route) => false,
  );
}
