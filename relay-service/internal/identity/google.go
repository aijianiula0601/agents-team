// Package identity 校验客户端提交的 Google 访问令牌。
package identity

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// ErrUnauthorized 表示 Google 拒绝了访问令牌。
var ErrUnauthorized = errors.New("google 访问令牌无效")

// Profile 是校验通过后的 Google 账号资料。
type Profile struct {
	Email    string
	Name     string
	Picture  string
	Verified bool
}

// Google 调用 Google userinfo 接口。
type Google struct {
	UserInfoURL string
	Client      *http.Client
}

// NewGoogle 创建带超时的 Google 身份客户端。
//
// 参数：userInfoURL 为 userinfo 地址；timeout 为单次请求超时。
// 返回值：可复用的客户端。
// 注意事项：超时同时作用于连接和响应头，不记录访问令牌。
func NewGoogle(userInfoURL string, timeout time.Duration) *Google {
	return &Google{
		UserInfoURL: userInfoURL,
		Client:      &http.Client{Timeout: timeout},
	}
}

// Verify 用访问令牌换取已验证邮箱。
//
// 参数：ctx 控制取消；accessToken 为 Google OAuth access token。
// 返回值：邮箱已验证的资料。令牌无效返回 ErrUnauthorized，网络或响应异常返回其他错误。
// 注意事项：邮箱未验证视为无效身份，不能建账号。
func (g *Google) Verify(ctx context.Context, accessToken string) (Profile, error) {
	if strings.TrimSpace(accessToken) == "" {
		return Profile{}, ErrUnauthorized
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, g.UserInfoURL, nil)
	if err != nil {
		return Profile{}, fmt.Errorf("创建 Google 身份请求失败: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	resp, err := g.Client.Do(req)
	if err != nil {
		return Profile{}, fmt.Errorf("请求 Google 身份失败: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return Profile{}, ErrUnauthorized
	}
	if resp.StatusCode != http.StatusOK {
		return Profile{}, fmt.Errorf("Google 身份接口返回 %d", resp.StatusCode)
	}
	var payload struct {
		Email         string `json:"email"`
		Name          string `json:"name"`
		Picture       string `json:"picture"`
		EmailVerified bool   `json:"email_verified"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return Profile{}, fmt.Errorf("解析 Google 身份失败: %w", err)
	}
	if !payload.EmailVerified || strings.TrimSpace(payload.Email) == "" {
		return Profile{}, ErrUnauthorized
	}
	return Profile{
		Email:    strings.ToLower(strings.TrimSpace(payload.Email)),
		Name:     strings.TrimSpace(payload.Name),
		Picture:  strings.TrimSpace(payload.Picture),
		Verified: true,
	}, nil
}
