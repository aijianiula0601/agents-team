package realtime

import (
	"context"
	"errors"
	"time"
)

// TransientWrite 是一个有明确到期时间的短期写入。参数为键、正文和 TTL；供批量事务使用；禁止永久保存配置命令。
type TransientWrite struct {
	Key, Body string
	TTL       time.Duration
}

// PutTransients 原子保存多个短期记录。参数为写入列表；返回事务错误；Redis 使用 MULTI/EXEC，内存回退持有同一互斥锁。
func (h *Hub) PutTransients(ctx context.Context, writes []TransientWrite) error {
	for _, write := range writes {
		if write.Key == "" || write.TTL < time.Millisecond {
			return errors.New("invalid transient transaction")
		}
	}
	if h.redis != nil {
		pipeline := h.redis.TxPipeline()
		for _, write := range writes {
			pipeline.Set(ctx, h.prefix+":transient:"+write.Key, write.Body, write.TTL)
		}
		_, err := pipeline.Exec(ctx)
		return err
	}
	transientMu.Lock()
	defer transientMu.Unlock()
	values := transientValues[h]
	if values == nil {
		values = map[string]transientValue{}
		transientValues[h] = values
	}
	now := time.Now()
	for _, write := range writes {
		values[h.prefix+":transient:"+write.Key] = transientValue{body: write.Body, expiry: now.Add(write.TTL)}
	}
	return nil
}
