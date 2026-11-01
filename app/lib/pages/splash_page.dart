import 'package:flutter/material.dart';

import '../core/app_state.dart';
import '../core/global.dart';
import '../core/theme.dart';
import 'app_entry.dart';
import 'login_page.dart';

class SplashPage extends StatefulWidget {
  const SplashPage({super.key});

  @override
  State<SplashPage> createState() => _SplashPageState();
}

class _SplashPageState extends State<SplashPage> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _run());
  }

  Future<void> _run() async {
    final AppState state = AppScope.read(context);
    int ticks = 0;
    while (state.booting && ticks < 375) {
      await Future<void>.delayed(const Duration(milliseconds: 80));
      ticks++;
    }
    if (!mounted) return;
    if (state.booting) {
      showToast('连接服务超时，请检查服务地址或网络', isError: true);
    }
    if (!state.loggedIn) {
      Navigator.of(context).pushReplacement(
        MaterialPageRoute<void>(builder: (_) => const LoginPage()),
      );
      return;
    }
    await enterApp(context);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Container(
        decoration: const BoxDecoration(gradient: kCocoaGradient),
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Container(
                width: 96,
                height: 96,
                decoration: BoxDecoration(
                  color: Colors.white.withAlpha(30),
                  shape: BoxShape.circle,
                ),
                child: const Icon(
                  Icons.favorite,
                  color: Colors.white,
                  size: 46,
                ),
              ),
              const SizedBox(height: 18),
              const Text(
                'Cocoa',
                style: TextStyle(
                  color: Colors.white,
                  fontSize: 30,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 2,
                ),
              ),
              const SizedBox(height: 6),
              Text(
                '把日常的温柔，慢慢讲给你听',
                style: TextStyle(
                  color: Colors.white.withAlpha(200),
                  fontSize: 12.5,
                  letterSpacing: 1,
                ),
              ),
              const SizedBox(height: 30),
              const SizedBox(
                width: 22,
                height: 22,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: Colors.white,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
