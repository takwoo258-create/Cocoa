import 'package:flutter/material.dart';
import '../../core/layout.dart';

import '../../core/app_state.dart';
import '../../core/constants.dart';
import '../../core/global.dart';
import '../../core/native.dart';
import '../../core/theme.dart';
import '../../core/utils.dart';
import '../../models/version_info.dart';
import '../../widgets/common.dart';
import '../../widgets/update_dialog.dart';
import '../server_address_dialog.dart';

/// 关于与版本二级页：手动检查更新、下载/忽略、服务地址、登录态。
class AboutPage extends StatefulWidget {
  const AboutPage({super.key});

  @override
  State<AboutPage> createState() => _AboutPageState();
}

class _AboutPageState extends State<AboutPage> {
  bool _checking = false;

  Future<void> _check() async {
    final AppState state = AppScope.read(context);
    setState(() => _checking = true);
    await state.checkVersion(force: true);
    if (!mounted) return;
    setState(() => _checking = false);
    final VersionCheckResult? r = state.versionCheck;
    if (r == null) {
      showToast('检查更新失败，请稍后再试', isError: true);
    } else if (r.updateAvailable) {
      showToast('发现新版本 ${r.latest.displayLabel}');
    } else {
      showToast('已是最新 v$kAppVersion');
    }
  }

  Future<void> _openRelease(LatestVersion latest) async {
    final String safe =
        latest.version.replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '-');
    final bool ok = await downloadApk(latest.downloadUrl, 'Cocoa-$safe.apk');
    if (!ok) {
      final bool opened = await openExternalUrl(latest.downloadUrl);
      if (!opened) {
        showToast('无法打开下载链接：${latest.downloadUrl}', isError: true);
      }
    } else {
      showToast('已开始下载 ${latest.displayLabel}');
    }
  }

  Widget _releaseTile(LatestVersion v, {bool latestBadge = false}) {
    return ExpansionTile(
      tilePadding: EdgeInsets.zero,
      shape: const Border(),
      collapsedShape: const Border(),
      title: Row(
        children: <Widget>[
          Text(
            v.displayLabel,
            style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
          ),
          const SizedBox(width: 6),
          if (v.beta)
            const Text(
              'Beta',
              style: TextStyle(fontSize: 9, color: AppColors.rose),
            ),
          if (!v.beta && latestBadge)
            const Text(
              '最新版',
              style: TextStyle(fontSize: 9, color: AppColors.cocoa),
            ),
          if (v.force) ...<Widget>[
            const SizedBox(width: 4),
            const Text(
              '需要更新',
              style: TextStyle(fontSize: 9, color: AppColors.warn),
            ),
          ],
        ],
      ),
      subtitle: Text(
        v.notesSummary,
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(fontSize: 10.5, color: AppColors.inkSoft),
      ),
      children: <Widget>[
        if (v.formattedNotes.isNotEmpty)
          Align(
            alignment: Alignment.centerLeft,
            child: Text(
              v.formattedNotes,
              style: const TextStyle(
                fontSize: 11,
                height: 1.55,
                color: AppColors.inkSoft,
              ),
            ),
          ),
        Align(
          alignment: Alignment.centerRight,
          child: TextButton(
            onPressed: () => _openRelease(v),
            child: Text('下载 ${v.displayLabel}'),
          ),
        ),
      ],
    );
  }

  String _forceReasonText(VersionCheckResult? check) {
    if (check == null) return '当前版本已不再受支持';
    switch (check.forceReason) {
      case 'admin':
        return '管理员已将该版本设为必须更新';
      case 'min_version':
        return '当前版本低于最低支持版本${check.minVersion.isEmpty ? '' : ' ${check.minVersion}'}';
      case 'release':
        return '该版本说明要求更新';
      default:
        return '当前版本已不再受支持';
    }
  }

  @override
  Widget build(BuildContext context) {
    final AppState state = AppScope.of(context);
    final VersionCheckResult? check = state.versionCheck;
    final LatestVersion latest = check?.latest ?? LatestVersion.empty;
    final bool forced = state.forceUpdateAvailable;
    final bool hasUpdate = forced || state.updateAvailable;
    return Scaffold(
      appBar: AppBar(title: const Text('关于与版本')),
      body: ListView(
        padding: pagePadding(context),
        children: <Widget>[
          SectionCard(
            title: '版本',
            trailing: Text(
              '当前 v$kAppVersion',
              style: const TextStyle(fontSize: 11, color: AppColors.cocoa),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    Icon(
                      hasUpdate
                          ? Icons.new_releases_outlined
                          : Icons.verified_outlined,
                      size: 17,
                      color: hasUpdate ? AppColors.warn : AppColors.success,
                    ),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        forced
                            ? '需要更新：${latest.displayLabel}'
                            : hasUpdate
                                ? '发现新版本 ${latest.displayLabel}'
                                : check == null
                                    ? '尚未检查更新'
                                    : (!check.ok && latest.version.isEmpty
                                        ? '版本信息暂不可用'
                                        : '已是最新'),
                        style: const TextStyle(fontSize: 12.5),
                      ),
                    ),
                    OutlinedButton(
                      onPressed: _checking ? null : _check,
                      style: OutlinedButton.styleFrom(
                        minimumSize: const Size(0, 34),
                        padding: const EdgeInsets.symmetric(horizontal: 12),
                        textStyle: const TextStyle(fontSize: 11.5),
                      ),
                      child: _checking
                          ? const SizedBox(
                              width: 14,
                              height: 14,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Text('检查更新'),
                    ),
                  ],
                ),
                if (check != null && latest.version.isNotEmpty) ...<Widget>[
                  const SizedBox(height: 6),
                  Text(
                    '最新 v${latest.version} · 来源 ${check.source} · 检查于 ${formatDateTime(check.checkedAt)}',
                    style: const TextStyle(
                      fontSize: 10.5,
                      color: AppColors.inkSoft,
                    ),
                  ),
                  if (forced) ...<Widget>[
                    const SizedBox(height: 6),
                    Text(
                      '需要更新的原因：${_forceReasonText(check)}'
                      '${check.minVersion.isNotEmpty ? ' · 最低版本 ${check.minVersion}' : ''}',
                      style: const TextStyle(
                        fontSize: 11,
                        color: AppColors.danger,
                        height: 1.5,
                      ),
                    ),
                  ],
                  if (latest.formattedNotes.isNotEmpty) ...<Widget>[
                    const SizedBox(height: 6),
                    Text(
                      latest.formattedNotes,
                      maxLines: 6,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 11,
                        height: 1.5,
                        color: AppColors.inkSoft,
                      ),
                    ),
                  ],
                  if (hasUpdate) ...<Widget>[
                    const SizedBox(height: 8),
                    Row(
                      children: <Widget>[
                        FilledButton(
                          onPressed: () => UpdateDialog.show(
                            context,
                            check: check,
                          ),
                          style: FilledButton.styleFrom(
                            minimumSize: const Size(0, 36),
                            padding:
                                const EdgeInsets.symmetric(horizontal: 14),
                          ),
                          child: const Text('查看更新'),
                        ),
                        if (!forced) ...<Widget>[
                          const SizedBox(width: 10),
                          TextButton(
                            onPressed: () => state.ignoreLatestUpdate(),
                            child: const Text('下次再提醒'),
                          ),
                        ],
                      ],
                    ),
                  ],
                ],
                if (state.ignoredVersionTag != null) ...<Widget>[
                  const SizedBox(height: 6),
                  TextButton(
                    onPressed: () => state.ignoreVersion(''),
                    style: TextButton.styleFrom(
                      minimumSize: const Size(0, 28),
                      padding: EdgeInsets.zero,
                      textStyle: const TextStyle(fontSize: 11),
                    ),
                    child: Text(
                      '已忽略 ${state.ignoredVersionTag} · 点击恢复提醒',
                    ),
                  ),
                ],
              ],
            ),
          ),
          if (check != null && check.releases.isNotEmpty)
            SectionCard(
              title: '可用版本',
              child: Column(
                children: check.releases
                    .map(
                      (LatestVersion v) => _releaseTile(
                        v,
                        latestBadge: v.version == check.latest.version,
                      ),
                    )
                    .toList(),
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
                const SizedBox(height: 8),
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
                      child: const Text('校验登录态',
                          style: TextStyle(fontSize: 12)),
                    ),
                  ],
                ),
              ],
            ),
          ),
          SectionCard(
            title: '关于 Cocoa',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                const Text(
                  'Cocoa 虚拟智能体陪伴系统 · Android 客户端',
                  style: TextStyle(fontSize: 11.5),
                ),
                const SizedBox(height: 4),
                Text(
                  '版本 $kAppVersion · 支持 Android 7.0 (API 24)+ · 每个角色的记忆与资产彼此独立',
                  style: const TextStyle(
                    fontSize: 10.5,
                    color: AppColors.inkSoft,
                  ),
                ),
                const SizedBox(height: 6),
                const Text(
                  '版本推送通过 GitHub Release 获取，下载地址使用 gh-proxy 加速镜像。',
                  style: TextStyle(
                    fontSize: 10.5,
                    color: AppColors.inkSoft,
                    height: 1.5,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
