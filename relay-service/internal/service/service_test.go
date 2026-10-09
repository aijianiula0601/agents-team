package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"agents-team-relay/internal/identity"
	"agents-team-relay/internal/storage"
)

type fakeGoogle struct {
	profile identity.Profile
	err     error
}

// Verify 返回测试预设的 Google 资料。
//
// 参数：accessToken 不参与判断。
// 返回值：预设资料或错误。
// 注意事项：只用于单元测试。
func (f fakeGoogle) Verify(context.Context, string) (identity.Profile, error) {
	return f.profile, f.err
}

// TestPrimaryDispatchAndSync 覆盖登录、主设备、快照冲突和执行回写。
//
// 参数：t 为测试句柄。
// 返回值：无。
// 注意事项：使用内存存储，不连接 MySQL。
func TestPrimaryDispatchAndSync(t *testing.T) {
	ctx := context.Background()
	svc := New(storage.NewMemory(), fakeGoogle{profile: identity.Profile{Email: "User@Example.com", Name: "测试用户", Verified: true}}, nil, []byte("0123456789abcdef0123456789abcdef"), 100000)
	mac := DeviceInput{ClientDeviceID: "mac-device-01", Name: "办公 Mac", Platform: "mac"}
	phone := DeviceInput{ClientDeviceID: "android-device-1", Name: "手机", Platform: "android"}
	primary, err := svc.LoginGoogle(ctx, "token", mac)
	if err != nil {
		t.Fatalf("主设备登录失败: %v", err)
	}
	if !primary.Device.IsPrimary || primary.Account.Email != "user@example.com" || primary.DeviceToken == "" {
		t.Fatalf("主设备会话不正确: %+v", primary.Device)
	}
	secondary, err := svc.LoginGoogle(ctx, "token", phone)
	if err != nil {
		t.Fatalf("手机登录失败: %v", err)
	}
	if secondary.Device.IsPrimary || secondary.Account.ID != primary.Account.ID {
		t.Fatalf("第二台设备不应成为主设备")
	}
	state := json.RawMessage(`{"agents":[{"id":"a1","name":"助手","messages":[]}],"rooms":[{"id":"r1"}],"settings":{"apiKeys":{"openai":"secret"},"theme":"dark"}}`)
	saved, err := svc.SaveState(ctx, primary.Device, 0, state)
	if err != nil {
		t.Fatalf("保存聊天记录失败: %v", err)
	}
	if saved.Revision != 1 || strings.Contains(string(saved.Body), "secret") || !strings.Contains(string(saved.Body), "dark") {
		t.Fatalf("密钥未被移除或版本错误: %s", saved.Body)
	}
	if _, err := svc.SaveState(ctx, secondary.Device, 0, state); err == nil || !errors.As(err, new(*Error)) {
		t.Fatalf("旧版本覆盖应该冲突")
	}
	dispatch, revision, err := svc.CreateDispatch(ctx, secondary.Device, DispatchInput{
		ClientRequestID: "req-android-001",
		Mode:            "execute",
		RoomID:          "r1",
		UserText:        "帮我看一下项目",
		Responders: []MessageInput{{
			AgentID: "a1",
			Message: json.RawMessage(`{"id":"u1","from":"you","text":"帮我看一下项目"}`),
		}},
	})
	if err != nil || dispatch.Status != "pending" || revision != 2 {
		t.Fatalf("下发失败: %v %+v %d", err, dispatch, revision)
	}
	again, _, err := svc.CreateDispatch(ctx, secondary.Device, DispatchInput{
		ClientRequestID: "req-android-001",
		Mode:            "execute",
		RoomID:          "r1",
		UserText:        "帮我看一下项目",
		Responders: []MessageInput{{
			AgentID: "a1",
			Message: json.RawMessage(`{"id":"u1","from":"you","text":"帮我看一下项目"}`),
		}},
	})
	if err != nil || again.ID != dispatch.ID {
		t.Fatalf("重复请求没有复用任务: %v", err)
	}
	if _, _, err := svc.CompleteDispatch(ctx, secondary.Device, dispatch.ID, ResultInput{Status: "done"}); err == nil {
		t.Fatal("非主设备不能回写执行结果")
	}
	claim, err := svc.ClaimDispatch(ctx, primary.Device)
	if err != nil || claim == nil {
		t.Fatalf("领取失败: %v", err)
	}
	done, revision, err := svc.CompleteDispatch(ctx, primary.Device, dispatch.ID, ResultInput{
		Status:     "done",
		ClaimToken: claim.ClaimToken,
		Replies: []MessageInput{{
			AgentID: "a1",
			Message: json.RawMessage(`{"id":"m1","from":"a1","text":"已经看过"}`),
		}},
	})
	if err != nil || done.Status != "done" || revision != 3 {
		t.Fatalf("主设备回写失败: %v %+v %d", err, done, revision)
	}
	current, err := svc.LoadState(ctx, primary.Account.ID)
	if err != nil || !strings.Contains(string(current.Body), "已经看过") || !strings.Contains(string(current.Body), "帮我看一下项目") {
		t.Fatalf("聊天记录没有同步完整: %s", current.Body)
	}
	if err := svc.SetPrimary(ctx, primary.Device, secondary.Device.ID); err == nil {
		t.Fatal("手机不能成为主设备")
	}
	computer, err := svc.LoginGoogle(ctx, "token", DeviceInput{ClientDeviceID: "mac-device-02", Name: "另一台 Mac", Platform: "mac"})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.SetPrimary(ctx, primary.Device, computer.Device.ID); err != nil {
		t.Fatal(err)
	}
	devices, err := svc.ListDevices(ctx, primary.Account.ID)
	if err != nil {
		t.Fatalf("读取设备失败: %v", err)
	}
	primaryCount := 0
	for _, device := range devices {
		if device.IsPrimary {
			primaryCount++
			if device.ID != computer.Device.ID {
				t.Fatalf("主设备切换目标错误: %s", device.ID)
			}
		}
	}
	if primaryCount != 1 {
		t.Fatalf("主设备数量错误: %d", primaryCount)
	}
}

// TestEmailInviteAndPrimaryHandoff 覆盖同一邮箱的第二台设备和主设备撤销后的显式选择。
//
// 参数：t 为测试句柄。
// 返回值：无。
// 注意事项：第二台设备直接加入同一账号，且不能成为主设备。
func TestEmailInviteAndPrimaryHandoff(t *testing.T) {
	ctx := context.Background()
	svc := New(storage.NewMemory(), fakeGoogle{}, nil, []byte("0123456789abcdef0123456789abcdef"), 100000)
	first, err := svc.LoginEmail(ctx, "owner@example.com", "负责人", "password123", "register", DeviceInput{ClientDeviceID: "mac-device-01", Name: "Mac", Platform: "mac"})
	if err != nil || !first.Device.IsPrimary {
		t.Fatalf("首次邮箱登录失败: %v", err)
	}
	second, err := svc.LoginEmail(ctx, "owner@example.com", "另一台 Mac", "password123", "login", DeviceInput{ClientDeviceID: "mac-device-02", Name: "另一台 Mac", Platform: "mac"})
	if err != nil || second.Device.IsPrimary || second.Account.ID != first.Account.ID {
		t.Fatalf("第二台设备应加入同一账号且不是主设备: %v primary=%t", err, second.Device.IsPrimary)
	}
	devices, err := svc.ListDevices(ctx, first.Account.ID)
	if err != nil || len(devices) != 2 {
		t.Fatalf("应看到两台已登录设备: %v %+v", err, devices)
	}
	if err := svc.SetPrimary(ctx, first.Device, second.Device.ID); err != nil {
		t.Fatalf("切换主设备失败: %v", err)
	}
	if err := svc.SetPrimary(ctx, first.Device, first.Device.ID); err != nil {
		t.Fatalf("切回主设备失败: %v", err)
	}
	if err := svc.RevokeDevice(ctx, first.Device, first.Device.ID); err != nil {
		t.Fatalf("撤销主设备失败: %v", err)
	}
	devices, err = svc.ListDevices(ctx, first.Account.ID)
	if err != nil {
		t.Fatalf("读取设备失败: %v", err)
	}
	if len(devices) != 1 || devices[0].ID != second.Device.ID || devices[0].IsPrimary {
		t.Fatalf("撤销主设备后不能自动提升其他设备: %+v", devices)
	}
}
