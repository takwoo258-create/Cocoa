import 'package:flutter/material.dart';
import '../../core/layout.dart';

import '../../core/app_state.dart';
import '../../core/theme.dart';
import '../../widgets/common.dart';

/// 智能体 / 对话偏好二级页。
class AgentPage extends StatelessWidget {
  const AgentPage({super.key});

  @override
  Widget build(BuildContext context) {
    final AppState state = AppScope.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('对话偏好')),
      body: ListView(
        padding: pagePadding(context),
        children: <Widget>[
          SectionCard(
            title: '思考与调试',
            child: Column(
              children: <Widget>[
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  dense: true,
                  title: const Text('思考模式', style: TextStyle(fontSize: 13)),
                  subtitle: const Text(
                    '角色默认关闭；开启后回复前会先思考（更慢但更细致）。',
                    style: TextStyle(fontSize: 10.5, color: AppColors.inkSoft),
                  ),
                  value: state.thinkingMode,
                  onChanged: (bool v) => state.setThinkingMode(v),
                ),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  dense: true,
                  title: const Text('调试模式', style: TextStyle(fontSize: 13)),
                  subtitle: const Text(
                    '在聊天输入框下方显示上下文占用圆形进度与百分比。',
                    style: TextStyle(fontSize: 10.5, color: AppColors.inkSoft),
                  ),
                  value: state.debugMode,
                  onChanged: (bool v) => state.setDebugMode(v),
                ),
              ],
            ),
          ),
          SectionCard(
            title: '回复行为',
            child: Column(
              children: <Widget>[
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  dense: true,
                  title: const Text('主动回复', style: TextStyle(fontSize: 13)),
                  subtitle: const Text(
                    '等待期结束后角色会主动追问或发来消息。',
                    style: TextStyle(fontSize: 10.5, color: AppColors.inkSoft),
                  ),
                  value: state.activeReplyEnabled,
                  onChanged: (bool v) => state.savePreferences(
                    <String, dynamic>{'activeReply': v},
                  ),
                ),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  dense: true,
                  title: const Text('分段消息', style: TextStyle(fontSize: 13)),
                  subtitle: const Text(
                    '开启后角色会把长回复拆成几条依次发送。',
                    style: TextStyle(fontSize: 10.5, color: AppColors.inkSoft),
                  ),
                  value: state.segmentEnabled,
                  onChanged: (bool v) => state.savePreferences(
                    <String, dynamic>{'segmentEnabled': v},
                  ),
                ),
              ],
            ),
          ),
          const Padding(
            padding: EdgeInsets.fromLTRB(16, 12, 16, 0),
            child: Text(
              '角色休息、上下文压缩与限额等行为由服务端根据设置自动处理。',
              style: TextStyle(fontSize: 10.5, color: AppColors.inkSoft),
            ),
          ),
        ],
      ),
    );
  }
}
