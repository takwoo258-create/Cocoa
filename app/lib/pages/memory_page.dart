import 'dart:async';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:path_provider/path_provider.dart';

import '../core/api_client.dart';
import '../core/app_state.dart';
import '../core/global.dart';
import '../core/theme.dart';
import '../core/utils.dart';
import '../models/character.dart';
import '../models/memory_graph.dart';

/// 记忆网状图：智能体 - 大类目 - 小类目 - 记忆点。
/// v1.0.1：可只传 characterId（从任意入口打开，不依赖聊天页上下文）。
class MemoryPage extends StatefulWidget {
  const MemoryPage({super.key, this.character, this.characterId})
      : assert(character != null || characterId != null,
            'character 与 characterId 至少传入一个');

  final Character? character;
  final String? characterId;

  @override
  State<MemoryPage> createState() => _MemoryPageState();
}

class _MemoryPageState extends State<MemoryPage> {
  MemoryGraph _graph = MemoryGraph.empty;
  final Set<String> _expanded = <String>{};
  String? _selectedId;
  bool _loading = true;
  String? _error;
  String _cid = '';
  String _characterName = '';
  int _companionDays = 0;

  final GlobalKey _canvasKey = GlobalKey();
  Timer? _rotateTimer;
  bool _paused = false;
  double _rotY = 0.55;
  double _rotX = -0.18;
  double _zoom = 1.0;
  double _zoomStart = 1.0;
  Offset _pan = Offset.zero;

  @override
  void initState() {
    super.initState();
    final Character? c = widget.character;
    if (c != null) {
      _cid = c.id;
      _characterName = c.name;
      _companionDays = c.state.companionDays;
      WidgetsBinding.instance.addPostFrameCallback((_) => _load());
    } else {
      WidgetsBinding.instance.addPostFrameCallback((_) => _resolveCharacter());
    }
    _rotateTimer = Timer.periodic(const Duration(milliseconds: 60), (_) {
      if (!mounted || _paused || _loading) return;
      setState(() => _rotY += 0.006);
    });
  }

  @override
  void dispose() {
    _rotateTimer?.cancel();
    super.dispose();
  }

  Future<void> _resolveCharacter() async {
    final String? id = widget.characterId;
    if (id == null || id.isEmpty) {
      if (mounted) setState(() => _error = '缺少角色 ID');
      return;
    }
    final AppState state = AppScope.read(context);
    try {
      final Character c = await state.characterService.get(id);
      if (!mounted) return;
      setState(() {
        _cid = c.id;
        _characterName = c.name;
        _companionDays = c.state.companionDays;
      });
      await _load();
    } catch (e) {
      if (mounted) {
        setState(() {
          _loading = false;
          _error = '角色加载失败：$e';
        });
      }
    }
  }

  Future<void> _load() async {
    final AppState state = AppScope.read(context);
    if (_cid.isEmpty) return;
    if (mounted) setState(() => _loading = true);
    try {
      final MemoryGraph g = await state.memoryService.graph(_cid);
      if (!mounted) return;
      setState(() {
        _graph = g;
        _error = null;
        _loading = false;
        final MemoryNode? agent = g.agent;
        if (agent != null) _expanded.add(agent.id);
        for (final MemoryNode n in g.nodes) {
          if (!n.isMemory) _expanded.add(n.id);
        }
      });
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _loading = false;
          _error = e.message;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _loading = false;
          _error = '$e';
        });
      }
    }
  }

  /// 计算可见节点（受展开状态控制）。
  Map<String, MemoryNode> _visibleNodes() {
    final Map<String, MemoryNode> visible = <String, MemoryNode>{};
    final MemoryNode? agent = _graph.agent;
    if (agent == null) return visible;
    visible[agent.id] = agent;
    final List<MemoryNode> bigs = _graph.childrenOf(agent.id);
    for (final MemoryNode big in bigs) {
      if (!_expanded.contains(agent.id)) continue;
      visible[big.id] = big;
      final List<MemoryNode> smalls = _graph.childrenOf(big.id);
      for (final MemoryNode small in smalls) {
        if (!_expanded.contains(big.id)) continue;
        visible[small.id] = small;
        if (_expanded.contains(small.id)) {
          for (final MemoryNode mem in _memoriesOf(small)) {
            visible[mem.id] = mem;
          }
        }
      }
      // 直接挂在大类目下的记忆
      if (_expanded.contains(big.id)) {
        for (final MemoryNode mem
            in _graph.nodes.where((MemoryNode n) => n.isMemory && n.big == big.label && n.small.isEmpty)) {
          visible[mem.id] = mem;
        }
        for (final MemoryNode mem in _graph.nodes.where((MemoryNode n) =>
            n.isMemory && n.parent == big.id && n.small.isEmpty)) {
          visible[mem.id] = mem;
        }
      }
    }
    return visible;
  }

  List<MemoryNode> _memoriesOf(MemoryNode small) {
    final List<MemoryNode> direct = _graph
        .childrenOf(small.id)
        .where((MemoryNode n) => n.isMemory)
        .toList();
    final String smallName = small.label;
    final String bigName = small.big.isNotEmpty
        ? small.big
        : (_graph.byId(small.parent)?.label ?? '');
    final List<MemoryNode> byName = _graph.nodes
        .where((MemoryNode n) =>
            n.isMemory &&
            n.small == smallName &&
            (bigName.isEmpty || n.big == bigName) &&
            !direct.any((MemoryNode d) => d.id == n.id))
        .toList();
    return <MemoryNode>[...direct, ...byName];
  }

  List<MemoryNode> _allMemories() =>
      _graph.nodes.where((MemoryNode n) => n.isMemory).toList();

  MemoryNode? _detailNode;
  List<MemoryNode> _detailRelated = <MemoryNode>[];

  Future<void> _onTapNode(MemoryNode node, Offset local) async {
    if (node.isMemory) {
      await _selectMemory(node);
      return;
    }
    setState(() {
      if (_expanded.contains(node.id)) {
        _expanded.remove(node.id);
        // 折叠时同时收起子级
        for (final MemoryNode child in _graph.childrenOf(node.id)) {
          _expanded.remove(child.id);
        }
      } else {
        _expanded.add(node.id);
      }
    });
  }

  /// 宽屏左右分栏，窄屏底部面板。
  Future<void> _selectMemory(MemoryNode node) async {
    final AppState state = AppScope.read(context);
    List<MemoryNode> related = _graph.relatedOf(node.id);
    try {
      final MemoryDetail detail = await state.memoryService.detail(node.id);
      if (detail.related.isNotEmpty) related = detail.related;
    } catch (_) {
      // 详情接口不可用时用图谱内的关联
    }
    if (!mounted) return;
    final bool wide = MediaQuery.sizeOf(context).width >= 700;
    if (wide) {
      setState(() {
        _selectedId = node.id;
        _detailNode = node;
        _detailRelated = related;
      });
      return;
    }
    setState(() => _selectedId = node.id);
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (BuildContext ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(18, 16, 18, 20),
          child: SingleChildScrollView(
            child: _detailContent(node, related),
          ),
        ),
      ),
    );
    if (mounted) setState(() => _selectedId = null);
  }

  Widget _detailContent(MemoryNode node, List<MemoryNode> related) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Row(
          children: <Widget>[
            Container(
              width: 10,
              height: 10,
              decoration: BoxDecoration(
                color: Colors.white,
                shape: BoxShape.circle,
                boxShadow: <BoxShadow>[
                  BoxShadow(
                    color: AppColors.cocoa.withAlpha(90),
                    blurRadius: 8,
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            const Text(
              '记忆详情',
              style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
            ),
            const Spacer(),
            Text(
              '权重 ${(node.weight * 100).toStringAsFixed(0)}%',
              style: const TextStyle(
                fontSize: 11,
                color: AppColors.inkSoft,
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        Text(
          node.label,
          style: const TextStyle(
            fontSize: 15,
            height: 1.5,
            fontWeight: FontWeight.w600,
          ),
        ),
        if (node.preview.isNotEmpty) ...<Widget>[
          const SizedBox(height: 6),
          Text(
            node.preview,
            style: const TextStyle(
              fontSize: 13,
              height: 1.55,
              color: AppColors.inkSoft,
            ),
          ),
        ],
        const SizedBox(height: 14),
        _kv('创建时间', formatDateTime(node.createdAt)),
        _kv('大类目', node.big.isEmpty ? '未分类' : node.big),
        _kv('小类目', node.small.isEmpty ? '未分类' : node.small),
        _kv('所属角色', _characterName),
        const SizedBox(height: 10),
        const Text(
          '关联记忆',
          style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700),
        ),
        const SizedBox(height: 6),
        if (related.isEmpty)
          const Text(
            '暂时没有关联记忆',
            style: TextStyle(fontSize: 11.5, color: AppColors.inkSoft),
          )
        else
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: related
                .map(
                  (MemoryNode r) => Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 10,
                      vertical: 6,
                    ),
                    decoration: BoxDecoration(
                      color: AppColors.white,
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: AppColors.sand),
                    ),
                    child: Text(
                      shortText(r.label, 18),
                      style: const TextStyle(fontSize: 11.5),
                    ),
                  ),
                )
                .toList(),
          ),
        const SizedBox(height: 12),
        const Text(
          '记忆点亮度代表权重：越亮说明在角色心里越重要。',
          style: TextStyle(fontSize: 10.5, color: AppColors.inkSoft),
        ),
      ],
    );
  }

  Widget _detailPanel() {
    final MemoryNode? node = _detailNode;
    return Container(
      margin: const EdgeInsets.fromLTRB(0, 8, 8, 8),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.cream.withAlpha(245),
        borderRadius: BorderRadius.circular(16),
      ),
      child: node == null
          ? const Center(
              child: Text(
                '点击白色记忆点\n查看创建时间、类目、内容与关联',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 11, color: AppColors.inkSoft),
              ),
            )
          : SingleChildScrollView(
              child: _detailContent(node, _detailRelated),
            ),
    );
  }

  Widget _kv(String key, String value) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 5),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          SizedBox(
            width: 62,
            child: Text(
              key,
              style: const TextStyle(fontSize: 11.5, color: AppColors.inkSoft),
            ),
          ),
          Expanded(
            child: Text(
              value.isEmpty ? '—' : value,
              style: const TextStyle(fontSize: 12, color: AppColors.ink),
            ),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(
        backgroundColor: Colors.black,
        body: Center(child: CircularProgressIndicator(color: Colors.white70)),
      );
    }
    if (_error != null) {
      return Scaffold(
        backgroundColor: Colors.black,
        body: SafeArea(
          child: Stack(
            children: <Widget>[
              Center(
                child: Padding(
                  padding: const EdgeInsets.all(28),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      const Icon(Icons.cloud_off, color: Colors.white54, size: 44),
                      const SizedBox(height: 10),
                      Text(
                        '记忆加载失败\n$_error',
                        textAlign: TextAlign.center,
                        style: const TextStyle(color: Colors.white70, fontSize: 12),
                      ),
                      const SizedBox(height: 12),
                      OutlinedButton(
                        onPressed: _load,
                        style: OutlinedButton.styleFrom(
                          foregroundColor: Colors.white,
                          side: const BorderSide(color: Colors.white38),
                        ),
                        child: const Text('重试'),
                      ),
                    ],
                  ),
                ),
              ),
              Positioned(
                left: 12,
                bottom: 12,
                child: TextButton.icon(
                  onPressed: () => Navigator.of(context).pop(),
                  icon: const Icon(Icons.close, size: 18, color: Colors.white70),
                  label: const Text('关闭', style: TextStyle(color: Colors.white70)),
                ),
              ),
            ],
          ),
        ),
      );
    }
    return Scaffold(
      backgroundColor: Colors.black,
      body: SafeArea(child: _graph3D()),
    );
  }

  Widget _graph3D() {
    final Map<String, MemoryNode> visible = _visibleNodes();
    final List<MemoryLink> links = _graph.links
        .where((MemoryLink l) =>
            visible.containsKey(l.source) && visible.containsKey(l.target))
        .toList();
    final List<MemoryNode> memories = _allMemories();
    return LayoutBuilder(
      builder: (BuildContext ctx, BoxConstraints c) {
        final Size size = Size(c.maxWidth, c.maxHeight);
        final Map<String, _Vec3> coords = _coords3D(visible);
        final Map<String, _P3> projected = <String, _P3>{};
        coords.forEach((String id, _Vec3 v) {
          projected[id] = _project(v, size);
        });
        final bool wide = size.width >= 700;
        return Stack(
          children: <Widget>[
            Positioned.fill(
              child: RepaintBoundary(
                key: _canvasKey,
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onScaleStart: (_) => _zoomStart = _zoom,
                  onScaleUpdate: (ScaleUpdateDetails d) {
                    setState(() {
                      if (d.pointerCount >= 2) {
                        _zoom = (_zoomStart * d.scale).clamp(0.45, 3.0);
                        _pan += d.focalPointDelta;
                      } else {
                        _rotY += d.focalPointDelta.dx * 0.008;
                        _rotX = (_rotX + d.focalPointDelta.dy * 0.008)
                            .clamp(-1.25, 1.25);
                      }
                    });
                  },
                  onTapUp: (TapUpDetails d) {
                    String? hit;
                    double best = 26;
                    projected.forEach((String id, _P3 p) {
                      final double dist = (p.pos - d.localPosition).distance;
                      final MemoryNode? n = visible[id];
                      final double radius =
                          n != null && n.isMemory ? 12 : 22;
                      if (dist < radius + 12 && dist < best) {
                        best = dist;
                        hit = id;
                      }
                    });
                    if (hit != null) _onTapNode(visible[hit]!, d.localPosition);
                  },
                  child: CustomPaint(
                    size: size,
                    painter: _Memory3DPainter(
                      projected: projected,
                      visible: visible,
                      links: links,
                      selectedId: _selectedId,
                    ),
                  ),
                ),
              ),
            ),
            Positioned(
              left: 14,
              top: 14,
              child: _statsCard(visible.length, links.length, memories.length),
            ),
            Positioned(
              right: 10,
              top: 10,
              child: IconButton(
                tooltip: '刷新',
                onPressed: _load,
                icon: const Icon(Icons.refresh, color: Colors.white70),
              ),
            ),
            if (memories.isEmpty)
              const Center(
                child: Text(
                  '还没有形成记忆\n多聊一些，角色会慢慢记住你',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Colors.white60, fontSize: 12, height: 1.7),
                ),
              ),
            if (wide && _detailNode != null)
              Positioned(
                right: 14,
                top: 90,
                bottom: 110,
                width: 330,
                child: Material(
                  color: Colors.transparent,
                  child: _detailPanel(),
                ),
              ),
            Positioned(
              left: 10,
              right: 10,
              bottom: 8,
              child: _bottomBar(memories.length),
            ),
          ],
        );
      },
    );
  }

  Widget _statsCard(int nodes, int links, int memories) {
    Widget row(String k, String v) => Padding(
          padding: const EdgeInsets.only(bottom: 4),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              SizedBox(
                width: 62,
                child: Text(
                  k,
                  style: const TextStyle(fontSize: 10, color: Colors.white54),
                ),
              ),
              Text(
                v,
                style: const TextStyle(
                  fontSize: 11,
                  color: Colors.white,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
        );
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 14, 8),
      decoration: BoxDecoration(
        color: Colors.black.withAlpha(150),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Colors.white24),
        boxShadow: <BoxShadow>[
          BoxShadow(
            color: Colors.cyanAccent.withAlpha(18),
            blurRadius: 22,
            spreadRadius: 2,
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          const Text(
            '记忆星图',
            style: TextStyle(
              color: Colors.white,
              fontSize: 12,
              fontWeight: FontWeight.w700,
              letterSpacing: 1.2,
            ),
          ),
          const SizedBox(height: 6),
          row('节点', '$nodes'),
          row('连线', '$links'),
          row('陪伴', '$_companionDays 天'),
          row('记忆点', '$memories'),
        ],
      ),
    );
  }

  Widget _bottomBar(int memories) {
    Widget btn(IconData icon, String label, VoidCallback onTap,
        {Color color = Colors.white70}) {
      return InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(10),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Icon(icon, color: color, size: 19),
              const SizedBox(height: 2),
              Text(label, style: TextStyle(color: color, fontSize: 9)),
            ],
          ),
        ),
      );
    }

    return Container(
      padding: const EdgeInsets.fromLTRB(8, 6, 8, 6),
      decoration: BoxDecoration(
        color: Colors.black.withAlpha(170),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: Colors.white.withAlpha(30)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceAround,
            children: <Widget>[
              Text(
                '×${_zoom.toStringAsFixed(2)}',
                style: const TextStyle(color: Colors.white70, fontSize: 11),
              ),
              btn(Icons.center_focus_strong, '复位', () {
                setState(() {
                  _rotY = 0.55;
                  _rotX = -0.18;
                  _zoom = 1;
                  _pan = Offset.zero;
                });
              }),
              btn(Icons.close, '关闭', () => Navigator.of(context).pop()),
              btn(
                _paused ? Icons.play_arrow : Icons.pause,
                _paused ? '继续' : '暂停',
                () => setState(() => _paused = !_paused),
              ),
              btn(Icons.download, '下载', _capture),
            ],
          ),
          const SizedBox(height: 2),
          const Text(
            '单指旋转 · 双指缩放/平移 · 点击节点查看详情',
            style: TextStyle(fontSize: 9, color: Colors.white38),
          ),
        ],
      ),
    );
  }

  double _hash01(String id, [int salt = 0]) {
    int h = 0x811c9dc5;
    for (final int c in id.codeUnits) {
      h ^= c;
      h = (h * 16777619) & 0x7fffffff;
    }
    h = (h + salt * 0x9e3779b9) & 0x7fffffff;
    return (h % 100000) / 100000;
  }

  Map<String, _Vec3> _coords3D(Map<String, MemoryNode> visible) {
    final Map<String, _Vec3> out = <String, _Vec3>{};
    final MemoryNode? agent = _graph.agent;
    if (agent == null || !visible.containsKey(agent.id)) return out;
    out[agent.id] = const _Vec3(0, 0, 0);
    final List<MemoryNode> bigs = _graph
        .childrenOf(agent.id)
        .where((MemoryNode n) => visible.containsKey(n.id))
        .toList();
    final Map<String, String> smallParent = <String, String>{};
    for (final MemoryNode big in bigs) {
      for (final MemoryNode small in _graph.childrenOf(big.id)) {
        smallParent[small.id] = big.id;
      }
    }
    for (int i = 0; i < bigs.length; i++) {
      final MemoryNode big = bigs[i];
      final double a = 2 * math.pi * i / math.max(bigs.length, 1);
      final double r = 150 + _hash01(big.id, 1) * 45;
      out[big.id] = _Vec3(
        math.cos(a) * r,
        (_hash01(big.id, 2) - 0.5) * 85,
        math.sin(a) * r,
      );
    }
    for (final MemoryNode small in visible.values.where((MemoryNode n) =>
        n.isCategory && !bigs.any((MemoryNode b) => b.id == n.id))) {
      final String pid = smallParent[small.id] ??
          (small.parent.isNotEmpty
              ? small.parent
              : (bigs.isNotEmpty ? bigs.first.id : agent.id));
      final _Vec3 base = out[pid] ?? const _Vec3(0, 0, 0);
      final double a = _hash01(small.id, 3) * 2 * math.pi;
      final double r = 62 + _hash01(small.id, 4) * 24;
      out[small.id] = _Vec3(
        base.x + math.cos(a) * r,
        base.y + (_hash01(small.id, 5) - 0.5) * 70,
        base.z + math.sin(a) * r,
      );
    }
    final Map<String, MemoryNode> smallByLabel = <String, MemoryNode>{};
    for (final MemoryNode n in visible.values) {
      if (n.isCategory) smallByLabel['${n.big}|${n.label}'] = n;
    }
    for (final MemoryNode mem in visible.values.where((MemoryNode n) => n.isMemory)) {
      MemoryNode? parent = smallByLabel['${mem.big}|${mem.small}'];
      parent ??= bigs.where((MemoryNode b) => b.label == mem.big).firstOrNull;
      final _Vec3 base =
          parent == null ? const _Vec3(0, 0, 0) : (out[parent.id] ?? const _Vec3(0, 0, 0));
      final double a = _hash01(mem.id, 6) * 2 * math.pi;
      final double e = (_hash01(mem.id, 7) - 0.5) * math.pi;
      final double r = 38 + _hash01(mem.id, 8) * 30;
      out[mem.id] = _Vec3(
        base.x + math.cos(a) * math.cos(e) * r,
        base.y + math.sin(e) * r,
        base.z + math.sin(a) * math.cos(e) * r,
      );
    }
    for (final MemoryNode n in visible.values) {
      if (out.containsKey(n.id)) continue;
      final double a = _hash01(n.id, 9) * 2 * math.pi;
      final double r = 120 + _hash01(n.id, 10) * 90;
      out[n.id] = _Vec3(math.cos(a) * r, 0, math.sin(a) * r);
    }
    return out;
  }

  _P3 _project(_Vec3 v, Size size) {
    final double cy = math.cos(_rotY), sy = math.sin(_rotY);
    final double cx = math.cos(_rotX), sx = math.sin(_rotX);
    final double x1 = v.x * cy - v.z * sy;
    final double z1 = v.x * sy + v.z * cy;
    final double y1 = v.y * cx - z1 * sx;
    final double z2 = v.y * sx + z1 * cx;
    final double persp = 900 / (900 + z2).clamp(300, 1800);
    final Offset center = Offset(size.width / 2, size.height / 2);
    return _P3(
      pos: center +
          _pan +
          Offset(x1 * persp * _zoom, y1 * persp * _zoom),
      z: z2,
      scale: persp * _zoom,
    );
  }

  Future<void> _capture() async {
    try {
      final RenderRepaintBoundary? boundary =
          _canvasKey.currentContext?.findRenderObject() as RenderRepaintBoundary?;
      if (boundary == null) {
        showToast('画布尚未准备好', isError: true);
        return;
      }
      final ui.Image image = await boundary.toImage(pixelRatio: 2);
      final ByteData? data =
          await image.toByteData(format: ui.ImageByteFormat.png);
      if (data == null) {
        showToast('截图失败', isError: true);
        return;
      }
      final Directory dir = await getApplicationDocumentsDirectory();
      final File f = File(
        '${dir.path}/cocoa-memory-${DateTime.now().millisecondsSinceEpoch}.png',
      );
      await f.writeAsBytes(data.buffer.asUint8List());
      if (mounted) showToast('已保存到 ${f.path}');
    } catch (e) {
      if (mounted) showToast('保存失败：$e', isError: true);
    }
  }
}

class _Vec3 {
  const _Vec3(this.x, this.y, this.z);
  final double x;
  final double y;
  final double z;
}

class _P3 {
  const _P3({required this.pos, required this.z, required this.scale});
  final Offset pos;
  final double z;
  final double scale;
}

class _Memory3DPainter extends CustomPainter {
  _Memory3DPainter({
    required this.projected,
    required this.visible,
    required this.links,
    this.selectedId,
  });

  final Map<String, _P3> projected;
  final Map<String, MemoryNode> visible;
  final List<MemoryLink> links;
  final String? selectedId;

  @override
  void paint(Canvas canvas, Size size) {
    final Paint bg = Paint()
      ..shader = const RadialGradient(
        colors: <Color>[Color(0xFF101820), Color(0xFF000000)],
        radius: 0.9,
      ).createShader(Offset.zero & size);
    canvas.drawRect(Offset.zero & size, bg);

    final Paint line = Paint()
      ..color = Colors.white.withAlpha(38)
      ..strokeWidth = 0.8;
    for (final MemoryLink link in links) {
      final _P3? a = projected[link.source];
      final _P3? b = projected[link.target];
      if (a == null || b == null) continue;
      canvas.drawLine(a.pos, b.pos, line);
    }

    final List<MemoryNode> nodes = visible.values.toList()
      ..sort((MemoryNode a, MemoryNode b) =>
          (projected[b.id]?.z ?? 0).compareTo(projected[a.id]?.z ?? 0));
    for (final MemoryNode node in nodes) {
      final _P3? p = projected[node.id];
      if (p == null) continue;
      final bool selected = node.id == selectedId;
      if (node.isMemory) {
        final double br = node.effectiveBrightness.clamp(0.12, 1.0);
        final double r = (2.4 + br * 2.4) * p.scale.clamp(0.5, 1.8);
        canvas.drawCircle(
          p.pos,
          r * 3.6,
          Paint()
            ..color = const Color(0xFF8FD8FF).withAlpha((br * 60).round())
            ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 9),
        );
        canvas.drawCircle(
          p.pos,
          r,
          Paint()
            ..color = Colors.white.withAlpha((150 + br * 100).round()),
        );
      } else {
        final bool agent = node.isAgent;
        final double base = agent ? 7 : 5;
        final Color glow = agent ? const Color(0xFFFFB7C5) : const Color(0xFF9CCBFF);
        canvas.drawCircle(
          p.pos,
          base * 4.6 * p.scale.clamp(0.6, 1.6),
          Paint()
            ..color = glow.withAlpha(agent ? 70 : 40)
            ..maskFilter = MaskFilter.blur(BlurStyle.normal, agent ? 16 : 10),
        );
        canvas.drawCircle(p.pos, base, Paint()..color = glow);
      }
      if (selected) {
        canvas.drawCircle(
          p.pos,
          (node.isMemory ? 10 : 16) * p.scale.clamp(0.6, 1.6),
          Paint()
            ..style = PaintingStyle.stroke
            ..strokeWidth = 1.4
            ..color = const Color(0xFFFFB7C5),
        );
      }
      final bool showLabel =
          node.isAgent || node.isCategory || node.weight >= 0.65 || selected;
      if (showLabel) {
        final TextPainter tp = TextPainter(
          text: TextSpan(
            text: shortText(node.label, node.isMemory ? 12 : 18),
            style: TextStyle(
              color: Colors.white.withAlpha(node.isMemory ? 165 : 220),
              fontSize: node.isAgent ? 12 : (node.isCategory ? 10 : 9),
              fontWeight: node.isAgent ? FontWeight.w700 : FontWeight.w500,
            ),
          ),
          textAlign: TextAlign.center,
          textDirection: TextDirection.ltr,
          maxLines: 1,
          ellipsis: '…',
        )..layout(maxWidth: 120);
        tp.paint(
          canvas,
          p.pos + Offset(-tp.width / 2, node.isMemory ? 7 : 10),
        );
      }
    }
  }

  @override
  bool shouldRepaint(covariant _Memory3DPainter old) =>
      old.projected != projected ||
      old.visible != visible ||
      old.links != links ||
      old.selectedId != selectedId;
}
