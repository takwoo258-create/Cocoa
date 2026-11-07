import '../core/api_client.dart';
import '../core/json_utils.dart';
import '../models/stats_models.dart';

class AdminService {
  AdminService(this.api);

  final ApiClient api;

  Future<AdminOverview> overview() async {
    final dynamic r = await api.get('/admin/overview');
    final Map<String, dynamic> m = asMap(r);
    final dynamic o = m['overview'];
    return AdminOverview.fromJson(o is Map ? asMap(o) : m);
  }

  Future<Map<String, dynamic>> users({
    String q = '',
    int page = 1,
    int size = 20,
  }) async {
    final dynamic r = await api.get(
      '/admin/users',
      query: <String, dynamic>{'q': q, 'page': page, 'size': size},
    );
    final Map<String, dynamic> m = asMap(r);
    if (m['items'] == null && r is List) {
      return <String, dynamic>{'items': r, 'total': r.length, 'page': page};
    }
    return m;
  }

  Future<void> updateUser(
    String id, {
    String? role,
    String? status,
    String? qq,
  }) async {
    await api.put('/admin/users/$id', body: <String, dynamic>{
      if (role != null) 'role': role,
      if (status != null) 'status': status,
      if (qq != null) 'qq': qq,
    });
  }

  Future<UsageResult> usage({
    String range = '7d',
    String? from,
    String? to,
    String? model,
    String? userId,
    String? bucket,
  }) async {
    final dynamic r = await api.get(
      '/admin/usage',
      query: <String, dynamic>{
        'range': range,
        'from': from,
        'to': to,
        'model': model,
        'userId': userId,
        'bucket': bucket,
      },
    );
    return UsageResult.fromJson(asMap(r));
  }

  /// 管理端用量原始响应（含 byUser）。
  Future<Map<String, dynamic>> usageRaw({
    String range = '7d',
    String? from,
    String? to,
    String? model,
    String? userId,
    String? bucket,
  }) async {
    return asMap(await api.get(
      '/admin/usage',
      query: <String, dynamic>{
        'range': range,
        'from': from,
        'to': to,
        'model': model,
        'userId': userId,
        'bucket': bucket,
      },
    ));
  }

  Future<Map<String, dynamic>> conversations({
    String? userId,
    int page = 1,
    int size = 20,
  }) async {
    return asMap(await api.get(
      '/admin/conversations',
      query: <String, dynamic>{
        'userId': userId,
        'page': page,
        'size': size,
      },
    ));
  }

  Future<Map<String, dynamic>> conversation(String id) async {
    return asMap(await api.get('/admin/conversations/$id'));
  }

  Future<Map<String, dynamic>> logs({
    int page = 1,
    int size = 30,
    String action = '',
  }) async {
    return asMap(await api.get(
      '/admin/logs',
      query: <String, dynamic>{
        'page': page,
        'size': size,
        'action': action,
      },
    ));
  }

  Future<Map<String, dynamic>> settings() async {
    return asMap(await api.get('/admin/settings'));
  }

  Future<Map<String, dynamic>> saveSettings(Map<String, dynamic> body) async {
    final dynamic r = await api.put('/admin/settings', body: body);
    final Map<String, dynamic> m = asMap(r);
    return m['settings'] is Map ? asMap(m['settings']) : m;
  }

  Future<Map<String, dynamic>> testMail(String to) async {
    return asMap(await api.post(
      '/admin/settings/test-mail',
      body: <String, dynamic>{'to': to},
    ));
  }

  Future<Map<String, dynamic>> storage() async {
    return asMap(await api.get('/admin/storage'));
  }

  Future<Map<String, dynamic>> onebotStatus() async {
    return asMap(await api.get('/admin/onebot/status', silent: true));
  }

  /// v1.2.0：服务器状态（CPU/内存/磁盘/网络）。
  Future<Map<String, dynamic>> serverStatus() async {
    return asMap(await api.get('/admin/server-status', silent: true));
  }

  Future<List<Map<String, dynamic>>> plazaBans() async {
    final dynamic r = await api.get('/admin/plaza/bans', silent: true);
    return asMapList(r is List ? r : asMap(r)['items']);
  }

  Future<void> createPlazaBan(Map<String, dynamic> body) =>
      api.put('/admin/plaza/bans', body: body);

  Future<void> deletePlazaBan(String id) =>
      api.delete('/admin/plaza/bans/$id');

  /// v1.2.0：后端可升级版本列表。
  Future<List<Map<String, dynamic>>> upgradeVersions() async {
    final dynamic r = await api.get('/admin/upgrade/versions', silent: true);
    final List<dynamic> raw = r is List ? r : asList(asMap(r)['items']);
    return asMapList(raw);
  }

  Future<Map<String, dynamic>> startUpgrade(String tag) async {
    return asMap(await api.post(
      '/admin/upgrade',
      body: <String, dynamic>{'tag': tag},
    ));
  }

  Future<Map<String, dynamic>> upgradeStatus() async {
    return asMap(await api.get('/admin/upgrade/status', silent: true));
  }
}
