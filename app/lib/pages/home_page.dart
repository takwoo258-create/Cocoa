import 'package:flutter/material.dart';

import '../core/app_state.dart';
import '../core/global.dart';
import '../core/theme.dart';
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

class _HomePageState extends State<HomePage> {
  int _index = 0;
  final GlobalKey<CharacterListPageState> _charsKey =
      GlobalKey<CharacterListPageState>();

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
              _index == 0 ? 'Cocoa' : <String>['Cocoa', '书架', '统计', '设置'][_index],
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
      body: IndexedStack(index: _index, children: pages),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (int i) {
          setState(() => _index = i);
        },
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
