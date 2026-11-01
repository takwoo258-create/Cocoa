import 'package:flutter/material.dart';

/// 暖可可色系。
class AppColors {
  static const Color cocoa = Color(0xFF6F4E37);
  static const Color mocha = Color(0xFF8B5E3C);
  static const Color latte = Color(0xFFC9A27E);
  static const Color cream = Color(0xFFFBF3E9);
  static const Color sand = Color(0xFFF0E1D0);
  static const Color rose = Color(0xFFD98E73);
  static const Color ink = Color(0xFF3B2A21);
  static const Color inkSoft = Color(0xFF7A6558);
  static const Color white = Color(0xFFFFFFFF);
  static const Color success = Color(0xFF6F9E6F);
  static const Color warn = Color(0xFFC9843C);
  static const Color danger = Color(0xFFB3543F);
  static const Color bubbleAgent = Color(0xFFFFF8F0);
  static const Color bubbleUser = Color(0xFFE9D3BC);
  static const Color bubbleSubjective = Color(0xFFF7E3D8);
  static const Color bubbleNotice = Color(0xFFEDE3D8);
  static const Color canvasBg = Color(0xFF2A1E18);
}

const LinearGradient kCocoaGradient = LinearGradient(
  begin: Alignment.topLeft,
  end: Alignment.bottomRight,
  colors: <Color>[Color(0xFF8B5E3C), Color(0xFF6F4E37)],
);

const LinearGradient kRoseGradient = LinearGradient(
  begin: Alignment.topLeft,
  end: Alignment.bottomRight,
  colors: <Color>[Color(0xFFE8B49C), Color(0xFFD98E73)],
);

ThemeData buildAppTheme() {
  const ColorScheme scheme = ColorScheme.light(
    primary: AppColors.cocoa,
    onPrimary: AppColors.white,
    primaryContainer: AppColors.sand,
    onPrimaryContainer: AppColors.ink,
    secondary: AppColors.rose,
    onSecondary: AppColors.white,
    secondaryContainer: Color(0xFFF6E3D8),
    onSecondaryContainer: AppColors.ink,
    surface: AppColors.cream,
    onSurface: AppColors.ink,
    error: AppColors.danger,
    onError: AppColors.white,
  );

  final TextTheme text = ThemeData.light().textTheme.apply(
        bodyColor: AppColors.ink,
        displayColor: AppColors.ink,
      );

  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: AppColors.cream,
    dividerColor: AppColors.sand,
    visualDensity: VisualDensity.standard,
    textTheme: text,
    appBarTheme: const AppBarTheme(
      backgroundColor: AppColors.cream,
      foregroundColor: AppColors.ink,
      elevation: 0,
      centerTitle: true,
      titleTextStyle: TextStyle(
        color: AppColors.ink,
        fontSize: 18,
        fontWeight: FontWeight.w600,
      ),
    ),
    snackBarTheme: const SnackBarThemeData(
      backgroundColor: AppColors.ink,
      contentTextStyle: TextStyle(color: AppColors.white),
      behavior: SnackBarBehavior.floating,
    ),
    pageTransitionsTheme: const PageTransitionsTheme(
      builders: <TargetPlatform, PageTransitionsBuilder>{
        TargetPlatform.android: CocoaPageTransitionsBuilder(),
        TargetPlatform.iOS: CocoaPageTransitionsBuilder(),
        TargetPlatform.macOS: CocoaPageTransitionsBuilder(),
      },
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: AppColors.white,
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: const BorderSide(color: AppColors.sand),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: const BorderSide(color: AppColors.sand),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: const BorderSide(color: AppColors.cocoa, width: 1.6),
      ),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: AppColors.cocoa,
        foregroundColor: AppColors.white,
        minimumSize: const Size(0, 48),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: AppColors.cocoa,
        side: const BorderSide(color: AppColors.latte),
        minimumSize: const Size(0, 46),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(foregroundColor: AppColors.cocoa),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: AppColors.white,
      indicatorColor: AppColors.sand,
      elevation: 2,
      labelTextStyle: WidgetStateProperty.all(
        const TextStyle(fontSize: 12, fontWeight: FontWeight.w500),
      ),
    ),
    tabBarTheme: const TabBarThemeData(
      labelColor: AppColors.cocoa,
      unselectedLabelColor: AppColors.inkSoft,
      indicatorColor: AppColors.cocoa,
      indicatorSize: TabBarIndicatorSize.label,
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: AppColors.cream,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(22)),
    ),
    bottomSheetTheme: const BottomSheetThemeData(
      backgroundColor: AppColors.cream,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
    ),
    switchTheme: SwitchThemeData(
      thumbColor: WidgetStateProperty.resolveWith((Set<WidgetState> s) {
        if (s.contains(WidgetState.selected)) return AppColors.white;
        return AppColors.white;
      }),
      trackColor: WidgetStateProperty.resolveWith((Set<WidgetState> s) {
        if (s.contains(WidgetState.selected)) return AppColors.cocoa;
        return AppColors.sand;
      }),
    ),
    progressIndicatorTheme: const ProgressIndicatorThemeData(
      color: AppColors.cocoa,
      linearTrackColor: AppColors.sand,
    ),
  );
}

/// v1.0.1：页面切换动效（淡入 + 轻微右滑）。
class CocoaPageTransitionsBuilder extends PageTransitionsBuilder {
  const CocoaPageTransitionsBuilder();

  @override
  Widget buildTransitions<T>(
    PageRoute<T> route,
    BuildContext context,
    Animation<double> animation,
    Animation<double> secondaryAnimation,
    Widget child,
  ) {
    final Animation<double> curved = CurvedAnimation(
      parent: animation,
      curve: Curves.easeOutCubic,
      reverseCurve: Curves.easeInCubic,
    );
    return FadeTransition(
      opacity: curved,
      child: SlideTransition(
        position: Tween<Offset>(
          begin: const Offset(0.05, 0),
          end: Offset.zero,
        ).animate(curved),
        child: child,
      ),
    );
  }
}
