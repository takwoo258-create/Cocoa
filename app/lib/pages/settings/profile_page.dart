import 'package:flutter/material.dart';
import '../../core/layout.dart';
import 'package:flutter/services.dart';

import '../../core/api_client.dart';
import '../../core/app_state.dart';
import '../../core/global.dart';
import '../../core/theme.dart';
import '../../core/utils.dart';
import '../../models/user.dart';
import '../../widgets/common.dart';

/// 个人信息二级页。
class ProfilePage extends StatefulWidget {
  const ProfilePage({super.key});

  @override
  State<ProfilePage> createState() => _ProfilePageState();
}

class _ProfilePageState extends State<ProfilePage> {
  final TextEditingController _username = TextEditingController();
  final TextEditingController _email = TextEditingController();
  final TextEditingController _qq = TextEditingController();
  final TextEditingController _oldPassword = TextEditingController();
  final TextEditingController _newPassword = TextEditingController();
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final AppState state = AppScope.read(context);
      _username.text = state.user?.username ?? '';
      _email.text = state.user?.email ?? '';
      _qq.text = state.user?.qq ?? '';
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _username.dispose();
    _email.dispose();
    _qq.dispose();
    _oldPassword.dispose();
    _newPassword.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final AppState state = AppScope.read(context);
    final String username = _username.text.trim();
    final String email = _email.text.trim();
    final String qq = _qq.text.trim();
    if (username.length < 2) {
      showToast('昵称至少 2 个字符');
      return;
    }
    if (!email.contains('@')) {
      showToast('请填写正确的邮箱');
      return;
    }
    if (qq.isNotEmpty && !RegExp(r'^\d{5,12}$').hasMatch(qq)) {
      showToast('请填写正确的 QQ 号');
      return;
    }
    final bool pwdChanged = _newPassword.text.isNotEmpty;
    if (pwdChanged && _newPassword.text.length < 8) {
      showToast('新密码至少 8 位');
      return;
    }
    setState(() => _saving = true);
    try {
      final User updated = await state.authService.updateProfile(
        username: username,
        email: email,
        qq: qq,
        oldPassword: pwdChanged ? _oldPassword.text : null,
        newPassword: pwdChanged ? _newPassword.text : null,
      );
      state.user = updated;
      _oldPassword.clear();
      _newPassword.clear();
      if (!mounted) return;
      setState(() {});
      showToast('个人信息已更新');
    } on ApiException catch (e) {
      showToast(e.message, isError: true);
    } catch (e) {
      showToast('保存失败：$e', isError: true);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final AppState state = AppScope.of(context);
    return Scaffold(
      appBar: AppBar(
        title: const Text('个人信息'),
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
        padding: pagePadding(context, top: 8),
        children: <Widget>[
          SectionCard(
            title: '账号信息',
            trailing: Text(
              '${state.user?.codeLabel ?? ''} · ${state.isAdmin ? '超级管理员' : '普通用户'}',
              style: TextStyle(
                fontSize: 10,
                color: state.isAdmin ? AppColors.rose : AppColors.inkSoft,
              ),
            ),
            child: Column(
              children: <Widget>[
                TextField(
                  controller: _username,
                  decoration: const InputDecoration(labelText: '昵称'),
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
                  decoration: const InputDecoration(
                    labelText: 'QQ 号',
                    helperText: '用于 QQ 机器人与动态绑定',
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  '注册于 ${formatDate(state.user?.createdAt)} · 上次登录 ${formatDateTime(state.user?.lastLoginAt)}',
                  style: const TextStyle(
                    fontSize: 10.5,
                    color: AppColors.inkSoft,
                  ),
                ),
              ],
            ),
          ),
          SectionCard(
            title: '修改密码',
            child: Column(
              children: <Widget>[
                TextField(
                  controller: _oldPassword,
                  obscureText: true,
                  decoration: const InputDecoration(labelText: '原密码'),
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: _newPassword,
                  obscureText: true,
                  decoration: const InputDecoration(
                    labelText: '新密码（至少 8 位，留空不修改）',
                  ),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 4, 12, 0),
            child: SizedBox(
              height: 46,
              child: FilledButton(
                onPressed: _saving ? null : _save,
                child: const Text('保存个人信息'),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
