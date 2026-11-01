import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/app_state.dart';
import '../../core/global.dart';
import '../../core/theme.dart';
import '../../widgets/common.dart';

/// Token 限额二级页：总开关 + 硬/软限额（v1.0.1）。
class LimitsPage extends StatefulWidget {
  const LimitsPage({super.key});

  @override
  State<LimitsPage> createState() => _LimitsPageState();
}

class _LimitsPageState extends State<LimitsPage> {
  final TextEditingController _hard = TextEditingController();
  final TextEditingController _soft = TextEditingController();
  bool _enabled = true;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final AppState state = AppScope.read(context);
      _enabled = state.limitsEnabled;
      _hard.text = state.hardTokens == 0 ? '' : '${state.hardTokens}';
      _soft.text = state.softTokens == 0 ? '' : '${state.softTokens}';
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _hard.dispose();
    _soft.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final AppState state = AppScope.read(context);
    final int hard = int.tryParse(_hard.text.trim()) ?? 0;
    final int soft = int.tryParse(_soft.text.trim()) ?? 0;
    setState(() => _saving = true);
    await state.savePreferences(<String, dynamic>{
      'limits': <String, dynamic>{
        'enabled': _enabled,
        'hardTokens': hard,
        'softTokens': soft,
      },
    });
    if (mounted) {
      setState(() => _saving = false);
      showToast(_enabled ? '限额已保存' : '限额已关闭');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Token 限额'),
        actions: <Widget>[
          TextButton(
            onPressed: _saving ? null : _save,
            child: _saving
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Text('保存'),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.only(bottom: 24),
        children: <Widget>[
          SectionCard(
            title: '限额总开关',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  dense: true,
                  title: const Text(
                    '启用 Token 限额',
                    style: TextStyle(fontSize: 13),
                  ),
                  subtitle: const Text(
                    '关闭后不执行硬限额与软限额检查，角色服务保持正常。',
                    style: TextStyle(fontSize: 10.5, color: AppColors.inkSoft),
                  ),
                  value: _enabled,
                  onChanged: (bool v) => setState(() => _enabled = v),
                ),
              ],
            ),
          ),
          SectionCard(
            title: '限额阈值',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    Expanded(
                      child: TextField(
                        controller: _hard,
                        enabled: _enabled,
                        keyboardType: TextInputType.number,
                        inputFormatters: <TextInputFormatter>[
                          FilteringTextInputFormatter.digitsOnly,
                        ],
                        decoration: const InputDecoration(
                          labelText: '硬限额',
                          hintText: '0 = 不限制',
                        ),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: TextField(
                        controller: _soft,
                        enabled: _enabled,
                        keyboardType: TextInputType.number,
                        inputFormatters: <TextInputFormatter>[
                          FilteringTextInputFormatter.digitsOnly,
                        ],
                        decoration: const InputDecoration(
                          labelText: '软限额',
                          hintText: '0 = 不限制',
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Text(
                  _enabled
                      ? '硬限额：达到后停止主会话与全部角色服务；软限额：停止创作与新闻阅读，仅保留会话与四小时一次状态更新。'
                      : '限额已关闭，以下输入不可编辑；开启后才会生效。',
                  style: const TextStyle(
                    fontSize: 10.5,
                    color: AppColors.inkSoft,
                    height: 1.5,
                  ),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 0),
            child: SizedBox(
              height: 46,
              child: FilledButton(
                onPressed: _saving ? null : _save,
                child: const Text('保存限额设置'),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
