import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/api_client.dart';
import '../core/constants.dart';
import '../core/app_state.dart';
import '../core/global.dart';
import '../core/json_utils.dart';
import '../core/theme.dart';
import '../core/utils.dart';
import '../models/book.dart';
import '../models/character.dart';
import '../widgets/common.dart';
import '../widgets/qzone_share_sheet.dart';
import 'reader_page.dart';

class BookshelfPage extends StatefulWidget {
  const BookshelfPage({super.key});

  @override
  State<BookshelfPage> createState() => _BookshelfPageState();
}

class _BookshelfPageState extends State<BookshelfPage>
    with SingleTickerProviderStateMixin {
  static const List<String> _types = <String>['novel', 'essay', 'diary', 'news'];

  late final TabController _tab;
  List<Character> _characters = <Character>[];
  Character? _character;
  bool _loadingChars = true;
  final Map<String, List<Book>> _books = <String, List<Book>>{};
  final Set<String> _loaded = <String>{};
  bool _loadingBooks = false;
  DiaryLockStatus? _lock;
  String? _diaryPassword;

  @override
  void initState() {
    super.initState();
    _tab = TabController(length: _types.length, vsync: this);
    _tab.addListener(_onTab);
    WidgetsBinding.instance.addPostFrameCallback((_) => _init());
  }

  @override
  void dispose() {
    _tab.removeListener(_onTab);
    _tab.dispose();
    super.dispose();
  }

  void _onTab() {
    if (_tab.indexIsChanging) return;
    _ensureLoaded(_types[_tab.index]);
  }

  Future<void> _init() async {
    final AppState state = AppScope.read(context);
    try {
      final List<Character> list = await state.characterService.list();
      if (!mounted) return;
      setState(() {
        _characters = list;
        _character = list.isEmpty
            ? null
            : list.firstWhere(
                (Character c) => c.id == state.activeCharacterId,
                orElse: () => list.first,
              );
        _loadingChars = false;
      });
      if (_character != null) {
        await _ensureLoaded('novel');
        await _loadLock();
      }
    } catch (e) {
      if (mounted) setState(() => _loadingChars = false);
      showToast('角色加载失败：$e', isError: true);
    }
  }

  Future<void> _loadLock() async {
    final Character? c = _character;
    if (c == null) return;
    final AppState state = AppScope.read(context);
    try {
      final DiaryLockStatus lock =
          await state.bookService.lockStatus(c.id);
      if (mounted) setState(() => _lock = lock);
    } catch (_) {
      if (mounted) {
        setState(() => _lock = DiaryLockStatus(locked: true, hint: ''));
      }
    }
  }

  Future<void> _ensureLoaded(String type, {bool force = false}) async {
    final Character? c = _character;
    if (c == null) return;
    if (!force && _loaded.contains(type)) return;
    if (type == 'diary' && (_lock?.locked ?? true) && _diaryPassword == null) {
      return;
    }
    final AppState state = AppScope.read(context);
    setState(() => _loadingBooks = true);
    try {
      final List<Book> list =
          await state.bookService.list(characterId: c.id, type: type);
      if (!mounted) return;
      setState(() {
        _books[type] = list;
        _loaded.add(type);
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _loaded.add(type));
      showToast('${kBookTypeLabels[type] ?? type}加载失败：${e.message}', isError: true);
    } catch (e) {
      if (mounted) setState(() => _loaded.add(type));
      showToast('加载失败：$e', isError: true);
    } finally {
      if (mounted) setState(() => _loadingBooks = false);
    }
  }

  Future<void> _switchCharacter(Character c) async {
    final AppState state = AppScope.read(context);
    setState(() {
      _character = c;
      _books.clear();
      _loaded.clear();
      _lock = null;
      _diaryPassword = null;
    });
    await state.setActiveCharacter(c.id);
    await _ensureLoaded(_types[_tab.index], force: true);
    await _loadLock();
  }

  Future<void> _unlockDiary() async {
    final Character? c = _character;
    if (c == null) return;
    final AppState state = AppScope.read(context);
    final TextEditingController ctrl = TextEditingController();
    final String? password = await showDialog<String>(
      context: context,
      builder: (BuildContext ctx) => AlertDialog(
          title: const Text('解锁日记本'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              const Text(
                '日记是角色的隐私，需要 6 位数字密码。角色只会在聊天里暗示线索，不会直接说出密码。',
                style: TextStyle(fontSize: 11.5, color: AppColors.inkSoft, height: 1.5),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: ctrl,
                autofocus: true,
                obscureText: true,
                keyboardType: TextInputType.number,
                maxLength: 6,
                inputFormatters: <TextInputFormatter>[
                  FilteringTextInputFormatter.digitsOnly,
                  LengthLimitingTextInputFormatter(6),
                ],
                decoration: const InputDecoration(
                  hintText: '6 位数字密码',
                  counterText: '',
                ),
                style: const TextStyle(fontSize: 18, letterSpacing: 8),
              ),
              if (_lock != null && _lock!.hint.isNotEmpty) ...<Widget>[
                const SizedBox(height: 8),
                Text(
                  '今日线索：${_lock!.hint}',
                  style: const TextStyle(fontSize: 11.5, color: AppColors.rose),
                ),
              ],
            ],
          ),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: const Text('取消'),
            ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(ctrl.text.trim()),
            child: const Text('解锁'),
          ),
        ],
      ),
    );
    ctrl.dispose();
    if (password == null) return;
    if (password.length != 6) {
      showToast('请输入 6 位数字密码');
      return;
    }
    try {
      final DiaryUnlockResult r = await state.bookService.unlockDiary(
        characterId: c.id,
        password: password,
      );
      if (!r.ok) {
        showToast('密码不正确，再想想角色给的线索', isError: true);
        return;
      }
      setState(() {
        _diaryPassword = password;
        _lock = DiaryLockStatus(
          locked: false,
          hint: _lock?.hint ?? '',
          day: _lock?.day ?? '',
          hasDiary: _lock?.hasDiary ?? false,
          diaryId: _lock?.diaryId,
        );
        _loaded.remove('diary');
      });
      showToast('日记本已解锁');
      await _ensureLoaded('diary', force: true);
      if (r.diary != null && mounted) {
        await _openBook(r.diary!);
      }
    } catch (e) {
      showToast('解锁失败：$e', isError: true);
    }
  }

  Future<void> _openBook(Book book) async {
    final AppState state = AppScope.read(context);
    Book detail = book;
    if (book.content.isEmpty) {
      try {
        detail = await state.bookService.detail(
          book.id,
          password: book.isDiary ? _diaryPassword : null,
        );
      } catch (e) {
        showToast('打开失败：$e', isError: true);
        return;
      }
    }
    if (!mounted) return;
    await Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => ReaderPage(book: detail)),
    );
  }

  Widget _characterBar() {
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 6, 12, 2),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      decoration: BoxDecoration(
        color: AppColors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.sand),
      ),
      child: Row(
        children: <Widget>[
          const Icon(Icons.person_outline, size: 16, color: AppColors.cocoa),
          const SizedBox(width: 6),
          Expanded(
            child: DropdownButtonHideUnderline(
              child: DropdownButton<String>(
                isExpanded: true,
                value: _character?.id,
                items: _characters
                    .map(
                      (Character c) => DropdownMenuItem<String>(
                        value: c.id,
                        child: Text(
                          c.name,
                          style: const TextStyle(fontSize: 12.5),
                        ),
                      ),
                    )
                    .toList(),
                onChanged: (String? id) {
                  if (id == null) return;
                  final Character c =
                      _characters.firstWhere((Character x) => x.id == id);
                  _switchCharacter(c);
                },
              ),
            ),
          ),
          IconButton(
            icon: const Icon(Icons.refresh, size: 17),
            onPressed: () {
              _ensureLoaded(_types[_tab.index], force: true);
              _loadLock();
            },
          ),
        ],
      ),
    );
  }

  Widget _bookList(String type) {
    final List<Book>? items = _books[type];
    if (items == null) {
      return _loadingBooks
          ? const LoadingView()
          : EmptyView(
              text: '还没有${kBookTypeLabels[type]}',
              icon: Icons.menu_book_outlined,
            );
    }
    if (items.isEmpty) {
      return EmptyView(
        text: '角色还没有创作${kBookTypeLabels[type]}\n多聊聊天，ta会慢慢写下自己的故事',
        icon: type == 'news' ? Icons.public : Icons.auto_stories_outlined,
      );
    }
    return RefreshIndicator(
      onRefresh: () => _ensureLoaded(type, force: true),
      child: ListView.builder(
        padding: const EdgeInsets.fromLTRB(12, 6, 12, 20),
        itemCount: items.length,
        itemBuilder: (BuildContext context, int i) {
          final Book b = items[i];
          return GestureDetector(
            onTap: () => _openBook(b),
            child: Container(
              margin: const EdgeInsets.only(bottom: 10),
              padding: const EdgeInsets.all(13),
              decoration: BoxDecoration(
                color: AppColors.white,
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: AppColors.sand),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Row(
                    children: <Widget>[
                      Expanded(
                        child: Text(
                          b.title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 14,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                      Text(
                        formatDate(b.displayDate),
                        style: const TextStyle(
                          fontSize: 10,
                          color: AppColors.inkSoft,
                        ),
                      ),
                      const SizedBox(width: 2),
                      IconButton(
                        visualDensity: VisualDensity.compact,
                        tooltip: '分享到 QQ 动态',
                        icon: const Icon(Icons.share_outlined, size: 16),
                        onPressed: () {
                          final String image = asString(
                            b.meta['image'] ??
                                b.meta['cover'] ??
                                b.meta['imageUrl'],
                          );
                          showQzoneShare(
                            context,
                            defaultContent: '${b.title}\n\n${b.previewText}',
                            imageUrl: image.isEmpty ? null : image,
                          );
                        },
                      ),
                    ],
                  ),
                  const SizedBox(height: 5),
                  Text(
                    b.previewText,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 11.5,
                      height: 1.5,
                      color: AppColors.inkSoft,
                    ),
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }

  Widget _diaryTab() {
    final DiaryLockStatus? lock = _lock;
    final bool locked = _diaryPassword == null && (lock?.locked ?? true);
    return Column(
      children: <Widget>[
        Container(
          margin: const EdgeInsets.fromLTRB(12, 8, 12, 4),
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            gradient: const LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: <Color>[Color(0xFFF3E3D2), Color(0xFFFBF3E9)],
            ),
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: AppColors.sand),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Row(
                children: <Widget>[
                  Icon(
                    locked ? Icons.lock_outline : Icons.lock_open,
                    size: 17,
                    color: AppColors.cocoa,
                  ),
                  const SizedBox(width: 6),
                  Text(
                    '${_character?.name ?? '角色'}的日记本',
                    style: const TextStyle(
                      fontSize: 13.5,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const Spacer(),
                  Text(
                    lock?.day.isNotEmpty == true ? lock!.day : formatTodayLabel(),
                    style: const TextStyle(
                      fontSize: 10.5,
                      color: AppColors.inkSoft,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Text(
                lock?.hint.isNotEmpty == true
                    ? '今日线索：${lock!.hint}'
                    : '密码每天随机更换，角色只会在聊天中暗示线索。',
                style: const TextStyle(
                  fontSize: 11.5,
                  color: AppColors.rose,
                  height: 1.5,
                ),
              ),
              const SizedBox(height: 8),
              if (locked)
                FilledButton.icon(
                  onPressed: _unlockDiary,
                  icon: const Icon(Icons.password, size: 16),
                  label: const Text('输入 6 位密码解锁'),
                  style: FilledButton.styleFrom(minimumSize: const Size(0, 40)),
                )
              else
                Row(
                  children: <Widget>[
                    const Icon(
                      Icons.check_circle_outline,
                      size: 14,
                      color: AppColors.success,
                    ),
                    const SizedBox(width: 5),
                    const Text(
                      '今日已解锁',
                      style: TextStyle(
                        fontSize: 11.5,
                        color: AppColors.success,
                      ),
                    ),
                    const Spacer(),
                    TextButton(
                      onPressed: () => setState(() {
                        _diaryPassword = null;
                        _lockedTrueAgain();
                      }),
                      child: const Text('重新上锁', style: TextStyle(fontSize: 11)),
                    ),
                  ],
                ),
            ],
          ),
        ),
        if (locked)
          const Expanded(
            child: EmptyView(
              text: '解锁后才能看到角色写下的日记',
              icon: Icons.auto_stories_outlined,
            ),
          )
        else
          Expanded(child: _bookList('diary')),
      ],
    );
  }

  void _lockedTrueAgain() {
    _lock = DiaryLockStatus(
      locked: true,
      hint: _lock?.hint ?? '',
      day: _lock?.day ?? '',
      hasDiary: _lock?.hasDiary ?? false,
      diaryId: _lock?.diaryId,
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_loadingChars) return const LoadingView(text: '加载书架…');
    if (_characters.isEmpty) {
      return const EmptyView(
        text: '还没有角色\n先去「角色」页创建一位角色吧',
        icon: Icons.person_outline,
      );
    }
    return Column(
      children: <Widget>[
        _characterBar(),
        TabBar(
          controller: _tab,
          isScrollable: false,
          tabs: _types
              .map((String t) => Tab(text: kBookTypeLabels[t]))
              .toList(),
        ),
        Expanded(
          child: TabBarView(
            controller: _tab,
            children: <Widget>[
              _bookList('novel'),
              _bookList('essay'),
              _diaryTab(),
              _bookList('news'),
            ],
          ),
        ),
      ],
    );
  }
}
