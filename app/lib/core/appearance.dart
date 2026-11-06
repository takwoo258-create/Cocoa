import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'app_state.dart';
import 'theme.dart';

/// v1.5.0：内置/本地图片壁纸与导入字体。
BoxDecoration? appearanceDecoration(
  AppState state, {
  bool chat = false,
}) {
  final String choice = chat ? state.chatWallpaper : state.wallpaper;
  final String? path = chat ? state.chatWallpaperPath : state.wallpaperPath;
  if (choice == 'none') return null;
  if (choice == 'image' && path != null && path.isNotEmpty) {
    final File f = File(path);
    if (f.existsSync()) {
      return BoxDecoration(
        image: DecorationImage(
          image: FileImage(f),
          fit: BoxFit.cover,
          colorFilter: ColorFilter.mode(
            Colors.white.withAlpha(30),
            BlendMode.srcOver,
          ),
        ),
      );
    }
  }
  switch (choice) {
    case 'cream':
      return const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: <Color>[AppColors.cream, AppColors.sand],
        ),
      );
    case 'rose':
      return const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: <Color>[Color(0xFFF9E6DC), Color(0xFFEBC7B4)],
        ),
      );
    case 'night':
      return const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: <Color>[Color(0xFF1B222C), Color(0xFF3B2A2A)],
        ),
      );
    default:
      return null;
  }
}

/// 加载用户导入的 ttf/otf 为 CocoaImported 字体。
Future<bool> loadImportedFont(String path) async {
  try {
    final File f = File(path);
    if (!f.existsSync()) return false;
    final ByteData data = ByteData.view((await f.readAsBytes()).buffer);
    final FontLoader loader = FontLoader('CocoaImported')
      ..addFont(Future<ByteData>.value(data));
    await loader.load();
    return true;
  } catch (_) {
    return false;
  }
}

/// 预览文字用。
TextStyle appearancePreviewStyle(AppState state) => TextStyle(
      fontFamily: state.fontFamily == 'system' ? null : state.fontFamily,
      fontSize: 16,
      height: 1.6,
      color: AppColors.ink,
    );
