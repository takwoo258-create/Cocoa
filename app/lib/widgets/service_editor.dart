import 'package:flutter/material.dart';

import '../core/app_state.dart';
import '../core/global.dart';
import '../core/theme.dart';
import '../models/config_models.dart';
import 'capability_icons.dart';

/// 单个服务的配置编辑器：地址 / 密钥 / 模型 / 测试连接 / 模型列表（带能力图标）。
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
  bool _obscureKey = true;
  bool _busy = false;
  bool _clearKey = false;
  String? _status;
  bool _statusOk = false;
  List<ModelInfo> _models = <ModelInfo>[];
  ModelInfo? _info;

  @override
  void initState() {
    super.initState();
    final ServiceConfig c =
        widget.state.config?.service(widget.service) ?? ServiceConfig.empty;
    _baseCtrl = TextEditingController(text: c.baseUrl);
    _keyCtrl = TextEditingController();
    _modelCtrl = TextEditingController(text: c.model);
    _voiceCtrl = TextEditingController(text: c.voice);
    if (_baseCtrl.text.isEmpty && widget.defaultBaseUrl.isNotEmpty) {
      _baseCtrl.text = widget.defaultBaseUrl;
    }
    WidgetsBinding.instance.addPostFrameCallback((_) => _loadModelInfo());
  }

  /// 当前模型能力（SVG 图标：文本/图片/语音 + 上下文窗口）。
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

  @override
  void dispose() {
    _baseCtrl.dispose();
    _keyCtrl.dispose();
    _modelCtrl.dispose();
    _voiceCtrl.dispose();
    super.dispose();
  }

  void _setStatus(String text, bool ok) {
    if (!mounted) return;
    setState(() {
      _status = text;
      _statusOk = ok;
    });
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

  Future<void> _loadModels() async {
    final bool ok = await save(silent: true);
    if (!ok) return;
    if (mounted) setState(() => _busy = true);
    try {
      final ModelListResult r =
          await widget.state.configService.listModels(widget.service);
      setState(() => _models = r.models);
      if (!mounted) return;
      if (_models.isEmpty) {
        _setStatus('未获取到模型列表，可直接手填模型名', false);
        return;
      }
      final ModelInfo? picked = await showModalBottomSheet<ModelInfo>(
        context: context,
        isScrollControlled: true,
        backgroundColor: AppColors.cream,
        builder: (BuildContext ctx) => _ModelSheet(
          models: _models,
          current: _modelCtrl.text.trim(),
          source: r.source,
        ),
      );
      if (picked != null) {
        _modelCtrl.text = picked.id;
        setState(() => _info = picked);
        await save();
        _setStatus('已选择 ${picked.id}', true);
      }
    } catch (e) {
      _setStatus('获取模型列表失败：$e', false);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
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
              ? TextButton(
                  onPressed: () {
                    _keyCtrl.clear();
                    setState(() => _clearKey = true);
                    showToast('保存后将清除已保存的密钥');
                  },
                  style: TextButton.styleFrom(
                    padding: EdgeInsets.zero,
                    minimumSize: const Size(0, 20),
                    textStyle: const TextStyle(fontSize: 11),
                  ),
                  child: const Text('清除密钥'),
                )
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
          onSubmitted: (String v) => _loadModelInfo(id: v),
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
                Text(
                  _info!.contextLabel,
                  style: const TextStyle(
                    fontSize: 10.5,
                    color: AppColors.inkSoft,
                  ),
                ),
              ],
            ),
          ),
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
                    color: _statusOk ? AppColors.success : AppColors.danger,
                  ),
                ),
              ),
            ],
          ),
        ],
      ],
    );
  }
}

class _ModelSheet extends StatefulWidget {
  const _ModelSheet({
    required this.models,
    required this.current,
    required this.source,
  });

  final List<ModelInfo> models;
  final String current;
  final String source;

  @override
  State<_ModelSheet> createState() => _ModelSheetState();
}

class _ModelSheetState extends State<_ModelSheet> {
  String _query = '';

  @override
  Widget build(BuildContext context) {
    final List<ModelInfo> filtered = widget.models
        .where((ModelInfo m) =>
            _query.isEmpty || m.id.toLowerCase().contains(_query.toLowerCase()))
        .toList();
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 8),
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
                  '共 ${widget.models.length} 个',
                  style: const TextStyle(fontSize: 11, color: AppColors.inkSoft),
                ),
                const Spacer(),
                IconButton(
                  onPressed: () => Navigator.of(context).pop(),
                  icon: const Icon(Icons.close, size: 18),
                ),
              ],
            ),
            TextField(
              onChanged: (String v) => setState(() => _query = v),
              decoration: const InputDecoration(
                hintText: '按名称筛选',
                isDense: true,
                prefixIcon: Icon(Icons.search, size: 18),
              ),
            ),
            const SizedBox(height: 8),
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
                    trailing: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: <Widget>[
                        Text(
                          m.contextLabel,
                          style: const TextStyle(
                            fontSize: 10,
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
                    onTap: () => Navigator.of(context).pop(m),
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}
