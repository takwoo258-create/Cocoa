import 'dart:async';

import 'package:flutter/material.dart';

import '../core/app_state.dart';
import '../core/constants.dart';
import '../core/global.dart';
import '../core/layout.dart';
import '../core/json_utils.dart';
import '../core/theme.dart';
import '../core/ws_service.dart';
import '../models/model_share.dart';
import '../models/version_info.dart';
import '../widgets/share_pending_dialog.dart';
import '../widgets/update_dialog.dart';
import 'admin/admin_page.dart';
import 'bookshelf_page.dart';
import 'character_list_page.dart';
import 'settings/plaza_page.dart';
import 'settings_page.dart';
import 'stats_page.dart';

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage>
    with SingleTickerProviderStateMixin, WidgetsBindingObserver {
  int _index = 0;
  late final AnimationController _tabFade;
  final GlobalKey<CharacterListPageState> _charsKey =
      GlobalKey<CharacterListPageState>();
  StreamSubscription<WsEvent>? _wsSub;
  bool _shareDialogOpen = false;

  static const List<String> _titles = <String>['Cocoa', '书架', '统计', '设置'];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _tabFade = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 220),
      value: 1,
    );
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _initVersion();
      _initShares();
      _listenWs();
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _wsSub?.cancel();
    _tabFade.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) return;
    // 回到前台时重新检查更新（checkVersion 自带 10 分钟节流）。
    _initVersion();
  }

  Future<void> _initVersion() async {
    if (!mounted) return;
    final AppState state = AppScope.read(context);
    await state.checkVersion();
    if (!mounted) return;
    _maybeShowForce(state);
  }

  void _listenWs() {
    final AppState state = AppScope.read(context);
    _wsSub = state.ws.events.listen((WsEvent event) {
      switch (event.type) {
        case 'share_request':
          showToast('收到新的模型分享请求');
          _initShares();
          break;
        case 'share_result':
          final ModelShare share = ModelShare.fromJson(asMap(event.data['share']));
          final bool accepted = share.status == 'accepted';
          showToast(
            share.direction == 'request'
                ? (accepted ? '对方接受了你的索要' : '对方拒绝了你的索要')
                : (accepted ? '对方接受了你的分享' : '对方拒绝了你的分享'),
          );
          break;
        case 'share_expired':
          final ModelShare share = ModelShare.fromJson(asMap(event.data['share']));
          showToast(
            '模型分享已到期：${share.services.isEmpty ? '' : share.services.join('、')}',
          );
          break;
        case 'qq_binding':
          showToast('QQ 接入角色已更新');
          break;
        case 'plaza_used':
        case 'plaza_quota':
        case 'plaza_expiring':
        case 'plaza_expired':
        case 'plaza_banned':
          state.handlePlazaEvent(
            event.type,
            event.data,
            onOpenPlaza: () {
              Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => const PlazaPage(),
                ),
              );
            },
          );
          break;
        default:
          break;
      }
    });
  }

  Future<void> _initShares() async {
    if (!mounted || _shareDialogOpen) return;
    final AppState state = AppScope.read(context);
    if (state.forceUpdateAvailable) return;
    try {
      final List<ModelShare> pending = await state.shareService.pending();
      if (!mounted || pending.isEmpty) return;
      _shareDialogOpen = true;
      await showSharePendingDialog(context, shares: pending);
      _shareDialogOpen = false;
    } catch (_) {
      _shareDialogOpen = false;
    }
  }

  void _maybeShowForce(AppState state) {
    final VersionCheckResult? check = state.versionCheck;
    if (check == null || !state.forceUpdateAvailable) return;
    UpdateDialog.show(context, check: check);
  }

  void _selectTab(int index) {
    if (index == _index) return;
    setState(() => _index = index);
    _tabFade.forward(from: 0);
  }

  Widget _versionBanner(AppState state) {
    final VersionCheckResult? check = state.versionCheck;
    if (check == null || !state.updateAvailable) return const SizedBox.shrink();
    final LatestVersion latest = check.latest;
    return GestureDetector(
      onTap: () => UpdateDialog.show(context, check: check),
      child: Container(
      margin: const EdgeInsets.fromLTRB(12, 8, 12, 0),
      padding: const EdgeInsets.fromLTRB(12, 10, 8, 8),
      decoration: BoxDecoration(
        gradient: kCocoaGradient,
        borderRadius: BorderRadius.circular(14),
        boxShadow: <BoxShadow>[
          BoxShadow(
            color: AppColors.cocoa.withAlpha(60),
            blurRadius: 12,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              const Icon(Icons.new_releases_outlined,
                  size: 16, color: Colors.white),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  '发现新版本 ${latest.displayLabel}',
                  style: const TextStyle(
                    color: Colors.white,
                    fontSize: 12.5,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              IconButton(
                visualDensity: VisualDensity.compact,
                tooltip: '忽略该版本',
                icon: const Icon(Icons.close, size: 16, color: Colors.white),
                onPressed: () => state.ignoreVersion(latest.tag),
              ),
            ],
          ),
          if (latest.notesSummary.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(left: 22, right: 4, bottom: 4),
              child: Text(
                latest.notesSummary,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: Colors.white.withAlpha(220),
                  fontSize: 10.5,
                  height: 1.45,
                ),
              ),
            ),
          Row(
            children: <Widget>[
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.only(left: 22),
                  child: Text(
                    '当前 v$kAppVersion · 来源 ${check.source}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: Colors.white.withAlpha(170),
                      fontSize: 9.5,
                    ),
                  ),
                ),
              ),
              TextButton(
                onPressed: () => state.ignoreVersion(latest.tag),
                style: TextButton.styleFrom(
                  minimumSize: const Size(0, 30),
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  foregroundColor: Colors.white,
                  textStyle: const TextStyle(fontSize: 11),
                ),
                child: const Text('下次再提醒'),
              ),
              FilledButton(
                onPressed: () => UpdateDialog.show(context, check: check),
                style: FilledButton.styleFrom(
                  backgroundColor: Colors.white,
                  foregroundColor: AppColors.cocoa,
                  minimumSize: const Size(0, 30),
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  textStyle: const TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                child: const Text('查看更新'),
              ),
            ],
          ),
        ],
      ),
      ),
    );
  }

  List<Widget> _appBarActions(AppState state) {
    return <Widget>[
      if (state.isAdmin && _index == 0)
        IconButton(
          tooltip: '管理端',
          icon: const Icon(Icons.shield_outlined, size: 20),
          onPressed: () {
            Navigator.of(context).push(
              MaterialPageRoute<void>(builder: (_) => const AdminPage()),
            );
          },
        ),
      if (_index == 0)
        IconButton(
          tooltip: '刷新角色',
          icon: const Icon(Icons.refresh, size: 20),
          onPressed: () => _charsKey.currentState?.reload(),
        ),
      if (_index == 0)
        IconButton(
          tooltip: '创建角色',
          icon: const Icon(Icons.add_circle_outline, size: 21),
          onPressed: () async {
            await _charsKey.currentState?.createCharacter();
          },
        ),
    ];
  }

  Widget _content(AppState state, List<Widget> pages) {
    return Column(
      children: <Widget>[
        _versionBanner(state),
        Expanded(
          child: FadeTransition(
            opacity: CurvedAnimation(
              parent: _tabFade,
              curve: Curves.easeOut,
            ),
            child: IndexedStack(index: _index, children: pages),
          ),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final AppState state = AppScope.of(context);
    final List<Widget> pages = <Widget>[
      CharacterListPage(key: _charsKey),
      const BookshelfPage(),
      const StatsPage(),
      const SettingsPage(),
    ];
    if (_index >= pages.length) _index = 0;
    final bool useRail = Breakpoints.isTablet(context);
    final Widget body = _content(state, pages);
    return Scaffold(
      appBar: AppBar(
        title: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            const Icon(Icons.coffee, size: 18, color: AppColors.cocoa),
            const SizedBox(width: 6),
            Text(
              _titles[_index],
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
          ],
        ),
        actions: _appBarActions(state),
      ),
      body: useRail
          ? Row(
              children: <Widget>[
                NavigationRail(
                  selectedIndex: _index,
                  onDestinationSelected: _selectTab,
                  labelType: NavigationRailLabelType.all,
                  backgroundColor: AppColors.white,
                  indicatorColor: AppColors.sand,
                  leading: const Padding(
                    padding: EdgeInsets.symmetric(vertical: 10),
                    child: Icon(Icons.coffee, color: AppColors.cocoa, size: 24),
                  ),
                  destinations: const <NavigationRailDestination>[
                    NavigationRailDestination(
                      icon: Icon(Icons.favorite_border),
                      selectedIcon: Icon(Icons.favorite),
                      label: Text('角色'),
                    ),
                    NavigationRailDestination(
                      icon: Icon(Icons.menu_book_outlined),
                      selectedIcon: Icon(Icons.menu_book),
                      label: Text('书架'),
                    ),
                    NavigationRailDestination(
                      icon: Icon(Icons.insights_outlined),
                      selectedIcon: Icon(Icons.insights),
                      label: Text('统计'),
                    ),
                    NavigationRailDestination(
                      icon: Icon(Icons.settings_outlined),
                      selectedIcon: Icon(Icons.settings),
                      label: Text('设置'),
                    ),
                  ],
                ),
                const VerticalDivider(width: 1, color: AppColors.sand),
                Expanded(child: body),
              ],
            )
          : body,
      bottomNavigationBar: useRail
          ? null
          : NavigationBar(
              selectedIndex: _index,
              onDestinationSelected: _selectTab,
              destinations: const <NavigationDestination>[
                NavigationDestination(
                  icon: Icon(Icons.favorite_border),
                  selectedIcon: Icon(Icons.favorite),
                  label: '角色',
                ),
                NavigationDestination(
                  icon: Icon(Icons.menu_book_outlined),
                  selectedIcon: Icon(Icons.menu_book),
                  label: '书架',
                ),
                NavigationDestination(
                  icon: Icon(Icons.insights_outlined),
                  selectedIcon: Icon(Icons.insights),
                  label: '统计',
                ),
                NavigationDestination(
                  icon: Icon(Icons.settings_outlined),
                  selectedIcon: Icon(Icons.settings),
                  label: '设置',
                ),
              ],
            ),
    );
  }
}

/// 通用的“没有角色”引导。
void showNeedCharacterToast() {
  showToast('请先创建一个角色');
}
