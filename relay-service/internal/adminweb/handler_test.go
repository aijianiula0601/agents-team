package adminweb

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestHandlerMountAndHeaders 验证资源前缀、入口和浏览器安全策略。
//
// 参数：t 为测试上下文。
// 返回值：无。
// 注意事项：请求使用实际 mux 挂载方式，防止 StripPrefix 与生产入口不一致。
func TestHandlerMountAndHeaders(t *testing.T) {
	mux := http.NewServeMux()
	mux.Handle("/agents-team/admin/", Handler("/agents-team"))
	for _, path := range []string{"/agents-team/admin/", "/agents-team/admin/assets/app.js", "/agents-team/admin/assets/analytics.js", "/agents-team/admin/assets/accounts.js", "/agents-team/admin/assets/app.css", "/agents-team/admin/assets/analytics.css"} {
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusOK || response.Body.Len() == 0 {
			t.Fatalf("资源无法读取 path=%q status=%d", path, response.Code)
		}
		if response.Header().Get("X-Content-Type-Options") != "nosniff" || response.Header().Get("Cache-Control") != "no-store" || !strings.Contains(response.Header().Get("Content-Security-Policy"), "frame-ancestors 'none'") {
			t.Fatalf("资源缺少安全响应头 path=%q", path)
		}
	}
}

// TestHandlerRejectsUnknownFiles 验证非公开文件与写方法不可从静态入口访问。
//
// 参数：t 为测试上下文。
// 返回值：无。
// 注意事项：README 和 Go 源码不应随静态路由公开。
func TestHandlerRejectsUnknownFiles(t *testing.T) {
	handler := Handler("/agents-team")
	for _, path := range []string{"README.md", "handler.go", "assets/", "api/me"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/agents-team/admin/"+path, nil))
		if response.Code != http.StatusNotFound {
			t.Fatalf("未知路径未被拒绝 path=%q status=%d", path, response.Code)
		}
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/agents-team/admin/", nil))
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("静态入口接受写方法 status=%d", response.Code)
	}
}
