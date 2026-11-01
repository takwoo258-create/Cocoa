import '../core/api_client.dart';
import '../core/json_utils.dart';

/// QQ 空间动态（POST /api/onebot/qzone）。
class SocialService {
  SocialService(this.api);

  final ApiClient api;

  /// 机器人 QQ / 连接状态（v1.2.0，角色页展示）。
  Future<Map<String, dynamic>> onebotStatus() async {
    return asMap(await api.get('/onebot/status', silent: true));
  }

  /// content 会自动截断到 1000 字；未连接 NapCat 时后端返回 503。
  Future<Map<String, dynamic>> shareQzone({
    required String content,
    List<String> images = const <String>[],
    int ugcRight = 1,
  }) async {
    final String text =
        content.length > 1000 ? content.substring(0, 1000) : content;
    final dynamic r = await api.post(
      '/onebot/qzone',
      body: <String, dynamic>{
        'content': text,
        if (images.isNotEmpty) 'images': images,
        'ugcRight': ugcRight,
      },
      silent: true,
    );
    return asMap(r);
  }
}
