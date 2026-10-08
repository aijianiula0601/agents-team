package service

import "context"

// invalidateHostConfig 在主电脑角色变更前废弃旧配置公钥及其服务器世代。
//
// 参数：ctx 控制缓存请求取消；accountID 来自已认证账号。
// 返回值：配置通道清理错误；缓存不可用时阻止换主，避免旧命令重新生效。
// 注意事项：由存储层在账号锁内调用，不能重入 Store；没有配置通道的测试发布器保持兼容。
func (s *Service) invalidateHostConfig(ctx context.Context, accountID string) error {
	invalidator, ok := s.publisher.(interface {
		InvalidateHostConfig(context.Context, string) error
	})
	if !ok {
		return nil
	}
	return invalidator.InvalidateHostConfig(ctx, accountID)
}
