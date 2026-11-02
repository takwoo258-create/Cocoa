import 'package:flutter/material.dart';

import '../core/constants.dart';
import '../models/config_models.dart';

/// v1.3.0：模型提供源编辑对话框（用户自建 / 管理端系统提供源共用）。
Future<Map<String, dynamic>?> showProviderEditor(
  BuildContext context, {
  ProviderConfig? initial,
  bool system = false,
}) async {
  final TextEditingController name =
      TextEditingController(text: initial?.name ?? '');
  final TextEditingController baseUrl =
      TextEditingController(text: initial?.baseUrl ?? '');
  final TextEditingController apiKey = TextEditingController();
  final Map<String, TextEditingController> models =
      <String, TextEditingController>{
    for (final String s in kServices)
      s: TextEditingController(text: initial?.models[s] ?? ''),
  };
  String? status;

  final Map<String, dynamic>? result = await showDialog<Map<String, dynamic>>(
    context: context,
    builder: (BuildContext ctx) => StatefulBuilder(
      builder: (BuildContext ctx, StateSetter setSt) => AlertDialog(
        title: Text(
          system
              ? (initial == null ? '新增系统提供源' : '编辑系统提供源')
              : (initial == null ? '新增模型提供源' : '编辑模型提供源'),
        ),
        content: SizedBox(
          width: 520,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                TextField(
                  controller: name,
                  decoration: const InputDecoration(labelText: '名称'),
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: baseUrl,
                  keyboardType: TextInputType.url,
                  decoration: const InputDecoration(labelText: 'BaseURL'),
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: apiKey,
                  obscureText: true,
                  decoration: InputDecoration(
                    labelText: 'API Key',
                    hintText: initial?.apiKeySet == true
                        ? '已保存（留空保持 ****）'
                        : 'sk-...',
                  ),
                ),
                const SizedBox(height: 10),
                const Text(
                  '各服务的模型名（留空表示该提供源不提供该服务）',
                  style: TextStyle(fontSize: 11),
                ),
                const SizedBox(height: 4),
                ...kServices.map(
                  (String s) => Padding(
                    padding: const EdgeInsets.only(bottom: 6),
                    child: TextField(
                      controller: models[s],
                      decoration: InputDecoration(
                        labelText: kServiceLabels[s] ?? s,
                        isDense: true,
                      ),
                    ),
                  ),
                ),
                if (status != null)
                  Text(
                    status!,
                    style: const TextStyle(
                      fontSize: 11,
                      color: Color(0xFFB3543F),
                    ),
                  ),
              ],
            ),
          ),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () {
              if (name.text.trim().isEmpty || baseUrl.text.trim().isEmpty) {
                setSt(() => status = '请填写名称与 BaseURL');
                return;
              }
              final Map<String, String> modelMap = <String, String>{};
              models.forEach((String s, TextEditingController c) {
                final String v = c.text.trim();
                if (v.isNotEmpty) modelMap[s] = v;
              });
              if (modelMap.isEmpty) {
                setSt(() => status = '至少填写一个服务的模型名');
                return;
              }
              Navigator.of(ctx).pop(<String, dynamic>{
                'id': initial?.id.isNotEmpty == true
                    ? initial!.id
                    : 'p_${DateTime.now().millisecondsSinceEpoch}',
                'name': name.text.trim(),
                'baseUrl': baseUrl.text.trim(),
                if (apiKey.text.trim().isNotEmpty)
                  'apiKey': apiKey.text.trim()
                else if (initial?.apiKeySet == true)
                  'apiKey': '****',
                'models': modelMap,
              });
            },
            child: const Text('保存'),
          ),
        ],
      ),
    ),
  );
  for (final TextEditingController c in models.values) {
    c.dispose();
  }
  name.dispose();
  baseUrl.dispose();
  apiKey.dispose();
  return result;
}
