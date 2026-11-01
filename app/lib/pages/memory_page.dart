import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../core/api_client.dart';
import '../core/app_state.dart';
import '../core/theme.dart';
import '../core/utils.dart';
import '../models/character.dart';
import '../models/memory_graph.dart';

/// 记忆网状图：智能体 - 大类目 - 小类目 - 记忆点。
class MemoryPage extends StatefulWidget {
  const MemoryPage({super.key, required this.character});

  final Character character;

  @override
  State<MemoryPage> createState() => _MemoryPageState();
}

class _MemoryPageState extends State<MemoryPage> {
  MemoryGraph _graph = MemoryGraph.empty;
  final Set<String> _expanded = <String>{};
  String? _selectedId;
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    final AppState state = AppScope.read(context);
    if (mounted) setState(() => _loading = true);
    try {
      final MemoryGraph g =
          await state.memoryService.graph(widget.character.id);
      if (!mounted) return;
      setState(() {
        _graph = g;
        _error = null;
        _loading = false;
        final MemoryNode? agent = g.agent;
        if (agent != null) _expanded.add(agent.id);
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

  Future<void> _onTapNode(MemoryNode node, Offset local) async {
    if (node.isMemory) {
      setState(() => _selectedId = node.id);
      await _showDetail(node);
      if (mounted) setState(() => _selectedId = null);
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

  Future<void> _showDetail(MemoryNode node) async {
    final AppState state = AppScope.read(context);
    List<MemoryNode> related = _graph.relatedOf(node.id);
    try {
      final MemoryDetail detail = await state.memoryService.detail(node.id);
      if (detail.related.isNotEmpty) related = detail.related;
    } catch (_) {
      // 详情接口未就绪时用图谱内的关联
    }
    if (!mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (BuildContext ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(18, 16, 18, 20),
          child: Column(
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
              _kv('所属角色', widget.character.name),
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
          ),
        ),
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
    return Scaffold(
      appBar: AppBar(
        title: Text('${widget.character.name} · 记忆'),
        actions: <Widget>[
          IconButton(
            tooltip: '刷新',
            icon: const Icon(Icons.refresh, size: 20),
            onPressed: _load,
          ),
        ],
      ),
      body: Container(
        color: AppColors.canvasBg,
        child: _loading
            ? const Center(
                child: CircularProgressIndicator(color: AppColors.latte),
              )
            : _error != null
                ? Center(
                    child: Padding(
                      padding: const EdgeInsets.all(28),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: <Widget>[
                          const Icon(
                            Icons.cloud_off,
                            color: AppColors.latte,
                            size: 44,
                          ),
                          const SizedBox(height: 10),
                          Text(
                            '记忆加载失败\n$_error',
                            textAlign: TextAlign.center,
                            style: const TextStyle(
                              color: AppColors.latte,
                              fontSize: 12,
                            ),
                          ),
                          const SizedBox(height: 12),
                          OutlinedButton(
                            onPressed: _load,
                            style: OutlinedButton.styleFrom(
                              foregroundColor: AppColors.latte,
                              side: const BorderSide(color: AppColors.latte),
                            ),
                            child: const Text('重试'),
                          ),
                        ],
                      ),
                    ),
                  )
                : _graphView(),
      ),
    );
  }

  Widget _graphView() {
    final Map<String, MemoryNode> visible = _visibleNodes();
    final List<MemoryLink> links = _graph.links
        .where((MemoryLink l) =>
            visible.containsKey(l.source) && visible.containsKey(l.target))
        .toList();
    final int memoryTotal = _allMemories().length;
    return Column(
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 10, 14, 6),
          child: Row(
            children: <Widget>[
              _legend(AppColors.rose, '智能体'),
              const SizedBox(width: 10),
              _legend(AppColors.cocoa, '大类目'),
              const SizedBox(width: 10),
              _legend(AppColors.latte, '小类目'),
              const SizedBox(width: 10),
              _legend(Colors.white, '记忆点'),
              const Spacer(),
              Text(
                '${visible.length}/${_graph.nodes.length} 节点 · 共 $memoryTotal 条记忆',
                style: const TextStyle(fontSize: 9.5, color: AppColors.latte),
              ),
            ],
          ),
        ),
        Expanded(
          child: LayoutBuilder(
            builder: (BuildContext context, BoxConstraints c) {
              final Map<String, Offset> positions = _layout(
                visible,
                Size(c.maxWidth, c.maxHeight),
              );
              return GestureDetector(
                onTapUp: (TapUpDetails d) {
                  String? hit;
                  double best = 22;
                  positions.forEach((String id, Offset p) {
                    final double dist = (p - d.localPosition).distance;
                    final MemoryNode? n = visible[id];
                    final double radius = n != null && n.isMemory ? 10 : 20;
                    if (dist < radius + 10 && dist < best) {
                      best = dist;
                      hit = id;
                    }
                  });
                  if (hit != null) {
                    _onTapNode(visible[hit]!, d.localPosition);
                  }
                },
                child: ClipRect(
                  child: CustomPaint(
                    size: Size(c.maxWidth, c.maxHeight),
                    painter: _MemoryPainter(
                      positions: positions,
                      visible: visible,
                      links: links,
                      selectedId: _selectedId,
                    ),
                  ),
                ),
              );
            },
          ),
        ),
        Container(
          width: double.infinity,
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
          color: Colors.black.withAlpha(60),
          child: Text(
            visible.length <= 1
                ? '还没有形成记忆。多聊一些，角色会慢慢记住你。'
                : '点击智能体或类目展开/折叠，点击白色记忆点查看详情',
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 10.5, color: AppColors.latte),
          ),
        ),
      ],
    );
  }

  Widget _legend(Color color, String text) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Container(
          width: 8,
          height: 8,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle),
        ),
        const SizedBox(width: 4),
        Text(
          text,
          style: const TextStyle(fontSize: 9.5, color: AppColors.latte),
        ),
      ],
    );
  }

  /// 径向布局 + 自动缩放适配画布。
  Map<String, Offset> _layout(Map<String, MemoryNode> visible, Size size) {
    final Map<String, Offset> raw = <String, Offset>{};
    final MemoryNode? agent = _graph.agent;
    if (agent == null) return raw;
    raw[agent.id] = Offset.zero;
    if (!visible.containsKey(agent.id)) return raw;

    final List<MemoryNode> bigs = _graph
        .childrenOf(agent.id)
        .where((MemoryNode n) => visible.containsKey(n.id))
        .toList();
    const double r1 = 150;
    final Set<String> placedMemories = <String>{};

    for (int i = 0; i < bigs.length; i++) {
      final MemoryNode big = bigs[i];
      final double angle = -math.pi / 2 + 2 * math.pi * i / bigs.length;
      final Offset bigPos =
          Offset(math.cos(angle) * r1, math.sin(angle) * r1);
      raw[big.id] = bigPos;

      final List<MemoryNode> smalls = _graph
          .childrenOf(big.id)
          .where((MemoryNode n) => visible.containsKey(n.id))
          .toList();
      for (final MemoryNode n in _graph.nodes) {
        if (n.isCategory &&
            n.big == big.label &&
            n.id != big.id &&
            visible.containsKey(n.id) &&
            !smalls.any((MemoryNode s) => s.id == n.id)) {
          smalls.add(n);
        }
      }

      for (int j = 0; j < smalls.length; j++) {
        final MemoryNode small = smalls[j];
        final double sAngle = angle + (j - (smalls.length - 1) / 2) * 0.5;
        final Offset smallPos =
            bigPos + Offset(math.cos(sAngle) * 96, math.sin(sAngle) * 96);
        raw[small.id] = smallPos;
        if (!_expanded.contains(small.id)) continue;
        final List<MemoryNode> memories =
            _memoriesOf(small).where((MemoryNode n) => visible.containsKey(n.id)).toList();
        for (int k = 0; k < memories.length; k++) {
          final double mAngle = sAngle + k * 2.399963;
          final double mRadius = 40 + 12 * math.sqrt(k);
          raw[memories[k].id] =
              smallPos + Offset(math.cos(mAngle) * mRadius, math.sin(mAngle) * mRadius);
          placedMemories.add(memories[k].id);
        }
      }
    }

    final List<MemoryNode> unplaced = visible.values
        .where((MemoryNode n) => n.isMemory && !placedMemories.contains(n.id))
        .toList();
    for (int k = 0; k < unplaced.length; k++) {
      final MemoryNode mem = unplaced[k];
      final MemoryNode baseNode = mem.big.isNotEmpty
          ? bigs.firstWhere((MemoryNode b) => b.label == mem.big, orElse: () => agent)
          : agent;
      final Offset base = raw[baseNode.id] ?? Offset.zero;
      final double mAngle = k * 2.399963;
      final double mRadius = 78 + 12 * math.sqrt(k);
      raw[mem.id] =
          base + Offset(math.cos(mAngle) * mRadius, math.sin(mAngle) * mRadius);
    }

    if (raw.isEmpty) return raw;
    double minX = double.infinity, maxX = -double.infinity;
    double minY = double.infinity, maxY = -double.infinity;
    raw.forEach((String _, Offset p) {
      minX = math.min(minX, p.dx);
      maxX = math.max(maxX, p.dx);
      minY = math.min(minY, p.dy);
      maxY = math.max(maxY, p.dy);
    });
    const double pad = 46;
    final double spanX = math.max(maxX - minX, 1);
    final double spanY = math.max(maxY - minY, 1);
    final double availX = math.max(size.width - pad * 2, 40);
    final double availY = math.max(size.height - pad * 2, 40);
    final double scale =
        math.min(availX / spanX, availY / spanY).clamp(0.15, 1.5);
    final Offset rawCenter = Offset((minX + maxX) / 2, (minY + maxY) / 2);
    final Offset viewCenter = Offset(size.width / 2, size.height / 2);
    final Map<String, Offset> out = <String, Offset>{};
    raw.forEach((String id, Offset p) {
      out[id] = Offset(
        viewCenter.dx + (p.dx - rawCenter.dx) * scale,
        viewCenter.dy + (p.dy - rawCenter.dy) * scale,
      );
    });
    return out;
  }
}

class _MemoryPainter extends CustomPainter {
  _MemoryPainter({
    required this.positions,
    required this.visible,
    required this.links,
    this.selectedId,
  });

  final Map<String, Offset> positions;
  final Map<String, MemoryNode> visible;
  final List<MemoryLink> links;
  final String? selectedId;

  @override
  void paint(Canvas canvas, Size size) {
    final Paint line = Paint()
      ..color = AppColors.latte.withAlpha(90)
      ..strokeWidth = 1;

    for (final MemoryLink link in links) {
      final Offset? a = positions[link.source];
      final Offset? b = positions[link.target];
      if (a == null || b == null) continue;
      if (link.dashed) {
        final Paint p = Paint()
          ..color = Colors.white.withAlpha(90)
          ..strokeWidth = 0.9;
        _dashedLine(canvas, a, b, p);
      } else {
        line.color = AppColors.latte.withAlpha(70);
        canvas.drawLine(a, b, line);
      }
    }

    for (final MemoryNode node in visible.values) {
      final Offset? p = positions[node.id];
      if (p == null) continue;
      if (node.isMemory) {
        final double b = node.effectiveBrightness.clamp(0.12, 1.0);
        final Paint glow = Paint()
          ..color = Colors.white.withAlpha((b * 70).round())
          ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 8);
        canvas.drawCircle(p, 6 + b * 6, glow);
        canvas.drawCircle(p, 3.2 + b * 2.6, Paint()..color = Colors.white.withAlpha((140 + b * 115).round()));
        if (node.id == selectedId) {
          canvas.drawCircle(
            p,
            13,
            Paint()
              ..style = PaintingStyle.stroke
              ..strokeWidth = 1.4
              ..color = AppColors.rose,
          );
        }
      } else if (node.isAgent) {
        canvas.drawCircle(p, 20, Paint()..color = AppColors.rose.withAlpha(230));
        canvas.drawCircle(
          p,
          26,
          Paint()
            ..style = PaintingStyle.stroke
            ..strokeWidth = 1.2
            ..color = AppColors.rose.withAlpha(120),
        );
        _label(canvas, p + const Offset(0, 34), node.label,
            color: Colors.white, size: 11, bold: true);
      } else if (node.isCategory) {
        final bool big = node.parent.isEmpty ||
            visible[node.parent]?.isAgent == true ||
            node.big.isEmpty;
        final double radius = big ? 12.0 : 8.5;
        canvas.drawCircle(
          p,
          radius,
          Paint()..color = (big ? AppColors.cocoa : AppColors.latte),
        );
        _label(
          canvas,
          p + Offset(0, radius + 11),
          node.label,
          color: Colors.white.withAlpha(225),
          size: big ? 10.5 : 9.5,
        );
      }
    }
  }

  void _label(
    Canvas canvas,
    Offset center,
    String text, {
    required Color color,
    required double size,
    bool bold = false,
  }) {
    if (text.isEmpty) return;
    final TextPainter tp = TextPainter(
      text: TextSpan(
        text: text,
        style: TextStyle(
          color: color,
          fontSize: size,
          fontWeight: bold ? FontWeight.w700 : FontWeight.w400,
        ),
      ),
      textAlign: TextAlign.center,
      textDirection: TextDirection.ltr,
      maxLines: 2,
      ellipsis: '…',
    )..layout(maxWidth: 96);
    tp.paint(canvas, center - Offset(tp.width / 2, 0));
  }

  void _dashedLine(Canvas canvas, Offset a, Offset b, Paint paint) {
    const double dash = 4;
    const double gap = 3.5;
    final double total = (b - a).distance;
    if (total <= 0) return;
    final Offset dir = (b - a) / total;
    double t = 0;
    while (t < total) {
      final double end = math.min(t + dash, total);
      canvas.drawLine(a + dir * t, a + dir * end, paint);
      t = end + gap;
    }
  }

  @override
  bool shouldRepaint(covariant _MemoryPainter old) =>
      old.positions != positions ||
      old.visible != visible ||
      old.links != links ||
      old.selectedId != selectedId;
}
