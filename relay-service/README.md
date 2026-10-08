# Chorus 聊天中转服务

电脑和手机连接用户自建的中转站。聊天快照、设备和执行任务按登录账号隔离，电脑通过出站 WebSocket 接收通知并领取任务，手机同步聊天和电脑配置、下发用户消息，实际 Agent 执行只发生在电脑主设备上。

## 自建部署

本目录包含 Go 服务、管理页面和 MySQL/Redis 存储。部署时为测试或生产环境分别准备私密配置，并设置 `RELAY_PUBLIC_URL` 为实际对外访问地址，例如 `https://your-relay.example/agents-team`。Mac 和 Android 客户端须配置同一个中转站地址；在线更新的可信源还需分别在原生构建配置中指定。

公网部署应通过 HTTPS 反向代理提供服务，配置自己的 MySQL、Redis 和持久化安装包目录。不要将环境文件、数据库备份或安装包提交到仓库。

## 运行要求

服务需要 Go 1.22+、MySQL 和 Redis。建议为本服务使用独立数据库与 Redis 前缀。健康检查包括 `/health`、`/agents-team/health` 和 `/agents-team/ready`；路径前缀可通过 `RELAY_ROUTE_PREFIX` 调整。


## 本地运行和检查

在本目录把 `.env.dev.example` 复制为被 Git 忽略的 `.env.dev`，再填写本机配置。进程环境变量会覆盖 `.env.<RELAY_ENV>`；密码、令牌密钥与 OAuth client secret 不得写入源码、提交记录或日志。

```bash
cd relay-service
cp .env.dev.example .env.dev
go test ./...
go test -race ./...
go vet ./...
go run ./cmd/server
```

`.env.test.example` 和 `.env.prod.example` 只是字段模板，尖括号占位符不能直接运行。复制后设置实际 `RELAY_PUBLIC_URL`、随机令牌密钥和独立的存储凭据。私密文件应限制访问权限，也可通过部署平台安全注入环境变量。

测试包含密码认证与登录方式隔离、手机权限、并发领取、租约过期与幂等、团队/私聊消息路由、完整历史保留、Google 浏览器授权与一次性 state、WebSocket 票据与账号隔离，以及两个 Hub 通过 Redis 收发事件。

## 登录

`POST /agents-team/api/v1/auth/email` 提交 `{action:"register"|"login",email,password,name,device}`。密码需为 8 到 72 字节，服务仅存 bcrypt 摘要；登录后返回 `{deviceToken,account,device,revision}`。仅凭邮箱不再允许登录，已存在账号不能通过注册请求重设密码，不同登录方式的同邮箱账号也不能自动关联。

`device` 包含 `clientDeviceId`、`name`、`platform`，平台可以是 `mac`、`windows`、`linux`、`android` 或 `web`。只有前三种电脑平台可成为主设备，手机先登录也不会成为执行设备。

Google 登录通过系统浏览器完成：

1. `POST /agents-team/api/v1/auth/google/start {device}` 返回 `authId`、`pollToken`、`authorizationUrl`、`expiresIn`；客户端在浏览器打开正式 Google 授权地址。
2. 服务以随机一次性 state、PKCE 和服务端 client secret 完成 authorization code 交换，校验 Google 返回的已验证邮箱，设备信息不会通过浏览器传回客户端。
3. 客户端 `POST /agents-team/api/v1/auth/google/poll {authId,pollToken}`。状态为 `pending`、`done` 或 `failed`，`done` 含完整 `session`。

旧 `/agents-team/api/v1/auth/google` 访问令牌直登接口已关闭，要求使用浏览器授权。缺少 Google 配置时明确返回 `503 GOOGLE_NOT_CONFIGURED`，不会伪造 Google 身份。

Google Web OAuth 必须配置授权回调 URI：

```text
https://your-relay.example/agents-team/api/v1/auth/google/callback
```

在服务端安全配置 `RELAY_GOOGLE_CLIENT_ID`、`RELAY_GOOGLE_CLIENT_SECRET` 与实际 `RELAY_PUBLIC_URL`；Google 控制台的回调 URI 必须与上述公开地址匹配。不要将密钥提交到 Git、复制到镜像或输出到日志。

`GET /agents-team/api/v1/config` 公开返回 `googleConfigured`、`passwordLoginEnabled`、`websocketEnabled` 和 `protocolVersion`，不返回 client secret。`POST /agents-team/api/v1/auth/logout` 撤销当前设备令牌。

可选的超级管理员映射通过服务器私密配置 `RELAY_GOOGLE_SUPERADMIN_EMAIL` 与 `RELAY_SUPERADMIN_EMPLOYEE_ID` 绑定；多节点部署需保持配置一致。只有 Google 验证通过且邮箱匹配的账号获得 `superadmin` 角色与对应标识。客户端提交标识、角色或修改缓存不会授予权限，密码账号也不会沿用 Google 身份授权。

`GET /agents-team/api/v1/auth/session` 使用当前设备 Bearer 令牌返回服务器有效的账号与设备视图；登录响应的 `account` 同样包含 `employeeId`、`role`。每次认证重新计算角色，撤销配置并重新部署后，旧会话也失去管理员权限。员工身份不改变各账号聊天记录的隔离规则。

旧版无密码邮箱账号保留记录和已有会话，但不能再通过匿名邮箱重新登录；账号迁移需要先核验所有权，不能由新注册请求直接接管。

## 同步和任务

所有登录后的 HTTP 请求携带 `Authorization: Bearer <deviceToken>`。

| 接口（均在 `/agents-team/api/v1` 下） | 行为 |
|---|---|
| `GET /state` | 读取 `{revision,state}`，用于启动、重连和事件后的补拉 |
| `PUT /state {baseRevision,state}` | 仅电脑主设备保存配置/历史；冲突返回 `409` 和服务器当前快照，客户端合并后重试 |
| `GET /devices` | 列出同账号设备和跨节点在线状态 |
| `POST /devices/{id}/primary` | 在电脑上切换到另一台电脑主设备 |
| `POST /dispatches` | 按 `clientRequestId` 幂等创建任务并原子保存用户消息 |
| `GET /dispatches` | 列出本账号尚未完成任务，仅用于查看，不能代替领取 |
| `POST /dispatches/claim {}` | 仅电脑主设备原子领取，返回 `dispatch:null` 或含 `claimToken/leaseExpiresAt` 的任务 |
| `POST /dispatches/{id}/result` | 带 `claimToken` 回写 `running`、`done` 或 `failed` |
| `GET /dispatches/{id}` | 按账号查看单个任务，包含已经完成的状态 |
| `POST /realtime/ticket` | 签发 60 秒一次性 WebSocket 连接票据 |

任务正文为 `{clientRequestId,mode,roomId?,agentId?,userText,userMessage?,attachments?,context?,responders:[{agentId,message?}]}`。团队使用 `roomId`，私聊使用 `agentId`，二者不能同时设置；提供 `userMessage` 时其 `id` 必须等于 `clientRequestId`。附件和会话上下文完整转交给电脑，服务不执行 Agent。`userText` 展开附件后最多 1000000 字符，一轮最多 200 个回复 Agent，与客户端团队成员上限一致。旧 `responders[].message` 请求保持可解析。

领取租约为 90 秒，长任务每 20 秒提交 `running` 延长租约；过期、错误或其他设备的领取令牌不能写结果。`done` 的 `replies:[{agentId,message}]` 原子追加到原团队或私聊，重复完成不会重复写消息。任务租约和聊天版本基于 MySQL 账号行锁，跨节点使用同一持久化队列。电脑应按请求号保存执行状态，领取机制提供有限期所有权；进程在执行之后、结果保存之前崩溃时，重新领取需要客户端结合持久化执行记录避免重复副作用。

聊天消息不会按最近 200 条截断。单条文本上限为 200000 字符，总快照上限由 `RELAY_STATE_LIMIT_BYTES` 配置，最大 32000000 字节；超限明确失败，不静默删除历史。配置中的模型密钥和设备令牌会被移除。

## 实时通道

先用 Bearer 获取票据，然后连接 `/agents-team/ws?ticket=<ticket>`，也兼容 `/agents-team/ws/device?ticket=<ticket>`。服务端加密保存短期票据内容，原子消费票据；URL 不能携带长期 `access_token`。

连接收到 `hello`，更新事件沿用 `state.updated`、`devices.updated`、`dispatch.created`、`dispatch.updated`，携带当前版本或任务。Redis Pub/Sub 将事件广播到其他节点，同账号设备共享通知，其他账号收不到事件。通知不代替持久化记录，客户端在通知、启动和断线重连后通过 HTTP 补拉快照和任务。设备令牌被撤销或更换后，现有连接在下一次心跳检查时断开。

## 账号管理与客户端版本发布

管理页面地址为 `{RELAY_PUBLIC_URL}/admin/`。页面源码位于 `internal/adminweb`，随中转站服务编译和部署，左侧分为运行总览、账号与设备、任务统计、版本发布。总览提供任务状态与账号/设备增长折线图，右上角日历支持自选日期及 7/30/90 天快捷范围。

普通邮箱用户注册后仅查看本人数据，普通管理员可查看全局统计并上传 DMG/APK 草稿、发布或撤回版本。超级管理员通过服务端私密配置授权，只有该身份可编辑用户、重置密码和删除用户；改邮箱或重置密码会撤销该账号的既有会话。

管理员预置凭据、共享安装包挂载、代理上传限制、接口契约及验证方式见 [管理模块说明](internal/management/README.md)。未配置共享安装包目录时后台和原有中转站业务仍可用，上传发布功能关闭。
