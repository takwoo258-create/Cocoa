import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/api_client.dart';
import '../core/app_state.dart';
import '../core/global.dart';
import '../core/theme.dart';
import '../services/auth_service.dart';
import 'app_entry.dart';
import 'server_address_dialog.dart';

class LoginPage extends StatefulWidget {
  const LoginPage({super.key});

  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  bool _register = false;
  String _loginMode = 'password';
  bool _obscure = true;
  bool _busy = false;
  bool _sending = false;
  int _cooldown = 0;
  Timer? _timer;

  final TextEditingController _identifier = TextEditingController();
  final TextEditingController _password = TextEditingController();
  final TextEditingController _code = TextEditingController();
  final TextEditingController _username = TextEditingController();
  final TextEditingController _email = TextEditingController();
  final TextEditingController _qq = TextEditingController();
  final TextEditingController _regPassword = TextEditingController();
  final TextEditingController _regConfirm = TextEditingController();
  final TextEditingController _regCode = TextEditingController();

  @override
  void dispose() {
    _timer?.cancel();
    for (final TextEditingController c in <TextEditingController>[
      _identifier,
      _password,
      _code,
      _username,
      _email,
      _qq,
      _regPassword,
      _regConfirm,
      _regCode,
    ]) {
      c.dispose();
    }
    super.dispose();
  }

  void _startCooldown() {
    _timer?.cancel();
    setState(() => _cooldown = 60);
    _timer = Timer.periodic(const Duration(seconds: 1), (Timer t) {
      if (!mounted) {
        t.cancel();
        return;
      }
      setState(() => _cooldown -= 1);
      if (_cooldown <= 0) {
        t.cancel();
        setState(() => _cooldown = 0);
      }
    });
  }

  Future<void> _sendCode() async {
    final AppState state = AppScope.read(context);
    final String email = _register
        ? _email.text.trim()
        : _identifier.text.trim();
    if (!email.contains('@')) {
      showToast(_register ? '请先填写邮箱' : '验证码登录请填写邮箱');
      return;
    }
    setState(() => _sending = true);
    try {
      final SendCodeResult r = await state.authService
          .sendCode(email, _register ? 'register' : 'login');
      if (r.devCode != null) {
        if (_register) {
          _regCode.text = r.devCode!;
        } else {
          _code.text = r.devCode!;
        }
        showToast('开发模式验证码：${r.devCode}');
      } else if (r.sent) {
        showToast('验证码已发送，请查收邮箱');
      } else {
        showToast(r.warning ?? '验证码发送失败，请稍后再试', isError: true);
      }
      _startCooldown();
    } on ApiException catch (e) {
      showToast(e.message, isError: true);
    } catch (e) {
      showToast('$e', isError: true);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _submit() async {
    final AppState state = AppScope.read(context);
    late final String identifier;
    late final String password;
    late final String code;
    late final String username;
    late final String email;
    late final String qq;
    late final String confirm;

    if (_register) {
      username = _username.text.trim();
      email = _email.text.trim();
      qq = _qq.text.trim();
      password = _regPassword.text;
      confirm = _regConfirm.text;
      code = _regCode.text.trim();
      if (username.length < 2) { showToast('用户名至少 2 个字符'); return; }
      if (!email.contains('@')) { showToast('请填写正确的邮箱'); return; }
      if (!RegExp(r'^\d{5,12}$').hasMatch(qq)) { showToast('注册必须填写 5-12 位 QQ 号'); return; }
      if (password.length < 8) { showToast('密码至少 8 位'); return; }
      if (password != confirm) { showToast('两次输入的密码不一致'); return; }
      if (code.isEmpty) { showToast('请填写邮箱验证码'); return; }
    } else {
      identifier = _identifier.text.trim();
      password = _password.text;
      code = _code.text.trim();
      if (identifier.isEmpty) { showToast('请输入用户名或邮箱'); return; }
      if (_loginMode == 'password' && password.isEmpty) {
        { showToast('请输入密码'); return; }
      }
      if (_loginMode == 'code') {
        if (!identifier.contains('@')) { showToast('验证码登录仅支持邮箱'); return; }
        if (code.isEmpty) { showToast('请填写邮箱验证码'); return; }
      }
    }

    setState(() => _busy = true);
    try {
      final AuthResult r = _register
          ? await state.authService.register(
              username: _username.text.trim(),
              email: _email.text.trim(),
              password: _regPassword.text,
              confirmPassword: _regConfirm.text,
              qq: _qq.text.trim(),
              code: _regCode.text.trim(),
            )
          : await state.authService.login(
              identifier: _identifier.text.trim(),
              mode: _loginMode,
              password: _password.text,
              code: _code.text.trim(),
            );
      await state.onLogin(r);
      if (!mounted) return;
      await enterApp(context);
    } on ApiException catch (e) {
      showToast(e.message, isError: true);
    } catch (e) {
      showToast('登录失败：$e', isError: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  InputDecoration _dec(String label, {String? hint, Widget? suffix}) =>
      InputDecoration(
        labelText: label,
        hintText: hint,
        suffixIcon: suffix,
        isDense: true,
      );

  Widget _switchMode() {
    Widget item(String label, bool active, VoidCallback onTap) {
      return Expanded(
        child: GestureDetector(
          onTap: onTap,
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 180),
            padding: const EdgeInsets.symmetric(vertical: 10),
            decoration: BoxDecoration(
              color: active ? AppColors.cocoa : Colors.transparent,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Center(
              child: Text(
                label,
                style: TextStyle(
                  fontSize: 13.5,
                  fontWeight: FontWeight.w600,
                  color: active ? Colors.white : AppColors.inkSoft,
                ),
              ),
            ),
          ),
        ),
      );
    }

    return Container(
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: AppColors.sand.withAlpha(160),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        children: <Widget>[
          item('登录', !_register, () => setState(() => _register = false)),
          item('注册', _register, () => setState(() => _register = true)),
        ],
      ),
    );
  }

  Widget _codeRow({
    required TextEditingController controller,
    required String label,
  }) {
    return Row(
      children: <Widget>[
        Expanded(
          child: TextField(
            controller: controller,
            keyboardType: TextInputType.number,
            inputFormatters: <TextInputFormatter>[
              FilteringTextInputFormatter.digitsOnly,
              LengthLimitingTextInputFormatter(6),
            ],
            decoration: _dec(label, hint: '6 位验证码'),
          ),
        ),
        const SizedBox(width: 8),
        SizedBox(
          width: 104,
          height: 48,
          child: OutlinedButton(
            onPressed: (_sending || _cooldown > 0) ? null : _sendCode,
            style: OutlinedButton.styleFrom(
              padding: EdgeInsets.zero,
              textStyle: const TextStyle(fontSize: 12),
            ),
            child: Text(
              _cooldown > 0 ? '${_cooldown}s' : (_sending ? '发送中' : '获取验证码'),
            ),
          ),
        ),
      ],
    );
  }

  Widget _loginForm() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Row(
          children: <Widget>[
            Expanded(
              child: _modeChip('密码登录', _loginMode == 'password',
                  () => setState(() => _loginMode = 'password')),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: _modeChip('验证码登录', _loginMode == 'code',
                  () => setState(() => _loginMode = 'code')),
            ),
          ],
        ),
        const SizedBox(height: 14),
        TextField(
          controller: _identifier,
          keyboardType: TextInputType.emailAddress,
          decoration: _dec(
            '用户名或邮箱',
            hint: _loginMode == 'code' ? '验证码登录请填写邮箱' : '',
          ),
        ),
        const SizedBox(height: 10),
        if (_loginMode == 'password')
          TextField(
            controller: _password,
            obscureText: _obscure,
            decoration: _dec(
              '密码',
              suffix: IconButton(
                icon: Icon(
                  _obscure ? Icons.visibility_off : Icons.visibility,
                  size: 18,
                ),
                onPressed: () => setState(() => _obscure = !_obscure),
              ),
            ),
          )
        else
          _codeRow(controller: _code, label: '邮箱验证码'),
      ],
    );
  }

  Widget _modeChip(String label, bool active, VoidCallback onTap) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 8),
        decoration: BoxDecoration(
          color: active ? AppColors.cocoa.withAlpha(20) : Colors.transparent,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(
            color: active ? AppColors.cocoa : AppColors.sand,
          ),
        ),
        child: Center(
          child: Text(
            label,
            style: TextStyle(
              fontSize: 12.5,
              color: active ? AppColors.cocoa : AppColors.inkSoft,
              fontWeight: active ? FontWeight.w600 : FontWeight.w400,
            ),
          ),
        ),
      ),
    );
  }

  Widget _registerForm() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        TextField(
          controller: _username,
          decoration: _dec('用户名', hint: '2-32 位，支持中英文'),
        ),
        const SizedBox(height: 10),
        TextField(
          controller: _email,
          keyboardType: TextInputType.emailAddress,
          decoration: _dec('邮箱', hint: '仅支持邮箱注册'),
        ),
        const SizedBox(height: 10),
        TextField(
          controller: _qq,
          keyboardType: TextInputType.number,
          inputFormatters: <TextInputFormatter>[
            FilteringTextInputFormatter.digitsOnly,
            LengthLimitingTextInputFormatter(12),
          ],
          decoration: _dec('QQ 号（必填）', hint: '用于 QQ 机器人绑定，5-12 位数字'),
        ),
        const SizedBox(height: 10),
        TextField(
          controller: _regPassword,
          obscureText: true,
          decoration: _dec('密码', hint: '8-64 位'),
        ),
        const SizedBox(height: 10),
        TextField(
          controller: _regConfirm,
          obscureText: true,
          decoration: _dec('确认密码', hint: '再次输入密码'),
        ),
        const SizedBox(height: 10),
        _codeRow(controller: _regCode, label: '邮箱验证码'),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final AppState state = AppScope.read(context);
    return Scaffold(
      body: Container(
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: <Color>[Color(0xFFF6E7D6), AppColors.cream],
          ),
        ),
        child: SafeArea(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(22, 28, 22, 24),
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 480),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                Center(
                  child: Container(
                    width: 72,
                    height: 72,
                    decoration: const BoxDecoration(
                      gradient: kCocoaGradient,
                      shape: BoxShape.circle,
                    ),
                    child: const Icon(
                      Icons.coffee,
                      color: Colors.white,
                      size: 34,
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                const Center(
                  child: Text(
                    'Cocoa',
                    style: TextStyle(
                      fontSize: 26,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 3,
                      color: AppColors.ink,
                    ),
                  ),
                ),
                const SizedBox(height: 4),
                const Center(
                  child: Text(
                    '虚拟智能体陪伴系统',
                    style: TextStyle(
                      fontSize: 12,
                      color: AppColors.inkSoft,
                      letterSpacing: 1,
                    ),
                  ),
                ),
                const SizedBox(height: 24),
                Container(
                  padding: const EdgeInsets.fromLTRB(16, 14, 16, 18),
                  decoration: BoxDecoration(
                    color: AppColors.white,
                    borderRadius: BorderRadius.circular(22),
                    boxShadow: <BoxShadow>[
                      BoxShadow(
                        color: AppColors.latte.withAlpha(50),
                        blurRadius: 22,
                        offset: const Offset(0, 8),
                      ),
                    ],
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: <Widget>[
                      _switchMode(),
                      const SizedBox(height: 16),
                      if (_register) _registerForm() else _loginForm(),
                      const SizedBox(height: 18),
                      FilledButton(
                        onPressed: _busy ? null : _submit,
                        child: _busy
                            ? const SizedBox(
                                width: 18,
                                height: 18,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                  color: Colors.white,
                                ),
                              )
                            : Text(_register ? '注册并登录' : '登录'),
                      ),
                      const SizedBox(height: 10),
                      Row(
                        children: <Widget>[
                          const Icon(
                            Icons.dns_outlined,
                            size: 13,
                            color: AppColors.inkSoft,
                          ),
                          const SizedBox(width: 4),
                          Expanded(
                            child: Text(
                              state.baseUrl,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                fontSize: 11,
                                color: AppColors.inkSoft,
                              ),
                            ),
                          ),
                          TextButton(
                            onPressed: () => showServerAddressDialog(context),
                            style: TextButton.styleFrom(
                              minimumSize: const Size(0, 28),
                              padding: const EdgeInsets.symmetric(horizontal: 6),
                              textStyle: const TextStyle(fontSize: 11.5),
                            ),
                            child: const Text('修改服务地址'),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 16),
                const Center(
                  child: Text(
                    '邮箱验证码注册 · 每个角色的记忆彼此独立',
                    style: TextStyle(fontSize: 10.5, color: AppColors.inkSoft),
                  ),
                ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
