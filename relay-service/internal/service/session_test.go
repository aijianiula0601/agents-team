package service

import (
	"context"
	"errors"
	"testing"

	"agents-team-relay/internal/realtime"
	"agents-team-relay/internal/storage"
)

// logoutPublisher 记录注销回归测试中的广播次数。
// 参数：events 保存合成事件。
// 返回值：通过 Publish 收集业务层已提交的事件。
// 注意事项：只用于顺序调用的单元测试，不保存令牌或用户内容。
type logoutPublisher struct{ events []realtime.Event }

// Publish 保存一条合成事件供测试断言。
// 参数：ctx 不使用；event 为待记录事件。
// 返回值：始终为nil。
// 注意事项：不联网，不记录认证信息。
func (p *logoutPublisher) Publish(_ context.Context, event realtime.Event) error {
	p.events = append(p.events, event)
	return nil
}

// TestLateLogoutPreservesNewSession 验证迟到退出不撤销新令牌或发送误导广播。
// 参数：t 为测试句柄。
// 返回值：无，发现会话或广播边界错误时终止测试。
// 注意事项：只操作隔离的内存账号，模拟HTTP认证与事务之间发生重新登录。
func TestLateLogoutPreservesNewSession(t *testing.T) {
	ctx := context.Background()
	publisher := &logoutPublisher{}
	svc := New(storage.NewMemory(), fakeGoogle{}, publisher, []byte("0123456789abcdef0123456789abcdef"), 100000)
	input := DeviceInput{ClientDeviceID: "late-logout-desktop", Name: "验收电脑", Platform: "mac"}
	old, err := svc.LoginEmail(ctx, "logout-service@example.test", "验收", "synthetic-password", "register", input)
	if err != nil {
		t.Fatal(err)
	}
	device, _, err := svc.Authenticate(ctx, old.DeviceToken)
	if err != nil {
		t.Fatal(err)
	}
	current, err := svc.LoginEmail(ctx, "logout-service@example.test", "验收", "synthetic-password", "login", input)
	if err != nil {
		t.Fatal(err)
	}
	before := len(publisher.events)
	if err := svc.Logout(ctx, device); err != nil || len(publisher.events) != before {
		t.Fatal("旧退出应幂等且不能广播设备变更")
	}
	if _, _, err := svc.Authenticate(ctx, current.DeviceToken); err != nil {
		t.Fatal("新会话被旧退出撤销")
	}
	var obsolete *Error
	if _, err := svc.ListPending(ctx, device); !errors.As(err, &obsolete) || obsolete.Status != 401 {
		t.Fatal("缓存旧设备不应读取待执行任务")
	}
	if _, _, err := svc.CompleteDispatch(ctx, device, "synthetic-task", ResultInput{Status: "running"}); !errors.As(err, &obsolete) || obsolete.Status != 401 {
		t.Fatal("缓存旧设备不应确认任务")
	}
	if err := svc.Logout(ctx, current.Device); err != nil || len(publisher.events) != before+1 {
		t.Fatal("当前会话注销应广播一次")
	}
	if err := svc.Logout(ctx, current.Device); err != nil || len(publisher.events) != before+1 {
		t.Fatal("重复注销不得重复广播")
	}
}
