package storage

import "context"

// SetPrimaryForSessionWithHook 在内存账号锁内验证会话、清理旧通道并切换主电脑。
//
// 参数：requester 是认证时的设备快照；deviceID 是目标；beforeChange 可为 nil。
// 返回值：身份、目标或回调错误；回调失败不修改设备角色。
// 注意事项：已是目标主电脑时幂等返回，回调不得重入存储层。
func (m *Memory) SetPrimaryForSessionWithHook(ctx context.Context, requester Device, deviceID string, beforeChange func() error) error {
	return m.setPrimary(ctx, requester.AccountID, deviceID, &requester, beforeChange)
}

// SetPrimaryForSessionWithHook 在 MySQL 账号事务内验证会话、清理旧通道并切换主电脑。
//
// 参数：requester 是认证快照；deviceID 是目标；beforeChange 在写设备角色前调用。
// 返回值：身份、目标、回调或 SQL 错误；回调失败回滚数据库事务。
// 注意事项：外部通道失效不能回滚，后续数据库失败只需原主电脑重新发布公钥，不会恢复旧世代。
func (s *MySQL) SetPrimaryForSessionWithHook(ctx context.Context, requester Device, deviceID string, beforeChange func() error) error {
	return s.setPrimary(ctx, requester.AccountID, deviceID, &requester, beforeChange)
}
