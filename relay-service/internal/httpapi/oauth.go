package httpapi

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"agents-team-relay/internal/auth"
	"agents-team-relay/internal/service"

	"github.com/google/uuid"
)

// OAuthConfig 保存服务端 Web OAuth 配置；密钥只由进程环境注入。
type OAuthConfig struct {
	ClientID     string
	ClientSecret string
	PublicURL    string
	TokenKey     []byte
	Timeout      time.Duration
	// TokenURL 默认使用 Google 官方端点；测试中可以注入本机替身。
	TokenURL string
}

func (s *Server) WithOAuth(cfg OAuthConfig) *Server {
	if cfg.Timeout <= 0 {
		cfg.Timeout = 8 * time.Second
	}
	if cfg.TokenURL == "" {
		cfg.TokenURL = "https://oauth2.googleapis.com/token"
	}
	s.oauth = cfg
	return s
}
func (s *Server) googleConfigured() bool {
	return s.oauth.ClientID != "" && s.oauth.ClientSecret != "" && strings.HasPrefix(s.oauth.PublicURL, "https://") && len(s.oauth.TokenKey) == 32
}
func (s *Server) publicConfig(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"googleConfigured": s.googleConfigured(), "websocketEnabled": s.hub != nil, "passwordLoginEnabled": true, "protocolVersion": 2})
}

type oauthRequest struct {
	AuthID       string              `json:"authId"`
	PollHash     string              `json:"pollHash"`
	Device       service.DeviceInput `json:"device"`
	CodeVerifier string              `json:"codeVerifier"`
}
type oauthPoll struct {
	Status       string         `json:"status"`
	ErrorMessage string         `json:"errorMessage,omitempty"`
	Session      map[string]any `json:"session,omitempty"`
}

// allowLogin 为匿名认证接口限速，避免密码爆破和大量创建 OAuth 请求。
func (s *Server) allowLogin(w http.ResponseWriter, r *http.Request, scope string) bool {
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		ip = r.RemoteAddr
	}
	sum := sha256.Sum256([]byte(ip))
	if s.hub == nil || !s.hub.AllowAttempt(r.Context(), scope+":"+base64.RawURLEncoding.EncodeToString(sum[:]), 30, time.Minute) {
		w.Header().Set("Retry-After", "60")
		writeError(w, http.StatusTooManyRequests, "RATE_LIMITED", "登录请求过于频繁，请稍后重试")
		return false
	}
	return true
}
func (s *Server) saveEncrypted(ctx context.Context, key string, value any, ttl time.Duration) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	sealed, err := auth.Seal(s.oauth.TokenKey, raw)
	if err != nil {
		return err
	}
	return s.hub.PutTransient(ctx, key, sealed, ttl)
}
func (s *Server) decodeEncrypted(raw string, dest any) error {
	body, err := auth.Open(s.oauth.TokenKey, raw)
	if err != nil {
		return err
	}
	return json.Unmarshal(body, dest)
}

// googleStart 生成标准 authorization code + PKCE 授权地址，浏览器回调只携带随机 state。
func (s *Server) googleStart(w http.ResponseWriter, r *http.Request) {
	if !s.googleConfigured() {
		writeError(w, 503, "GOOGLE_NOT_CONFIGURED", "中转站尚未配置 Google Web OAuth，请管理员配置登录应用")
		return
	}
	if !s.allowLogin(w, r, "google-start") {
		return
	}
	var req struct {
		Device deviceInput `json:"device"`
	}
	if !decodeBody(w, r, 16384, &req) {
		return
	}
	input := req.Device.toService()
	if err := service.ValidateDevice(input); err != nil {
		writeServiceError(w, err)
		return
	}
	state, _, err := auth.NewDeviceToken(s.oauth.TokenKey)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	poll, hash, err := auth.NewDeviceToken(s.oauth.TokenKey)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	verifier, _, err := auth.NewDeviceToken(s.oauth.TokenKey)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	request := oauthRequest{AuthID: uuid.NewString(), PollHash: hash, Device: input, CodeVerifier: verifier}
	if err := s.saveEncrypted(r.Context(), "oauth-state:"+state, request, 10*time.Minute); err != nil {
		writeServiceError(w, err)
		return
	}
	if err := s.saveEncrypted(r.Context(), "oauth-poll:"+request.AuthID, oauthPoll{Status: "pending"}, 10*time.Minute); err != nil {
		writeServiceError(w, err)
		return
	}
	// 单独保存摘要，客户端 poll 不携带 Google state，服务端也不会把摘要返回。
	if err := s.hub.PutTransient(r.Context(), "oauth-proof:"+request.AuthID, hash, 10*time.Minute); err != nil {
		writeServiceError(w, err)
		return
	}
	challenge := sha256.Sum256([]byte(verifier))
	q := url.Values{"client_id": {s.oauth.ClientID}, "redirect_uri": {s.oauth.PublicURL + "/api/v1/auth/google/callback"}, "response_type": {"code"}, "scope": {"openid email profile"}, "state": {state}, "code_challenge": {base64.RawURLEncoding.EncodeToString(challenge[:])}, "code_challenge_method": {"S256"}, "prompt": {"select_account"}}
	writeJSON(w, 200, map[string]any{"authId": request.AuthID, "pollToken": poll, "authorizationUrl": "https://accounts.google.com/o/oauth2/v2/auth?" + q.Encode(), "expiresIn": 600})
}

// googlePoll 凭请求专属秘密交付会话，Redis 加密数据允许回调和客户端请求落在不同节点。
func (s *Server) googlePoll(w http.ResponseWriter, r *http.Request) {
	if !s.googleConfigured() {
		writeError(w, 503, "GOOGLE_NOT_CONFIGURED", "中转站尚未配置 Google Web OAuth")
		return
	}
	var req struct {
		AuthID    string `json:"authId"`
		PollToken string `json:"pollToken"`
	}
	if !decodeBody(w, r, 4096, &req) {
		return
	}
	if len(req.AuthID) > 64 || len(req.PollToken) > 128 {
		writeError(w, 401, "UNAUTHORIZED", "登录请求无效或已过期")
		return
	}
	proof, err := s.hub.GetTransient(r.Context(), "oauth-proof:"+req.AuthID)
	if err != nil || subtle.ConstantTimeCompare([]byte(proof), []byte(auth.Hash(s.oauth.TokenKey, req.PollToken))) != 1 {
		writeError(w, 401, "UNAUTHORIZED", "登录请求无效或已过期")
		return
	}
	raw, err := s.hub.GetTransient(r.Context(), "oauth-poll:"+req.AuthID)
	var poll oauthPoll
	if err != nil || s.decodeEncrypted(raw, &poll) != nil {
		writeError(w, 401, "UNAUTHORIZED", "登录请求无效或已过期")
		return
	}
	writeJSON(w, 200, poll)
}

// googleCallback 核销 state 后向 Google 换取令牌，验证真实账号再登记客户端设备。
func (s *Server) googleCallback(w http.ResponseWriter, r *http.Request) {
	if !s.googleConfigured() {
		writeError(w, 503, "GOOGLE_NOT_CONFIGURED", "中转站尚未配置 Google Web OAuth")
		return
	}
	state := r.URL.Query().Get("state")
	if len(state) > 128 || state == "" {
		writeError(w, 400, "INVALID_STATE", "Google 登录请求无效或已过期")
		return
	}
	raw, err := s.hub.TakeTransient(r.Context(), "oauth-state:"+state)
	var request oauthRequest
	if err != nil || s.decodeEncrypted(raw, &request) != nil {
		writeError(w, 400, "INVALID_STATE", "Google 登录请求无效或已过期")
		return
	}
	poll := oauthPoll{Status: "failed", ErrorMessage: "Google 登录未完成，请返回应用重试"}
	if r.URL.Query().Get("error") == "" && r.URL.Query().Get("code") != "" {
		token, err := s.exchangeCode(r.Context(), r.URL.Query().Get("code"), request.CodeVerifier)
		if err == nil {
			session, loginErr := s.service.LoginGoogle(r.Context(), token, request.Device)
			if loginErr == nil {
				poll = oauthPoll{Status: "done", Session: sessionJSON(session)}
			}
		}
	}
	if err := s.saveEncrypted(r.Context(), "oauth-poll:"+request.AuthID, poll, 2*time.Minute); err != nil {
		writeServiceError(w, err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'")
	message := "登录未完成，请返回 Chorus 重试。"
	if poll.Status == "done" {
		message = "Google 登录成功，请返回 Chorus；此窗口可以关闭。"
	}
	fmt.Fprintf(w, "<!doctype html><html lang=\"zh\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Chorus 登录</title><body style=\"font-family:system-ui;margin:3rem\"><h1>%s</h1></body></html>", message)
}
func (s *Server) exchangeCode(ctx context.Context, code, verifier string) (string, error) {
	if len(code) > 4096 {
		return "", fmt.Errorf("invalid code")
	}
	values := url.Values{"client_id": {s.oauth.ClientID}, "client_secret": {s.oauth.ClientSecret}, "code": {code}, "code_verifier": {verifier}, "grant_type": {"authorization_code"}, "redirect_uri": {s.oauth.PublicURL + "/api/v1/auth/google/callback"}}
	req, err := http.NewRequestWithContext(ctx, "POST", s.oauth.TokenURL, strings.NewReader(values.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := (&http.Client{Timeout: s.oauth.Timeout}).Do(req)
	if err != nil {
		return "", fmt.Errorf("Google 授权服务暂不可用")
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return "", fmt.Errorf("Google 授权未通过")
	}
	var payload struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 65536)).Decode(&payload); err != nil || payload.AccessToken == "" || !strings.EqualFold(payload.TokenType, "Bearer") {
		return "", fmt.Errorf("Google 授权响应无效")
	}
	return payload.AccessToken, nil
}
