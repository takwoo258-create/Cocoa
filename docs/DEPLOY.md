# Cocoa 部署手册

本手册覆盖后端从零部署、升级、回滚、备份、排障的完整流程。所有命令以 `root` 在目标服务器执行（或本机通过 `deploy/deploy.mjs` 经 SSH 代为执行）。

- 目标服务器（当前线上）：`120.26.204.70`，SSH 22
- 服务名：`cocoa.service`　端口：`8787`（占用则 `8788`）
- 代码目录：`/opt/cocoa`　数据目录：`/opt/cocoa/data`　上一版：`/opt/cocoa.prev`

---

## 1. 目标环境实测基线

部署前用 `node deploy/deploy.mjs preflight`（只读）确认，实测结果如下（2026-10-31）：

| 项 | 值 | 影响 |
| --- | --- | --- |
| OS | Ubuntu 26.04.1 LTS，kernel 7.0.0-31-generic | systemd 可用，自带 `xz/tar/curl/rsync` |
| CPU | 2 vCPU | 后端单进程足够，构建不要放这里 |
| 内存 | **1735 MB，无 swap** | 必须限堆：`--max-old-space-size=512`、`MemoryMax=900M` |
| 磁盘 | `/` 40G，剩 25G | 数据与备份够用；日志需轮转 |
| 已占端口 | 22(sshd)、12333(1panel-core)、127.0.0.54:53、127.0.0.1:44001(hbrclient) | 8787 空闲 |
| 已有服务 | 1panel-core/agent、docker(0 容器)、containerd、aliyun、hbrclient | **不得停止/重启** |
| NapCat | 未安装、无进程、无容器 | OneBot 适配层照常部署，接 QQ 需自行装 NapCat |
| Node | 未安装 | 用官方静态 tar.xz 装 24.11.1 |
| 防火墙 | `ufw` inactive | 主机层不拦截；**阿里云安全组需放行 8787/TCP** |

> 该机内存仅 1.7G，与 `build.md` 描述的 4G 不同。所有部署动作按 1.7G 设计：不编译前端、不装开发依赖、限制 Node 堆与 cgroup 内存。

---

## 2. 目录布局

```
/opt/cocoa/                  当前版本代码（属主 cocoa:cocoa）
├── server/                 后端源码
├── deploy/                 install.sh / rollback.sh / backup.sh / cocoa.service
├── node_modules/           生产依赖（npm ci --omit=dev）
├── .env                    运行时配置（600，不入库）
├── .admin-initial-password 首次部署生成的管理员初始密码（600，登录后删除）
├── data/                   持久数据（升级不覆盖）
│   ├── cocoa.db (+ -wal/-shm)  SQLite 主库
│   ├── .masterkey          自动生成的主密钥（若 .env 未设置）
│   ├── vault/              加密正文
│   ├── media/              图片/语音/头像
│   └── logs/cocoa.log      应用日志
└── backups/                backup.sh 产物

/opt/cocoa.prev/            上一版代码全量快照（含 node_modules，用于离线回滚）
/opt/cocoa.broken-<ts>/     回滚时移开的坏版本（确认稳定后可删）
/etc/systemd/system/cocoa.service
/usr/local/lib/nodejs/node-v24.11.1-linux-x64/   Node 运行时（软链到 /usr/local/bin）
```

---

## 3. 前置条件

- 目标机：Debian/Ubuntu 系，systemd；`curl`、`tar`、`xz`（缺 xz 时 Node tar.xz 解压会失败）
- root 或具备 sudo 的账号（本流程以 root 演示）
- 出网：`nodejs.org`（或 `npmmirror.com` 镜像）、`registry.npmjs.org`（或国内镜像）
- 客户端能访问服务器 IP + 端口（云安全组）

---

## 4. 部署（脚本方式，推荐）

在**本机**（仓库根目录）执行，SSH 密码只通过环境变量传递，不落仓库：

```bash
export COCOA_SSH_HOST=120.26.204.70
export COCOA_SSH_PORT=22
export COCOA_SSH_USER=root
export COCOA_SSH_PASS='<root 密码>'          # 或 COCOA_SSH_KEY=/path/id_rsa
export COCOA_APP_DIR=/opt/cocoa
export COCOA_PORT=8787
export COCOA_ADMIN_EMAIL=admin@example.com    # 仅首次生效

node deploy/deploy.mjs preflight   # ① 只读巡检：OS/内存/磁盘/端口/已有服务/Node/防火墙
node deploy/deploy.mjs deploy      # ② 打包 → 上传 → 安装 → 冒烟
node deploy/deploy.mjs status      # ③ 服务状态 + 最近 30 行日志
node deploy/deploy.mjs rollback    # ④ 出问题时回滚
```

`deploy` 依次做的事：

1. 本机 `tar` 打包源码（排除 `node_modules`、`data`、`.git`、`.env`、`app/build`、`*.jks`、`*.apk`）；
2. 远程只读巡检并校验端口空闲（被占用则**失败退出**，不杀进程）；
3. 上传代码包与 `install.sh` 到 `/tmp`；
4. 远程执行 `install.sh`：装 Node 24（若无）→ 建 `cocoa` 用户 → 快照旧代码到 `/opt/cocoa.prev` → 解包 → `npm ci --omit=dev` → 生成 `.env` → 安装并启动 systemd → 放行防火墙 → `curl /api/health` 冒烟；
5. 打印访问地址、健康检查结果、初始管理员密码路径。

失败时保留 `/opt/cocoa.prev`，直接执行回滚命令即可。

---

## 5. 部署（手工方式）

```bash
# ① 打包并上传（本机）
tar -czf /tmp/cocoa.tar.gz -C . \
  --exclude=node_modules --exclude=data --exclude=.git --exclude=.env \
  --exclude=app/build --exclude=app/.dart_tool --exclude='*.jks' --exclude='*.apk' .
scp /tmp/cocoa.tar.gz deploy/install.sh root@120.26.204.70:/tmp/

# ② 服务器执行安装
ssh root@120.26.204.70
bash /tmp/install.sh /tmp/cocoa.tar.gz /opt/cocoa 8787
```

`install.sh` 可重复执行（幂等）：第二次起复用现有 `.env`（只校正 `PORT`/`COCOA_DATA_DIR`）、复用 Node、把上一版快照到 `/opt/cocoa.prev`。

---

## 6. 配置项（`/opt/cocoa/.env`）

模板见 [`deploy/env.example`](../deploy/env.example)。关键项：

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `PORT` / `HOST` | 监听端口与地址 | `8787` / `0.0.0.0` |
| `NODE_ENV` | `production` 时错误不返回栈 | `production` |
| `PUBLIC_URL` | 对外地址（用于生成媒体链接） | `http://IP:8787` |
| `COCOA_DATA_DIR` | 数据根目录 | `/opt/cocoa/data` |
| `COCOA_MASTER_KEY` | 加密主密钥，≥32 字符；留空则生成 `data/.masterkey` | 自动 |
| `COCOA_TOKEN_TTL` | 登录令牌有效期（秒） | `2592000` |
| `COCOA_ALLOW_REGISTER` | `0` 关闭注册 | `1` |
| `COCOA_ADMIN_EMAIL` / `COCOA_ADMIN_PASSWORD` | 初始管理员（库中已有 admin 时不再生效） | 空 |
| `SMTP_*` | 验证码邮件；可在管理端覆盖 | 空 |
| `ONEBOT_TOKEN` / `ONEBOT_SELF_ID` / `ONEBOT_WS_PATH` | NapCat 反向 WS 鉴权与路径 | 空 / 空 / `/onebot/ws` |
| `COCOA_EMBEDDING_*` / `COCOA_SEARCH_*` | 默认嵌入与搜索服务 | 空 |
| `COCOA_LOG_LEVEL` | `debug/info/warn/error` | `info` |

改完 `.env` 后：`systemctl restart cocoa && systemctl status cocoa --no-pager`。

> ⚠️ `COCOA_MASTER_KEY` 一旦投入生产**不可更换**，否则历史消息/记忆无法解密。更换前必须先备份并确认迁移方案。

---

## 7. systemd 单元（`deploy/cocoa.service`）

```ini
User=cocoa
WorkingDirectory=/opt/cocoa
EnvironmentFile=/opt/cocoa/.env
Environment=NODE_OPTIONS=--max-old-space-size=512
ExecStart=/usr/bin/node server/src/index.js
Restart=always
RestartSec=3
MemoryHigh=700M
MemoryMax=900M
MemorySwapMax=0
OOMScoreAdjust=200
LimitNOFILE=65535
Nice=5
CPUWeight=80
ProtectSystem=full
ReadWritePaths=/opt/cocoa/data
```

设计意图：容器总内存 1.7G 且无 swap，必须让 Cocoa 在 OOM 时先被回收（`OOMScoreAdjust=200`），保护 1panel 与 NapCat。

常用命令：

```bash
systemctl status cocoa --no-pager
systemctl restart cocoa
journalctl -u cocoa -n 100 --no-pager
journalctl -u cocoa -f
systemctl show cocoa -p MemoryCurrent,MemoryMax
```

---

## 8. 端口、防火墙与安全组

1. 主机防火墙：`install.sh` 自动处理
   - `ufw` 活跃：`ufw allow 8787/tcp`
   - `firewalld` 活跃：`firewall-cmd --permanent --add-port=8787/tcp && firewall-cmd --reload`
   - 两者都不活跃（当前服务器即是）：**什么都不做**，不要贸然开启防火墙，以免切断 22/12333
2. 云安全组（阿里云）：**必须手工放行 TCP 8787**，否则公网不可达。本机验证顺序：

```bash
# 服务器内（排除进程问题）
curl -fsS http://127.0.0.1:8787/api/health
# 本机（排除安全组问题）
curl -m 8 http://120.26.204.70:8787/api/health
```

内通外不通 → 安全组；内外都不通 → 服务或防火墙。

3. 端口冲突：`install.sh` 检测到端口被占用会打印占用者并退出（`ss -lntp`）。换端口：

```bash
sed -i 's/^PORT=.*/PORT=8788/' /opt/cocoa/.env
systemctl restart cocoa
# 云安全组同步放行 8788；客户端服务器地址改为 http://IP:8788
```

**绝不**为腾端口去 stop/kill 1panel、NapCat、hbrclient 等既有进程。

---

## 9. 反向代理与 HTTPS

### 线上现状（已启用：Caddy + Let's Encrypt）

| 项 | 值 |
| --- | --- |
| 域名 | `120-26-204-70.sslip.io`（sslip.io 泛解析 → 120.26.204.70，无需自备 DNS） |
| 入口 | `https://120-26-204-70.sslip.io` → Caddy → `127.0.0.1:8787` |
| 证书 | Let's Encrypt（R11 中间证书），`CN=120-26-204-70.sslip.io`，90 天有效，自动续签 |
| HTTP | 80 端口自动 308 跳转到 HTTPS（`deploy/Caddyfile` 里的 `:80` 兜底块） |
| 直连 | `http://120.26.204.70:8787` 仍然保留，供旧客户端与 WS 使用 |
| 组件 | `/usr/local/bin/caddy`（v2.11.7 静态二进制）+ `caddy.service`，配置 `/etc/caddy/Caddyfile` |

安装/重装（服务器内）：

```bash
bash deploy/caddy-setup.sh 120-26-204-70.sslip.io
# 无外网时先本机下载再上传：CADDY_TARBALL=/tmp/caddy.tar.gz bash deploy/caddy-setup.sh <域名>
```

要点：

- `deploy/Caddyfile` 已包含 gzip/zstd 压缩、HSTS、`X-Content-Type-Options`，并把 `/ws`、`/onebot/` 的 Upgrade 头透传（Caddy 默认即透传，`flush_interval -1` 保证实时性）；
- **续签窗口**：Caddy/certmagic 默认在证书剩余有效期约 1/3（90 天证书 ≈ 到期前 30 天）时续签，并每日检查；本仓库 Caddyfile 里另有 `renewal_window_ratio 0.34`（≈ 剩余 30 天），若 Caddy 版本不支持该项，`caddy-setup.sh` 会自动去掉并回落到默认窗口；
- 查看证书与到期时间：

```bash
echo | openssl s_client -connect 120-26-204-70.sslip.io:443 -servername 120-26-204-70.sslip.io 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
```

- Caddy 启动日志：`journalctl -u caddy -n 100 --no-pager`；证书目录 `/var/lib/caddy/.local/share/caddy/certificates`；
- **前置条件**：云安全组必须放行 80/TCP 与 443/TCP（Let's Encrypt 的 HTTP-01 校验依赖 80），否则证书申请会失败；
- NapCat 反向 WS 若走公网，建议改成 `wss://120-26-204-70.sslip.io/onebot/ws?access_token=…`。

### Nginx 备选方案

`deploy/nginx.conf.example` 仍保留 Nginx 版本（80/443 两段 + WebSocket 透传），适合已有 Nginx 的环境：

```bash
cp deploy/nginx.conf.example /etc/nginx/conf.d/cocoa.conf
sed -i 's/cocoa.example.com/<你的域名>/g' /etc/nginx/conf.d/cocoa.conf
nginx -t && systemctl reload nginx
```

> ⚠️ 不要同时启用 Caddy 与 Nginx 抢占 80/443；两者选一。

没有域名时保持 http，客户端把服务器地址写成 `http://IP:8787`。

---

## 10. 接入 NapCat（QQ）

NapCat **不在本仓库**，也**不在当前服务器**（实测无进程/无容器）。接入步骤：

1. 部署 NapCat（Docker 示例：`mlikiowa/napcat-docker`），用独立 QQ 小号；
2. NapCat WebUI → 网络配置 → 新建「WebSocket 客户端（反向 WS）」；
3. URL：`ws://120.26.204.70:8787/onebot/ws?access_token=<ONEBOT_TOKEN>`；
4. `/opt/cocoa/.env` 里 `ONEBOT_TOKEN` 保持一致（也可在管理端「OneBot 配置」修改，优先级更高）；
5. `systemctl restart cocoa` 后重启 NapCat 触发重连；
6. 验证：`curl http://127.0.0.1:8787/api/admin/onebot/status`（需管理员令牌）。

安全提示：`ONEBOT_TOKEN` 必须是随机长串（`openssl rand -hex 16`），否则任何人可伪造 QQ 消息注入。

---

## 11. 备份

```bash
bash /opt/cocoa/deploy/backup.sh /opt/cocoa 14    # 保留 14 份
```

- 数据库用 `node:sqlite` 的 `VACUUM INTO` 做一致性快照（WAL 模式下直接 `cp` 会拿到半写状态）；
- 同时打包 `vault/`（加密正文）、`media/`、`logs/`；
- 输出 `/opt/cocoa/backups/cocoa-YYYYmmdd-HHMMSS.tar.gz`（600），自动轮转。

每日自动备份（systemd timer）：

```bash
cat >/etc/systemd/system/cocoa-backup.service <<'EOF'
[Unit]
Description=Cocoa nightly backup
[Service]
Type=oneshot
ExecStart=/bin/bash /opt/cocoa/deploy/backup.sh /opt/cocoa 14
EOF
cat >/etc/systemd/system/cocoa-backup.timer <<'EOF'
[Unit]
Description=Run Cocoa backup daily 03:30
[Timer]
OnCalendar=03:30
Persistent=true
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload && systemctl enable --now cocoa-backup.timer
```

异地留存：把 `backups/` 与 `.env`（含 `COCOA_MASTER_KEY`）加密后另行保存；**没有主密钥的备份等于无效备份**。

---

## 12. 升级与回滚

升级 = 再执行一次 `install.sh`（或 `node deploy/deploy.mjs deploy`）：

1. 旧代码整目录快照到 `/opt/cocoa.prev`（含 `node_modules`，可离线回滚）；
2. 新代码覆盖 `/opt/cocoa`，`data/` 与 `.env` 不动；
3. `npm ci --omit=dev` → `systemctl restart cocoa` → 冒烟。

回滚：

```bash
bash /opt/cocoa/deploy/rollback.sh          # 服务器内
node deploy/deploy.mjs rollback             # 本机远程触发
```

流程：停服务 → 当前目录移到 `/opt/cocoa.broken-<ts>` → `/opt/cocoa.prev` 换回 `/opt/cocoa` → 把最新 `data/` 与 `.env` 拷回 → 启动 → 健康检查；若仍不健康，脚本会把坏版本换回来以避免长时间停机。

> 回滚只回退**代码**，不回退数据。若新版本做过破坏性 schema 变更，回滚前先用 `backup.sh` 留一份快照，并评估旧代码能否读新库。

### 12.1 自升级（Release 资产 `Cocoa-backend-vX.Y.Z.zip`）

v1.2.0 起支持「从 GitHub Release 自助升级」，由 `deploy/upgrade.sh` 完成，管理端与 backend-platform API 都调用它：

```bash
/opt/cocoa/deploy/upgrade.sh v1.2.0            # 后台执行（立即返回，脚本已 setsid detach）
/opt/cocoa/deploy/upgrade.sh v1.2.0 --check    # 只探测资产，退出码 3 = 资产不存在
/opt/cocoa/deploy/upgrade.sh v1.2.0 --foreground  # 前台执行，便于观察/演练
```

流程：
1. 下载 `https://github.com/takwoo258-create/Cocoa/releases/download/<TAG>/Cocoa-backend-<TAG>.zip`（缺失时回退 GitHub source archive）；
2. 解压到 `/opt/cocoa.new`，校验 `package.json` 的 `version` 必须等于 TAG；
3. 停 `cocoa.service`，把当前代码快照到 `/opt/cocoa.prev`（**不含 data**）；
4. 交换目录，`data/`、`.env`、`.masterkey`、`.admin-initial-password` 原样带过去；
5. `npm ci --omit=dev` → 启动 → 轮询 `/api/health`，版本号必须等于 TAG；
6. 任一步失败自动回滚到 `/opt/cocoa.prev`，并把坏版本留在 `/opt/cocoa.failed-<ts>`。

进度与结果写在 `/opt/cocoa/data/upgrade-status.json`（API 读取并回写 upgrade_logs），日志追加到 `/opt/cocoa/data/upgrade.log`：

```json
{"running": false, "status": "success", "tag": "v1.2.0", "fromVersion": "1.1.0", "toVersion": "1.2.0",
 "message": "升级成功：v1.2.0", "progress": 100, "startedAt": "…", "finishedAt": "…", "log": "/opt/cocoa/data/upgrade.log"}
```

API 契约（backend-platform 侧）：`spawn('/opt/cocoa/deploy/upgrade.sh', [tag])`，tag 已校验 `^v\d+\.\d+\.\d+(-pre)?$`；可用环境变量 `COCOA_UPGRADE_TAG / COCOA_UPGRADE_LOG / COCOA_UPGRADE_STATUS / COCOA_UPGRADE_LOG_ID / COCOA_UPGRADE_FROM / COCOA_ROOT`。脚本会先 `setsid` 脱离父进程，因此服务重启不会中断升级。

打包后端发布包（本机）：

```bash
bash scripts/package-backend.sh /data/dsh/home
# → Cocoa-backend-v1.2.0.zip（含 server/src、package.json、package-lock.json、deploy、docs、README、LICENSE、updateX.Y.Z.md）
```

---

## 13. 冒烟与验收

```bash
# 存活（公网 HTTPS）
curl -fsS https://120-26-204-70.sslip.io/api/health
# 直连
curl -fsS http://127.0.0.1:8787/api/health

# 注册（SMTP 未配置时响应会带 devCode，仅开发环境）
curl -fsS -X POST http://127.0.0.1:8787/api/auth/send-code \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@example.com","purpose":"register"}'

# 登录拿令牌
TOKEN=$(curl -fsS -X POST http://127.0.0.1:8787/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"identifier":"admin@example.com","mode":"password","password":"<密码>"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')

# 需要鉴权的接口
curl -fsS http://127.0.0.1:8787/api/users/me -H "Authorization: Bearer $TOKEN"
```

WebSocket 连通性（服务器内）：

```bash
node -e '
const ws=new WebSocket("ws://127.0.0.1:8787/ws?token="+process.argv[1]);
ws.onmessage=e=>{console.log("event:",e.data);ws.close()};
ws.onerror=()=>{console.error("ws error");process.exit(1)};
' "$TOKEN"
```

---

## 14. 排障手册

| 现象 | 排查 | 处理 |
| --- | --- | --- |
| `systemctl status` 一直 activating / 反复重启 | `journalctl -u cocoa -n 80` | 多为 `.env` 缺 `COCOA_MASTER_KEY` 太短、端口被占、数据目录权限不对 |
| `EADDRINUSE` | `ss -lntp \| grep 8787` | 换 8788（见 §8），不要 kill 占用者 |
| `SQLITE_CANTOPEN` | `ls -ld /opt/cocoa/data` | `chown -R cocoa:cocoa /opt/cocoa`；确认 `ProtectSystem=full` + `ReadWritePaths` 未写错 |
| `node:sqlite` 模块缺失 | `node -v` | <22.5，重装 Node 24 |
| 502/超时（经 Nginx） | `curl 127.0.0.1:8787/api/health` | 后端没起或 Nginx upstream 端口不对；WS 400 多为 Upgrade 头丢失 |
| OOM 后 Cocoa 被杀 | `journalctl -k \| grep -i oom` | 正常保护行为（`OOMScoreAdjust=200`），调低并发或加 swap |
| 公网不通、内网通 | 安全组 | 放行 8787/TCP |
| 解密失败 | 比对 `COCOA_MASTER_KEY` | 恢复原主密钥或 `data/.masterkey` |

日志位置：`journalctl -u cocoa`（stdout）与 `/opt/cocoa/data/logs/cocoa.log`（文件，按 `COCOA_LOG_LEVEL`）。

---

## 15. 安全清单

- [ ] `.env` 与 `.admin-initial-password` 权限 600，属主 `cocoa`，不入 git
- [ ] `ONEBOT_TOKEN` 为随机长串；`COCOA_MASTER_KEY` 已离线备份
- [ ] 首次登录后修改管理员密码并删除 `.admin-initial-password`
- [ ] 云安全组只放行必要端口，8787 来源尽量限制
- [ ] SSH 禁止密码登录（改用密钥），并在 `fail2ban`/云盾层面限速
- [ ] 定期 `backup.sh` 并验证可恢复（至少每季度演练一次回滚）
- [ ] 服务以非 root 的 `cocoa` 用户运行，`ProtectSystem=full` + `NoNewPrivileges=true`

---

## 16. 已知约束

1. 服务器 1.7G 内存无 swap：任何 `npm ci`、`next build`、Flutter 构建都不应在此机执行（Flutter 构建在本机构建机完成）。
2. 单进程 Node + SQLite：不支持多实例横向扩展；负载增长需先换单写队列或迁移 PG。
3. 无域名/无证书：当前对外是 http，客户端为明文传输；上生产建议补域名 + Let's Encrypt。
4. 回滚不迁移数据：破坏性 schema 变更需配套数据迁移脚本与备份。
5. NapCat 由用户自建，本仓库只提供 OneBot 适配与路由规则。
