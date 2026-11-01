# Cocoa Android 客户端（Flutter）

仅 Android，中文 UI，Material 3，暖可可色系。客户端代码全部位于本目录，后端契约见 `../docs/API.md`，产品需求见 `../build.md`。

## 目录结构

```
lib/
  core/       ApiClient（token/401/错误 toast）、AppState（ChangeNotifier）、
              WebSocketService（重连）、StorageService、主题、SVG path 渲染器、工具
  models/     user / character / chat_message / config / memory_graph / book / stats
  services/   auth / config / character / chat / media / memory / book / stats / admin
  widgets/    ServiceEditor、能力 SVG 图标、状态卡、气泡、上下文圆环、通用组件
  pages/      splash / login / api_setup_dialog / home / character_* / chat /
              memory / bookshelf / reader / stats / settings / admin/admin_page
```

状态管理只使用 `ChangeNotifier` + `InheritedNotifier`（`AppScope`），没有引入重型状态库。

## 关键实现

- **启动闭环**：`SplashPage` 读取 secure storage 中的 token → `GET /api/auth/me` → `enterApp`。
  若 `/api/config` 返回 `ready.chat=false`，弹出不可取消的 `ApiSetupDialog`（`barrierDismissible=false` +
  `PopScope(canPop:false)`），保存成功且 `ready.chat` 为真后才进入 `HomePage`。
- **模型能力**：`POST /api/config/models` 返回 `modalities/capabilities/contextWindow/svg`，
  用自写的迷你 SVG path 渲染器（`core/svg_icon.dart`）展示文本 / 图片 / 语音能力；当前模型能力通过
  `GET /api/config/model-info?id=` 刷新。
- **聊天**：`ws://host/ws?token=`（`web_socket_channel`，指数退避重连），事件覆盖
  `ready/message/typing/notice/context/state/profile/subjective/error`；分段消息按 `meta.wait` 依次显示；
  `subjective` 按 `sendsec` 延时显示；调试模式在输入框下方显示 `context` 事件的圆环与百分比。
- **记忆**：`CustomPainter` 径向布局（智能体 → 大类 → 小类 → 记忆点），自动缩放适配画布；
  记忆点恒白色、亮度 = weight，关联为虚线；点击节点展开/折叠，点击记忆点弹出详情面板。
- **媒体**：图片 `image_picker`、语音 `record` → `POST /api/media`（multipart，字段 `file`）→
  发送消息时携带字符串 `mediaId`；播放走 `just_audio` 并带 Authorization 头。
- **服务地址**：默认 `http://120.26.204.70:8787`，可在登录页/设置页修改并做健康检查。

## v1.0.1 增量

- 模型列表：点「获取模型列表」前先保存当前 baseUrl/apiKey/model；展示 `source/warning/attempts`，
  远端失败时可重试或手动输入模型名；每个模型显示 `contextWindow` 与来源（远程/内置/默认）；
  支持手动上下文覆盖（`preferences.contextLimits`，可存为当前模型或 default）。
- 首次配置弹窗：键盘弹出时 Dialog 自动上移 + 内容可滚动，所有字段与「保存并进入」均可达。
- 顶部提示：`showToast` 改为 Overlay + SlideTransition 浮层（错误红/普通深色），不受键盘影响。
- 设置页二级菜单：个人信息 / 服务配置 / 角色配置 / 模型分工 / Token 限额 / 对话偏好 / 关于与版本。
- 角色状态独立页（动作/心理/心情/健康/睡眠/亲密度/陪伴天数，刷新与叫醒）；聊天页状态卡改为可点击紧凑状态条。
- 记忆页支持只传 `characterId`，不再依赖聊天页上下文。
- 页面切换动效（淡入 + 右滑），主页 Tab 使用 IndexedStack + FadeTransition。
- 角色输入状态：`typing` 事件的 `checking/waiting/replying` 阶段文案 + 三点动画；发送后立即显示输入中。
- QQ 空间动态：阅读页/书架条目分享（`POST /api/onebot/qzone`，内容 1000 字内，503 提示 NapCat 未连接）；
  角色设置新增 `qzoneEnabled` 开关。
- 版本推送：`GET /api/version/latest?current=1.0.1`，主页横幅与「关于与版本」页可下载（gh-proxy）与忽略；
  下载通过 `MethodChannel('cocoa/native').invokeMethod('openUrl')` 调系统浏览器。
- 限额增加 `limits.enabled` 总开关；移除 search/fetch 服务配置项（复用 DeepSeek）；注册 QQ 必填。

## 构建

工具链（本机）：Flutter 3.47.9 / Dart 3.13.7、AGP 9.1.0、Gradle 9.3.1、JDK 17、Android SDK 36。

```bash
export PATH=/data/dsh/home/.toolchain/flutter/bin:$PATH
export JAVA_HOME=/data/dsh/home/.toolchain/jdk17
export ANDROID_HOME=/data/dsh/home/.toolchain/android-sdk
export ANDROID_SDK_ROOT=$ANDROID_HOME
export PUB_CACHE=/data/dsh/home/.pub-cache
export ANDROID_USER_HOME=/data/dsh/home/.android
export GRADLE_USER_HOME=/data/dsh/home/.gradle

flutter pub get
flutter analyze
flutter build apk --debug
```

`android/app/build.gradle.kts`：`applicationId=com.sandsalt.cocoa`、`minSdk=24`（Android 7.0+）、`targetSdk=35`，
`compileSdk` 跟随 Flutter（当前 36）；Manifest 已开启 `usesCleartextTraffic` 并声明
`INTERNET / RECORD_AUDIO / CAMERA` 等权限。签名与 release 构建由 ops 线注入。
