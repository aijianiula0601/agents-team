package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// TestHostPrimaryABAInvalidatesOldGeneration 验证主电脑 A→B→A 后相同原生公钥也不能恢复旧命令。
//
// 参数：t 为测试句柄。
// 返回值：无；旧 pending、running、回执或创建请求重新有效时失败。
// 注意事项：不模拟原生主动轮换 keyId，确保保护来自服务端账号锁中的世代失效。
func TestHostPrimaryABAInvalidatesOldGeneration(t *testing.T) {
	ctx := context.Background()
	f := newHostFixture(t)
	runningID := f.create(t, "model.get", map[string]any{})
	claimed := claimHostTest(t, request(f.a, http.MethodGet, "/agents-team/api/v1/host-config/commands", f.primary.token, nil))
	if claimed == nil || claimed.ID != runningID {
		t.Fatal("测试运行任务未领取")
	}
	pendingID := f.create(t, "harness.get", map[string]any{})
	primary, _, _ := f.svc.Authenticate(ctx, f.primary.token)
	other, _, _ := f.svc.Authenticate(ctx, f.other.token)
	if err := f.svc.SetPrimary(ctx, primary, primary.ID); err != nil {
		t.Fatal(err)
	}
	unchanged := request(f.b, http.MethodGet, "/agents-team/api/v1/host-config/key", f.phone.token, nil)
	var unchangedKey struct{ Key hostConfigKey }
	if unchanged.Code != 200 || json.Unmarshal(unchanged.Body.Bytes(), &unchangedKey) != nil || unchangedKey.Key.Generation != f.generation {
		t.Fatal("重复选择当前主电脑破坏了有效配置通道")
	}
	if err := f.svc.SetPrimary(ctx, primary, other.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.SetPrimary(ctx, other, primary.ID); err != nil {
		t.Fatal(err)
	}
	if response := request(f.b, http.MethodGet, "/agents-team/api/v1/host-config/key", f.phone.token, nil); response.Code != 409 {
		t.Fatal("A→B→A 自动恢复了旧主电脑公钥")
	}
	republished := request(f.a, http.MethodPut, "/agents-team/api/v1/host-config/key", f.primary.token, f.key)
	var current struct{ Key hostConfigKey }
	if republished.Code != 200 || json.Unmarshal(republished.Body.Bytes(), &current) != nil || current.Key.Generation == "" || current.Key.Generation == f.generation {
		t.Fatal("重新发布同原生公钥没有生成新的服务器世代")
	}
	stale := request(f.b, http.MethodPost, "/agents-team/api/v1/host-config/commands", f.phone.token, map[string]any{"id": uuid.NewString(), "targetDeviceId": f.key["targetDeviceId"], "keyId": f.key["keyId"], "generation": f.generation, "action": "model.get", "payload": map[string]any{}})
	if stale.Code != 409 {
		t.Fatal("旧世代仍然能够新建配置命令")
	}
	if result := request(f.b, http.MethodPut, "/agents-team/api/v1/host-config/commands/"+runningID, f.primary.token, map[string]any{"claimToken": claimed.ClaimToken, "result": map[string]any{}}); result.Code != 403 {
		t.Fatal("旧世代已领取任务能够回写结果")
	}
	if item := claimHostTest(t, request(f.b, http.MethodGet, "/agents-team/api/v1/host-config/commands", f.primary.token, nil)); item != nil {
		t.Fatal("旧世代 pending 或 running 任务被重新执行")
	}
	for _, id := range []string{runningID, pendingID} {
		response := request(f.a, http.MethodGet, "/agents-team/api/v1/host-config/commands/"+id, f.phone.token, nil)
		var result struct{ Command hostCommand }
		if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &result) != nil || result.Command.Status != "failed" {
			t.Fatalf("旧命令没有明确失败: %d %s", response.Code, response.Body.String())
		}
	}
	f.generation = current.Key.Generation
	fresh := f.create(t, "model.get", map[string]any{})
	if item := claimHostTest(t, request(f.b, http.MethodGet, "/agents-team/api/v1/host-config/commands", f.primary.token, nil)); item == nil || item.ID != fresh {
		t.Fatal("新世代任务无法正常执行")
	}
}

// TestHostPrimaryChangeRejectsCacheFailure 验证配置通道无法作废时不会切换主电脑。
//
// 参数：t 为测试句柄。
// 返回值：无；Redis 故障后角色被更改时失败。
// 注意事项：认证与设备查询仍使用内存数据库，故障只作用于通道失效阶段。
func TestHostPrimaryChangeRejectsCacheFailure(t *testing.T) {
	f := newHostFixture(t)
	ctx := context.Background()
	primary, _, _ := f.svc.Authenticate(ctx, f.primary.token)
	other, _, _ := f.svc.Authenticate(ctx, f.other.token)
	f.redis.SetError("test transient unavailable")
	if err := f.svc.SetPrimary(ctx, primary, other.ID); err == nil {
		t.Fatal("Redis 故障仍允许换主")
	}
	f.redis.SetError("")
	devices, err := f.svc.ListDevices(ctx, primary.AccountID)
	if err != nil {
		t.Fatal(err)
	}
	for _, device := range devices {
		if device.IsPrimary != (device.ID == primary.ID) {
			t.Fatal("清理通道失败破坏了原主设备身份")
		}
	}
}
