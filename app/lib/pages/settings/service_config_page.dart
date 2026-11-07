import 'package:flutter/material.dart';

import '../../core/app_state.dart';
import '../../core/global.dart';
import '../../core/json_utils.dart';
import '../../core/layout.dart';
import '../../core/theme.dart';
import '../../models/config_models.dart';
import '../../models/model_profile.dart';
import '../../widgets/common.dart';
import '../../widgets/plaza_publish_dialog.dart';
import '../../widgets/voice_test_panel.dart';

/// v1.5.0：按服务分组的命名模型配置（api.profiles / api.active）。
class ServiceConfigPage extends StatefulWidget {
  const ServiceConfigPage({super.key});

  @override
  State<ServiceConfigPage> createState() => _ServiceConfigPageState();
}

class _ServiceConfigPageState extends State<ServiceConfigPage> {
  Map<String, List<ModelProfile>> _profiles = <String, List<ModelProfile>>{};
  Map<String, String> _active = <String, String>{};
  String _modelSource = 'own';
  String _systemProviderId = '';
  bool _loading = true;
  bool _saving = false;

  List<String> get _services {
    final AppConfig? cfg = AppScope.read(context).config;
    final List<String> list =
        asStringList(asMap(cfg?.defaults)['services']);
    final List<String> out = List<String>.of(
      list.isEmpty ? kModelServiceGroups : list,
    );
    if (!out.contains('image')) out.add('image');
    return out;
  }

  String _label(String service) {
    final AppConfig? cfg = AppScope.read(context).config;
    return modelServiceLabel(service, cfg?.defaults ?? <String, dynamic>{});
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  void _load() {
    final AppConfig? cfg = AppScope.read(context).config;
    final Map<String, List<ModelProfile>> loaded =
        <String, List<ModelProfile>>{};
    for (final String s in _services) {
      loaded[s] = List<ModelProfile>.of(cfg?.profiles[s] ?? const <ModelProfile>[]);
    }
    setState(() {
      _profiles = loaded;
      _active = Map<String, String>.of(cfg?.active ?? const <String, String>{});
      _modelSource = cfg?.modelSource ?? 'own';
      _systemProviderId = cfg?.systemProviderId ?? '';
      _loading = false;
    });
  }

  void _setLocal(String service, List<ModelProfile> list) {
    setState(() => _profiles[service] = list);
  }

  Future<void> _saveGroup(String service) async {
    final AppState state = AppScope.read(context);
    setState(() => _saving = true);
    try {
      await state.configService.saveProfiles(
        profiles: <String, List<ModelProfile>>{
          service: _profiles[service] ?? <ModelProfile>[],
        },
        active: <String, String>{service: _active[service] ?? ''},
      );
      await state.refreshConfig();
      _load();
      if (mounted) showToast('${_label(service)}已保存');
    } catch (e) {
      if (mounted) showToast('保存失败：$e', isError: true);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _setActive(String service, String id) async {
    final AppState state = AppScope.read(context);
    setState(() => _active[service] = id);
    try {
      await state.configService.saveProfiles(
        active: <String, String>{service: id},
      );
      await state.refreshConfig();
      if (mounted) {
        setState(() {
          _active[service] = state.config?.active[service] ?? id;
        });
      }
    } catch (e) {
      if (mounted) showToast('切换失败：$e', isError: true);
    }
  }

  Future<void> _saveSource() async {
    final AppState state = AppScope.read(context);
    setState(() => _saving = true);
    try {
      await state.configService.saveProfiles(
        modelSource: _modelSource,
        systemProviderId: _modelSource == 'system' ? _systemProviderId : '',
      );
      await state.refreshConfig();
      _load();
      if (mounted) showToast('模型来源已保存');
    } catch (e) {
      if (mounted) showToast('保存失败：$e', isError: true);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _test(String service, ModelProfile p) async {
    final AppState state = AppScope.read(context);
    showToast('正在测试 ${p.name}…');
    final Map<String, dynamic> r = await state.configService.testProfileConfig(
      service: service,
      profileId: p.id.isNotEmpty ? p.id : null,
      baseUrl: p.id.isEmpty ? p.baseUrl : null,
      apiKey: p.id.isEmpty ? p.apiKey : null,
      model: p.model,
    );
    if (!mounted) return;
    final bool ok = asBool(r['ok']);
    showToast(
      ok
          ? '连接成功${asInt(r['latencyMs']) > 0 ? ' · ${asInt(r['latencyMs'])}ms' : ''}'
          : '连接失败：${asString(r['detail'], '未知错误')}',
      isError: !ok,
    );
  }

  Future<void> _delete(String service, ModelProfile p) async {
    final bool ok = await confirmDialog(
      context,
      title: '删除配置',
      message: '确定删除「${p.name}」吗？',
      confirmText: '删除',
      danger: true,
    );
    if (!ok) return;
    final List<ModelProfile> list = List<ModelProfile>.of(
      _profiles[service] ?? const <ModelProfile>[],
    )..removeWhere((ModelProfile x) => x.id == p.id);
    _setLocal(service, list);
    if (_active[service] == p.id) _active[service] = '';
    await _saveGroup(service);
  }

  Future<void> _copy(String service, ModelProfile p) async {
    final List<ModelProfile> list = List<ModelProfile>.of(
      _profiles[service] ?? const <ModelProfile>[],
    )..add(ModelProfile(
        name: '${p.name} 副本',
        baseUrl: p.baseUrl,
        apiKey: '',
        model: p.model,
        voice: p.voice,
        contextWindow: p.contextWindow,
      ));
    _setLocal(service, list);
    await _saveGroup(service);
  }

  Future<void> _edit(String service, [ModelProfile? initial]) async {
    final ModelProfile? result = await _showEditor(service, initial);
    if (result == null || !mounted) return;
    final List<ModelProfile> list = List<ModelProfile>.of(
      _profiles[service] ?? const <ModelProfile>[],
    );
    final int idx = list.indexWhere((ModelProfile x) => x.id == result.id);
    if (initial == null || result.id.isEmpty) {
      list.add(result);
    } else if (idx >= 0) {
      list[idx] = result;
    } else {
      list.add(result);
    }
    _setLocal(service, list);
    await _saveGroup(service);
  }

  Future<ModelProfile?> _showEditor(
    String service,
    ModelProfile? initial,
  ) async {
    final AppState state = AppScope.read(context);
    final TextEditingController name =
        TextEditingController(text: initial?.name ?? '');
    final TextEditingController baseUrl =
        TextEditingController(text: initial?.baseUrl ?? '');
    final TextEditingController apiKey = TextEditingController();
    final TextEditingController model =
        TextEditingController(text: initial?.model ?? '');
    final TextEditingController voice =
        TextEditingController(text: initial?.voice ?? '');
    final TextEditingController size = TextEditingController(
      text: asString(initial?.extra['size'], '1024x1024'),
    );
    final TextEditingController style =
        TextEditingController(text: asString(initial?.extra['style']));
    final TextEditingController contextCtrl = TextEditingController(
      text: (initial?.contextWindow ?? 0) > 0
          ? '${initial!.contextWindow}'
          : '',
    );
    bool clearKey = false;
    bool busy = false;
    String status = '';

    Future<ModelListResult?> fetchModels(StateSetter setSt) async {
      setSt(() => busy = true);
      try {
        final ModelListResult res =
            await state.configService.listProfileModels(
          service: service,
          profileId: initial?.id.isNotEmpty == true ? initial!.id : null,
          baseUrl: initial?.id.isNotEmpty == true ? null : baseUrl.text.trim(),
          apiKey: initial?.id.isNotEmpty == true
              ? null
              : (apiKey.text.trim().isEmpty ? null : apiKey.text.trim()),
          model: model.text.trim(),
        );
        return res;
      } catch (e) {
        setSt(() => status = '获取模型失败：$e');
        return null;
      } finally {
        setSt(() => busy = false);
      }
    }

    Future<void> pickModel(StateSetter setSt) async {
      final ModelListResult? res = await fetchModels(setSt);
      if (res == null) return;
      if (res.models.isEmpty) {
        setSt(() => status = res.warning.isEmpty ? '没有获取到模型' : res.warning);
        return;
      }
      final ModelInfo? picked = await showModalBottomSheet<ModelInfo>(
        context: context,
        builder: (BuildContext ctx) => SafeArea(
          child: ListView(
            shrinkWrap: true,
            children: res.models
                .map(
                  (ModelInfo m) => ListTile(
                    title: Text(m.id, style: const TextStyle(fontSize: 13)),
                    subtitle: Text(
                      m.contextWindow > 0 ? '上下文 ${m.contextWindow}' : '上下文未知',
                      style: const TextStyle(fontSize: 10.5),
                    ),
                    onTap: () => Navigator.of(ctx).pop(m),
                  ),
                )
                .toList(),
          ),
        ),
      );
      if (picked == null) return;
      model.text = picked.id;
      if (picked.contextWindow > 0) {
        contextCtrl.text = '${picked.contextWindow}';
      }
      setSt(() {});
      // 已保存配置：模型列表返回的 contextWindow 立即写回该条配置并保存。
      if (initial?.id.isNotEmpty == true && picked.contextWindow > 0) {
        final ModelProfile updated = initial!.copyWith(
          model: picked.id,
          contextWindow: picked.contextWindow,
        );
        final List<ModelProfile> list = List<ModelProfile>.of(
          _profiles[service] ?? const <ModelProfile>[],
        );
        final int idx = list.indexWhere((ModelProfile x) => x.id == updated.id);
        if (idx >= 0) {
          list[idx] = updated;
          _setLocal(service, list);
          await _saveGroup(service);
        }
      }
    }

    Future<void> test(StateSetter setSt) async {
      setSt(() => busy = true);
      final Map<String, dynamic> r =
          await state.configService.testProfileConfig(
        service: service,
        profileId: initial?.id.isNotEmpty == true ? initial!.id : null,
        baseUrl: initial?.id.isNotEmpty == true ? null : baseUrl.text.trim(),
        apiKey: initial?.id.isNotEmpty == true
            ? null
            : (apiKey.text.trim().isEmpty ? null : apiKey.text.trim()),
        model: model.text.trim(),
      );
      setSt(() {
        busy = false;
        final bool ok = asBool(r['ok']);
        status = ok
            ? '连接成功${asInt(r['latencyMs']) > 0 ? ' · ${asInt(r['latencyMs'])}ms' : ''}'
            : '连接失败：${asString(r['detail'], '未知错误')}';
      });
    }

    final ModelProfile? result = await showDialog<ModelProfile>(
      context: context,
      builder: (BuildContext ctx) => StatefulBuilder(
        builder: (BuildContext ctx, StateSetter setSt) => AlertDialog(
          title: Text(initial == null ? '新建${_label(service)}' : '编辑配置'),
          content: SizedBox(
            width: 520,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  TextField(
                    controller: name,
                    decoration: const InputDecoration(labelText: '配置名称'),
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
                    enabled: !clearKey,
                    decoration: InputDecoration(
                      labelText: 'API Key',
                      hintText: (initial?.apiKeySet ?? false)
                          ? '已设置，留空保持'
                          : 'sk-...',
                    ),
                  ),
                  Row(
                    children: <Widget>[
                      TextButton(
                        onPressed: () => setSt(() => clearKey = !clearKey),
                        style: TextButton.styleFrom(
                          minimumSize: const Size(0, 28),
                          textStyle: const TextStyle(fontSize: 10.5),
                        ),
                        child: Text(clearKey ? '取消清空' : '清空已保存密钥'),
                      ),
                      if (clearKey)
                        const Text(
                          '保存后将清空密钥',
                          style: TextStyle(fontSize: 10, color: AppColors.danger),
                        ),
                    ],
                  ),
                  Row(
                    children: <Widget>[
                      Expanded(
                        child: TextField(
                          controller: model,
                          decoration: const InputDecoration(labelText: '模型名'),
                        ),
                      ),
                      const SizedBox(width: 8),
                      OutlinedButton(
                        onPressed: busy ? null : () => pickModel(setSt),
                        style: OutlinedButton.styleFrom(
                          minimumSize: const Size(0, 42),
                          padding: const EdgeInsets.symmetric(horizontal: 10),
                          textStyle: const TextStyle(fontSize: 11),
                        ),
                        child: const Text('获取模型列表'),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  TextField(
                    controller: contextCtrl,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(
                      labelText: '上下文窗口（token，模型列表自动写入）',
                    ),
                  ),
                  if (service == 'tts')
                    Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: TextField(
                        controller: voice,
                        decoration: const InputDecoration(labelText: '音色 voice'),
                      ),
                    ),
                  if (service == 'image') ...<Widget>[
                    const SizedBox(height: 8),
                    TextField(
                      controller: size,
                      decoration: const InputDecoration(
                        labelText: '尺寸 size',
                        hintText: '1024x1024',
                      ),
                    ),
                    const SizedBox(height: 8),
                    TextField(
                      controller: style,
                      decoration: const InputDecoration(
                        labelText: '风格 style（可选）',
                      ),
                    ),
                  ],
                  if (status.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Text(
                        status,
                        style: const TextStyle(
                          fontSize: 10.5,
                          color: AppColors.cocoa,
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
          actions: <Widget>[
            TextButton(
              onPressed: busy ? null : () => test(setSt),
              child: const Text('测试连接'),
            ),
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: busy
                  ? null
                  : () {
                      if (name.text.trim().isEmpty ||
                          baseUrl.text.trim().isEmpty ||
                          model.text.trim().isEmpty) {
                        setSt(() => status = '请填写名称、BaseURL 与模型名');
                        return;
                      }
                      final String typedKey = apiKey.text.trim();
                      Navigator.of(ctx).pop(ModelProfile(
                        id: initial?.id ?? '',
                        name: name.text.trim(),
                        baseUrl: baseUrl.text.trim(),
                        apiKey: clearKey
                            ? ''
                            : (typedKey.isNotEmpty
                                ? typedKey
                                : ((initial?.apiKeySet ?? false) ? '****' : '')),
                        apiKeySet: !clearKey &&
                            (typedKey.isNotEmpty || (initial?.apiKeySet ?? false)),
                        model: model.text.trim(),
                        voice: voice.text.trim(),
                        contextWindow: int.tryParse(contextCtrl.text.trim()) ?? 0,
                        ready: initial?.ready ?? false,
                        extra: service == 'image'
                            ? <String, dynamic>{
                                'size': size.text.trim().isEmpty
                                    ? '1024x1024'
                                    : size.text.trim(),
                                if (style.text.trim().isNotEmpty)
                                  'style': style.text.trim(),
                              }
                            : (initial?.extra ?? const <String, dynamic>{}),
                      ));
                    },
              child: const Text('保存'),
            ),
          ],
        ),
      ),
    );
    name.dispose();
    baseUrl.dispose();
    apiKey.dispose();
    model.dispose();
    voice.dispose();
    size.dispose();
    style.dispose();
    contextCtrl.dispose();
    return result;
  }

  Widget _sourceCard(AppState state) {
    final SystemModels sys = state.config?.systemModels ?? const SystemModels();
    return SectionCard(
      title: '模型来源',
      trailing: TextButton(
        onPressed: _saving ? null : _saveSource,
        style: TextButton.styleFrom(
          minimumSize: const Size(0, 28),
          textStyle: const TextStyle(fontSize: 11),
        ),
        child: const Text('保存来源'),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          if (sys.enabled)
            SegmentedButton<String>(
              segments: const <ButtonSegment<String>>[
                ButtonSegment<String>(value: 'own', label: Text('使用自己的模型')),
                ButtonSegment<String>(value: 'system', label: Text('使用系统模型')),
              ],
              selected: <String>{_modelSource},
              onSelectionChanged: (Set<String> v) =>
                  setState(() => _modelSource = v.first),
            ),
          if (sys.enabled && _modelSource == 'system') ...<Widget>[
            const SizedBox(height: 6),
            Wrap(
              spacing: 6,
              children: sys.providers
                  .map(
                    (ProviderConfig p) => ChoiceChip(
                      label: Text(
                        '${p.name} · ${p.servicesLabel}',
                        style: const TextStyle(fontSize: 10.5),
                      ),
                      selected: _systemProviderId == p.id,
                      onSelected: (_) =>
                          setState(() => _systemProviderId = p.id),
                    ),
                  )
                  .toList(),
            ),
          ],
          const SizedBox(height: 4),
          const Text(
            '服务之间互不影响；切换某个服务的当前配置只更新该服务的 active。',
            style: TextStyle(fontSize: 10, color: AppColors.inkSoft),
          ),
        ],
      ),
    );
  }

  Future<void> _publish(String service, ModelProfile p) async {
    final AppState state = AppScope.read(context);
    if (_active[service] != p.id) {
      await _setActive(service, p.id);
    }
    final Map<String, dynamic>? form = await showPlazaPublishDialog(
      context,
      kind: 'model',
      title: p.name,
    );
    if (form == null) return;
    try {
      await state.plazaService.publish(<String, dynamic>{
        'kind': 'model',
        'services': <String>[service],
        ...form,
      }, global: false);
      if (mounted) showToast('模型使用权已发布到本服广场');
    } catch (e) {
      showToast('发布失败：$e', isError: true);
    }
  }

  Widget _profileCard(String service, ModelProfile p) {
    final ProviderMeta? meta =
        AppScope.read(context).config?.providerMeta[service];
    final bool active = _active[service] == p.id;
    final bool shared = meta?.source == 'shared' && active;
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.fromLTRB(10, 6, 6, 6),
      decoration: BoxDecoration(
        color: active ? AppColors.cocoa.withAlpha(12) : AppColors.cream,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: active ? AppColors.cocoa.withAlpha(130) : AppColors.sand,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              IconButton(
                tooltip: active ? '当前生效' : '设为当前生效',
                icon: Icon(
                  active
                      ? Icons.radio_button_checked
                      : Icons.radio_button_unchecked,
                  size: 18,
                  color: active ? AppColors.cocoa : AppColors.inkSoft,
                ),
                onPressed: p.id.isEmpty ? null : () => _setActive(service, p.id),
              ),
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
                      '${p.model}${p.contextWindow > 0 ? ' · ${p.contextWindow} token' : ''}',
                      style: const TextStyle(fontSize: 10.5),
                    ),
                    Text(
                      '${p.baseUrl} · 密钥${p.apiKeySet ? '已设置' : '未设置'}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 9.5,
                        color: AppColors.inkSoft,
                      ),
                    ),
                    if (shared)
                      Text(
                        '来自分享：${meta?.profileName ?? meta?.providerName ?? ''}',
                        style: const TextStyle(
                          fontSize: 9.5,
                          color: AppColors.rose,
                        ),
                      ),
                  ],
                ),
              ),
              if (p.ready)
                const Icon(Icons.check_circle, size: 14, color: AppColors.success),
            ],
          ),
          Row(
            children: <Widget>[
              TextButton(
                onPressed: () => _test(service, p),
                style: TextButton.styleFrom(
                  minimumSize: const Size(0, 28),
                  textStyle: const TextStyle(fontSize: 10.5),
                ),
                child: const Text('测试连接'),
              ),
              TextButton(
                onPressed: () => _publish(service, p),
                style: TextButton.styleFrom(
                  minimumSize: const Size(0, 28),
                  textStyle: const TextStyle(fontSize: 10.5),
                ),
                child: const Text('公开使用权'),
              ),
              const Spacer(),
              IconButton(
                visualDensity: VisualDensity.compact,
                icon: const Icon(Icons.copy_outlined, size: 15),
                onPressed: () => _copy(service, p),
              ),
              IconButton(
                visualDensity: VisualDensity.compact,
                icon: const Icon(Icons.edit_outlined, size: 16),
                onPressed: () => _edit(service, p),
              ),
              IconButton(
                visualDensity: VisualDensity.compact,
                icon: const Icon(Icons.delete_outline, size: 16),
                onPressed: () => _delete(service, p),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _groupCard(String service) {
    final List<ModelProfile> list =
        _profiles[service] ?? const <ModelProfile>[];
    return SectionCard(
      title: _label(service),
      trailing: IconButton(
        tooltip: '新建配置',
        icon: const Icon(Icons.add_circle_outline, size: 19),
        onPressed: () => _edit(service),
      ),
      child: list.isEmpty
          ? const Text(
              '暂无配置；点击右上角新建，每条配置独立保存地址、密钥、模型与上下文。',
              style: TextStyle(fontSize: 10.5, color: AppColors.inkSoft),
            )
          : Column(
              children: list
                  .map((ModelProfile p) => _profileCard(service, p))
                  .toList(),
            ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final AppState state = AppScope.of(context);
    if (_loading) {
      return Scaffold(
        appBar: AppBar(title: const Text('模型配置')),
        body: const Center(child: CircularProgressIndicator()),
      );
    }
    return Scaffold(
      appBar: AppBar(title: const Text('模型配置')),
      body: ListView(
        padding: pagePadding(context),
        children: <Widget>[
          _sourceCard(state),
          ..._services.map(_groupCard),
          if (_services.contains('tts') || _services.contains('stt'))
            SectionCard(
              title: '语音测试',
              child: Column(
                children: const <Widget>[
                  VoiceTestPanel(service: 'tts'),
                  VoiceTestPanel(service: 'stt'),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
