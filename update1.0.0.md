# Cocoa v1.0.0 更新日志

> 版本：1.0.0（首次公开发布）　日期：2026-11-01

## 后端 · 基础

### 新增

* `server/src/env.js`：统一环境加载，支持 `.env` 与 `server/.env` 双路径且不覆盖既有环境变量，并自动创建 `data/`、`vault/`、`media/`、`logs/` 目录。
* 主密钥策略：`COCOA_MASTER_KEY` 未设置或不足 32 字符时，自动生成 48 字节密钥并写入 `data/.masterkey`（权限 600），启动日志提示备份。
* `GET /api/health`：返回 `{ok,name,version,time,uptime}`，供进程守护与云监控探活。
* 统一错误体 `{error:{code,message,detail}}` 与 404/500 兜底处理，并加入 `trust proxy`、CORS 与请求耗时日志。
* 优雅退出：`SIGINT/SIGTERM` 关闭 HTTP 服务后 5 秒退出；`unhandledRejection` 只记录，不直接结束进程。

### 调整

* 使用 `node:sqlite`（`DatabaseSync`）替代外部数据库驱动，启用 `journal_mode=WAL`、`foreign_keys=ON`、`busy_timeout=8000`、`synchronous=NORMAL`，并加入语句级 LRU 缓存。
* `engines.node` 提升为 `>=22.5`，即 `node:sqlite` 内置化的最低版本。

## 后端 · 认证与多用户

### 新增

* 邮箱验证码与密码双模式登录；注册需二次确认密码；`devCode` 仅在未配置邮件服务时回显，便于开发调试。
* 令牌签发与吊销：支持单条 `logout` 与全量 `logout-all`，`COCOA_TOKEN_TTL` 默认 30 天。
* `GET/PUT /api/users/me`：资料修改与 `ready.chat/embedding` 就绪状态，客户端据此弹出模型配置引导。
* 首次启动自动创建管理员：库中无管理员时按 `COCOA_ADMIN_EMAIL` / `COCOA_ADMIN_PASSWORD` 写入，之后不再覆盖。
* 登录与注册限流、审计日志（`core/ratelimit.js`、`services/audit.js`）。

## 后端 · 服务配置

### 新增

* `GET/PUT /api/config`：`chat/embedding/deepseek/stt/tts/search` 多服务配置；apiKey 只回显 `apiKeySet/apiKeyMasked`，传入 `****` 保持原值、传空串清除。
* `POST /api/config/models`：拉取模型列表并标注 `modalities:[text,image,audio]` 与 SVG 图标，供客户端渲染多模态能力。
* `POST /api/config/test`：连通性测试返回 `{ok,latencyMs,detail}`，失败返回 502。
* `GET/PUT /api/config/preferences`：调试模式、思考模式、主动回复、分段发送、模型分工、硬/软 Token 限额、上下文限额与语言。

## 后端 · 角色与对话

### 新增

* 角色 CRUD：九项人设字段、`settings` 与 `archived`；角色之间的记忆、人设与资产完全隔离。
* `POST /api/characters/expand`：把模糊词扩写为 JSON 人设并自动回填。
* 角色模板复用（`character_templates`），新角色可沿用旧模板。
* 角色状态 `motion/psychology/mood/health/sleepState`，默认每 10 分钟刷新。
* 会话主链路：用户消息入库 → 句子完整性判定（非思考模式，只回 `yes/no`）→ 按语音、图片、文字的优先级做多模态转换 → 主模型回复 → JSON 协议解析（异常时降级为纯文本）。
* 分段回复：`devide/agent[]/wait` 校验，`wait` 取 0–8 秒；仅智能体对话允许分段。
* 上下文占用计算与压缩：达到 85% 时等当前回复结束后压缩，期间消息入队并回 `notice:"在回味之前的记忆喵~"`；调试模式暴露 `used/limit/percent`。
* 睡眠与午睡拦截、叫醒：`wakeup=1` 时二次请求模型调整状态并生成回复，提示语统一追加“若强行叫醒的话，可能会带来不必要的麻烦哦”。
* 主动回复：回复后进入 60–80 秒随机等待，超时由模型判断是否追问，否则生成 `subjective`（含 `sendsec`）。
* WebSocket `/ws`：推送 `ready/message/typing/notice/context/state/profile/subjective/error` 事件。

## 后端 · 记忆 / 书架 / 统计 / 管理端

### 新增

* 记忆网图 `GET /api/memory/graph`：节点分为 `agent/category(big|small)/memory`，记忆点恒为白色、亮度等于权重、关联用虚线；`/api/memory/:id` 详情包含创建时间、大/小类目、内容与关联。
* 语义检索 `GET /api/memory/search`。
* 书架：小说、文集、阅读记录、日记统一存入 `books`；日记正文不出现在列表接口，需 `POST /api/books/diary/unlock` 解锁，密码每日随机且仅返回角色暗示。
* 统计：Token 三分支（`input/inputHit/inputMiss/output`）、金额、模型维度、时间范围（日/3 日/7 日/30 日/年/全部/自定义）与 `bucket` 聚合。
* 亲密度与陪伴天数，以及对话数、创作数、健康异常、心情异常统计。
* 管理端：用户管理、全量用量（可按用户筛选）、会话列表、日志审计、SMTP 与 OneBot 配置、存储用量、在线用户（10 分钟活跃）。

## 后端 · OneBot（QQ）

### 新增

* 反向 WebSocket `/onebot/ws?access_token=`、HTTP 上报 `POST /onebot/event` 与 `GET /onebot/status`。
* 按 `users.qq` 路由：未注册回复「账号未注册，花名册上没有主人的大名哦~」；已注册但缺配置回复「<未配置项目名>还未设置哦，请前往 Cocoa 进行配置」。
* 模块未就绪时不影响主服务启动（`index.js` 动态导入并降级处理）。

## 客户端（Flutter / Android）

### 新增

* 全新 Android 客户端：登录注册、模型配置引导、角色创建（含便捷扩写）与陪伴主页面。
* 记忆网图页面：点击智能体或类目折叠展开，点击记忆点弹出详情。
* 书架页面：小说、文集、阅读与日记（六位密码解锁）。
* 统计页面：Token 柱状图（点击查看浮层详情）、亲密度折线图、陪伴天数 Banner。
* 管理端页面：用户、用量、日志、SMTP/OneBot 配置。
* 登录态持久化（`flutter_secure_storage`）与 WebSocket 断线重连。

### 调整

* 仅支持 Android，不含独立的应用内对话端。

## 部署与运维

### 新增

* `deploy/install.sh`：一键安装与升级，流程为安装 Node 24 → 创建运行用户 → 快照旧版 → 解包 → 安装生产依赖 → 生成环境文件 → 注册服务 → 配置防火墙 → 健康检查，可重复执行。
* `deploy/deploy.mjs`（基于 ssh2）：`preflight / deploy / rollback / status` 四种模式，凭据只从环境变量读取，代码包排除 `node_modules`、`data`、`.env` 与签名文件。
* `deploy/cocoa.service`：`Restart=always`、`RestartSec=3`、`MemoryHigh=700M`、`MemoryMax=900M`、`MemorySwapMax=0`、`OOMScoreAdjust=200`、`NODE_OPTIONS=--max-old-space-size=512`，可与同机的面板与 NapCat 共存。
* `deploy/rollback.sh`：代码级回滚（数据与环境文件取最新），两版均不健康时自动换回，避免长时间停机。
* `deploy/backup.sh`：用 `VACUUM INTO` 做一致性快照，并打包 `vault`、`media`、`logs`，保留 14 份轮转。
* `deploy/nginx.conf.example`：80/443 反向代理，含 `/ws` 与 `/onebot/` 的 Upgrade 透传。
* `deploy/env.example`：全量环境变量模板（含 OneBot、SMTP、嵌入与搜索默认值）。
* `scripts/install-toolchain.sh`：Flutter 3.47.9、Temurin JDK 17 与 Android SDK 35 一键安装，内置静态 busybox 以适配缺少 `xz`/`unzip` 的环境。
* `scripts/env.sh`：构建环境变量（`JAVA_HOME`、`ANDROID_SDK_ROOT`、Gradle 串行与 2G 堆）。
* `scripts/build-apk.sh`：`pub get → analyze（error 阻塞）→ build apk → 注入签名 → 产物归档与 SHA256 校验`。
* `docs/DEPLOY.md`：目标环境基线、目录布局、脚本与手工部署、配置项、防火墙与安全组、NapCat 接入、备份、升级回滚、冒烟、排障与安全清单。
* `README.md`：架构图、功能概览、快速开始、接口概览、客户端说明、部署步骤与常见问题。

### 调整

* 部署端口默认 `8787`，被占用时改用 `8788` 并同步修改客户端地址。

## 安全

### 新增

* 正文经多重对称加密后落 `data/vault`；apiKey 仅回显掩码。
* 日记密码每日随机，仅以暗示形式给出。
* 部署产物不含密钥：`.env`、`.masterkey`、初始管理员密码文件、`*.jks`、`key.properties` 与 `*.apk` 均不入库。
* 服务以非 root 用户运行，启用 `NoNewPrivileges`、`ProtectSystem=full`，并用 `ReadWritePaths` 限定可写目录。

## 已知限制

* 单进程与 SQLite，不支持多实例水平扩展。
* 运行环境为小内存单机实例，Node 堆上限 512M，不适合在该机执行构建类重任务。
* 默认使用 HTTP，启用 HTTPS 需反向代理与证书。
* NapCat 需自行部署；未安装时 OneBot 相关能力不可用，但不影响其它功能。
* 回滚仅回退代码，不回退数据；破坏性 schema 变更需自行备份与迁移。
