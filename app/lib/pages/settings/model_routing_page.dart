import 'package:flutter/material.dart';

import '../../core/app_state.dart';
import '../../core/constants.dart';
import '../../core/global.dart';
import '../../core/theme.dart';
import '../../models/config_models.dart';
import '../../widgets/capability_icons.dart';

/// 模型分工二级页：每个任务选择模型（从 chat 服务模型列表选择或手填）。
class ModelRoutingPage extends StatelessWidget {
  const ModelRoutingPage({super.key});

  Future<void> _setRouting(
    BuildContext context,
    String task,
    String current,
  ) async {
    final AppState state = AppScope.read(context);
    List<ModelInfo> models = <ModelInfo>[];
    try {
      models = (await state.configService.listModels('chat')).models;
    } catch (_) {
      models = <ModelInfo>[];
    }
    if (!context.mounted) return;

    Widget mark(bool active) => active
        ? const Icon(Icons.check_circle, size: 17, color: AppColors.cocoa)
        : const SizedBox(width: 17);

    final String? value = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      builder: (BuildContext ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
              child: Row(
                children: <Widget>[
                  Text(
                    '${kRoutingLabels[task]} · 选择模型',
                    style: const TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const Spacer(),
                  IconButton(
                    onPressed: () => Navigator.of(ctx).pop(),
                    icon: const Icon(Icons.close, size: 18),
                  ),
                ],
              ),
            ),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                children: <Widget>[
                  ListTile(
                    dense: true,
                    title: const Text('跟随主会话', style: TextStyle(fontSize: 13)),
                    subtitle: const Text(
                      '不单独指定，使用主会话模型',
                      style: TextStyle(fontSize: 10.5),
                    ),
                    trailing: mark(current.isEmpty),
                    onTap: () => Navigator.of(ctx).pop(''),
                  ),
                  ...models.map(
                    (ModelInfo m) => ListTile(
                      dense: true,
                      title: Text(m.id, style: const TextStyle(fontSize: 13)),
                      subtitle: Padding(
                        padding: const EdgeInsets.only(top: 3),
                        child: CapabilityBadge(model: m, dense: true),
                      ),
                      trailing: mark(current == m.id),
                      onTap: () => Navigator.of(ctx).pop(m.id),
                    ),
                  ),
                  if (models.isEmpty)
                    const Padding(
                      padding: EdgeInsets.fromLTRB(16, 6, 16, 6),
                      child: Text(
                        '未获取到模型列表（先在服务配置里点「获取模型列表」），也可以手动输入。',
                        style: TextStyle(fontSize: 10.5, color: AppColors.inkSoft),
                      ),
                    ),
                  ListTile(
                    dense: true,
                    leading: const Icon(Icons.edit_outlined, size: 18),
                    title: const Text('手动输入模型名', style: TextStyle(fontSize: 13)),
                    onTap: () => Navigator.of(ctx).pop('__manual__'),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
    if (value == null || !context.mounted) return;

    String finalValue = value;
    if (value == '__manual__') {
      final TextEditingController ctrl = TextEditingController(text: current);
      final String? typed = await showDialog<String>(
        context: context,
        builder: (BuildContext ctx) => AlertDialog(
          title: Text('${kRoutingLabels[task]} · 模型名'),
          content: TextField(
            controller: ctrl,
            autofocus: true,
            decoration: const InputDecoration(
              hintText: '例如 gpt-4o-mini，留空表示跟随主会话',
            ),
          ),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: () => Navigator.of(ctx).pop(ctrl.text.trim()),
              child: const Text('保存'),
            ),
          ],
        ),
      );
      ctrl.dispose();
      if (typed == null) return;
      finalValue = typed;
    }

    final Map<String, String> routing = <String, String>{
      ...state.modelRouting,
      task: finalValue,
    };
    await state.savePreferences(<String, dynamic>{'modelRouting': routing});
    if (context.mounted) {
      showToast(
        finalValue.isEmpty
            ? '${kRoutingLabels[task]}已跟随主会话'
            : '${kRoutingLabels[task]}使用 $finalValue',
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final AppState state = AppScope.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('模型分工')),
      body: ListView(
        padding: const EdgeInsets.only(bottom: 20),
        children: <Widget>[
          const Padding(
            padding: EdgeInsets.fromLTRB(16, 10, 16, 6),
            child: Text(
              '不同任务可以使用不同模型：主会话、句子检查、画像、创作、状态、记忆、图片理解、新闻、搜索、语音等。',
              style: TextStyle(
                fontSize: 10.5,
                color: AppColors.inkSoft,
                height: 1.5,
              ),
            ),
          ),
          ...kRoutingTasks.map((String task) {
            final String model = state.modelRouting[task] ?? '';
            return ListTile(
              dense: true,
              title: Text(
                kRoutingLabels[task] ?? task,
                style: const TextStyle(fontSize: 13),
              ),
              trailing: Row(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 150),
                    child: Text(
                      model.isEmpty ? '跟随主会话' : model,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 11,
                        color: model.isEmpty
                            ? AppColors.inkSoft
                            : AppColors.cocoa,
                      ),
                    ),
                  ),
                  const Icon(Icons.chevron_right, size: 16),
                ],
              ),
              onTap: () => _setRouting(context, task, model),
            );
          }),
        ],
      ),
    );
  }
}
