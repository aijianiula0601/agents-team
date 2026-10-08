// Package realtime 把账号事件广播到本机连接和 Redis。
package realtime

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"agents-team-relay/internal/logx"

	"github.com/redis/go-redis/v9"
)

// Event 是推送给同一账号所有在线设备的事件。
type Event struct {
	AccountID string          `json:"accountId"`
	Type      string          `json:"type"`
	Revision  int64           `json:"revision,omitempty"`
	Dispatch  json.RawMessage `json:"dispatch,omitempty"`
}

// Publisher 把事件发给在线设备。
type Publisher interface {
	Publish(ctx context.Context, event Event) error
}

// Hub 维护本机 WebSocket，并通过 Redis 让其他节点收到同一事件。
type Hub struct {
	redis       *redis.Client
	prefix      string
	channel     string
	mu          sync.Mutex
	conns       map[string]map[*Conn]struct{}
	localOnline map[string]time.Time
}

// Conn 是一台设备在本节点上的一条连接。
type Conn struct {
	AccountID string
	DeviceID  string
	send      chan []byte
	mu        sync.Mutex
	closed    bool
}

// New 创建广播中心。
//
// 参数：client 为空时只在本进程内投递；prefix 是 Redis 键前缀。
// 返回值：尚未开始订阅的 Hub。
// 注意事项：测试环境必须传入 Redis，否则其他节点收不到事件。
func New(client *redis.Client, prefix string) *Hub {
	return &Hub{
		redis:       client,
		prefix:      prefix,
		channel:     prefix + ":fanout",
		conns:       map[string]map[*Conn]struct{}{},
		localOnline: map[string]time.Time{},
	}
}

// Run 订阅 Redis 并把事件投递给本机连接。
//
// 参数：ctx 取消时退出订阅。
// 返回值：无。
// 注意事项：没有 Redis 时直接返回，本机 Publish 仍可投递。
func (h *Hub) Run(ctx context.Context) {
	if h.redis == nil {
		return
	}
	pubsub := h.redis.Subscribe(ctx, h.channel)
	defer pubsub.Close()
	ch := pubsub.Channel()
	for {
		select {
		case <-ctx.Done():
			return
		case message, ok := <-ch:
			if !ok {
				return
			}
			var event Event
			if err := json.Unmarshal([]byte(message.Payload), &event); err != nil {
				logx.Warnf("忽略无法解析的广播")
				continue
			}
			h.deliver(event.AccountID, []byte(message.Payload))
		}
	}
}

// Publish 发布账号事件。
//
// 参数：event 至少包含账号和类型。
// 返回值：Redis 发布失败时返回错误，同时仍尝试通知本机连接。
// 注意事项：Redis 正常时由订阅回调投递本机，避免同一连接收到两次。
func (h *Hub) Publish(ctx context.Context, event Event) error {
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if h.redis == nil {
		h.deliver(event.AccountID, payload)
		return nil
	}
	if err := h.redis.Publish(ctx, h.channel, payload).Err(); err != nil {
		logx.Warnf("Redis 广播失败 account=%s type=%s", event.AccountID, event.Type)
		h.deliver(event.AccountID, payload)
		return err
	}
	return nil
}

// Ping 检查 Redis。
//
// 参数：ctx 控制超时。
// 返回值：未配置或 PING 失败时返回错误。
// 注意事项：内存测试可以不调用本方法。
func (h *Hub) Ping(ctx context.Context) error {
	if h.redis == nil {
		return errRedisMissing
	}
	return h.redis.Ping(ctx).Err()
}

// MarkOnline 刷新设备在线标记。
//
// 参数：deviceID 为设备主键。
// 返回值：无。
// 注意事项：标记 60 秒后过期，HTTP 和 WebSocket 心跳都要刷新。
func (h *Hub) MarkOnline(ctx context.Context, deviceID string) {
	if deviceID == "" {
		return
	}
	if h.redis == nil {
		h.mu.Lock()
		h.localOnline[deviceID] = time.Now().Add(60 * time.Second)
		h.mu.Unlock()
		return
	}
	if err := h.redis.Set(ctx, h.onlineKey(deviceID), "1", 60*time.Second).Err(); err != nil {
		logx.Warnf("刷新在线状态失败 device=%s", deviceID)
	}
}

// Online 批量查询设备是否在线。
//
// 参数：deviceIDs 为要查询的设备。
// 返回值：在线设备集合。
// 注意事项：Redis 短暂失败时返回空集合，不把设备误判为可以执行。
func (h *Hub) Online(ctx context.Context, deviceIDs []string) map[string]bool {
	result := map[string]bool{}
	if len(deviceIDs) == 0 {
		return result
	}
	if h.redis == nil {
		now := time.Now()
		h.mu.Lock()
		defer h.mu.Unlock()
		for _, id := range deviceIDs {
			if expiry, ok := h.localOnline[id]; ok && expiry.After(now) {
				result[id] = true
			}
		}
		return result
	}
	keys := make([]string, len(deviceIDs))
	for i, id := range deviceIDs {
		keys[i] = h.onlineKey(id)
	}
	values, err := h.redis.MGet(ctx, keys...).Result()
	if err != nil {
		logx.Warnf("读取在线状态失败")
		return result
	}
	for i, value := range values {
		if value != nil {
			result[deviceIDs[i]] = true
		}
	}
	return result
}

// Register 登记一条本机连接。
//
// 参数：accountID 与 deviceID 来自已校验的设备令牌。
// 返回值：用于发送事件的连接对象。
// 注意事项：调用方必须在结束时 Unregister。
func (h *Hub) Register(accountID string, deviceID string) *Conn {
	conn := &Conn{AccountID: accountID, DeviceID: deviceID, send: make(chan []byte, 32)}
	h.mu.Lock()
	defer h.mu.Unlock()
	set := h.conns[accountID]
	if set == nil {
		set = map[*Conn]struct{}{}
		h.conns[accountID] = set
	}
	set[conn] = struct{}{}
	return conn
}

// Unregister 移除连接并关闭发送队列。
//
// 参数：conn 为 Register 的返回值。
// 返回值：无。
// 注意事项：可以重复调用。
func (h *Hub) Unregister(conn *Conn) {
	if conn == nil {
		return
	}
	h.mu.Lock()
	if set := h.conns[conn.AccountID]; set != nil {
		delete(set, conn)
		if len(set) == 0 {
			delete(h.conns, conn.AccountID)
		}
	}
	h.mu.Unlock()
	conn.closeSend()
}

// Enqueue 异步发送一条文本帧。
//
// 参数：payload 为完整 JSON。
// 返回值：无。
// 注意事项：队列满时关闭慢连接，避免堵住整个账号的广播。
func (c *Conn) Enqueue(payload []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	copied := append([]byte(nil), payload...)
	select {
	case c.send <- copied:
	default:
		c.closed = true
		close(c.send)
	}
}

// Send 返回写循环读取的队列。
//
// 参数：无。
// 返回值：字节通道。通道关闭表示连接应退出。
// 注意事项：只允许一个写循环读取。
func (c *Conn) Send() <-chan []byte { return c.send }

// closeSend 关闭发送队列。
//
// 参数：无。
// 返回值：无。
// 注意事项：重复关闭由 closed 标记防止。
func (c *Conn) closeSend() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	c.closed = true
	close(c.send)
}

// deliver 把载荷交给某账号的本机连接。
//
// 参数：accountID 为账号；payload 为事件 JSON。
// 返回值：无。
// 注意事项：发送时复制连接列表，避免持锁写网络。
func (h *Hub) deliver(accountID string, payload []byte) {
	h.mu.Lock()
	set := h.conns[accountID]
	conns := make([]*Conn, 0, len(set))
	for conn := range set {
		conns = append(conns, conn)
	}
	h.mu.Unlock()
	for _, conn := range conns {
		conn.Enqueue(payload)
	}
}

// onlineKey 生成设备在线键。
//
// 参数：deviceID 为设备主键。
// 返回值：带环境前缀的 Redis 键。
// 注意事项：前缀与音量中转服务隔离。
func (h *Hub) onlineKey(deviceID string) string {
	return h.prefix + ":online:" + deviceID
}

var errRedisMissing = redisMissing("redis 未配置")

type redisMissing string

func (e redisMissing) Error() string { return string(e) }
