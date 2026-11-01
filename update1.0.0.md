# Cocoa v1.0.0 更新日志

> 格式说明：`+` 新增　`-` 删除　`±` 调整
> 版本：1.0.0（首次公开发布）　日期：2026-11-01

## 后端 · 基础

+ `server/src/env.js`：统一环境加载（`.env` / `server/.env` 双路径、不覆盖既有 env），自动创建 `data/`、`vault/`、`media/`、`logs/` 目录
+ 主密钥策略：`COCOA_MASTER_KEY` 未设置或 <32 字符时自动生成 48 字节密钥并写入 `data/.masterkey`（600），启动日志提示备份
+ `GET /api/health`：返回 `{ok,name,version,time,uptime}`，供 systemd/云监控探活
+ 统一错误体 `{error:{code,message,detail}}` 与 404/500 兜底处理；`trust proxy`、CORS、请求耗时日志
± `node:sqlite`（`DatabaseSync`）替代外部驱动：`PRAGMA journal_mode=WAL / foreign_keys=ON / busy_timeout=8000 / synchronous=NORMAL`，语句级 LRU 缓存
± `engines.node` 提升为 `>=22.5`（`node:sqlite` 内置化的最低版本）
+ 优雅退出：`SIGINT/SIGTERM` 关闭 HTTP 后 5s 强制退出；`unhandledRejection` 记录不杀死进程

## 后端 · 认证与多用户

+ 邮箱验证码 + 密码双模式登录；注册二次确认密码；`devCode` 仅在 SMTP 未配置时回显（开发用）
+ 令牌签发/吊销（单条 `logout`、全量 `logout-all`），`COCOA_TOKEN_TTL` 默认 30 天
+ `GET/PUT /api/users/me`：资料修改、`ready.chat/embedding` 就绪状态（客户端据此弹出模型配置引导）
+ 首次启动自动创建管理员（库中无 `admin` 时按 `COCOA_ADMIN_EMAIL/PASSWORD` 写入，之后不再覆盖）
+ 登录/注册限流与审计日志（`core/ratelimit.js`、`services/audit.js`）

## 后端 · 服务配置

+ `GET/PUT /api/config`：`chat/embedding/deepseek/stt/tts/search` 多服务配置；apiKey 只回显 `apiKeySet/apiKeyMasked`，传 `****` 保持不变、传空串清除
+ `POST /api/config/models`：拉取模型列表并标注 `modalities:[text,image,audio]` 与 SVG 图标，供客户端渲染多模态能力
+ `POST /api/config/test`：连通性测试返回 `{ok,latencyMs,detail}`，失败 502
+ `GET/PUT /api/config/preferences`：调试模式、思考模式、主动回复、分段发送、模型分工、硬/软 Token 限额、上下文限额、语言

## 后端 · 角色与对话

+ 角色 CRUD（九项人设字段 + `settings` + `archived`），角色间记忆/人设/资产完全隔离
+ `POST /api/characters/expand`：模糊词 → 大模型扩写为 JSON 人设并自动回填
+ 角色模板复用（`character_templates`），新角色可沿用旧模板
+ 角色状态 `motion/psychology/mood/health/sleepState`，默认 10 分钟刷新
+ 会话主链路：用户消息入库 → 句子完整性判定（强制非思考模式，只回 `yes/no`）→ 优先级 语音=图片>文字 的多模态转换 → 主模型回复 → JSON 协议解析（容错降级纯文本）
+ 分段回复：`devide/agent[]/wait` 校验 0–8 秒；仅智能体对话允许分段
+ 上下文占用计算与压缩：≥85% 时等当前回复结束后压缩，期间入队并回 `notice:"在回味之前的记忆喵~"`；调试模式暴露 `used/limit/percent`
+ 睡眠/午睡拦截与叫醒：`wakeup=1` 时二次请求模型调整状态并生成回复；提示语统一追加"若强行叫醒的话，可能会带来不必要的麻烦哦"
+ 主动回复：回复后 60–80s 随机等待，超时由模型判断是否追问，否则生成 `subjective`（含 `sendsec`）
+ WebSocket `/ws`：`ready/message/typing/notice/context/state/profile/subjective/error` 事件推送

## 后端 · 记忆 / 书架 / 统计 / 管理端

+ 记忆网图 `GET /api/memory/graph`：节点分 `agent/category(big|small)/memory`，记忆点恒白、亮度=权重、关联用虚线；`/api/memory/:id` 详情含创建时间、大/小类目、内容与关联
+ 语义检索 `GET /api/memory/search`
+ 书架：小说/文集/阅读记录/日记统一 `books`；日记正文不出现在列表接口，需 `POST /api/books/diary/unlock` 解锁，密码每日随机、仅返回角色暗示
+ 统计：Token 三分支（`input/inputHit/inputMiss/output`）、金额、模型维度、时间范围（日/3日/7日/30日/年/全部/自定义）与 `bucket` 聚合
+ 亲密度与陪伴天数、对话数/创作数/健康异常/心情异常统计
+ 管理端：用户管理、全量用量（可按用户筛选）、会话列表、日志审计、SMTP 与 OneBot 配置、存储用量、在线用户（10 分钟活跃）

## 后端 · OneBot（QQ）

+ 反向 WS `/onebot/ws?access_token=`、HTTP 上报 `POST /onebot/event`、`GET /onebot/status`
+ 按 `users.qq` 路由：未注册回「账号未注册，花名册上没有主人的大名哦~」；已注册但缺配置回「<未配置项目名>还未设置哦，请前往 Cocoa 进行配置」
+ 模块未就绪时不影响主服务启动（`index.js` 动态 import + try/catch 降级）

## 客户端（Flutter / Android）

+ 全新 Android 客户端：登录注册、模型配置引导、角色创建（含便捷扩写）、陪伴主页面
+ 记忆网图页面：点击智能体/类目折叠展开，点击记忆点弹出详情
+ 书架页面：小说/文集/阅读/日记（六位密码解锁）
+ 统计页面：Token 柱状图（点击看浮层详情）、亲密度折线图、陪伴天数爱心 Banner
+ 管理端页面：用户、用量、日志、SMTP/OneBot 配置
+ 登录态持久化（`flutter_secure_storage`）；WebSocket 断线重连
± 仅 Android，不含独立应用对话

## 部署与运维（新增）

+ `deploy/install.sh`：一键安装/升级（Node 24 静态包 → 建 `cocoa` 用户 → 快照旧版到 `/opt/cocoa.prev` → 解包 → `npm ci --omit=dev` → 生成 `.env` → systemd → 防火墙 → 健康检查），幂等可重跑
+ `deploy/deploy.mjs`（基于 ssh2）：`preflight / deploy / rollback / status` 四模式；密码只走环境变量，代码包排除 `node_modules/data/.env/*.jks`
+ `deploy/cocoa.service`：`Restart=always`、`RestartSec=3`、`MemoryHigh=700M`、`MemoryMax=900M`、`MemorySwapMax=0`、`OOMScoreAdjust=200`、`NODE_OPTIONS=--max-old-space-size=512`，与同机 1panel/NapCat 共存
+ `deploy/rollback.sh`：代码级回滚（数据与 `.env` 取最新），两版均不健康时自动换回避免长时间停机
+ `deploy/backup.sh`：`VACUUM INTO` 一致性快照 + `vault/media/logs` 打包，14 份轮转
+ `deploy/nginx.conf.example`：80/443 反代，含 `/ws`、`/onebot/` 的 Upgrade 透传
+ `deploy/env.example`：全量环境变量模板（含 OneBot、SMTP、嵌入/搜索默认值）
+ `scripts/install-toolchain.sh`：Flutter 3.47.9 + Temurin JDK 17 + Android SDK 35 一键安装（内置静态 busybox 解决无 `xz`/`unzip` 的环境）
+ `scripts/env.sh`：构建环境变量（`JAVA_HOME`、`ANDROID_SDK_ROOT`、Gradle 串行/2G 堆）
+ `scripts/build-apk.sh`：`pub get → analyze（error 阻塞）→ build apk → 签名注入 → 产物归档 + SHA256`
+ `docs/DEPLOY.md`：目标环境基线、目录布局、脚本/手工部署、配置项、防火墙与安全组、NapCat 接入、备份、升级回滚、冒烟、排障、安全清单
+ `README.md`：架构图、功能概览、快速开始、接口概览、客户端说明、部署步骤、FAQ
± 部署端口默认 `8787`，被占用时改 `8788` 并在客户端同步修改

## 安全

+ 正文多重对称加密后落 `data/vault`；apiKey 仅回显掩码
+ 日记密码每日随机、仅以暗示形式给出
+ 部署产物不含密钥：`.env`、`.masterkey`、`admin-initial-password`、`*.jks`、`key.properties`、`*.apk` 均不入库
+ 服务以非 root 用户 `cocoa` 运行，`NoNewPrivileges`、`ProtectSystem=full`、`ReadWritePaths` 限定数据目录

## 已知限制

- 服务器仅 1.7G 内存且无 swap：不支持在该机执行构建类重任务，Node 堆上限 512M
- 单进程 + SQLite，不支持多实例水平扩展
- 当前线上为 HTTP（无域名证书）；开启 HTTPS 需 Nginx + 证书
- NapCat 需用户自行部署；未安装时 OneBot 相关能力不可用，但不影响其它功能
- 回滚仅回退代码，不回退数据（破坏性 schema 变更需自行备份/迁移）
