import 'package:flutter/material.dart';

import '../core/api_client.dart';
import '../core/app_state.dart';
import '../core/json_utils.dart';
import '../core/theme.dart';

/// 服务地址编辑 + 健康检查（登录前与设置页共用）。
Future<void> showServerAddressDialog(BuildContext context) async {
  final AppState state = AppScope.read(context);
  final TextEditingController ctrl =
      TextEditingController(text: state.baseUrl);
  String? status;
  bool statusOk = false;
  bool busy = false;

  await showDialog<void>(
    context: context,
    builder: (BuildContext ctx) => StatefulBuilder(
      builder: (BuildContext ctx, StateSetter setSt) {
        Future<void> test() async {
          setSt(() => busy = true);
          try {
            final ApiClient probe = ApiClient(baseUrl: ctrl.text);
            final dynamic r = await probe.get('/health', silent: true);
            final Map<String, dynamic> m = asMap(r);
            setSt(() {
              statusOk = asBool(m['ok']);
              status = statusOk
                  ? '连接成功：${asString(m['name'], 'cocoa')} ${asString(m['version'])}'
                  : '响应异常：${r.toString()}';
            });
          } catch (e) {
            setSt(() {
              statusOk = false;
              status = '连接失败：$e';
            });
          } finally {
            setSt(() => busy = false);
          }
        }

        Future<void> save() async {
          setSt(() => busy = true);
          // v1.2.0：只有测试连接通过才保存，失败保持原地址。
          try {
            final ApiClient probe = ApiClient(baseUrl: ctrl.text);
            final dynamic r = await probe.get('/health', silent: true);
            final bool ok = asBool(asMap(r)['ok']);
            if (!ok) {
              setSt(() {
                statusOk = false;
                status = '连接测试未通过，服务地址未修改';
                busy = false;
              });
              return;
            }
          } catch (e) {
            setSt(() {
              statusOk = false;
              status = '连接失败：$e（服务地址未修改）';
              busy = false;
            });
            return;
          }
          await state.setBaseUrl(ctrl.text);
          final bool sessionOk =
              state.loggedIn ? await state.verifySession() : true;
          setSt(() => busy = false);
          if (!ctx.mounted) return;
          if (sessionOk) {
            Navigator.of(ctx).pop();
          } else {
            setSt(() {
              statusOk = false;
              status = '地址已保存，但当前登录态在该服务上无效，请重新登录';
            });
          }
        }

        return AlertDialog(
          title: const Text('服务地址'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              TextField(
                controller: ctrl,
                keyboardType: TextInputType.url,
                decoration: const InputDecoration(
                  hintText: 'https://120-26-204-70.sslip.io',
                  labelText: '后端地址（含协议与端口）',
                ),
                style: const TextStyle(fontSize: 13),
              ),
              const SizedBox(height: 8),
              if (status != null)
                Text(
                  status!,
                  style: TextStyle(
                    fontSize: 11.5,
                    color: statusOk ? AppColors.success : AppColors.danger,
                  ),
                ),
              if (busy)
                const Padding(
                  padding: EdgeInsets.only(top: 8),
                  child: LinearProgressIndicator(minHeight: 2),
                ),
            ],
          ),
          actions: <Widget>[
            TextButton(
              onPressed: busy ? null : test,
              child: const Text('测试连接'),
            ),
            TextButton(
              onPressed: busy ? null : () => Navigator.of(ctx).pop(),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: busy ? null : save,
              child: const Text('保存'),
            ),
          ],
        );
      },
    ),
  );
  ctrl.dispose();
}
