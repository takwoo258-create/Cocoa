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
