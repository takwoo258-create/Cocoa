import 'package:flutter/material.dart';

import '../../core/app_state.dart';
import '../../core/constants.dart';
import '../../core/global.dart';
import '../../core/json_utils.dart';
import '../../core/layout.dart';
import '../../core/theme.dart';
import '../../models/config_models.dart';
import '../../widgets/common.dart';
import '../../widgets/provider_editor_dialog.dart';
import '../../widgets/service_editor.dart';
import '../../widgets/voice_test_panel.dart';

/// 服务配置二级页：统一模型来源 + 多提供源 + 各服务配置。
class ServiceConfigPage extends StatefulWidget {
  const ServiceConfigPage({super.key});

  @override
  State<ServiceConfigPage> createState() => _ServiceConfigPageState();
}

class _ServiceConfigPageState extends State<ServiceConfigPage> {
  List<ProviderConfig> _providers = <ProviderConfig>[];
  String _modelSource = 'own';
  String _systemProviderId = '';
  Map<String, String> _active = <String, String>{};
  bool _initialized = false;
  bool _saving = false;
  String _voiceMode = 'auto';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _loadFromState());
  }

  void _loadFromState() {
    final AppConfig? cfg = AppScope.read(context).config;
    setState(() {
      _providers = List<ProviderConfig>.of(cfg?.providers ?? const <ProviderConfig>[]);
      final bool systemEnabled = cfg?.systemModels.enabled ?? false;
      _modelSource = systemEnabled ? (cfg?.modelSource ?? 'own') : 'own';
      _systemProviderId = cfg?.systemProviderId ?? '';
      _active = Map<String, String>.of(
        cfg?.activeProviderId ?? const <String, String>{},
      );
      _voiceMode = cfg?.voiceReplyMode ?? 'auto';
      _initialized = true;
    });
  }

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

  Future<void> _saveVoiceMode(String mode) async {
    final AppState state = AppScope.read(context);
    setState(() => _voiceMode = mode);
    try {
      await state.configService.savePreferences(<String, dynamic>{
        'voiceReplyMode': mode,
      });
      await state.refreshConfig();
      if (mounted) showToast('语音回复设置已保存');
    } catch (e) {
      if (mounted) showToast('保存失败：$e', isError: true);
    }
  }

  Widget _voiceReplyCard() {
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 0, 12, 8),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: AppColors.sand.withAlpha(90),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        children: <Widget>[
          const Icon(Icons.record_voice_over_outlined, size: 17),
          const SizedBox(width: 8),
          const Expanded(
            child: Text(
              '语音回复',
              style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
            ),
          ),
          DropdownButton<String>(
            value: _voiceMode,
            underline: const SizedBox.shrink(),
            style: const TextStyle(fontSize: 12, color: AppColors.ink),
            items: const <DropdownMenuItem<String>>[
              DropdownMenuItem<String>(value: 'auto', child: Text('仅语音消息')),
              DropdownMenuItem<String>(value: 'always', child: Text('始终发送语音')),
              DropdownMenuItem<String>(value: 'off', child: Text('关闭')),
            ],
            onChanged: (String? value) {
              if (value != null) _saveVoiceMode(value);
            },
          ),
        ],
      ),
    );
  }

  Future<void> _saveSources() async {
    final AppState state = AppScope.read(context);
    setState(() => _saving = true);
    try {
      await state.configService.saveModelConfig(
        modelSource: _modelSource,
        systemProviderId: _systemProviderId,
        providers: _providers.map((ProviderConfig p) => p.toJson()).toList(),
        activeProviderId: _active,
      );
      await state.refreshConfig();
      if (mounted) showToast('模型来源已保存');
      _loadFromState();
    } catch (e) {
      if (mounted) showToast('保存失败：$e', isError: true);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _editProvider([ProviderConfig? initial]) async {
    final Map<String, dynamic>? data =
        await showProviderEditor(context, initial: initial);
    if (data == null || !mounted) return;
    final ProviderConfig p = ProviderConfig(
      id: asString(data['id']),
      name: asString(data['name']),
      baseUrl: asString(data['baseUrl']),
      apiKey: asString(data['apiKey']),
      apiKeySet: asString(data['apiKey']).isNotEmpty,
      models: asStringMap(data['models']),
      services: asStringMap(data['models']).keys.toList(),
    );
    setState(() {
      final int idx = _providers.indexWhere((ProviderConfig x) => x.id == p.id);
      if (idx >= 0) {
        _providers[idx] = p;
      } else {
        _providers.add(p);
      }
    });
  }

  Future<void> _deleteProvider(ProviderConfig p) async {
    final bool ok = await confirmDialog(
      context,
      title: '删除提供源',
      message: '确定删除「${p.name}」吗？使用它的服务会回退到默认来源。',
      confirmText: '删除',
      danger: true,
    );
    if (!ok) return;
    setState(() {
      _providers.removeWhere((ProviderConfig x) => x.id == p.id);
      _active.removeWhere((String _, String v) => v == p.id);
    });
  }

  Widget _sourceCard(AppState state) {
    final SystemModels sys = state.config?.systemModels ?? const SystemModels();
    return SectionCard(
      title: '模型来源',
      trailing: TextButton(
        onPressed: _saving ? null : _saveSources,
        style: TextButton.styleFrom(
          minimumSize: const Size(0, 28),
          padding: const EdgeInsets.symmetric(horizontal: 8),
          textStyle: const TextStyle(fontSize: 11.5),
        ),
        child: Text(_saving ? '保存中…' : '保存来源'),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          if (sys.enabled)
            SegmentedButton<String>(
              segments: const <ButtonSegment<String>>[
                ButtonSegment<String>(
                  value: 'system',
                  label: Text('使用系统模型'),
                ),
                ButtonSegment<String>(
                  value: 'own',
                  label: Text('使用自己的模型'),
                ),
              ],
              selected: <String>{_modelSource},
              onSelectionChanged: (Set<String> v) =>
                  setState(() => _modelSource = v.first),
            ),
          if (sys.enabled) ...<Widget>[
            const SizedBox(height: 8),
            const Text(
              '系统统一模型（点击选择）',
              style: TextStyle(fontSize: 10.5, color: AppColors.inkSoft),
            ),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: sys.providers
                  .map(
                    (ProviderConfig p) => ChoiceChip(
                      label: Text(
                        '${p.name}\n${p.servicesLabel}',
                        style: const TextStyle(fontSize: 10.5),
                      ),
                      selected: _modelSource == 'system' &&
                          _systemProviderId == p.id,
                      onSelected: (_) => setState(() {
                        _systemProviderId = p.id;
                        _modelSource = 'system';
                      }),
                    ),
                  )
                  .toList(),
            ),
          ],
          if (!sys.enabled || _modelSource == 'own') ...<Widget>[
            const SizedBox(height: 6),
            Row(
              children: <Widget>[
                const Expanded(
                  child: Text(
                    '我的提供源（可配置多个）',
                    style: TextStyle(fontSize: 11.5),
                  ),
                ),
                TextButton.icon(
                  onPressed: () => _editProvider(),
                  icon: const Icon(Icons.add, size: 15),
                  label: const Text(
                    '新增提供源',
                    style: TextStyle(fontSize: 11),
                  ),
                  style: TextButton.styleFrom(
                    minimumSize: const Size(0, 30),
                  ),
                ),
              ],
            ),
            if (_providers.isEmpty)
              const Text(
                '还没有自己的提供源；新增后可在这里按服务选择。',
                style: TextStyle(fontSize: 10.5, color: AppColors.inkSoft),
              ),
            ..._providers.map(
              (ProviderConfig p) => Container(
                margin: const EdgeInsets.only(top: 6),
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: AppColors.cream,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: AppColors.sand),
                ),
                child: Row(
                  children: <Widget>[
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Text(
                            p.name.isEmpty ? p.id : p.name,
                            style: const TextStyle(
                              fontSize: 12.5,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          Text(
                            '${p.baseUrl} · ${p.servicesLabel}',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 10,
                              color: AppColors.inkSoft,
                            ),
                          ),
                        ],
                      ),
                    ),
                    IconButton(
                      visualDensity: VisualDensity.compact,
                      icon: const Icon(Icons.edit_outlined, size: 17),
                      onPressed: () => _editProvider(p),
                    ),
                    IconButton(
                      visualDensity: VisualDensity.compact,
                      icon: const Icon(Icons.delete_outline, size: 17),
                      onPressed: () => _deleteProvider(p),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _activeCard(AppState state) {
    if (_providers.isEmpty) return const SizedBox.shrink();
    if (_modelSource == 'system' && (state.config?.systemModels.enabled ?? false)) {
      return const SizedBox.shrink();
    }
    return SectionCard(
      title: '按服务选择提供源',
      child: Column(
        children: kServices.map((String service) {
          final String value =
              _providers.any((ProviderConfig p) => p.id == _active[service])
                  ? _active[service]!
                  : '';
          return Row(
            children: <Widget>[
              SizedBox(
                width: 96,
                child: Text(
                  kServiceLabels[service] ?? service,
                  style: const TextStyle(fontSize: 11.5),
                ),
              ),
              Expanded(
                child: DropdownButton<String>(
                  isExpanded: true,
                  value: value,
                  hint: const Text('默认（使用上方服务配置）',
                      style: TextStyle(fontSize: 11)),
                  items: <DropdownMenuItem<String>>[
                    const DropdownMenuItem<String>(
                      value: '',
                      child: Text('默认', style: TextStyle(fontSize: 11.5)),
                    ),
                    ..._providers.map(
                      (ProviderConfig p) => DropdownMenuItem<String>(
                        value: p.id,
                        child: Text(
                          p.models[service]?.isNotEmpty == true
                              ? '${p.name} · ${p.models[service]}'
                              : p.name,
                          style: const TextStyle(fontSize: 11.5),
                        ),
                      ),
                    ),
                  ],
                  onChanged: (String? v) {
                    setState(() {
                      if (v == null || v.isEmpty) {
                        _active.remove(service);
                      } else {
                        _active[service] = v;
                      }
                    });
                  },
                ),
              ),
            ],
          );
        }).toList(),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final AppState state = AppScope.of(context);
    if (!_initialized) {
      return Scaffold(
        appBar: AppBar(title: const Text('服务配置')),
        body: const Center(child: CircularProgressIndicator()),
      );
    }
    return Scaffold(
      appBar: AppBar(
        title: const Text('服务配置'),
        actions: <Widget>[
          IconButton(
            tooltip: '刷新',
            icon: const Icon(Icons.refresh, size: 20),
            onPressed: () async {
              await state.refreshConfig();
              if (mounted) _loadFromState();
            },
          ),
        ],
      ),
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
                '对话模型未配置：可选择系统统一模型，或填写自己的提供源与服务配置。',
                style: TextStyle(fontSize: 11.5, color: AppColors.warn),
              ),
            ),
          _sourceCard(state),
          _activeCard(state),
          ...kServices.map((String service) {
            final ServiceConfig cfg =
                state.config?.service(service) ?? ServiceConfig.empty;
            final bool ready = _ready(state, service);
            final ProviderMeta? meta = state.config?.providerMeta[service];
            final Map<String, dynamic> shared =
                asMap(asMap(state.config?.shared)[service]);
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
                        meta?.label.isNotEmpty == true
                            ? meta!.label
                            : (shared.isNotEmpty && !ready
                                ? '来自分享'
                                : (cfg.model.isEmpty ? '未设置模型' : cfg.model)),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 10,
                          color: meta?.label.isNotEmpty == true
                              ? AppColors.rose
                              : (shared.isNotEmpty && !ready
                                  ? AppColors.rose
                                  : AppColors.inkSoft),
                        ),
                      ),
                    ),
                  ],
                ),
                children: <Widget>[
                  if (shared.isNotEmpty)
                    Container(
                      margin: const EdgeInsets.fromLTRB(12, 0, 12, 8),
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                        color: AppColors.rose.withAlpha(18),
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(
                          color: AppColors.rose.withAlpha(80),
                        ),
                      ),
                      child: Text(
                        '共享来源：#${asInt(shared['ownerCode'])} '
                        '${asString(shared['ownerNickname'])}'
                        '${asString(shared['expiresAt']).isEmpty ? '' : ' · 到期 ${asString(shared['expiresAt'])}'}'
                        '${asString(shared['model']).isEmpty ? '' : ' · 模型 ${asString(shared['model'])}'}'
                        '${ready ? '' : '（未自行配置时自动使用）'}',
                        style: const TextStyle(
                          fontSize: 10.5,
                          color: AppColors.cocoa,
                          height: 1.5,
                        ),
                      ),
                    ),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
                    child: Column(
                      children: <Widget>[
                        if (service == 'tts') _voiceReplyCard(),
                        if (service == 'tts' || service == 'stt')
                          VoiceTestPanel(service: service),
                        ServiceEditor(
                          state: state,
                          service: service,
                          showVoice: service == 'tts',
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            );
          }),
          const Padding(
            padding: EdgeInsets.fromLTRB(16, 14, 16, 0),
            child: Text(
              '网页搜索 / 抓取复用 DeepSeek；系统统一模型启用时可一键使用，也可配置多个自己的提供源并按服务选择。',
              style: TextStyle(fontSize: 10.5, color: AppColors.inkSoft),
            ),
          ),
        ],
      ),
    );
  }
}
