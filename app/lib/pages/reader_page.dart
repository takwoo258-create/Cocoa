import 'package:flutter/material.dart';

import '../core/json_utils.dart';
import '../core/theme.dart';
import '../core/utils.dart';
import '../models/book.dart';
import '../widgets/qzone_share_sheet.dart';

class ReaderPage extends StatelessWidget {
  const ReaderPage({super.key, required this.book});

  final Book book;

  String get _shareImageUrl {
    final String image = asString(
      book.meta['image'] ?? book.meta['cover'] ?? book.meta['imageUrl'],
    );
    return image;
  }

  String get _shareContent {
    final String body = book.content.isNotEmpty ? book.content : book.previewText;
    return '${book.title}\n\n${body.length > 600 ? body.substring(0, 600) : body}';
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFFDF7F0),
      appBar: AppBar(
        title: Text(
          kTypeLabel(book.type),
          style: const TextStyle(fontSize: 15),
        ),
        actions: <Widget>[
          IconButton(
            tooltip: '分享到 QQ 动态',
            icon: const Icon(Icons.share_outlined, size: 20),
            onPressed: () => showQzoneShare(
              context,
              defaultContent: _shareContent,
              imageUrl: _shareImageUrl.isEmpty ? null : _shareImageUrl,
            ),
          ),
        ],
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(22, 18, 22, 40),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(
              book.title,
              style: const TextStyle(
                fontSize: 21,
                fontWeight: FontWeight.w700,
                height: 1.4,
                color: AppColors.ink,
              ),
            ),
            const SizedBox(height: 8),
            Row(
              children: <Widget>[
                Text(
                  formatDateTime(book.displayDate),
                  style: const TextStyle(
                    fontSize: 11,
                    color: AppColors.inkSoft,
                  ),
                ),
                const SizedBox(width: 10),
                if (book.locked)
                  const Text(
                    '已加密',
                    style: TextStyle(fontSize: 10, color: AppColors.rose),
                  ),
              ],
            ),
            const SizedBox(height: 16),
            const Divider(color: AppColors.sand),
            const SizedBox(height: 14),
            SelectableText(
              book.content.isEmpty ? '（还没有正文内容）' : book.content,
              style: const TextStyle(
                fontSize: 15,
                height: 1.85,
                color: AppColors.ink,
                letterSpacing: 0.2,
              ),
            ),
            const SizedBox(height: 30),
            Center(
              child: Text(
                '— ${book.type == 'diary' ? '日记' : book.type == 'news' ? '阅读记录' : '创作'} · Cocoa —',
                style: const TextStyle(
                  fontSize: 10.5,
                  color: AppColors.inkSoft,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  String kTypeLabel(String type) {
    switch (type) {
      case 'novel':
        return '小说';
      case 'essay':
        return '文集';
      case 'diary':
        return '日记';
      case 'news':
        return '浏览记录';
      default:
        return '阅读';
    }
  }
}
