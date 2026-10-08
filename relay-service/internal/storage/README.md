# storage

按登录账号保存设备、聊天快照和待主设备执行的任务。生产使用 MySQL，测试使用内存实现。聊天快照和任务修改都在账号行锁里完成。

`Account.EmployeeID` 与 `Account.Role` 是业务层认证后的派生字段，不加入 MySQL 表，不改变既有账号、设备或聊天数据。每次认证以当前服务器授权配置重新计算角色，存储返回的旧角色值不能用作权限判断。

会话退出使用 `RevokeSession` 在账号事务中匹配认证时的令牌摘要，旧退出请求不会撤销重新登录后的设备或转移主设备；未匹配与重复退出按幂等处理。设备管理使用 `RevokeDevice`，继续撤销该账号下指定设备的当前会话。

设备撤销后清除它的主设备身份，不自动提升其他设备，避免离线电脑接管执行。账号聊天快照和待处理任务保留，新主电脑由用户显式选择；正在执行的任务保留有限期租约，原令牌不能续租。

管理后台通过独立 `ManagementStore` 接口做按账号隔离的聚合和分页，不在原有设备存储接口里添加后台权限逻辑。`app_releases` 表保存版本元数据、发布状态和下载请求计数；安装包字节存放于共享挂载，平台+架构+构建号具有数据库唯一约束。真实SQL测试 `TestManagementMySQLIntegration` 只使用随机临时库，与既有业务数据隔离。

趋势查询接收 UTC 首尾日期，最多 366 天，返回按日补零的账号创建、设备创建及任务当前状态分布。日期过滤使用闭开范围保护结束日的全部毫秒；设备增长保留已撤销记录，永久删除的数据不再参与历史统计。累计指标保留原有口径，不能把创建趋势解释为历史活跃数据。

迁移为 `accounts`、`devices`、`dispatches` 增加 `created_at` 索引，并为后两者增加 `(account_id, created_at)` 复合索引。每次先查询 `information_schema.STATISTICS` 核对索引列顺序，已存在时不重复 DDL；多节点同时创建出现 MySQL 1061 时重新核对结构，不吞掉其他迁移错误。缺失索引显式使用 `ALGORITHM=INPLACE, LOCK=NONE`，独立连接的元数据锁最多等待两秒，归还连接池前恢复会话设置，恢复失败则丢弃连接。长事务阻挡迁移时新节点启动失败，释放事务后可重试，避免长时间阻塞旧节点登录。真实集成测试覆盖幂等/并发索引迁移、真实事务持锁超时与连接参数恢复、严格分组模式、首尾毫秒、空日期、账号隔离和单日查询。

`AccountManager` 在账号行锁内更新资料、重置口令或删除整套用户数据。改邮箱/重置同时撤销设备、邀请码、执行租约；删除按外键顺序清理，并与其他账号隔离。设备签发新增 `UpsertAuthenticatedDevice`，在相同账号锁内检查之前认证的邮箱、密码摘要及持久 `auth_version`，阻止并发密码重置和邮箱 A→B→A 之后旧认证结果重新建立设备会话。`accounts_test.go` 与真实临时库 `accounts_integration_test.go` 复用同一组行为断言。

`account_credentials.auth_version` 通过在线DDL增量迁移（默认0），独立连接短元数据锁等待，双节点重复列1060需复核定义才忽略。设备管理调用 `SetPrimaryForSession/RevokeDeviceForSession`，在账号锁内验证请求者TokenHash；可信内部存储方法保留用于无HTTP会话的受信业务及测试。

配置删除保护使用事务内 `ConfigInUse`：按账号与 pending/running 状态查询 `EXISTS`，群引用匹配 `room_id`，私聊兼容 `payload.agentId` 和历史 `responders[].agentId`。不复用只返回前 100 条的任务领取列表，避免长队列尾部的在途任务失去会话；不新增表或迁移。`TestConfigUsageMySQLIntegration` 可通过 `RELAY_CONFIG_INTEGRATION=1 RELAY_ENV=test` 启用，仅创建当前连接的临时 `dispatches` 表验证真实 JSON SQL，显式 `DROP TEMPORARY` 清理，不修改业务表。

`SetPrimaryForSessionWithHook` 先在账号锁内复核请求者及目标，只有真实角色变更才执行 `beforeChange`，之后提交唯一主设备。回调失败保持原角色；回调不得重入 Store。Memory 和 MySQL 使用相同顺序，保证与配置公钥发布/命令操作互斥；旧的无回调接口继续供可信内部流程和已有测试使用。
