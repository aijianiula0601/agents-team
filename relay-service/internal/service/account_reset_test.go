package service

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"agents-team-relay/internal/storage"
	"golang.org/x/crypto/bcrypt"
)

// pausedDeviceStore 在密码验证与设备签发之间设置测试屏障。参数：channels控制确定性交错；返回值：实现Store的测试包装；注意事项：保留真实内存存储原子锁与重置实现。
type pausedDeviceStore struct {
	*storage.Memory
	validated chan struct{}
	resume    chan struct{}
}

// UpsertAuthenticatedDevice 等待重置完成后提交旧认证快照。参数：设备、认证邮箱及摘要；返回值：存储结果；注意事项：该屏障仅用于测试，不改变底层校验逻辑。
func (s *pausedDeviceStore) UpsertAuthenticatedDevice(ctx context.Context, device storage.Device, email, hash string, version int64) (storage.Device, error) {
	close(s.validated)
	select {
	case <-s.resume:
	case <-ctx.Done():
		return storage.Device{}, ctx.Err()
	}
	return s.Memory.UpsertAuthenticatedDevice(ctx, device, email, hash, version)
}

// verifyInFlightCredentialChange 证明凭据变更后旧认证不能重建有效设备令牌。参数：t为测试句柄；返回值：无；注意事项：不依赖sleep时序，利用屏障稳定复现原来的危险交错。
func verifyInFlightCredentialChange(t *testing.T, emailRoundTrip bool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	memory := storage.NewMemory()
	oldHash, err := bcrypt.GenerateFromPassword([]byte("old-password"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	account, err := memory.RegisterEmail(ctx, storage.Account{ID: "test-reset-account", Email: "reset@example.test", Name: "重置测试", Provider: "email"}, string(oldHash))
	if err != nil {
		t.Fatal(err)
	}
	store := &pausedDeviceStore{Memory: memory, validated: make(chan struct{}), resume: make(chan struct{})}
	svc := New(store, nil, nil, []byte(strings.Repeat("k", 32)), 1_500_000)
	result := make(chan error, 1)
	go func() {
		_, err := svc.LoginEmail(ctx, account.Email, "", "old-password", "login", DeviceInput{ClientDeviceID: "pending-device", Name: "电脑", Platform: "mac"})
		result <- err
	}()
	select {
	case <-store.validated:
	case <-ctx.Done():
		t.Fatal("登录未到达设备签发屏障")
	}
	password := "new-password"
	if emailRoundTrip {
		changed := "temporary@example.test"
		if _, _, err = memory.UpdateManagedAccount(ctx, account.ID, storage.AccountPatch{Email: &changed}); err != nil {
			t.Fatal(err)
		}
		if _, _, err = memory.UpdateManagedAccount(ctx, account.ID, storage.AccountPatch{Email: &account.Email}); err != nil {
			t.Fatal(err)
		}
		password = "old-password"
	} else {
		nextHash, e := bcrypt.GenerateFromPassword([]byte(password), bcrypt.MinCost)
		if e != nil {
			t.Fatal(e)
		}
		if err = memory.ResetManagedPassword(ctx, account.ID, string(nextHash)); err != nil {
			t.Fatal(err)
		}
	}

	close(store.resume)
	select {
	case err = <-result:
	case <-ctx.Done():
		t.Fatal("旧登录没有结束")
	}
	var business *Error
	if !errors.As(err, &business) || business.Status != 401 || business.Code != "CREDENTIALS_CHANGED" {
		t.Fatal("旧认证快照未被拒绝", err)
	}
	devices, err := memory.ListDevices(ctx, account.ID)
	if err != nil || len(devices) != 0 {
		t.Fatal("旧密码仍签发了设备", err)
	}
	fresh := New(memory, nil, nil, []byte(strings.Repeat("k", 32)), 1_500_000)
	session, err := fresh.LoginEmail(ctx, account.Email, "", password, "login", DeviceInput{ClientDeviceID: "fresh-device", Name: "电脑", Platform: "mac"})
	if err != nil || session.DeviceToken == "" {
		t.Fatal("新密码正常登录受影响", err)
	}
}

// TestPasswordResetFencesInFlightLogin 验证并发密码重置和邮箱A→B→A均拒绝旧认证快照。参数：t为测试句柄；返回值：无；注意事项：使用屏障而非时间等待，邮箱回转不能让版本0复活。
func TestPasswordResetFencesInFlightLogin(t *testing.T) {
	t.Run("password-reset", func(t *testing.T) { verifyInFlightCredentialChange(t, false) })
	t.Run("email-round-trip", func(t *testing.T) { verifyInFlightCredentialChange(t, true) })
}

// TestOldDeviceCannotMutateAfterRelogin 验证被撤销后复用设备ID的新会话不接受旧请求。参数：t为测试句柄；返回值：无；注意事项：覆盖创建任务、切主电脑和撤销设备三个账号事务入口，正常新请求仍成功。
func TestOldDeviceCannotMutateAfterRelogin(t *testing.T) {
	ctx := context.Background()
	svc, store := testService()
	old := testLogin(t, svc, "stale@example.test", "same-desktop", "mac", "register")
	hash, err := bcrypt.GenerateFromPassword([]byte("secure-password"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	if err = store.ResetManagedPassword(ctx, old.Account.ID, string(hash)); err != nil {
		t.Fatal(err)
	}
	current := testLogin(t, svc, "stale@example.test", "same-desktop", "mac", "login")
	target := testLogin(t, svc, "stale@example.test", "target-desktop", "mac", "login")
	if current.Device.ID != old.Device.ID {
		t.Fatal("未复用设备ID，测试条件不成立")
	}
	input := DispatchInput{ClientRequestID: "old-device-request", Mode: "execute", UserText: "不能写入", Responders: []MessageInput{{AgentID: "a1"}}}
	if _, _, err = svc.CreateDispatch(ctx, old.Device, input); businessCode(err) != "UNAUTHORIZED" {
		t.Fatal("旧请求能够创建任务", err)
	}
	if err = svc.SetPrimary(ctx, old.Device, target.Device.ID); businessCode(err) != "UNAUTHORIZED" {
		t.Fatal("旧请求能够切换主电脑", err)
	}
	if err = svc.RevokeDevice(ctx, old.Device, target.Device.ID); businessCode(err) != "UNAUTHORIZED" {
		t.Fatal("旧请求能够撤销设备", err)
	}
	if _, err = store.GetDevice(ctx, current.Account.ID, target.Device.ID); err != nil {
		t.Fatal("新会话设备被旧请求破坏", err)
	}
	if err = svc.SetPrimary(ctx, current.Device, target.Device.ID); err != nil {
		t.Fatal("正常新会话无法切换主电脑", err)
	}
	if err = svc.RevokeDevice(ctx, current.Device, target.Device.ID); err != nil {
		t.Fatal("正常新会话无法撤销设备", err)
	}
}
