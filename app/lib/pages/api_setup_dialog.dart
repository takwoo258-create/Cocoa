import 'package:flutter/material.dart';

import '../core/app_state.dart';
import '../core/global.dart';
import '../core/theme.dart';
import '../widgets/service_editor.dart';

/// 启动/登录后强制配置对话模型（未配置则无法使用智能体）。
/// v1.0.1：键盘弹出时整体上移并可滚动，所有字段与「保存并进入」始终可达。
class ApiSetupDialog extends StatefulWidget {
  const ApiSetupDialog({super.key, this.force = true});

  final bool force;

  static Future<bool> show(BuildContext context, {bool force = true}) async {
    final bool? ok = await showDialog<bool>(
      context: context,
      barrierDismissible: !force,
      builder: (BuildContext ctx) => ApiSetupDialog(force: force),
    );
    return ok ?? false;
  }

  @override
  State<ApiSetupDialog> createState() => _ApiSetupDialogState();
}

class _ApiSetupDialogState extends State<ApiSetupDialog> {
  final GlobalKey<ServiceEditorState> _chatKey =
      GlobalKey<ServiceEditorState>();
  final GlobalKey<ServiceEditorState> _embedKey =
      GlobalKey<ServiceEditorState>();
  final ScrollController _scroll = ScrollController();
  bool _embeddingOpen = false;
  bool _busy = false;

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _finish() async {
    final AppState state = AppScope.read(context);
    final ServiceEditorState? chat = _chatKey.currentState;
    if (chat == null) return;
    setState(() => _busy = true);
    try {
      final bool chatOk = await chat.save(silent: true);
      if (!chatOk) {
        showToast('请先填写对话模型的服务地址与 API Key');
        return;
      }
      if (_embeddingOpen) {
        await _embedKey.currentState?.save(silent: true);
      }
      await state.refreshConfig();
      if (!state.chatReady) {
        showToast('对话模型尚未生效，请检查 API Key 后重试');
        return;
      }
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      showToast('保存失败：$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _header() {
    return Row(
      children: <Widget>[
        Container(
          padding: const EdgeInsets.all(8),
          decoration: const BoxDecoration(
            gradient: kCocoaGradient,
            shape: BoxShape.circle,
          ),
          child: const Icon(Icons.auto_awesome, color: Colors.white, size: 18),
        ),
        const SizedBox(width: 10),
        const Expanded(
          child: Text(
            '配置模型服务',
            style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
          ),
        ),
        if (!widget.force)
          IconButton(
            onPressed: () => Navigator.of(context).pop(false),
            icon: const Icon(Icons.close, size: 18),
          ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final AppState state = AppScope.read(context);
    final MediaQueryData mq = MediaQuery.of(context);
    // Dialog 自身会把 MediaQuery.viewInsets 加到 insetPadding 上（键盘弹出时自动上移），
    // 这里只给出可滚动内容与高度上限，避免重复扣减导致内容被压得过小。
    final double available =
        mq.size.height - mq.padding.top - mq.padding.bottom - 24;
    final double maxHeight = available.clamp(240.0, mq.size.height);
    return PopScope(
      canPop: !widget.force,
      child: Dialog(
        insetPadding: const EdgeInsets.fromLTRB(12, 12, 12, 12),
        child: ConstrainedBox(
            constraints: BoxConstraints(maxWidth: 520, maxHeight: maxHeight),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 14, 8, 4),
                  child: _header(),
                ),
                Flexible(
                  child: SingleChildScrollView(
                    controller: _scroll,
                    keyboardDismissBehavior:
                        ScrollViewKeyboardDismissBehavior.onDrag,
                    padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        const Text(
                          'Cocoa 需要接入 OpenAI 兼容的对话模型才能使用智能体。API Key 仅保存在你的账号下。',
                          style: TextStyle(
                            fontSize: 12,
                            color: AppColors.inkSoft,
                            height: 1.5,
                          ),
                        ),
                        Container(
                          margin: const EdgeInsets.only(top: 8),
                          padding: const EdgeInsets.symmetric(
                            horizontal: 10,
                            vertical: 6,
                          ),
                          decoration: BoxDecoration(
                            color: state.chatReady
                                ? AppColors.success.withAlpha(24)
                                : AppColors.warn.withAlpha(24),
                            borderRadius: BorderRadius.circular(8),
                          ),
                          child: Row(
                            children: <Widget>[
                              Icon(
                                state.chatReady
                                    ? Icons.check_circle_outline
                                    : Icons.info_outline,
                                size: 14,
                                color: state.chatReady
                                    ? AppColors.success
                                    : AppColors.warn,
                              ),
                              const SizedBox(width: 6),
                              Expanded(
                                child: Text(
                                  state.chatReady
                                      ? '对话模型已配置，可继续微调'
                                      : '对话模型未配置，必须填写后才能进入',
                                  style: TextStyle(
                                    fontSize: 11.5,
                                    color: state.chatReady
                                        ? AppColors.success
                                        : AppColors.warn,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(height: 4),
                        ServiceEditor(
                          key: _chatKey,
                          state: state,
                          service: 'chat',
                          defaultBaseUrl: 'https://api.openai.com/v1',
                        ),
                        const SizedBox(height: 8),
                        Container(
                          decoration: BoxDecoration(
                            color: AppColors.white,
                            borderRadius: BorderRadius.circular(12),
                            border: Border.all(color: AppColors.sand),
                          ),
                          child: ExpansionTile(
                            shape: const Border(),
                            collapsedShape: const Border(),
                            tilePadding:
                                const EdgeInsets.symmetric(horizontal: 12),
                            title: const Text(
                              '记忆嵌入模型（可选）',
                              style: TextStyle(fontSize: 13),
                            ),
                            subtitle: const Text(
                              '不配置则无法形成长期记忆图谱',
                              style: TextStyle(
                                fontSize: 11,
                                color: AppColors.inkSoft,
                              ),
                            ),
                            onExpansionChanged: (bool v) =>
                                setState(() => _embeddingOpen = v),
                            children: <Widget>[
                              Padding(
                                padding:
                                    const EdgeInsets.fromLTRB(12, 0, 12, 12),
                                child: ServiceEditor(
                                  key: _embedKey,
                                  state: state,
                                  service: 'embedding',
                                  defaultBaseUrl: 'https://api.openai.com/v1',
                                ),
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(height: 6),
                        const Text(
                          '提示：DeepSeek / 通义 / GLM 等网关请把 baseUrl 填到 /v1 结尾，模型名按网关实际名称填写。',
                          style: TextStyle(
                            fontSize: 11,
                            color: AppColors.inkSoft,
                            height: 1.5,
                          ),
                        ),
                        const SizedBox(height: 12),
                        Row(
                          children: <Widget>[
                            if (!widget.force)
                              TextButton(
                                onPressed: () =>
                                    Navigator.of(context).pop(false),
                                child: const Text('稍后配置'),
                              ),
                            const Spacer(),
                            FilledButton(
                              onPressed: _busy ? null : _finish,
                              child: _busy
                                  ? const SizedBox(
                                      width: 16,
                                      height: 16,
                                      child: CircularProgressIndicator(
                                        strokeWidth: 2,
                                        color: Colors.white,
                                      ),
                                    )
                                  : const Text('保存并进入'),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
      ),
    );
  }
}
