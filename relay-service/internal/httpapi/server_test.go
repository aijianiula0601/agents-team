package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"agents-team-relay/internal/identity"
	"agents-team-relay/internal/realtime"
	"agents-team-relay/internal/service"
	"agents-team-relay/internal/storage"
)

type stubGoogle struct{}

// Verify 返回固定测试账号。
//
// 参数：accessToken 不校验内容。
// 返回值：已验证邮箱。
// 注意事项：只用于接口测试。
func (stubGoogle) Verify(context.Context, string) (identity.Profile, error) {
	return identity.Profile{Email: "user@example.com", Name: "测试", Verified: true}, nil
}

// TestRelayFlow 通过 HTTP 走通登录、同步、下发和主设备回写。
//
// 参数：t 为测试句柄。
// 返回值：无。
// 注意事项：使用内存存储和无 Redis 的本机广播。
func TestRelayFlow(t *testing.T) {
	store := storage.NewMemory()
	hub := realtime.New(nil, "agents-team:test")
	svc := service.New(store, stubGoogle{}, hub, []byte("0123456789abcdef0123456789abcdef"), 100000)
	handler := New(svc, store, hub, "/agents-team").Handler()

	primary := login(t, handler, "mac-device-01", "mac")
	recorder := request(handler, http.MethodPut, "/agents-team/api/v1/state", primary.token, map[string]any{
		"baseRevision": 0,
		"state": map[string]any{
			"agents": []any{map[string]any{"id": "a1", "messages": []any{}}},
			"rooms":  []any{map[string]any{"id": "r1"}},
		},
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("保存快照失败: %s", recorder.Body.String())
	}
	phone := login(t, handler, "android-device-1", "android")
	recorder = request(handler, http.MethodPost, "/agents-team/api/v1/dispatches", phone.token, map[string]any{
		"clientRequestId": "req-phone-001",
		"mode":            "discuss",
		"roomId":          "r1",
		"userText":        "你好",
		"responders": []any{map[string]any{
			"agentId": "a1",
			"message": map[string]any{"id": "u1", "from": "you", "text": "你好"},
		}},
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("下发失败: %s", recorder.Body.String())
	}
	var created struct {
		Dispatch struct {
			ID string `json:"id"`
		} `json:"dispatch"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	claimed := request(handler, http.MethodPost, "/agents-team/api/v1/dispatches/claim", primary.token, map[string]any{})
	var lease struct {
		Dispatch struct {
			ClaimToken string `json:"claimToken"`
		} `json:"dispatch"`
	}
	if err := json.Unmarshal(claimed.Body.Bytes(), &lease); err != nil || lease.Dispatch.ClaimToken == "" {
		t.Fatalf("领取失败: %s", claimed.Body.String())
	}
	recorder = request(handler, http.MethodPost, "/agents-team/api/v1/dispatches/"+created.Dispatch.ID+"/result", primary.token, map[string]any{
		"status":     "done",
		"claimToken": lease.Dispatch.ClaimToken,
		"replies": []any{map[string]any{
			"agentId": "a1",
			"message": map[string]any{"id": "m1", "from": "a1", "text": "收到"},
		}},
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("回写失败: %s", recorder.Body.String())
	}
	recorder = request(handler, http.MethodGet, "/agents-team/api/v1/state", phone.token, nil)
	if recorder.Code != http.StatusOK || !bytes.Contains(recorder.Body.Bytes(), []byte("收到")) {
		t.Fatalf("手机没有同步到回复: %s", recorder.Body.String())
	}
	recorder = request(handler, http.MethodGet, "/health", "", nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("健康检查失败: %d", recorder.Code)
	}
}

type sessionToken struct {
	token string
}

// login 调用 Google 登录并取出设备令牌。
//
// 参数：handler 为接口；clientID 和 platform 描述设备。
// 返回值：设备令牌。失败时终止测试。
// 注意事项：访问令牌内容对测试替身没有意义。
func login(t *testing.T, handler http.Handler, clientID string, platform string) sessionToken {
	t.Helper()
	payload := map[string]any{"email": "user@example.com", "name": "测试", "password": "test-password-123", "action": "register", "device": map[string]string{"clientDeviceId": clientID, "name": clientID, "platform": platform}}
	recorder := request(handler, "POST", "/agents-team/api/v1/auth/email", "", payload)
	if recorder.Code == 409 {
		payload["action"] = "login"
		recorder = request(handler, "POST", "/agents-team/api/v1/auth/email", "", payload)
	}
	if recorder.Code != http.StatusOK {
		t.Fatalf("登录失败: %s", recorder.Body.String())
	}
	var session struct {
		DeviceToken string `json:"deviceToken"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &session); err != nil || session.DeviceToken == "" {
		t.Fatalf("登录响应缺少令牌: %s", recorder.Body.String())
	}
	return sessionToken{token: session.DeviceToken}
}

// request 发送一次 JSON 请求。
//
// 参数：method 和 path 为请求；token 为空时不带鉴权；payload 为请求体。
// 返回值：记录下来的响应。
// 注意事项：只用于测试。
func request(handler http.Handler, method string, path string, token string, payload any) *httptest.ResponseRecorder {
	var body bytes.Buffer
	if payload != nil {
		_ = json.NewEncoder(&body).Encode(payload)
	}
	req := httptest.NewRequest(method, path, &body)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	return recorder
}
