package storage

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// accountTestStore 汇集真实账号变更与设备操作契约。参数：实现可为Memory或MySQL；返回值：测试依赖；注意事项：同一套行为断言覆盖两种存储。
type accountTestStore interface {
	Store
	AccountManager
}

// accountFixture 记录一名测试用户的完整关联数据。参数：字段均由随机测试生成；返回值：便于后续核对隔离；注意事项：不使用真实账号标识。
type accountFixture struct {
	account    Account
	device     Device
	dispatchID string
	inviteHash string
}

// seedAccountFixture 创建账号、设备、聊天、任务、租约和邀请码。参数：store为待测存储；返回值：关联主键；注意事项：测试完成时由内存回收或独立数据库清理。
func seedAccountFixture(t *testing.T, store accountTestStore, email string) accountFixture {
	t.Helper()
	ctx := context.Background()
	account, err := store.RegisterEmail(ctx, Account{ID: uuid.NewString(), Email: email, Name: "原姓名", Provider: "email"}, "initial-password-hash")
	if err != nil {
		t.Fatal(err)
	}
	device, err := store.UpsertDevice(ctx, Device{ID: uuid.NewString(), AccountID: account.ID, ClientDeviceID: uuid.NewString(), Name: "电脑", Platform: "mac", TokenHash: strings.ReplaceAll(uuid.NewString()+uuid.NewString(), "-", "")})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	dispatchID := uuid.NewString()
	err = store.WithAccount(ctx, account.ID, func(tx Tx) error {
		if _, err := tx.SaveState(ctx, device.ID, []byte(`{"agents":[],"rooms":[]}`)); err != nil {
			return err
		}
		if err := tx.InsertDispatch(ctx, Dispatch{ID: dispatchID, AccountID: account.ID, SourceDeviceID: device.ID, ClientRequestID: uuid.NewString(), Mode: "execute", Status: "running", Payload: []byte("{}"), CreatedAt: now, UpdatedAt: now}); err != nil {
			return err
		}
		return tx.SaveClaim(ctx, Claim{DispatchID: dispatchID, DeviceID: device.ID, TokenHash: strings.Repeat("c", 64), ExpiresAt: now.Add(time.Minute)})
	})
	if err != nil {
		t.Fatal(err)
	}
	invite := strings.ReplaceAll(uuid.NewString()+uuid.NewString(), "-", "")
	if err = store.InsertInvite(ctx, Invite{CodeHash: invite, AccountID: account.ID, CreatedByDevice: device.ID, CreatedAt: now, ExpiresAt: now.Add(time.Minute)}); err != nil {
		t.Fatal(err)
	}
	return accountFixture{account: account, device: device, dispatchID: dispatchID, inviteHash: invite}
}

// verifyAccountManagement 核对编辑、撤销、凭据栅栏和删除隔离。参数：store为实际实现；返回值：被删除账号与保留账号ID；注意事项：断言公开存储行为，不依赖实现内部集合。
func verifyAccountManagement(t *testing.T, store accountTestStore) (string, string) {
	t.Helper()
	ctx := context.Background()
	first := seedAccountFixture(t, store, "first@example.test")
	other := seedAccountFixture(t, store, "other@example.test")
	name := "新姓名"
	account, revoked, err := store.UpdateManagedAccount(ctx, first.account.ID, AccountPatch{Name: &name})
	if err != nil || revoked || account.Name != name {
		t.Fatal("改名错误", err)
	}
	if _, _, err = store.DeviceByTokenHash(ctx, first.device.TokenHash); err != nil {
		t.Fatal("改名撤销正常设备", err)
	}
	wrongName := "不得保存"
	_, _, err = store.UpdateManagedAccount(ctx, first.account.ID, AccountPatch{Name: &wrongName, Email: &other.account.Email})
	if !errors.Is(err, ErrAccountExists) {
		t.Fatal("重复邮箱未受保护", err)
	}
	account, err = store.GetManagedAccount(ctx, first.account.ID)
	if err != nil || account.Name != name || account.Email != first.account.Email {
		t.Fatal("失败变更未回滚", err)
	}
	changedEmail := "changed@example.test"
	_, revoked, err = store.UpdateManagedAccount(ctx, first.account.ID, AccountPatch{Email: &changedEmail})
	if err != nil || !revoked {
		t.Fatal("邮箱变更未撤销会话", err)
	}
	if _, _, err = store.DeviceByTokenHash(ctx, first.device.TokenHash); !errors.Is(err, ErrNotFound) {
		t.Fatal("旧设备仍有效", err)
	}
	if _, err = store.ConsumeInvite(ctx, first.inviteHash, time.Now().UTC()); !errors.Is(err, ErrNotFound) {
		t.Fatal("旧邀请码仍可消费", err)
	}
	candidate := first.device
	candidate.ID = uuid.NewString()
	candidate.ClientDeviceID = first.device.ClientDeviceID
	candidate.TokenHash = strings.Repeat("n", 64)
	if _, err = store.UpsertAuthenticatedDevice(ctx, candidate, first.account.Email, "initial-password-hash", 0); !errors.Is(err, ErrCredentialsChanged) {
		t.Fatal("旧邮箱认证快照仍可签发", err)
	}
	// 邮箱恢复原值时密码未变，但版本必须阻止最早认证快照复活。
	if _, _, err = store.UpdateManagedAccount(ctx, first.account.ID, AccountPatch{Email: &first.account.Email}); err != nil {
		t.Fatal(err)
	}
	if _, err = store.UpsertAuthenticatedDevice(ctx, candidate, first.account.Email, "initial-password-hash", 0); !errors.Is(err, ErrCredentialsChanged) {
		t.Fatal("邮箱回转复活旧认证快照", err)
	}
	if _, _, err = store.UpdateManagedAccount(ctx, first.account.ID, AccountPatch{Email: &changedEmail}); err != nil {
		t.Fatal(err)
	}
	fresh, err := store.UpsertAuthenticatedDevice(ctx, candidate, changedEmail, "initial-password-hash", 3)
	if err != nil {
		t.Fatal("新邮箱无法登记设备", err)
	}
	if fresh.ID != first.device.ID {
		t.Fatal("重新登录未复用原设备ID")
	}
	if err = store.SetPrimaryForSession(ctx, first.device, fresh.ID); !errors.Is(err, ErrCredentialsChanged) {
		t.Fatal("旧请求能够切换主设备", err)
	}
	if err = store.RevokeDeviceForSession(ctx, first.device, fresh.ID); !errors.Is(err, ErrCredentialsChanged) {
		t.Fatal("旧请求能够撤销新会话", err)
	}
	if err = store.SetPrimaryForSession(ctx, fresh, fresh.ID); err != nil {
		t.Fatal("新会话无法正常管理设备", err)
	}
	if err = store.ResetManagedPassword(ctx, first.account.ID, "new-password-hash"); err != nil {
		t.Fatal(err)
	}
	if _, _, err = store.DeviceByTokenHash(ctx, fresh.TokenHash); !errors.Is(err, ErrNotFound) {
		t.Fatal("重置后设备未撤销", err)
	}
	if _, err = store.UpsertAuthenticatedDevice(ctx, candidate, changedEmail, "initial-password-hash", 3); !errors.Is(err, ErrCredentialsChanged) {
		t.Fatal("旧密码认证快照仍可签发", err)
	}
	if _, err = store.FindDispatch(ctx, first.account.ID, first.dispatchID); err != nil {
		t.Fatal("重置丢失任务历史", err)
	}
	if err = store.DeleteManagedAccount(ctx, first.account.ID, "wrong@example.test"); !errors.Is(err, ErrConfirmationMismatch) {
		t.Fatal("错误删除确认被接受", err)
	}
	if _, err = store.GetManagedAccount(ctx, first.account.ID); err != nil {
		t.Fatal("错误确认仍删除账号", err)
	}
	if err = store.DeleteManagedAccount(ctx, first.account.ID, changedEmail); err != nil {
		t.Fatal("外键关联删除失败", err)
	}
	if _, err = store.GetManagedAccount(ctx, first.account.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("账号仍残留", err)
	}
	if _, err = store.PasswordHash(ctx, first.account.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("密码仍残留", err)
	}
	if _, err = store.FindDispatch(ctx, first.account.ID, first.dispatchID); !errors.Is(err, ErrNotFound) {
		t.Fatal("任务仍残留", err)
	}
	if _, _, err = store.DeviceByTokenHash(ctx, first.device.TokenHash); !errors.Is(err, ErrNotFound) {
		t.Fatal("删除后令牌仍有效", err)
	}
	if _, _, err = store.DeviceByTokenHash(ctx, other.device.TokenHash); err != nil {
		t.Fatal("变更破坏其他账号设备", err)
	}
	if _, err = store.FindDispatch(ctx, other.account.ID, other.dispatchID); err != nil {
		t.Fatal("变更破坏其他账号任务", err)
	}
	if hash, err := store.PasswordHash(ctx, other.account.ID); err != nil || hash != "initial-password-hash" {
		t.Fatal("变更破坏其他账号凭据", err)
	}
	if _, err = store.RegisterEmail(ctx, Account{ID: uuid.NewString(), Email: changedEmail, Name: "新账号", Provider: "email"}, "other-new-hash"); err != nil {
		t.Fatal("删除后邮箱未释放", err)
	}
	return first.account.ID, other.account.ID
}

// TestMemoryAccountManagement 验证内存实现完整账号管理契约。参数：t为测试句柄；返回值：无；注意事项：与真实MySQL集成测试复用相同断言。
func TestMemoryAccountManagement(t *testing.T) { verifyAccountManagement(t, NewMemory()) }
