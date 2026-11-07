import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart' as rec;

import '../core/app_state.dart';
import '../core/appearance.dart';
import '../core/constants.dart';
import '../core/global.dart';
import '../core/json_utils.dart';
import '../core/layout.dart';
import '../core/motion.dart';
import '../core/theme.dart';
import '../core/utils.dart';
import '../core/ws_service.dart';
import '../models/character.dart';
import '../models/chat_message.dart';
import '../widgets/common.dart';
import '../widgets/context_gauge.dart';
import '../widgets/message_bubble.dart';
import '../widgets/status_card.dart';
import 'character_settings_page.dart';
import 'character_status_page.dart';
import 'memory_page.dart';

class ChatPage extends StatefulWidget {
  const ChatPage({super.key, required this.character});

  final Character character;

  @override
  State<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<ChatPage> {
  final ScrollController _scroll = ScrollController();
  final TextEditingController _input = TextEditingController();
  final rec.AudioRecorder _recorder = rec.AudioRecorder();

  late CharacterState _state;
  List<ChatMessage> _messages = <ChatMessage>[];
  ContextUsage _context = const ContextUsage();
  bool _loading = true;
  bool _sending = false;
  bool _typing = false;
  String? _typingStage;
  bool _enabled = true;
  bool _recording = false;
  bool _connected = false;
  DateTime? _recordStartedAt;
  AppState? _app;

  StreamSubscription<WsEvent>? _sub;
  final List<Timer> _timers = <Timer>[];
  final List<ChatMessage> _segmentQueue = <ChatMessage>[];
  final Set<String> _seenMessageIds = <String>{};
  Timer? _segmentTimer;
  bool _segmentActive = false;

  @override
  void initState() {
    super.initState();
    _state = widget.character.state;
    _enabled = widget.character.settings.enabled;
    WidgetsBinding.instance.addPostFrameCallback((_) => _bootstrap());
  }

  void _bootstrap() {
    if (!mounted) return;
    final AppState state = AppScope.read(context);
    _app = state;
    state.connectWs();
    _sub = state.ws.events.listen(_onWsEvent);
    state.ws.status.addListener(_onWsStatus);
    _connected = state.ws.connected;
    _load();
  }

  void _onWsStatus() {
    if (!mounted) return;
    setState(() => _connected = AppScope.read(context).ws.connected);
  }

  @override
  void dispose() {
    _sub?.cancel();
    _app?.ws.status.removeListener(_onWsStatus);
    for (final Timer t in _timers) {
      t.cancel();
    }
    _segmentTimer?.cancel();
    _recorder.dispose();
    _scroll.dispose();
    _input.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final AppState state = AppScope.read(context);
    try {
      final List<ChatMessage> history =
          await state.chatService.history(widget.character.id, limit: 60);
      ContextUsage ctx = const ContextUsage();
      CharacterState? latest;
      try {
        ctx = await state.chatService.context(widget.character.id);
      } catch (_) {
        // 调试接口未就绪时忽略
      }
      try {
        latest = await state.characterService.getState(widget.character.id);
      } catch (_) {
        // 用列表里的状态兜底
      }
      if (!mounted) return;
      setState(() {
        _messages = history;
        _context = ctx;
        if (latest != null) _state = latest;
        _loading = false;
      });
      _scrollToBottom(animate: false);
    } catch (e) {
      if (mounted) setState(() => _loading = false);
      showToast('聊天记录加载失败：$e', isError: true);
    }
  }

  void _onWsEvent(WsEvent event) {
    final Map<String, dynamic> d = event.data;
    switch (event.type) {
      case 'ready':
        // 服务端连接就绪：WS 状态由 status notifier 驱动，这里刷新连接标记。
        setState(() => _connected = true);
        break;
      case 'message':
        // v1.3.0 一次性下发：{content, agent:[{content,wait}], devide}
        final List<dynamic> parts = asList(d['agent']);
        if (parts.isNotEmpty) {
          final String baseId = asString(
            asMap(d['message'])['id'],
            'agent_${DateTime.now().microsecondsSinceEpoch}',
          );
          final int total = asInt(d['devide'], parts.length);
          for (int i = 0; i < parts.length; i++) {
            final Map<String, dynamic> part = asMap(parts[i]);
            final String content = asString(part['content']);
            if (content.isEmpty) continue;
            _enqueueAgent(ChatMessage(
              id: '${baseId}_seg${i + 1}',
              role: 'agent',
              content: content,
              createdAt: asString(asMap(d['message'])['createdAt']),
              meta: <String, dynamic>{
                'segment': i + 1,
                'segments': total,
                'wait': asInt(part['wait']),
              },
            ));
          }
          break;
        }
        final List<dynamic> batch = asList(
          d['messages'] is List
              ? d['messages']
              : (d['segments'] is List ? d['segments'] : const <dynamic>[]),
        );
        if (batch.isNotEmpty) {
          for (final dynamic raw in batch) {
            final ChatMessage part = ChatMessage.fromJson(asMap(raw));
            if (part.content.isEmpty && !part.isImage && !part.isVoice) continue;
            _enqueueAgent(part);
          }
          break;
        }
        final Map<String, dynamic> rawMessage = asMap(d['message']);
        final ChatMessage msg = rawMessage.isEmpty
            ? ChatMessage(
                id: 'agent_${DateTime.now().microsecondsSinceEpoch}',
                role: 'agent',
                content: asString(d['content']),
                createdAt: asString(d['createdAt']),
              )
            : ChatMessage.fromJson(rawMessage);
        if (msg.content.isEmpty && !msg.isImage && !msg.isVoice) break;
        _enqueueAgent(msg);
        break;
      case 'typing':
        final String cid = asString(d['characterId']);
        if (cid.isNotEmpty && cid != widget.character.id) break;
        final bool typing = asBool(d['typing']);
        setState(() {
          _typing = typing;
          _typingStage = typing ? asStringOrNull(d['stage']) : null;
        });
        break;
      case 'notice':
        _appendNotice(asString(d['content']));
        if (asString(d['content']).contains('记忆')) {
          setState(() => _context = ContextUsage(
                used: _context.used,
                limit: _context.limit,
                percent: _context.percent,
                compressing: true,
              ));
        }
        break;
      case 'context':
        setState(() => _context = ContextUsage.fromJson(d));
        break;
      case 'state':
        final Map<String, dynamic> s = asMap(d['state']);
        if (s.isNotEmpty) {
          setState(() => _state = CharacterState.fromJson(s));
        }
        break;
      case 'profile':
        _appendNotice('人物画像已更新');
        break;
      case 'subjective':
        final String content = asString(d['content']);
        if (content.isNotEmpty) {
          _scheduleSubjective(content, asInt(d['sendsec']));
        }
        break;
      case 'error':
        showToast(asString(d['message'], '实时通道出错'), isError: true);
        break;
      default:
        break;
    }
  }

  void _scheduleSubjective(String content, int seconds) {
    final ChatMessage msg = ChatMessage(
      id: 'subjective_${DateTime.now().microsecondsSinceEpoch}',
      role: 'subjective',
      content: content,
      createdAt: DateTime.now().toUtc().toIso8601String(),
      sendAt: DateTime.now().add(Duration(seconds: seconds < 0 ? 0 : seconds)),
    );
    if (seconds <= 0) {
      _appendMessage(msg);
      return;
    }
    _timers.add(Timer(Duration(seconds: seconds), () {
      if (!mounted) return;
      _appendMessage(msg);
    }));
  }

  void _enqueueAgent(ChatMessage msg) {
    if (msg.id.isNotEmpty && !_seenMessageIds.add(msg.id)) return;
    final int? segments = msg.segments;
    if (segments != null && segments > 1) {
      // 一次性下发的多段消息不要再把打字态重置掉。
      _segmentQueue.add(msg);
      _segmentQueue.sort((ChatMessage a, ChatMessage b) =>
          (a.segment ?? 0).compareTo(b.segment ?? 0));
      _drainSegments();
    } else {
      setState(() {
        _typing = false;
        _typingStage = null;
      });
      _appendMessage(msg);
    }
  }

  void _drainSegments() {
    if (_segmentActive || _segmentQueue.isEmpty) return;
    _segmentActive = true;
    final ChatMessage msg = _segmentQueue.removeAt(0);
    _appendMessage(msg);
    final bool more = _segmentQueue.isNotEmpty;
    if (!more) {
      _segmentActive = false;
      if (mounted) setState(() => _typing = false);
      return;
    }
    // 服务端一次性下发所有段；按 wait 等待时保持「正在输入」三点动画。
    final int wait = (msg.wait ?? 0).clamp(0, 8);
    if (mounted) {
      setState(() => _typing = true);
      _scrollToBottom();
    }
    _segmentTimer?.cancel();
    _segmentTimer = Timer(
      Duration(milliseconds: wait > 0 ? wait * 1000 : 450),
      () {
        _segmentActive = false;
        if (!mounted) return;
        _drainSegments();
      },
    );
  }

  void _appendMessage(ChatMessage msg) {
    if (!mounted) return;
    setState(() {
      _messages.add(msg);
      if (msg.id.isNotEmpty) _seenMessageIds.add(msg.id);
    });
    _scrollToBottom();
  }

  void _appendNotice(String text) {
    if (text.trim().isEmpty || !mounted) return;
    setState(() {
      _messages.add(ChatMessage.notice(text.trim()));
    });
    _scrollToBottom();
  }

  void _scrollToBottom({bool animate = true}) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scroll.hasClients) return;
      final double target = _scroll.position.maxScrollExtent;
      if (animate) {
        _scroll.animateTo(
          target,
          duration: const Duration(milliseconds: 220),
          curve: Curves.easeOut,
        );
      } else {
        _scroll.jumpTo(target);
      }
    });
  }

  Future<void> _sendText() async {
    final String text = _input.text.trim();
    if (text.isEmpty || _sending) return;
    _input.clear();
    final ChatMessage local = ChatMessage(
      id: 'local_${DateTime.now().microsecondsSinceEpoch}',
      role: 'user',
      kind: 'text',
      content: text,
      createdAt: DateTime.now().toUtc().toIso8601String(),
      pending: true,
    );
    setState(() => _messages.add(local));
    _scrollToBottom();
    await _dispatch(local, kind: 'text', text: text);
  }

  Future<void> _dispatch(
    ChatMessage local, {
    required String kind,
    String text = '',
    String? mediaId,
  }) async {
    final AppState state = AppScope.read(context);
    setState(() {
      _sending = true;
      // v1.0.1：发送即显示「正在输入…」，避免用户以为没有反应。
      _typing = true;
      _typingStage = null;
    });
    try {
      final SendMessageResult r = await state.chatService.send(
        characterId: widget.character.id,
        kind: kind,
        text: text,
        mediaId: mediaId,
      );
      if (!mounted) return;
      setState(() {
        final int i = _messages.indexWhere((ChatMessage m) => m.id == local.id);
        if (i >= 0) {
          if (!r.accepted) {
            _messages.removeAt(i);
          } else {
            final ChatMessage? server = r.userMessage;
            _messages[i] = _messages[i].copyWith(
              pending: false,
              id: server?.id,
              createdAt: server?.createdAt,
            );
          }
        }
        if (r.queued) {
          _context = ContextUsage(
            used: _context.used,
            limit: _context.limit,
            percent: _context.percent,
            compressing: true,
          );
        }
        if (!r.accepted) {
          _typing = false;
          _typingStage = null;
        }
      });
      if (r.notice != null && r.notice!.isNotEmpty) {
        _appendNotice(r.notice!);
      }
      if (r.accepted) {
        setState(() {
          _typing = true;
          _typingStage = null;
        });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _typing = false;
        _typingStage = null;
        final int i = _messages.indexWhere((ChatMessage m) => m.id == local.id);
        if (i >= 0) {
          _messages[i] = _messages[i].copyWith(pending: false);
        }
      });
      showToast('发送失败：$e', isError: true);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _showAttachmentSheet() async {
    final String? kind = await showModalBottomSheet<String>(
      context: context,
      builder: (BuildContext ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            ListTile(
              leading: const Icon(Icons.photo_library_outlined),
              title: const Text('从相册选择图片'),
              onTap: () => Navigator.of(ctx).pop('gallery'),
            ),
            ListTile(
              leading: const Icon(Icons.photo_camera_outlined),
              title: const Text('拍照'),
              onTap: () => Navigator.of(ctx).pop('camera'),
            ),
          ],
        ),
      ),
    );
    if (kind == null) return;
    try {
      final XFile? file = await ImagePicker().pickImage(
        source: kind == 'camera' ? ImageSource.camera : ImageSource.gallery,
        imageQuality: 88,
        maxWidth: 1680,
      );
      if (file == null) return;
      await _sendMedia(kind: 'image', filePath: file.path);
    } catch (e) {
      showToast('选择图片失败：$e', isError: true);
    }
  }

  Future<void> _sendMedia({
    required String kind,
    required String filePath,
    int duration = 0,
  }) async {
    final AppState state = AppScope.read(context);
    setState(() => _sending = true);
    try {
      final Map<String, dynamic> media = await state.mediaService.upload(
        filePath: filePath,
        kind: kind,
        characterId: widget.character.id,
      );
      final String? mediaId = asStringOrNull(media['id']);
      if (mediaId == null) {
        showToast('媒体上传失败');
        return;
      }
      final ChatMessage local = ChatMessage(
        id: 'local_${DateTime.now().microsecondsSinceEpoch}',
        role: 'user',
        kind: kind,
        content: kind == 'image' ? '[图片]' : '[语音]',
        createdAt: DateTime.now().toUtc().toIso8601String(),
        pending: true,
        localMediaPath: filePath,
        meta: <String, dynamic>{
          'mediaId': mediaId,
          'url': media['url'],
          if (duration > 0) 'duration': duration,
        },
      );
      if (!mounted) return;
      setState(() => _messages.add(local));
      _scrollToBottom();
      setState(() => _sending = false);
      await _dispatch(local, kind: kind, mediaId: mediaId);
    } catch (e) {
      showToast('上传失败：$e', isError: true);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _toggleRecord() async {
    if (_recording) {
      await _stopRecordAndSend();
      return;
    }
    try {
      final bool ok = await _recorder.hasPermission();
      if (!ok) {
        showToast('需要麦克风权限才能发送语音');
        return;
      }
      final Directory dir = await getTemporaryDirectory();
      final String path =
          '${dir.path}/cocoa_voice_${DateTime.now().millisecondsSinceEpoch}.m4a';
      await _recorder.start(
        const rec.RecordConfig(encoder: rec.AudioEncoder.aacLc),
        path: path,
      );
      setState(() {
        _recording = true;
        _recordStartedAt = DateTime.now();
      });
    } catch (e) {
      showToast('录音启动失败：$e', isError: true);
    }
  }

  Future<void> _stopRecordAndSend() async {
    final DateTime? started = _recordStartedAt;
    String? path;
    try {
      path = await _recorder.stop();
    } catch (_) {
      path = null;
    }
    final int seconds =
        started == null ? 0 : DateTime.now().difference(started).inSeconds;
    setState(() => _recording = false);
    if (path == null || !File(path).existsSync()) {
      showToast('没有录到声音');
      return;
    }
    if (seconds < 1) {
      showToast('录音太短了');
      return;
    }
    await _sendMedia(kind: 'voice', filePath: path, duration: seconds);
  }

  Future<void> _wakeUp() async {
    final AppState state = AppScope.read(context);
    try {
      final WakeResult result =
          await state.chatService.wake(widget.character.id);
      if (!mounted) return;
      setState(() {
        if (result.state != null) _state = result.state!;
      });
      _appendNotice('${widget.character.name}被叫醒了');
      if (result.reply.trim().isNotEmpty) {
        _appendMessage(ChatMessage(
          id: 'wake_${DateTime.now().microsecondsSinceEpoch}',
          role: 'agent',
          content: result.reply,
          createdAt: DateTime.now().toUtc().toIso8601String(),
        ));
      } else {
        showToast('叫醒成功');
      }
    } catch (e) {
      showToast('叫醒失败：$e', isError: true);
    }
  }

  Widget _pausedBar() {
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 2, 12, 6),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: AppColors.warn.withAlpha(22),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.warn.withAlpha(80)),
      ),
      child: const Row(
        children: <Widget>[
          Icon(Icons.pause_circle_outline, size: 16, color: AppColors.warn),
          SizedBox(width: 6),
          Expanded(
            child: Text(
              '角色已暂停：停止所有活动与 token 消耗；可在角色设置中恢复运行。',
              style: TextStyle(fontSize: 11, color: AppColors.warn, height: 1.4),
            ),
          ),
        ],
      ),
    );
  }

  Widget _sleepBar() {
    final String hint = sleepHint(widget.character.name, _state.sleepState);
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 2, 12, 6),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: AppColors.sand.withAlpha(160),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        children: <Widget>[
          const Icon(Icons.bedtime_outlined, size: 16, color: AppColors.inkSoft),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              hint,
              style: const TextStyle(fontSize: 11, color: AppColors.inkSoft),
            ),
          ),
          TextButton(
            onPressed: _enabled ? _wakeUp : null,
            style: TextButton.styleFrom(
              minimumSize: const Size(0, 30),
              padding: const EdgeInsets.symmetric(horizontal: 8),
              textStyle: const TextStyle(fontSize: 11.5),
            ),
            child: const Text('强行叫醒'),
          ),
        ],
      ),
    );
  }

  Widget _inputBar() {
    final AppState state = AppScope.of(context);
    final bool disabled = _state.resting || !_enabled;
    return Container(
      padding: const EdgeInsets.fromLTRB(8, 6, 8, 8),
      decoration: BoxDecoration(
        color: AppColors.white,
        border: Border(top: BorderSide(color: AppColors.sand)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (state.debugMode) ContextGauge(usage: _context),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: <Widget>[
              IconButton(
                tooltip: '图片',
                icon: const Icon(Icons.add_photo_alternate_outlined, size: 22),
                onPressed: disabled || _sending ? null : _showAttachmentSheet,
              ),
              Expanded(
                child: TextField(
                  controller: _input,
                  enabled: !disabled,
                  maxLines: 4,
                  minLines: 1,
                  textInputAction: TextInputAction.newline,
                  decoration: InputDecoration(
                    isDense: true,
                    hintText: !_enabled
                        ? '${widget.character.name}已暂停活动，暂时不能发送消息'
                        : (disabled
                            ? '${widget.character.name}在休息，暂时不能发送消息'
                            : '说点什么…'),
                    contentPadding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 10,
                    ),
                  ),
                  style: const TextStyle(fontSize: 14, height: 1.4),
                ),
              ),
              IconButton(
                tooltip: _recording ? '停止并发送' : '语音',
                icon: Icon(
                  _recording ? Icons.stop_circle_outlined : Icons.mic_none,
                  size: 23,
                  color: _recording ? AppColors.danger : AppColors.cocoa,
                ),
                onPressed: disabled || _sending ? null : _toggleRecord,
              ),
              const SizedBox(width: 2),
              SizedBox(
                width: 42,
                height: 42,
                child: IconButton.filled(
                  style: IconButton.styleFrom(
                    backgroundColor: AppColors.cocoa,
                    disabledBackgroundColor: AppColors.sand,
                  ),
                  onPressed: disabled || _sending ? null : _sendText,
                  icon: const Icon(Icons.send_rounded, size: 18),
                ),
              ),
            ],
          ),
          if (_recording)
            const Padding(
              padding: EdgeInsets.only(top: 4),
              child: Text(
                '正在录音… 再点一次麦克风结束并发送',
                style: TextStyle(fontSize: 10.5, color: AppColors.danger),
              ),
            ),
        ],
      ),
    );
  }

  Widget _messageList() {
    if (_loading) return const LoadingView(text: '加载对话…');
    if (_messages.isEmpty && !_typing) {
      return EmptyView(
        text: '还没有聊过天\n发一条消息，开始和${widget.character.name}的日常吧',
        icon: Icons.chat_bubble_outline,
      );
    }
    final AppState state = AppScope.of(context);
    final int extra = _typing ? 1 : 0;
    return ListView.builder(
      controller: _scroll,
      padding: const EdgeInsets.symmetric(vertical: 8),
      itemCount: _messages.length + extra,
      itemBuilder: (BuildContext context, int i) {
        if (i >= _messages.length) return _typingBubble();
        final ChatMessage m = _messages[i];
        return MessageBubble(
          message: m,
          baseUrl: state.baseUrl,
          token: state.token,
        );
      },
    );
  }

  String get _typingLabel {
    final String? stage = _typingStage;
    if (stage != null && kTypingStageLabels.containsKey(stage)) {
      return '${widget.character.name}${kTypingStageLabels[stage]}';
    }
    return '${widget.character.name}正在输入…';
  }

  Widget _typingBubble() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 4, 40, 4),
      child: Row(
        children: <Widget>[
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(
              color: AppColors.bubbleAgent,
              borderRadius: BorderRadius.circular(14),
            ),
            child: const _TypingDots(),
          ),
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              _typingLabel,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 10, color: AppColors.inkSoft),
            ),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final AppState state = AppScope.of(context);
    return Scaffold(
      appBar: AppBar(
        title: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text(widget.character.name),
            const SizedBox(width: 6),
            Container(
              width: 6,
              height: 6,
              decoration: BoxDecoration(
                color: _connected ? AppColors.success : AppColors.inkSoft,
                shape: BoxShape.circle,
              ),
            ),
          ],
        ),
        actions: <Widget>[
          IconButton(
            tooltip: state.debugMode ? '关闭调试模式' : '打开调试模式',
            icon: Icon(
              state.debugMode ? Icons.bug_report : Icons.bug_report_outlined,
              size: 20,
              color: state.debugMode ? AppColors.rose : null,
            ),
            onPressed: () => state.setDebugMode(!state.debugMode),
          ),
          IconButton(
            tooltip: '记忆图谱',
            icon: const Icon(Icons.hub_outlined, size: 20),
            onPressed: () {
              Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => MemoryPage(character: widget.character),
                ),
              );
            },
          ),
          IconButton(
            tooltip: '角色设置',
            icon: const Icon(Icons.tune, size: 20),
            onPressed: () async {
              await Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) =>
                      CharacterSettingsPage(character: widget.character),
                ),
              );
              if (!mounted) return;
              final AppState state = AppScope.read(context);
              try {
                final CharacterSettings latest =
                    await state.characterService.getSettings(
                  widget.character.id,
                );
                if (mounted) setState(() => _enabled = latest.enabled);
              } catch (_) {}
            },
          ),
        ],
      ),
      body: Container(
        decoration: appearanceDecoration(state, chat: true),
        child: ContentFrame(
        maxWidth: 900,
        child: Column(
          children: <Widget>[
            CharacterStatusBar(
              characterName: widget.character.name,
              state: _state,
              onTap: _openStatusPage,
            ),
            if (!_enabled) _pausedBar(),
            if (_enabled && _state.resting) _sleepBar(),
            Expanded(child: _messageList()),
            _inputBar(),
          ],
        ),
        ),
      ),
    );
  }

  Future<void> _openStatusPage() async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => CharacterStatusPage(
          character: widget.character,
          initialState: _state,
        ),
      ),
    );
    if (!mounted) return;
    final AppState state = AppScope.read(context);
    try {
      final CharacterState latest =
          await state.characterService.getState(widget.character.id);
      if (mounted) setState(() => _state = latest);
    } catch (_) {
      // 状态页已刷新过，失败时保留原状态
    }
  }
}

/// 三点循环动画（typing 指示）。
class _TypingDots extends StatefulWidget {
  const _TypingDots();

  @override
  State<_TypingDots> createState() => _TypingDotsState();
}

class _TypingDotsState extends State<_TypingDots>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    final AppState state = AppScope.read(context);
    _controller = AnimationController(
      vsync: this,
      duration: motionDuration(state, const Duration(milliseconds: 900)),
    );
    if (state.motion != 'off') _controller.repeat();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (BuildContext context, Widget? child) {
        return Row(
          mainAxisSize: MainAxisSize.min,
          children: List<Widget>.generate(3, (int i) {
            final double t = (_controller.value + i * 0.22) % 1.0;
            final double alpha = 0.25 + 0.75 * (1 - (t - 0.5).abs() * 2);
            return Padding(
              padding: EdgeInsets.only(right: i == 2 ? 0 : 4),
              child: Transform.translate(
                offset: Offset(0, -2 * (alpha - 0.25)),
                child: Container(
                  width: 5,
                  height: 5,
                  decoration: BoxDecoration(
                    color: AppColors.cocoa.withAlpha((alpha * 220).round()),
                    shape: BoxShape.circle,
                  ),
                ),
              ),
            );
          }),
        );
      },
    );
  }
}
