import 'package:flutter/material.dart';
import '../../core/layout.dart';

import '../../core/app_state.dart';
import '../../core/constants.dart';
import '../../core/theme.dart';
import '../../models/config_models.dart';
import '../../widgets/service_editor.dart';

/// 服务配置二级页：v1.0.1 起 search/fetch 复用 DeepSeek，不再单列。
class ServiceConfigPage extends StatelessWidget {
  const ServiceConfigPage({super.key});

  bool _ready(AppState state, String service) {
    final ServiceConfig cfg =
        state.config?.service(service) ?? ServiceConfig.empty;
    switch (service) {
      case 'chat':
        return state.chatReady;
      case 'embedding':
        return state.embeddingReady;
      case 'stt':
        return state.config?.readyStt ?? false;
      case 'tts':
        return state.config?.readyTts ?? false;
      default:
        return cfg.configured;
    }
  }

  @override
  Widget build(BuildContext context) {
    final AppState state = AppScope.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('服务配置')),
      body: ListView(
        padding: pagePadding(context),
        children: <Widget>[
          if (!state.chatReady)
            Container(
              margin: const EdgeInsets.fromLTRB(12, 8, 12, 0),
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: AppColors.warn.withAlpha(24),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: AppColors.warn.withAlpha(90)),
              ),
              child: const Text(
                '对话模型未配置：填写 baseUrl 与 API Key 后点击「保存」，再「获取模型列表」。',
                style: TextStyle(fontSize: 11.5, color: AppColors.warn),
              ),
            ),
          ...kServices.map((String service) {
            final ServiceConfig cfg =
                state.config?.service(service) ?? ServiceConfig.empty;
            final bool ready = _ready(state, service);
            return Container(
              margin: const EdgeInsets.fromLTRB(12, 8, 12, 0),
              decoration: BoxDecoration(
                color: AppColors.white,
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: AppColors.sand),
              ),
              child: ExpansionTile(
                shape: const Border(),
                collapsedShape: const Border(),
                tilePadding: const EdgeInsets.symmetric(horizontal: 12),
                title: Row(
                  children: <Widget>[
                    Text(
                      kServiceLabels[service] ?? service,
                      style: const TextStyle(fontSize: 13.5),
                    ),
                    const SizedBox(width: 6),
                    Icon(
                      ready ? Icons.check_circle : Icons.radio_button_unchecked,
                      size: 12,
                      color: ready ? AppColors.success : AppColors.inkSoft,
                    ),
                    const Spacer(),
                    Flexible(
                      child: Text(
                        cfg.model.isEmpty ? '未设置模型' : cfg.model,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 10,
                          color: AppColors.inkSoft,
                        ),
                      ),
                    ),
                  ],
                ),
                children: <Widget>[
                  Padding(
                    padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
                    child: ServiceEditor(
                      state: state,
                      service: service,
                      showVoice: service == 'tts',
                    ),
                  ),
                ],
              ),
            );
          }),
          const Padding(
            padding: EdgeInsets.fromLTRB(16, 14, 16, 0),
            child: Text(
              'v1.0.1 起网页搜索 / 抓取复用 DeepSeek 配置，不再提供 search、fetch 服务项。',
              style: TextStyle(fontSize: 10.5, color: AppColors.inkSoft),
            ),
          ),
        ],
      ),
    );
  }
}
