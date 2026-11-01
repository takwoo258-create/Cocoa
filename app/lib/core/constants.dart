/// 全局常量与后端契约中的枚举映射。
library cocoa.core.constants;

const String kAppName = 'Cocoa';
const String kAppVersion = '1.2.0';

/// 默认服务地址（可在设置页修改）。
const String kDefaultBaseUrl = 'https://120-26-204-70.sslip.io';

/// 服务配置中的服务（v1.0.1：search/fetch 复用 DeepSeek，不再单列）。
const List<String> kServices = <String>[
  'chat',
  'embedding',
  'deepseek',
  'stt',
  'tts',
];

const Map<String, String> kServiceLabels = <String, String>{
  'chat': '对话模型',
  'embedding': '嵌入模型',
  'deepseek': 'DeepSeek（搜索/抓取复用）',
  'stt': '语音识别 STT',
  'tts': '语音合成 TTS',
};

/// 模型上下文窗口来源：remote=远端 / table=内置表 / default=默认。
const Map<String, String> kContextSourceLabels = <String, String>{
  'remote': '远程',
  'table': '内置',
  'default': '默认',
};

/// 模型分工任务（/api/config preferences.modelRouting）。
const List<String> kRoutingTasks = <String>[
  'main',
  'sentence',
  'profile',
  'portrait',
  'creation',
  'status',
  'memory',
  'vision',
  'news',
  'search',
  'tts',
  'stt',
];

const Map<String, String> kRoutingLabels = <String, String>{
  'main': '主会话',
  'sentence': '句子完整性检查',
  'profile': '人物画像',
  'portrait': '心理画像提炼',
  'creation': '角色创作（小说/日记）',
  'status': '角色状态刷新',
  'memory': '记忆提取',
  'vision': '图片理解',
  'news': '新闻阅读',
  'search': '网页搜索（复用 DeepSeek）',
  'tts': '语音合成',
  'stt': '语音识别',
};

/// 九个人设字段（顺序即表单顺序）。
const List<String> kProfileFields = <String>[
  'name',
  'age',
  'race',
  'gender',
  'personality',
  'worldview',
  'hobbies',
  'relation',
  'appearance',
  'occupation',
];

const Map<String, String> kProfileLabels = <String, String>{
  'name': '姓名',
  'age': '年龄',
  'race': '种族',
  'gender': '性别',
  'personality': '性格',
  'worldview': '世界观',
  'hobbies': '爱好',
  'relation': '与本人关系',
  'appearance': '外观',
  'occupation': '职业',
};

const Map<String, String> kProfileHints = <String, String>{
  'name': '例如：可可',
  'age': '例如：20',
  'race': '例如：人类 / 猫妖',
  'gender': '例如：女',
  'personality': '温柔、黏人、偶尔傲娇',
  'worldview': '她生活的世界是什么样的',
  'hobbies': '喜欢做的事',
  'relation': '恋人 / 青梅竹马 / 主仆',
  'appearance': '发色、瞳色、衣着、身高',
  'occupation': '例如：大学生 / 咖啡师',
};

/// 统计时间范围。
const Map<String, String> kRangeLabels = <String, String>{
  'day': '当日',
  '3d': '近三天',
  '7d': '近七天',
  '30d': '近一个月',
  'year': '近一年',
  'all': '全部',
  'custom': '自定义',
};

/// 书架类型。
const Map<String, String> kBookTypeLabels = <String, String>{
  'novel': '小说',
  'essay': '文集',
  'diary': '日记',
  'news': '浏览记录',
};

const String kNoticeCompressing = '在回味之前的记忆喵~';

/// 角色休息提示中固定的后半句（build.md 二.14）。
const String kForceWakeSuffix = '若强行叫醒的话，可能会带来不必要的麻烦哦';

/// typing 事件阶段文案（v1.0.1）。
const Map<String, String> kTypingStageLabels = <String, String>{
  'checking': '正在看懂你的话…',
  'waiting': '正在等你把话说完…',
  'replying': '正在输入…',
};
