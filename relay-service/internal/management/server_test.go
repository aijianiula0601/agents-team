package management

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"agents-team-relay/internal/realtime"
	"agents-team-relay/internal/storage"
	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"golang.org/x/crypto/bcrypt"
)

// testStore 模拟发布元数据并保留真实账号内存存储。参数：记录用于测试并发锁保护；返回值：ManagementStore替身；注意事项：生产使用MySQL，SQL另外由集成测试覆盖。
type testStore struct {
	*storage.Memory
	mu       sync.Mutex
	releases map[string]storage.Release
	scope    string
	start    time.Time
	end      time.Time
}

// ManagementOverview 记录查询账号范围。参数：id为范围；返回值：空统计；注意事项：用于证明请求不能覆盖账号范围。
func (s *testStore) ManagementOverview(_ context.Context, id string, start, end time.Time) (map[string]any, error) {
	s.scope = id
	s.start, s.end = start, end
	return map[string]any{"scope": id}, nil
}

// ManagementList 记录列表查询范围。参数：id为服务器选择范围；返回值：空列表；注意事项：不模拟SQL分页实现。
func (s *testStore) ManagementList(_ context.Context, id, kind, q, status string, page, size int) ([]map[string]any, int64, error) {
	s.scope = id
	return []map[string]any{}, 0, nil
}

// SaveRelease 保存草稿并检查构建唯一性。参数：item为元数据；返回值：重复错误；注意事项：加锁模拟数据库原子唯一键。
func (s *testStore) SaveRelease(_ context.Context, item storage.Release) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, old := range s.releases {
		if old.Platform == item.Platform && old.Arch == item.Arch && old.BuildNumber == item.BuildNumber {
			return storage.ErrAccountExists
		}
	}
	s.releases[item.ID] = item
	return nil
}

// FindRelease 按ID读取测试版本。参数：id为主键；返回值：版本或不存在错误；注意事项：返回副本。
func (s *testStore) FindRelease(_ context.Context, id string) (storage.Release, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	item, ok := s.releases[id]
	if !ok {
		return item, storage.ErrNotFound
	}
	return item, nil
}

// ListReleases 返回符合权限的测试数据。参数：all为管理员可见性；返回值：列表和数量；注意事项：测试只使用少量记录。
func (s *testStore) ListReleases(_ context.Context, all bool, platform string, page, size int) ([]storage.Release, int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items := []storage.Release{}
	for _, item := range s.releases {
		if (all || item.Status == "published") && (platform == "" || platform == item.Platform) {
			items = append(items, item)
		}
	}
	return items, int64(len(items)), nil
}

// SetReleaseStatus 模拟发布状态更新。参数：id/status为目标状态；返回值：记录；注意事项：加锁更新发布时间。
func (s *testStore) SetReleaseStatus(_ context.Context, id, status string) (storage.Release, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	item, ok := s.releases[id]
	if !ok {
		return item, storage.ErrNotFound
	}
	item.Status = status
	if status == "published" {
		now := time.Now().UTC()
		item.PublishedAt = &now
	}
	s.releases[id] = item
	return item, nil
}

// LatestReleases 按架构和发布状态筛选。参数：平台和架构；返回值：候选集合；注意事项：保留无序数据以测试业务层排序。
func (s *testStore) LatestReleases(_ context.Context, platform, arch string) ([]storage.Release, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items := []storage.Release{}
	for _, item := range s.releases {
		if item.Status == "published" && item.Platform == platform && (item.Arch == arch || item.Arch == "universal") {
			items = append(items, item)
		}
	}
	return items, nil
}

// CountDownload 模拟下载计数。参数：id为版本标识；返回值：nil；注意事项：本测试不验证统计SQL。
func (s *testStore) CountDownload(context.Context, string) error { return nil }

// setupAdmin 创建使用真实Redis协议的后台。参数：t为测试上下文；返回值：HTTP处理器、数据替身和配置；注意事项：使用低成本bcrypt仅加速测试。
func setupAdmin(t *testing.T) (http.Handler, *testStore, Config) {
	t.Helper()
	redisServer := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: redisServer.Addr()})
	t.Cleanup(func() { client.Close() })
	hub := realtime.New(client, "admin-test")
	hash, err := bcrypt.GenerateFromPassword([]byte("admin-secret"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	cfg := Config{Prefix: "/relay", PublicURL: "http://relay.test/relay", AdminEmails: []string{"admin@example.test"}, AdminPasswordHash: string(hash), ReleaseDir: t.TempDir(), MaxUploadBytes: 2048}
	store := &testStore{Memory: storage.NewMemory(), releases: map[string]storage.Release{}}
	mux := http.NewServeMux()
	New(store, hub, cfg).Register(mux)
	return mux, store, cfg
}

// request 构造同源JSON请求。参数：method/path/body/cookie/csrf为HTTP字段；返回值：记录响应；注意事项：不能用于multipart请求。
func request(handler http.Handler, method, path, body string, cookie *http.Cookie, csrf string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://relay.test"+path, strings.NewReader(body))
	r.Header.Set("Origin", "http://relay.test")
	r.Header.Set("Content-Type", "application/json")
	if cookie != nil {
		r.AddCookie(cookie)
	}
	if csrf != "" {
		r.Header.Set("X-CSRF-Token", csrf)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

// loginTest 登录并读取测试cookie和CSRF。参数：处理器与凭据；返回值：cookie及会话；注意事项：失败立即终止测试。
func loginTest(t *testing.T, handler http.Handler, email, password string) (*http.Cookie, Session) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"email": email, "password": password})
	w := request(handler, "POST", "/relay/admin/api/auth/login", string(body), nil, "")
	if w.Code != 200 {
		t.Fatalf("login %d %s", w.Code, w.Body.String())
	}
	var session Session
	if err := json.Unmarshal(w.Body.Bytes(), &session); err != nil {
		t.Fatal(err)
	}
	return w.Result().Cookies()[0], session
}

// TestBrowserIdentityBoundary 验证管理员不能被公开注册抢占及普通用户数据隔离。参数：t为测试句柄；返回值：无；注意事项：包括CSRF、HttpOnly会话与退出失效。
func TestBrowserIdentityBoundary(t *testing.T) {
	handler, store, _ := setupAdmin(t)
	// 即使原有客户端流程已注册同名邮箱，普通凭据也不能成为后台管理员。
	userHash, err := bcrypt.GenerateFromPassword([]byte("user-secret"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.RegisterEmail(context.Background(), storage.Account{ID: "untrusted-native-account", Email: "admin@example.test", Name: "普通客户端账号", Provider: "email"}, string(userHash)); err != nil {
		t.Fatal(err)
	}
	denied := request(handler, "POST", "/relay/admin/api/auth/login", `{"email":"admin@example.test","password":"user-secret"}`, nil, "")
	if denied.Code != 401 {
		t.Fatal("普通客户端密码提权", denied.Code)
	}
	w := request(handler, "POST", "/relay/admin/api/auth/register", `{"email":"admin@example.test","password":"user-secret"}`, nil, "")
	if w.Code != 409 {
		t.Fatalf("reserved registration status=%d", w.Code)
	}
	w = request(handler, "POST", "/relay/admin/api/auth/register", `{"email":"member@example.test","name":"成员","password":"user-secret"}`, nil, "")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	cookie, session := loginTest(t, handler, "member@example.test", "user-secret")
	if session.User.Role != "user" || !cookie.HttpOnly || cookie.Path != "/relay/admin/" || cookie.SameSite != http.SameSiteStrictMode {
		t.Fatal("invalid user or cookie")
	}
	w = request(handler, "GET", "/relay/admin/api/accounts?accountId=somebody", "", cookie, "")
	if w.Code != 200 || store.scope != session.User.ID {
		t.Fatal("account scope escaped")
	}
	w = request(handler, "POST", "/relay/admin/api/releases/upload", "", cookie, session.CSRF)
	if w.Code != 403 {
		t.Fatal("user can upload")
	}
	w = request(handler, "POST", "/relay/admin/api/auth/logout", "", cookie, "")
	if w.Code != 403 {
		t.Fatal("CSRF missing accepted")
	}
	w = request(handler, "POST", "/relay/admin/api/auth/logout", "", cookie, session.CSRF)
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	w = request(handler, "GET", "/relay/admin/api/me", "", cookie, "")
	if w.Code != 401 {
		t.Fatal("logout did not revoke")
	}
	adminCookie, admin := loginTest(t, handler, "admin@example.test", "admin-secret")
	if admin.User.Role != "admin" || admin.Policy != "" {
		t.Fatal("invalid admin response")
	}
	w = request(handler, "GET", "/relay/admin/api/overview", "", adminCookie, "")
	if w.Code != 200 || store.scope != "" {
		t.Fatal("admin missing global scope")
	}
}

// uploadTest 发送文件字段先于元数据的流式上传。参数：内容和构建号；返回值：HTTP响应；注意事项：覆盖浏览器multipart字段顺序不保证的问题。
func uploadTest(t *testing.T, handler http.Handler, cookie *http.Cookie, csrf string, content []byte, build string) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", "Chorus.apk")
	if err != nil {
		t.Fatal(err)
	}
	part.Write(content)
	for key, value := range map[string]string{"platform": "android", "arch": "universal", "version": "0.5.6", "buildNumber": build, "notes": "修复并更新"} {
		writer.WriteField(key, value)
	}
	writer.Close()
	r := httptest.NewRequest("POST", "http://relay.test/relay/admin/api/releases/upload", &body)
	r.Header.Set("Content-Type", writer.FormDataContentType())
	r.Header.Set("Origin", "http://relay.test")
	r.Header.Set("X-CSRF-Token", csrf)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

// TestReleaseLifecycle 验证上传、发布、架构匹配、校验摘要、续传及撤回。参数：t为测试句柄；返回值：无；注意事项：APK测试文件只满足容器头，签名校验由原生客户端测试。
func TestReleaseLifecycle(t *testing.T) {
	handler, _, cfg := setupAdmin(t)
	cookie, session := loginTest(t, handler, "admin@example.test", "admin-secret")
	content := append([]byte("PK\x03\x04"), bytes.Repeat([]byte("a"), 100)...)
	w := uploadTest(t, handler, cookie, session.CSRF, content, "11")
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	var payload struct {
		Release storage.Release `json:"release"`
	}
	json.Unmarshal(w.Body.Bytes(), &payload)
	item := payload.Release
	if item.SHA256 != digest(string(content)) || item.Size != int64(len(content)) || item.Status != "draft" {
		t.Fatal("metadata mismatch")
	}
	w = request(handler, "GET", item.DownloadURL, "", nil, "")
	if w.Code != 404 {
		t.Fatal("draft downloadable")
	}
	latest := "/relay/api/v1/releases/latest?platform=android&arch=arm64&currentVersion=0.5.5&currentBuild=10"
	w = request(handler, "GET", latest, "", nil, "")
	if !strings.Contains(w.Body.String(), `"release":null`) {
		t.Fatal("draft discoverable")
	}
	w = request(handler, "POST", "/relay/admin/api/releases/"+item.ID+"/publish", "", cookie, session.CSRF)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = request(handler, "GET", latest, "", nil, "")
	if !strings.Contains(w.Body.String(), item.ID) || strings.Contains(w.Body.String(), "createdBy") || strings.Contains(w.Body.String(), "downloadCount") {
		t.Fatal("bad public manifest", w.Body.String())
	}
	r := httptest.NewRequest("GET", "http://relay.test"+item.DownloadURL, nil)
	r.Header.Set("Range", "bytes=4-9")
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 206 || w.Body.String() != strings.Repeat("a", 6) {
		t.Fatal("range failed", w.Code)
	}
	w = uploadTest(t, handler, cookie, session.CSRF, content, "11")
	if w.Code != 409 {
		t.Fatal("duplicate build accepted")
	}
	w = uploadTest(t, handler, cookie, session.CSRF, bytes.Repeat([]byte("x"), 2049), "12")
	if w.Code != 413 {
		t.Fatal("oversized file accepted")
	}
	w = uploadTest(t, handler, cookie, session.CSRF, []byte("invalid-apk"), "12")
	if w.Code != 400 {
		t.Fatal("invalid package accepted")
	}
	files, _ := os.ReadDir(cfg.ReleaseDir)
	if len(files) != 1 {
		t.Fatal("failed uploads left files", len(files))
	}
	w = request(handler, "POST", "/relay/admin/api/releases/"+item.ID+"/withdraw", "", cookie, session.CSRF)
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	w = request(handler, "GET", item.DownloadURL, "", nil, "")
	if w.Code != 404 {
		t.Fatal("withdrawn downloadable")
	}
	w = request(handler, "GET", latest, "", nil, "")
	if !strings.Contains(w.Body.String(), `"release":null`) {
		t.Fatal("withdrawn discoverable")
	}
}

// TestOriginAndVersionGuards 验证跨源登录及版本降级防护。参数：t为测试句柄；返回值：无；注意事项：Mac相同语义版本不能触发重复升级。
func TestOriginAndVersionGuards(t *testing.T) {
	handler, store, _ := setupAdmin(t)
	r := httptest.NewRequest("POST", "http://relay.test/relay/admin/api/auth/login", strings.NewReader(`{"email":"admin@example.test","password":"admin-secret"}`))
	r.Header.Set("Origin", "https://evil.test")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("cross-site login accepted")
	}
	for _, item := range []storage.Release{{ID: "same", Platform: "mac", Arch: "arm64", Version: "0.5.5", BuildNumber: 99, Status: "published"}, {ID: "wrong-arch", Platform: "mac", Arch: "x64", Version: "1.0.0", BuildNumber: 100, Status: "published"}, {ID: "android-down", Platform: "android", Arch: "universal", Version: "0.5.6", BuildNumber: 8, Status: "published"}} {
		store.SaveRelease(context.Background(), item)
	}
	for _, path := range []string{"/relay/api/v1/releases/latest?platform=mac&arch=arm64&currentVersion=0.5.5&currentBuild=0", "/relay/api/v1/releases/latest?platform=android&arch=arm64&currentVersion=0.5.5&currentBuild=10"} {
		w = request(handler, "GET", path, "", nil, "")
		body, _ := io.ReadAll(w.Result().Body)
		if w.Code != 200 || !strings.Contains(string(body), `"release":null`) {
			t.Fatal("unexpected update", string(body))
		}
	}
}

// TestSharedStorageIdentity 验证挂载丢失时即使本地目录仍存在也停止发版和下载。参数：t为测试句柄；返回值：无；注意事项：共享卷恢复后无需重启，错误标识不能继续写本地。
func TestSharedStorageIdentity(t *testing.T) {
	_, store, cfg := setupAdmin(t)
	cfg.StorageID = "test-shared-volume"
	server := New(store, realtime.New(nil, "volume-test"), cfg)
	mux := http.NewServeMux()
	server.Register(mux)
	cookie, session := loginTest(t, mux, "admin@example.test", "admin-secret")
	content := append([]byte("PK\x03\x04"), bytes.Repeat([]byte("a"), 100)...)
	if server.StorageAvailable() {
		t.Fatal("无标识目录被当成共享卷")
	}
	w := uploadTest(t, mux, cookie, session.CSRF, content, "11")
	if w.Code != 503 {
		t.Fatal("标识缺失仍能上传", w.Code)
	}
	marker := cfg.ReleaseDir + "/.relay-storage-id"
	if err := os.WriteFile(marker, []byte("other-volume"), 0600); err != nil {
		t.Fatal(err)
	}
	if server.StorageAvailable() {
		t.Fatal("错误卷身份被接受")
	}
	if err := os.WriteFile(marker, []byte(cfg.StorageID+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if !server.StorageAvailable() {
		t.Fatal("正确卷身份不可用")
	}
	w = uploadTest(t, mux, cookie, session.CSRF, content, "11")
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	var payload struct {
		Release storage.Release `json:"release"`
	}
	json.Unmarshal(w.Body.Bytes(), &payload)
	id := payload.Release.ID
	// ------------ 同大小文件损坏也必须阻止发布 ---------------
	stored, _ := store.FindRelease(context.Background(), id)
	packagePath := cfg.ReleaseDir + "/" + stored.StorageKey
	if err := os.WriteFile(packagePath, bytes.Repeat([]byte("b"), len(content)), 0600); err != nil {
		t.Fatal(err)
	}
	w = request(mux, "POST", "/relay/admin/api/releases/"+id+"/publish", "", cookie, session.CSRF)
	if w.Code != 409 {
		t.Fatal("损坏文件被发布")
	}
	if err := os.WriteFile(packagePath, content, 0600); err != nil {
		t.Fatal(err)
	}
	w = request(mux, "POST", "/relay/admin/api/releases/"+id+"/publish", "", cookie, session.CSRF)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if err := os.Remove(marker); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/relay/admin/api/releases/" + id + "/publish", payload.Release.DownloadURL} {
		method := "POST"
		if strings.HasSuffix(path, "/download") {
			method = "GET"
		}
		w = request(mux, method, path, "", cookie, session.CSRF)
		if w.Code != 503 {
			t.Fatal("挂载丢失仍发布或下载", path, w.Code)
		}
	}
	if err := os.WriteFile(marker, []byte(cfg.StorageID), 0600); err != nil {
		t.Fatal(err)
	}
	w = request(mux, "GET", payload.Release.DownloadURL, "", nil, "")
	if w.Code != 200 {
		t.Fatal("恢复共享卷后未恢复下载", w.Code)
	}
}

// TestReleaseCopiesToTheOtherNode 验证上传会写入另一台节点，本机文件缺失时下载会再拉回来。
//
// 参数：t 为测试句柄。
// 返回值：无。
// 注意事项：两个处理器共享元数据，安装包目录彼此独立，用来模拟负载均衡后面的两台测试机。
func TestReleaseCopiesToTheOtherNode(t *testing.T) {
	redisServer := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: redisServer.Addr()})
	t.Cleanup(func() { client.Close() })
	hub := realtime.New(client, "release-sync")
	hash, err := bcrypt.GenerateFromPassword([]byte("admin-secret"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	store := &testStore{Memory: storage.NewMemory(), releases: map[string]storage.Release{}}
	leftDir, rightDir := t.TempDir(), t.TempDir()
	leftMux, rightMux := http.NewServeMux(), http.NewServeMux()
	leftSrv := httptest.NewServer(leftMux)
	rightSrv := httptest.NewServer(rightMux)
	t.Cleanup(leftSrv.Close)
	t.Cleanup(rightSrv.Close)
	syncKey := SyncKeyFromToken([]byte("test-token-key"))
	base := Config{Prefix: "/relay", PublicURL: "http://relay.test/relay", AdminEmails: []string{"admin@example.test"}, AdminPasswordHash: string(hash), SyncKey: syncKey, MaxUploadBytes: 2048}
	leftCfg := base
	leftCfg.ReleaseDir = leftDir
	leftCfg.Peers = []string{leftSrv.URL, rightSrv.URL}
	leftCfg.SelfURL = leftSrv.URL
	rightCfg := base
	rightCfg.ReleaseDir = rightDir
	rightCfg.Peers = []string{leftSrv.URL, rightSrv.URL}
	rightCfg.SelfURL = rightSrv.URL
	New(store, hub, leftCfg).Register(leftMux)
	New(store, hub, rightCfg).Register(rightMux)
	cookie, session := loginTest(t, leftMux, "admin@example.test", "admin-secret")
	content := append([]byte("PK\x03\x04"), bytes.Repeat([]byte("a"), 80)...)
	forged := httptest.NewRequest(http.MethodPut, rightSrv.URL+"/relay/internal/release-blobs/11111111-1111-1111-1111-111111111111.apk", bytes.NewReader(content))
	forged.Header.Set("X-Release-SHA256", digest(string(content)))
	forged.Header.Set("X-Release-Size", "84")
	rejected := httptest.NewRecorder()
	rightMux.ServeHTTP(rejected, forged)
	if rejected.Code != 404 {
		t.Fatal("未签名同步被接受", rejected.Code)
	}
	w := uploadTest(t, leftMux, cookie, session.CSRF, content, "21")
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	var payload struct {
		Release storage.Release `json:"release"`
	}
	if err = json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	stored, err := store.FindRelease(context.Background(), payload.Release.ID)
	if err != nil {
		t.Fatal(err)
	}
	copied, err := os.ReadFile(rightDir + "/" + stored.StorageKey)
	if err != nil || !bytes.Equal(copied, content) {
		t.Fatal("另一台节点没有收到安装包", err)
	}
	if err = os.Remove(rightDir + "/" + stored.StorageKey); err != nil {
		t.Fatal(err)
	}
	w = request(leftMux, "POST", "/relay/admin/api/releases/"+payload.Release.ID+"/publish", "", cookie, session.CSRF)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = request(rightMux, "GET", payload.Release.DownloadURL, "", nil, "")
	if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), content) {
		t.Fatal("对端缺失时未能拉回安装包", w.Code, w.Body.Len())
	}
	restored, err := os.ReadFile(rightDir + "/" + stored.StorageKey)
	if err != nil || !bytes.Equal(restored, content) {
		t.Fatal("拉回的安装包未保存到本机目录", err)
	}
}

// rawRequest 发送原始请求体。参数：method/path/body/cookie/csrf 为 HTTP 字段；返回值：记录响应；注意事项：用于分段上传，不强制 JSON。
func rawRequest(handler http.Handler, method, path string, body []byte, cookie *http.Cookie, csrf string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://relay.test"+path, bytes.NewReader(body))
	r.Header.Set("Origin", "http://relay.test")
	if cookie != nil {
		r.AddCookie(cookie)
	}
	if csrf != "" {
		r.Header.Set("X-CSRF-Token", csrf)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

// apkBytes 构造最小 APK 容器。参数：n 为头之后的填充长度；返回值：以 ZIP 头开头的字节；注意事项：只满足容器头检查，不是可安装包。
func apkBytes(n int) []byte {
	return append([]byte("PK\x03\x04"), bytes.Repeat([]byte("a"), n)...)
}

// TestChunkedUploadCanBeCancelled 验证分段上传、中断删半成品，以及手动登记。
//
// 参数：t 为测试句柄。
// 返回值：无。
// 注意事项：临时把单段大小调小，结束时恢复，避免影响其他测试。
func TestChunkedUploadCanBeCancelled(t *testing.T) {
	previous := uploadChunkBytes
	uploadChunkBytes = 30
	t.Cleanup(func() { uploadChunkBytes = previous })
	redisServer := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: redisServer.Addr()})
	t.Cleanup(func() { client.Close() })
	hub := realtime.New(client, "chunk-upload")
	hash, err := bcrypt.GenerateFromPassword([]byte("admin-secret"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	store := &testStore{Memory: storage.NewMemory(), releases: map[string]storage.Release{}}
	cfg := Config{Prefix: "/relay", PublicURL: "http://relay.test/relay", AdminEmails: []string{"admin@example.test"}, AdminPasswordHash: string(hash), ReleaseDir: dir, HostDir: "/srv/releases", Nodes: []string{"10.1.1.1", "10.1.1.2"}, SelfURL: "http://10.1.1.1:5006", MaxUploadBytes: 2048}
	mux := http.NewServeMux()
	New(store, hub, cfg).Register(mux)
	cookie, session := loginTest(t, mux, "admin@example.test", "admin-secret")
	content := apkBytes(66)
	meta := fmt.Sprintf(`{"platform":"android","arch":"universal","version":"1.2.0","buildNumber":31,"notes":"分段","fileName":"app.apk","size":%d}`, len(content))
	created := request(mux, "POST", "/relay/admin/api/releases/uploads", meta, cookie, session.CSRF)
	if created.Code != 201 {
		t.Fatal(created.Code, created.Body.String())
	}
	var started struct {
		ID         string `json:"id"`
		ChunkBytes int64  `json:"chunkBytes"`
	}
	if err = json.Unmarshal(created.Body.Bytes(), &started); err != nil || started.ChunkBytes != 30 {
		t.Fatal(created.Body.String(), err)
	}
	var received int64
	for received < int64(len(content)) {
		end := received + uploadChunkBytes
		if end > int64(len(content)) {
			end = int64(len(content))
		}
		part := rawRequest(mux, "PUT", fmt.Sprintf("/relay/admin/api/releases/uploads/%s?offset=%d", started.ID, received), content[received:end], cookie, session.CSRF)
		if part.Code != 200 {
			t.Fatal(part.Code, part.Body.String())
		}
		var progress struct {
			Received int64 `json:"received"`
		}
		if err = json.Unmarshal(part.Body.Bytes(), &progress); err != nil || progress.Received <= received {
			t.Fatal(part.Body.String(), err)
		}
		received = progress.Received
	}
	again := rawRequest(mux, "PUT", fmt.Sprintf("/relay/admin/api/releases/uploads/%s?offset=0", started.ID), content[:30], cookie, session.CSRF)
	if again.Code != 200 || !strings.Contains(again.Body.String(), fmt.Sprintf(`"received":%d`, len(content))) {
		t.Fatal("重复分段未按已写入确认", again.Code, again.Body.String())
	}
	finished := rawRequest(mux, "POST", "/relay/admin/api/releases/uploads/"+started.ID+"/finish", nil, cookie, session.CSRF)
	if finished.Code != 201 {
		t.Fatal(finished.Code, finished.Body.String())
	}
	var saved struct {
		Release   storage.Release `json:"release"`
		Locations []struct {
			Host string `json:"host"`
			Path string `json:"path"`
		} `json:"locations"`
	}
	if err = json.Unmarshal(finished.Body.Bytes(), &saved); err != nil {
		t.Fatal(err)
	}
	storageKey := saved.Release.ID + ".apk"
	if saved.Release.StoragePath != "/srv/releases/"+storageKey || len(saved.Locations) != 1 || saved.Locations[0].Host != "10.1.1.1" || saved.Locations[0].Path != saved.Release.StoragePath {
		t.Fatal("未返回实际目录", finished.Body.String())
	}
	stored, err := os.ReadFile(dir + "/" + storageKey)
	if err != nil || !bytes.Equal(stored, content) {
		t.Fatal("分段合并结果不正确", err)
	}
	if _, err = os.Stat(dir + "/.part-" + started.ID); !os.IsNotExist(err) {
		t.Fatal("完成后仍留下半成品", err)
	}
	listed := request(mux, "GET", "/relay/admin/api/releases", "", cookie, session.CSRF)
	if !strings.Contains(listed.Body.String(), `"/srv/releases"`) || !strings.Contains(listed.Body.String(), saved.Release.StoragePath) {
		t.Fatal("列表没有目录", listed.Body.String())
	}
	// ------------ 中断必须删掉未完成文件，之后不能再登记 ---------------
	partial := apkBytes(40)
	meta = fmt.Sprintf(`{"platform":"android","arch":"universal","version":"1.2.1","buildNumber":32,"notes":"中断","fileName":"partial.apk","size":%d}`, len(partial))
	created = request(mux, "POST", "/relay/admin/api/releases/uploads", meta, cookie, session.CSRF)
	if created.Code != 201 {
		t.Fatal(created.Code, created.Body.String())
	}
	json.Unmarshal(created.Body.Bytes(), &started)
	part := rawRequest(mux, "PUT", fmt.Sprintf("/relay/admin/api/releases/uploads/%s?offset=0", started.ID), partial[:30], cookie, session.CSRF)
	if part.Code != 200 {
		t.Fatal(part.Code, part.Body.String())
	}
	cancelled := rawRequest(mux, "DELETE", "/relay/admin/api/releases/uploads/"+started.ID, nil, cookie, session.CSRF)
	if cancelled.Code != 204 {
		t.Fatal(cancelled.Code, cancelled.Body.String())
	}
	if _, err = os.Stat(dir + "/.part-" + started.ID); !os.IsNotExist(err) {
		t.Fatal("中断后半成品还在", err)
	}
	if again = rawRequest(mux, "POST", "/relay/admin/api/releases/uploads/"+started.ID+"/finish", nil, cookie, session.CSRF); again.Code != 404 {
		t.Fatal("中断后仍能完成", again.Code)
	}
	// ------------ 手动放到目录后按原文件名登记，成功后改成服务文件名 ---------------
	manual := apkBytes(20)
	if err = os.WriteFile(dir+"/Chorus.apk", manual, 0600); err != nil {
		t.Fatal(err)
	}
	imported := request(mux, "POST", "/relay/admin/api/releases/import", `{"platform":"android","arch":"universal","version":"1.2.2","buildNumber":33,"notes":"手动","fileName":"Chorus.apk"}`, cookie, session.CSRF)
	if imported.Code != 201 {
		t.Fatal(imported.Code, imported.Body.String())
	}
	if _, err = os.Stat(dir + "/Chorus.apk"); !os.IsNotExist(err) {
		t.Fatal("登记后仍保留原文件名", err)
	}
	rejected := request(mux, "POST", "/relay/admin/api/releases/import", `{"platform":"android","arch":"universal","version":"1.2.3","buildNumber":34,"notes":"路径","fileName":"../Chorus.apk"}`, cookie, session.CSRF)
	if rejected.Code != 400 {
		t.Fatal("路径文件名被接受", rejected.Code)
	}
}

// TestChunkedUploadGoesToWriter 验证非写入节点把分段转给写入节点。
//
// 参数：t 为测试句柄。
// 返回值：无。
// 注意事项：两台机器目录独立且不互相同步，用来确认文件没有写在转发节点上。
func TestChunkedUploadGoesToWriter(t *testing.T) {
	redisServer := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: redisServer.Addr()})
	t.Cleanup(func() { client.Close() })
	hub := realtime.New(client, "chunk-forward")
	hash, err := bcrypt.GenerateFromPassword([]byte("admin-secret"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	store := &testStore{Memory: storage.NewMemory(), releases: map[string]storage.Release{}}
	leftDir, rightDir := t.TempDir(), t.TempDir()
	leftMux, rightMux := http.NewServeMux(), http.NewServeMux()
	leftSrv, rightSrv := httptest.NewServer(leftMux), httptest.NewServer(rightMux)
	t.Cleanup(leftSrv.Close)
	t.Cleanup(rightSrv.Close)
	base := Config{Prefix: "/relay", PublicURL: "http://relay.test/relay", AdminEmails: []string{"admin@example.test"}, AdminPasswordHash: string(hash), SyncKey: SyncKeyFromToken([]byte("test-token-key")), WriterURL: rightSrv.URL, MaxUploadBytes: 2048}
	leftCfg, rightCfg := base, base
	leftCfg.ReleaseDir, leftCfg.SelfURL = leftDir, leftSrv.URL
	rightCfg.ReleaseDir, rightCfg.SelfURL = rightDir, rightSrv.URL
	New(store, hub, leftCfg).Register(leftMux)
	New(store, hub, rightCfg).Register(rightMux)
	cookie, session := loginTest(t, leftMux, "admin@example.test", "admin-secret")
	content := apkBytes(40)
	meta := fmt.Sprintf(`{"platform":"android","arch":"universal","version":"1.3.0","buildNumber":41,"notes":"转发","fileName":"forward.apk","size":%d}`, len(content))
	created := request(leftMux, "POST", "/relay/admin/api/releases/uploads", meta, cookie, session.CSRF)
	if created.Code != 201 {
		t.Fatal(created.Code, created.Body.String())
	}
	var started struct {
		ID string `json:"id"`
	}
	if err = json.Unmarshal(created.Body.Bytes(), &started); err != nil {
		t.Fatal(err)
	}
	part := rawRequest(leftMux, "PUT", fmt.Sprintf("/relay/admin/api/releases/uploads/%s?offset=0", started.ID), content, cookie, session.CSRF)
	if part.Code != 200 {
		t.Fatal(part.Code, part.Body.String())
	}
	finished := rawRequest(leftMux, "POST", "/relay/admin/api/releases/uploads/"+started.ID+"/finish", nil, cookie, session.CSRF)
	if finished.Code != 201 {
		t.Fatal(finished.Code, finished.Body.String())
	}
	var saved struct {
		Release storage.Release `json:"release"`
	}
	if err = json.Unmarshal(finished.Body.Bytes(), &saved); err != nil {
		t.Fatal(err)
	}
	storageKey := saved.Release.ID + ".apk"
	if _, err = os.Stat(leftDir + "/" + storageKey); !os.IsNotExist(err) {
		t.Fatal("转发节点自己保存了安装包", err)
	}
	copied, err := os.ReadFile(rightDir + "/" + storageKey)
	if err != nil || !bytes.Equal(copied, content) {
		t.Fatal("写入节点没有安装包", err)
	}
}
