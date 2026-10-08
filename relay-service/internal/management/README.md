# 管理后台与在线发版

本模块负责 `/agents-team/admin/api/` 的浏览器认证、只读运营统计和安装包发布。静态页面由 `internal/adminweb` 提供；原有设备登录、聊天快照和主设备调度认证保持独立。

## 权限和会话

- 公开注册产生普通邮箱账号，复用客户端 `accounts/account_credentials`，不登记虚假 Web 设备。普通账号只能查询自己的账号、设备和任务。
- 管理员通过 `RELAY_ADMIN_EMAILS`（逗号分隔）和 `RELAY_ADMIN_PASSWORD_HASH`（bcrypt）预置。这个密码独立于公开账号密码；原有客户端注册同名邮箱也不能获得管理员身份。后台禁止注册预置邮箱。首次注册永不自动提权。
- 配置多个管理员邮箱时共用这个预置密码摘要；需为每位管理员独立凭据时，应将配置扩展为邮箱到摘要的映射。
- 浏览器会话保存在共享 Redis，8 小时到期，cookie 为 HttpOnly、SameSite=Strict、HTTPS 时 Secure，Path 限于管理后台。修改管理员密码配置或移除邮箱会撤销其已有后台权限。
- 写接口验证 PublicURL 的 Origin，已登录写请求还要求 `X-CSRF-Token`。登录/注册按 TCP 来源和邮箱做 Redis 限流，Redis 不可用时禁止签发身份。代理前不信任客户端提供的 X-Forwarded-For。
- 不在浏览器 localStorage 保存口令或设备令牌。任务列表不返回聊天正文、请求 payload、结果或错误细节。

## API

以下路径均相对 `{RELAY_ROUTE_PREFIX}/admin/api`：

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/auth/register` | POST | `{email,name,password}`；普通账号注册，密码 8–72 UTF-8 字节 |
| `/auth/login` | POST | `{email,password}`；返回 `{user:{id,email,name,role},csrfToken}` 并设置 cookie |
| `/me` | GET | 当前浏览器身份与 CSRF 令牌 |
| `/auth/logout` | POST | 撤销当前 cookie 会话 |
| `/overview` | GET | 指标、日期范围趋势、设备平台分布、版本状态、`releaseUploadEnabled`；支持 `startDate`、`endDate` |
| `/accounts`、`/devices`、`/tasks` | GET | `page=1&pageSize=20&q=`；任务还支持 `status=pending/running/done/failed` |
| `/releases` | GET | `page/pageSize/platform`；管理员可见草稿与撤回，普通账号仅可见已发布 |
| `/releases/upload` | POST | 管理员 multipart：`platform,arch,version,buildNumber,notes,file`；字段顺序任意。入口负载均衡会拒绝约 60MB 以上的单次请求，页面改走下面的分段接口 |
| `/releases/uploads` | POST | 开始分段上传，JSON 含版本信息和 `size`；返回 `{id,chunkBytes,releaseStorage}` |
| `/releases/uploads/{id}?offset=` | PUT | 按顺序写入一段原始字节，单段约 16MB。重复提交已写入的一段会直接确认 |
| `/releases/uploads/{id}/finish` | POST | 收齐后校验安装包并保存草稿，返回 `{release,locations}` |
| `/releases/uploads/{id}` | DELETE | 中断上传并删除半成品，重复取消也返回 204 |
| `/releases/import` | POST | 登记已经放到安装包目录里的文件。`fileName` 只能是字母、数字、点、下划线和短横线，并以 `.dmg` 或 `.apk` 结尾 |
| `/releases/{id}/publish` | POST | 显式发布，上传本身不会公开 |
| `/releases/{id}/withdraw` | POST | 撤回，后续版本发现与下载失效 |

列表返回 `{items,total,page,pageSize}`，错误为 `{error:{code,message}}`。最大每页 100 条。运营日界线为 UTC：账号总量/今日新增、最近七日活跃账号、有效设备/一分钟内活跃设备、主电脑及在线主电脑、任务总量及状态、今日任务、终态成功率，以及可指定日期范围的趋势。成功率为 `done/(done+failed)*100`，没有终态时为 0。在线统计根据服务器设备心跳时间计算。下载量是 GET 请求次数（包括断点续传），不代表安装或升级成功数。

### 趋势日期与指标口径

`GET /overview?startDate=2026-09-01&endDate=2026-09-30` 查询 UTC 日期，包含首尾两天。不传两项时默认最近 30 个 UTC 日（含今天）；自定义时必须同时提供，最多 366 天。无效日期、重复参数、未来日期、倒置或过宽范围返回 HTTP 400 / `INVALID_DATE_RANGE`。时区始终由响应的 `timezone: "UTC"` 明确，不按浏览器当地午夜解释日期。

响应额外提供 `range: { startDate, endDate, days }`。`trend` 按日期升序包含范围内每一天，无记录时补零；每日字段为：

| 字段 | 口径 |
| --- | --- |
| `date` | UTC 创建日期，YYYY-MM-DD |
| `accountsCreated` | 当天创建且当前仍保留的账号数 |
| `devicesCreated` | 当天创建设备数，包含后来被撤销但记录仍保留的设备 |
| `total` | 当天创建且当前仍保留的任务总数 |
| `completed`、`failed` | 上述任务中当前状态为成功、失败的数量 |
| `pending`、`running` | 上述任务中当前状态为待处理、运行中的数量 |

趋势按**现存记录的创建日期**聚合。任务完成后会更新其创建日的状态分布，并不表示“当天发生的状态转换”；永久删除账号及其关联记录后，相应历史点会减少。设备仅保存最后一次心跳，因此不提供无法可靠追溯的每日活跃账号/设备曲线。

日期筛选只影响 `trend`，`metrics` 的累计、今日及当前在线口径保持不变，`platforms` 和 `releases` 也保持原口径。普通用户所有趋势只统计自己账号，管理员查看全局。SQL 采用 `created_at >= 开始日 AND created_at < 结束日次日`，涵盖结束日全部毫秒，并使用日期及账号+日期索引；默认与自定义范围都兼容 MySQL `ONLY_FULL_GROUP_BY`。

公开客户端接口：

```text
GET {prefix}/api/v1/releases/latest?platform=mac&arch=arm64&currentVersion=0.5.5&currentBuild=0
GET {prefix}/api/v1/releases/{id}/download
```

版本检查返回 `{release:null}` 或 `{release:{id,platform,arch,version,buildNumber,notes,fileName,size,sha256,downloadUrl,publishedAt}}`。`downloadUrl` 是以 `/` 开头的同源路径，客户端应使用 `new URL(downloadUrl, relayBase + '/')`。支持 mac/android；mac 架构 arm64/x64/universal，Android 当前仅允许上传 universal 安装包（客户端汇报 universal）。版本严格三段数字。Mac 仅较高语义版本可升级；Android 必须构建号增加且语义版本不降低，构建号范围 1–2100000000。相同平台、架构和构建号不可覆盖。不会向客户端推送降级。

## 多节点安装包存储

MySQL 保存版本元数据，Redis 保存会话及限流。多节点部署应让各节点访问同一持久安装包目录（例如 NFS/共享卷），并使用一致的运行 UID/GID；也可以自行配置节点间复制。安装包以随机 UUID 命名，先写同目录临时文件并 fsync，原子改名后创建数据库草稿。内存使用与安装包大小无关；默认最大 2 GiB，可通过 `RELAY_RELEASE_MAX_BYTES` 降低。DMG 校验 UDIF 尾部标记，APK 校验 ZIP 容器头；最终客户端仍需核对哈希和字节数，Android 另核对包名、签名及 versionCode。容器头检查不能替代代码签名审查。

- 共享目录必须由运维预先挂载并创建，并在共享卷内预置 `.relay-storage-id`（内容与 `RELAY_RELEASE_STORAGE_ID` 一致）。test/prod 配置发布目录时必须提供卷标识。应用不创建标识文件，每次上传、发布、下载动态核对，挂载丢失时本地空目录不能继续写入。dev 可省略标识。若采用节点间复制，`RELAY_RELEASE_PEERS` 列出其他节点源站，`RELAY_RELEASE_SELF` 用来跳过本机。
- 未配置目录、目录不可访问或卷标识不匹配：后台统计和既有客户端业务仍正常，发版关闭，启动日志明确提示；已配置的共享挂载恢复后自动恢复，无需重启。卷标识证明访问到了预期卷，仍需运维保证所有节点实际挂载同一共享目录。
- 运行中共享存储异常：上传/发布/下载返回明确错误；MySQL/Redis 就绪检查不因此把聊天业务摘流。应独立监控挂载容量、可写性和备份，安装包与元数据一同备份。
- 下载支持 HEAD/Range，使用 no-store，撤回后新的请求立即失败；已经下载或正在传输的包不会远程删除。
- 为避免代理先缓冲大文件，反向代理需为上传路径设置足够的 `client_max_body_size`、上传超时，并关闭 `proxy_request_buffering`；下载支持 Range 且不改写包内容。安装包不放进发布目录或 Git。
- 页面上传走分段接口。多节点且未使用共享目录时，可由 `RELAY_RELEASE_WRITER` 指定写入节点，让其他节点转发，避免前后两段写到不同磁盘。`RELAY_RELEASE_HOST_DIR` 和 `RELAY_RELEASE_NODES` 只用于管理页展示宿主机目录。手动上传时把同一个文件复制到每台机器的该目录，再调用导入接口；登记成功后原文件名会改成 UUID。
- 异常进程终止可能留下 `.upload-*`、`.part-*` 或未入库 UUID 文件。超过 6 小时的 `.part-*` 会在下次开始上传时删除；其余文件仅在确认无进行中的上传且对照元数据后清理。

## 配置和验收

```dotenv
RELAY_PUBLIC_URL=https://your-relay.example/agents-team
RELAY_ADMIN_EMAILS=admin@example.com
RELAY_ADMIN_PASSWORD_HASH=$2b$12$...完整bcrypt摘要...
RELAY_RELEASE_DIR=/mnt/chorus-releases
RELAY_RELEASE_STORAGE_ID=chorus-release-volume-prod
RELAY_RELEASE_MAX_BYTES=2147483648
```

通过密码管理工具生成 bcrypt 摘要并注入部署密钥配置；例如有 Apache 工具时执行 `htpasswd -nB admin` 交互输入口令，仅保留冒号后的摘要。不要把明文密码写入环境文件、命令参数、提交或日志。Shell 环境赋值须单引号保护摘要中的 `$`。不配置管理员时注册用户仍能查看自己的统计。

本地运行仍需 MySQL 和 Redis：从仓库根目录执行 `RELAY_ENV=dev RELAY_PUBLIC_URL=http://127.0.0.1:5006/agents-team go run ./cmd/server`，浏览器访问 `http://127.0.0.1:5006/agents-team/admin/`。PublicURL 必须与浏览器 origin 一致，否则写接口会拒绝。

常规测试：`go test ./...`、`go test -race ./internal/management ./internal/httpapi`。真实 MySQL 验收：`RELAY_MANAGEMENT_INTEGRATION=1 RELAY_ENV=test go test ./internal/storage -run TestManagementMySQLIntegration -count=1 -v`，测试从 `.env.test` 读取连接地址，但只创建随机 `relay_admin_test_*` 独立临时库，最终清理，不迁移或写入配置中的业务库。需要测试实例建库权限与网络连通。

## 超级管理员与用户维护

后台最高权限由服务端预置邮箱及独立密码摘要授予，`user.role` 为 `superadmin`。界面显示通用角色名，注册页面填写相同姓名、标识或伪造角色不会获得任何权限。单独配置：

```dotenv
RELAY_MANAGEMENT_SUPERADMIN_EMAIL=你的已核实邮箱
RELAY_MANAGEMENT_SUPERADMIN_PASSWORD_HASH=独立超级管理员口令的完整bcrypt摘要
```

这两个变量与普通 `RELAY_ADMIN_EMAILS/RELAY_ADMIN_PASSWORD_HASH` 相互独立，必须使用不同口令；普通管理员拥有全局统计和发版权限，但不能管理用户。仅配置超级管理员即可使用全部后台功能，无须再配置普通管理员。若只提供超级管理员摘要，邮箱可沿用已存在的 `RELAY_GOOGLE_SUPERADMIN_EMAIL`；不提供摘要时，Google 身份映射不会自动启用后台密码登录。

账号接口均位于 `{prefix}/admin/api`，要求超级管理员会话、Origin 和 `X-CSRF-Token`；已登录的其他角色明确返回 `403 SUPERADMIN_REQUIRED`：

| 路径 | 方法 | 输入与行为 |
| --- | --- | --- |
| `/accounts/{id}` | PATCH | `{name?,email?}`，至少一个字段；返回 `{account,sessionsRevoked}` |
| `/accounts/{id}/reset-password` | POST | `{password}`，8–72 UTF-8 字节；返回 `{status:"ok",sessionsRevoked:true}` |
| `/accounts/{id}` | DELETE | `{confirmEmail}`，必须匹配当前完整邮箱；返回 `{status:"ok",deletedAccountId}` |

账号列表额外提供 `protected`：预置后台管理员邮箱和受信 Google 超级管理员邮箱为受保护身份，不能通过页面修改、重置或删除，须在服务器配置中维护。Google 登录账号允许修改显示姓名，邮箱和密码由 Google 管理，不能在后台转换为邮箱密码身份。接口不接受 `role/provider/employeeId` 等授权字段。

仅修改姓名不影响正常登录会话。修改邮箱或重置密码在同一账号事务内撤销全部设备、一次性邀请和执行租约，保留聊天及任务历史；旧设备和浏览器必须重新登录。普通浏览器会话每次请求核对数据库账号ID、邮箱及密码摘要与持久认证版本组合的指纹，指纹仅存 Redis，不在接口或日志返回。设备签发在同一账号锁内核对认证时邮箱、凭据摘要与 `account_credentials.auth_version`。改邮箱或重置口令在同一事务内递增版本，改名不递增；邮箱 A→B→A 不能复活旧 cookie 或旧登录快照。创建任务、切换主电脑与撤销设备亦在账号事务内复核请求者的当前令牌，因此已经通过 HTTP 认证但晚到的旧请求不能修改重新登录后的新会话。

删除账号按外键依赖顺序原子删除租约、任务、邀请、聊天快照、设备、口令和账号，失败整体回滚，不影响其他用户和公共发布包。删除不可恢复；重新注册同一邮箱会得到全新账号，旧会话不能复活。WebSocket 在每次收发及15秒心跳重验数据库状态，账号变更另发布跨节点撤销通知以加速旧连接退出。

账号变更的真实数据库验收：`RELAY_MANAGEMENT_INTEGRATION=1 RELAY_ENV=test go test ./internal/storage -run TestAccountManagementMySQLIntegration -count=1 -v`。该测试只创建并清理随机 `relay_accounts_test_*` 数据库，覆盖编辑回滚、密码重置、旧凭据签发拒绝、外键关联删除以及其他用户数据完整性。
