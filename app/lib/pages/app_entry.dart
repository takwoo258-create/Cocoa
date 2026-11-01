import 'package:flutter/material.dart';

import '../core/app_state.dart';
import '../core/global.dart';
import 'api_setup_dialog.dart';
import 'home_page.dart';

/// 登录/启动完成后的统一入口：缺模型配置则先强制配置，直到配置成功才进主页。
Future<void> enterApp(BuildContext context) async {
  final AppState state = AppScope.read(context);
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
