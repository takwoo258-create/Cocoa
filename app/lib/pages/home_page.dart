import 'package:flutter/material.dart';

import '../core/app_state.dart';
import '../core/constants.dart';
import '../core/global.dart';
import '../core/native.dart';
import '../core/theme.dart';
import '../models/version_info.dart';
import 'admin/admin_page.dart';
import 'bookshelf_page.dart';
import 'character_list_page.dart';
import 'settings_page.dart';
import 'stats_page.dart';

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage>
    with SingleTickerProviderStateMixin {
  int _index = 0;
  late final AnimationController _tabFade;
  final GlobalKey<CharacterListPageState> _charsKey =
      GlobalKey<CharacterListPageState>();

  @override
  void initState() {
    super.initState();
    _tabFade = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 220),
      value: 1,
    );
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      AppScope.read(context).checkVersion();
    });
  }

  @override
  void dispose() {
    _tabFade.dispose();
    super.dispose();
  }

  void _selectTab(int index) {
    if (index == _index) return;
    setState(() => _index = index);
    _tabFade.forward(from: 0);
  }

  Future<void> _openRelease(LatestVersion version) async {
    final bool ok = await openExternalUrl(version.downloadUrl);
    if (!ok) {
      showToast('无法打开下载链接：${version.downloadUrl}', isError: true);
    }
  }

  Widget _versionBanner(AppState state) {
    final VersionCheckResult? check = state.versionCheck;
    if (check == null || !state.updateAvailable) return const SizedBox.shrink();
    final LatestVersion latest = check.latest;
    return Container(
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
                  '发现新版本 v${latest.version}',
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
                child: const Text('忽略此版本'),
              ),
              FilledButton(
                onPressed: () => _openRelease(latest),
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
                child: const Text('立即更新'),
              ),
            ],
          ),
        ],
      ),
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
    return Scaffold(
      appBar: AppBar(
        title: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            const Icon(Icons.coffee, size: 18, color: AppColors.cocoa),
            const SizedBox(width: 6),
            Text(
              _index == 0
                  ? 'Cocoa'
                  : <String>['Cocoa', '书架', '统计', '设置'][_index],
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
          ],
        ),
        actions: <Widget>[
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
        ],
      ),
      body: Column(
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
      ),
      bottomNavigationBar: NavigationBar(
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
