# identity

用 Google userinfo 校验服务端授权码交换得到的 access token，只接受 `email_verified=true` 的邮箱。HTTP 不接受客户端直接提交 access token 登录。

`AccessPolicy` 只匹配服务器授权的 Google 邮箱，将其绑定员工工号与 `superadmin` 角色。密码账号和未匹配的 Google 账号均为 `member`；角色不授予跨账号聊天访问权限。员工映射不写入数据库，撤销服务器配置后重启两台服务即可让现有会话失去该角色。
