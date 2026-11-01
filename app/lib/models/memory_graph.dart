import '../core/json_utils.dart';

/// 记忆网状图节点。
/// type: agent | category | memory
class MemoryNode {
  const MemoryNode({
    required this.id,
    required this.type,
    required this.label,
    this.preview = '',
    this.parent = '',
    this.big = '',
    this.small = '',
    this.weight = 0,
    this.brightness = 0,
    this.createdAt = '',
  });

  final String id;
  final String type;
  final String label;
  final String preview;
  final String parent;

  /// 记忆点所属大类 / 小类名。
  final String big;
  final String small;
  final double weight;
  final double brightness;
  final String createdAt;

  bool get isAgent => type == 'agent';
  bool get isCategory => type == 'category';
  bool get isMemory => type == 'memory';

  /// 记忆点恒定白色，亮度由权重决定。
  double get effectiveBrightness {
    final double v = brightness > 0 ? brightness : weight;
    return v.clamp(0.0, 1.0).toDouble();
  }

  factory MemoryNode.fromJson(Map<String, dynamic> j) => MemoryNode(
        id: asString(j['id']),
        type: asString(j['type'], 'memory'),
        label: asString(j['label']),
        preview: asString(j['preview']),
        parent: asString(j['parent']),
        big: asString(j['big']),
        small: asString(j['small']),
        weight: asDouble(j['weight']),
        brightness: asDouble(j['brightness']),
        createdAt: asString(j['createdAt']),
      );
}

class MemoryLink {
  const MemoryLink({
    required this.source,
    required this.target,
    this.dashed = false,
    this.score = 0,
  });

  final String source;
  final String target;
  final bool dashed;
  final double score;

  factory MemoryLink.fromJson(Map<String, dynamic> j) => MemoryLink(
        source: asString(j['source']),
        target: asString(j['target']),
        dashed: asBool(j['dashed']),
        score: asDouble(j['score']),
      );
}

class MemoryGraph {
  const MemoryGraph({
    this.nodes = const <MemoryNode>[],
    this.links = const <MemoryLink>[],
  });

  final List<MemoryNode> nodes;
  final List<MemoryLink> links;

  static const MemoryGraph empty = MemoryGraph();

  factory MemoryGraph.fromJson(Map<String, dynamic> j) => MemoryGraph(
        nodes: asMapList(j['nodes'])
            .map((Map<String, dynamic> n) => MemoryNode.fromJson(n))
            .toList(),
        links: asMapList(j['links'])
            .map((Map<String, dynamic> l) => MemoryLink.fromJson(l))
            .toList(),
      );

  MemoryNode? byId(String id) {
    for (final MemoryNode n in nodes) {
      if (n.id == id) return n;
    }
    return null;
  }

  MemoryNode? get agent {
    for (final MemoryNode n in nodes) {
      if (n.isAgent) return n;
    }
    return nodes.isEmpty ? null : nodes.first;
  }

  List<MemoryNode> childrenOf(String parentId) =>
      nodes.where((MemoryNode n) => n.parent == parentId).toList();

  List<MemoryNode> relatedOf(String id) {
    final List<MemoryNode> out = <MemoryNode>[];
    for (final MemoryLink l in links) {
      if (!l.dashed) continue;
      if (l.source == id) {
        final MemoryNode? n = byId(l.target);
        if (n != null) out.add(n);
      } else if (l.target == id) {
        final MemoryNode? n = byId(l.source);
        if (n != null) out.add(n);
      }
    }
    return out;
  }
}

/// 记忆详情（含关联）。
class MemoryDetail {
  const MemoryDetail({
    required this.node,
    this.related = const <MemoryNode>[],
  });

  final MemoryNode node;
  final List<MemoryNode> related;

  factory MemoryDetail.fromJson(Map<String, dynamic> j) {
    final Map<String, dynamic> nodeJson =
        j['node'] is Map ? asMap(j['node']) : j;
    final MemoryNode node = MemoryNode.fromJson(nodeJson);
    final List<MemoryNode> related = asMapList(j['related'])
        .map((Map<String, dynamic> n) => MemoryNode.fromJson(n))
        .toList();
    return MemoryDetail(node: node, related: related);
  }
}
