import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/api_client.dart';
import '../core/app_state.dart';
import '../core/constants.dart';
import '../core/global.dart';
import '../core/json_utils.dart';
import '../core/theme.dart';
import '../core/utils.dart';
import '../models/character.dart';
import '../models/config_models.dart';
import '../models/user.dart';
import '../widgets/capability_icons.dart';
import '../widgets/common.dart';
import '../widgets/service_editor.dart';
import 'character_settings_page.dart';
import 'server_address_dialog.dart';

class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key});

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  final TextEditingController _username = TextEditingController();
  final TextEditingController _email = TextEditingController();
  final TextEditingController _qq = TextEditingController();
  final TextEditingController _oldPassword = TextEditingController();
  final TextEditingController _newPassword = TextEditingController();
  final TextEditingController _hard = TextEditingController();
  final TextEditingController _soft = TextEditingController();
  List<Character> _characters = <Character>[];
  bool _savingProfile = false;
  bool _initialized = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _init());
  }

  @override
  void dispose() {
    _username.dispose();
    _email.dispose();
    _qq.dispose();
    _oldPassword.dispose();
    _newPassword.dispose();
    _hard.dispose();
    _soft.dispose();
    super.dispose();
  }

  Future<void> _init() async {
    final AppState state = AppScope.read(context);
    _fillUser(state);
    try {
      _characters = await state.characterService.list();
    } catch (_) {
      _characters = <Character>[];
    }
    if (mounted) {
      setState(() => _initialized = true);
    }
  }

  void _fillUser(AppState state) {
    _username.text = state.user?.username ?? '';
    _email.text = state.user?.email ?? '';
    _qq.text = state.user?.qq ?? '';
    _hard.text = state.hardTokens == 0 ? '' : '${state.hardTokens}';
    _soft.text = state.softTokens == 0 ? '' : '${state.softTokens}';
  }

  Future<void> _saveProfile() async {
    final AppState state = AppScope.read(context);
    setState(() => _savingProfile = true);
    try {
      final bool pwdChanged = _newPassword.text.isNotEmpty;
      final User updated = await state.authService.updateProfile(
        username: _username.text.trim(),
        email: _email.text.trim(),
        qq: _qq.text.trim(),
        oldPassword: pwdChanged ? _oldPassword.text : null,
        newPassword: pwdChanged ? _newPassword.text : null,
      );
      state.user = updated;
      _oldPassword.clear();
      _newPassword.clear();
      if (mounted) {
        setState(() {});
        showToast('个人信息已更新');
      }
    } on ApiException catch (e) {
      showToast(e.message, isError: true);
    } catch (e) {
      showToast('保存失败：$e', isError: true);
    } finally {
      if (mounted) setState(() => _savingProfile = false);
    }
  }

  Future<void> _saveLimits() async {
    final AppState state = AppScope.read(context);
    final int hard = int.tryParse(_hard.text.trim()) ?? 0;
    final int soft = int.tryParse(_soft.text.trim()) ?? 0;
    await state.savePreferences(<String, dynamic>{
      'limits': <String, dynamic>{'hardTokens': hard, 'softTokens': soft},
    });
    if (mounted) showToast('限额已保存');
  }

  Future<void> _setRouting(String task, String current) async {
    final AppState state = AppScope.read(context);
    List<ModelInfo> models = <ModelInfo>[];
    try {
      models = (await state.configService.listModels('chat')).models;
    } catch (_) {
      models = <ModelInfo>[];
    }
    if (!mounted) return;

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
                    title: const Text(
                      '跟随主会话',
                      style: TextStyle(fontSize: 13),
                    ),
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
                        '未获取到模型列表（可先在服务配置里点「获取模型列表」），也可以手动输入模型名。',
                        style: TextStyle(fontSize: 10.5, color: AppColors.inkSoft),
                      ),
                    ),
                  ListTile(
                    dense: true,
                    leading: const Icon(Icons.edit_outlined, size: 18),
                    title: const Text(
                      '手动输入模型名',
                      style: TextStyle(fontSize: 13),
                    ),
                    onTap: () => Navigator.of(ctx).pop('__manual__'),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
    if (value == null || !mounted) return;

    String finalValue = value;
    if (value == '__manual__') {
      final TextEditingController ctrl =
          TextEditingController(text: current);
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
    if (mounted) {
      showToast(
        finalValue.isEmpty
            ? '${kRoutingLabels[task]}已跟随主会话'
            : '${kRoutingLabels[task]}使用 $finalValue',
      );
    }
  }

  Future<void> _manageCharacterSettings() async {
    if (_characters.isEmpty) {
      showToast('还没有角色');
      return;
    }
    final Character? picked = await showModalBottomSheet<Character>(
      context: context,
      builder: (BuildContext ctx) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: <Widget>[
            const Padding(
              padding: EdgeInsets.all(14),
              child: Text(
                '选择要配置的角色',
                style: TextStyle(fontWeight: FontWeight.w700),
              ),
            ),
            ..._characters.map(
              (Character c) => ListTile(
                leading: const Icon(Icons.person_outline),
                title: Text(c.name),
                subtitle: Text(c.subtitle),
                onTap: () => Navigator.of(ctx).pop(c),
              ),
            ),
          ],
        ),
      ),
    );
    if (picked == null || !mounted) return;
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => CharacterSettingsPage(character: picked),
      ),
    );
  }

  Future<void> _logout() async {
    final AppState state = AppScope.read(context);
    final bool ok = await confirmDialog(
      context,
      title: '退出登录',
      message: '确定要退出当前账号吗？本地 token 会被清除。',
      confirmText: '退出',
      danger: true,
    );
    if (!ok) return;
    await state.logout();
  }

  Widget _switchTile(String title, String subtitle, bool value,
      ValueChanged<bool> onChanged) {
    return SwitchListTile(
      contentPadding: EdgeInsets.zero,
      dense: true,
      title: Text(title, style: const TextStyle(fontSize: 13)),
      subtitle: Text(
        subtitle,
        style: const TextStyle(fontSize: 10.5, color: AppColors.inkSoft),
      ),
      value: value,
      onChanged: onChanged,
    );
  }

  @override
  Widget build(BuildContext context) {
    final AppState state = AppScope.of(context);
    if (!_initialized) return const LoadingView();
    return ListView(
      padding: const EdgeInsets.only(bottom: 24),
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
              '对话模型尚未配置，请先在「服务配置 → 对话模型」中填写 baseUrl 与 API Key。',
              style: TextStyle(fontSize: 11.5, color: AppColors.warn),
            ),
          ),
        SectionCard(
          title: '账号信息',
          trailing: Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
            decoration: BoxDecoration(
              color: state.isAdmin
                  ? AppColors.rose.withAlpha(30)
                  : AppColors.sand,
              borderRadius: BorderRadius.circular(8),
            ),
            child: Text(
              state.isAdmin ? '超级管理员' : '普通用户',
              style: TextStyle(
                fontSize: 10,
                color: state.isAdmin ? AppColors.rose : AppColors.inkSoft,
              ),
            ),
          ),
          child: Column(
            children: <Widget>[
              TextField(
                controller: _username,
                decoration: const InputDecoration(labelText: '用户名'),
              ),
              const SizedBox(height: 8),
              TextField(
                controller: _email,
                keyboardType: TextInputType.emailAddress,
                decoration: const InputDecoration(labelText: '邮箱'),
              ),
              const SizedBox(height: 8),
              TextField(
                controller: _qq,
                keyboardType: TextInputType.number,
                inputFormatters: <TextInputFormatter>[
                  FilteringTextInputFormatter.digitsOnly,
                  LengthLimitingTextInputFormatter(12),
                ],
                decoration: const InputDecoration(labelText: 'QQ 号'),
              ),
              const SizedBox(height: 8),
              TextField(
                controller: _oldPassword,
                obscureText: true,
                decoration: const InputDecoration(labelText: '原密码（修改密码时填写）'),
              ),
              const SizedBox(height: 8),
              TextField(
                controller: _newPassword,
                obscureText: true,
                decoration: const InputDecoration(labelText: '新密码（至少 8 位）'),
              ),
              const SizedBox(height: 10),
              Row(
                children: <Widget>[
                  Text(
                    '注册于 ${formatDate(state.user?.createdAt)}',
                    style: const TextStyle(
                      fontSize: 10.5,
                      color: AppColors.inkSoft,
                    ),
                  ),
                  const Spacer(),
                  FilledButton(
                    onPressed: _savingProfile ? null : _saveProfile,
                    style: FilledButton.styleFrom(
                      minimumSize: const Size(0, 38),
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                    ),
                    child: const Text('保存'),
                  ),
                ],
              ),
            ],
          ),
        ),
        SectionCard(
          title: '服务配置',
          child: Column(
            children: kServices.map((String service) {
              final ServiceConfig cfg = state.config?.service(service) ??
                  ServiceConfig.empty;
              final bool ready = switch (service) {
                'chat' => state.chatReady,
                'embedding' => state.embeddingReady,
                'stt' => state.config?.readyStt ?? false,
                'tts' => state.config?.readyTts ?? false,
                'search' => state.config?.readySearch ?? false,
                _ => cfg.configured,
              };
              return Container(
                margin: const EdgeInsets.only(bottom: 6),
                decoration: BoxDecoration(
                  color: AppColors.cream,
                  borderRadius: BorderRadius.circular(12),
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
                        style: const TextStyle(fontSize: 13),
                      ),
                      const SizedBox(width: 6),
                      Icon(
                        ready
                            ? Icons.check_circle
                            : Icons.radio_button_unchecked,
                        size: 12,
                        color: ready ? AppColors.success : AppColors.inkSoft,
                      ),
                      const Spacer(),
                      Text(
                        cfg.model.isEmpty ? '未设置模型' : cfg.model,
                        style: const TextStyle(
                          fontSize: 10,
                          color: AppColors.inkSoft,
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
            }).toList(),
          ),
        ),
        SectionCard(
          title: '角色配置',
          trailing: TextButton(
            onPressed: _manageCharacterSettings,
            style: TextButton.styleFrom(
              minimumSize: const Size(0, 28),
              padding: const EdgeInsets.symmetric(horizontal: 6),
              textStyle: const TextStyle(fontSize: 11.5),
            ),
            child: const Text('选择角色'),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                _characters.isEmpty
                    ? '还没有角色'
                    : '已创建 ${_characters.length} 位角色：${_characters.map((Character c) => c.name).join('、')}',
                style: const TextStyle(fontSize: 11.5, color: AppColors.inkSoft),
              ),
              const SizedBox(height: 4),
              const Text(
                '可配置 RSS 源、创作标签、创作频率、作息与主动回复。',
                style: TextStyle(fontSize: 10.5, color: AppColors.inkSoft),
              ),
            ],
          ),
        ),
        SectionCard(
          title: '模型分工',
          child: Column(
            children: kRoutingTasks.map((String task) {
              final String model = state.modelRouting[task] ?? '';
              return InkWell(
                onTap: () => _setRouting(task, model),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Row(
                    children: <Widget>[
                      Expanded(
                        child: Text(
                          kRoutingLabels[task] ?? task,
                          style: const TextStyle(fontSize: 12.5),
                        ),
                      ),
                      Text(
                        model.isEmpty ? '跟随主会话' : model,
                        style: TextStyle(
                          fontSize: 11,
                          color: model.isEmpty
                              ? AppColors.inkSoft
                              : AppColors.cocoa,
                        ),
                      ),
                      const Icon(Icons.chevron_right, size: 16),
                    ],
                  ),
                ),
              );
            }).toList(),
          ),
        ),
        SectionCard(
          title: 'Token 限额',
          child: Column(
            children: <Widget>[
              Row(
                children: <Widget>[
                  Expanded(
                    child: TextField(
                      controller: _hard,
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
              const Text(
                '硬限额：达到后停止主会话与全部角色服务；软限额：停止创作与新闻阅读，仅保留会话与四小时一次状态更新。',
                style: TextStyle(fontSize: 10.5, color: AppColors.inkSoft, height: 1.5),
              ),
              const SizedBox(height: 8),
              Align(
                alignment: Alignment.centerRight,
                child: FilledButton(
                  onPressed: _saveLimits,
                  style: FilledButton.styleFrom(
                    minimumSize: const Size(0, 36),
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                  ),
                  child: const Text('保存限额'),
                ),
              ),
            ],
          ),
        ),
        SectionCard(
          title: '对话偏好',
          child: Column(
            children: <Widget>[
              _switchTile(
                '思考模式',
                '角色默认关闭；开启后回复前会先思考',
                state.thinkingMode,
                (bool v) => state.setThinkingMode(v),
              ),
              _switchTile(
                '调试模式',
                '在聊天输入框下显示上下文占用圆圈与百分比',
                state.debugMode,
                (bool v) => state.setDebugMode(v),
              ),
              _switchTile(
                '主动回复',
                '等待期结束后角色会主动发来消息',
                asBool(state.preferences['activeReply'], true),
                (bool v) =>
                    state.savePreferences(<String, dynamic>{'activeReply': v}),
              ),
              _switchTile(
                '分段消息',
                '开启后角色会把长回复拆成几条依次发送',
                state.segmentEnabled,
                (bool v) => state.savePreferences(
                  <String, dynamic>{'segmentEnabled': v},
                ),
              ),
            ],
          ),
        ),
        SectionCard(
          title: '服务地址',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                state.baseUrl,
                style: const TextStyle(fontSize: 12, color: AppColors.cocoa),
              ),
              const SizedBox(height: 6),
              Row(
                children: <Widget>[
                  OutlinedButton(
                    onPressed: () => showServerAddressDialog(context),
                    style: OutlinedButton.styleFrom(
                      minimumSize: const Size(0, 36),
                      padding: const EdgeInsets.symmetric(horizontal: 14),
                    ),
                    child: const Text('修改服务地址'),
                  ),
                  const SizedBox(width: 10),
                  TextButton(
                    onPressed: () async {
                      final bool ok = await state.verifySession();
                      showToast(ok ? '登录态有效' : '登录态已失效，请重新登录',
                          isError: !ok);
                    },
                    child: const Text('校验登录态', style: TextStyle(fontSize: 12)),
                  ),
                ],
              ),
            ],
          ),
        ),
        SectionCard(
          title: '关于',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              const Text(
                'Cocoa 虚拟智能体陪伴系统 · Android 客户端',
                style: TextStyle(fontSize: 11.5),
              ),
              const SizedBox(height: 4),
              Text(
                '版本 $kAppVersion · 每个角色的记忆与资产彼此独立',
                style: const TextStyle(fontSize: 10.5, color: AppColors.inkSoft),
              ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 12, 12, 0),
          child: OutlinedButton.icon(
            onPressed: _logout,
            icon: const Icon(Icons.logout, size: 17),
            label: const Text('退出登录'),
            style: OutlinedButton.styleFrom(
              foregroundColor: AppColors.danger,
              side: const BorderSide(color: AppColors.danger),
            ),
          ),
        ),
      ],
    );
  }
}
