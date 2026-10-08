package service

import (
	"context"
	"strconv"

	"agents-team-relay/internal/identity"
	"agents-team-relay/internal/logx"
	"agents-team-relay/internal/storage"
)

// WithAccessPolicy 注入服务器员工身份授权策略。
//
// 参数：policy 必须来自已经校验的服务器私密配置。
// 返回值：当前服务，便于启动代码组合依赖。
// 注意事项：仅在开始监听或启动并发业务前调用；不提供客户端修改策略的入口。
func (s *Service) WithAccessPolicy(policy identity.AccessPolicy) *Service {
	s.accessPolicy = policy
	logx.Infof("------------- 加载员工身份策略 --------------")
	logx.Infof("Google 超级管理员映射已加载 enabled=" + strconv.FormatBool(policy.GoogleEmail != "" && policy.EmployeeID != ""))
	return s
}

// accountIdentity 为数据库账号补充当前有效的服务器身份。
//
// 参数：account 为存储层读取或 OAuth 成功后保存的账号。
// 返回值：账号副本，包含 EmployeeID 与 Role。
// 注意事项：始终覆盖已有角色字段，防止旧缓存或其他代码的预设身份影响权限判断。
func (s *Service) accountIdentity(account storage.Account) storage.Account {
	access := s.accessPolicy.Resolve(account.Provider, account.Email)
	account.EmployeeID, account.Role = access.EmployeeID, access.Role
	return account
}

// RequireSuperadmin 验证设备会话并要求服务器授权的超级管理员身份。
//
// 参数：ctx 控制取消；rawToken 为当前请求的设备令牌。
// 返回值：当前设备与账号；身份无效返回 401，普通成员返回 403。
// 注意事项：用于管理功能的服务器授权；调用方不能通过客户端 role 或 employeeId 替代本校验。
func (s *Service) RequireSuperadmin(ctx context.Context, rawToken string) (storage.Device, storage.Account, error) {
	device, account, err := s.Authenticate(ctx, rawToken)
	if err != nil {
		return storage.Device{}, storage.Account{}, err
	}
	if account.Role != identity.RoleSuperadmin {
		logx.Warnf("超级管理员权限校验失败 account=" + account.ID)
		return storage.Device{}, storage.Account{}, fail(403, "SUPERADMIN_REQUIRED", "此操作需要超级管理员权限")
	}
	return device, account, nil
}
