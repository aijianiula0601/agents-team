package management

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"agents-team-relay/internal/realtime"
	"agents-team-relay/internal/service"
	"agents-team-relay/internal/storage"
	"golang.org/x/crypto/bcrypt"
)

// setupSuperadmin 为账号管理测试配置独立超级管理员口令。参数：t为测试句柄；返回值：HTTP处理器、内存存储和业务服务；注意事项：测试身份固定，不使用真实人员邮箱和密码。
func setupSuperadmin(t *testing.T) (http.Handler, *testStore, *service.Service) {
	t.Helper()
	_, store, cfg := setupAdmin(t)
	hash, err := bcrypt.GenerateFromPassword([]byte("super-secret"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	cfg.SuperadminEmail = "owner@example.test"
	cfg.SuperadminPasswordHash = string(hash)
	cfg.ProtectedGoogleEmail = "google-owner@example.test"
	hub := realtime.New(nil, "superadmin-tests")
	mux := http.NewServeMux()
	New(store, hub, cfg).Register(mux)
	svc := service.New(store, nil, hub, []byte(strings.Repeat("k", 32)), 1_500_000)
	return mux, store, svc
}

// registerTestMember 注册一名测试普通用户。参数：email为测试邮箱；返回值：账号；注意事项：故意填写超级管理员显示名，证明姓名不能赋予权限。
func registerTestMember(t *testing.T, handler http.Handler, store *testStore, email string) storage.Account {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"email": email, "name": "超级管理员", "password": "member-secret"})
	w := request(handler, "POST", "/relay/admin/api/auth/register", string(body), nil, "")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	account, err := store.FindAccountByEmail(context.Background(), email)
	if err != nil {
		t.Fatal(err)
	}
	return account
}

// TestAccountMutationAuthorization 验证仅配置的超级管理员具有账号变更权限。参数：t为测试句柄；返回值：无；注意事项：覆盖普通管理员、伪造姓名、CSRF、role注入和受保护身份。
func TestAccountMutationAuthorization(t *testing.T) {
	handler, store, _ := setupSuperadmin(t)
	member := registerTestMember(t, handler, store, "member@example.test")
	w := request(handler, "POST", "/relay/admin/api/auth/login", `{"email":"owner@example.test","password":"admin-secret"}`, nil, "")
	if w.Code != 401 {
		t.Fatal("共享管理员口令冒充超级管理员")
	}
	superCookie, super := loginTest(t, handler, "owner@example.test", "super-secret")
	if super.User.Role != "superadmin" || super.User.Name != "超级管理员" || super.User.EmployeeID != "" || super.Policy != "" || super.CredentialStamp != "" {
		t.Fatal("超级管理员身份或公开会话不正确")
	}
	for _, credential := range [][2]string{{"member@example.test", "member-secret"}, {"admin@example.test", "admin-secret"}} {
		cookie, session := loginTest(t, handler, credential[0], credential[1])
		for _, operation := range [][3]string{{"PATCH", "", `{"name":"修改"}`}, {"POST", "/reset-password", `{"password":"next-password"}`}, {"DELETE", "", `{"confirmEmail":"member@example.test"}`}} {
			w = request(handler, operation[0], "/relay/admin/api/accounts/"+member.ID+operation[1], operation[2], cookie, session.CSRF)
			if w.Code != 403 || !strings.Contains(w.Body.String(), "SUPERADMIN_REQUIRED") {
				t.Fatal("普通身份能够管理账号", credential[0], w.Code, w.Body.String())
			}
		}
	}
	w = request(handler, "PATCH", "/relay/admin/api/accounts/"+member.ID, `{"name":"修改"}`, superCookie, "")
	if w.Code != 403 {
		t.Fatal("CSRF缺失仍可修改")
	}
	w = request(handler, "PATCH", "/relay/admin/api/accounts/"+member.ID, `{"role":"superadmin"}`, superCookie, super.CSRF)
	if w.Code != 400 {
		t.Fatal("客户端role字段被接受")
	}
	w = request(handler, "PATCH", "/relay/admin/api/accounts/"+member.ID, `{"email":"owner@example.test"}`, superCookie, super.CSRF)
	if w.Code != 409 {
		t.Fatal("普通账号可改为超级管理员邮箱")
	}
	protected, err := store.UpsertAccount(context.Background(), storage.Account{ID: "protected-google", Email: "google-owner@example.test", Name: "受保护Google身份", Provider: "google"})
	if err != nil {
		t.Fatal(err)
	}
	w = request(handler, "DELETE", "/relay/admin/api/accounts/"+protected.ID, `{"confirmEmail":"google-owner@example.test"}`, superCookie, super.CSRF)
	if w.Code != 409 || !strings.Contains(w.Body.String(), "ACCOUNT_PROTECTED") {
		t.Fatal("受保护账号可删除")
	}
	google, err := store.UpsertAccount(context.Background(), storage.Account{ID: "regular-google", Email: "google@example.test", Name: "Google用户", Provider: "google"})
	if err != nil {
		t.Fatal(err)
	}
	for _, operation := range [][3]string{{"PATCH", "", `{"email":"changed@example.test"}`}, {"POST", "/reset-password", `{"password":"next-password"}`}} {
		w = request(handler, operation[0], "/relay/admin/api/accounts/"+google.ID+operation[1], operation[2], superCookie, super.CSRF)
		if w.Code != 409 {
			t.Fatal("Google身份被转换", w.Code)
		}
	}
	w = request(handler, "GET", "/relay/admin/api/releases", "", superCookie, "")
	if w.Code != 200 {
		t.Fatal("超级管理员丢失发版访问能力")
	}
}

// TestAccountSessionInvalidation 验证姓名修改保持正常会话，凭据变更与删除使所有旧会话失效。参数：t为测试句柄；返回值：无；注意事项：同时使用真实服务登录路径验证设备令牌，不只检查模拟状态。
func TestAccountSessionInvalidation(t *testing.T) {
	handler, store, svc := setupSuperadmin(t)
	ctx := context.Background()
	member := registerTestMember(t, handler, store, "member@example.test")
	other := registerTestMember(t, handler, store, "other@example.test")
	superCookie, super := loginTest(t, handler, "owner@example.test", "super-secret")
	memberCookie, memberSession := loginTest(t, handler, "member@example.test", "member-secret")
	otherCookie, _ := loginTest(t, handler, "other@example.test", "member-secret")
	device, err := svc.LoginEmail(ctx, member.Email, "", "member-secret", "login", service.DeviceInput{ClientDeviceID: "member-mac", Name: "电脑", Platform: "mac"})
	if err != nil {
		t.Fatal(err)
	}
	w := request(handler, "PATCH", "/relay/admin/api/accounts/"+member.ID, `{"name":"新的姓名"}`, superCookie, super.CSRF)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"sessionsRevoked":false`) {
		t.Fatal(w.Code, w.Body.String())
	}
	w = request(handler, "GET", "/relay/admin/api/me", "", memberCookie, "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), "新的姓名") || strings.Contains(w.Body.String(), "credentialStamp") {
		t.Fatal("姓名修改破坏会话或泄露指纹")
	}
	if _, _, err = svc.Authenticate(ctx, device.DeviceToken); err != nil {
		t.Fatal("改名错误撤销设备")
	}
	w = request(handler, "PATCH", "/relay/admin/api/accounts/"+member.ID, `{"email":"other@example.test"}`, superCookie, super.CSRF)
	if w.Code != 409 {
		t.Fatal("重复邮箱未拒绝")
	}
	w = request(handler, "POST", "/relay/admin/api/accounts/"+member.ID+"/reset-password", `{"password":"new-member-secret"}`, superCookie, super.CSRF)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = request(handler, "GET", "/relay/admin/api/me", "", memberCookie, "")
	if w.Code != 401 {
		t.Fatal("密码重置后旧浏览器会话有效")
	}
	if _, _, err = svc.Authenticate(ctx, device.DeviceToken); err == nil {
		t.Fatal("密码重置后旧设备令牌有效")
	}
	w = request(handler, "POST", "/relay/admin/api/auth/login", `{"email":"member@example.test","password":"member-secret"}`, nil, "")
	if w.Code != 401 {
		t.Fatal("旧密码仍可登录")
	}
	memberCookie, memberSession = loginTest(t, handler, "member@example.test", "new-member-secret")
	device, err = svc.LoginEmail(ctx, member.Email, "", "new-member-secret", "login", service.DeviceInput{ClientDeviceID: "member-mac", Name: "电脑", Platform: "mac"})
	if err != nil {
		t.Fatal(err)
	}
	w = request(handler, "PATCH", "/relay/admin/api/accounts/"+member.ID, `{"email":"changed@example.test"}`, superCookie, super.CSRF)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"sessionsRevoked":true`) {
		t.Fatal(w.Code, w.Body.String())
	}
	w = request(handler, "GET", "/relay/admin/api/me", "", memberCookie, memberSession.CSRF)
	if w.Code != 401 {
		t.Fatal("改邮箱后旧浏览器会话有效")
	}
	if _, _, err = svc.Authenticate(ctx, device.DeviceToken); err == nil {
		t.Fatal("改邮箱后旧设备令牌有效")
	}
	memberCookie, _ = loginTest(t, handler, "changed@example.test", "new-member-secret")
	w = request(handler, "DELETE", "/relay/admin/api/accounts/"+member.ID, `{"confirmEmail":"wrong@example.test"}`, superCookie, super.CSRF)
	if w.Code != 409 {
		t.Fatal("删除确认失配未拒绝")
	}
	w = request(handler, "DELETE", "/relay/admin/api/accounts/"+member.ID, `{"confirmEmail":"changed@example.test"}`, superCookie, super.CSRF)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = request(handler, "GET", "/relay/admin/api/me", "", memberCookie, "")
	if w.Code != 401 {
		t.Fatal("删除后旧浏览器会话有效")
	}
	w = request(handler, "GET", "/relay/admin/api/me", "", otherCookie, "")
	if w.Code != 200 {
		t.Fatal("删除影响其他账号会话")
	}
	if _, err = store.GetManagedAccount(ctx, other.ID); err != nil {
		t.Fatal("其他账号数据丢失")
	}
	registerTestMember(t, handler, store, "changed@example.test")
	w = request(handler, "GET", "/relay/admin/api/me", "", memberCookie, "")
	if w.Code != 401 {
		t.Fatal("重新注册同邮箱复活已删除会话")
	}
}

// TestEmailRoundTripDoesNotReviveBrowserSession 验证邮箱A→B→A不能复活未过期旧cookie。参数：t为测试句柄；返回值：无；注意事项：真实HTTP修改两次，密码未变，必须依靠持久认证版本拒绝旧会话。
func TestEmailRoundTripDoesNotReviveBrowserSession(t *testing.T) {
	handler, store, _ := setupSuperadmin(t)
	member := registerTestMember(t, handler, store, "roundtrip@example.test")
	oldCookie, _ := loginTest(t, handler, member.Email, "member-secret")
	superCookie, super := loginTest(t, handler, "owner@example.test", "super-secret")
	for _, email := range []string{"intermediate@example.test", member.Email} {
		body, _ := json.Marshal(map[string]string{"email": email})
		w := request(handler, "PATCH", "/relay/admin/api/accounts/"+member.ID, string(body), superCookie, super.CSRF)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	w := request(handler, "GET", "/relay/admin/api/me", "", oldCookie, "")
	if w.Code != 401 {
		t.Fatal("邮箱恢复原值后旧cookie重新生效", w.Code)
	}
	if _, version, err := store.PasswordState(context.Background(), member.ID); err != nil || version != 2 {
		t.Fatal("邮箱变更未持久递增认证版本", version, err)
	}
	freshCookie, _ := loginTest(t, handler, member.Email, "member-secret")
	w = request(handler, "GET", "/relay/admin/api/me", "", freshCookie, "")
	if w.Code != 200 {
		t.Fatal("当前凭据不能重新登录")
	}
}
