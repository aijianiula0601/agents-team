package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"agents-team-relay/internal/identity"
	"agents-team-relay/internal/storage"
)

func testService() (*Service, *storage.Memory) {
	store := storage.NewMemory()
	return New(store, fakeGoogle{profile: identity.Profile{Email: "google@example.com", Verified: true}}, nil, []byte("0123456789abcdef0123456789abcdef"), 32000000), store
}
func testLogin(t *testing.T, s *Service, email, id, platform, action string) Session {
	t.Helper()
	session, err := s.LoginEmail(context.Background(), email, "测试", "secure-password", action, DeviceInput{ClientDeviceID: id, Name: id, Platform: platform})
	if err != nil {
		t.Fatal(err)
	}
	return session
}
func businessCode(err error) string {
	var b *Error
	if errors.As(err, &b) {
		return b.Code
	}
	return ""
}

func TestPasswordAuthenticationAndProviderIsolation(t *testing.T) {
	s, store := testService()
	ctx := context.Background()
	owner := testLogin(t, s, "owner@example.com", "mac-owner", "mac", "register")
	if _, err := s.LoginEmail(ctx, "owner@example.com", "", "wrong-password", "login", DeviceInput{ClientDeviceID: "mac-attacker", Platform: "mac"}); businessCode(err) != "UNAUTHORIZED" {
		t.Fatalf("错误密码必须拒绝: %v", err)
	}
	if _, err := s.LoginEmail(ctx, "owner@example.com", "", "", "login", DeviceInput{ClientDeviceID: "mac-attacker", Platform: "mac"}); businessCode(err) != "INVALID_PASSWORD" {
		t.Fatalf("只有email不能登录: %v", err)
	}
	if _, err := s.LoginEmail(ctx, "owner@example.com", "", "new-password", "register", DeviceInput{ClientDeviceID: "mac-attacker", Platform: "mac"}); businessCode(err) != "ACCOUNT_EXISTS" {
		t.Fatalf("注册不能接管已有账号: %v", err)
	}
	s.verifier = fakeGoogle{profile: identity.Profile{Email: "owner@example.com", Verified: true}}
	if _, err := s.LoginGoogle(ctx, "real-token", DeviceInput{ClientDeviceID: "mac-google", Platform: "mac"}); businessCode(err) != "PROVIDER_CONFLICT" {
		t.Fatalf("登录方式不能自动关联: %v", err)
	}
	account, _ := store.FindAccountByEmail(ctx, "owner@example.com")
	if account.Provider != "email" || account.ID != owner.Account.ID {
		t.Fatal("冲突修改了原账号")
	}
	s.verifier = fakeGoogle{profile: identity.Profile{Email: "unverified@example.com", Verified: false}}
	if _, err := s.LoginGoogle(ctx, "token", DeviceInput{ClientDeviceID: "mac-google", Platform: "mac"}); businessCode(err) != "UNAUTHORIZED" {
		t.Fatalf("未验证的Google邮箱不授予身份: %v", err)
	}
}

func TestMobileFirstCannotExecuteOrOverwriteAccount(t *testing.T) {
	s, _ := testService()
	ctx := context.Background()
	phone := testLogin(t, s, "mobile@example.com", "phone-first", "android", "register")
	if phone.Device.IsPrimary {
		t.Fatal("先登录的手机不能成为主设备")
	}
	pc := testLogin(t, s, "mobile@example.com", "desktop-second", "mac", "login")
	if !pc.Device.IsPrimary {
		t.Fatal("首台电脑应成为主设备")
	}
	state := json.RawMessage(`{"agents":[{"id":"a1","messages":[]}],"rooms":[{"id":"r1","agentIds":["a1"],"messages":[]}],"execution":{"running":null}}`)
	if _, err := s.SaveState(ctx, phone.Device, 0, state); businessCode(err) != "NOT_PRIMARY" {
		t.Fatalf("手机不能写快照: %v", err)
	}
	if _, err := s.SaveState(ctx, pc.Device, 0, state); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ClaimDispatch(ctx, phone.Device); businessCode(err) != "NOT_PRIMARY" {
		t.Fatalf("手机不能领取: %v", err)
	}
	if err := s.SetPrimary(ctx, phone.Device, phone.Device.ID); businessCode(err) != "DESKTOP_REQUIRED" {
		t.Fatalf("手机不能成为primary: %v", err)
	}
	outsider := testLogin(t, s, "other@example.com", "other-desktop", "mac", "register")
	if _, err := s.GetDispatch(ctx, outsider.Account.ID, "missing"); businessCode(err) != "NOT_FOUND" {
		t.Fatal(err)
	}
	if err := s.RevokeDevice(ctx, pc.Device, pc.Device.ID); err != nil {
		t.Fatal(err)
	}
	devices, _ := s.ListDevices(ctx, pc.Account.ID)
	if len(devices) != 1 || devices[0].IsPrimary {
		t.Fatal("不能把电脑身份移交给手机")
	}
	if _, _, err := s.Authenticate(ctx, pc.DeviceToken); businessCode(err) != "UNAUTHORIZED" {
		t.Fatal("撤销的令牌仍然可用")
	}
}

func TestDispatchLeaseConcurrencyExpiryAndRoomRouting(t *testing.T) {
	s, store := testService()
	ctx := context.Background()
	pc := testLogin(t, s, "lease@example.com", "lease-desktop", "mac", "register")
	phone := testLogin(t, s, "lease@example.com", "lease-phone", "android", "login")
	state := json.RawMessage(`{"agents":[{"id":"a1","messages":[]}],"rooms":[{"id":"r1","agentIds":["a1"],"messages":[]}]}`)
	if _, err := s.SaveState(ctx, pc.Device, 0, state); err != nil {
		t.Fatal(err)
	}
	input := DispatchInput{ClientRequestID: "request-one", Mode: "discuss", RoomID: "r1", UserText: "你好", UserMessage: json.RawMessage(`{"id":"request-one","from":"a1","text":"你好"}`), Responders: []MessageInput{{AgentID: "a1"}}, Attachments: json.RawMessage(`[{"name":"notes.txt","text":"原始附件"}]`)}
	job, rev, err := s.CreateDispatch(ctx, phone.Device, input)
	if err != nil || rev != 2 {
		t.Fatal(err)
	}
	again, _, err := s.CreateDispatch(ctx, phone.Device, input)
	if err != nil || again.ID != job.ID {
		t.Fatal("幂等请求产生了多个任务")
	}
	var leases []*DispatchRecord
	var mu sync.Mutex
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			claim, err := s.ClaimDispatch(ctx, pc.Device)
			if err != nil {
				t.Error(err)
			}
			if claim != nil {
				mu.Lock()
				leases = append(leases, claim)
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if len(leases) != 1 {
		t.Fatalf("同时领取应只有一个成功，实际%d", len(leases))
	}
	lease := leases[0]
	if string(lease.Attachments) != string(input.Attachments) || lease.ClaimToken == "" {
		t.Fatal("领取丢失附件或令牌")
	}
	if _, _, err := s.CompleteDispatch(ctx, pc.Device, job.ID, ResultInput{Status: "done", ClaimToken: "bad"}); businessCode(err) != "CLAIM_REQUIRED" {
		t.Fatal("错误领取令牌可回写")
	}
	if err := store.WithAccount(ctx, pc.Account.ID, func(tx storage.Tx) error {
		claim, err := tx.Claim(ctx, job.ID)
		if err != nil {
			return err
		}
		claim.ExpiresAt = time.Now().Add(-time.Second)
		return tx.SaveClaim(ctx, claim)
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.CompleteDispatch(ctx, pc.Device, job.ID, ResultInput{Status: "running", ClaimToken: lease.ClaimToken}); businessCode(err) != "CLAIM_EXPIRED" {
		t.Fatal("过期租约未拒绝")
	}
	fresh, err := s.ClaimDispatch(ctx, pc.Device)
	if err != nil || fresh == nil || fresh.ClaimToken == lease.ClaimToken {
		t.Fatal("过期任务不能重领")
	}
	result := ResultInput{Status: "done", ClaimToken: fresh.ClaimToken, Replies: []MessageInput{{AgentID: "a1", Message: json.RawMessage(`{"id":"reply-one","from":"you","text":"电脑回复"}`)}}}
	_, revision, err := s.CompleteDispatch(ctx, pc.Device, job.ID, result)
	if err != nil || revision != 3 {
		t.Fatal(err)
	}
	_, revision2, err := s.CompleteDispatch(ctx, pc.Device, job.ID, result)
	if err != nil || revision2 != revision {
		t.Fatal("重复完成写入了重复消息")
	}
	snapshot, _ := s.LoadState(ctx, pc.Account.ID)
	var doc struct {
		Agents []struct{ Messages []json.RawMessage }
		Rooms  []struct{ Messages []map[string]any }
	}
	if err := json.Unmarshal(snapshot.Body, &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Agents[0].Messages) != 0 || len(doc.Rooms[0].Messages) != 2 || doc.Rooms[0].Messages[0]["from"] != "you" || doc.Rooms[0].Messages[1]["from"] != "a1" {
		t.Fatalf("团队消息路由或来源错误: %s", snapshot.Body)
	}
	outsider := testLogin(t, s, "isolated@example.com", "isolated-desktop", "mac", "register")
	if _, err := s.GetDispatch(ctx, outsider.Account.ID, job.ID); businessCode(err) != "NOT_FOUND" {
		t.Fatal("可读取其他账号任务")
	}
}

func TestPrivateMessageSourceAndFullHistory(t *testing.T) {
	messages := make([]any, 301)
	for i := range messages {
		messages[i] = map[string]any{"id": fmt.Sprintf("old-%d", i), "from": "a1", "text": "旧聊天"}
	}
	body, _ := json.Marshal(map[string]any{"agents": []any{map[string]any{"id": "a1", "messages": messages}}, "rooms": []any{}})
	user := json.RawMessage(`{"id":"user-message","from":"a1","text":"新聊天"}`)
	saved, err := appendDispatchMessages(body, "", "a1", user, []MessageInput{{AgentID: "a1"}}, true, 100000)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(saved), "old-0") || !strings.Contains(string(saved), `"from":"you"`) {
		t.Fatal("历史被截断或私聊用户来源未规范化")
	}
	var doc struct{ Agents []struct{ Messages []any } }
	json.Unmarshal(saved, &doc)
	if len(doc.Agents[0].Messages) != 302 {
		t.Fatal("没有保留所有消息")
	}
	if _, err := sanitizeState(saved, 1024); err == nil {
		t.Fatal("超限应明确失败")
	}
}

func TestSnapshotStripsNestedConfigurationCredentials(t *testing.T) {
	input := json.RawMessage(`{"agents":[{"id":"a1","apiKey":"agent-secret","headers":{"Authorization":"secret-header"},"messages":[{"id":"m1","text":"用户正文保留","password":"用户消息字段"}]}],"rooms":[],"settings":{"models":{"openai":{"api_key":"model-secret"}}},"relaySession":{"deviceToken":"device-secret"},"execution":{"running":null}}`)
	clean, err := sanitizeState(input, 100000)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"agent-secret", "secret-header", "model-secret", "device-secret"} {
		if strings.Contains(string(clean), secret) {
			t.Fatalf("配置凭据进入快照: %s", secret)
		}
	}
	if !strings.Contains(string(clean), "用户消息字段") || !strings.Contains(string(clean), "execution") {
		t.Fatal("普通消息或执行状态被删除")
	}
}

// TestLargeAttachmentDispatchAndFullTeam 验证附件展开文本与大团队都可经实际任务存储和领取链路转发。
func TestLargeAttachmentDispatchAndFullTeam(t *testing.T) {
	svc, _ := testService()
	ctx := context.Background()
	pc := testLogin(t, svc, "large-team@example.com", "large-team-desktop", "mac", "register")
	phone := testLogin(t, svc, "large-team@example.com", "large-team-phone", "android", "login")
	agents := make([]any, 200)
	members := make([]string, 200)
	responders := make([]MessageInput, 200)
	for i := range agents {
		id := fmt.Sprintf("agent-%03d", i)
		members[i] = id
		agents[i] = map[string]any{"id": id, "messages": []any{}}
		responders[i] = MessageInput{AgentID: id}
	}
	snapshot, _ := json.Marshal(map[string]any{"agents": agents, "rooms": []any{map[string]any{"id": "large-room", "agentIds": members, "messages": []any{}}}})
	if _, err := svc.SaveState(ctx, pc.Device, 0, snapshot); err != nil {
		t.Fatal(err)
	}
	expanded := strings.Repeat("附件内容", 130000)
	input := DispatchInput{ClientRequestID: "large-team-request", Mode: "execute", RoomID: "large-room", UserText: expanded, UserMessage: json.RawMessage(`{"id":"large-team-request","from":"you","text":"请处理附件"}`), Responders: responders, Attachments: json.RawMessage(`[{"name":"notes.txt","size":512000,"text":"完整附件内容"}]`)}
	job, _, err := svc.CreateDispatch(ctx, phone.Device, input)
	if err != nil {
		t.Fatalf("大附件或200成员团队被拒绝: %v", err)
	}
	claim, err := svc.ClaimDispatch(ctx, pc.Device)
	if err != nil || claim == nil || claim.ID != job.ID || claim.UserText != expanded || len(claim.Responders) != 200 {
		t.Fatalf("转发任务丢失展开正文或成员: %v", err)
	}
	input.ClientRequestID = "too-large-request"
	input.UserMessage = json.RawMessage(`{"id":"too-large-request","from":"you","text":"超限"}`)
	input.UserText = strings.Repeat("x", 1_000_001)
	if _, _, err := svc.CreateDispatch(ctx, phone.Device, input); businessCode(err) != "INVALID" {
		t.Fatalf("展开文本超限应明确拒绝: %v", err)
	}
	input.UserText = "hello"
	input.Responders = append(input.Responders, MessageInput{AgentID: "agent-200"})
	if _, _, err := svc.CreateDispatch(ctx, phone.Device, input); businessCode(err) != "INVALID" {
		t.Fatalf("201成员超限应明确拒绝: %v", err)
	}
}

func TestPreviouslyQueuedDispatchPreservesSnapshotMessageAndReplyIDs(t *testing.T) {
	for _, test := range []struct {
		name    string
		room    bool
		payload json.RawMessage
	}{
		{"private", false, json.RawMessage(`{"agentId":"a1","userMessage":{"id":"u1","from":"spoofed","text":"previous message"},"responders":[{"agentId":"a1"}]}`)},
		{"team", true, json.RawMessage(`{"userMessage":{"id":"u1","from":"spoofed","text":"previous message"},"responders":[{"agentId":"a1"}]}`)},
		{"legacy-private", false, json.RawMessage(`[{"agentId":"a1","message":{"id":"u1","from":"spoofed","text":"previous message"}}]`)},
		{"legacy-team", true, json.RawMessage(`[{"agentId":"a1","message":{"id":"u1","from":"spoofed","text":"previous message"}}]`)},
	} {
		t.Run(test.name, func(t *testing.T) {
			svc, store := testService()
			ctx := context.Background()
			pc := testLogin(t, svc, "queued@example.com", "queued-desktop", "mac", "register")
			messages := []any{map[string]any{"id": "u1", "from": "you", "text": "previous message"}, map[string]any{"id": "reply-1", "from": "a1", "text": "previous reply", "requestId": "u1"}}
			agent := map[string]any{"id": "a1", "messages": []any{}}
			room := map[string]any{"id": "r1", "agentIds": []string{"a1"}, "messages": []any{}}
			if test.room {
				room["messages"] = messages
			} else {
				agent["messages"] = messages
			}
			snapshot, _ := json.Marshal(map[string]any{"agents": []any{agent}, "rooms": []any{room}})
			if _, err := svc.SaveState(ctx, pc.Device, 0, snapshot); err != nil {
				t.Fatal(err)
			}
			before, err := store.LoadState(ctx, pc.Account.ID)
			if err != nil {
				t.Fatal(err)
			}
			item := storage.Dispatch{ID: "previous-dispatch", AccountID: pc.Account.ID, SourceDeviceID: pc.Device.ID, ClientRequestID: "queued-request", Mode: "discuss", UserText: "previous message", Payload: test.payload, Status: "pending", CreatedAt: time.Now(), UpdatedAt: time.Now()}
			if test.room {
				item.RoomID = "r1"
			}
			if err := store.WithAccount(ctx, pc.Account.ID, func(tx storage.Tx) error { return tx.InsertDispatch(ctx, item) }); err != nil {
				t.Fatal(err)
			}
			view, err := svc.GetDispatch(ctx, pc.Account.ID, item.ID)
			if err != nil {
				t.Fatal(err)
			}
			claim, err := svc.ClaimDispatch(ctx, pc.Device)
			if err != nil || claim == nil {
				t.Fatal(err)
			}
			for _, raw := range []json.RawMessage{view.UserMessage, claim.UserMessage} {
				var message map[string]any
				if err := json.Unmarshal(raw, &message); err != nil {
					t.Fatal(err)
				}
				if message["from"] != "you" || message["id"] != "u1" || message["text"] != "previous message" {
					t.Fatalf("historical queue delivered spoofed sender: %s", raw)
				}
			}
			for _, responder := range claim.Responders {
				if len(responder.Message) == 0 {
					continue
				}
				var message map[string]any
				if err := json.Unmarshal(responder.Message, &message); err != nil || message["id"] != "u1" || message["from"] != "you" {
					t.Fatalf("historical responder message changed identity: %s", responder.Message)
				}
			}
			after, err := store.LoadState(ctx, pc.Account.ID)
			if err != nil || after.Revision != before.Revision || !bytes.Equal(after.Body, before.Body) {
				t.Fatalf("claim changed historical snapshot or reply references: %v", err)
			}
			var document struct {
				Agents []struct{ Messages []map[string]any }
				Rooms  []struct{ Messages []map[string]any }
			}
			if err := json.Unmarshal(after.Body, &document); err != nil {
				t.Fatal(err)
			}
			existing := document.Agents[0].Messages
			if test.room {
				existing = document.Rooms[0].Messages
			}
			var queued map[string]any
			json.Unmarshal(claim.UserMessage, &queued)
			if len(existing) != 2 || existing[0]["id"] != queued["id"] || existing[1]["requestId"] != queued["id"] {
				t.Fatal("desktop message deduplication and completed reply lookup must match the original u1")
			}
		})
	}
}

func TestHistoricalUserMessageFallsBackOnlyWhenIDMissing(t *testing.T) {
	for _, raw := range []json.RawMessage{json.RawMessage(`{"text":"old"}`), json.RawMessage(`{"id":"","text":"old"}`), json.RawMessage(`{"id":123,"text":"old"}`)} {
		canonical, err := historicalUserMessage(raw, "queued-request")
		if err != nil {
			t.Fatal(err)
		}
		var message map[string]any
		json.Unmarshal(canonical, &message)
		if message["id"] != "queued-request" || message["from"] != "you" {
			t.Fatalf("historical message without a string ID lacked fallback: %s", canonical)
		}
	}
}
