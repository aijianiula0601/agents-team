package storage

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"

	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

// TestMemorySessionLogoutFence 验证旧退出请求不能撤销同一设备的新登录。
// 参数：t 为测试句柄。
// 返回值：无，违反存储会话版本契约时终止测试。
// 注意事项：使用内存存储，不读取真实账号或凭据。
func TestMemorySessionLogoutFence(t *testing.T) {
	verifySessionLogoutFence(t, NewMemory())
}

// verifySessionLogoutFence 对持久化接口执行相同的会话轮换、退出和管理撤销检查。
// 参数：t 为测试句柄；store 为待验证存储。
// 返回值：无，行为错误时终止测试。
// 注意事项：账号与摘要均为随机测试数据；不会读取或修改真实账号。
func verifySessionLogoutFence(t *testing.T, store Store) {
	t.Helper()
	ctx := context.Background()
	key := uuid.NewString()
	passwordHash, err := bcrypt.GenerateFromPassword([]byte(uuid.NewString()), bcrypt.MinCost)
	if err != nil {
		t.Fatal("生成测试摘要失败")
	}
	account, err := store.RegisterEmail(ctx, Account{ID: uuid.NewString(), Email: "logout-fence-" + key + "@example.test", Name: "注销回归验收", Provider: "email"}, string(passwordHash))
	if err != nil {
		t.Fatal("创建隔离存储账号失败")
	}
	oldSum := sha256.Sum256([]byte(uuid.NewString()))
	newSum := sha256.Sum256([]byte(uuid.NewString()))
	old, err := store.UpsertDevice(ctx, Device{ID: uuid.NewString(), AccountID: account.ID, ClientDeviceID: "fence-" + key, Name: "验收电脑", Platform: "mac", TokenHash: hex.EncodeToString(oldSum[:])})
	if err != nil {
		t.Fatal("创建设备失败")
	}
	current := old
	current.ID, current.TokenHash = uuid.NewString(), hex.EncodeToString(newSum[:])
	current, err = store.UpsertDevice(ctx, current)
	if err != nil || current.ID != old.ID {
		t.Fatal("重新登录未复用设备记录")
	}
	for attempt := 0; attempt < 2; attempt++ {
		if revoked, err := store.RevokeSession(ctx, old); err != nil || revoked {
			t.Fatal("旧退出请求不应撤销新会话")
		}
	}
	if device, _, err := store.DeviceByTokenHash(ctx, current.TokenHash); err != nil || !device.IsPrimary {
		t.Fatal("旧退出请求破坏新会话或主设备身份")
	}
	if _, _, err := store.DeviceByTokenHash(ctx, old.TokenHash); !errors.Is(err, ErrNotFound) {
		t.Fatal("已轮换的旧令牌仍有效")
	}
	if revoked, err := store.RevokeSession(ctx, current); err != nil || !revoked {
		t.Fatal("当前会话未被撤销")
	}
	if revoked, err := store.RevokeSession(ctx, current); err != nil || revoked {
		t.Fatal("重复退出应幂等且不更新设备")
	}
	if _, err := store.UpsertDevice(ctx, current); err != nil {
		t.Fatal("退出后不能重新登录")
	}
	if err := store.RevokeDevice(ctx, account.ID, current.ID); err != nil {
		t.Fatal("设备管理撤销语义被改变")
	}
	if err := store.RevokeDevice(ctx, account.ID, current.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("重复设备管理撤销应返回不存在")
	}
}
