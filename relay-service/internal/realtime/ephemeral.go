package realtime

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

type transientValue struct {
	body   string
	expiry time.Time
}

var transientMu sync.Mutex

// 本机回退仅供单进程单元测试；测试和生产始终使用 Redis。
var transientValues = map[*Hub]map[string]transientValue{}

// PutTransient 保存有明确 TTL 的登录请求或一次性连接票据。
func (h *Hub) PutTransient(ctx context.Context, key, body string, ttl time.Duration) error {
	key = h.prefix + ":transient:" + key
	if h.redis != nil {
		return h.redis.Set(ctx, key, body, ttl).Err()
	}
	transientMu.Lock()
	defer transientMu.Unlock()
	values := transientValues[h]
	if values == nil {
		values = map[string]transientValue{}
		transientValues[h] = values
	}
	now := time.Now()
	for k, v := range values {
		if !v.expiry.After(now) {
			delete(values, k)
		}
	}
	values[key] = transientValue{body: body, expiry: now.Add(ttl)}
	return nil
}

// GetTransient 在任一节点读取尚未过期的短期数据。
func (h *Hub) GetTransient(ctx context.Context, key string) (string, error) {
	return h.transient(ctx, key, false)
}

// TakeTransient 原子读取并删除，票据和 OAuth state 都只能消费一次。
func (h *Hub) TakeTransient(ctx context.Context, key string) (string, error) {
	return h.transient(ctx, key, true)
}
func (h *Hub) transient(ctx context.Context, key string, take bool) (string, error) {
	key = h.prefix + ":transient:" + key
	if h.redis != nil {
		if take {
			return h.redis.GetDel(ctx, key).Result()
		}
		return h.redis.Get(ctx, key).Result()
	}
	transientMu.Lock()
	defer transientMu.Unlock()
	values := transientValues[h]
	value, ok := values[key]
	if !ok || !value.expiry.After(time.Now()) {
		delete(values, key)
		return "", redis.Nil
	}
	if take {
		delete(values, key)
	}
	return value.body, nil
}

// AllowAttempt 对登录相关匿名请求限速，Redis 不可用时停止签发新身份。
func (h *Hub) AllowAttempt(ctx context.Context, key string, limit int, window time.Duration) bool {
	if h == nil {
		return false
	}
	if h.redis != nil {
		result, err := h.redis.Eval(ctx, `local n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end;return n`, []string{h.prefix + ":rate:" + key}, window.Milliseconds()).Int()
		return err == nil && result <= limit
	}
	// 内存模式无需模拟分布式限流，测试独立验证业务身份规则。
	return true
}
func IsTransientMissing(err error) bool { return errors.Is(err, redis.Nil) }
