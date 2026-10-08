// Package adminweb 提供中转站管理页面的内嵌静态资源。
package adminweb

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"
)

// resources 随服务二进制打包管理页面，部署时无需额外复制前端文件。
//
// 参数：不适用。
// 返回值：不适用。
// 注意事项：只嵌入明确列出的前端文件，避免携带工作目录内的其他资料。
//
//go:embed index.html assets/app.css assets/analytics.css assets/app.js assets/analytics.js assets/accounts.js
var resources embed.FS

// Handler 创建支持服务路径前缀的管理页面处理器。
//
// 参数：prefix 为服务公开路径前缀，例如 /agents-team；空字符串表示根路径。
// 返回值：直接挂载到 prefix + "/admin/" 的 HTTP 处理器。
// 注意事项：API 应以更具体的 /admin/api/ 路由注册；页面不缓存登录资料，静态文件禁用 MIME 猜测。
func Handler(prefix string) http.Handler {
	root := strings.TrimRight(prefix, "/") + "/admin/"
	files := http.FileServer(http.FS(resources))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "方法不允许", http.StatusMethodNotAllowed)
			return
		}
		path := strings.TrimPrefix(r.URL.Path, root)
		if path != "" && path != "index.html" && path != "assets/app.css" && path != "assets/analytics.css" && path != "assets/app.js" && path != "assets/analytics.js" && path != "assets/accounts.js" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
		w.Header().Set("Cache-Control", "no-store")
		// ------------ 页面入口固定返回首页，资源路径由文件服务处理 ---------------
		if path == "" || path == "index.html" {
			body, err := fs.ReadFile(resources, "index.html")
			if err != nil {
				http.Error(w, "管理页面暂时不可用", http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			if r.Method == http.MethodHead {
				return
			}
			_, _ = w.Write(body)
			return
		}
		http.StripPrefix(root, files).ServeHTTP(w, r)
	})
}
