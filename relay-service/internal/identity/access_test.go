package identity

import "testing"

// TestAccessPolicyResolve 验证员工身份只由服务器 Google 邮箱白名单决定。
//
// 参数：t 为测试句柄。
// 返回值：无；策略行为错误时终止测试。
// 注意事项：测试邮箱为虚构数据，不使用真实个人账号或凭据。
func TestAccessPolicyResolve(t *testing.T) {
	policy := AccessPolicy{GoogleEmail: "admin@example.test", EmployeeID: "12345678"}
	for _, item := range []struct {
		provider string
		email    string
		role     string
		employee string
	}{
		{"google", "admin@example.test", RoleSuperadmin, "12345678"},
		{"google", "  ADMIN@EXAMPLE.TEST  ", RoleSuperadmin, "12345678"},
		{"google", "other@example.test", RoleMember, ""},
		{"email", "admin@example.test", RoleMember, ""},
		{"", "admin@example.test", RoleMember, ""},
	} {
		got := policy.Resolve(item.provider, item.email)
		if got.Role != item.role || got.EmployeeID != item.employee {
			t.Fatalf("身份映射错误 provider=%s role=%s", item.provider, got.Role)
		}
	}
	for _, empty := range []AccessPolicy{{}, {GoogleEmail: "admin@example.test"}, {EmployeeID: "12345678"}} {
		if got := empty.Resolve("google", "admin@example.test"); got.Role != RoleMember || got.EmployeeID != "" {
			t.Fatal("不完整或撤销的配置不得授予管理员角色")
		}
	}
}
