package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"agents-team-relay/internal/realtime"
	"agents-team-relay/internal/service"
	"agents-team-relay/internal/storage"

	"github.com/gorilla/websocket"
)

func TestGoogleBrowserAuthorizationAndPoll(t *testing.T) {
	store := storage.NewMemory()
	hub := realtime.New(nil, "oauth-test")
	key := []byte("0123456789abcdef0123456789abcdef")
	svc := service.New(store, stubGoogle{}, hub, key, 100000)
	tokenCalls := 0
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tokenCalls++
		r.ParseForm()
		if r.Form.Get("client_secret") != "secret" || r.Form.Get("code_verifier") == "" || r.Form.Get("redirect_uri") != "https://relay.example/agents-team/api/v1/auth/google/callback" {
			t.Error("Google exchange缺少client认证/PKCE/callback")
		}
		writeJSON(w, 200, map[string]string{"access_token": "verified-access-token", "token_type": "Bearer"})
	}))
	defer tokenServer.Close()
	server := New(svc, store, hub, "/agents-team").WithOAuth(OAuthConfig{ClientID: "client-id", ClientSecret: "secret", PublicURL: "https://relay.example/agents-team", TokenKey: key, TokenURL: tokenServer.URL})
	handler := server.Handler()
	start := request(handler, "POST", "/agents-team/api/v1/auth/google/start", "", map[string]any{"device": map[string]string{"clientDeviceId": "oauth-device-mac", "name": "Mac", "platform": "mac"}})
	if start.Code != 200 {
		t.Fatalf("start: %s", start.Body.String())
	}
	var auth struct {
		AuthID           string `json:"authId"`
		PollToken        string `json:"pollToken"`
		AuthorizationURL string `json:"authorizationUrl"`
	}
	if err := json.Unmarshal(start.Body.Bytes(), &auth); err != nil {
		t.Fatal(err)
	}
	authorization, err := url.Parse(auth.AuthorizationURL)
	if err != nil {
		t.Fatal(err)
	}
	q := authorization.Query()
	if authorization.Host != "accounts.google.com" || q.Get("code_challenge_method") != "S256" || q.Get("state") == "" || strings.Contains(auth.AuthorizationURL, auth.PollToken) {
		t.Fatal("浏览器地址必须是正式Google OAuth并保护poll秘密")
	}
	bad := request(handler, "POST", "/agents-team/api/v1/auth/google/poll", "", map[string]string{"authId": auth.AuthID, "pollToken": "wrong"})
	if bad.Code != 401 {
		t.Fatal("错误poll秘密未拒绝")
	}
	pending := request(handler, "POST", "/agents-team/api/v1/auth/google/poll", "", map[string]string{"authId": auth.AuthID, "pollToken": auth.PollToken})
	if !strings.Contains(pending.Body.String(), `"status":"pending"`) {
		t.Fatal(pending.Body.String())
	}
	callbackPath := "/agents-team/api/v1/auth/google/callback?state=" + url.QueryEscape(q.Get("state")) + "&code=authorization-code"
	callback := request(handler, "GET", callbackPath, "", nil)
	if callback.Code != 200 || tokenCalls != 1 {
		t.Fatal(callback.Body.String())
	}
	complete := request(handler, "POST", "/agents-team/api/v1/auth/google/poll", "", map[string]string{"authId": auth.AuthID, "pollToken": auth.PollToken})
	var done struct {
		Status  string `json:"status"`
		Session struct {
			DeviceToken string `json:"deviceToken"`
			Account     struct {
				Provider string `json:"provider"`
			}
		} `json:"session"`
	}
	json.Unmarshal(complete.Body.Bytes(), &done)
	if done.Status != "done" || done.Session.DeviceToken == "" || done.Session.Account.Provider != "google" {
		t.Fatalf("浏览器成功后未交付真实账号: %s", complete.Body.String())
	}
	if replay := request(handler, "GET", callbackPath, "", nil); replay.Code != 400 || tokenCalls != 1 {
		t.Fatal("OAuth state可以重复使用")
	}
	snapshot := request(handler, "GET", "/agents-team/api/v1/state", done.Session.DeviceToken, nil)
	if snapshot.Code != 200 {
		t.Fatal(snapshot.Body.String())
	}
}

func TestGoogleDisabledIsExplicitAndEmailNeedsPassword(t *testing.T) {
	store := storage.NewMemory()
	hub := realtime.New(nil, "config-test")
	svc := service.New(store, stubGoogle{}, hub, []byte("0123456789abcdef0123456789abcdef"), 100000)
	handler := New(svc, store, hub, "/agents-team").Handler()
	cfg := request(handler, "GET", "/agents-team/api/v1/config", "", nil)
	if cfg.Code != 200 || !strings.Contains(cfg.Body.String(), `"googleConfigured":false`) || !strings.Contains(cfg.Body.String(), `"passwordLoginEnabled":true`) {
		t.Fatal(cfg.Body.String())
	}
	start := request(handler, "POST", "/agents-team/api/v1/auth/google/start", "", map[string]any{})
	if start.Code != 503 || !strings.Contains(start.Body.String(), "GOOGLE_NOT_CONFIGURED") {
		t.Fatal(start.Body.String())
	}
	email := request(handler, "POST", "/agents-team/api/v1/auth/email", "", map[string]any{"email": "victim@example.com", "name": "attacker", "device": map[string]string{"clientDeviceId": "attacker-device", "platform": "mac"}})
	if email.Code != 400 {
		t.Fatal("只有email的请求仍可登录")
	}
}

func TestSocketTicketSingleUseAndAccountEvents(t *testing.T) {
	store := storage.NewMemory()
	hub := realtime.New(nil, "ws-test")
	svc := service.New(store, stubGoogle{}, hub, []byte("0123456789abcdef0123456789abcdef"), 100000)
	handler := New(svc, store, hub, "/agents-team").Handler()
	pc := login(t, handler, "socket-desktop", "mac")
	phone := login(t, handler, "socket-phone", "android")
	server := httptest.NewServer(handler)
	defer server.Close()
	ticketResponse := request(handler, "POST", "/agents-team/api/v1/realtime/ticket", phone.token, map[string]any{})
	var ticket struct {
		Ticket string `json:"ticket"`
	}
	json.Unmarshal(ticketResponse.Body.Bytes(), &ticket)
	if ticket.Ticket == "" {
		t.Fatal(ticketResponse.Body.String())
	}
	socketURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/agents-team/ws?ticket=" + url.QueryEscape(ticket.Ticket)
	conn, _, err := websocket.DefaultDialer.Dial(socketURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	var hello map[string]any
	if err := conn.ReadJSON(&hello); err != nil || hello["type"] != "hello" || hello["isPrimary"] != false {
		t.Fatalf("hello: %v %v", hello, err)
	}
	replay, replayResponse, replayErr := websocket.DefaultDialer.Dial(socketURL, nil)
	if replay != nil {
		replay.Close()
	}
	if replayErr == nil || replayResponse == nil || replayResponse.StatusCode != 401 {
		t.Fatal("连接票据可以重复使用")
	}
	response := request(handler, "PUT", "/agents-team/api/v1/state", pc.token, map[string]any{"baseRevision": 0, "state": map[string]any{"agents": []any{map[string]any{"id": "a1", "messages": []any{}}}, "rooms": []any{}}})
	if response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	var event map[string]any
	if err := conn.ReadJSON(&event); err != nil || event["type"] != "state.updated" || event["revision"] != float64(1) {
		t.Fatalf("实时通知: %v %v", event, err)
	}
	rawQuery := request(handler, "GET", "/agents-team/api/v1/state?access_token="+url.QueryEscape(phone.token), "", nil)
	if rawQuery.Code != 401 {
		t.Fatal("REST不应接受URL长期令牌")
	}
	// 另一个账号连接只能收到自身事件。
	other, err := svc.LoginEmail(context.Background(), "different@example.com", "other", "password123", "register", service.DeviceInput{ClientDeviceID: "other-ws-desktop", Platform: "mac"})
	if err != nil {
		t.Fatal(err)
	}
	otherTicket := request(handler, "POST", "/agents-team/api/v1/realtime/ticket", other.DeviceToken, map[string]any{})
	json.Unmarshal(otherTicket.Body.Bytes(), &ticket)
	isolated, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/agents-team/ws?ticket="+url.QueryEscape(ticket.Ticket), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer isolated.Close()
	var isolatedHello map[string]any
	isolated.ReadJSON(&isolatedHello)
	response = request(handler, "PUT", "/agents-team/api/v1/state", pc.token, map[string]any{"baseRevision": 1, "state": map[string]any{"agents": []any{}, "rooms": []any{}}})
	if response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	isolated.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
	if _, _, err := isolated.ReadMessage(); err == nil {
		t.Fatal("WebSocket接收到其他账号事件")
	}
	logout := request(handler, "POST", "/agents-team/api/v1/auth/logout", phone.token, map[string]any{})
	if logout.Code != 200 {
		t.Fatal(logout.Body.String())
	}
	if request(handler, "GET", "/agents-team/api/v1/state", phone.token, nil).Code != 401 {
		t.Fatal("退出后令牌仍然有效")
	}
}
