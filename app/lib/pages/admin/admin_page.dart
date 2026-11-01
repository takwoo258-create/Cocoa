import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/api_client.dart';
import '../../core/app_state.dart';
import '../../core/constants.dart';
import '../../core/global.dart';
import '../../core/json_utils.dart';
import '../../core/layout.dart';
import '../../core/theme.dart';
import '../../core/utils.dart';
import '../../models/stats_models.dart';
import '../../widgets/common.dart';

/// 管理端：概览 / 用户 / 用量 / 会话 / 日志 / 服务配置 / 存储。
class AdminPage extends StatefulWidget {
  const AdminPage({super.key});

  @override
  State<AdminPage> createState() => _AdminPageState();
}

class _AdminPageState extends State<AdminPage>
    with SingleTickerProviderStateMixin {
  late final TabController _tab;
  final Set<int> _loadedTabs = <int>{};

  AdminOverview _overview = AdminOverview.empty;
  StorageUsage _storage = StorageUsage.empty;
  bool _loadingOverview = true;
  String? _authError;

  final TextEditingController _userQuery = TextEditingController();
  List<Map<String, dynamic>> _users = <Map<String, dynamic>>[];
  int _userPage = 1;
  int _userTotal = 0;
  bool _loadingUsers = false;

  String _range = '7d';
  String _usageUser = '';
  UsageResult _usage = UsageResult.empty;
  Map<String, dynamic> _usageRaw = <String, dynamic>{};
  bool _loadingUsage = false;

  List<Map<String, dynamic>> _conversations = <Map<String, dynamic>>[];
  int _convPage = 1;
  int _convTotal = 0;
  bool _loadingConvs = false;

  List<Map<String, dynamic>> _logs = <Map<String, dynamic>>[];
  int _logPage = 1;
  int _logTotal = 0;
  String _logAction = '';
  bool _loadingLogs = false;

  final TextEditingController _smtpHost = TextEditingController();
  final TextEditingController _smtpPort = TextEditingController(text: '465');
  final TextEditingController _smtpUser = TextEditingController();
  final TextEditingController _smtpPass = TextEditingController();
  final TextEditingController _smtpFrom = TextEditingController();
  final TextEditingController _testMail = TextEditingController();
  final TextEditingController _obToken = TextEditingController();
  final TextEditingController _obSelfId = TextEditingController();
  final TextEditingController _obPath = TextEditingController();
  final TextEditingController _updateMinVersion = TextEditingController();
  bool _updateForce = false;
  bool _smtpSecure = true;
  bool _settingsLoaded = false;
  bool _savingSettings = false;
  Map<String, dynamic> _onebotStatus = <String, dynamic>{};

  @override
  void initState() {
    super.initState();
    _tab = TabController(length: 7, vsync: this);
    _tab.addListener(_onTabChanged);
    WidgetsBinding.instance.addPostFrameCallback((_) => _loadOverview());
  }

  @override
  void dispose() {
    _tab.removeListener(_onTabChanged);
    _tab.dispose();
    for (final TextEditingController c in <TextEditingController>[
      _userQuery,
      _smtpHost,
      _smtpPort,
      _smtpUser,
      _smtpPass,
      _smtpFrom,
      _testMail,
      _obToken,
      _obSelfId,
      _obPath,
      _updateMinVersion,
    ]) {
      c.dispose();
    }
    super.dispose();
  }

  void _onTabChanged() {
    if (_tab.indexIsChanging) return;
    final int i = _tab.index;
    if (_loadedTabs.contains(i)) return;
    switch (i) {
      case 1:
        _loadUsers();
        break;
      case 2:
        _loadUsage();
        break;
      case 3:
        _loadConversations();
        break;
      case 4:
        _loadLogs();
        break;
      case 5:
        _loadSettings();
        break;
      case 6:
        _loadStorage();
        break;
    }
  }

  Future<void> _loadOverview() async {
    final AppState state = AppScope.read(context);
    if (mounted) setState(() => _loadingOverview = true);
    try {
      final AdminOverview overview = await state.adminService.overview();
      if (!mounted) return;
      setState(() {
        _overview = overview;
        _storage = overview.storage;
        _onebotStatus = overview.onebot;
        _loadingOverview = false;
        _authError = null;
      });
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _loadingOverview = false;
          if (e.statusCode == 403 || e.code.contains('forbidden') || e.code.contains('admin')) {
            _authError = e.message;
          }
        });
      }
      showToast(e.message, isError: true);
    } catch (e) {
      if (mounted) setState(() => _loadingOverview = false);
      showToast('概览加载失败：$e', isError: true);
    }
  }

  Future<void> _loadUsers({bool reset = false}) async {
    final AppState state = AppScope.read(context);
    if (reset) _userPage = 1;
    setState(() => _loadingUsers = true);
    try {
      final Map<String, dynamic> r = await state.adminService.users(
        q: _userQuery.text.trim(),
        page: _userPage,
        size: 20,
      );
      if (!mounted) return;
      setState(() {
        _users = asMapList(r['items']);
        _userTotal = asInt(r['total'], _users.length);
        _loadingUsers = false;
        _loadedTabs.add(1);
      });
    } catch (e) {
      if (mounted) setState(() => _loadingUsers = false);
      showToast('用户列表加载失败：$e', isError: true);
    }
  }

  Future<void> _loadUsage() async {
    final AppState state = AppScope.read(context);
    setState(() => _loadingUsage = true);
    try {
      final Map<String, dynamic> raw = await state.adminService.usageRaw(
        range: _range,
        userId: _usageUser.trim().isEmpty ? null : _usageUser.trim(),
        bucket: _range == 'day' ? 'hour' : 'day',
      );
      if (!mounted) return;
      setState(() {
        _usageRaw = raw;
        _usage = UsageResult.fromJson(raw);
        _loadingUsage = false;
        _loadedTabs.add(2);
      });
    } catch (e) {
      if (mounted) setState(() => _loadingUsage = false);
      showToast('用量加载失败：$e', isError: true);
    }
  }

  Future<void> _loadConversations({bool reset = false}) async {
    final AppState state = AppScope.read(context);
    if (reset) _convPage = 1;
    setState(() => _loadingConvs = true);
    try {
      final Map<String, dynamic> r = await state.adminService.conversations(
        page: _convPage,
        size: 20,
      );
      if (!mounted) return;
      setState(() {
        _conversations = asMapList(r['items']);
        _convTotal = asInt(r['total'], _conversations.length);
        _loadingConvs = false;
        _loadedTabs.add(3);
      });
    } catch (e) {
      if (mounted) setState(() => _loadingConvs = false);
      showToast('会话加载失败：$e', isError: true);
    }
  }

  Future<void> _loadLogs({bool reset = false}) async {
    final AppState state = AppScope.read(context);
    if (reset) _logPage = 1;
    setState(() => _loadingLogs = true);
    try {
      final Map<String, dynamic> r = await state.adminService.logs(
        page: _logPage,
        size: 30,
        action: _logAction.trim(),
      );
      if (!mounted) return;
      setState(() {
        _logs = asMapList(r['items']);
        _logTotal = asInt(r['total'], _logs.length);
        _loadingLogs = false;
        _loadedTabs.add(4);
      });
    } catch (e) {
      if (mounted) setState(() => _loadingLogs = false);
      showToast('日志加载失败：$e', isError: true);
    }
  }

  Future<void> _loadStorage() async {
    final AppState state = AppScope.read(context);
    try {
      final Map<String, dynamic> raw = await state.adminService.storage();
      final Map<String, dynamic> ob = await state.adminService.onebotStatus();
      if (!mounted) return;
      setState(() {
        _storage = StorageUsage.fromJson(raw);
        _onebotStatus = ob;
        _loadedTabs.add(6);
      });
    } catch (e) {
      showToast('存储信息加载失败：$e', isError: true);
    }
  }

  Future<void> _loadSettings() async {
    final AppState state = AppScope.read(context);
    try {
      final Map<String, dynamic> s = await state.adminService.settings();
      final Map<String, dynamic> smtp = asMap(s['smtp']);
      final Map<String, dynamic> onebot = asMap(s['onebot']);
      final Map<String, dynamic> update = asMap(s['update']);
      if (!mounted) return;
      setState(() {
        _smtpHost.text = asString(smtp['host']);
        _smtpPort.text = asString(smtp['port'], '465');
        _smtpUser.text = asString(smtp['user']);
        _smtpFrom.text = asString(smtp['from']);
        _smtpSecure = asBool(smtp['secure'], true);
        _obSelfId.text = asString(onebot['selfId']);
        _obPath.text = asString(onebot['wsPath'], '/onebot/ws');
        _updateForce = asBool(update['force']);
        _updateMinVersion.text = asString(update['minVersion']);
        _settingsLoaded = true;
        _loadedTabs.add(5);
      });
    } catch (e) {
      showToast('服务端配置加载失败：$e', isError: true);
    }
  }

  Future<void> _saveSettings() async {
    final AppState state = AppScope.read(context);
    setState(() => _savingSettings = true);
    try {
      await state.adminService.saveSettings(<String, dynamic>{
        'smtp': <String, dynamic>{
          'host': _smtpHost.text.trim(),
          'port': int.tryParse(_smtpPort.text.trim()) ?? 465,
          'secure': _smtpSecure,
          'user': _smtpUser.text.trim(),
          'from': _smtpFrom.text.trim(),
          'pass': _smtpPass.text.trim().isEmpty
              ? '****'
              : _smtpPass.text.trim(),
        },
        'onebot': <String, dynamic>{
          'token': _obToken.text.trim().isEmpty ? '****' : _obToken.text.trim(),
          'selfId': _obSelfId.text.trim(),
          'wsPath': _obPath.text.trim(),
        },
        'update': <String, dynamic>{
          'force': _updateForce,
          'minVersion': _updateMinVersion.text.trim(),
        },
      });
      _smtpPass.clear();
      _obToken.clear();
      if (mounted) showToast('服务端配置已保存');
      await _loadSettings();
      await _loadOverview();
    } on ApiException catch (e) {
      showToast(e.message, isError: true);
    } catch (e) {
      showToast('保存失败：$e', isError: true);
    } finally {
      if (mounted) setState(() => _savingSettings = false);
    }
  }

  Future<void> _sendTestMail() async {
    final AppState state = AppScope.read(context);
    final String to = _testMail.text.trim();
    if (!to.contains('@')) {
      showToast('请输入收件邮箱');
      return;
    }
    try {
      await state.adminService.testMail(to);
      showToast('测试邮件已发送');
    } on ApiException catch (e) {
      showToast(e.message, isError: true);
    }
  }

  Future<void> _userActions(Map<String, dynamic> user) async {
    final String id = asString(user['id']);
    final String role = asString(user['role'], 'user');
    final String status = asString(user['status'], 'active');
    await showModalBottomSheet<void>(
      context: context,
      builder: (BuildContext ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Padding(
              padding: const EdgeInsets.all(14),
              child: Text(
                '${asString(user['username'])} · ${asString(user['email'])}',
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
            ),
            ListTile(
              leading: const Icon(Icons.verified_user_outlined),
              title: Text(role == 'admin' ? '降级为普通用户' : '设为管理员'),
              onTap: () async {
                Navigator.of(ctx).pop();
                await _updateUser(id, role: role == 'admin' ? 'user' : 'admin');
              },
            ),
            ListTile(
              leading: const Icon(Icons.block),
              title: Text(status == 'active' ? '停用账号' : '启用账号'),
              onTap: () async {
                Navigator.of(ctx).pop();
                await _updateUser(
                  id,
                  status: status == 'active' ? 'disabled' : 'active',
                );
              },
            ),
            ListTile(
              leading: const Icon(Icons.numbers),
              title: const Text('修改绑定 QQ'),
              onTap: () async {
                Navigator.of(ctx).pop();
                await _editUserQq(user);
              },
            ),
          ],
        ),
      ),
    );
    if (!mounted) return;
    if (role.isNotEmpty) setState(() {});
  }

  Future<void> _updateUser(
    String id, {
    String? role,
    String? status,
    String? qq,
  }) async {
    final AppState state = AppScope.read(context);
    try {
      await state.adminService.updateUser(id, role: role, status: status, qq: qq);
      showToast('已更新用户');
      await _loadUsers();
    } on ApiException catch (e) {
      showToast(e.message, isError: true);
    }
  }

  Future<void> _editUserQq(Map<String, dynamic> user) async {
    final TextEditingController ctrl =
        TextEditingController(text: asString(user['qq']));
    final String? qq = await showDialog<String>(
      context: context,
      builder: (BuildContext ctx) => AlertDialog(
        title: const Text('绑定 QQ'),
        content: TextField(
          controller: ctrl,
          keyboardType: TextInputType.number,
          inputFormatters: <TextInputFormatter>[
            FilteringTextInputFormatter.digitsOnly,
          ],
          decoration: const InputDecoration(labelText: 'QQ 号'),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(ctrl.text.trim()),
            child: const Text('保存'),
          ),
        ],
      ),
    );
    ctrl.dispose();
    if (qq == null) return;
    await _updateUser(asString(user['id']), qq: qq);
  }

  Future<void> _openConversation(Map<String, dynamic> conv) async {
    final AppState state = AppScope.read(context);
    final String id = asString(conv['id']);
    showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (BuildContext ctx) => const Center(child: LoadingView()),
    );
    Map<String, dynamic> detail = <String, dynamic>{};
    try {
      detail = await state.adminService.conversation(id);
    } catch (e) {
      showToast('会话详情加载失败：$e', isError: true);
    }
    if (!mounted) return;
    Navigator.of(context).pop();
    if (!mounted) return;
    final List<Map<String, dynamic>> recent = asMapList(detail['recent']);
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (BuildContext ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 18),
          child: SizedBox(
            height: MediaQuery.of(ctx).size.height * 0.6,
            child: ListView(
              children: <Widget>[
                Text(
                  asString(conv['title'], '未命名会话'),
                  style: const TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  '${asString(conv['username'])} · ${asString(conv['characterName'])} · ${asString(conv['kind'])}',
                  style: const TextStyle(
                    fontSize: 11,
                    color: AppColors.inkSoft,
                  ),
                ),
                const SizedBox(height: 10),
                const Divider(),
                if (recent.isEmpty)
                  const Padding(
                    padding: EdgeInsets.all(20),
                    child: Text(
                      '暂无最近消息',
                      style: TextStyle(fontSize: 12, color: AppColors.inkSoft),
                    ),
                  )
                else
                  ...recent.map(
                    (Map<String, dynamic> m) => Padding(
                      padding: const EdgeInsets.symmetric(vertical: 5),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          SizedBox(
                            width: 42,
                            child: Text(
                              asString(m['role']),
                              style: const TextStyle(
                                fontSize: 10,
                                color: AppColors.rose,
                              ),
                            ),
                          ),
                          Expanded(
                            child: Text(
                              asString(m['content']),
                              style: const TextStyle(fontSize: 12, height: 1.5),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _metricCard(String label, String value, IconData icon,
      {Color? color}) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 10),
      decoration: BoxDecoration(
        color: AppColors.white,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.sand),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Icon(icon, size: 15, color: color ?? AppColors.rose),
          const SizedBox(height: 6),
          Text(
            value,
            style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800),
          ),
          Text(
            label,
            style: const TextStyle(fontSize: 9.5, color: AppColors.inkSoft),
          ),
        ],
      ),
    );
  }

  Widget _overviewTab() {
    if (_loadingOverview) return const LoadingView(text: '概览加载中…');
    return RefreshIndicator(
      onRefresh: _loadOverview,
      child: ListView(
        padding: const EdgeInsets.only(bottom: 20),
        children: <Widget>[
          LayoutBuilder(
            builder: (BuildContext ctx, BoxConstraints c) {
              final double w = (c.maxWidth - 24 - 16) / 3;
              return Padding(
                padding: const EdgeInsets.fromLTRB(12, 10, 12, 0),
                child: Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: <Widget>[
                    SizedBox(
                      width: w,
                      child: _metricCard(
                        '注册用户',
                        '${_overview.users}',
                        Icons.people_outline,
                      ),
                    ),
                    SizedBox(
                      width: w,
                      child: _metricCard(
                        '在线用户',
                        '${_overview.online}',
                        Icons.online_prediction,
                        color: AppColors.success,
                      ),
                    ),
                    SizedBox(
                      width: w,
                      child: _metricCard(
                        '活跃指数',
                        _overview.activeIndex.toStringAsFixed(0),
                        Icons.trending_up,
                        color: AppColors.warn,
                      ),
                    ),
                    SizedBox(
                      width: w,
                      child: _metricCard(
                        '总会话',
                        '${_overview.conversations}',
                        Icons.forum_outlined,
                      ),
                    ),
                    SizedBox(
                      width: w,
                      child: _metricCard(
                        '活跃会话',
                        '${_overview.activeConversations}',
                        Icons.bolt_outlined,
                        color: AppColors.success,
                      ),
                    ),
                    SizedBox(
                      width: w,
                      child: _metricCard(
                        '角色数',
                        '${_overview.characters}',
                        Icons.favorite_border,
                      ),
                    ),
                  ],
                ),
              );
            },
          ),
          SectionCard(
            title: '全站用量',
            child: Row(
              children: <Widget>[
                _usageCell('输入命中', _overview.usage.inputHit),
                _usageCell('输入未命中', _overview.usage.inputMiss),
                _usageCell('输出', _overview.usage.output),
                _usageCell('消费', -1, cost: _overview.usage.cost),
              ],
            ),
          ),
          SectionCard(
            title: '存储占用',
            trailing: Text(
              formatBytes(_overview.storage.total),
              style: const TextStyle(fontSize: 11, color: AppColors.cocoa),
            ),
            child: Column(
              children: <Widget>[
                _storageBar('数据库', _overview.storage.db, _overview.storage.total),
                _storageBar('消息', _overview.storage.messages, _overview.storage.total),
                _storageBar('媒体', _overview.storage.media, _overview.storage.total),
                _storageBar('缓存', _overview.storage.cache, _overview.storage.total),
              ],
            ),
          ),
          SectionCard(
            title: 'OneBot / NapCat',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  '连接状态：${_onebotStatus.isEmpty ? '未知' : (_onebotStatus['connected'] == true ? '已连接' : '未连接')}',
                  style: const TextStyle(fontSize: 12),
                ),
                const SizedBox(height: 4),
                Text(
                  _overview.formula.isEmpty ? '活跃指数由在线占比与近7日活跃占比加权计算' : _overview.formula,
                  style: const TextStyle(
                    fontSize: 10.5,
                    color: AppColors.inkSoft,
                    height: 1.5,
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  '消息总数 ${_overview.messages} · 近7日活跃 ${_overview.active7d}',
                  style: const TextStyle(fontSize: 10.5, color: AppColors.inkSoft),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _usageCell(String label, int value, {double? cost}) {
    return Expanded(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            label,
            style: const TextStyle(fontSize: 9.5, color: AppColors.inkSoft),
          ),
          const SizedBox(height: 3),
          Text(
            cost != null ? formatCost(cost) : compactNumber(value),
            style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700),
          ),
        ],
      ),
    );
  }

  Widget _storageBar(String label, int value, int total) {
    final double ratio = total <= 0 ? 0 : (value / total).clamp(0.0, 1.0);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: <Widget>[
          SizedBox(
            width: 54,
            child: Text(
              label,
              style: const TextStyle(fontSize: 11, color: AppColors.inkSoft),
            ),
          ),
          Expanded(
            child: ClipRRect(
              borderRadius: BorderRadius.circular(4),
              child: LinearProgressIndicator(
                value: ratio.toDouble(),
                minHeight: 5,
                backgroundColor: AppColors.sand,
              ),
            ),
          ),
          const SizedBox(width: 8),
          SizedBox(
            width: 62,
            child: Text(
              formatBytes(value),
              textAlign: TextAlign.right,
              style: const TextStyle(fontSize: 10, color: AppColors.inkSoft),
            ),
          ),
        ],
      ),
    );
  }

  Widget _usersTab() {
    return Column(
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
          child: Row(
            children: <Widget>[
              Expanded(
                child: TextField(
                  controller: _userQuery,
                  decoration: const InputDecoration(
                    hintText: '搜索用户名 / 邮箱 / QQ / ID',
                    isDense: true,
                    prefixIcon: Icon(Icons.search, size: 18),
                  ),
                  onSubmitted: (_) => _loadUsers(reset: true),
                ),
              ),
              const SizedBox(width: 8),
              FilledButton(
                onPressed: () => _loadUsers(reset: true),
                style: FilledButton.styleFrom(
                  minimumSize: const Size(0, 42),
                  padding: const EdgeInsets.symmetric(horizontal: 14),
                ),
                child: const Text('搜索'),
              ),
            ],
          ),
        ),
        Expanded(
          child: _loadingUsers
              ? const LoadingView()
              : RefreshIndicator(
                  onRefresh: () => _loadUsers(),
                  child: ListView.builder(
                    itemCount: _users.length + 1,
                    itemBuilder: (BuildContext context, int i) {
                      if (i == _users.length) {
                        return _pager(
                          page: _userPage,
                          total: _userTotal,
                          onPrev: _userPage > 1
                              ? () {
                                  _userPage -= 1;
                                  _loadUsers();
                                }
                              : null,
                          onNext: _userPage * 20 < _userTotal
                              ? () {
                                  _userPage += 1;
                                  _loadUsers();
                                }
                              : null,
                        );
                      }
                      final Map<String, dynamic> u = _users[i];
                      final bool online = asBool(u['online']);
                      return ListTile(
                        dense: true,
                        leading: CircleAvatar(
                          radius: 16,
                          backgroundColor: online
                              ? AppColors.success.withAlpha(40)
                              : AppColors.sand,
                          child: Text(
                            asString(u['username'], '?').characters.first,
                            style: const TextStyle(fontSize: 12),
                          ),
                        ),
                        title: Row(
                          children: <Widget>[
                            Text(
                              asString(u['username']),
                              style: const TextStyle(fontSize: 13),
                            ),
                            const SizedBox(width: 5),
                            if (asString(u['role']) == 'admin')
                              const Text(
                                'admin',
                                style: TextStyle(
                                  fontSize: 9,
                                  color: AppColors.rose,
                                ),
                              ),
                            if (asString(u['status']) != 'active')
                              const Text(
                                ' 已停用',
                                style: TextStyle(
                                  fontSize: 9,
                                  color: AppColors.danger,
                                ),
                              ),
                          ],
                        ),
                        subtitle: Text(
                          '${asString(u['email'])} · QQ ${asString(u['qq'], '未绑定')} · 角色 ${asInt(u['characters'])}',
                          style: const TextStyle(fontSize: 10),
                        ),
                        trailing: Text(
                          online ? '在线' : formatDate(asString(u['lastActiveAt'])),
                          style: TextStyle(
                            fontSize: 10,
                            color: online
                                ? AppColors.success
                                : AppColors.inkSoft,
                          ),
                        ),
                        onTap: () => _userActions(u),
                      );
                    },
                  ),
                ),
        ),
      ],
    );
  }

  Widget _pager({
    required int page,
    required int total,
    VoidCallback? onPrev,
    VoidCallback? onNext,
  }) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          IconButton(
            onPressed: onPrev,
            icon: const Icon(Icons.chevron_left, size: 20),
          ),
          Text(
            '第 $page 页 · 共 $total 条',
            style: const TextStyle(fontSize: 11, color: AppColors.inkSoft),
          ),
          IconButton(
            onPressed: onNext,
            icon: const Icon(Icons.chevron_right, size: 20),
          ),
        ],
      ),
    );
  }

  Widget _usageTab() {
    final List<Map<String, dynamic>> byUser = asMapList(_usageRaw['byUser']);
    return ListView(
      padding: const EdgeInsets.only(bottom: 20),
      children: <Widget>[
        SizedBox(
          height: 38,
          child: ListView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 12),
            children: kRangeLabels.entries
                .where((MapEntry<String, String> e) => e.key != 'custom')
                .map((MapEntry<String, String> e) {
              final bool active = _range == e.key;
              return GestureDetector(
                onTap: () {
                  setState(() => _range = e.key);
                  _loadUsage();
                },
                child: Container(
                  margin: const EdgeInsets.only(right: 8),
                  padding:
                      const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
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
            }).toList(),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
          child: Row(
            children: <Widget>[
              Expanded(
                child: TextField(
                  onChanged: (String v) => _usageUser = v,
                  decoration: const InputDecoration(
                    hintText: '按 user id 筛选（留空=全站）',
                    isDense: true,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              FilledButton(
                onPressed: _loadUsage,
                style: FilledButton.styleFrom(
                  minimumSize: const Size(0, 42),
                  padding: const EdgeInsets.symmetric(horizontal: 14),
                ),
                child: const Text('查询'),
              ),
            ],
          ),
        ),
        if (_loadingUsage)
          const LoadingView()
        else ...<Widget>[
          SectionCard(
            title: '汇总',
            child: Row(
              children: <Widget>[
                _usageCell('输入命中', _usage.totals.inputHit),
                _usageCell('输入未命中', _usage.totals.inputMiss),
                _usageCell('输出', _usage.totals.output),
                _usageCell('消费', -1, cost: _usage.totals.cost),
              ],
            ),
          ),
          if (_usage.series.isNotEmpty)
            SectionCard(
              title: '趋势',
              child: SizedBox(height: 150, child: _usageBars()),
            ),
          SectionCard(
            title: '按用户',
            child: byUser.isEmpty
                ? const Text(
                    '全站汇总模式下按用户统计；输入 user id 可看单用户明细。',
                    style: TextStyle(fontSize: 11, color: AppColors.inkSoft),
                  )
                : Column(
                    children: byUser
                        .map(
                          (Map<String, dynamic> u) => Padding(
                            padding: const EdgeInsets.symmetric(vertical: 4),
                            child: Row(
                              children: <Widget>[
                                Expanded(
                                  child: Text(
                                    asString(u['username'], asString(u['userId'])),
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(fontSize: 11.5),
                                  ),
                                ),
                                Text(
                                  '${compactNumber(asInt(u['total']))} tok · ${formatCost(asDouble(u['cost']))}',
                                  style: const TextStyle(
                                    fontSize: 10,
                                    color: AppColors.inkSoft,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        )
                        .toList(),
                  ),
          ),
          SectionCard(
            title: '按模型',
            child: _usage.models.isEmpty
                ? const Text(
                    '暂无模型用量',
                    style: TextStyle(fontSize: 11, color: AppColors.inkSoft),
                  )
                : Column(
                    children: _usage.models
                        .map(
                          (ModelUsage m) => Padding(
                            padding: const EdgeInsets.symmetric(vertical: 4),
                            child: Row(
                              children: <Widget>[
                                Expanded(
                                  child: Text(
                                    m.model,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(fontSize: 11.5),
                                  ),
                                ),
                                Text(
                                  '${compactNumber(m.total)} tok · ${formatCost(m.cost)}',
                                  style: const TextStyle(
                                    fontSize: 10,
                                    color: AppColors.inkSoft,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        )
                        .toList(),
                  ),
          ),
        ],
      ],
    );
  }

  Widget _usageBars() {
    double maxY = 0;
    for (final UsagePoint p in _usage.series) {
      final double v = (p.input + p.output).toDouble();
      if (v > maxY) maxY = v;
    }
    if (maxY <= 0) maxY = 100;
    return BarChart(
      BarChartData(
        maxY: maxY * 1.15,
        minY: 0,
        gridData: const FlGridData(show: false),
        borderData: FlBorderData(show: false),
        titlesData: const FlTitlesData(
          topTitles: AxisTitles(sideTitles: SideTitles(showTitles: false)),
          rightTitles: AxisTitles(sideTitles: SideTitles(showTitles: false)),
          bottomTitles: AxisTitles(sideTitles: SideTitles(showTitles: false)),
          leftTitles: AxisTitles(sideTitles: SideTitles(showTitles: false)),
        ),
        barTouchData: BarTouchData(
          enabled: true,
          touchCallback: (FlTouchEvent event, BarTouchResponse? response) {
            if (event is! FlTapUpEvent) return;
            final int? index = response?.spot?.touchedBarGroupIndex;
            if (index == null || index < 0 || index >= _usage.series.length) {
              return;
            }
            final UsagePoint p = _usage.series[index];
            showDialog<void>(
              context: context,
              builder: (BuildContext ctx) => AlertDialog(
                title: Text(p.key),
                content: Text(
                  '命中 ${compactNumber(p.cached)} · 未命中 ${compactNumber(p.input - p.cached)}\n'
                  '输出 ${compactNumber(p.output)} · ${formatCost(p.cost)}\n调用 ${p.calls} 次',
                  style: const TextStyle(fontSize: 12, height: 1.6),
                ),
                actions: <Widget>[
                  TextButton(
                    onPressed: () => Navigator.of(ctx).pop(),
                    child: const Text('关闭'),
                  ),
                ],
              ),
            );
          },
        ),
        barGroups: <BarChartGroupData>[
          for (int i = 0; i < _usage.series.length; i++)
            BarChartGroupData(
              x: i,
              barRods: <BarChartRodData>[
                BarChartRodData(
                  toY: (_usage.series[i].input + _usage.series[i].output)
                      .toDouble(),
                  width: _usage.series.length > 24 ? 5 : 12,
                  color: AppColors.cocoa,
                  borderRadius: BorderRadius.circular(2),
                ),
              ],
            ),
        ],
      ),
    );
  }

  Widget _conversationsTab() {
    if (_loadingConvs) return const LoadingView();
    return RefreshIndicator(
      onRefresh: _loadConversations,
      child: ListView.builder(
        itemCount: _conversations.length + 1,
        itemBuilder: (BuildContext context, int i) {
          if (i == _conversations.length) {
            return _pager(
              page: _convPage,
              total: _convTotal,
              onPrev: _convPage > 1
                  ? () {
                      _convPage -= 1;
                      _loadConversations();
                    }
                  : null,
              onNext: _convPage * 20 < _convTotal
                  ? () {
                      _convPage += 1;
                      _loadConversations();
                    }
                  : null,
            );
          }
          final Map<String, dynamic> c = _conversations[i];
          final bool active = asBool(c['active']);
          return ListTile(
            dense: true,
            leading: Icon(
              active ? Icons.forum : Icons.forum_outlined,
              size: 18,
              color: active ? AppColors.success : AppColors.inkSoft,
            ),
            title: Text(
              asString(c['title'], '未命名会话'),
              style: const TextStyle(fontSize: 12.5),
            ),
            subtitle: Text(
              '${asString(c['username'])} · ${asString(c['characterName'])} · ${asInt(c['tokenUsed'])}/${asInt(c['contextLimit'])} tok · ${asInt(c['messageCount'])} 条',
              style: const TextStyle(fontSize: 10),
            ),
            trailing: Text(
              formatDate(asString(c['updatedAt'])),
              style: const TextStyle(fontSize: 9.5, color: AppColors.inkSoft),
            ),
            onTap: () => _openConversation(c),
          );
        },
      ),
    );
  }

  Widget _logsTab() {
    return Column(
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
          child: Row(
            children: <Widget>[
              Expanded(
                child: TextField(
                  onChanged: (String v) => _logAction = v,
                  decoration: const InputDecoration(
                    hintText: '按 action 过滤，如 character.create',
                    isDense: true,
                  ),
                  onSubmitted: (_) => _loadLogs(reset: true),
                ),
              ),
              const SizedBox(width: 8),
              FilledButton(
                onPressed: () => _loadLogs(reset: true),
                style: FilledButton.styleFrom(
                  minimumSize: const Size(0, 42),
                  padding: const EdgeInsets.symmetric(horizontal: 14),
                ),
                child: const Text('筛选'),
              ),
            ],
          ),
        ),
        Expanded(
          child: _loadingLogs
              ? const LoadingView()
              : ListView.builder(
                  itemCount: _logs.length + 1,
                  itemBuilder: (BuildContext context, int i) {
                    if (i == _logs.length) {
                      return _pager(
                        page: _logPage,
                        total: _logTotal,
                        onPrev: _logPage > 1
                            ? () {
                                _logPage -= 1;
                                _loadLogs();
                              }
                            : null,
                        onNext: _logPage * 30 < _logTotal
                            ? () {
                                _logPage += 1;
                                _loadLogs();
                              }
                            : null,
                      );
                    }
                    final Map<String, dynamic> l = _logs[i];
                    return ListTile(
                      dense: true,
                      title: Text(
                        asString(l['action']),
                        style: const TextStyle(fontSize: 12),
                      ),
                      subtitle: Text(
                        '${asString(l['actorName'], 'system')} · ${asString(l['target'])} · ${formatDateTime(asString(l['created_at']))}',
                        style: const TextStyle(fontSize: 10),
                      ),
                      trailing: Icon(
                        asString(l['ip']).isEmpty
                            ? Icons.circle
                            : Icons.public,
                        size: 10,
                        color: AppColors.inkSoft,
                      ),
                      onTap: () {
                        showDialog<void>(
                          context: context,
                          builder: (BuildContext ctx) => AlertDialog(
                            title: Text(asString(l['action'])),
                            content: SingleChildScrollView(
                              child: Text(
                                '${asString(l['detail'])}\n\nip: ${asString(l['ip'])}\nid: ${asString(l['id'])}',
                                style: const TextStyle(fontSize: 11, height: 1.5),
                              ),
                            ),
                            actions: <Widget>[
                              TextButton(
                                onPressed: () => Navigator.of(ctx).pop(),
                                child: const Text('关闭'),
                              ),
                            ],
                          ),
                        );
                      },
                    );
                  },
                ),
        ),
      ],
    );
  }

  Widget _settingsTab() {
    if (!_settingsLoaded) {
      return Center(
        child: OutlinedButton(
          onPressed: _loadSettings,
          child: const Text('加载服务端配置'),
        ),
      );
    }
    return ListView(
      padding: const EdgeInsets.only(bottom: 24),
      children: <Widget>[
        SectionCard(
          title: 'SMTP 邮件服务',
          child: Column(
            children: <Widget>[
              TextField(
                controller: _smtpHost,
                decoration: const InputDecoration(
                  labelText: 'SMTP 主机',
                  hintText: 'smtp.example.com',
                ),
              ),
              const SizedBox(height: 8),
              Row(
                children: <Widget>[
                  Expanded(
                    child: TextField(
                      controller: _smtpPort,
                      keyboardType: TextInputType.number,
                      inputFormatters: <TextInputFormatter>[
                        FilteringTextInputFormatter.digitsOnly,
                      ],
                      decoration: const InputDecoration(labelText: '端口'),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: SwitchListTile(
                      contentPadding: EdgeInsets.zero,
                      dense: true,
                      title: const Text('SSL', style: TextStyle(fontSize: 12)),
                      value: _smtpSecure,
                      onChanged: (bool v) => setState(() => _smtpSecure = v),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              TextField(
                controller: _smtpUser,
                decoration: const InputDecoration(labelText: '账号'),
              ),
              const SizedBox(height: 8),
              TextField(
                controller: _smtpPass,
                obscureText: true,
                decoration: const InputDecoration(
                  labelText: '密码 / 授权码（留空保持不变）',
                ),
              ),
              const SizedBox(height: 8),
              TextField(
                controller: _smtpFrom,
                decoration: const InputDecoration(labelText: '发件人地址'),
              ),
              const SizedBox(height: 10),
              Row(
                children: <Widget>[
                  Expanded(
                    child: TextField(
                      controller: _testMail,
                      keyboardType: TextInputType.emailAddress,
                      decoration: const InputDecoration(
                        labelText: '测试收件邮箱',
                        isDense: true,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  OutlinedButton(
                    onPressed: _sendTestMail,
                    style: OutlinedButton.styleFrom(
                      minimumSize: const Size(0, 42),
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                    ),
                    child: const Text('发送测试邮件'),
                  ),
                ],
              ),
            ],
          ),
        ),
        SectionCard(
          title: '应用更新',
          child: Column(
            children: <Widget>[
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                dense: true,
                title: const Text(
                  '强制更新',
                  style: TextStyle(fontSize: 13),
                ),
                subtitle: const Text(
                  '开启后所有低于最新版本的客户端必须更新；也可用最低版本号强制。',
                  style: TextStyle(fontSize: 10.5, color: AppColors.inkSoft),
                ),
                value: _updateForce,
                onChanged: (bool v) => setState(() => _updateForce = v),
              ),
              const SizedBox(height: 6),
              TextField(
                controller: _updateMinVersion,
                decoration: const InputDecoration(
                  labelText: '最低版本',
                  hintText: '例如 1.1.0（留空表示不限制）',
                  helperText: '当前客户端版本低于该值时也会触发强制更新',
                ),
              ),
            ],
          ),
        ),
        SectionCard(
          title: 'OneBot / NapCat',
          child: Column(
            children: <Widget>[
              TextField(
                controller: _obToken,
                obscureText: true,
                decoration: const InputDecoration(
                  labelText: 'access_token（留空保持不变）',
                ),
              ),
              const SizedBox(height: 8),
              TextField(
                controller: _obSelfId,
                keyboardType: TextInputType.number,
                inputFormatters: <TextInputFormatter>[
                  FilteringTextInputFormatter.digitsOnly,
                ],
                decoration: const InputDecoration(labelText: '机器人 QQ 号'),
              ),
              const SizedBox(height: 8),
              TextField(
                controller: _obPath,
                decoration: const InputDecoration(labelText: '上报 WS 路径'),
              ),
              const SizedBox(height: 8),
              Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  '连接状态：${_onebotStatus.isEmpty ? '未知' : (_onebotStatus['online'] == true || _onebotStatus['connected'] == true ? '已连接' : '未连接')}',
                  style: const TextStyle(fontSize: 11, color: AppColors.inkSoft),
                ),
              ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
          child: FilledButton(
            onPressed: _savingSettings ? null : _saveSettings,
            child: _savingSettings
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: Colors.white,
                    ),
                  )
                : const Text('保存服务端配置'),
          ),
        ),
      ],
    );
  }

  Widget _storageTab() {
    final StorageUsage s = _storage;
    final int total = s.total > 0
        ? s.total
        : s.db + s.wal + s.messages + s.media + s.cache;
    return RefreshIndicator(
      onRefresh: _loadStorage,
      child: ListView(
        padding: const EdgeInsets.only(bottom: 20),
        children: <Widget>[
          SectionCard(
            title: '存储总览',
            trailing: Text(
              formatBytes(total),
              style: const TextStyle(fontSize: 12, color: AppColors.cocoa),
            ),
            child: Column(
              children: <Widget>[
                _storageBar('数据库', s.db, total),
                _storageBar('WAL', s.wal, total),
                _storageBar('消息文件', s.messages, total),
                _storageBar('媒体', s.media, total),
                _storageBar('缓存', s.cache, total),
              ],
            ),
          ),
          const Padding(
            padding: EdgeInsets.fromLTRB(16, 4, 16, 0),
            child: Text(
              '缓存为未来会被自动清理的目录；数据库与消息文件请勿手动删除。',
              style: TextStyle(fontSize: 10.5, color: AppColors.inkSoft),
            ),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final AppState state = AppScope.of(context);
    if (!state.isAdmin || _authError != null) {
      return Scaffold(
        appBar: AppBar(title: const Text('管理端')),
        body: EmptyView(
          text: _authError == null
              ? '当前账号不是超级管理员，无法访问管理端。'
              : '权限不足：$_authError，请用超级管理员账号登录。',
          icon: Icons.lock_outline,
          action: OutlinedButton(
            onPressed: () {
              setState(() => _authError = null);
              _loadOverview();
            },
            child: const Text('重试'),
          ),
        ),
      );
    }
    return Scaffold(
      appBar: AppBar(
        title: const Text('管理端'),
        actions: <Widget>[
          IconButton(
            tooltip: '刷新概览',
            icon: const Icon(Icons.refresh, size: 20),
            onPressed: _loadOverview,
          ),
        ],
      ),
      body: Column(
        children: <Widget>[
          TabBar(
            controller: _tab,
            isScrollable: true,
            tabAlignment: TabAlignment.start,
            tabs: const <Tab>[
              Tab(text: '概览'),
              Tab(text: '用户'),
              Tab(text: '用量'),
              Tab(text: '会话'),
              Tab(text: '日志'),
              Tab(text: '配置'),
              Tab(text: '存储'),
            ],
          ),
          Expanded(
            child: ContentFrame(
              maxWidth: 1100,
              child: TabBarView(
                controller: _tab,
                children: <Widget>[
                _overviewTab(),
                _usersTab(),
                _usageTab(),
                _conversationsTab(),
                _logsTab(),
                _settingsTab(),
                _storageTab(),
              ],
            ),
          ),
        ),
        ],
      ),
    );
  }
}
