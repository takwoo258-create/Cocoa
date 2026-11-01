import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:just_audio/just_audio.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart' as rec;

import '../core/api_client.dart';
import '../core/app_state.dart';
import '../core/json_utils.dart';
import '../core/theme.dart';

/// v1.2.0：TTS / STT 连通性测试（服务配置页）。
class VoiceTestPanel extends StatefulWidget {
  const VoiceTestPanel({super.key, required this.service});

  /// 'tts' 或 'stt'
  final String service;

  @override
  State<VoiceTestPanel> createState() => _VoiceTestPanelState();
}

class _VoiceTestPanelState extends State<VoiceTestPanel> {
  AudioPlayer? _player;
  rec.AudioRecorder? _recorder;
  bool _busy = false;
  String? _status;
  bool _statusOk = false;

  @override
  void dispose() {
    _player?.dispose();
    _recorder?.dispose();
    super.dispose();
  }

  void _setStatus(String text, bool ok) {
    if (!mounted) return;
    setState(() {
      _status = text;
      _statusOk = ok;
    });
  }

  Future<void> _testTts() async {
    final AppState state = AppScope.read(context);
    final TextEditingController ctrl = TextEditingController(
      text: '你好，我是可可，这是语音合成测试。',
    );
    final String? text = await showDialog<String>(
      context: context,
      builder: (BuildContext ctx) => AlertDialog(
        title: const Text('测试语音合成'),
        content: TextField(
          controller: ctrl,
          maxLines: 3,
          decoration: const InputDecoration(
            labelText: '合成文本',
            alignLabelWithHint: true,
          ),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(ctrl.text.trim()),
            child: const Text('合成并播放'),
          ),
        ],
      ),
    );
    ctrl.dispose();
    if (text == null || text.isEmpty) return;
    setState(() => _busy = true);
    try {
      final Map<String, dynamic> r = await state.configService.testTts(text);
      final String url = asString(r['url']);
      if (!asBool(r['ok']) || url.isEmpty) {
        _setStatus('合成失败', false);
        return;
      }
      final String full = url.startsWith('http')
          ? url
          : '${ApiClient.normalizeBase(state.baseUrl)}$url';
      _player ??= AudioPlayer();
      await _player!.stop();
      await _player!.setUrl(
        full,
        headers: state.token == null
            ? null
            : <String, String>{'Authorization': 'Bearer ${state.token}'},
      );
      unawaited(_player!.play());
      _setStatus(
        '合成成功 · ${asString(r['mime'], 'audio')} · ${asInt(r['bytes'])} bytes',
        true,
      );
    } on ApiException catch (e) {
      _setStatus('合成失败：${e.message}', false);
    } catch (e) {
      _setStatus('合成失败：$e', false);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _testStt() async {
    final AppState state = AppScope.read(context);
    setState(() => _busy = true);
    try {
      _recorder ??= rec.AudioRecorder();
      final bool ok = await _recorder!.hasPermission();
      if (!ok) {
        _setStatus('需要麦克风权限', false);
        return;
      }
      final Directory dir = await getTemporaryDirectory();
      final String path =
          '${dir.path}/cocoa_stt_${DateTime.now().millisecondsSinceEpoch}.m4a';
      await _recorder!.start(
        const rec.RecordConfig(encoder: rec.AudioEncoder.aacLc),
        path: path,
      );
      _setStatus('录音中，请说一句话（3 秒）…', true);
      await Future<void>.delayed(const Duration(seconds: 3));
      final String? filePath = await _recorder!.stop();
      if (filePath == null || !File(filePath).existsSync()) {
        _setStatus('录音失败', false);
        return;
      }
      _setStatus('识别中…', true);
      final Map<String, dynamic> r = await state.configService.testStt(filePath);
      final String text = asString(r['text']);
      if (!asBool(r['ok'])) {
        _setStatus('识别失败', false);
        return;
      }
      _setStatus('识别成功：$text', true);
      if (mounted) {
        await showDialog<void>(
          context: context,
          builder: (BuildContext ctx) => AlertDialog(
            title: const Text('语音识别结果'),
            content: SelectableText(
              text.isEmpty ? '（无文本）' : text,
              style: const TextStyle(fontSize: 13, height: 1.6),
            ),
            actions: <Widget>[
              TextButton(
                onPressed: () => Navigator.of(ctx).pop(),
                child: const Text('关闭'),
              ),
            ],
          ),
        );
      }
    } on ApiException catch (e) {
      _setStatus('识别失败：${e.message}', false);
    } catch (e) {
      _setStatus('识别失败：$e', false);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final bool tts = widget.service == 'tts';
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: AppColors.cream,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppColors.sand),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Icon(
                tts ? Icons.graphic_eq : Icons.mic_none,
                size: 15,
                color: AppColors.cocoa,
              ),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  tts ? '语音合成测试（会尝试播放）' : '语音识别测试（录音 3 秒）',
                  style: const TextStyle(fontSize: 11.5),
                ),
              ),
              OutlinedButton(
                onPressed: _busy ? null : (tts ? _testTts : _testStt),
                style: OutlinedButton.styleFrom(
                  minimumSize: const Size(0, 32),
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                  textStyle: const TextStyle(fontSize: 11),
                ),
                child: _busy
                    ? const SizedBox(
                        width: 13,
                        height: 13,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : Text(tts ? '测试语音合成' : '测试语音识别'),
              ),
            ],
          ),
          if (_status != null)
            Padding(
              padding: const EdgeInsets.only(top: 5),
              child: Text(
                _status!,
                style: TextStyle(
                  fontSize: 10.5,
                  color: _statusOk ? AppColors.success : AppColors.danger,
                ),
              ),
            ),
        ],
      ),
    );
  }
}
