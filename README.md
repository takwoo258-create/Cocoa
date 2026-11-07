<div align="center">

# Cocoa

让角色真正生活在自己的世界里，也记得与你说过的每一句话。

Node.js 后端 · Flutter Android 客户端 · GPL-3.0

</div>

<hr>

## 简介

Cocoa 是一套可自行部署的虚拟智能体陪伴系统。后端用 Node.js、Express 与 SQLite 承担角色、对话、记忆、创作、统计与 QQ 接入，Android 客户端用 Flutter 承担日常交互。

角色不是一问一答的聊天窗口：它们有独立人设、动态状态与作息，会自己写日记与小说，会记住你说过的事，也会在你安静下来之后主动来找你。模型服务由使用者自行填写（OpenAI 兼容协议），数据保存在自己部署的实例里，角色之间、用户之间彼此隔离。

## 核心能力

### 对话

- **分段回复**：模型按单句下发多段消息，客户端按每段的 `sendsec`（约 0.3–0.5 秒每字，模型按长度给出）逐条显示，段间保持输入状态，不再整段刷出。
- **句子完整性判断**：用户拆成碎片发送时，消息先经过判定会话；不完整则继续等待后续输入，最多 6 秒，超时按当前内容生成回复，避免对话断续。
- **多模态消息**：支持文本、图片、语音；语音与图片先转写为文字描述，再与文本合并送入主模型。
- **主动回复**：角色回复后进入等待期，超时由模型判断是否追问，并给出下一次主动消息的间隔（`timesec`）；多次追问无果会沉淀为记忆点。
- **上下文管理**：按模型上下文窗口计算占用，接近上限时在回复结束后压缩；调试模式展示占用明细。

### 状态与作息

- 状态是动态剧本：动作、心理、心情、健康按 5 分钟到更长区间刷新，并随记忆与交往变化。
- 作息独立展示：每天首次刷新由模型确定当日作息，允许熬夜、晚起、早睡与大幅调整；到达入睡或起床节点时立即刷新状态。
- 入睡时角色卡片切换为夜幕背景；叫醒入口按当前作息状态判断，叫醒后给出过渡提示。

### 记忆

- 语义记忆：Embedding 生成记忆点，构成「智能体 → 大类目 → 小类目 → 记忆点」的关联网络。
- 三维网图：可旋转、缩放、平移，节点按权重发光，点选查看详情。
- 记忆调用：对话时按相关性检索并注入上下文，角色可主动提起旧事；也会从对话中提取用户特征形成记忆。

### 创作

- 小说、散文、日记独立成篇，按文体使用独立会话；连载作品各自维护上下文，接近窗口上限时压缩前文。
- 标题与文体受约束，篇幅按文体控制；日记由角色自己写，阅读新闻后会写下感想。
- 日记本需要六位密码解锁，密码每日随机，角色只给暗示不给明文。

### 共享广场

- **人设模板**：保存、导入、一键套用；可从已有角色导入人设，也可把模板发布到广场。
- **模型使用权**：把自己的模型配置公开给指定用户、本服广场或全球广场，可设时长、截止时间或永久，并配置 Token 软/硬限额。
- **share ID**：每位用户拥有 8 位随机 share ID，可复制、可搜索，支持跨服务器分享。
- **通知与治理**：资源被使用、额度触顶、使用权到期均有应用内与邮件通知；分享只可点赞；管理端可对分享权限做停用处理并设置期限。

### 主题

- 主界面与聊天界面可分别设置壁纸（内置样式或本地图片）。
- 字体可选系统字体、内置字体或导入字体文件；字号可调并实时演示。
- 动效强度可设为关闭、减弱或正常。

### 统计

- Token 消耗按输入命中、输入未命中、输出三分支统计，支持按模型与时间范围筛选；「今日」可按小时段查看。
- 模型消耗与陪伴天数分页展示，含亲密度与陪伴天数曲线；图表详情以悬浮浮窗呈现。
- 管理端提供全局用量、用户、会话、日志、存储与在线状态。

### QQ 接入

- OneBot11 反向 WebSocket 接入 NapCat，按 QQ 号路由到用户绑定的角色。
- 支持 QQ 侧收发消息、输入状态、语音消息与 QQ 空间动态。
- 未注册或配置缺失时返回明确提示，不影响其它功能。

## 架构与技术栈

```
┌──────────────────────────┐   HTTPS / WebSocket   ┌──────────────────────────────────┐
│ Flutter Android 客户端     │ ────────────────────▶ │ Cocoa 后端（Node.js / Express 5）   │
│ 登录 · 对话 · 记忆 · 书架   │ ◀──────────────────── │ routes/  services/  ai/           │
└──────────────────────────┘                       │ realtime/  onebot/  auth/  db/    │
                                                   └───────────────┬──────────────────┘
┌──────────────────────────┐   OneBot11 反向 WS                     │
│ NapCat（自行部署）          │ ────────────────────▶  onebot 适配层   │
└──────────────────────────┘                                       │
                                                                   ▼
                          SQLite（WAL）· 加密正文 vault · 媒体文件 · 运行日志
                                                                   │
                                                                   ▼
                                        OpenAI 兼容服务（对话 / Embedding / 搜索 / STT / TTS）
```

| 层 | 技术 |
| --- | --- |
| 运行时 | Node.js >= 22.5（推荐 24），ESM |
| Web 框架 | Express 5，统一错误体与限流中间件 |
| 数据库 | `node:sqlite`（`DatabaseSync`），WAL 模式，无外部数据库依赖 |
| 实时通道 | `ws`，`/ws` 推送消息、输入状态、状态与上下文事件 |
| 模型接入 | `openai` SDK，兼容任意 OpenAI 协议服务 |
| 文件与邮件 | `multer` 处理上传，`nodemailer` 发送验证码与通知 |
| 客户端 | Flutter / Dart >= 3.4，`fl_chart`、`web_socket_channel`、`flutter_secure_storage` 等 |
| 存储 | 元信息入 SQLite，正文加密后落 vault，图片/语音/头像落 media |
| 许可 | GPL-3.0 |

## 目录结构

```
Cocoa/
├── app/                  Flutter Android 客户端
│   ├── lib/core/         状态、主题、网络、WebSocket、存储
│   ├── lib/models/       数据模型
│   ├── lib/pages/        页面（对话、书架、记忆、统计、设置、管理端）
│   ├── lib/services/     接口封装
│   └── lib/widgets/      通用组件
├── server/               后端
│   ├── src/routes/       HTTP 契约
│   ├── src/services/     角色、模板、广场、分享、审计、设置
│   ├── src/ai/           对话、记忆、创作、状态、提示词、调度
│   ├── src/realtime/     WebSocket hub
│   ├── src/onebot/       QQ 适配层
│   ├── src/db/           schema 与 SQLite 封装
│   └── test/             单元与冒烟测试
├── deploy/               环境模板、服务单元、安装与备份脚本
├── scripts/              构建与工具链脚本
├── docs/                 API 契约与部署手册
├── update1.5.2.md        当前版本更新日志
└── LICENSE               GPL-3.0
```

## 快速开始

### 环境要求

- Node.js >= 22.5（推荐 24；`node:sqlite` 自 22.5 起内置）
- 可访问的 OpenAI 兼容模型服务（对话与 Embedding）
- 构建客户端另需 Flutter 3.x stable、JDK 17、Android SDK 35

### 后端

```bash
git clone <仓库地址>
cd Cocoa
npm install
cp deploy/env.example .env
npm start
```

`npm run dev` 为热重启的开发模式。默认端口 `8787`，监听全部网卡，启动后可用健康检查确认：

```bash
curl -s localhost:8787/api/health
```

首次启动会自动建库、建目录，并按环境变量创建初始管理员；库中已存在管理员时不会覆盖。

### 环境变量

配置写在项目根目录的 `.env`，常用项：

| 变量 | 说明 |
| --- | --- |
| `PORT` | 监听端口，默认 `8787` |
| `HOST` | 监听地址，默认监听全部网卡 |
| `NODE_ENV` | 运行环境，`production` / `development` |
| `COCOA_DATA_DIR` | 数据目录，默认项目下 `data/` |
| `COCOA_MASTER_KEY` | 主密钥，至少 32 字符；留空时首次启动自动生成并落盘 |
| `COCOA_TOKEN_TTL` | 登录令牌有效期（秒） |
| `COCOA_ALLOW_REGISTER` | 设为 `0` 关闭注册 |
| `COCOA_ADMIN_EMAIL` / `COCOA_ADMIN_PASSWORD` | 初始管理员账号，仅在库中无管理员时生效 |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | 邮件服务，用于验证码与通知 |
| `ONEBOT_TOKEN` / `ONEBOT_SELF_ID` / `ONEBOT_WS_PATH` | OneBot11 接入参数 |
| `COCOA_EMBEDDING_*` / `COCOA_SEARCH_*` | 默认 Embedding 与搜索服务，可在应用内覆盖 |

主密钥可用以下命令生成：

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

主密钥是解密历史数据的唯一凭据，需与数据一起备份；更换后旧正文无法解密。模型 API Key 在客户端首次配置时填写，服务端只回显掩码。

### 测试

```bash
npm test        # 单元测试
npm run smoke   # 端到端冒烟
```

### Android 客户端

```bash
cd app
flutter pub get
flutter analyze
flutter build apk --release
```

产物为 `app/build/app/outputs/flutter-apk/app-release.apk`。发布签名在本地 `key.properties` 与密钥库中配置，两者都不入库；仓库内的 `scripts/build-apk.sh` 封装了同样的流程。安装后在客户端填写后端地址并完成模型配置，即可创建角色开始对话。

## API 概览

统一前缀 `/api`，除健康检查与认证接口外均需 `Authorization: Bearer <token>`；实时事件走 `/ws`，QQ 侧走 `/onebot/*`。完整字段、错误结构与模型回复协议见 [`docs/API.md`](docs/API.md)。

| 分组 | 代表端点 | 说明 |
| --- | --- | --- |
| 健康检查 | `GET /api/health` | 存活探针，无需鉴权 |
| 认证 | `POST /api/auth/register`、`/login`、`/send-code`、`GET /api/auth/me` | 邮箱验证码与密码登录、令牌吊销 |
| 用户 | `GET/PUT /api/users/me` | 资料与模型就绪状态 |
| 服务配置 | `GET/PUT /api/config`、`POST /api/config/models`、`/test` | 多服务配置、模型列表与连通性测试 |
| 角色 | `GET/POST /api/characters`、`/expand`、`/:id/settings`、`/:id/state` | 人设 CRUD、扩写、作息与状态 |
| 对话 | `POST/GET /api/characters/:id/messages`、`/active-reply`、`/wake`、`/context` | 发送、历史、主动回复、叫醒、上下文占用 |
| 实时 | `WS /ws?token=` | 消息、输入状态、状态、上下文与错误事件 |
| 记忆 | `GET /api/memory/graph`、`/:id`、`/search` | 网图、详情、语义检索 |
| 书架 | `GET/POST /api/books`、`/:id`、`/diary/unlock` | 小说、文集、阅读记录、日记 |
| 模板 | `GET/POST /api/templates`、`/import`、`/:id/apply`、`/:id/publish` | 人设模板管理与发布 |
| 广场 | `GET /api/plaza/resources`、`POST /:id/like`、`/:id/use`、`GET /api/plaza/share-id` | 资源浏览、点赞、使用与 share ID |
| 统计 | `GET /api/stats/usage`、`/intimacy`、`/overview` | Token 三分支、亲密度、陪伴天数 |
| 管理端 | `GET /api/admin/overview`、`/users`、`/logs`、`/settings`、`/storage` | 全局统计、用户与审计、服务配置 |
| 媒体 | `POST /api/media`、`GET /api/media/:id` | 图片、语音、头像上传与鉴权读取 |
| 版本 | `GET /api/version/latest`、`/updates` | 版本信息与更新说明 |
| QQ(OneBot) | `WS /onebot/ws`、`POST /onebot/event`、`GET /onebot/status` | NapCat 上报入口 |

模型回复协议（`type: message/image/profile/status/subjective/wakeup`、分段 `sendsec` 与兼容字段 `wait`、主动消息 `timesec`）与全部错误码以 `docs/API.md` 为准。

## 版本与更新说明

当前版本 **1.5.2**（2026-11-07），本版更新见 [`update1.5.2.md`](update1.5.2.md)。历史版本日志：

| 版本 | 日期 | 日志 |
| --- | --- | --- |
| 1.5.2 | 2026-11-07 | [update1.5.2.md](update1.5.2.md) |
| 1.5.1 | 2026-11-07 | [update1.5.1.md](update1.5.1.md) |
| 1.5.0 | 2026-11-07 | [update1.5.0.md](update1.5.0.md) |
| 1.3.1 | 2026-11-03 | [update1.3.1.md](update1.3.1.md) |
| 1.3.0 | 2026-11-02 | [update1.3.0.md](update1.3.0.md) |
| 1.2.1 | 2026-11-02 | [update1.2.1.md](update1.2.1.md) |
| 1.2.0 | 2026-11-01 | [update1.2.0.md](update1.2.0.md) |
| 1.1.0 | 2026-11-01 | [update1.1.0.md](update1.1.0.md) |
| 1.0.1 | 2026-11-01 | [update1.0.1.md](update1.0.1.md) |
| 1.0.0 | 2026-11-01 | [update1.0.0.md](update1.0.0.md) |

客户端启动时会检查版本信息：标为需要更新的版本会提示版本更新并给出更新说明，其余版本按提示自行选择。升级前建议备份数据目录与主密钥。

## 开源协议

本项目以 **GPL-3.0** 发布，全文见 [`LICENSE`](LICENSE)。Copyright (C) 2026 Sand Salt / takwoo258-create。
