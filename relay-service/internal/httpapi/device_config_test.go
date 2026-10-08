package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"agents-team-relay/internal/realtime"
	"agents-team-relay/internal/service"
	"agents-team-relay/internal/storage"
)

// TestHTTPRemoteAgentConfig 验证手机可保存配置且整份快照权限与乐观锁继续有效。
//
// 参数：t 为测试句柄。
// 返回值：无，HTTP 协议、返回快照或写权限错误时失败。
// 注意事项：使用真实路由和合成登录，确保 PATCH 的跨域预检同样可用。
func TestHTTPRemoteAgentConfig(t *testing.T) {
	store := storage.NewMemory()
	hub := realtime.New(nil, "agent-config")
	svc := service.New(store, stubGoogle{}, hub, []byte("0123456789abcdef0123456789abcdef"), 100000)
	handler := New(svc, store, hub, "/agents-team").Handler()
	desktop := login(t, handler, "config-desktop", "mac")
	phone := login(t, handler, "config-phone", "android")
	original := map[string]any{"agents": []any{map[string]any{"id": "a1", "name": "旧名字", "messages": []any{map[string]any{"id": "m1", "text": "历史"}}}}, "rooms": []any{}}
	if response := request(handler, http.MethodPut, "/agents-team/api/v1/state", desktop.token, map[string]any{"baseRevision": 0, "state": original}); response.Code != 200 {
		t.Fatalf("初始快照保存失败: %s", response.Body.String())
	}
	response := request(handler, http.MethodPatch, "/agents-team/api/v1/agents/a1", phone.token, map[string]any{"baseRevision": 1, "config": map[string]any{"name": "手机修改", "harnessModel": "model-1", "workspaceMode": "auto"}})
	if response.Code != 200 || !bytes.Contains(response.Body.Bytes(), []byte(`"configRevision":1`)) || !bytes.Contains(response.Body.Bytes(), []byte("历史")) {
		t.Fatalf("手机配置未持久化或历史丢失: %s", response.Body.String())
	}
	response = request(handler, http.MethodPut, "/agents-team/api/v1/state", desktop.token, map[string]any{"baseRevision": 2, "state": original})
	if response.Code != 409 || !bytes.Contains(response.Body.Bytes(), []byte("手机修改")) {
		t.Fatalf("旧主电脑快照覆盖远端修改: %s", response.Body.String())
	}
	response = request(handler, http.MethodPut, "/agents-team/api/v1/state", phone.token, map[string]any{"baseRevision": 2, "state": original})
	if response.Code != 403 {
		t.Fatal("手机仍不能覆盖完整执行快照")
	}
	response = request(handler, http.MethodOptions, "/agents-team/api/v1/agents/a1", "", nil)
	if response.Code != 204 || !bytes.Contains([]byte(response.Header().Get("Access-Control-Allow-Methods")), []byte("PATCH")) {
		t.Fatal("跨域预检没有放行配置编辑")
	}
}

// TestHTTPPrimaryRequiresOnlineTarget 验证离线设备禁选由服务端执行，不能绕过页面限制。
//
// 参数：t 为测试句柄。
// 返回值：无，离线电脑被提升或在线电脑不能切换时失败。
// 注意事项：目标设备的实时标记必须存在；修改方在线不能代替目标在线。
func TestHTTPPrimaryRequiresOnlineTarget(t *testing.T) {
	ctx := context.Background()
	store := storage.NewMemory()
	hub := realtime.New(nil, "primary-online")
	svc := service.New(store, stubGoogle{}, hub, []byte("0123456789abcdef0123456789abcdef"), 100000)
	handler := New(svc, store, hub, "/agents-team").Handler()
	desktop := login(t, handler, "primary-desktop", "mac")
	other := login(t, handler, "other-desktop", "mac")
	target, _, err := svc.Authenticate(ctx, other.token)
	if err != nil {
		t.Fatal(err)
	}
	path := "/agents-team/api/v1/devices/" + target.ID + "/primary"
	response := request(handler, http.MethodPost, path, desktop.token, map[string]any{})
	if response.Code != 409 || !bytes.Contains(response.Body.Bytes(), []byte("离线不可设置")) {
		t.Fatalf("离线电脑被设置为主电脑: %s", response.Body.String())
	}
	hub.MarkOnline(ctx, target.ID)
	response = request(handler, http.MethodPost, path, desktop.token, map[string]any{})
	if response.Code != 200 {
		t.Fatalf("在线电脑不能设置为主电脑: %s", response.Body.String())
	}
	devices, _ := store.ListDevices(ctx, target.AccountID)
	for _, item := range devices {
		if item.IsPrimary != (item.ID == target.ID) {
			t.Fatal("设置后主电脑身份不唯一")
		}
	}
}

// TestHTTPDeleteRevokesSocketAndPreservesAccountData 验证删除设备撤销现有连接，保留账号资料并隔离其他账号。
//
// 参数：t 为测试句柄。
// 返回值：无，旧会话可继续访问或删除后资料丢失时失败。
// 注意事项：删除主电脑不隐式提升其他电脑，之后须明确选择在线设备。
func TestHTTPDeleteRevokesSocketAndPreservesAccountData(t *testing.T) {
	ctx := context.Background()
	store := storage.NewMemory()
	hub := realtime.New(nil, "delete-device")
	svc := service.New(store, stubGoogle{}, hub, []byte("0123456789abcdef0123456789abcdef"), 100000)
	handler := New(svc, store, hub, "/agents-team").Handler()
	primary := login(t, handler, "deleted-desktop", "mac")
	other := login(t, handler, "kept-desktop", "mac")
	target, account, err := svc.Authenticate(ctx, primary.token)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SaveState(ctx, target, 0, json.RawMessage(`{"agents":[{"id":"a1","name":"保留配置","messages":[]}],"rooms":[]}`)); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	defer server.Close()
	connection := connectSessionSocket(t, server, primary.token)
	defer connection.Close()
	response := request(handler, http.MethodDelete, "/agents-team/api/v1/devices/"+target.ID, other.token, nil)
	if response.Code != 200 {
		t.Fatal("删除设备失败")
	}
	connection.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := connection.ReadMessage(); err == nil {
		t.Fatal("已删除设备的连接仍收到账号事件")
	}
	if request(handler, http.MethodGet, "/agents-team/api/v1/state", primary.token, nil).Code != 401 {
		t.Fatal("已删除设备令牌仍然有效")
	}
	devices, _ := store.ListDevices(ctx, account.ID)
	if len(devices) != 1 || devices[0].IsPrimary {
		t.Fatal("删除主电脑后提升了其他电脑")
	}
	state, _ := svc.LoadState(ctx, account.ID)
	if state.Revision != 1 || !bytes.Contains(state.Body, []byte("保留配置")) {
		t.Fatal("删除设备丢失账号的配置或历史")
	}
	outsider, err := svc.LoginEmail(ctx, "other-account@example.com", "其他账号", "test-password-123", "register", service.DeviceInput{ClientDeviceID: "outsider-device", Name: "其他电脑", Platform: "mac"})
	if err != nil {
		t.Fatal(err)
	}
	response = request(handler, http.MethodDelete, "/agents-team/api/v1/devices/"+devices[0].ID, outsider.DeviceToken, nil)
	if response.Code != 404 {
		t.Fatal("可以删除其他账号的设备")
	}
}
