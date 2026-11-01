import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'core/app_state.dart';
import 'core/global.dart';
import 'core/layout.dart';
import 'core/theme.dart';
import 'pages/app_entry.dart';
import 'pages/login_page.dart';
import 'pages/splash_page.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const CocoaApp());
}

class CocoaApp extends StatefulWidget {
  const CocoaApp({super.key});

  @override
  State<CocoaApp> createState() => _CocoaAppState();
}

class _CocoaAppState extends State<CocoaApp> {
  final AppState _state = AppState();

  @override
  void initState() {
    super.initState();
    _state.onNeedLogin = () {
      final NavigatorState? nav = appNavigatorKey.currentState;
      if (nav == null) return;
      nav.pushAndRemoveUntil(
        MaterialPageRoute<void>(builder: (_) => const LoginPage()),
        (Route<dynamic> route) => false,
      );
    };
    _state.boot();
  }

  @override
  void dispose() {
    _state.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AppScope(
      state: _state,
      child: MaterialApp(
        title: 'Cocoa',
        debugShowCheckedModeBanner: false,
        navigatorKey: appNavigatorKey,
        scaffoldMessengerKey: appMessengerKey,
        theme: buildAppTheme(),
        locale: const Locale('zh', 'CN'),
        supportedLocales: const <Locale>[
          Locale('zh', 'CN'),
          Locale('en', 'US'),
        ],
        localizationsDelegates: const <LocalizationsDelegate<dynamic>>[
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        // v1.1.0：手机锁竖屏、平板允许横竖屏，随尺寸变化重新应用。
        builder: (BuildContext context, Widget? child) => OrientationGate(
          child: child ?? const SizedBox.shrink(),
        ),
        home: const SplashPage(),
      ),
    );
  }
}

/// 保留给后续路由扩展：登录成功统一走 enterApp。
Future<void> pushHome(BuildContext context) => enterApp(context);
