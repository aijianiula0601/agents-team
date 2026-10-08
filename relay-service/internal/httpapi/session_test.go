package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"agents-team-relay/internal/realtime"
	"agents-team-relay/internal/service"
	"agents-team-relay/internal/storage"

	"github.com/gorilla/websocket"
)

// delayedLogoutStore 在事务前暂停退出请求以复现重新登录竞态。
// 参数：Store 为实际内存存储；entered 与 resume 控制认证完成后的暂停点。
// 返回值：通过 RevokeSession 执行条件撤销。
// 注意事项：仅供一次退出请求的测试使用，不记录认证信息。
type delayedLogoutStore struct {
	storage.Store
	entered chan struct{}
	resume  chan struct{}
}

// RevokeSession 等待新登录完成后继续原子退出。
// 参数：ctx 控制取消；device 为退出请求旧认证结果。
// 返回值：底层实际撤销结果与错误。
// 注意事项：暂停点用于确保测试确定性，不依赖线程调度或固定睡眠。
func (s *delayedLogoutStore) RevokeSession(ctx context.Context, device storage.Device) (bool, error) {
	close(s.entered)
	select {
	case <-s.resume:
		return s.Store.RevokeSession(ctx, device)
	case <-ctx.Done():
		return false, ctx.Err()
	}
}

// TestHTTPDelayedLogoutCannotRevokeNewLogin 确认认证后迟到的退出请求不影响新登录。
// 参数：t 为测试句柄。
// 返回值：无，HTTP会话边界错误时终止测试。
// 注意事项：以同步暂停点复现竞态，不访问真实账号或外部服务。
func TestHTTPDelayedLogoutCannotRevokeNewLogin(t *testing.T) {
	store := &delayedLogoutStore{Store: storage.NewMemory(), entered: make(chan struct{}), resume: make(chan struct{})}
	hub := realtime.New(nil, "logout-race")
	svc := service.New(store, stubGoogle{}, hub, []byte("0123456789abcdef0123456789abcdef"), 100000)
	handler := New(svc, store, hub, "/agents-team").Handler()
	old := login(t, handler, "same-desktop-device", "mac")
	completed := make(chan int, 1)
	go func() {
		completed <- request(handler, "POST", "/agents-team/api/v1/auth/logout", old.token, map[string]any{}).Code
	}()
	select {
	case <-store.entered:
	case <-time.After(3 * time.Second):
		close(store.resume)
		t.Fatal("退出请求未到达事务暂停点")
	}
	current := login(t, handler, "same-desktop-device", "mac")
	close(store.resume)
	if code := <-completed; code != 200 {
		t.Fatal("旧退出请求应幂等成功")
	}
	if request(handler, "GET", "/agents-team/api/v1/auth/session", current.token, nil).Code != 200 {
		t.Fatal("迟到退出撤销了新会话")
	}
	if request(handler, "GET", "/agents-team/api/v1/auth/session", old.token, nil).Code != 401 {
		t.Fatal("轮换后的旧令牌仍可使用")
	}
}

// connectSessionSocket 建立使用合成设备令牌的本机测试连接。
// 参数：t 为测试句柄；server 为测试HTTP服务器；token 为合成设备令牌。
// 返回值：已经收到hello的WebSocket连接。
// 注意事项：令牌仅在Authorization头中传递，不出现在URL或断言日志。
func connectSessionSocket(t *testing.T, server *httptest.Server, token string) *websocket.Conn {
	t.Helper()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/agents-team/ws", http.Header{"Authorization": []string{"Bearer " + token}})
	if err != nil {
		t.Fatal("测试连接建立失败")
	}
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	var hello map[string]any
	if err := conn.ReadJSON(&hello); err != nil || hello["type"] != "hello" {
		conn.Close()
		t.Fatal("测试连接未收到hello")
	}
	return conn
}

// TestRotatedSocketCannotReadNewEvents 验证旧连接不能接收令牌轮换后的账号事件。
// 参数：t 为测试句柄。
// 返回值：无，旧连接泄露事件或新连接失效时终止测试。
// 注意事项：全部账号与事件都是本机合成数据，仍使用真实WebSocket收发。
func TestRotatedSocketCannotReadNewEvents(t *testing.T) {
	store := storage.NewMemory()
	hub := realtime.New(nil, "socket-rotation-read")
	svc := service.New(store, stubGoogle{}, hub, []byte("0123456789abcdef0123456789abcdef"), 100000)
	handler := New(svc, store, hub, "/agents-team").Handler()
	old := login(t, handler, "rotating-phone", "android")
	server := httptest.NewServer(handler)
	defer server.Close()
	oldSocket := connectSessionSocket(t, server, old.token)
	defer oldSocket.Close()
	current := login(t, handler, "rotating-phone", "android")
	oldSocket.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := oldSocket.ReadMessage(); err == nil {
		t.Fatal("旧连接收到重新登录后的账号事件")
	}
	newSocket := connectSessionSocket(t, server, current.token)
	defer newSocket.Close()
	device, _, err := svc.Authenticate(context.Background(), current.token)
	if err != nil {
		t.Fatal(err)
	}
	hub.Publish(context.Background(), realtime.Event{AccountID: device.AccountID, Type: "state.updated", Revision: 42})
	var event map[string]any
	if err := newSocket.ReadJSON(&event); err != nil || event["type"] != "state.updated" || event["revision"] != float64(42) {
		t.Fatal("重新登录的新连接未正常接收事件")
	}
}

// TestRotatedSocketCannotSendAcknowledgment 验证旧连接下一次任务确认即关闭。
// 参数：t 为测试句柄。
// 返回值：无，旧令牌继续写入或有效连接受影响时终止测试。
// 注意事项：关闭业务广播以单独验证接收帧的认证边界，不依赖发送路径关闭旧连接。
func TestRotatedSocketCannotSendAcknowledgment(t *testing.T) {
	store := storage.NewMemory()
	hub := realtime.New(nil, "socket-rotation-write")
	svc := service.New(store, stubGoogle{}, nil, []byte("0123456789abcdef0123456789abcdef"), 100000)
	handler := New(svc, store, hub, "/agents-team").Handler()
	old := login(t, handler, "rotating-desktop", "mac")
	server := httptest.NewServer(handler)
	defer server.Close()
	oldSocket := connectSessionSocket(t, server, old.token)
	defer oldSocket.Close()
	current := login(t, handler, "rotating-desktop", "mac")
	if err := oldSocket.WriteJSON(map[string]string{"type": "dispatch.ack", "id": "synthetic-job", "claimToken": "synthetic-claim"}); err != nil {
		t.Fatal("测试旧帧发送失败")
	}
	oldSocket.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, err := oldSocket.ReadMessage()
	if err == nil || !websocket.IsUnexpectedCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
		t.Fatal("旧连接下一次确认应立即关闭，不能仅等超时")
	}
	newSocket := connectSessionSocket(t, server, current.token)
	defer newSocket.Close()
	device, _, err := svc.Authenticate(context.Background(), current.token)
	if err != nil {
		t.Fatal(err)
	}
	hub.Publish(context.Background(), realtime.Event{AccountID: device.AccountID, Type: "state.updated", Revision: 7})
	var event map[string]any
	if err := newSocket.ReadJSON(&event); err != nil || event["revision"] != float64(7) {
		t.Fatal("有效新连接受旧连接关闭影响")
	}
}
