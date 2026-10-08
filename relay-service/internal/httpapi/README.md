# httpapi

对外 HTTP 和 WebSocket。设备用登录时拿到的令牌访问自己的账号。聊天快照按版本保存，非主设备创建的执行任务由主设备领取并回写。

登录成功返回的 `account` 包含服务器派生的 `employeeId` 和 `role`（`member` / `superadmin`）。`GET /agents-team/api/v1/auth/session` 使用 Bearer 设备令牌返回当前有效账号与设备，不再次返回设备令牌。员工工号和角色不是登录请求参数，客户端提交这些字段会被拒绝。

退出接口只撤销认证时的令牌版本；重新登录后迟到的旧退出请求不会影响新会话。WebSocket 在每轮收发前重新验证设备令牌版本，退出或令牌轮换后关闭旧连接，不能继续发送任务确认或接收账号事件。

## 配置与设备管理接口

所有下列配置端点均接受同账号任意有效设备的 Bearer 令牌，成功返回 `{ revision, state }`；旧版本返回 `409 REVISION_CONFLICT` 及当前完整快照。`baseRevision` 来自最近一次拉取或成功修改响应。

- `POST /api/v1/agents`：`{ "baseRevision": 12, "id": "a-客户端稳定编号", "config": { "name": "工程师", "backend": "cursor", "workspaceMode": "auto", "workspace": "" } }`。新建时由服务端初始化空消息；无需主电脑已上线或账号已上传初始快照。
- `PATCH /api/v1/agents/{id}`：`{ "baseRevision": 12, "config": { "name": "工程师", "harnessModel": "模型 ID", "workspaceMode": "auto" } }`，保留既有补丁合同。
- `DELETE /api/v1/agents/{id}`：`{ "baseRevision": 12 }`，至少保留一个 Agent；清理所有群引用，空群回填剩余首位成员。
- `POST /api/v1/rooms`：`{ "baseRevision": 12, "id": "r-客户端稳定编号", "config": { "name": "研发群", "agentIds": ["a1"], "rule": "free", "workspace": "/主电脑/项目" } }`。至少一位有效成员，缺省规则为 `free`、工作目录为空字符串。
- `PATCH /api/v1/rooms/{id}`：`{ "baseRevision": 12, "config": { "name": "新群名", "agentIds": ["a1", "a2"], "rule": "mention", "workspace": "/主电脑/项目" } }`，允许只提交需修改字段。
- `DELETE /api/v1/rooms/{id}`：`{ "baseRevision": 12 }`，删除目标群，其他群与私聊不变。
- `PATCH /api/v1/settings`：`{ "baseRevision": 12, "config": { "localExecution": true, "defaultProvider": "openai" } }`，两个字段可分别修改，服务商可取 `openai/anthropic/local/custom`。
- `PUT /api/v1/state`：仅主电脑可写；`state.configRevision` 必须匹配当前版本。`configRevision>0` 时共享实体集合和已存在的配置字段须保持一致；允许主电脑写聊天、执行状态、模型目录和派生的自动工作区路径。初始旧快照兼容缺省版本 0。
- `POST /api/v1/devices/{id}/primary`：目标电脑必须有有效在线标记，离线时返回 `409 DEVICE_OFFLINE` 和「离线不可设置」。
- `DELETE /api/v1/devices/{id}`：撤销同账号设备会话，既有 WebSocket 随账号变更事件关闭。删除主电脑后无主设备，不能自动提升离线电脑；账号历史保留。

每次配置变更会递增 `configRevision` 并广播 `state.updated`。创建请求应在同一次表单中保持稳定 `id`；同编号同内容重试幂等返回当前状态，异内容返回 `409 CONFIG_EXISTS`。数量上限为 200 个 Agent 和 200 个群；群成员最多 200 位且不得重复或引用不存在的 Agent。删除或调整成员涉及未完成任务（包括主电脑本机运行）时返回 `409 CONFIG_IN_USE`，需停止或等待完成。

Agent 配置补丁允许 `name/initial/label/role/persona/provider/model/backend/harness/harnessModel/workspaceMode/workspace/endpoint/temperature`，不接受 `id/messages/notify`、凭据或顶层模型目录。`harnessModels` 仍由主电脑的完整快照发布，其他设备只读。

管理后台入口为 `{prefix}/admin/`，通过 `WithManagement` 显式挂载后台 API 与公开版本检查/下载。管理会话使用独立 HttpOnly cookie，不接受设备 bearer token 获取后台管理权限；业务路由和现有 OAuth 流程保持不变。具体端点见 `../management/README.md`。

## 主电脑短期配置通道

`host_commands.go` 提供同账号远程配置，独立于聊天快照与聊天 dispatch。`GET/PUT/DELETE /api/v1/host-config/key` 读取、发布或清理主电脑公钥；发布仅限当前主电脑，公钥 90 秒失效并绑定该设备的当前登录版本。`POST /api/v1/host-config/commands` 创建操作，`GET` 同路径由主电脑独占领取，`GET /commands/{id}` 仅由发起设备读取结果，`PUT /commands/{id}` 由当前主电脑携领取令牌回写。主设备变更、注销、公钥更新或请求过期均拒绝旧操作。

命令在现有 Redis transient 命名空间保存最多三分钟，结果回写不延长有效期；不会写入 MySQL 业务表或聊天消息。各节点使用相同账号行锁对队列及领取操作串行化，与主设备切换共享锁。每账号最多 32 条待领取命令，并限制每分钟 60 次创建。广播只发 `host-config.updated` 提示，不包含请求正文、密钥或结果。公开结果按操作白名单重建，移除未知字段和领取认证摘要。`model.save` 只接受 RSA-OAEP-256/A256GCM 信封；中转站既不接收模型明文密钥，也无法解密。

动作白名单：`settings.get`、`model.get`、`model.save`、`harness.get`、`harness.save`、`harness.probe`、`harness.models`、`workspace.normalize`。路径在主电脑实际校验，服务端不访问客户端文件系统。运行 `go test ./internal/httpapi -run TestHostCommand` 验证跨节点独占领取、来源和主角色隔离、密钥/结果脱敏、换主和 TTL。

配置命令与队列使用 Redis MULTI/EXEC 原子写入；请求编号绑定规范化动作与正文摘要，异内容重复编号返回冲突。45 秒领取租约到期后可重新交付同一编号，原生端按编号缓存结果，恢复丢失回执时不会重复保存。公钥另带服务端 generation，命令必须携带并持续匹配；切换主设备在账号锁内删除旧公钥，快速 A→B→A 后即使重用原生公钥也不能恢复旧命令。公钥续期保持 generation，失效或重新建立连接则生成新值。
