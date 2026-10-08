package service

import (
	"context"
	"errors"
	"sync"
	"testing"

	"agents-team-relay/internal/identity"
	"agents-team-relay/internal/storage"
)

// TestSuperadminSessionAcrossNodes 验证双节点同配置派生员工身份且撤销配置影响旧会话。
//
// 参数：t 为测试句柄。
// 返回值：无；身份或权限异常时终止测试。
// 注意事项：使用并发安全的共享内存存储模拟共享 MySQL，不向任何外部服务发送数据。
func TestSuperadminSessionAcrossNodes(t *testing.T) {
	ctx := context.Background()
	store := storage.NewMemory()
	key := []byte("0123456789abcdef0123456789abcdef")
	verifier := fakeGoogle{profile: identity.Profile{Email: "ADMIN@EXAMPLE.TEST", Verified: true}}
	policy := identity.AccessPolicy{GoogleEmail: "admin@example.test", EmployeeID: "12345678"}
	nodeA := New(store, verifier, nil, key, 100000).WithAccessPolicy(policy)
	nodeB := New(store, verifier, nil, key, 100000).WithAccessPolicy(policy)
	session, err := nodeA.LoginGoogle(ctx, "synthetic-google-token", DeviceInput{ClientDeviceID: "desktop-admin-01", Name: "桌面", Platform: "mac"})
	if err != nil {
		t.Fatal(err)
	}
	if session.Account.EmployeeID != "12345678" || session.Account.Role != identity.RoleSuperadmin {
		t.Fatal("Google 登录未返回服务器绑定员工身份")
	}
	// ------------ 验证同一会话跨节点并发认证 ---------------
	var workers sync.WaitGroup
	for index := 0; index < 24; index++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			_, account, err := nodeB.RequireSuperadmin(ctx, session.DeviceToken)
			if err != nil || account.EmployeeID != "12345678" || account.Role != identity.RoleSuperadmin {
				t.Error("第二节点未正确验证管理员会话")
			}
		}()
	}
	workers.Wait()
	// 撤销通过新进程策略模拟，不能运行中修改策略形成数据竞争。
	revokedNode := New(store, verifier, nil, key, 100000)
	_, account, err := revokedNode.Authenticate(ctx, session.DeviceToken)
	if err != nil || account.Role != identity.RoleMember || account.EmployeeID != "" {
		t.Fatal("撤销服务器映射后旧会话仍保留身份")
	}
	_, _, err = revokedNode.RequireSuperadmin(ctx, session.DeviceToken)
	var forbidden *Error
	if !errors.As(err, &forbidden) || forbidden.Status != 403 {
		t.Fatal("普通成员应该被服务器管理权限校验拒绝")
	}
	if _, _, err := nodeA.RequireSuperadmin(ctx, "invalid-token"); err == nil {
		t.Fatal("无效设备令牌不得获得管理权限")
	}
}

// TestPasswordAccountCannotClaimEmployee 验证密码账号不能冒用相同 Google 邮箱获得员工角色。
//
// 参数：t 为测试句柄。
// 返回值：无；密码账号越权或登录方式冲突被忽略时终止测试。
// 注意事项：邮箱、密码及 Google 令牌全部为测试数据。
func TestPasswordAccountCannotClaimEmployee(t *testing.T) {
	ctx := context.Background()
	store := storage.NewMemory()
	svc := New(store, fakeGoogle{profile: identity.Profile{Email: "admin@example.test", Verified: true}}, nil, []byte("0123456789abcdef0123456789abcdef"), 100000).WithAccessPolicy(identity.AccessPolicy{GoogleEmail: "admin@example.test", EmployeeID: "12345678"})
	device := DeviceInput{ClientDeviceID: "desktop-email-01", Name: "12345678", Platform: "mac"}
	session, err := svc.LoginEmail(ctx, "admin@example.test", "12345678", "synthetic-password", "register", device)
	if err != nil {
		t.Fatal(err)
	}
	if session.Account.Role != identity.RoleMember || session.Account.EmployeeID != "" {
		t.Fatal("姓名或设备名称冒用工号不得获得员工身份")
	}
	_, _, err = svc.RequireSuperadmin(ctx, session.DeviceToken)
	var forbidden *Error
	if !errors.As(err, &forbidden) || forbidden.Status != 403 {
		t.Fatal("密码注册的同邮箱账号不得获得 Google 管理员角色")
	}
	if _, err := svc.LoginGoogle(ctx, "synthetic-google-token", device); err == nil {
		t.Fatal("OAuth 不得自动链接并提升已存在的密码账号")
	}
	other := New(storage.NewMemory(), fakeGoogle{profile: identity.Profile{Email: "admin@example.test", Verified: false}}, nil, []byte("0123456789abcdef0123456789abcdef"), 100000).WithAccessPolicy(identity.AccessPolicy{GoogleEmail: "admin@example.test", EmployeeID: "12345678"})
	if _, err := other.LoginGoogle(ctx, "synthetic-google-token", device); err == nil {
		t.Fatal("未经 Google 验证的邮箱不得获得会话或管理员角色")
	}
}
