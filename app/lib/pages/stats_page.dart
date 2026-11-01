import 'package:fl_chart/fl_chart.dart';
import '../core/layout.dart';
import 'package:flutter/material.dart';

import '../core/api_client.dart';
import '../core/app_state.dart';
import '../core/constants.dart';
import '../core/theme.dart';
import '../core/utils.dart';
import '../models/character.dart';
import '../models/stats_models.dart';
import '../widgets/common.dart';

class StatsPage extends StatefulWidget {
  const StatsPage({super.key});

  @override
  State<StatsPage> createState() => _StatsPageState();
}

class _StatsPageState extends State<StatsPage> {
  List<Character> _characters = <Character>[];
  Character? _character;
  String _range = '7d';
  DateTimeRange? _customRange;
  bool _loading = true;
  String? _error;

  UsageResult _usage = UsageResult.empty;
  IntimacyResult _intimacy = IntimacyResult.empty;
  CharacterOverview _overview = CharacterOverview.empty;
  String? _modelFilter;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _init());
  }

  Future<void> _init() async {
    final AppState state = AppScope.read(context);
    try {
      final List<Character> list = await state.characterService.list();
      if (!mounted) return;
      setState(() {
        _characters = list;
        if (list.isNotEmpty) {
          _character = list.firstWhere(
            (Character c) => c.id == state.activeCharacterId,
            orElse: () => list.first,
          );
        }
      });
      await _load();
    } catch (e) {
      if (mounted) {
        setState(() {
          _loading = false;
          _error = '$e';
        });
      }
    }
  }

  String? get _from => _range == 'custom' && _customRange != null
      ? _customRange!.start.toUtc().toIso8601String()
      : null;

  String? get _to => _range == 'custom' && _customRange != null
      ? _customRange!.end.add(const Duration(days: 1)).toUtc().toIso8601String()
      : null;

  String get _bucket {
    if (_range == 'day') return 'hour';
    if (_range == 'year' || _range == 'all') return 'month';
    return 'day';
  }

  Future<void> _load() async {
    final AppState state = AppScope.read(context);
    if (mounted) setState(() => _loading = true);
    try {
      final UsageResult usage = await state.statsService.usage(
        range: _range,
        from: _from,
        to: _to,
        model: _modelFilter,
        bucket: _bucket,
      );
      IntimacyResult intimacy = IntimacyResult.empty;
      CharacterOverview overview = CharacterOverview.empty;
      final Character? c = _character;
      if (c != null) {
        intimacy = await state.statsService.intimacy(
          characterId: c.id,
          range: _range,
          from: _from,
          to: _to,
        );
        overview = await state.statsService.overview(c.id);
      }
      if (!mounted) return;
      setState(() {
        _usage = usage;
        _intimacy = intimacy;
        _overview = overview;
        _error = null;
        _loading = false;
      });
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _error = e.message;
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = '$e';
          _loading = false;
        });
      }
    }
  }

  Future<void> _pickRange(String range) async {
    if (range == 'custom') {
      final DateTimeRange? picked = await showDateRangePicker(
        context: context,
        firstDate: DateTime(2024),
        lastDate: DateTime.now().add(const Duration(days: 1)),
        initialDateRange: _customRange,
        helpText: '选择时间范围',
        saveText: '确定',
      );
      if (picked == null) return;
      setState(() {
        _customRange = picked;
        _range = 'custom';
      });
    } else {
      setState(() => _range = range);
    }
    await _load();
  }

  Widget _rangeBar() {
    return SizedBox(
      height: 38,
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        children: <Widget>[
          ...kRangeLabels.entries.map((MapEntry<String, String> e) {
            final bool active = _range == e.key;
            return GestureDetector(
              onTap: () => _pickRange(e.key),
              child: Container(
                margin: const EdgeInsets.only(right: 8),
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                decoration: BoxDecoration(
                  color: active ? AppColors.cocoa : AppColors.white,
                  borderRadius: BorderRadius.circular(20),
                  border: Border.all(
                    color: active ? AppColors.cocoa : AppColors.sand,
                  ),
                ),
                child: Text(
                  e.value,
                  style: TextStyle(
                    fontSize: 12,
                    color: active ? Colors.white : AppColors.inkSoft,
                  ),
                ),
              ),
            );
          }),
          if (_range == 'custom' && _customRange != null)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              child: Text(
                '${formatDate(_customRange!.start.toIso8601String())} ~ ${formatDate(_customRange!.end.toIso8601String())}',
                style: const TextStyle(fontSize: 10.5, color: AppColors.inkSoft),
              ),
            ),
        ],
      ),
    );
  }

  Widget _tokenCards() {
    final UsageTotals t = _usage.totals;
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: <Color>[Color(0xFF7B5232), Color(0xFF5C3C25)],
        ),
        borderRadius: BorderRadius.circular(18),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              const Text(
                'Token 消耗',
                style: TextStyle(
                  color: Colors.white,
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const Spacer(),
              Text(
                '${compactNumber(t.total)} total · ${t.calls} 次调用',
                style: TextStyle(
                  color: Colors.white.withAlpha(180),
                  fontSize: 10.5,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            children: <Widget>[
              _tokenItem('输入命中', t.inputHit, const Color(0xFFF3E0C7)),
              _tokenItem('输入未命中', t.inputMiss, const Color(0xFFE3B78F)),
              _tokenItem('输出', t.output, const Color(0xFFD98E73)),
            ],
          ),
          const SizedBox(height: 10),
          Row(
            children: <Widget>[
              Text(
                '消费 ${formatCost(t.cost)}',
                style: const TextStyle(
                  color: Colors.white,
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const Spacer(),
              if (_modelFilter != null)
                GestureDetector(
                  onTap: () {
                    setState(() => _modelFilter = null);
                    _load();
                  },
                  child: Row(
                    children: <Widget>[
                      Text(
                        '模型：$_modelFilter ✕',
                        style: TextStyle(
                          color: Colors.white.withAlpha(200),
                          fontSize: 10.5,
                        ),
                      ),
                    ],
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _tokenItem(String label, int value, Color color) {
    return Expanded(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Container(
                width: 7,
                height: 7,
                decoration: BoxDecoration(color: color, shape: BoxShape.circle),
              ),
              const SizedBox(width: 5),
              Text(
                label,
                style: TextStyle(
                  color: Colors.white.withAlpha(200),
                  fontSize: 10,
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            compactNumber(value),
            style: const TextStyle(
              color: Colors.white,
              fontSize: 17,
              fontWeight: FontWeight.w700,
            ),
          ),
        ],
      ),
    );
  }

  Widget _usageChart() {
    final List<UsagePoint> series = _usage.series;
    if (series.isEmpty) {
      return const SizedBox(
        height: 120,
        child: Center(
          child: Text(
            '该时间范围还没有用量数据',
            style: TextStyle(fontSize: 11.5, color: AppColors.inkSoft),
          ),
        ),
      );
    }
    double maxY = 0;
    for (final UsagePoint p in series) {
      final double v = (p.input + p.output).toDouble();
      if (v > maxY) maxY = v;
    }
    if (maxY <= 0) maxY = 100;
    final double interval = maxY / 4;
    return SizedBox(
      height: 190,
      child: BarChart(
        BarChartData(
          maxY: maxY * 1.18,
          minY: 0,
          alignment: BarChartAlignment.spaceAround,
          gridData: FlGridData(
            show: true,
            drawVerticalLine: false,
            horizontalInterval: interval <= 0 ? null : interval,
            getDrawingHorizontalLine: (double v) => FlLine(
              color: AppColors.sand.withAlpha(120),
              strokeWidth: 1,
            ),
          ),
          borderData: FlBorderData(show: false),
          titlesData: FlTitlesData(
            topTitles: const AxisTitles(
              sideTitles: SideTitles(showTitles: false),
            ),
            rightTitles: const AxisTitles(
              sideTitles: SideTitles(showTitles: false),
            ),
            leftTitles: AxisTitles(
              sideTitles: SideTitles(
                showTitles: true,
                reservedSize: 38,
                interval: interval <= 0 ? null : interval,
                getTitlesWidget: (double value, TitleMeta meta) => Text(
                  compactNumber(value),
                  style: const TextStyle(
                    fontSize: 9,
                    color: AppColors.inkSoft,
                  ),
                ),
              ),
            ),
            bottomTitles: AxisTitles(
              sideTitles: SideTitles(
                showTitles: true,
                reservedSize: 24,
                interval: (series.length / 5).ceilToDouble().clamp(1.0, 999.0).toDouble(),
                getTitlesWidget: (double value, TitleMeta meta) {
                  final int i = value.toInt();
                  if (i < 0 || i >= series.length) return const SizedBox.shrink();
                  final String key = series[i].key;
                  final String label = key.length >= 10
                      ? key.substring(key.length >= 10 ? 5 : 0)
                      : key;
                  return Text(
                    label,
                    style: const TextStyle(
                      fontSize: 8.5,
                      color: AppColors.inkSoft,
                    ),
                  );
                },
              ),
            ),
          ),
          barTouchData: BarTouchData(
            enabled: true,
            handleBuiltInTouches: false,
            touchCallback: (FlTouchEvent event, BarTouchResponse? response) {
              if (event is! FlTapUpEvent) return;
              final int? index = response?.spot?.touchedBarGroupIndex;
              if (index == null || index < 0 || index >= series.length) return;
              _showPointDetail(series[index]);
            },
          ),
          barGroups: <BarChartGroupData>[
            for (int i = 0; i < series.length; i++)
              BarChartGroupData(
                x: i,
                barRods: <BarChartRodData>[
                  BarChartRodData(
                    toY: (series[i].input + series[i].output).toDouble(),
                    width: series.length > 24 ? 6 : 14,
                    borderRadius: BorderRadius.circular(3),
                    rodStackItems: <BarChartRodStackItem>[
                      BarChartRodStackItem(
                        0,
                        series[i].input.toDouble(),
                        const Color(0xFFD98E73),
                      ),
                      BarChartRodStackItem(
                        series[i].input.toDouble(),
                        (series[i].input + series[i].output).toDouble(),
                        const Color(0xFF8B5E3C),
                      ),
                    ],
                  ),
                ],
              ),
          ],
        ),
      ),
    );
  }

  Future<void> _showPointDetail(UsagePoint p) async {
    await showDialog<void>(
      context: context,
      builder: (BuildContext ctx) => AlertDialog(
        title: Text(p.key),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            _detailRow('输入命中', '${compactNumber(p.cached)} tokens'),
            _detailRow('输入未命中', '${compactNumber(p.input - p.cached)} tokens'),
            _detailRow('输入合计', '${compactNumber(p.input)} tokens'),
            _detailRow('输出', '${compactNumber(p.output)} tokens'),
            _detailRow('合计', '${compactNumber(p.total)} tokens'),
            _detailRow('消费', formatCost(p.cost)),
            _detailRow('调用', '${p.calls} 次'),
          ],
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

  Widget _detailRow(String key, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: <Widget>[
          SizedBox(
            width: 76,
            child: Text(
              key,
              style: const TextStyle(fontSize: 11.5, color: AppColors.inkSoft),
            ),
          ),
          Text(value, style: const TextStyle(fontSize: 12.5)),
        ],
      ),
    );
  }

  Widget _companionBanner() {
    final int days = _intimacy.companionDays > 0
        ? _intimacy.companionDays
        : _overview.companionDays;
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
      decoration: BoxDecoration(
        gradient: kRoseGradient,
        borderRadius: BorderRadius.circular(20),
      ),
      child: Row(
        children: <Widget>[
          HeartNumber(number: '$days', size: 104),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  '${_character?.name ?? '角色'}陪你走过',
                  style: const TextStyle(fontSize: 12, color: AppColors.ink),
                ),
                const SizedBox(height: 2),
                const Text(
                  '陪伴天数',
                  style: TextStyle(
                    fontSize: 20,
                    fontWeight: FontWeight.w800,
                    color: Colors.white,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  '当前亲密度 ${_intimacy.current.toStringAsFixed(1)} / 100',
                  style: TextStyle(
                    fontSize: 11,
                    color: Colors.white.withAlpha(230),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _intimacyChart() {
    final List<IntimacyPoint> points = _intimacy.points;
    if (points.length < 2) {
      return const SizedBox(
        height: 90,
        child: Center(
          child: Text(
            '亲密度变化数据不足，多陪伴几天就会有折线啦',
            style: TextStyle(fontSize: 11.5, color: AppColors.inkSoft),
          ),
        ),
      );
    }
    final List<FlSpot> spots = <FlSpot>[
      for (int i = 0; i < points.length; i++)
        FlSpot(i.toDouble(), points[i].v.clamp(0.0, 100.0).toDouble()),
    ];
    return SizedBox(
      height: 150,
      child: LineChart(
        LineChartData(
          minY: 0,
          maxY: 100,
          gridData: FlGridData(
            show: true,
            drawVerticalLine: false,
            horizontalInterval: 25,
            getDrawingHorizontalLine: (double v) => FlLine(
              color: AppColors.sand.withAlpha(120),
              strokeWidth: 1,
            ),
          ),
          borderData: FlBorderData(show: false),
          titlesData: FlTitlesData(
            topTitles: const AxisTitles(
              sideTitles: SideTitles(showTitles: false),
            ),
            rightTitles: const AxisTitles(
              sideTitles: SideTitles(showTitles: false),
            ),
            leftTitles: AxisTitles(
              sideTitles: SideTitles(
                showTitles: true,
                reservedSize: 28,
                interval: 25,
                getTitlesWidget: (double value, TitleMeta meta) => Text(
                  value.toInt().toString(),
                  style: const TextStyle(fontSize: 9, color: AppColors.inkSoft),
                ),
              ),
            ),
            bottomTitles: AxisTitles(
              sideTitles: SideTitles(
                showTitles: true,
                reservedSize: 22,
                interval: (points.length / 4).ceilToDouble().clamp(1.0, 999.0).toDouble(),
                getTitlesWidget: (double value, TitleMeta meta) {
                  final int i = value.toInt();
                  if (i < 0 || i >= points.length) return const SizedBox.shrink();
                  return Text(
                    formatDate(points[i].t),
                    style: const TextStyle(
                      fontSize: 8,
                      color: AppColors.inkSoft,
                    ),
                  );
                },
              ),
            ),
          ),
          lineTouchData: const LineTouchData(enabled: false),
          lineBarsData: <LineChartBarData>[
            LineChartBarData(
              spots: spots,
              isCurved: true,
              curveSmoothness: 0.25,
              color: AppColors.cocoa,
              barWidth: 2.4,
              dotData: const FlDotData(show: false),
              belowBarData: BarAreaData(
                show: true,
                gradient: LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: <Color>[
                    AppColors.rose.withAlpha(90),
                    AppColors.rose.withAlpha(8),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _overviewGrid() {
    final List<Widget> items = <Widget>[
      _countCard('对话数', _overview.chatCount, Icons.chat_bubble_outline),
      _countCard('创作文集', _overview.bookCount, Icons.menu_book_outlined),
      _countCard('健康异常', _overview.healthAbnormal, Icons.healing_outlined),
      _countCard('心情异常', _overview.moodAbnormal, Icons.mood_bad_outlined),
      _countCard('调用次数', _overview.calls, Icons.bolt_outlined),
    ];
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12),
      child: LayoutBuilder(
        builder: (BuildContext ctx, BoxConstraints c) {
          final double itemWidth = (c.maxWidth - 24) / 4;
          return Wrap(
            spacing: 8,
            runSpacing: 8,
            children: items
                .map((Widget item) => SizedBox(width: itemWidth, child: item))
                .toList(),
          );
        },
      ),
    );
  }

  Widget _callsSection() {
    final List<ModelCallCount> list = _overview.callsByModel;
    if (list.isEmpty) return const SizedBox.shrink();
    return SectionCard(
      title: '按模型调用次数',
      child: Column(
        children: list
            .map(
              (ModelCallCount m) => Padding(
                padding: const EdgeInsets.symmetric(vertical: 5),
                child: Row(
                  children: <Widget>[
                    Expanded(
                      child: Text(
                        m.model,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 12),
                      ),
                    ),
                    Text(
                      '${m.calls} 次',
                      style: const TextStyle(
                        fontSize: 11,
                        color: AppColors.cocoa,
                      ),
                    ),
                  ],
                ),
              ),
            )
            .toList(),
      ),
    );
  }

  Widget _countCard(String label, int value, IconData icon) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 8),
      decoration: BoxDecoration(
        color: AppColors.white,
        borderRadius: BorderRadius.circular(13),
        border: Border.all(color: AppColors.sand),
      ),
      child: Column(
        children: <Widget>[
          Icon(icon, size: 15, color: AppColors.rose),
          const SizedBox(height: 4),
          Text(
            '$value',
            style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
          ),
          Text(
            label,
            style: const TextStyle(fontSize: 9.5, color: AppColors.inkSoft),
          ),
        ],
      ),
    );
  }

  Widget _modelsSection() {
    if (_usage.models.isEmpty) return const SizedBox.shrink();
    return SectionCard(
      title: '按模型统计',
      child: Column(
        children: _usage.models.map((ModelUsage m) {
          final bool active = _modelFilter == m.model;
          return InkWell(
            onTap: () {
              setState(() => _modelFilter = active ? null : m.model);
              _load();
            },
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: Row(
                children: <Widget>[
                  Icon(
                    active ? Icons.check_circle : Icons.circle_outlined,
                    size: 13,
                    color: active ? AppColors.cocoa : AppColors.inkSoft,
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      m.model,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 12),
                    ),
                  ),
                  Text(
                    '${compactNumber(m.total)} tokens · ${m.calls} 次',
                    style: const TextStyle(
                      fontSize: 10,
                      color: AppColors.inkSoft,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    formatCost(m.cost),
                    style: const TextStyle(fontSize: 10.5, color: AppColors.cocoa),
                  ),
                ],
              ),
            ),
          );
        }).toList(),
      ),
    );
  }

  Widget _characterBar() {
    if (_characters.isEmpty) return const SizedBox.shrink();
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 6, 12, 2),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
      decoration: BoxDecoration(
        color: AppColors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.sand),
      ),
      child: Row(
        children: <Widget>[
          const Icon(Icons.favorite, size: 14, color: AppColors.rose),
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
                onChanged: (String? id) async {
                  if (id == null) return;
                  final Character c =
                      _characters.firstWhere((Character x) => x.id == id);
                  setState(() => _character = c);
                  await AppScope.read(context).setActiveCharacter(c.id);
                  await _load();
                },
              ),
            ),
          ),
          IconButton(
            icon: const Icon(Icons.refresh, size: 17),
            onPressed: _load,
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const LoadingView(text: '统计加载中…');
    if (_error != null && _usage.series.isEmpty) {
      return Column(
        children: <Widget>[
          _rangeBar(),
          Expanded(
            child: EmptyView(
              text: '统计加载失败\n$_error',
              icon: Icons.cloud_off,
              action: OutlinedButton(
                onPressed: _load,
                child: const Text('重试'),
              ),
            ),
          ),
        ],
      );
    }
    final bool wide = MediaQuery.sizeOf(context).width >= 700;
    final Widget usageCard = SectionCard(
      title: '用量柱状图',
      trailing: const Text(
        '点击柱体查看详情',
        style: TextStyle(fontSize: 9.5, color: AppColors.inkSoft),
      ),
      child: _usageChart(),
    );
    final Widget intimacyCard = SectionCard(
      title: '亲密度变化',
      child: _intimacyChart(),
    );
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: pagePadding(context),
        children: <Widget>[
          _characterBar(),
          const SizedBox(height: 4),
          _rangeBar(),
          _tokenCards(),
          if (wide)
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Expanded(child: usageCard),
                const SizedBox(width: 8),
                Expanded(child: intimacyCard),
              ],
            )
          else ...<Widget>[usageCard, intimacyCard],
          _companionBanner(),
          if (wide)
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Expanded(child: _overviewGrid()),
                const SizedBox(width: 8),
                Expanded(child: _modelsSection()),
              ],
            )
          else ...<Widget>[
            const SizedBox(height: 4),
            _overviewGrid(),
            const SizedBox(height: 6),
            _modelsSection(),
          ],
          const SizedBox(height: 6),
          _callsSection(),
        ],
      ),
    );
  }
}
