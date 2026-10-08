package realtime

import "context"

// InvalidateHostConfig 清除账号主电脑的短期配置公钥，使后续发布获得新的服务器世代。
//
// 参数：ctx 控制取消；accountID 为经过认证的账号编号。
// 返回值：删除错误，原键不存在视为成功。
// 注意事项：调用方须持有账号锁，与公钥发布、命令创建及角色切换互斥；不删除其他账号资料。
func (h *Hub) InvalidateHostConfig(ctx context.Context, accountID string) error {
	_, err := h.TakeTransient(ctx, "host-key:"+accountID)
	if IsTransientMissing(err) {
		return nil
	}
	return err
}
