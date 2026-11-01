import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/app_state.dart';
import '../core/global.dart';
import '../core/json_utils.dart';
import '../core/theme.dart';
import '../models/config_models.dart';
import 'capability_icons.dart';

/// 单个服务的配置编辑器：地址 / 密钥 / 模型 / 测试连接 / 模型列表（带能力图标）。
/// v1.0.1：获取模型列表前强制保存；远端失败时展示 warning/attempts/重试/手动模型名；
/// 支持手动上下文长度覆盖（preferences.contextLimits）。
class ServiceEditor extends StatefulWidget {
  const ServiceEditor({
    super.key,
    required this.state,
    required this.service,
    this.onSaved,
    this.showVoice = false,
    this.dense = false,
    this.defaultBaseUrl = '',
  });

  final AppState state;
  final String service;
  final VoidCallback? onSaved;
  final bool showVoice;
  final bool dense;
  final String defaultBaseUrl;

  @override
  ServiceEditorState createState() => ServiceEditorState();
}

class ServiceEditorState extends State<ServiceEditor> {
  late final TextEditingController _baseCtrl;
  late final TextEditingController _keyCtrl;
  late final TextEditingController _modelCtrl;
  late final TextEditingController _voiceCtrl;
  late final TextEditingController _ctxCtrl;
  bool _obscureKey = true;
  bool _busy = false;
  bool _clearKey = false;
  String? _status;
  bool _statusOk = false;
  List<ModelInfo> _models = <ModelInfo>[];
  ModelInfo? _info;
  String _listWarning = '';

  @override
  void initState() {
    super.initState();
    final ServiceConfig c =
        widget.state.config?.service(widget.service) ?? ServiceConfig.empty;
    _baseCtrl = TextEditingController(text: c.baseUrl);
    _keyCtrl = TextEditingController();
    _modelCtrl = TextEditingController(text: c.model);
    _voiceCtrl = TextEditingController(text: c.voice);
    _ctxCtrl = TextEditingController();
    if (_baseCtrl.text.isEmpty && widget.defaultBaseUrl.isNotEmpty) {
      _baseCtrl.text = widget.defaultBaseUrl;
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _loadModelInfo();
      _loadContextLimit();
    });
  }

  @override
  void dispose() {
    _baseCtrl.dispose();
    _keyCtrl.dispose();
    _modelCtrl.dispose();
    _voiceCtrl.dispose();
    _ctxCtrl.dispose();
    super.dispose();
  }

  bool get _contextEditable =>
      widget.service == 'chat' || widget.service == 'embedding';

  void _setStatus(String text, bool ok) {
    if (!mounted) return;
    setState(() {
      _status = text;
      _statusOk = ok;
    });
  }

  /// 当前模型能力（SVG 图标：文本/图片/语音 + 上下文窗口 + 来源）。
  Future<void> _loadModelInfo({String? id}) async {
    final String modelId = (id ?? _modelCtrl.text).trim();
    if (modelId.isEmpty) {
      if (mounted) setState(() => _info = null);
      return;
    }
    try {
      final ModelInfo? info =
          await widget.state.configService.modelInfo(id: modelId);
      if (mounted) setState(() => _info = info);
    } catch (_) {
      // 能力信息不可用时静默降级
    }
  }

  void _loadContextLimit() {
    final Map<String, dynamic> limits =
        asMap(widget.state.preferences['contextLimits']);
    final String model = _modelCtrl.text.trim();
    final dynamic value =
        model.isNotEmpty ? limits[model] : limits['default'];
    _ctxCtrl.text = value == null ? '' : value.toString();
  }

  /// 模型列表行内编辑：保存指定模型的上下文覆盖（value=null 表示清除）。
  Future<void> _saveContextForModel(String model, int? value) async {
    final Map<String, dynamic> limits = Map<String, dynamic>.from(
      asMap(widget.state.preferences['contextLimits']),
    );
    limits[model] = value;
    await widget.state.savePreferences(<String, dynamic>{
      'contextLimits': limits,
    });
    if (mounted) {
      _setStatus(
        value == null ? '$model 已恢复模型窗口' : '$model 上下文已设为 $value',
        true,
      );
    }
    if (_modelCtrl.text.trim() == model) {
      _loadContextLimit();
      await _loadModelInfo(id: model);
    }
  }

  Future<void> _saveContextLimit({required bool asDefault}) async {
    final int? value = int.tryParse(_ctxCtrl.text.trim());
    if (value == null || value <= 0) {
      _setStatus('请输入大于 0 的上下文长度', false);
      return;
    }
    final String model = _modelCtrl.text.trim();
    if (!asDefault && model.isEmpty) {
      _setStatus('请先选择或填写模型名', false);
      return;
    }
    final Map<String, dynamic> limits = Map<String, dynamic>.from(
      asMap(widget.state.preferences['contextLimits']),
    );
    if (asDefault) {
      limits['default'] = value;
    } else {
      limits[model] = value;
    }
    await widget.state.savePreferences(<String, dynamic>{
      'contextLimits': limits,
    });
    await _loadModelInfo();
    if (mounted) {
      _setStatus(
        asDefault ? '默认上下文已设为 $value' : '$model 上下文已设为 $value',
        true,
      );
    }
  }

  Future<void> _clearContextLimit({required bool asDefault}) async {
    final String model = _modelCtrl.text.trim();
    final Map<String, dynamic> limits = Map<String, dynamic>.from(
      asMap(widget.state.preferences['contextLimits']),
    );
    // 后端 preferences 为深合并：用 null 覆盖才能删除已有覆盖值
    if (asDefault) {
      limits['default'] = null;
    } else if (model.isNotEmpty) {
      limits[model] = null;
    }
    await widget.state.savePreferences(<String, dynamic>{
      'contextLimits': limits,
    });
    _ctxCtrl.clear();
    await _loadModelInfo();
    if (mounted) _setStatus('已清除上下文覆盖', true);
  }

  Future<bool> save({bool silent = false}) async {
    final String base = _baseCtrl.text.trim();
    if (base.isEmpty) {
      _setStatus('请填写服务地址', false);
      return false;
    }
    final String key = _keyCtrl.text.trim();
    final Map<String, dynamic> payload = <String, dynamic>{
      'baseUrl': base,
      'model': _modelCtrl.text.trim(),
      'apiKey': _clearKey ? '' : (key.isEmpty ? '****' : key),
      if (widget.showVoice) 'voice': _voiceCtrl.text.trim(),
    };
    if (mounted) setState(() => _busy = true);
    try {
      await widget.state.configService
          .saveApi(<String, dynamic>{widget.service: payload});
      await widget.state.refreshConfig(notify: false);
      _keyCtrl.clear();
      _clearKey = false;
      if (!silent) _setStatus('已保存', true);
      widget.onSaved?.call();
      _loadModelInfo();
      return true;
    } catch (e) {
      _setStatus('保存失败：$e', false);
      return false;
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<TestConnectionResult?> _test() async {
    final bool ok = await save(silent: true);
    if (!ok) return null;
    if (mounted) setState(() => _busy = true);
    try {
      final TestConnectionResult r =
          await widget.state.configService.testConnection(widget.service);
      _setStatus(
        r.ok
            ? '连接成功 · ${r.latencyMs}ms'
            : '连接失败${r.detailText.isEmpty ? '' : '：${r.detailText}'}',
        r.ok,
      );
      return r;
    } catch (e) {
      _setStatus('连接失败：$e', false);
      return null;
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// v1.0.1 关键修复：后端只读已保存配置，必须先 PUT 当前 baseUrl/apiKey/model 再取列表。
  Future<void> _loadModels() async {
    if (mounted) setState(() => _busy = true);
    try {
      final bool saved = await save(silent: true);
      if (!saved) {
        _setStatus('保存当前配置失败，无法获取模型列表', false);
        return;
      }
      final ModelListResult r =
          await widget.state.configService.listModels(widget.service);
      if (!mounted) return;
      setState(() {
        _models = r.models;
        _listWarning = r.warning;
      });

      final String sheetWarning = r.isFallback
          ? (r.warning.isEmpty
              ? '远端 /models 未返回结果，以下为后端内置候选模型'
              : r.warning)
          : '';

      bool pickedSomething = false;
      while (mounted) {
        final String? action = await showModalBottomSheet<String>(
          context: context,
          isScrollControlled: true,
          backgroundColor: AppColors.cream,
          builder: (BuildContext ctx) => _ModelSheet(
            models: _models,
            current: _modelCtrl.text.trim(),
            source: r.source,
            warning: sheetWarning,
            attempts: r.attempts,
            contextLimits: asMap(widget.state.preferences['contextLimits']),
            onSaveContext: _saveContextForModel,
          ),
        );
        if (action == null) break;
        if (action == '__retry__') {
          await _loadModels();
          return;
        }
        if (action == '__manual__') {
          await _manualModelInput();
          break;
        }
        final ModelInfo picked = _models.firstWhere(
          (ModelInfo m) => m.id == action,
          orElse: () => ModelInfo(id: action),
        );
        _modelCtrl.text = picked.id;
        setState(() => _info = picked);
        await save(silent: true);
        _loadContextLimit();
        await _loadModelInfo(id: picked.id);
        if (mounted) _setStatus('已选择 ${picked.id}', true);
        pickedSomething = true;
        break;
      }
      if (_listWarning.isNotEmpty && !pickedSomething) {
        _setStatus(_listWarning, false);
      } else if (_models.isEmpty && !pickedSomething) {
        _setStatus('未获取到模型列表，可点击「手动输入模型名」', false);
      }
    } catch (e) {
      _setStatus('获取模型列表失败：$e', false);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _manualModelInput() async {
    final TextEditingController ctrl =
        TextEditingController(text: _modelCtrl.text.trim());
    final String? value = await showDialog<String>(
      context: context,
      builder: (BuildContext ctx) => AlertDialog(
        title: const Text('手动输入模型名'),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          decoration: const InputDecoration(
            hintText: '例如 gpt-4o-mini / deepseek-chat',
            helperText: '按网关或服务商实际模型 ID 填写',
          ),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(ctrl.text.trim()),
            child: const Text('使用'),
          ),
        ],
      ),
    );
    ctrl.dispose();
    if (value == null || value.isEmpty) return;
    _modelCtrl.text = value;
    setState(() => _info = null);
    await save(silent: true);
    _loadContextLimit();
    await _loadModelInfo(id: value);
    if (mounted) _setStatus('已使用模型 $value', true);
  }

  InputDecoration _dec(String hint) => InputDecoration(
        hintText: hint,
        isDense: true,
        hintStyle: const TextStyle(fontSize: 12, color: AppColors.inkSoft),
        contentPadding:
            const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
      );

  Widget _label(String text, {Widget? trailing}) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 4, top: 8),
      child: Row(
        children: <Widget>[
          Text(
            text,
            style: const TextStyle(
              fontSize: 11.5,
              fontWeight: FontWeight.w600,
              color: AppColors.inkSoft,
            ),
          ),
          const Spacer(),
          if (trailing != null) trailing,
        ],
      ),
    );
  }

  Widget _smallTextButton(String text, VoidCallback? onPressed) {
    return TextButton(
      onPressed: onPressed,
      style: TextButton.styleFrom(
        padding: EdgeInsets.zero,
        minimumSize: const Size(0, 22),
        textStyle: const TextStyle(fontSize: 11),
      ),
      child: Text(text),
    );
  }

  Widget _contextSection() {
    if (!_contextEditable) return const SizedBox.shrink();
    final String sourceLabel = _info == null
        ? ''
        : (_info!.contextSourceLabel.isEmpty
            ? ''
            : ' · 来源 ${_info!.contextSourceLabel}');
    final int? override = _info?.contextOverride;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        _label(
          '上下文长度（可选覆盖）',
          trailing: _smallTextButton('设为默认', () {
            _saveContextLimit(asDefault: true);
          }),
        ),
        Row(
          children: <Widget>[
            Expanded(
              child: TextField(
                controller: _ctxCtrl,
                keyboardType: TextInputType.number,
                inputFormatters: <TextInputFormatter>[
                  FilteringTextInputFormatter.digitsOnly,
                ],
                decoration: _dec('例如 128000，留空使用模型窗口'),
                style: const TextStyle(fontSize: 13),
              ),
            ),
            IconButton(
              tooltip: '保存为当前模型覆盖',
              icon: const Icon(Icons.check_circle_outline, size: 20),
              onPressed: () => _saveContextLimit(asDefault: false),
            ),
            IconButton(
              tooltip: '清除覆盖',
              icon: const Icon(Icons.restart_alt, size: 20),
              onPressed: () => _clearContextLimit(asDefault: false),
            ),
          ],
        ),
        Text(
          _info == null
              ? '模型窗口未知；可手动填写覆盖值。'
              : '模型窗口 ${_info!.contextLabel}$sourceLabel'
                  '${override != null && override > 0 ? ' · 已覆盖 $override' : ''}',
          style: const TextStyle(fontSize: 10.5, color: AppColors.inkSoft),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final ServiceConfig current =
        widget.state.config?.service(widget.service) ?? ServiceConfig.empty;
    final String keyHint = current.apiKeySet
        ? '已保存 ${current.apiKeyMasked}（留空保持不变）'
        : 'sk-... 或兼容网关令牌';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        _label('服务地址（OpenAI 兼容 baseUrl）'),
        TextField(
          controller: _baseCtrl,
          decoration: _dec('https://api.example.com/v1'),
          style: const TextStyle(fontSize: 13),
        ),
        _label(
          'API Key',
          trailing: current.apiKeySet
              ? _smallTextButton('清除密钥', () {
                  _keyCtrl.clear();
                  setState(() => _clearKey = true);
                  showToast('保存后将清除已保存的密钥');
                })
              : null,
        ),
        TextField(
          controller: _keyCtrl,
          obscureText: _obscureKey,
          decoration: _dec(keyHint).copyWith(
            suffixIcon: IconButton(
              icon: Icon(
                _obscureKey ? Icons.visibility_off : Icons.visibility,
                size: 18,
              ),
              onPressed: () => setState(() => _obscureKey = !_obscureKey),
            ),
          ),
          style: const TextStyle(fontSize: 13),
        ),
        _label('模型'),
        TextField(
          controller: _modelCtrl,
          decoration: _dec('例如 gpt-4o-mini / deepseek-chat'),
          style: const TextStyle(fontSize: 13),
          onSubmitted: (String v) {
            _loadModelInfo(id: v);
            _loadContextLimit();
          },
        ),
        if (_info != null)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Row(
              children: <Widget>[
                CapabilityIcons(
                  capabilities: ModelCapabilities.of(_info),
                  size: 15,
                  showLabels: true,
                ),
                const SizedBox(width: 10),
                Flexible(
                  child: Text(
                    '${_info!.contextLabel}'
                    '${_info!.contextSourceLabel.isEmpty ? '' : ' · ${_info!.contextSourceLabel}'}',
                    style: const TextStyle(
                      fontSize: 10.5,
                      color: AppColors.inkSoft,
                    ),
                  ),
                ),
              ],
            ),
          ),
        _contextSection(),
        if (widget.showVoice) ...<Widget>[
          _label('音色 voice（TTS）'),
          TextField(
            controller: _voiceCtrl,
            decoration: _dec('default'),
            style: const TextStyle(fontSize: 13),
          ),
        ],
        const SizedBox(height: 10),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: <Widget>[
            FilledButton(
              onPressed: _busy ? null : () => save(),
              style: FilledButton.styleFrom(
                minimumSize: const Size(0, 38),
                padding: const EdgeInsets.symmetric(horizontal: 14),
                textStyle: const TextStyle(fontSize: 12.5),
              ),
              child: const Text('保存'),
            ),
            OutlinedButton(
              onPressed: _busy ? null : _loadModels,
              style: OutlinedButton.styleFrom(
                minimumSize: const Size(0, 38),
                padding: const EdgeInsets.symmetric(horizontal: 14),
                textStyle: const TextStyle(fontSize: 12.5),
              ),
              child: const Text('获取模型列表'),
            ),
            OutlinedButton(
              onPressed: _busy ? null : _test,
              style: OutlinedButton.styleFrom(
                minimumSize: const Size(0, 38),
                padding: const EdgeInsets.symmetric(horizontal: 14),
                textStyle: const TextStyle(fontSize: 12.5),
              ),
              child: const Text('测试连接'),
            ),
            if (_busy)
              const SizedBox(
                width: 16,
                height: 16,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
          ],
        ),
        if (_status != null) ...<Widget>[
          const SizedBox(height: 8),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Icon(
                _statusOk ? Icons.check_circle_outline : Icons.error_outline,
                size: 14,
                color: _statusOk ? AppColors.success : AppColors.danger,
              ),
              const SizedBox(width: 4),
              Expanded(
                child: Text(
                  _status!,
                  style: TextStyle(
                    fontSize: 11.5,
                    height: 1.4,
                    color: _statusOk ? AppColors.success : AppColors.danger,
                  ),
                ),
              ),
            ],
          ),
        ],
        if (_listWarning.isNotEmpty) ...<Widget>[
          const SizedBox(height: 6),
          Text(
            '提示：$_listWarning',
            style: const TextStyle(fontSize: 10.5, color: AppColors.warn),
          ),
        ],
        if (widget.service == 'deepseek')
          const Padding(
            padding: EdgeInsets.only(top: 6),
            child: Text(
              '搜索 / 网页抓取复用该 DeepSeek 配置，无需单独设置 search 服务。',
              style: TextStyle(fontSize: 10.5, color: AppColors.inkSoft),
            ),
          ),
      ],
    );
  }
}

/// 模型选择面板：warning / attempts / 手动输入 / 重试 / 上下文来源。
class _ModelSheet extends StatefulWidget {
  const _ModelSheet({
    required this.models,
    required this.current,
    required this.source,
    required this.warning,
    required this.attempts,
    required this.contextLimits,
    required this.onSaveContext,
  });

  final List<ModelInfo> models;
  final String current;
  final String source;
  final String warning;
  final List<Map<String, dynamic>> attempts;
  final Map<String, dynamic> contextLimits;
  final Future<void> Function(String model, int? value) onSaveContext;

  @override
  State<_ModelSheet> createState() => _ModelSheetState();
}

class _ModelSheetState extends State<_ModelSheet> {
  String _query = '';
  bool _showAttempts = false;
  late final Map<String, dynamic> _limits =
      Map<String, dynamic>.from(widget.contextLimits);

  String _effectiveContext(ModelInfo m) {
    final dynamic override = _limits[m.id];
    if (override != null) return '${asInt(override)}';
    return m.contextWindow > 0 ? '${m.contextWindow}' : '未知';
  }

  bool _hasOverride(ModelInfo m) => _limits[m.id] != null;

  Future<void> _editContext(ModelInfo m) async {
    final TextEditingController ctrl = TextEditingController(
      text: _hasOverride(m) ? '${asInt(_limits[m.id])}' : '',
    );
    final String? value = await showDialog<String>(
      context: context,
      builder: (BuildContext ctx) => AlertDialog(
        title: Text('上下文长度 · ${m.id}'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            const Text(
              '留空并点「清除覆盖」可恢复模型默认窗口；保存后写入 preferences.contextLimits。',
              style: TextStyle(fontSize: 11, color: AppColors.inkSoft, height: 1.5),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: ctrl,
              autofocus: true,
              keyboardType: TextInputType.number,
              inputFormatters: <TextInputFormatter>[
                FilteringTextInputFormatter.digitsOnly,
              ],
              decoration: InputDecoration(
                labelText: 'Token 数',
                hintText: m.contextWindow > 0
                    ? '模型窗口 ${m.contextWindow}'
                    : '例如 128000',
              ),
            ),
          ],
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(ctx).pop('__clear__'),
            child: const Text('清除覆盖'),
          ),
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
    if (value == null || !mounted) return;
    if (value == '__clear__') {
      await widget.onSaveContext(m.id, null);
      setState(() => _limits.remove(m.id));
      return;
    }
    final int? parsed = int.tryParse(value);
    if (parsed == null || parsed <= 0) {
      if (mounted) showToast('请输入大于 0 的上下文长度');
      return;
    }
    await widget.onSaveContext(m.id, parsed);
    setState(() => _limits[m.id] = parsed);
  }

  String _attemptText(Map<String, dynamic> a) {
    final String url = asString(a['url']);
    final String error = asString(a['error']);
    final dynamic status = a['status'];
    return status == null
        ? '$url${error.isEmpty ? '' : ' · $error'}'
        : '$url · HTTP $status';
  }

  @override
  Widget build(BuildContext context) {
    final List<ModelInfo> filtered = widget.models
        .where((ModelInfo m) =>
            _query.isEmpty || m.id.toLowerCase().contains(_query.toLowerCase()))
        .toList();
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 10),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Row(
              children: <Widget>[
                const Text(
                  '选择模型',
                  style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
                ),
                const SizedBox(width: 8),
                Text(
                  '共 ${widget.models.length} 个 · 来源 ${widget.source}',
                  style: const TextStyle(fontSize: 11, color: AppColors.inkSoft),
                ),
                const Spacer(),
                IconButton(
                  onPressed: () => Navigator.of(context).pop(),
                  icon: const Icon(Icons.close, size: 18),
                ),
              ],
            ),
            if (widget.warning.isNotEmpty)
              Container(
                width: double.infinity,
                margin: const EdgeInsets.only(bottom: 8),
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: AppColors.warn.withAlpha(24),
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: AppColors.warn.withAlpha(110)),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Row(
                      children: <Widget>[
                        const Icon(Icons.warning_amber_rounded,
                            size: 15, color: AppColors.warn),
                        const SizedBox(width: 6),
                        const Expanded(
                          child: Text(
                            '未能从远端获取模型列表',
                            style: TextStyle(
                              fontSize: 11.5,
                              fontWeight: FontWeight.w600,
                              color: AppColors.warn,
                            ),
                          ),
                        ),
                        if (widget.attempts.isNotEmpty)
                          TextButton(
                            onPressed: () => setState(
                                () => _showAttempts = !_showAttempts),
                            style: TextButton.styleFrom(
                              minimumSize: const Size(0, 24),
                              padding: const EdgeInsets.symmetric(horizontal: 6),
                              textStyle: const TextStyle(fontSize: 10.5),
                            ),
                            child: Text(_showAttempts ? '收起' : '查看尝试'),
                          ),
                      ],
                    ),
                    const SizedBox(height: 2),
                    Text(
                      widget.warning,
                      style: const TextStyle(
                        fontSize: 10.5,
                        height: 1.4,
                        color: AppColors.inkSoft,
                      ),
                    ),
                    if (_showAttempts)
                      Padding(
                        padding: const EdgeInsets.only(top: 4),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: widget.attempts
                              .map((Map<String, dynamic> a) => Text(
                                    '· ${_attemptText(a)}',
                                    style: const TextStyle(
                                      fontSize: 10,
                                      color: AppColors.inkSoft,
                                    ),
                                  ))
                              .toList(),
                        ),
                      ),
                  ],
                ),
              ),
            TextField(
              onChanged: (String v) => setState(() => _query = v),
              decoration: const InputDecoration(
                hintText: '按名称筛选',
                isDense: true,
                prefixIcon: Icon(Icons.search, size: 18),
              ),
            ),
            const SizedBox(height: 2),
            const Align(
              alignment: Alignment.centerLeft,
              child: Text(
                '点击右侧铅笔可直接修改该模型的上下文；点击行则选中模型。',
                style: TextStyle(fontSize: 10, color: AppColors.inkSoft),
              ),
            ),
            const SizedBox(height: 6),
            Flexible(
              child: ListView.separated(
                shrinkWrap: true,
                itemCount: filtered.length,
                separatorBuilder: (_, __) => const Divider(height: 1),
                itemBuilder: (BuildContext ctx, int i) {
                  final ModelInfo m = filtered[i];
                  final bool selected = m.id == widget.current;
                  return ListTile(
                    dense: true,
                    title: Text(
                      m.id,
                      style: TextStyle(
                        fontSize: 13,
                        fontWeight: selected ? FontWeight.w700 : FontWeight.w400,
                        color: selected ? AppColors.cocoa : AppColors.ink,
                      ),
                    ),
                    subtitle: Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: CapabilityBadge(model: m, dense: true),
                    ),
                    trailing: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: <Widget>[
                        Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: <Widget>[
                            Text(
                              '上下文 ${_effectiveContext(m)}'
                              '${_hasOverride(m) ? '（覆盖）' : ''}',
                              style: TextStyle(
                                fontSize: 10,
                                color: _hasOverride(m)
                                    ? AppColors.cocoa
                                    : AppColors.inkSoft,
                              ),
                            ),
                            if (m.contextSourceLabel.isNotEmpty ||
                                widget.source == 'remote')
                              Text(
                                m.contextSourceLabel.isNotEmpty
                                    ? m.contextSourceLabel
                                    : '远程',
                                style: const TextStyle(
                                  fontSize: 9,
                                  color: AppColors.inkSoft,
                                ),
                              ),
                            if (selected)
                              const Icon(
                                Icons.check_circle,
                                size: 15,
                                color: AppColors.cocoa,
                              ),
                          ],
                        ),
                        IconButton(
                          tooltip: '设置该模型上下文',
                          visualDensity: VisualDensity.compact,
                          icon: const Icon(Icons.edit_outlined, size: 17),
                          onPressed: () => _editContext(m),
                        ),
                      ],
                    ),
                    onTap: () => Navigator.of(context).pop(m.id),
                  );
                },
              ),
            ),
            const SizedBox(height: 6),
            Row(
              children: <Widget>[
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: () => Navigator.of(context).pop('__retry__'),
                    icon: const Icon(Icons.refresh, size: 15),
                    label: const Text(
                      '重试远端获取',
                      style: TextStyle(fontSize: 11.5),
                    ),
                    style: OutlinedButton.styleFrom(
                      minimumSize: const Size(0, 38),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: () => Navigator.of(context).pop('__manual__'),
                    icon: const Icon(Icons.edit_outlined, size: 15),
                    label: const Text(
                      '手动输入模型名',
                      style: TextStyle(fontSize: 11.5),
                    ),
                    style: OutlinedButton.styleFrom(
                      minimumSize: const Size(0, 38),
                    ),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
