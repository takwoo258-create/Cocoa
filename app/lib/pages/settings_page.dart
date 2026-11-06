import 'package:flutter/material.dart';
import '../core/layout.dart';

import '../core/app_state.dart';
import '../core/constants.dart';
import '../core/global.dart';
import '../core/theme.dart';
import '../core/appearance.dart';
import 'settings/about_page.dart';
import 'settings/agent_page.dart';
import 'settings/character_config_page.dart';
import 'settings/limits_page.dart';
import 'settings/model_routing_page.dart';
import 'settings/profile_page.dart';
import 'settings/service_config_page.dart';
import 'settings/plaza_page.dart';
import 'settings/templates_page.dart';
import 'settings/theme_page.dart';
import 'settings/shares_page.dart';

/// v1.0.1：设置首页改为分组二级菜单。
class SettingsPage extends StatelessWidget {
  const SettingsPage({super.key});

  Widget _group(String title, List<Widget> children) {
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 8, 12, 2),
      decoration: BoxDecoration(
        color: AppColors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppColors.sand),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 2),
            child: Text(
              title,
              style: const TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w700,
                color: AppColors.inkSoft,
                letterSpacing: 0.5,
              ),
            ),
          ),
          ...children,
        ],
      ),
    );
  }

  Widget _tile(
    BuildContext context, {
    required IconData icon,
    required String title,
    String? subtitle,
    String? trailingText,
    Widget? page,
    VoidCallback? onTap,
    Color? color,
  }) {
    return ListTile(
      dense: true,
      leading: Icon(icon, size: 19, color: color ?? AppColors.cocoa),
      title: Text(
        title,
        style: TextStyle(fontSize: 13.5, color: color ?? AppColors.ink),
      ),
      subtitle: subtitle == null
          ? null
          : Text(
              subtitle,
              style: const TextStyle(fontSize: 10.5, color: AppColors.inkSoft),
            ),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (trailingText != null)
            Text(
              trailingText,
              style: const TextStyle(fontSize: 10.5, color: AppColors.inkSoft),
            ),
          const SizedBox(width: 4),
          const Icon(Icons.chevron_right, size: 18, color: AppColors.inkSoft),
        ],
      ),
      onTap: onTap ??
          (page == null
              ? null
              : () => Navigator.of(context)
                  .push(MaterialPageRoute<void>(builder: (_) => page))),
    );
  }

  Future<void> _logout(BuildContext context) async {
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

  @override
  Widget build(BuildContext context) {
    final AppState state = AppScope.of(context);
    final String role = state.isAdmin ? '超级管理员' : '普通用户';
    return Container(
      decoration: appearanceDecoration(state),
      child: ListView(
      padding: pagePadding(context, top: 0, bottom: 26),
      children: <Widget>[
        Container(
          margin: const EdgeInsets.fromLTRB(12, 10, 12, 2),
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            gradient: kCocoaGradient,
            borderRadius: BorderRadius.circular(18),
          ),
          child: Row(
            children: <Widget>[
              Container(
                width: 46,
                height: 46,
                decoration: BoxDecoration(
                  color: Colors.white.withAlpha(40),
                  shape: BoxShape.circle,
                ),
                child: Center(
                  child: Text(
                    (state.user?.displayName.isNotEmpty ?? false)
                        ? state.user!.displayName.characters.first
                        : '?',
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 18,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      '${state.user?.codeLabel ?? ''} ${state.user?.displayName ?? ''}'.trim(),
                      style: const TextStyle(
                        color: Colors.white,
                        fontSize: 15,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      '${state.user?.email ?? ''} · $role',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: Colors.white.withAlpha(210),
                        fontSize: 10.5,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
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
        _group('账号', <Widget>[
          _tile(
            context,
            icon: Icons.person_outline,
            title: '个人信息',
            subtitle: '昵称 / 邮箱 / QQ / 密码',
            page: const ProfilePage(),
          ),
          _tile(
            context,
            icon: Icons.favorite_border,
            title: '角色配置',
            subtitle: 'RSS、创作标签、频率、作息、QQ 动态',
            page: const CharacterConfigPage(),
          ),
        ]),
        _group('模型', <Widget>[
          _tile(
            context,
            icon: Icons.dns_outlined,
            title: '服务配置',
            subtitle: '对话 / 嵌入 / DeepSeek / STT / TTS',
            trailingText: state.chatReady ? '已配置' : '未配置',
            page: const ServiceConfigPage(),
          ),
          _tile(
            context,
            icon: Icons.palette_outlined,
            title: '主题与外观',
            subtitle: '壁纸 / 字体 / 字号 / 动效',
            page: const ThemePage(),
          ),
          _tile(
            context,
            icon: Icons.public,
            title: '共享广场',
            subtitle: '本服 / 全球模型与人设模板',
            page: const PlazaPage(),
          ),
          _tile(
            context,
            icon: Icons.bookmark_border,
            title: '人设模板',
            subtitle: '保存 / 导入 / 应用创建角色',
            page: const TemplatesPage(),
          ),
          _tile(
            context,
            icon: Icons.swap_horiz,
            title: '模型分享',
            subtitle: '分享 / 索要模型，设置时长或截止时间',
            page: const SharesPage(),
          ),
          _tile(
            context,
            icon: Icons.call_split,
            title: '模型分工',
            subtitle: '主会话、画像、创作等任务分别选模型',
            page: const ModelRoutingPage(),
          ),
          _tile(
            context,
            icon: Icons.speed,
            title: 'Token 限额',
            subtitle: state.limitsEnabled ? '已启用硬/软限额' : '限额已关闭',
            trailingText: '${state.hardTokens}/${state.softTokens}',
            page: const LimitsPage(),
          ),
        ]),
        _group('智能体', <Widget>[
          const _AutoMemorySwitch(),
          _tile(
            context,
            icon: Icons.psychology_outlined,
            title: '对话偏好',
            subtitle:
                '思考模式 ${state.thinkingMode ? '开' : '关'} · 调试 ${state.debugMode ? '开' : '关'} · 主动回复 ${state.activeReplyEnabled ? '开' : '关'}',
            page: const AgentPage(),
          ),
        ]),
        _group('其他', <Widget>[
          _tile(
            context,
            icon: Icons.info_outline,
            title: '关于与版本',
            subtitle: '版本推送、服务地址、登录态检查',
            trailingText: 'v$kAppVersion',
            page: const AboutPage(),
          ),
          _tile(
            context,
            icon: Icons.logout,
            title: '退出登录',
            color: AppColors.danger,
            onTap: () => _logout(context),
          ),
        ]),
        const Padding(
          padding: EdgeInsets.fromLTRB(18, 14, 18, 0),
          child: Text(
            'Cocoa · 每个角色的记忆与资产彼此独立',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 10, color: AppColors.inkSoft),
          ),
        ),
      ],
      ),
    );
  }
}


class _AutoMemorySwitch extends StatefulWidget {
  const _AutoMemorySwitch();

  @override
  State<_AutoMemorySwitch> createState() => _AutoMemorySwitchState();
}

class _AutoMemorySwitchState extends State<_AutoMemorySwitch> {
  bool _value = true;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final AppState state = AppScope.read(context);
      try {
        final bool v = await state.memoryService.autoMemory();
        if (mounted) setState(() => _value = v);
      } catch (_) {}
      if (mounted) setState(() => _loading = false);
    });
  }

  Future<void> _toggle(bool v) async {
    setState(() => _value = v);
    final AppState state = AppScope.read(context);
    try {
      await state.memoryService.saveAutoMemory(v);
      if (mounted) showToast(v ? '已开启自动记忆' : '已关闭自动记忆');
    } catch (e) {
      if (mounted) {
        setState(() => _value = !v);
        showToast('保存失败：$e', isError: true);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return SwitchListTile(
      dense: true,
      title: const Text('自动从对话中记住我的特征', style: TextStyle(fontSize: 13)),
      subtitle: const Text(
        '开启后角色会从聊天中提取你的偏好与特征形成记忆点',
        style: TextStyle(fontSize: 10.5, color: AppColors.inkSoft),
      ),
      value: _value,
      onChanged: _loading ? null : _toggle,
    );
  }
}
