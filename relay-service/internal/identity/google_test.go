package identity

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TestVerifyGoogleAcceptsVerifiedEmail 确认已验证邮箱可以成为账号身份。
//
// 参数：t 为测试句柄。
// 返回值：无。
// 注意事项：使用本地 HTTP 替身，不访问 Google。
func TestVerifyGoogleAcceptsVerifiedEmail(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer token-1" {
			t.Fatalf("鉴权头错误")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"email":"User@Example.com","email_verified":true,"name":"测试"}`))
	}))
	defer server.Close()
	profile, err := NewGoogle(server.URL, time.Second).Verify(context.Background(), "token-1")
	if err != nil {
		t.Fatalf("校验失败: %v", err)
	}
	if profile.Email != "user@example.com" || profile.Name != "测试" {
		t.Fatalf("资料不正确: %+v", profile)
	}
}

// TestVerifyGoogleRejectsUnverifiedEmail 确认未验证邮箱不能登录。
//
// 参数：t 为测试句柄。
// 返回值：无。
// 注意事项：错误必须是 ErrUnauthorized，便于接口返回 401。
func TestVerifyGoogleRejectsUnverifiedEmail(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"email":"user@example.com","email_verified":false}`))
	}))
	defer server.Close()
	_, err := NewGoogle(server.URL, time.Second).Verify(context.Background(), "token-1")
	if err != ErrUnauthorized {
		t.Fatalf("期望未授权，实际 %v", err)
	}
}
