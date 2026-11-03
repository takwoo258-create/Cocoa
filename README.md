# Cocoa

> 虚拟智能体陪伴系统 —— 后端（Node.js）+ Android 客户端（Flutter），开源协议 GPLv3。

Cocoa 让用户自己配模型、自己捏角色：角色有独立人设、记忆、状态、作息、日记与创作，能通过 QQ 主动找人聊天，也能在 App 里被"叫醒"。所有文本落盘前多重对称加密，角色与角色、用户与用户之间数据完全隔离。

- 最新版本：`v1.3.1`（更新日志见 [`update1.3.1.md`](update1.3.1.md)）
- Android 安装包：GitHub Release 页面 → `Cocoa-v1.3.1.apk`（后端源码包 `Cocoa-backend-v1.3.1.zip` 同页）
- 接口契约：[`docs/API.md`](docs/API.md)　部署手册：[`docs/DEPLOY.md`](docs/DEPLOY.md)

---

## 1. 功能概览

| 模块 | 能力 |
| --- | --- |
| 模型接入 | OpenAI 兼容协议；API Key / Base URL 在首次使用时录入；模型列表、连接测试、多模态能力（文本/图片/语音）以 SVG 图标标注 |
| 多模态消息 | 语音 = 图片 > 文字 的推理顺序；图片/语音先经模型转写成文字描述，再与用户文本合并送入主模型 |
| 上下文管理 | 按模型上下文窗口计算占用；≥85% 时在回复结束后压缩，期间用户输入排队并提示"在回味之前的记忆喵~"；调试模式显示环形进度条 |
| 记忆系统 | Embedding 模型生成记忆点，构成「智能体 → 大类目 → 小类目 → 记忆点」神经网图；记忆点恒为白色、亮度 = 权重，关联记忆用虚线连接 |
| 亲昵陪伴 | 九项人设字段 + 模糊词一键扩写为 JSON；多角色并行；默认关闭思考模式；句子完整性判定（yes/no）；口语化回复；分段发送（wait ≤ 8s） |
| 角色世界 | 每 10 分钟刷新动作/心理/心情/健康；作息与睡眠提示；微博热搜 + RSS 阅读感想；日记与小说创作 |
| 书架 | 小说 / 文集 / 阅读记录 / 日记独立页面；日记需六位密码，密码每日随机、角色只给暗示不给明文 |
| 主动回复 | 回复后进入 60–80s 随机等待期；超时由模型判断是否追问，否则生成下一条主动消息（`subjective` + `sendsec`） |
| 存储 | SQLite（WAL）存元信息，正文经多重对称加密后落 vault；数据库/消息/缓存用量可统计 |
| 多用户 | 邮箱注册登录（验证码/密码双模式）、QQ 号绑定校验、细粒度角色隔离 |
| 统计 | Token 三分支（输入命中/输入未命中/输出）、金额、模型维度筛选；陪伴天数、亲密度折线；管理员全局汇总 |
| 管理端 | 用户管理、日志审计、SMTP 与 OneBot 配置、存储用量、在线用户与活跃会话 |
| QQ 接入 | OneBot11 反向 WebSocket（NapCat 上报），按 `users.qq` 路由到用户默认角色 |

---

## 2. 架构

```
┌────────────────────────┐        HTTPS / WebSocket        ┌─────────────────────────────────────┐
│  Flutter Android 客户端  │ ─────────────────────────────▶ │  Cocoa 后端（Node.js 24 + Express 5） │
│  • 登录态 / 角色 / 对话   │ ◀───────────────────────────── │                                     │
│  • 记忆网图 / 书架 / 统计 │        ws://host/ws?token=…     │  routes/       HTTP 契约（API.md）    │
└────────────────────────┘                                 │  services/     角色·任务·审计·设置    │
                                                           │  ai/           模型路由·用量·调度     │
┌────────────────────────┐     OneBot11 反向 WS            │  realtime/hub  在线事件广播          │
│  NapCat（QQ 机器人）      │ ──▶ ws://host:8787/onebot/ws    │  onebot/       QQ 消息适配           │
│  由用户自行部署          │ ◀── (access_token 鉴权)          │  auth/ db/ core/ 鉴权·SQLite·加密    │
└────────────────────────┘                                 └───────────────┬─────────────────────┘
                                                                           │
                                          ┌────────────────────────────────▼──────────────────────┐
                                          │ SQLite WAL: data/cocoa.db                             │
                                          │ data/vault/  加密正文（消息·人设·创作·记忆）            │
                                          │ data/media/  图片·语音·头像                            │
                                          │ data/logs/   cocoa.log（按级别）                       │
                                          └───────────────────────────────────────────────────────┘
                                                 │
                                                 ▼  HTTPS
                                  ┌────────────────────────────────────┐
                                  │ 上游 OpenAI 兼容服务（对话/Embedding） │
                                  │ DeepSeek（搜索/抓取）、STT、TTS 接口     │
                                  └────────────────────────────────────┘
```

约定：

- 浏览器/客户端只与 `/api/*` 打交道；实时事件走 `/ws`；QQ 侧走 `/onebot/*`。
- 主密钥 `COCOA_MASTER_KEY`（或首次启动自动生成的 `data/.masterkey`）是解密历史数据的唯一凭据，**丢失即不可恢复**，务必备份。
- 单进程、无外部数据库依赖：`node:sqlite` 为 Node 22.5+ 内置模块，因此 `engines` 要求 `>=22.5`。

---

## 3. 快速开始（本地）

```bash
# 1) 依赖（Node >= 22.5，推荐 24）
git clone https://github.com/takwoo258-create/Cocoa.git
cd Cocoa
npm ci

# 2) 配置
cp deploy/env.example .env
#  至少填：COCOA_MASTER_KEY（>=32 字符）、COCOA_ADMIN_EMAIL / COCOA_ADMIN_PASSWORD
#  生成主密钥：node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"

# 3) 启动
npm start           # 生产
npm run dev         # 开发（--watch 热重启）

# 4) 验证
curl http://127.0.0.1:8787/api/health
# {"ok":true,"name":"cocoa","version":"1.3.1","time":"…","uptime":1}
```

测试：

```bash
npm test            # node --test server/test/
npm run smoke       # 端到端冒烟脚本
```

首次登录：用 `.env` 里的 `COCOA_ADMIN_EMAIL / COCOA_ADMIN_PASSWORD`。服务启动时若库中不存在管理员则自动创建（`server/src/services/bootstrap.js`），之后修改 `.env` 不会覆盖已存在账号。

---

## 4. 接口概览

完整字段、错误结构与 JSON 协议见 [`docs/API.md`](docs/API.md)。前缀统一 `/api`，除 `/api/health` 与认证接口外均需 `Authorization: Bearer <token>`。

| 分组 | 代表端点 | 说明 |
| --- | --- | --- |
| 健康检查 | `GET /api/health` | 存活探针，无需鉴权 |
| 认证 | `POST /api/auth/send-code`、`/register`、`/login`、`GET /api/auth/me`、`/logout` | 邮箱验证码注册、密码/验证码登录、令牌吊销 |
| 用户 | `GET/PUT /api/users/me` | 资料与就绪状态（`ready.chat/embedding`） |
| 服务配置 | `GET/PUT /api/config`、`POST /api/config/models`、`/test`、`GET/PUT /api/config/preferences` | 多服务 apiKey（只回显掩码）、模型列表与连通性、模型分工与限额 |
| 角色 | `GET/POST /api/characters`、`POST /api/characters/expand`、`/<id>/settings`、`/<id>/state` | 人设 CRUD、模糊词扩写、作息/RSS/创作配置、状态查询 |
| 对话 | `POST /api/characters/:id/messages`、`GET …/messages`、`/active-reply`、`/wake`、`/context` | 发送（文本/图片/语音）、历史、主动回复、叫醒、上下文占用 |
| 实时 | `WS /ws?token=` | `ready/message/typing/notice/context/state/profile/subjective/error` 事件 |
| 记忆 | `GET /api/memory/graph`、`/:id`、`DELETE /:id`、`/search` | 网图节点/连线、详情、语义检索 |
| 书架 | `GET /api/books`、`/:id`、`POST /api/books`、`/diary/unlock`、`/diary/lock-status` | 小说/文集/阅读/日记；日记密码每日随机 |
| 统计 | `GET /api/stats/usage`、`/intimacy`、`/overview` | Token 三分支、亲密度、陪伴天数 |
| 管理端 | `GET /api/admin/overview`、`/users`、`/logs`、`/settings`、`/storage`、`/onebot/status` | 全局统计、用户与审计、SMTP/OneBot 配置 |
| 媒体 | `POST /api/media`（multipart）、`GET /api/media/:id` | 图片/语音/头像上传与鉴权读取 |
| QQ(OneBot) | `WS /onebot/ws?access_token=`、`POST /onebot/event`、`GET /onebot/status` | NapCat 上报入口 |

各接口的 JSON 结构、模型回复协议（`type: message/profile/subjective/status/wakeup`、分段 `wait` 0–8s）与错误码，均以 `docs/API.md` 为准。

---

## 5. Android 客户端

- 技术栈：Flutter（Dart `>=3.4`），仅 Android；包名/版本见 [`app/pubspec.yaml`](app/pubspec.yaml)。
- 依赖：`http`、`web_socket_channel`、`shared_preferences`、`flutter_secure_storage`、`fl_chart`、`image_picker`、`record`、`just_audio`、`path_provider`。
- 保持登录态：令牌存 `flutter_secure_storage`，启动校验 `GET /api/auth/me`。
- 启动后先在设置里填模型 API（不配置无法对话），再创建角色。

构建：

```bash
# 工具链：Flutter 3.47.9 stable + JDK 17 + Android SDK 35
source scripts/env.sh          # JAVA_HOME / ANDROID_SDK_ROOT / PATH / Gradle 串行参数
bash scripts/build-apk.sh      # 内含 pub get → analyze → build apk --release → 签名/产物复制
```

产物：`app/build/app/outputs/flutter-apk/app-release.apk`，发布时复制为
`/data/dsh/home/Cocoa-v1.3.1.apk` 并上传到 GitHub Release。

签名材料放在仓库外 `$COCOA_SIGN_DIR`（默认 `/data/dsh/home/.cocoa-sign/`）：`cocoa-release.jks` + `key.properties`，两者都不入库。

安装：Release 页下载 APK → 允许"安装未知来源应用" → 安装后首次启动填你的服务器地址（如 `https://<你的服务器地址>`）。

---

## 6. 部署

最短路径（脚本化，SSH 密码只走环境变量）：

```bash
export COCOA_SSH_PASS='<服务器 root 密码>'
node deploy/deploy.mjs preflight   # 只读巡检：OS/内存/磁盘/端口/已有服务/Node/防火墙
node deploy/deploy.mjs deploy      # 打包上传 → 装 Node24 → npm ci → systemd → 冒烟
node deploy/deploy.mjs rollback    # 回滚到 /opt/cocoa.prev（数据不回滚）
```

手工部署（服务器内）：

```bash
tar -czf /tmp/cocoa.tar.gz --exclude=node_modules --exclude=data --exclude=.git .
scp /tmp/cocoa.tar.gz deploy/install.sh root@HOST:/tmp/
ssh root@HOST 'bash /tmp/install.sh /tmp/cocoa.tar.gz /opt/cocoa 8787'
```

部署拓扑与全部细节（端口、systemd、防火墙、安全组、备份、回滚、升级、排障）见 **[`docs/DEPLOY.md`](docs/DEPLOY.md)**。

关键约定：

- 代码 `/opt/cocoa`，数据 `/opt/cocoa/data`，上一版快照 `/opt/cocoa.prev`，服务 `cocoa.service`（`Restart=always`、`MemoryMax=900M`、堆上限 512M）。
- 默认端口 `8787`；若被占用改用 `8788` 并在客户端同步改地址（**不要 kill 占用者**）。
- 服务器防火墙（ufw/firewalld）由安装脚本放行；**阿里云安全组需手工放行 8787/TCP**，否则公网 `curl` 会超时。
- 首次部署后管理员初始密码写在 `/opt/cocoa/.admin-initial-password`（600），登录后请修改并删除该文件。

---

## 7. 接入 QQ（NapCat）

本仓库只提供 OneBot11 适配层，**不包含 NapCat 本体**，需自行安装（例如 Docker `mlikiowa/napcat-docker`）。配置要点：

1. NapCat 网络配置 → 添加「WebSocket 客户端（反向 WS）」
2. URL：`ws://<服务器公网 IP>:8787/onebot/ws?access_token=<ONEBOT_TOKEN>`
3. `ONEBOT_TOKEN` 与服务端 `/opt/cocoa/.env` 中保持一致（也可在管理端「OneBot 配置」里改）
4. 重启 NapCat 使其重连；`GET /api/admin/onebot/status` 可看连接状态

消息路由：QQ 号 ↔ `users.qq`。未注册回复「账号未注册，花名册上没有主人的大名哦~」；已注册但某项配置缺失回复「<未配置项目名>还未设置哦，请前往 Cocoa 进行配置」；否则进入该用户默认角色的主会话。

---

## 8. 常见问题（FAQ）

**Q1. 端口 8787 被占用怎么办？**
换 `8788`：改 `/opt/cocoa/.env` 的 `PORT`，`systemctl restart cocoa`，客户端地址同步改；云安全组/防火墙放行新端口。安装脚本发现端口被占用会直接失败退出，不会杀进程。

**Q2. 公网 `curl http://IP:8787/api/health` 超时，但服务器内 `curl 127.0.0.1:8787` 正常？**
云厂商安全组未放行 8787/TCP。到控制台加入站规则（TCP 8787，来源按需限制）。本机 `ufw status` 若为 inactive，说明没有主机防火墙拦截。

**Q3. 启动报 `SQLITE_CANTOPEN` / `node:sqlite` 不存在？**
Node 版本低于 22.5。`node -v` 确认，安装脚本会把 Node 24 静态包放到 `/usr/local/lib/nodejs` 并软链到 `/usr/local/bin`。

**Q4. 换机器/重装后历史消息全是乱码或报解密失败？**
`COCOA_MASTER_KEY` 变了。它必须与首次启动时一致，或恢复 `data/.masterkey` 文件。请把主密钥纳入备份。

**Q5. `data/cocoa.db-wal` 很大 / 备份用什么？**
不要直接 `cp` 正在使用的 `.db`（WAL 模式下会不一致）。用 `deploy/backup.sh`，它通过 `node:sqlite` 的 `VACUUM INTO` 做一致性快照，并打包 `vault/`、`media/`。

**Q6. 升级后出问题怎么退？**
`bash /opt/cocoa/deploy/rollback.sh`（或本机 `node deploy/deploy.mjs rollback`）。脚本把坏版本移到 `/opt/cocoa.broken-<时间戳>`，从 `/opt/cocoa.prev` 恢复代码，`data/` 与 `.env` 取最新；若回滚版本仍不健康会自动换回，避免长时间停机。

**Q7. 服务器内存只有 1.7G，会不会拖垮同机的面板/机器人？**
systemd 单元里限制了 `MemoryMax=900M`、`MemoryHigh=700M`、`NODE_OPTIONS=--max-old-space-size=512`，`Nice=5`、`CPUWeight=80`。不要在这台机器上同时跑 Flutter 构建或 `npm ci` 之类的重任务。

**Q8. 构建机上 `/tmp` 只有 256M 且 noexec？**
用 `/data` 下的路径放工具链与构建产物（`source scripts/env.sh` 已指向 `/data/dsh/home/.toolchain`）。下载的 `.tar.xz` 若系统无 `xz`，用 `scripts/install-toolchain.sh`（内置静态 busybox 解压）。

**Q9. `flutter analyze` 报 error 但只是提示？**
`error` 必须清零才能出包，`warning/info` 不阻塞。客户端代码归 app 线维护，构建线不直接改 `app/lib`。

**Q10. 没有域名能用 HTTPS 吗？**
可以先 http（客户端里关闭明文校验风险自担），或让 Nginx 用自签证书（`deploy/nginx.conf.example` 有 HTTPS 段）。有域名后更容易：Let's Encrypt + Nginx 反代，注意 `/ws`、`/onebot/` 必须透传 `Upgrade` 头。

---

## 9. 目录结构

```
Cocoa/
├── app/                 Flutter Android 客户端（lib/ 由客户端线维护）
├── server/              后端
│   ├── src/
│   │   ├── routes/      HTTP 契约实现
│   │   ├── services/    角色、任务、审计、设置、bootstrap
│   │   ├── ai/          模型路由、用量、调度、提示词
│   │   ├── realtime/    WebSocket hub
│   │   ├── db/          schema.sql 与 node:sqlite 封装
│   │   ├── auth/ core/ mail/ onebot/
│   │   ├── app.js       Express 装配
│   │   └── index.js     进程入口（HTTP + WS + 调度器）
│   └── test/            单元与冒烟测试
├── deploy/              install.sh、cocoa.service、deploy.mjs、backup/rollback、nginx/env 模板
├── scripts/             env.sh（构建环境）、install-toolchain.sh、build-apk.sh
├── docs/                API.md（契约）、DEPLOY.md（部署手册）
├── update1.3.1.md       版本更新日志　（历史：update1.3.0.md / update1.2.1.md / update1.2.0.md …）
└── LICENSE              GPL-3.0
```

---

## 10. 许可

GPL-3.0（全文见 [`LICENSE`](LICENSE)）。Copyright (C) 2026 Sand Salt / takwoo258-create。
