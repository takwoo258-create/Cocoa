import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../../core/app_state.dart';
import '../../core/appearance.dart';
import '../../core/global.dart';
import '../../core/layout.dart';
import '../../core/native.dart';
import '../../core/theme.dart';
import '../../widgets/common.dart';

/// v1.5.0：壁纸、字体、字号（实时演示）与动效限制。
class ThemePage extends StatefulWidget {
  const ThemePage({super.key});

  @override
  State<ThemePage> createState() => _ThemePageState();
}

class _ThemePageState extends State<ThemePage> {
  final ImagePicker _picker = ImagePicker();
  bool _loadingFont = false;

  Future<void> _pickWallpaper(bool chat) async {
    final XFile? picked =
        await _picker.pickImage(source: ImageSource.gallery);
    if (picked == null || !mounted) return;
    final AppState state = AppScope.read(context);
    if (chat) {
      await state.updateAppearance(
        chatWallpaper: 'image',
        chatWallpaperPath: picked.path,
      );
    } else {
      await state.updateAppearance(
        wallpaper: 'image',
        wallpaperPath: picked.path,
      );
    }
    if (mounted) setState(() {});
  }

  Future<void> _importFont() async {
    final AppState state = AppScope.read(context);
    setState(() => _loadingFont = true);
    try {
      final String? path = await pickFontFile();
      if (path == null || path.isEmpty) return;
      final bool ok = await loadImportedFont(path);
      if (!ok) {
        if (mounted) showToast('字体加载失败', isError: true);
        return;
      }
      await state.updateAppearance(fontFamily: 'CocoaImported', fontPath: path);
      if (mounted) {
        setState(() {});
        showToast('字体已应用');
      }
    } finally {
      if (mounted) setState(() => _loadingFont = false);
    }
  }

  Widget _wallpaperRow(
    AppState state, {
    required String title,
    required bool chat,
    required String value,
    String? path,
  }) {
    Widget chip(String key, String label) => ChoiceChip(
          label: Text(label, style: const TextStyle(fontSize: 10.5)),
          selected: value == key,
          onSelected: (_) async {
            if (chat) {
              await state.updateAppearance(chatWallpaper: key);
            } else {
              await state.updateAppearance(wallpaper: key);
            }
            if (mounted) setState(() {});
          },
        );
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(title, style: const TextStyle(fontSize: 12)),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: <Widget>[
              chip('none', '无'),
              chip('cream', '暖白'),
              chip('rose', '晚霞'),
              chip('night', '夜幕'),
              chip('image', '本地图片'),
              OutlinedButton(
                onPressed: _loadingFont ? null : () => _pickWallpaper(chat),
                style: OutlinedButton.styleFrom(
                  minimumSize: const Size(0, 32),
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                  textStyle: const TextStyle(fontSize: 10.5),
                ),
                child: const Text('选择图片'),
              ),
            ],
          ),
          if (path != null && path.isNotEmpty)
            Text(
              value == 'image' ? '图片：$path' : '已保存：$path',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 9, color: AppColors.inkSoft),
            ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final AppState state = AppScope.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('主题与外观')),
      body: ListView(
        padding: pagePadding(context),
        children: <Widget>[
          SectionCard(
            title: '壁纸',
            child: Column(
              children: <Widget>[
                _wallpaperRow(
                  state,
                  title: '设置主界面',
                  chat: false,
                  value: state.wallpaper,
                  path: state.wallpaperPath,
                ),
                _wallpaperRow(
                  state,
                  title: '聊天界面',
                  chat: true,
                  value: state.chatWallpaper,
                  path: state.chatWallpaperPath,
                ),
              ],
            ),
          ),
          SectionCard(
            title: '字体',
            trailing: TextButton(
              onPressed: _loadingFont ? null : _importFont,
              style: TextButton.styleFrom(
                minimumSize: const Size(0, 28),
                textStyle: const TextStyle(fontSize: 10.5),
              ),
              child: Text(_loadingFont ? '导入中…' : '导入字体文件'),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                DropdownButtonFormField<String>(
                  initialValue: state.fontFamily == 'CocoaImported' &&
                          (state.fontPath?.isNotEmpty ?? false)
                      ? 'CocoaImported'
                      : (state.fontFamily == 'serif' ||
                              state.fontFamily == 'monospace'
                          ? state.fontFamily
                          : 'system'),
                  decoration: const InputDecoration(labelText: '字体'),
                  items: <DropdownMenuItem<String>>[
                    const DropdownMenuItem<String>(
                      value: 'system',
                      child: Text('系统字体', style: TextStyle(fontSize: 12)),
                    ),
                    const DropdownMenuItem<String>(
                      value: 'serif',
                      child: Text('衬线体', style: TextStyle(fontSize: 12)),
                    ),
                    const DropdownMenuItem<String>(
                      value: 'monospace',
                      child: Text('等宽体', style: TextStyle(fontSize: 12)),
                    ),
                    if ((state.fontPath?.isNotEmpty ?? false))
                      const DropdownMenuItem<String>(
                        value: 'CocoaImported',
                        child: Text('已导入字体', style: TextStyle(fontSize: 12)),
                      ),
                  ],
                  onChanged: (String? v) async {
                    if (v == null) return;
                    await state.updateAppearance(fontFamily: v);
                    if (mounted) setState(() {});
                  },
                ),
                const SizedBox(height: 10),
                Row(
                  children: <Widget>[
                    const Text('字号', style: TextStyle(fontSize: 12)),
                    Expanded(
                      child: Slider(
                        value: state.fontScale.clamp(0.85, 1.4),
                        min: 0.85,
                        max: 1.4,
                        divisions: 11,
                        label: '${(state.fontScale * 100).round()}%',
                        onChanged: (double v) async {
                          await state.updateAppearance(fontScale: v);
                          if (mounted) setState(() {});
                        },
                      ),
                    ),
                    Text(
                      '${(state.fontScale * 100).round()}%',
                      style: const TextStyle(fontSize: 11),
                    ),
                  ],
                ),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: AppColors.cream,
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: AppColors.sand),
                  ),
                  child: Text(
                    '今晚的月亮很温柔，适合慢慢说一会儿话。\nThe quick brown fox jumps over the lazy dog. 0123456789',
                    style: appearancePreviewStyle(state).copyWith(
                      fontSize: 16 * state.fontScale,
                    ),
                  ),
                ),
              ],
            ),
          ),
          SectionCard(
            title: '动效限制',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                SegmentedButton<String>(
                  segments: const <ButtonSegment<String>>[
                    ButtonSegment<String>(value: 'off', label: Text('关闭')),
                    ButtonSegment<String>(value: 'reduced', label: Text('减弱')),
                    ButtonSegment<String>(value: 'normal', label: Text('正常')),
                  ],
                  selected: <String>{state.motion},
                  onSelectionChanged: (Set<String> v) async {
                    await state.updateAppearance(motion: v.first);
                    if (mounted) setState(() {});
                  },
                ),
                const SizedBox(height: 4),
                const Text(
                  '关闭后页面切换不再使用过渡动画；减弱保留淡入，正常使用完整动效。',
                  style: TextStyle(fontSize: 10.5, color: AppColors.inkSoft),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
