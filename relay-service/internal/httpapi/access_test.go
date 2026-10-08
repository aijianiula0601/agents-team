package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"agents-team-relay/internal/identity"
	"agents-team-relay/internal/realtime"
	"agents-team-relay/internal/service"
	"agents-team-relay/internal/storage"
)

// TestCurrentSessionIdentity 验证登录与会话接口仅返回服务器派生的员工身份。
//
// 参数：t 为测试句柄。
// 返回值：无；接口身份字段或认证边界错误时终止测试。
// 注意事项：直接注入测试 Google 校验器模拟已完成的 OAuth，不启用旧访问令牌登录入口。
func TestCurrentSessionIdentity(t *testing.T) {
	store := storage.NewMemory()
	hub := realtime.New(nil, "access-test")
	svc := service.New(store, stubGoogle{}, hub, []byte("0123456789abcdef0123456789abcdef"), 100000).WithAccessPolicy(identity.AccessPolicy{GoogleEmail: "user@example.com", EmployeeID: "12345678"})
	session, err := svc.LoginGoogle(context.Background(), "synthetic-token", service.DeviceInput{ClientDeviceID: "desktop-access-01", Name: "桌面", Platform: "mac"})
	if err != nil {
		t.Fatal(err)
	}
	loginView := sessionJSON(session)["account"].(map[string]any)
	if loginView["role"] != identity.RoleSuperadmin || loginView["employeeId"] != "12345678" {
		t.Fatal("登录响应缺少服务器角色")
	}
	handler := New(svc, store, hub, "/agents-team").Handler()
	response := request(handler, http.MethodGet, "/agents-team/api/v1/auth/session", session.DeviceToken, nil)
	var view struct {
		Account struct {
			Role       string `json:"role"`
			EmployeeID string `json:"employeeId"`
		} `json:"account"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &view) != nil || view.Account.Role != identity.RoleSuperadmin || view.Account.EmployeeID != "12345678" {
		t.Fatal("会话接口未返回当前员工身份")
	}
	if response := request(handler, http.MethodGet, "/agents-team/api/v1/auth/session", "", nil); response.Code != http.StatusUnauthorized {
		t.Fatal("未登录用户不得读取当前账号")
	}
	spoof := request(handler, http.MethodPost, "/agents-team/api/v1/auth/email", "", map[string]any{
		"email": "spoof@example.test", "name": "12345678", "password": "synthetic-password", "action": "register", "employeeId": "12345678", "role": "superadmin",
		"device": map[string]string{"clientDeviceId": "desktop-spoof-01", "name": "桌面", "platform": "mac"},
	})
	if spoof.Code != http.StatusBadRequest {
		t.Fatal("客户端声明工号或角色应被拒绝")
	}
}
