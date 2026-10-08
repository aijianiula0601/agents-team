// Package auth 负责设备令牌和邀请码的生成与摘要。
package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
)

const tokenPrefix = "chr_"

// NewDeviceToken 生成只返回一次的设备令牌及其摘要。
//
// 参数：key 为环境配置中的 HMAC 密钥，长度应为 32 字节。
// 返回值：raw 交给客户端保存；hash 写入数据库。失败时返回错误。
// 注意事项：日志和接口响应之外不得再次持久化 raw。
func NewDeviceToken(key []byte) (raw string, hash string, err error) {
	buf := make([]byte, 32)
	if _, err = rand.Read(buf); err != nil {
		return "", "", fmt.Errorf("生成设备令牌失败: %w", err)
	}
	raw = tokenPrefix + hex.EncodeToString(buf)
	return raw, Hash(key, raw), nil
}

// NewInviteCode 生成短邀请码及其摘要。
//
// 参数：key 为 HMAC 密钥。
// 返回值：明文邀请码和摘要。失败时返回错误。
// 注意事项：明文只在创建接口返回一次，库中只保存摘要。
func NewInviteCode(key []byte) (code string, hash string, err error) {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	buf := make([]byte, 8)
	if _, err = rand.Read(buf); err != nil {
		return "", "", fmt.Errorf("生成邀请码失败: %w", err)
	}
	out := make([]byte, len(buf))
	for i, b := range buf {
		out[i] = alphabet[int(b)%len(alphabet)]
	}
	code = string(out)
	return code, Hash(key, code), nil
}

// Hash 计算令牌或邀请码的 HMAC-SHA256 十六进制摘要。
//
// 参数：key 为密钥；raw 为明文。
// 返回值：64 位十六进制摘要。
// 注意事项：比较摘要时使用恒定时间比较由数据库等值查询完成，不要把明文写进日志。
func Hash(key []byte, raw string) string {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(raw))
	return hex.EncodeToString(mac.Sum(nil))
}
