package storage

import (
	"context"
	"errors"
	"testing"
)

// TestPrimaryChangeHookRunsUnderAccountLock 验证真正换主在账号锁内先废弃旧通道。
//
// 参数：t 为测试句柄。
// 返回值：无；身份校验、回调顺序、幂等或错误回滚失效时失败。
// 注意事项：回调只读取已经受本测试持有的内存锁保护的状态，绝不重入 Store。
func TestPrimaryChangeHookRunsUnderAccountLock(t *testing.T) {
	ctx := context.Background()
	memory := NewMemory()
	memory.accounts["account"] = Account{ID: "account"}
	memory.devices["primary"] = Device{ID: "primary", AccountID: "account", Platform: "mac", IsPrimary: true, TokenHash: "primary-token"}
	memory.devices["other"] = Device{ID: "other", AccountID: "account", Platform: "mac", TokenHash: "other-token"}
	requester := memory.devices["primary"]
	calls := 0
	beforeChange := func() error {
		calls++
		if memory.mu.TryLock() {
			memory.mu.Unlock()
			t.Error("回调未持有账号锁")
		}
		if !memory.devices["primary"].IsPrimary || memory.devices["other"].IsPrimary {
			t.Error("回调前已改变主角色")
		}
		return nil
	}
	if err := memory.SetPrimaryForSessionWithHook(ctx, requester, requester.ID, beforeChange); err != nil || calls != 0 {
		t.Fatal("同主设备重复设置不应废弃已有通道")
	}
	stale := requester
	stale.TokenHash = "stale-token"
	if err := memory.SetPrimaryForSessionWithHook(ctx, stale, "other", beforeChange); !errors.Is(err, ErrCredentialsChanged) || calls != 0 {
		t.Fatal("旧会话触发了通道清理")
	}
	if err := memory.SetPrimaryForSessionWithHook(ctx, requester, "missing", beforeChange); !errors.Is(err, ErrNotFound) || calls != 0 {
		t.Fatal("无效目标触发了通道清理")
	}
	failure := errors.New("test cache unavailable")
	if err := memory.SetPrimaryForSessionWithHook(ctx, requester, "other", func() error { return failure }); !errors.Is(err, failure) {
		t.Fatal("未返回配置通道清理错误")
	}
	if !memory.devices["primary"].IsPrimary || memory.devices["other"].IsPrimary {
		t.Fatal("通道清理失败仍然切换了主设备")
	}
	if err := memory.SetPrimaryForSessionWithHook(ctx, requester, "other", beforeChange); err != nil || calls != 1 {
		t.Fatal("合法换主没有恰好调用一次清理")
	}
	if memory.devices["primary"].IsPrimary || !memory.devices["other"].IsPrimary {
		t.Fatal("清理成功后主设备没有正确切换")
	}
}
