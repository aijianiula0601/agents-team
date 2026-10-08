package service

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"agents-team-relay/internal/storage"
)

// TestRemoteAgentConfigPreservesAccountState 验证同账号设备编辑配置且旧主电脑不能覆盖。
//
// 参数：t 为测试句柄。
// 返回值：无，配置、历史或版本隔离失效时失败。
// 注意事项：全程使用内存数据，覆盖与手机发消息交错的完整快照上传。
func TestRemoteAgentConfigPreservesAccountState(t *testing.T) {
	ctx := context.Background()
	svc, _ := testService()
	primary := testLogin(t, svc, "config@example.com", "config-desktop", "mac", "register")
	phone := testLogin(t, svc, "config@example.com", "config-phone", "android", "login")
	original := json.RawMessage(`{"agents":[{"id":"a1","name":"原始名字","messages":[{"id":"m1","from":"a1","text":"完整历史","replyTo":"user-1"}]}],"rooms":[{"id":"r1","messages":[]}],"harnessModels":{"codex":[{"id":"model-1"}]},"execution":{"running":{"agentId":"a1"}},"settings":{"localExecution":true}}`)
	if _, err := svc.SaveState(ctx, primary.Device, 0, original); err != nil {
		t.Fatal(err)
	}
	updated, err := svc.UpdateAgentConfig(ctx, phone.Device, "a1", 1, json.RawMessage(`{"name":"远端名字","backend":"codex","harness":"codex","harnessModel":"model-1","workspaceMode":"auto","workspace":"","temperature":0.5}`))
	if err != nil || updated.Revision != 2 || configRevision(updated.Body) != 1 {
		t.Fatalf("配置未成功保存: %v", err)
	}
	for _, expected := range []string{"远端名字", "完整历史", `"replyTo":"user-1"`, `"harnessModels"`, `"running":{"agentId":"a1"}`, `"rooms"`, `"localExecution":true`} {
		if !strings.Contains(string(updated.Body), expected) {
			t.Fatalf("配置编辑意外丢失其他账号资料: %s", expected)
		}
	}
	if _, err := svc.SaveState(ctx, primary.Device, 2, original); businessCode(err) != "REVISION_CONFLICT" {
		t.Fatalf("旧配置借用新聊天版本覆盖了远端修改: %v", err)
	}
	if _, err := svc.UpdateAgentConfig(ctx, phone.Device, "a1", 1, json.RawMessage(`{"role":"冲突修改"}`)); businessCode(err) != "REVISION_CONFLICT" {
		t.Fatalf("旧版本编辑没有冲突: %v", err)
	}
	if saved, err := svc.SaveState(ctx, primary.Device, 2, updated.Body); err != nil || configRevision(saved.Body) != 1 {
		t.Fatalf("主电脑同步最新配置后不能继续上传: %v", err)
	}
}

// TestAgentConfigRejectsProtectedFieldsAndCrossAccount 验证修改范围、账号边界和会话撤销。
//
// 参数：t 为测试句柄。
// 返回值：无，非法输入或失效会话被接受时失败。
// 注意事项：不允许通过配置接口修改消息、密钥、设备归属或模型目录。
func TestAgentConfigRejectsProtectedFieldsAndCrossAccount(t *testing.T) {
	ctx := context.Background()
	svc, _ := testService()
	primary := testLogin(t, svc, "protected@example.com", "protected-desktop", "mac", "register")
	phone := testLogin(t, svc, "protected@example.com", "protected-phone", "android", "login")
	_, err := svc.SaveState(ctx, primary.Device, 0, json.RawMessage(`{"agents":[{"id":"a1","name":"原名字","messages":[]}],"rooms":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{`{"messages":[]}`, `{"apiKey":"secret"}`, `{"id":"other"}`, `{"deviceId":"other"}`, `{"harnessModels":{}}`, `{"notify":true}`, `{"temperature":"1"}`, `{"name":""}`, `{"workspaceMode":"other"}`, `{"backend":"arbitrary"}`} {
		if _, err := svc.UpdateAgentConfig(ctx, phone.Device, "a1", 1, json.RawMessage(raw)); businessCode(err) != "INVALID" {
			t.Fatalf("非法配置被接受: %s (%v)", raw, err)
		}
	}
	outsider := testLogin(t, svc, "outsider@example.com", "outsider-desktop", "mac", "register")
	if _, err := svc.UpdateAgentConfig(ctx, outsider.Device, "a1", 0, json.RawMessage(`{"name":"越权"}`)); businessCode(err) != "AGENT_NOT_FOUND" {
		t.Fatalf("可以修改其他账号 Agent: %v", err)
	}
	current := testLogin(t, svc, "protected@example.com", "protected-phone", "android", "login")
	if _, err := svc.UpdateAgentConfig(ctx, phone.Device, "a1", 1, json.RawMessage(`{"name":"旧会话"}`)); businessCode(err) != "UNAUTHORIZED" {
		t.Fatalf("轮换前会话仍能修改配置: %v", err)
	}
	if err := svc.RevokeDevice(ctx, current.Device, current.Device.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpdateAgentConfig(ctx, current.Device, "a1", 1, json.RawMessage(`{"name":"被删除设备"}`)); businessCode(err) != "UNAUTHORIZED" {
		t.Fatalf("已删除设备仍能修改配置: %v", err)
	}
}

// TestDeletingPrimaryLeavesExplicitSelectionAndRecoverableLease 验证删除主电脑不会提升离线电脑或永久卡住任务。
//
// 参数：t 为测试句柄。
// 返回值：无，设备身份、旧令牌或任务恢复不正确时失败。
// 注意事项：旧执行者在领取到期前仍可能退出中，保留有限期租约可避免新电脑重复执行。
func TestDeletingPrimaryLeavesExplicitSelectionAndRecoverableLease(t *testing.T) {
	ctx := context.Background()
	svc, store := testService()
	primary := testLogin(t, svc, "delete@example.com", "delete-desktop", "mac", "register")
	other := testLogin(t, svc, "delete@example.com", "remaining-desktop", "mac", "login")
	_, err := svc.SaveState(ctx, primary.Device, 0, json.RawMessage(`{"agents":[{"id":"a1","messages":[]}],"rooms":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	job, _, err := svc.CreateDispatch(ctx, other.Device, DispatchInput{ClientRequestID: "delete-job", AgentID: "a1", Mode: "discuss", UserText: "任务", UserMessage: json.RawMessage(`{"id":"delete-job","text":"任务"}`), Responders: []MessageInput{{AgentID: "a1"}}})
	if err != nil {
		t.Fatal(err)
	}
	claim, err := svc.ClaimDispatch(ctx, primary.Device)
	if err != nil || claim == nil {
		t.Fatal("主电脑未领取测试任务")
	}
	if err := svc.RevokeDevice(ctx, primary.Device, primary.Device.ID); err != nil {
		t.Fatal(err)
	}
	devices, err := svc.ListDevices(ctx, primary.Account.ID)
	if err != nil || len(devices) != 1 || devices[0].IsPrimary {
		t.Fatal("删除后不应自动选择其他电脑")
	}
	if _, _, err := svc.Authenticate(ctx, primary.DeviceToken); businessCode(err) != "UNAUTHORIZED" {
		t.Fatal("删除设备未撤销认证令牌")
	}
	if _, _, err := svc.CompleteDispatch(ctx, primary.Device, job.ID, ResultInput{Status: "running", ClaimToken: claim.ClaimToken}); businessCode(err) != "UNAUTHORIZED" {
		t.Fatal("已删除执行者仍可续租")
	}
	if err := svc.SetPrimary(ctx, other.Device, other.Device.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.WithAccount(ctx, other.Account.ID, func(tx storage.Tx) error {
		lease, err := tx.Claim(ctx, job.ID)
		if err != nil {
			return err
		}
		lease.ExpiresAt = time.Now().Add(-time.Second)
		return tx.SaveClaim(ctx, lease)
	}); err != nil {
		t.Fatal(err)
	}
	if recovered, err := svc.ClaimDispatch(ctx, other.Device); err != nil || recovered == nil || recovered.ID != job.ID || recovered.ClaimToken == claim.ClaimToken {
		t.Fatalf("新主电脑无法恢复已删除设备的任务: %v", err)
	}
}

// TestDeletedPrimaryOldRequestsCannotUseRelogin 验证删除后重新登录不会复活先前已认证的在途请求。
//
// 参数：t 为测试句柄。
// 返回值：无，旧会话可写配置或领取任务时失败。
// 注意事项：新登录复用设备编号但轮换令牌，事务必须校验令牌版本。
func TestDeletedPrimaryOldRequestsCannotUseRelogin(t *testing.T) {
	ctx := context.Background()
	svc, _ := testService()
	old := testLogin(t, svc, "relogin@example.com", "same-desktop", "mac", "register")
	if err := svc.RevokeDevice(ctx, old.Device, old.Device.ID); err != nil {
		t.Fatal(err)
	}
	current := testLogin(t, svc, "relogin@example.com", "same-desktop", "mac", "login")
	if current.Device.ID != old.Device.ID || current.Device.TokenHash == old.Device.TokenHash {
		t.Fatal("测试没有复现设备编号复用与令牌轮换")
	}
	state := json.RawMessage(`{"agents":[{"id":"a1","messages":[]}],"rooms":[]}`)
	if _, err := svc.SaveState(ctx, old.Device, 0, state); businessCode(err) != "UNAUTHORIZED" {
		t.Fatalf("旧会话借新登录主设备身份上传: %v", err)
	}
	if _, err := svc.ClaimDispatch(ctx, old.Device); businessCode(err) != "UNAUTHORIZED" {
		t.Fatalf("旧会话借新登录主设备身份领取: %v", err)
	}
	if _, err := svc.SaveState(ctx, current.Device, 0, state); err != nil {
		t.Fatalf("新会话受旧令牌失效影响: %v", err)
	}
}

// TestGroupRepliesAllowMentionsFollowupsAndSilence 验证实际群聊中的转发成员、同人补充及全员沉默。
//
// 参数：t 为测试句柄。
// 返回值：无，合法群聊回复被过滤或越权成员被接受时失败。
// 注意事项：成员按当前房间校验，不能限制到首条用户消息初选的 responders。
func TestGroupRepliesAllowMentionsFollowupsAndSilence(t *testing.T) {
	ctx := context.Background()
	svc, _ := testService()
	primary := testLogin(t, svc, "group@example.com", "group-desktop", "mac", "register")
	body := json.RawMessage(`{"agents":[{"id":"a1","messages":[]},{"id":"a2","messages":[]},{"id":"outside","messages":[]}],"rooms":[{"id":"r1","agentIds":["a1","a2"],"messages":[]}]}`)
	if _, err := svc.SaveState(ctx, primary.Device, 0, body); err != nil {
		t.Fatal(err)
	}
	for _, requestID := range []string{"group-mentions", "group-silent"} {
		job, _, err := svc.CreateDispatch(ctx, primary.Device, DispatchInput{ClientRequestID: requestID, RoomID: "r1", Mode: "discuss", UserText: "请判断是否需要回复", UserMessage: json.RawMessage(`{"id":"` + requestID + `","text":"请判断是否需要回复"}`), Responders: []MessageInput{{AgentID: "a1"}}})
		if err != nil {
			t.Fatal(err)
		}
		lease, err := svc.ClaimDispatch(ctx, primary.Device)
		if err != nil || lease == nil {
			t.Fatal("群聊任务未能领取")
		}
		replies := []MessageInput{}
		if requestID == "group-mentions" {
			replies = []MessageInput{
				{AgentID: "a1", Message: json.RawMessage(`{"id":"reply-1","replyTo":"group-mentions","text":"@a2 请补充"}`)},
				{AgentID: "a2", Message: json.RawMessage(`{"id":"reply-2","replyTo":"reply-1","text":"我的补充"}`)},
				{AgentID: "a1", Message: json.RawMessage(`{"id":"reply-3","replyTo":"reply-2","text":"收到后补充说明"}`)},
			}
			invalid := ResultInput{Status: "done", ClaimToken: lease.ClaimToken, Replies: []MessageInput{{AgentID: "outside", Message: json.RawMessage(`{"id":"bad","text":"非成员"}`)}}}
			if _, _, err := svc.CompleteDispatch(ctx, primary.Device, job.ID, invalid); businessCode(err) != "INVALID" {
				t.Fatalf("非群成员被接受: %v", err)
			}
		}
		completed, _, err := svc.CompleteDispatch(ctx, primary.Device, job.ID, ResultInput{Status: "done", ClaimToken: lease.ClaimToken, Replies: replies})
		if err != nil || completed.Status != "done" {
			t.Fatalf("群聊 @ 接力或静默完成失败: %v", err)
		}
	}
	current, _ := svc.LoadState(ctx, primary.Account.ID)
	var snapshot struct {
		Rooms []struct {
			Messages []map[string]any
		}
	}
	if err := json.Unmarshal(current.Body, &snapshot); err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Rooms) != 1 || len(snapshot.Rooms[0].Messages) != 5 || snapshot.Rooms[0].Messages[2]["replyTo"] != "reply-1" || snapshot.Rooms[0].Messages[3]["from"] != "a1" {
		t.Fatal("群聊消息或 replyTo 关联未完整保存")
	}
}
