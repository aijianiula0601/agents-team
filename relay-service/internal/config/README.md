# config

读取 `RELAY_ENV` 对应的 `.env.dev`、`.env.test` 或 `.env.prod`。进程已有的环境变量优先于文件。密码只进入连接配置，不进入日志。

服务器私密环境文件可同时设置 `RELAY_GOOGLE_SUPERADMIN_EMAIL` 和 `RELAY_SUPERADMIN_EMPLOYEE_ID`，将已通过 Google 验证的单个邮箱绑定为超级管理员。两项同时为空时关闭映射；只填一项、邮箱格式错误或标识含非数字时拒绝启动。授权邮箱不会写入公开配置响应或日志。

管理后台使用 `RELAY_ADMIN_EMAILS` 和 `RELAY_ADMIN_PASSWORD_HASH`（必须成对配置，预置管理员口令使用 bcrypt 摘要）。`RELAY_RELEASE_DIR` 指向自建安装包目录；test/prod 配置目录时必须配置 `RELAY_RELEASE_STORAGE_ID`，并由卷内同值的 `.relay-storage-id` 证明目录身份，应用每次访问动态核对；`RELAY_RELEASE_MAX_BYTES` 默认 2 GiB。后台会话来源校验使用 `RELAY_PUBLIC_URL`，本地访问必须覆盖成实际 HTTP 地址。详细接口、统计口径、代理配置及多节点要求见 `../management/README.md`。

后台超级管理员使用独立的 `RELAY_MANAGEMENT_SUPERADMIN_EMAIL` 与 `RELAY_MANAGEMENT_SUPERADMIN_PASSWORD_HASH`。服务器按预置邮箱和独立密码摘要授权，界面显示通用角色名；仅在独立摘要已配置时，邮箱允许回退到既有 `RELAY_GOOGLE_SUPERADMIN_EMAIL`。后台不复用普通管理员摘要，也不按注册姓名授权。
