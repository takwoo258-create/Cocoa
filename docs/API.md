# Cocoa API 契约 v1

> 所有接口前缀 `/api`。除 `/api/health` 与认证接口外，均需 `Authorization: Bearer <token>`。
> 时间统一为 ISO-8601 UTC 字符串；客户端按 UTC+8 展示。ID 为字符串。
> 错误统一返回：`{ "error": { "code": "...", "message": "...", "detail": {...} } }`。
> 成功列表统一返回数组字段，分页返回 `{ items, total, page, size }`。

## 0. 健康检查
`GET /api/health` → `{ ok: true, name: "cocoa", version: "1.0.0", time }`

## 1. 认证（已实现：routes/auth.js）
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/send-code` | `{email, purpose: "register"\|"login"}`；SMTP 未配置时开发环境回显 `devCode` |
| POST | `/api/auth/register` | `{username,email,password,confirmPassword,qq,code}` → `{token,user,needsApiConfig:true}` |
| POST | `/api/auth/login` | `{identifier,mode:"password"\|"code",password?,code?}` → `{token,expiresAt,user}` |
| GET | `/api/auth/me` | → `{user}` |
| POST | `/api/auth/logout` / `/api/auth/logout-all` | 注销当前令牌 / 全部令牌 |
| GET | `/api/users/me` | → `{user, ready:{chat,embedding}}` |
| PUT | `/api/users/me` | `{username?,email?,qq?,oldPassword?,newPassword?}` |

`user` 对象：`{id,username,email,qq,role,emailVerified,status,createdAt,lastLoginAt,lastActiveAt}`。

## 2. 服务配置（已实现：routes/config.js）
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/config` | `{api,preferences,ready,defaults}`；api 中 apiKey 只返回 `apiKeySet/apiKeyMasked` |
| PUT | `/api/config/api` | `{chat:{baseUrl,apiKey,model},embedding:{...},deepseek:{...},stt:{...},tts:{...},search:{...}}`；apiKey 传 `"****"` 保持不变，传 `""` 清除 |
| POST | `/api/config/models` | `{service}` → `{models:[{id,modalities:["text","image","audio"],capabilities:{...},contextWindow,svg:{text,image,audio}}],source}` |
| POST | `/api/config/test` | `{service}` → `{ok,latencyMs,detail}`（失败 502） |
| GET/PUT | `/api/config/preferences` | `{preferences}`，见下 |
| GET | `/api/config/model-info?id=&task=` | 单模型能力 + 当前路由 |

`preferences`（默认值）：
```json
{
  "debug": false, "thinking": false, "activeReply": true, "segmentEnabled": true,
  "modelRouting": {"main":"","sentence":"","profile":"","portrait":"","creation":"","status":"","memory":"","vision":"","news":"","search":"","tts":"","stt":""},
  "limits": {"hardTokens": 0, "softTokens": 0},
  "contextLimits": {}, "language": "zh-CN"
}
```

## 3. 角色（待实现：routes/characters.js）
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/characters` | → `[character]` |
| POST | `/api/characters` | 9 个人设字段 + `settings?` / `templateId?` → `{character}`（201） |
| GET | `/api/characters/:id` | → `{character}` |
| PUT | `/api/characters/:id` | 人设字段 / `settings` / `archived` |
| DELETE | `/api/characters/:id` | 级联删除该角色全部资产 |
| POST | `/api/characters/expand` | `{prompt}` → `{profile:{name,age,race,gender,personality,worldview,hobbies,relation,appearance,occupation}}`（LLM 扩写，JSON） |
| GET | `/api/characters/templates` | 角色模板列表（`character_templates`） |
| POST | `/api/characters/templates` | `{name, profile}` → 保存模板 |
| GET/PUT | `/api/characters/:id/settings` | 角色设置（RSS、创作标签/频率、作息、模型路由、主动回复开关） |
| GET | `/api/characters/:id/state` | 角色状态 |

`character` 对象：
```json
{
  "id":"c_xxx","name":"可可","age":"20","race":"人类","gender":"女",
  "personality":"...","worldview":"...","hobbies":"...","relation":"恋人","appearance":"...","occupation":"...",
  "avatar":null,"createdAt":"","updatedAt":"","archived":false,
  "state":{"motion":"","psychology":"","mood":"","health":"","sleepState":"awake","updatedAt":"","intimacy":0,"companionDays":1,"chatCount":0},
  "settings":{"rss":[],"creationTags":[],"creationFrequency":"daily","sleep":{"enabled":true,"start":"23:30","end":"07:00","napStart":"13:00","napEnd":"14:30"},"statusIntervalMin":10,"activeReply":true,"timezone":"Asia/Shanghai","modelRouting":{}}
}
```

`expand` 规则：模糊输入 → 大模型扩写润色 → 仅输出 JSON，字段缺失时由模型补全。

## 4. 对话（待实现：routes/chat.js + ai/chat.js）
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/characters/:id/messages` | 发送用户消息（图/语音先上传 `/api/media`） |
| GET | `/api/characters/:id/messages?before=&limit=50` | 历史消息（解密后） |
| POST | `/api/characters/:id/active-reply` | 立即触发主动回复 |
| POST | `/api/characters/:id/wake` | 叫醒（模型判断 wakeup） |
| GET | `/api/characters/:id/context` | `{used,limit,percent,compressing}` 调试用 |

发送请求：
```json
{"kind":"text","text":"在吗","mediaId":null,"meta":{"clientTs":"..."}}
```
`kind`: `text | image | voice`；图片/语音必须带 `mediaId`（POST `/api/media` 返回）。
响应：
```json
{"accepted":true,"queued":false,"notice":null,"userMessage":{"id":"m_...","role":"user","kind":"text","content":"在吗","createdAt":""}}
```
特殊状态：
- 角色休息：`accepted:false, notice:"可可 在休息哦，要稍后再来找他/她吧 若强行叫醒的话，可能会带来不必要的麻烦哦"`
- 上下文压缩中：`accepted:true, queued:true, notice:"在回味之前的记忆喵~"`
- 硬限额：`accepted:false, notice:"Token 已达硬性限额，角色服务已暂停"`

WebSocket `ws://HOST/ws?token=<token>`，服务端推送：
```json
{"type":"ready","userId":"","at":""}
{"type":"message","message":{"id":"m_","role":"agent","kind":"text","content":"","createdAt":"","meta":{"segment":1,"segments":2,"wait":2}}}
{"type":"typing","typing":true}
{"type":"notice","content":"在回味之前的记忆喵~"}
{"type":"context","used":1234,"limit":128000,"percent":0.96,"compressing":false}
{"type":"state","state":{"motion":"","psychology":"","mood":"","health":"","sleepState":"awake"}}
{"type":"profile","content":"画像文本","changelog":"本次差异"}
{"type":"subjective","content":"…","sendsec":30}
{"type":"error","code":"","message":""}
```

### 模型回复 JSON 协议（后端解析，容错降级为纯文本）
```json
{"type":"message","content":"整段文本","agent":[{"content":"分段1","wait":2},{"content":"分段2","wait":0}],"devide":2}
{"type":"profile","content":"人物画像文本"}
{"type":"subjective","content":"主动消息","sendsec":30}
{"type":"status","motion":"","psychology":"","mood":"","health":""}
{"type":"wakeup","wakeup":1}
```
约束：`wait` 0-8 秒；仅智能体对话允许分段；`sendsec` 为静默秒数（UTC+8 语义，前后端均按相对秒处理）。

## 5. 记忆（待实现：routes/memory.js）
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/memory/graph?characterId=` | 网状图 |
| GET | `/api/memory/:id` | 记忆详情（含关联） |
| DELETE | `/api/memory/:id` | 删除记忆点 |
| GET | `/api/memory/search?characterId=&q=` | 语义检索（嵌入） |

图结构：
```json
{"nodes":[
  {"id":"agent","type":"agent","label":"可可","weight":1},
  {"id":"cat:喜好","type":"category","label":"喜好","big":true,"parent":"agent","weight":0.9},
  {"id":"cat:喜好/食物","type":"category","label":"食物","big":false,"parent":"cat:喜好","weight":0.6},
  {"id":"mem_1","type":"memory","label":"喜欢吃辣","preview":"用户无辣不欢","weight":0.73,"brightness":0.73,"big":"喜好","small":"食物","createdAt":""}
],"links":[
  {"source":"agent","target":"cat:喜好","dashed":false},
  {"source":"mem_1","target":"mem_2","dashed":true,"score":0.81}
]}
```
颜色：智能体/大类/小类/记忆点各不相同，记忆点恒为白色；亮度 = `weight`（0-1）。

## 6. 书架与日记（待实现：routes/books.js）
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/books?characterId=&type=novel\|diary\|essay\|news` | 列表（不含日记正文） |
| GET | `/api/books/:id` | 详情（日记需 `password` 查询参数或先解锁） |
| POST | `/api/books` | 手动创建创作 |
| POST | `/api/books/diary/unlock` | `{characterId, password}` → `{ok}` 并返回当日日记 |
| GET | `/api/books/diary/lock-status?characterId=` | `{locked:true, hint:"", day:""}`，`hint` 为角色暗示 |

## 7. 统计（待实现：routes/stats.js）
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/stats/usage?range=day\|3d\|7d\|30d\|year\|all\|custom&from=&to=&model=&bucket=day|hour|month` | Token 三分支/消费/模型筛选 |
| GET | `/api/stats/intimacy?characterId=&range=` | `{current,companionDays,points:[{t,v}]}` |
| GET | `/api/stats/overview?characterId=` | `{chatCount,bookCount,healthAbnormal,moodAbnormal,companionDays,intimacy}` |

`usage` 返回：
```json
{"range":"7d","from":"","to":"","totals":{"input":0,"inputHit":0,"inputMiss":0,"output":0,"total":0,"cost":0,"calls":0},
 "series":[{"key":"2026-10-01","input":0,"cached":0,"output":0,"cost":0,"calls":0}],
 "models":[{"model":"gpt-4o-mini","input":0,"cached":0,"output":0,"cost":0,"calls":0}]}
```

## 8. 管理端（待实现：routes/admin.js）
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/overview` | 用户数/在线数(10min)/活跃指数/会话数/活跃会话/存储 |
| GET | `/api/admin/users?q=&page=&size=` | 用户列表 |
| PUT | `/api/admin/users/:id` | `{role?,status?,qq?}` |
| GET | `/api/admin/usage?...` | 全量或 `userId` 筛选（复用 stats/usage） |
| GET | `/api/admin/conversations?userId=&page=` | 会话列表与详情入口 |
| GET | `/api/admin/logs?page=&action=` | 日志审计 |
| GET/PUT | `/api/admin/settings` | `{smtp:{host,port,secure,user,pass,from},onebot:{token,selfId,wsPath}}`（pass 写入后隐藏） |
| POST | `/api/admin/settings/test-mail` | `{to}` 发送测试邮件 |
| GET | `/api/admin/storage` | `{db,wal,messages,media,cache,total}` |
| GET | `/api/admin/onebot/status` | NapCat 连接状态 |

## 9. 媒体（待实现：routes/media.js）
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/media` | `multipart/form-data: file, characterId?, kind=image\|voice\|avatar` → `{id,url,mime,size,kind}` |
| GET | `/api/media/:id` | 鉴权取文件（图片/音频） |

## 10. OneBot（待实现：routes/onebot.js + onebot/*）
- 反向 WS：`/onebot/ws?access_token=<token>`（NapCat 配置上报地址）
- `POST /onebot/event`：HTTP 上报兼容
- `GET /onebot/status`：连接与账号信息
- `POST /onebot/send`：管理员手动发送 `{qq,text}`
路由规则：QQ → `users.qq` 匹配；未注册回「账号未注册，花名册上没有主人的大名哦~」；已注册但 `api_configs` 缺项回「<未配置项目名>还未设置哦，请前往 Cocoa 进行配置」；正常则走该用户默认角色的主会话。

## 11. 内部模块契约（供各开发线）
```js
// services/characters.js
listCharacters(userId, {includeArchived}) -> character[]
getCharacter(userId, id) -> character|null
createCharacter(userId, profile) -> character
updateCharacter(userId, id, patch) -> character
deleteCharacter(userId, id) -> boolean
getSettings(characterId, userId) -> settings
saveSettings(characterId, userId, patch) -> settings
updateState(characterId, patch) -> stateRow
defaultCharacterId(userId) -> string|null
ensureDiaryLock(characterId, userId) -> {day, fresh, hint}
verifyDiaryPassword(characterId, day, password) -> {ok}

// services/jobs.js
enqueue(type, dueAt, payload, {userId, characterId}) -> jobId
dueJobs(limit) -> job[]
jobPayload(job) -> object
markJob(id, status)

// ai/usage.js
recordUsage({userId, characterId, kind, model, usage, cost})
queryUsage({userId, range, from, to, model, bucket}) -> {totals, series, models}

// ai/provider.js
chatText(userId, {task, model, messages, temperature, maxTokens, thinking, json, service})
embed(userId, texts, {model}) -> {vectors, usage}
visionDescribe(userId, imageUrlOrData)
transcribe(userId, filePath, {language})
synthesize(userId, text, {voice}) -> {buffer, mime}
listModels(userId, service) / testConnection(userId, service)
resolveModel(userId, task, explicit)

// ai/chat.js（AI 线实现）
submitUserMessage({userId, characterId, content, kind, mediaId, meta, source}) -> {accepted, queued, notice, messageId}
handleOnebotIncoming({qq, text}) -> {ok, reason?, reply?}

// realtime/hub.js
broadcast(userId, event)
```

## 12. v1.0.1 增量接口

### 12.1 版本检查 `GET /api/version/latest?current=1.0.1`（公开，无需鉴权）
返回：
```json
{
  "ok": true, "current": "1.0.1", "source": "github|cache|unavailable",
  "latest": {
    "version": "1.0.2", "tag": "v1.0.2", "name": "Cocoa v1.0.2",
    "notes": "更新日志文本", "publishedAt": "2026-11-01T00:00:00Z",
    "url": "https://github.com/takwoo258-create/Cocoa/releases/tag/v1.0.2",
    "apk": {"name": "Cocoa-v1.0.2.apk", "size": 22020579,
            "directUrl": "https://github.com/.../Cocoa-v1.0.2.apk",
            "url": "https://gh-proxy.com/https://github.com/.../Cocoa-v1.0.2.apk"}
  },
  "updateAvailable": true, "proxy": "https://gh-proxy.com/", "checkedAt": "…"
}
```
缓存 10 分钟；GitHub 不可用时回退最近一次成功结果（`source:"cache"`）。

### 12.2 QQ 空间动态 `POST /api/onebot/qzone`（需登录）
```json
{"content":"今天的花开了。","images":[],"ugcRight":1}
```
→ `{ok:true, tid:"…", time:0, ugcRight:1}`；未连接 503、动作失败 502。
底层为 NapCat 扩展动作 `send_qzone_msg`（content/images/ugc_right）。

### 12.3 模型列表与上下文
`POST /api/config/models` 每个模型新增 `contextWindowSource: "remote" | "table" | "default"`；
响应新增 `attempts:[{url,status|error}]` 与 `warning`（远端失败时）。baseURL 会自动尝试 `<base>/v1/models` 与 `<base>/models`。
`GET /api/config/model-info?id=<model>` 返回 `contextWindow/contextWindowSource/override`。

### 12.4 偏好设置新增
```json
{"limits":{"enabled":true,"hardTokens":0,"softTokens":0},
 "contextLimits":{"gpt-4o-mini":128000,"default":65536}}
```
`limits.enabled=false` 时不执行硬/软限额；`contextLimits` 优先于模型内置窗口。

### 12.5 配置项收敛
`search/fetch` 复用 DeepSeek 配置，不再出现在 `/api/config` 的 `api` 服务项中（`ready.search` 字段保留兼容）。

### 12.6 WebSocket typing 事件
```json
{"type":"typing","characterId":"c_x","typing":true,"stage":"checking|waiting|replying"}
{"type":"typing","characterId":"c_x","typing":false}
```
`checking`=句子完整性判断，`waiting`=30s 等待用户补全，`replying`=模型生成中。

## 13. v1.1.0 增量

### 13.1 版本检查与更新要求
`GET /api/version/latest` 新增：
```json
{"forceUpdate": true, "forceReason": "admin|min_version|release", "minVersion": "1.1.0"}
```
- 管理端 `update.force=true` → 强制；
- `update.minVersion` 高于当前版本 → 强制；
- Release 说明包含 `[force]` / `[force-update]` / `<!-- cocoa:force -->` → 强制。
客户端收到 `forceUpdate=true` 时必须展示不可关闭的更新对话框，并禁用「忽略此版本」。

### 13.2 管理端更新配置
`GET/PUT /api/admin/settings` 新增：
```json
{"update": {"force": false, "minVersion": "1.1.0"}}
```

## 14. v1.2.0 增量

### 14.1 用户代号与昵称
`user` 对象新增 `code`（注册顺序 1..N，只读）与 `nickname`（即用户名，用于展示与角色默认称呼）。
注册返回的 user 直接带 `code`。令牌有效期 3 天；每天首次访问自动延长 1 天，最长 4 天（`auth_tokens.last_renew_at`）。

### 14.2 角色称呼与 QQ 接入
角色 settings 新增 `userAddress`（角色对用户的称呼，空则用用户昵称）与 `qqEnabled`（是否接入 QQ）。
`PUT /api/characters/:id/settings`：
```json
{"qqEnabled":true,"confirmReplace":false}
```
若已有其他角色接入 QQ 且未确认，返回 409：
```json
{"error":{"code":"qq_binding_conflict","message":"是否更换接入对象？",
 "detail":{"current":{"id":"c_old","name":"旧角色"},"next":{"id":"c_new","name":"新角色"}}}}
```
传 `confirmReplace:true` 后切换，旧角色 `qqEnabled=false`；成功后 WS 推送 `{type:'qq_binding', current, next}` 并给用户 QQ 发送提示。
`GET /api/characters/:id` 返回 `qqEnabled`；`GET /api/onebot/status` 的 `selfId` 即机器人 QQ，用于角色页展示。

### 14.3 状态刷新与叫醒
`POST /api/characters/:id/status/refresh`：立即调用模型刷新状态，冷却 5 分钟。
成功 `{state, nextAllowedAt}`；冷却中 429 `{error:{code:"status_cooldown"}, detail:{retryAfterSec, nextAllowedAt}}`。
`POST /api/characters/:id/wake`：解除睡眠并生成一次回复，返回 `{ok, state, reply?}`。

### 14.4 模型分享
分享对象用用户代号或邮箱定位。
- `POST /api/shares`：
```json
{"target":"2","direction":"share|request","services":["chat","embedding"],
 "duration":{"years":0,"months":0,"weeks":0,"days":3,"hours":0,"minutes":0},
 "expiresAt":null,"permanent":false,"note":"随便用"}
```
`duration` 与 `expiresAt` 二选一，`permanent=true` 表示永久；`expiresAt` 为 UTC+8 本地时间字符串 `YYYY-MM-DD HH:mm:ss`。
- `GET /api/shares?box=incoming|outgoing|active|history` → `{items:[share]}`
- `GET /api/shares/pending` → 待处理（客户端启动弹窗）
- `POST /api/shares/:id/respond` `{accept:true|false}`
- `POST /api/shares/:id/revoke`
`share` 对象：`{id,direction,status,owner:{id,code,nickname},target:{...},services,permanent,duration,expiresAt,note,createdAt,canRespond}`。
通知：WS `{type:'share_request',share}`、`{type:'share_result',share}`、`{type:'share_expired',share}`；同时通过 OneBot 私聊与邮件通知。
`GET /api/config` 返回 `shared:{chat:{shareId,ownerCode,ownerNickname,expiresAt,model},...}`；用户未配置的服务会自动使用有效分享。

### 14.5 统计与管理端
`GET /api/stats/overview` 新增 `calls` 与 `callsByModel:[{model,calls}]`。
`GET /api/admin/server-status` → `{cpu:{percent,cores,load},memory:{total,used,free,percent},disk:{total,used,free,percent},network:{rxBytes,txBytes,rxRate,txRate},uptime,node,time}`。
`GET /api/admin/upgrade/versions` → `[{tag,version,name,notes,publishedAt,asset}]`（GitHub Releases）。
`POST /api/admin/upgrade` `{tag}` → `{accepted, logId}`；`GET /api/admin/upgrade/status` → `{running,status,log,currentVersion}`。
`PUT /api/admin/settings` 新增 `update:{force,minVersion,autoUpgrade}`。

### 14.6 集成与测试
- `GET /api/integrations/weather?city=宣城` → 天气 JSON（缓存 10 分钟）
- `GET /api/integrations/hotboard?type=weibo` → 热榜 JSON（缓存 5 分钟）
- `POST /api/config/test-tts` `{text}` → `{ok,url,mime,bytes}`
- `POST /api/config/test-stt`（multipart `file`）→ `{ok,text,model}`
- 邮件改为品牌化 HTML 模板（验证码、分享请求、分享到期）。

### 14.7 更新策略
`GET /api/version/latest` 的 `forceUpdate` 逻辑不变；v1.2.0 发布时为需要更新的版本。仓库文档与客户端文案统一使用“需要更新/版本更新”。

## 15. v1.3.0 增量

### 15.1 多版本更新 `GET /api/version/updates?current=1.3.0`
```json
{
  "ok": true, "current": "1.3.0", "source": "github",
  "latest": {"version":"1.4.0","label":"1.4.0","tag":"v1.4.0","notes":"…","publishedAt":"…","apk":{...},"beta":false},
  "releases": [
    {"version":"1.4.0","label":"1.4.0","baseVersion":"1.4.0","beta":false,"betaNumber":0,
     "force":false,"forceReason":null,"notes":"…","apk":{"url":"https://gh-proxy.com/…","size":0},"tag":"v1.4.0"},
    {"version":"1.3.1+++Beta 1","label":"1.3.1 Beta 1","beta":true,"betaNumber":1,
     "force":true,"forceReason":"release","notes":"…","apk":{...},"tag":"v1.3.1+++Beta1"}
  ],
  "requiredVersion": "1.3.1+++Beta 1",
  "updateAvailable": true, "forceUpdate": true, "forceReason": "release",
  "minVersion": "1.3.0", "proxy": "https://gh-proxy.com/", "checkedAt": "…"
}
```
- `releases` 仅包含高于 current 的版本，按版本从高到低排序（Beta 低于同 base 正式版）。
- `requiredVersion`：最低的必须安装版本（Release 标记 / 管理端 minVersion / admin force）。
- 客户端默认选择 `latest`，可切换列表；需要更新的版本不能跳过。
- Beta 版本号支持 `1.3.1+++Beta 1` / `1.3.1-beta.1`，标签如 `1.3.1 Beta 1`。

### 15.2 统一模型配置
`GET /api/config` 新增：
```json
{
  "api": {
    "providers": [{"id":"p1","name":"我的 DeepSeek","baseUrl":"…","apiKeySet":true,"apiKey":"****","models":{"chat":"deepseek-chat"},"services":["chat"]}],
    "modelSource": "system|own",
    "systemProviderId": "sys-ds",
    "providerMeta": {"chat":{"source":"system|own|shared","providerId":"…","providerName":"…"}}
  },
  "systemModels": {"enabled": true, "providers": [{"id":"sys-ds","name":"Cocoa 统一模型","baseUrl":"…","apiKey":"****","models":{"chat":"deepseek-chat","embedding":"…"},"services":["chat","embedding"]}]}
}
```
`PUT /api/config/api` 接受：
```json
{"modelSource":"system","systemProviderId":"sys-ds",
 "providers":[{"id":"p1","name":"…","baseUrl":"…","apiKey":"sk-…|****","models":{"chat":"…","embedding":"…"}}],
 "activeProviderId":{"chat":"p1","embedding":"p1"}}
```
管理端 `GET/PUT /api/admin/settings` 新增 `systemModels:{enabled,providers:[...]}`，API Key 只返回 `****`，传 `****` 保持原值。

### 15.3 更新提示文案
客户端不使用“强制更新”“最新版本”区分版本，仅展示版本号与「最新版」标签；更新详情中 `+/-/±` 转为“新增/删除/修改”。
