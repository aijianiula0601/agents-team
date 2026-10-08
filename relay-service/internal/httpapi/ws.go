package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"agents-team-relay/internal/auth"
	"agents-team-relay/internal/logx"
	"agents-team-relay/internal/realtime"
	"agents-team-relay/internal/storage"

	"github.com/gorilla/websocket"
)

// 客户端来自 Electron、Capacitor 和本地页面，来源不固定。身份只看设备令牌。
var upgrader = websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}

// socket 建立设备长连接，用于接收聊天版本和执行任务。
//
// 参数：需要设备令牌。主设备连接后会立即收到未完成任务。
// 返回值：无。
// 注意事项：升级前及每轮收发前校验令牌版本。连接断开后在线标记最多再保留 60 秒。
func (s *Server) socket(w http.ResponseWriter, r *http.Request) {
	device, account, ok := s.authenticateSocket(w, r)
	if !ok || s.hub == nil {
		if ok {
			writeError(w, http.StatusServiceUnavailable, "UNAVAILABLE", "实时通道未就绪")
		}
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		logx.Warnf("升级设备连接失败 account=%s device=%s", account.ID, device.ID)
		return
	}
	client := s.hub.Register(account.ID, device.ID)
	defer s.hub.Unregister(client)
	defer conn.Close()
	s.hub.MarkOnline(r.Context(), device.ID)
	hello := map[string]any{
		"version":   1,
		"type":      "hello",
		"accountId": account.ID,
		"deviceId":  device.ID,
		"isPrimary": device.IsPrimary,
	}
	if state, err := s.service.LoadState(r.Context(), account.ID); err == nil {
		hello["revision"] = state.Revision
	}
	if device.IsPrimary {
		if pending, err := s.service.ListPending(r.Context(), device); err == nil {
			hello["pending"] = pending
		}
	}
	if payload, err := json.Marshal(hello); err == nil {
		client.Enqueue(payload)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	validSession := func() bool {
		checkCtx, checkCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer checkCancel()
		if current, err := s.store.GetDevice(checkCtx, account.ID, device.ID); err != nil || current.TokenHash != device.TokenHash {
			conn.Close()
			return false
		}
		return true
	}
	go writeSocket(ctx, conn, client, validSession, func() { s.hub.MarkOnline(ctx, device.ID) })
	readSocket(conn, func(payload []byte) {
		// ------------ 读取每一帧前重新验证会话版本 ---------------
		if !validSession() {
			return
		}
		var message struct {
			Type       string `json:"type"`
			ID         string `json:"id"`
			ClaimToken string `json:"claimToken"`
		}
		if json.Unmarshal(payload, &message) != nil || message.Type != "dispatch.ack" || message.ID == "" {
			return
		}
		_, _, err := s.service.CompleteDispatch(context.Background(), device, message.ID, resultRequest{Status: "running", ClaimToken: message.ClaimToken}.toService())
		if err != nil {
			logx.Warnf("确认执行任务失败 account=%s dispatch=%s", account.ID, message.ID)
		}
	})
}

// writeSocket 把队列中的事件写成文本帧，并定期发送心跳。
//
// 参数：ctx 取消时退出；conn 为已升级连接；client 为发送队列；validSession 验证当前令牌；markOnline 刷新在线标记。
// 返回值：无。
// 注意事项：只允许这一处写连接；每次发送前验证令牌版本，避免旧连接继续读取新会话数据。
func writeSocket(ctx context.Context, conn *websocket.Conn, client *realtime.Conn, validSession func() bool, markOnline func()) {
	defer conn.Close()
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case payload, ok := <-client.Send():
			if !ok {
				_ = conn.WriteControl(websocket.CloseMessage, []byte{}, time.Now().Add(time.Second))
				return
			}
			if !validSession() {
				return
			}
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteMessage(websocket.TextMessage, payload); err != nil {
				return
			}
		case <-ticker.C:
			if !validSession() {
				return
			}
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
			markOnline()
		}
	}
}

// readSocket 读取客户端消息，直到连接关闭。
//
// 参数：conn 为已升级连接；onMessage 处理文本帧。
// 返回值：无。
// 注意事项：70 秒没有 pong 或新消息就断开，避免占着失效连接。
func readSocket(conn *websocket.Conn, onMessage func([]byte)) {
	conn.SetReadLimit(1 << 20)
	_ = conn.SetReadDeadline(time.Now().Add(70 * time.Second))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(70 * time.Second))
	})
	for {
		_, payload, err := conn.ReadMessage()
		if err != nil {
			return
		}
		_ = conn.SetReadDeadline(time.Now().Add(70 * time.Second))
		onMessage(payload)
	}
}

// socketTicket 签发 60 秒的一次性票据，设备令牌不会出现在 WebSocket URL 或代理访问日志中。
func (s *Server) socketTicket(w http.ResponseWriter, r *http.Request) {
	_, _, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	if s.hub == nil {
		writeError(w, 503, "UNAVAILABLE", "实时通道未就绪")
		return
	}
	ticket, _, err := auth.NewDeviceToken(make([]byte, 32))
	if err != nil {
		writeServiceError(w, err)
		return
	}
	sealed, err := s.service.Seal([]byte(bearerToken(r)))
	if err != nil {
		writeServiceError(w, err)
		return
	}
	if err = s.hub.PutTransient(r.Context(), "ws-ticket:"+ticket, sealed, 60*time.Second); err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"ticket": ticket, "expiresIn": 60, "websocketPath": s.prefix + "/ws"})
}
func (s *Server) authenticateSocket(w http.ResponseWriter, r *http.Request) (storage.Device, storage.Account, bool) {
	if bearerToken(r) != "" {
		return s.authenticate(w, r)
	}
	ticket := r.URL.Query().Get("ticket")
	if s.hub == nil || ticket == "" || len(ticket) > 128 {
		writeError(w, 401, "UNAUTHORIZED", "缺少有效连接票据")
		return storage.Device{}, storage.Account{}, false
	}
	sealed, err := s.hub.TakeTransient(r.Context(), "ws-ticket:"+ticket)
	if err != nil {
		writeError(w, 401, "UNAUTHORIZED", "连接票据无效或已使用")
		return storage.Device{}, storage.Account{}, false
	}
	token, err := s.service.Unseal(sealed)
	if err != nil {
		writeError(w, 401, "UNAUTHORIZED", "连接票据无效")
		return storage.Device{}, storage.Account{}, false
	}
	r.Header.Set("Authorization", "Bearer "+string(token))
	return s.authenticate(w, r)
}
