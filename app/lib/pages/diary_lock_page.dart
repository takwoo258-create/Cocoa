import 'package:flutter/material.dart';

import '../core/app_state.dart';
import '../core/theme.dart';

/// v1.5.0：日记解锁全屏页，6 位分格 + 内置数字键盘 + 自动校验。
class DiaryLockPage extends StatefulWidget {
  const DiaryLockPage({
    super.key,
    required this.characterId,
    this.hint = '',
  });

  final String characterId;
  final String hint;

  @override
  State<DiaryLockPage> createState() => _DiaryLockPageState();
}

class _DiaryLockPageState extends State<DiaryLockPage> {
  String _digits = '';
  bool _busy = false;
  String? _error;

  Future<void> _append(String d) async {
    if (_busy || _digits.length >= 6) return;
    setState(() {
      _digits += d;
      _error = null;
    });
    if (_digits.length == 6) await _submit();
  }

  Future<void> _submit() async {
    final AppState state = AppScope.read(context);
    setState(() => _busy = true);
    try {
      final result = await state.bookService.unlockDiary(
        characterId: widget.characterId,
        password: _digits,
      );
      if (!mounted) return;
      if (result.ok) {
        Navigator.of(context).pop(_digits);
      } else {
        setState(() {
          _error = '密码不正确，再想想角色给的线索';
          _digits = '';
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = '解锁失败：$e';
          _digits = '';
        });
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _dot(int i) {
    final bool filled = i < _digits.length;
    return Container(
      width: 38,
      height: 46,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: filled ? AppColors.cocoa.withAlpha(28) : Colors.transparent,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(
          color: filled ? AppColors.cocoa : AppColors.sand,
          width: 1.4,
        ),
      ),
      child: filled
          ? const Icon(Icons.circle, size: 9, color: AppColors.cocoa)
          : null,
    );
  }

  Widget _key(String value, {IconData? icon}) {
    return InkWell(
      onTap: _busy
          ? null
          : () {
              if (value == 'back') {
                if (_digits.isNotEmpty) {
                  setState(() => _digits =
                      _digits.substring(0, _digits.length - 1));
                }
              } else {
                _append(value);
              }
            },
      borderRadius: BorderRadius.circular(14),
      child: Container(
        height: 56,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: AppColors.white,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: AppColors.sand),
        ),
        child: icon != null
            ? Icon(icon, size: 21, color: AppColors.ink)
            : Text(
                value,
                style: const TextStyle(
                  fontSize: 20,
                  fontWeight: FontWeight.w600,
                ),
              ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final List<String> keys = <String>[
      '1','2','3','4','5','6','7','8','9','','0','back'
    ];
    return Scaffold(
      backgroundColor: AppColors.cream,
      appBar: AppBar(
        title: const Text('日记本'),
        leading: IconButton(
          icon: const Icon(Icons.close),
          onPressed: () => Navigator.of(context).pop(),
        ),
      ),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(28, 10, 28, 18),
          child: Column(
            children: <Widget>[
              const SizedBox(height: 10),
              const Icon(Icons.lock_outline, size: 32, color: AppColors.cocoa),
              const SizedBox(height: 8),
              const Text(
                '日记是角色的隐私',
                style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: 4),
              const Text(
                '输入 6 位数字密码，满 6 位自动校验',
                style: TextStyle(fontSize: 11, color: AppColors.inkSoft),
              ),
              const SizedBox(height: 20),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                children: List<Widget>.generate(6, _dot),
              ),
              if (_error != null) ...<Widget>[
                const SizedBox(height: 12),
                Text(
                  _error!,
                  textAlign: TextAlign.center,
                  style: const TextStyle(fontSize: 11.5, color: AppColors.danger),
                ),
              ],
              if (widget.hint.isNotEmpty) ...<Widget>[
                const SizedBox(height: 12),
                Container(
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: AppColors.rose.withAlpha(18),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Text(
                    '今日线索：${widget.hint}',
                    textAlign: TextAlign.center,
                    style: const TextStyle(fontSize: 11.5, color: AppColors.rose),
                  ),
                ),
              ],
              const Spacer(),
              if (_busy)
                const Padding(
                  padding: EdgeInsets.only(bottom: 10),
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              GridView.count(
                crossAxisCount: 3,
                shrinkWrap: true,
                mainAxisSpacing: 10,
                crossAxisSpacing: 12,
                childAspectRatio: 1.55,
                physics: const NeverScrollableScrollPhysics(),
                children: keys.map((String key) {
                  if (key.isEmpty) return const SizedBox.shrink();
                  if (key == 'back') {
                    return _key(key, icon: Icons.backspace_outlined);
                  }
                  return _key(key);
                }).toList(),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
