import 'package:flutter/material.dart';

import '../core/theme.dart';

/// v1.5.1：独立一言卡片（渐变玻璃、引号、刷新、点击换一条）。
class SayingCard extends StatefulWidget {
  const SayingCard({
    super.key,
    required this.saying,
    required this.loading,
    required this.onRefresh,
  });

  final String saying;
  final bool loading;
  final VoidCallback onRefresh;

  @override
  State<SayingCard> createState() => _SayingCardState();
}

class _SayingCardState extends State<SayingCard> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final double width = MediaQuery.sizeOf(context).width;
    final double fontSize = (width >= 900
            ? 22.0
            : width >= 600
                ? 20.0
                : 18.0)
        .clamp(18.0, 22.0);
    final bool empty = widget.saying.trim().isEmpty;
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 760),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(0, 4, 0, 10),
          child: Material(
            color: Colors.transparent,
            child: InkWell(
              onTap: widget.onRefresh,
              borderRadius: BorderRadius.circular(18),
              child: Ink(
                decoration: BoxDecoration(
                  gradient: const LinearGradient(
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                    colors: <Color>[
                      Color(0xFFFFF7EE),
                      Color(0xFFF1D9C8),
                      Color(0xFFE8C4B0),
                    ],
                  ),
                  borderRadius: BorderRadius.circular(18),
                  border: Border.all(color: Colors.white.withAlpha(150)),
                  boxShadow: <BoxShadow>[
                    BoxShadow(
                      color: AppColors.cocoa.withAlpha(30),
                      blurRadius: 18,
                      offset: const Offset(0, 8),
                    ),
                  ],
                ),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 10, 10),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          const Icon(
                            Icons.format_quote_rounded,
                            size: 30,
                            color: AppColors.cocoa,
                          ),
                          const SizedBox(width: 6),
                          Expanded(
                            child: widget.loading && empty
                                ? _skeleton()
                                : GestureDetector(
                                    onTap: () {
                                      if (widget.saying.length > 60) {
                                        setState(
                                          () => _expanded = !_expanded,
                                        );
                                      } else {
                                        widget.onRefresh();
                                      }
                                    },
                                    child: Text(
                                      empty ? '正在寻找一句话…' : widget.saying,
                                      maxLines: _expanded ? null : 3,
                                      overflow: _expanded
                                          ? TextOverflow.visible
                                          : TextOverflow.ellipsis,
                                      style: TextStyle(
                                        fontSize: fontSize,
                                        height: 1.45,
                                        color: AppColors.ink,
                                        fontWeight: FontWeight.w600,
                                        fontFamily:
                                            Theme.of(context).textTheme.bodyLarge?.fontFamily,
                                      ),
                                    ),
                                  ),
                          ),
                          IconButton(
                            tooltip: '换一条',
                            visualDensity: VisualDensity.compact,
                            onPressed: widget.loading ? null : widget.onRefresh,
                            icon: widget.loading
                                ? const SizedBox(
                                    width: 16,
                                    height: 16,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 2,
                                    ),
                                  )
                                : const Icon(Icons.refresh, size: 19),
                          ),
                        ],
                      ),
                      Padding(
                        padding: const EdgeInsets.only(left: 38, top: 4),
                        child: Row(
                          children: <Widget>[
                            const Text(
                              '一言 · UAPIS',
                              style: TextStyle(
                                fontSize: 10,
                                color: AppColors.inkSoft,
                                letterSpacing: 0.4,
                              ),
                            ),
                            if (widget.saying.length > 60)
                              Text(
                                _expanded ? ' · 点击收起' : ' · 点击展开',
                                style: const TextStyle(
                                  fontSize: 9.5,
                                  color: AppColors.inkSoft,
                                ),
                              ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _skeleton() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Container(
          height: 18,
          width: double.infinity,
          decoration: BoxDecoration(
            color: AppColors.inkSoft.withAlpha(25),
            borderRadius: BorderRadius.circular(5),
          ),
        ),
        const SizedBox(height: 8),
        FractionallySizedBox(
          widthFactor: 0.7,
          child: Container(
            height: 18,
            decoration: BoxDecoration(
              color: AppColors.inkSoft.withAlpha(20),
              borderRadius: BorderRadius.circular(5),
            ),
          ),
        ),
      ],
    );
  }
}
