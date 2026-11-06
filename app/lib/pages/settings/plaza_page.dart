import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/app_state.dart';
import '../../core/global.dart';
import '../../core/json_utils.dart';
import '../../core/theme.dart';
import '../../core/utils.dart';
import '../../models/plaza.dart';
import '../../widgets/common.dart';
import '../character_edit_page.dart';
import 'shares_page.dart';

/// v1.5.0：共享广场（本服 / 全球 / 我的发布）。
class PlazaPage extends StatefulWidget {
  const PlazaPage({super.key});

  @override
  State<PlazaPage> createState() => _PlazaPageState();
}

class _PlazaPageState extends State<PlazaPage> {
  PlazaMeta _meta = const PlazaMeta();
  List<PlazaResource> _items = <PlazaResource>[];
  List<Map<String, dynamic>> _grants = <Map<String, dynamic>>[];
  final TextEditingController _search = TextEditingController();
  bool _global = false;
  bool _mine = false;
  String _kind = '';
  String _sort = 'latest';
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _init());
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  Future<void> _init() async {
    final AppState state = AppScope.read(context);
    try {
      final PlazaMeta meta = await state.plazaService.meta();
      final List<Map<String, dynamic>> grants =
          await state.plazaService.grantsRaw();
      if (mounted) {
        setState(() {
          _meta = meta;
          _grants = grants;
        });
      }
    } catch (_) {}
    await _load();
  }

  Future<void> _load() async {
    final AppState state = AppScope.read(context);
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final PlazaListResult r = _mine
          ? await state.plazaService.mine(box: 'published')
          : _global
              ? await state.plazaService.globalList(
                  q: _search.text.trim(), kind: _kind, pageSize: 50)
              : await state.plazaService.resources(
                  scope: 'server',
                  q: _search.text.trim(),
                  kind: _kind,
                  sort: _sort,
                  pageSize: 50,
                );
      if (!mounted) return;
      setState(() {
        _items = r.items;
        _loading = false;
        if (_global && r.items.isEmpty) {
          _error = '全球广场暂不可达，已保留本服入口';
        }
      });
    } catch (e) {
      if (mounted) {
        setState(() {
          _loading = false;
          _error = '广场加载失败：$e';
        });
      }
    }
  }

  Future<void> _copyId() async {
    final AppState state = AppScope.read(context);
    String id = _meta.shareId;
    if (id.isEmpty) {
      try {
        id = await state.plazaService.shareId();
      } catch (_) {}
    }
    if (id.isEmpty) return;
    await Clipboard.setData(ClipboardData(text: id));
    if (mounted) showToast('已复制 share ID：$id');
  }

  Future<void> _rotateId() async {
    final AppState state = AppScope.read(context);
    try {
      final String id = await state.plazaService.rotateShareId();
      if (mounted) {
        setState(() => _meta = _meta);
        showToast('share ID 已更新：$id');
      }
    } catch (e) {
      showToast('今日不可再更换：$e', isError: true);
    }
  }

  Future<void> _like(PlazaResource r) async {
    final AppState state = AppScope.read(context);
    try {
      await state.plazaService.like(r.id, global: _global);
      await _load();
    } catch (e) {
      showToast('点赞失败：$e', isError: true);
    }
  }

  Future<void> _use(PlazaResource r) async {
    final AppState state = AppScope.read(context);
    try {
      final Map<String, dynamic> res =
          await state.plazaService.use(r.id, global: _global);
      if (!mounted) return;
      if (r.isTemplate) {
        final Map<String, dynamic> profile = asMap(res['profile']);
        if (profile.isEmpty) {
          showToast('模板内容为空', isError: true);
          return;
        }
        await Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => CharacterEditPage(initialProfile: profile),
          ),
        );
      } else {
        final Map<String, dynamic> ref = asMap(res['providerRef']);
        final List<dynamic> services = asList(ref['services']);
        final String text = services.isEmpty
            ? '模型使用权已生效'
            : '模型使用权已生效：${services.map((dynamic e) => asMap(e)['service']).join('、')}';
        showToast(text);
        await state.refreshConfig();
      }
      await _load();
    } catch (e) {
      showToast('使用失败：$e', isError: true);
    }
  }

  Future<void> _delete(PlazaResource r) async {
    final bool ok = await confirmDialog(
      context,
      title: '删除发布',
      message: '确定下架「${r.title}」吗？',
      confirmText: '删除',
      danger: true,
    );
    if (!ok) return;
    final AppState state = AppScope.read(context);
    try {
      await state.plazaService.deleteResource(r.id);
      await _load();
    } catch (e) {
      showToast('删除失败：$e', isError: true);
    }
  }

  Future<void> _legacy() async {
    final AppState state = AppScope.read(context);
    List<PlazaLegacyShare> list = <PlazaLegacyShare>[];
    try {
      list = await state.plazaService.legacyShares();
    } catch (e) {
      showToast('旧分享加载失败：$e', isError: true);
      return;
    }
    if (!mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      builder: (BuildContext ctx) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: <Widget>[
            const ListTile(
              title: Text('旧分享', style: TextStyle(fontSize: 13)),
              subtitle: Text(
                '兼容入口；新分享请使用广场发布',
                style: TextStyle(fontSize: 10.5),
              ),
            ),
            ...list.map(
              (PlazaLegacyShare s) => ListTile(
                title: Text(s.title.isEmpty ? s.id : s.title,
                    style: const TextStyle(fontSize: 12)),
                subtitle: Text(
                  s.data['ownerCode'] == null ? '' : '#${s.data['ownerCode']}',
                  style: const TextStyle(fontSize: 10),
                ),
                onTap: () {
                  Navigator.of(ctx).pop();
                  Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) => const SharesPage(),
                    ),
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }

  String _statusLabel(PlazaResource r) {
    switch (r.status) {
      case 'active':
        return '展示中';
      case 'hidden':
        return '已隐藏';
      case 'expired':
        return '已过期';
      case 'deleted':
        return '已删除';
      default:
        return r.status;
    }
  }

  Widget _banner() {
    final bool quota = _grants.any((Map<String, dynamic> g) {
      final String s = asString(asMap(g['grant'])['status']);
      return s == 'soft_limited' || s == 'exhausted' || s == 'expiring';
    });
    final bool expiring = _items.any((PlazaResource r) {
      final String s = asString(r.grant['status']);
      return s == 'expiring' || s == 'expired' || s == 'revoked';
    });
    if (!quota && !expiring) return const SizedBox.shrink();
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: AppColors.warn.withAlpha(24),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppColors.warn.withAlpha(90)),
      ),
      child: Text(
        !quota
            ? '有模型使用权即将到期或已失效，请到「我的-授权」查看。'
            : '模型使用权额度已触发软/硬限额，对话可能受限。',
        style: const TextStyle(fontSize: 11, color: AppColors.warn),
      ),
    );
  }

  Widget _card(PlazaResource r) {
    final String remaining = r.permanent
        ? '永久'
        : (r.expiresAt.isEmpty ? '' : '至 ${formatDate(r.expiresAt)}');
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(12),
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
              Icon(
                r.isTemplate ? Icons.bookmark_border : Icons.memory,
                size: 16,
                color: AppColors.cocoa,
              ),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  r.title.isEmpty ? r.id : r.title,
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: AppColors.sand,
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text(
                  _statusLabel(r),
                  style: const TextStyle(fontSize: 9, color: AppColors.inkSoft),
                ),
              ),
            ],
          ),
          if (r.description.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                r.description,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontSize: 10.5,
                  color: AppColors.inkSoft,
                ),
              ),
            ),
          Padding(
            padding: const EdgeInsets.only(top: 5),
            child: Text(
              '发布者 #${r.ownerShareId}${r.ownerNickname.isEmpty ? '' : ' · ${r.ownerNickname}'}'
              '${remaining.isEmpty ? '' : ' · $remaining'}',
              style: const TextStyle(fontSize: 9.5, color: AppColors.inkSoft),
            ),
          ),
          const SizedBox(height: 6),
          Row(
            children: <Widget>[
              Text(
                '♥ ${r.likeCount} · 使用 ${r.useCount}',
                style: const TextStyle(fontSize: 10, color: AppColors.inkSoft),
              ),
              const Spacer(),
              TextButton(
                onPressed: () => _like(r),
                style: TextButton.styleFrom(
                  minimumSize: const Size(0, 30),
                  textStyle: const TextStyle(fontSize: 10.5),
                ),
                child: Text(r.liked ? '取消赞' : '点赞'),
              ),
              FilledButton(
                onPressed: () => _use(r),
                style: FilledButton.styleFrom(
                  minimumSize: const Size(0, 32),
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  textStyle: const TextStyle(fontSize: 11),
                ),
                child: Text(r.isTemplate ? '使用模板' : '使用'),
              ),
              if (r.mine)
                IconButton(
                  visualDensity: VisualDensity.compact,
                  icon: const Icon(Icons.delete_outline, size: 17),
                  onPressed: () => _delete(r),
                ),
            ],
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('共享广场'),
        actions: <Widget>[
          IconButton(
            tooltip: '旧分享',
            icon: const Icon(Icons.history, size: 20),
            onPressed: _legacy,
          ),
          IconButton(
            tooltip: '刷新',
            icon: const Icon(Icons.refresh, size: 20),
            onPressed: _load,
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(12),
        children: <Widget>[
          Row(
            children: <Widget>[
              Expanded(
                child: SegmentedButton<String>(
                  segments: <ButtonSegment<String>>[
                    const ButtonSegment<String>(
                      value: 'server',
                      label: Text('本服'),
                    ),
                    ButtonSegment<String>(
                      value: 'global',
                      label: Text(
                        _meta.globalAvailable ? '全球' : '全球(不可达)',
                      ),
                    ),
                  ],
                  selected: <String>{_global ? 'global' : 'server'},
                  onSelectionChanged: (Set<String> v) {
                    setState(() {
                      _global = v.first == 'global';
                      _mine = false;
                    });
                    _load();
                  },
                ),
              ),
              IconButton(
                tooltip: '我的发布',
                icon: Icon(
                  _mine ? Icons.person : Icons.person_outline,
                  color: _mine ? AppColors.cocoa : null,
                ),
                onPressed: () {
                  setState(() => _mine = !_mine);
                  _load();
                },
              ),
            ],
          ),
          const SizedBox(height: 6),
          Row(
            children: <Widget>[
              const Icon(Icons.badge_outlined, size: 15, color: AppColors.cocoa),
              const SizedBox(width: 4),
              Expanded(
                child: Text(
                  '我的 share ID：${_meta.shareId.isEmpty ? '加载中…' : _meta.shareId}',
                  style: const TextStyle(fontSize: 11),
                ),
              ),
              TextButton(
                onPressed: _copyId,
                style: TextButton.styleFrom(
                  minimumSize: const Size(0, 28),
                  textStyle: const TextStyle(fontSize: 10.5),
                ),
                child: const Text('复制'),
              ),
              TextButton(
                onPressed: _rotateId,
                style: TextButton.styleFrom(
                  minimumSize: const Size(0, 28),
                  textStyle: const TextStyle(fontSize: 10.5),
                ),
                child: const Text('更换'),
              ),
            ],
          ),
          _banner(),
          TextField(
            controller: _search,
            decoration: const InputDecoration(
              hintText: '搜索 share ID 或关键词',
              prefixIcon: Icon(Icons.search, size: 18),
              isDense: true,
            ),
            onSubmitted: (_) => _load(),
          ),
          const SizedBox(height: 6),
          Wrap(
            spacing: 6,
            children: <Widget>[
              ChoiceChip(
                label: const Text('全部', style: TextStyle(fontSize: 10.5)),
                selected: _kind.isEmpty,
                onSelected: (_) {
                  setState(() => _kind = '');
                  _load();
                },
              ),
              ChoiceChip(
                label: const Text('人设模板', style: TextStyle(fontSize: 10.5)),
                selected: _kind == 'template',
                onSelected: (_) {
                  setState(() => _kind = 'template');
                  _load();
                },
              ),
              ChoiceChip(
                label: const Text('模型', style: TextStyle(fontSize: 10.5)),
                selected: _kind == 'model',
                onSelected: (_) {
                  setState(() => _kind = 'model');
                  _load();
                },
              ),
              if (!_global && !_mine)
                DropdownButton<String>(
                  value: _sort,
                  underline: const SizedBox.shrink(),
                  items: const <DropdownMenuItem<String>>[
                    DropdownMenuItem<String>(value: 'latest', child: Text('最新')),
                    DropdownMenuItem<String>(value: 'popular', child: Text('最热')),
                    DropdownMenuItem<String>(value: 'likes', child: Text('点赞')),
                  ],
                  onChanged: (String? v) {
                    if (v == null) return;
                    setState(() => _sort = v);
                    _load();
                  },
                ),
            ],
          ),
          const SizedBox(height: 6),
          if (_loading)
            const Padding(
              padding: EdgeInsets.all(30),
              child: Center(child: CircularProgressIndicator()),
            )
          else if (_error != null && _items.isEmpty)
            EmptyView(text: _error!, icon: Icons.public_off)
          else if (_items.isEmpty)
            const EmptyView(text: '还没有资源', icon: Icons.public)
          else
            ..._items.map(_card),
        ],
      ),
    );
  }
}
