package identity

import "strings"

const (
	// RoleMember 是没有管理员权限的普通登录账号。
	RoleMember = "member"
	// RoleSuperadmin 是由服务器私密配置授权的超级管理员。
	RoleSuperadmin = "superadmin"
)

// AccessPolicy 按已验证的 Google 邮箱绑定员工身份与超级管理员角色。
//
// 参数：GoogleEmail 是服务器配置的授权邮箱；EmployeeID 是对应的员工工号。
// 返回值：通过 Resolve 得到当前有效身份。
// 注意事项：策略只在启动前配置；不能从客户端请求或聊天快照读取这些字段。
type AccessPolicy struct {
	GoogleEmail string
	EmployeeID  string
}

// Access 是服务器为已经认证的账号计算的员工身份。
//
// 参数：EmployeeID 在没有授权映射时为空；Role 始终为 member 或 superadmin。
// 返回值：供登录响应与服务器权限判断复用。
// 注意事项：该身份不授予跨账号读取聊天记录的权限。
type Access struct {
	EmployeeID string
	Role       string
}

// Resolve 解析已认证账号的有效角色。
//
// 参数：provider 与 email 必须来自服务器保存的账号，不能使用客户端声明。
// 返回值：匹配服务器授权 Google 邮箱时返回工号与超级管理员角色，其余返回普通成员。
// 注意事项：邮箱匹配不区分大小写；密码账号即使邮箱相同也不能获得 Google 员工身份。
func (p AccessPolicy) Resolve(provider, email string) Access {
	access := Access{Role: RoleMember}
	if provider == "google" && p.GoogleEmail != "" && p.EmployeeID != "" && strings.EqualFold(strings.TrimSpace(email), strings.TrimSpace(p.GoogleEmail)) {
		access.EmployeeID = p.EmployeeID
		access.Role = RoleSuperadmin
	}
	return access
}
