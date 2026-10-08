# internal

本目录保存中转站内部实现，只供当前 Go module 使用：

- `adminweb/`：管理后台静态页面与入口；
- `auth/`、`identity/`：令牌、密封数据和可信身份；
- `config/`：运行配置加载与校验；
- `httpapi/`：HTTP、OAuth 与 WebSocket 路由；
- `management/`：统计、账号管理和客户端版本发布；
- `realtime/`：节点内及跨节点实时通知；
- `service/`：账号、团队、配置和任务领域逻辑；
- `storage/`：内存与 MySQL 持久化实现；
- `logx/`：统一日志入口。

各子目录的详细职责、接口边界和注意事项见其自身 `README.md`。
