package httpapi

import (
	"bytes"
	"net/http"
	"testing"

	"agents-team-relay/internal/realtime"
	"agents-team-relay/internal/service"
	"agents-team-relay/internal/storage"
)

// TestHTTPSharedTeamCRUD 验证手机从空账号新建 Agent、群并修改共享执行设置的真实路由。
//
// 参数：t 为测试句柄。
// 返回值：无；认证、版本、请求格式或路由错误时失败。
// 注意事项：全部操作使用设备令牌，管理后台会话不是前置条件。
func TestHTTPSharedTeamCRUD(t *testing.T) {
	store := storage.NewMemory()
	hub := realtime.New(nil, "shared-team-config")
	svc := service.New(store, stubGoogle{}, hub, []byte("0123456789abcdef0123456789abcdef"), 100000)
	handler := New(svc, store, hub, "/agents-team").Handler()
	phone := login(t, handler, "team-config-phone", "android")
	paths := []struct {
		method   string
		path     string
		body     map[string]any
		expected string
	}{
		{http.MethodPost, "/agents", map[string]any{"baseRevision": 0, "id": "a1", "config": map[string]any{"name": "手机新建", "workspaceMode": "project", "workspace": "/主电脑/实际目录"}}, "手机新建"},
		{http.MethodPost, "/agents", map[string]any{"baseRevision": 1, "id": "a2", "config": map[string]any{"name": "第二成员"}}, "第二成员"},
		{http.MethodPost, "/rooms", map[string]any{"baseRevision": 2, "id": "r1", "config": map[string]any{"name": "手机新群", "agentIds": []string{"a1", "a2"}}}, "手机新群"},
		{http.MethodPatch, "/rooms/r1", map[string]any{"baseRevision": 3, "config": map[string]any{"name": "群改名", "rule": "mention", "workspace": "/主电脑/群"}}, "群改名"},
		{http.MethodPatch, "/settings", map[string]any{"baseRevision": 4, "config": map[string]any{"localExecution": false, "defaultProvider": "custom"}}, `"localExecution":false`},
		{http.MethodDelete, "/agents/a2", map[string]any{"baseRevision": 5}, `"agentIds":["a1"]`},
		{http.MethodDelete, "/rooms/r1", map[string]any{"baseRevision": 6}, `"rooms":[]`},
	}
	for _, item := range paths {
		response := request(handler, item.method, "/agents-team/api/v1"+item.path, phone.token, item.body)
		if response.Code != 200 || !bytes.Contains(response.Body.Bytes(), []byte(item.expected)) {
			t.Fatalf("配置路由未按合同返回 %s %s: %d %s", item.method, item.path, response.Code, response.Body.String())
		}
	}
	response := request(handler, http.MethodPost, "/agents-team/api/v1/agents", phone.token, map[string]any{"baseRevision": 6, "id": "stale", "config": map[string]any{"name": "旧版本"}})
	if response.Code != 409 || !bytes.Contains(response.Body.Bytes(), []byte(`"configRevision":7`)) || !bytes.Contains(response.Body.Bytes(), []byte(`"REVISION_CONFLICT"`)) {
		t.Fatal("旧版本没有返回可恢复的最新配置")
	}
	response = request(handler, http.MethodPatch, "/agents-team/api/v1/settings", phone.token, map[string]any{"baseRevision": 7, "config": map[string]any{"apiKeys": map[string]string{"openai": "never-store"}}})
	if response.Code != 400 {
		t.Fatal("共享设置允许写入模型密钥")
	}
	response = request(handler, http.MethodDelete, "/agents-team/api/v1/agents/a1", phone.token, map[string]any{"baseRevision": 7, "id": "other"})
	if response.Code != 400 {
		t.Fatal("删除正文和路径的歧义编号未拒绝")
	}
	if response = request(handler, http.MethodPost, "/agents-team/api/v1/rooms", "", map[string]any{}); response.Code != 401 {
		t.Fatal("未认证用户能够创建共享配置")
	}
	if response = request(handler, http.MethodPut, "/agents-team/api/v1/state", phone.token, map[string]any{"baseRevision": 7, "state": map[string]any{}}); response.Code != 403 {
		t.Fatal("手机通过新增配置权限获得了整个执行快照写权限")
	}
}
