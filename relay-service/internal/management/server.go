// Package management 提供独立浏览器会话、账号统计和客户端版本发布。
package management

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/mail"
	"net/url"
	"strconv"
	"strings"
	"time"

	"agents-team-relay/internal/logx"
	"agents-team-relay/internal/realtime"
	"agents-team-relay/internal/storage"

	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

// Config 指定后台信任边界和安装包存储。参数：AdminEmails 与 AdminPasswordHash 是预置管理员身份，ReleaseDir 为共享持久目录；返回值：供 New 构造；注意事项：管理员密码摘要不在公开注册流程中创建。
type Config struct {
	Prefix                 string
	PublicURL              string
	AdminEmails            []string
	AdminPasswordHash      string
	SuperadminEmail        string
	SuperadminPasswordHash string
	ProtectedGoogleEmail   string
	ReleaseDir             string
	StorageID              string
	Peers                  []string
	SelfURL                string
	WriterURL              string
	HostDir                string
	Nodes                  []string
	SyncKey                []byte
	MaxUploadBytes         int64
}

// Server 绑定共享存储和后台配置。参数：store 与 hub 提供跨节点数据；返回值：独立 HTTP 路由；注意事项：每次请求重新检查管理员配置。
type Server struct {
	store  storage.ManagementStore
	hub    *realtime.Hub
	cfg    Config
	origin string
	secure bool
}

// User 是浏览器会话允许公开的身份。参数：字段来自服务端认证；返回值：JSON身份；注意事项：不携带客户端设备令牌。
type User struct {
	ID         string `json:"id"`
	Email      string `json:"email"`
	Name       string `json:"name"`
	Role       string `json:"role"`
	EmployeeID string `json:"employeeId,omitempty"`
}

// Session 是 Redis 保存的浏览器会话。参数：User 为认证结果，CSRF 为独立随机令牌；返回值：会话记录；注意事项：Redis key 只保存 cookie 摘要。
type Session struct {
	User            User   `json:"user"`
	CSRF            string `json:"csrfToken"`
	Policy          string `json:"policy,omitempty"`
	CredentialStamp string `json:"credentialStamp,omitempty"`
}

// New 创建后台处理器。参数：store/hub 是共享依赖，cfg 控制发布和权限；返回值：服务器；注意事项：空 ReleaseDir 仅禁用上传和下载，不阻止统计后台启动。
func New(store storage.ManagementStore, hub *realtime.Hub, cfg Config) *Server {
	cfg.Prefix = strings.TrimRight(cfg.Prefix, "/")
	if cfg.MaxUploadBytes == 0 {
		cfg.MaxUploadBytes = 2 << 30
	}
	public, _ := url.Parse(cfg.PublicURL)
	origin := ""
	secure := false
	if public != nil && public.Host != "" {
		origin = public.Scheme + "://" + public.Host
		secure = public.Scheme == "https"
	}
	return &Server{store: store, hub: hub, cfg: cfg, origin: origin, secure: secure}
}

// Register 注册后台 API 和公开更新路由。参数：mux 为主服务路由；返回值：无；注意事项：静态管理页面由独立 adminweb 模块挂载。
func (s *Server) Register(mux *http.ServeMux) {
	base := s.cfg.Prefix + "/admin/api/"
	mux.HandleFunc("POST "+base+"auth/register", s.register)
	mux.HandleFunc("POST "+base+"auth/login", s.login)
	mux.HandleFunc("POST "+base+"auth/logout", s.logout)
	mux.HandleFunc("GET "+base+"me", s.me)
	mux.HandleFunc("GET "+base+"overview", s.overview)
	for _, kind := range []string{"accounts", "devices", "tasks"} {
		mux.HandleFunc("GET "+base+kind, s.list)
	}
	mux.HandleFunc("PATCH "+base+"accounts/{id}", s.updateAccount)
	mux.HandleFunc("POST "+base+"accounts/{id}/reset-password", s.resetPassword)
	mux.HandleFunc("DELETE "+base+"accounts/{id}", s.deleteAccount)
	mux.HandleFunc("GET "+base+"releases", s.releases)
	mux.HandleFunc("POST "+base+"releases/upload", s.upload)
	mux.HandleFunc("POST "+base+"releases/uploads", s.createUpload)
	mux.HandleFunc("PUT "+base+"releases/uploads/{id}", s.writeUploadChunk)
	mux.HandleFunc("POST "+base+"releases/uploads/{id}/finish", s.finishUpload)
	mux.HandleFunc("DELETE "+base+"releases/uploads/{id}", s.cancelUpload)
	mux.HandleFunc("POST "+base+"releases/import", s.importRelease)
	mux.HandleFunc("POST "+base+"releases/{id}/publish", s.publish)
	mux.HandleFunc("POST "+base+"releases/{id}/withdraw", s.withdraw)
	mux.HandleFunc("GET "+s.cfg.Prefix+"/api/v1/releases/latest", s.latest)
	mux.HandleFunc("GET "+s.cfg.Prefix+"/api/v1/releases/{id}/download", s.download)
	mux.HandleFunc("PUT "+s.cfg.Prefix+"/internal/release-blobs/{name}", s.receivePackage)
	mux.HandleFunc("GET "+s.cfg.Prefix+"/internal/release-blobs/{name}", s.serveInternalPackage)
}

// jsonResponse 写统一后台响应。参数：status 为 HTTP 状态，body 为载荷；返回值：无；注意事项：浏览器会话及统计禁止缓存。
func jsonResponse(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		logx.Warnf("后台响应写入失败")
	}
}

// apiError 输出不包含底层敏感细节的错误。参数：code/message 为可公开错误；返回值：无；注意事项：详细错误只写服务端日志。
func apiError(w http.ResponseWriter, status int, code, message string) {
	jsonResponse(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}

// internalError 记录异常并统一返回临时失败。参数：err 为内部错误；返回值：无；注意事项：不能传入含密码和令牌的错误。
func internalError(w http.ResponseWriter, err error) {
	logx.Errorf("后台处理异常 err=" + err.Error())
	apiError(w, 503, "UNAVAILABLE", "服务暂时不可用，请稍后重试")
}

// decode 解析有界且严格的 JSON。参数：dst 为目标指针；返回值：解析是否成功；注意事项：拒绝多段 JSON 与未知字段。
func decode(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 16*1024)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		apiError(w, 400, "INVALID", "请求格式不正确")
		return false
	}
	if decoder.Decode(new(any)) != io.EOF {
		apiError(w, 400, "INVALID", "请求格式不正确")
		return false
	}
	return true
}

// sameOrigin 验证浏览器写请求来源。参数：r 为请求；返回值：是否可信；注意事项：忽略可伪造 Forwarded 头，反向代理部署使用 PublicURL。
func (s *Server) sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return false
	}
	expected := s.origin
	if expected == "" {
		scheme := "http"
		if r.TLS != nil {
			scheme = "https"
		}
		expected = scheme + "://" + r.Host
	}
	return origin == expected && r.Header.Get("Sec-Fetch-Site") != "cross-site"
}

// allowAuth 按共享 Redis 计数限制认证尝试。参数：请求的 TCP 地址用于限流；返回值：是否继续；注意事项：不信任客户端伪造 X-Forwarded-For，Redis异常时关闭身份签发。
func (s *Server) allowAuth(w http.ResponseWriter, r *http.Request, email string) bool {
	if !s.sameOrigin(r) {
		apiError(w, 403, "ORIGIN_REJECTED", "请求来源不允许")
		return false
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if !s.hub.AllowAttempt(r.Context(), "admin:ip:"+digest(host), 60, time.Minute) || !s.hub.AllowAttempt(r.Context(), "admin:account:"+digest(email), 10, 10*time.Minute) {
		w.Header().Set("Retry-After", "60")
		apiError(w, 429, "RATE_LIMITED", "登录尝试过于频繁，请稍后再试")
		return false
	}
	return true
}

// adminEmail 判断邮箱是否属于预置管理员。参数：email 为小写邮箱；返回值：是否命中；注意事项：命中邮箱本身不授予权限，还必须校验独立配置密码。
func (s *Server) adminEmail(email string) bool {
	if s.cfg.SuperadminEmail != "" && strings.EqualFold(email, s.cfg.SuperadminEmail) {
		return true
	}
	for _, item := range s.cfg.AdminEmails {
		if strings.EqualFold(strings.TrimSpace(item), email) {
			return true
		}
	}
	return false
}

// validCredentials 校验邮箱和密码长度。参数：email/password 为表单数据；返回值：是否合法；注意事项：bcrypt 最多接受 72 字节密码。
func validCredentials(email, password string) bool {
	parsed, err := mail.ParseAddress(email)
	return err == nil && parsed.Address == email && len(email) <= 254 && len(password) >= 8 && len(password) <= 72
}

// register 创建普通账号并签发浏览器会话。参数：JSON包含邮箱、名称、密码；返回值：身份与CSRF；注意事项：不会创建设备，不允许注册预置管理员邮箱。
func (s *Server) register(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Email    string `json:"email"`
		Name     string `json:"name"`
		Password string `json:"password"`
	}
	if !decode(w, r, &input) {
		return
	}
	input.Email = strings.ToLower(strings.TrimSpace(input.Email))
	if !s.allowAuth(w, r, input.Email) {
		return
	}
	if !validCredentials(input.Email, input.Password) || len([]rune(input.Name)) > 128 {
		apiError(w, 400, "INVALID", "请填写有效邮箱、8到72字节密码及不超过128字符的姓名")
		return
	}
	if s.protectedEmail(input.Email) {
		apiError(w, 409, "RESERVED_ACCOUNT", "此账号由管理员预置，请直接登录")
		return
	}
	logx.Infof("------------- 后台注册普通账号 --------------")
	hash, err := bcrypt.GenerateFromPassword([]byte(input.Password), bcrypt.DefaultCost)
	if err != nil {
		internalError(w, err)
		return
	}
	name := strings.TrimSpace(input.Name)
	if name == "" {
		name = strings.Split(input.Email, "@")[0]
	}
	account, err := s.store.RegisterEmail(r.Context(), storage.Account{ID: uuid.NewString(), Email: input.Email, Name: name, Provider: "email"}, string(hash))
	if errors.Is(err, storage.ErrAccountExists) {
		apiError(w, 409, "ACCOUNT_EXISTS", "邮箱已注册，请登录")
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	s.issue(w, r, User{ID: account.ID, Email: account.Email, Name: account.Name, Role: "user"}, string(hash), 0)
}

const dummyHash = "$2a$10$7EqJtq98hPqEX7fNZaFWoO5jEWtF2hV0HGbQ9q1GyCKshizT8oL8K"

// login 使用独立管理员凭据或普通账号密码登录。参数：邮箱和密码；返回值：浏览器身份；注意事项：公开客户端注册的同名邮箱绝不能获取管理员身份。
func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !decode(w, r, &input) {
		return
	}
	input.Email = strings.ToLower(strings.TrimSpace(input.Email))
	if !s.allowAuth(w, r, input.Email) {
		return
	}
	if !validCredentials(input.Email, input.Password) {
		apiError(w, 401, "UNAUTHORIZED", "邮箱或密码不正确")
		return
	}
	logx.Infof("------------- 后台账号登录 --------------")
	if user, hash, ok := s.privilegedIdentity(input.Email); ok {
		if hash != "" && bcrypt.CompareHashAndPassword([]byte(hash), []byte(input.Password)) == nil {
			s.issue(w, r, user, "", -1)
			return
		}
		apiError(w, 401, "UNAUTHORIZED", "邮箱或密码不正确")
		return
	}

	account, err := s.store.FindAccountByEmail(r.Context(), input.Email)
	if err != nil && !errors.Is(err, storage.ErrNotFound) {
		internalError(w, err)
		return
	}
	hash := dummyHash
	var credentialVersion int64
	if err == nil && account.Provider == "email" {
		value, version, e := s.store.PasswordState(r.Context(), account.ID)
		if e != nil && !errors.Is(e, storage.ErrNotFound) {
			internalError(w, e)
			return
		}
		if e == nil {
			hash = value
			credentialVersion = version
		}
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(input.Password)) != nil || hash == dummyHash {
		logx.Warnf("后台登录拒绝")
		apiError(w, 401, "UNAUTHORIZED", "邮箱或密码不正确")
		return
	}
	s.issue(w, r, User{ID: account.ID, Email: account.Email, Name: account.Name, Role: "user"}, hash, credentialVersion)
}

// issue 签发8小时HttpOnly会话。参数：user 已完成认证；返回值：公开身份和CSRF；注意事项：原 cookie 会话先撤销以避免遗留会话累积。
func (s *Server) issue(w http.ResponseWriter, r *http.Request, user User, passwordHash string, credentialVersion int64) {
	if old, err := r.Cookie("relay_admin_session"); err == nil {
		_, _ = s.hub.TakeTransient(r.Context(), "admin:session:"+digest(old.Value))
	}
	token := uuid.NewString() + uuid.NewString()
	session := Session{User: user, CSRF: uuid.NewString()}
	if isAdministrator(user.Role) {
		_, hash, _ := s.privilegedIdentity(user.Email)
		session.Policy = digest(user.Role + ":" + hash)
	} else {
		session.CredentialStamp = digest(passwordHash + ":" + strconv.FormatInt(credentialVersion, 10))
	}
	data, err := json.Marshal(session)
	if err != nil {
		internalError(w, err)
		return
	}
	if err = s.hub.PutTransient(r.Context(), "admin:session:"+digest(token), string(data), 8*time.Hour); err != nil {
		internalError(w, err)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: "relay_admin_session", Value: token, Path: s.cfg.Prefix + "/admin/", HttpOnly: true, Secure: s.secure, SameSite: http.SameSiteStrictMode, MaxAge: 8 * 3600})
	logx.Infof("后台会话已签发 account=" + user.ID + " role=" + user.Role)
	jsonResponse(w, 200, map[string]any{"user": session.User, "csrfToken": session.CSRF})
}

// authenticate 验证会话及写操作CSRF。参数：adminOnly 指定是否只允许管理员；返回值：会话和是否授权；注意事项：密码配置更换后已有管理员会话立即失效。
func (s *Server) authenticate(w http.ResponseWriter, r *http.Request, adminOnly bool) (Session, bool) {
	cookie, err := r.Cookie("relay_admin_session")
	if err != nil || len(cookie.Value) > 128 {
		apiError(w, 401, "UNAUTHORIZED", "请先登录")
		return Session{}, false
	}
	data, err := s.hub.GetTransient(r.Context(), "admin:session:"+digest(cookie.Value))
	if err != nil {
		if !realtime.IsTransientMissing(err) {
			internalError(w, err)
		} else {
			apiError(w, 401, "UNAUTHORIZED", "会话已过期，请重新登录")
		}
		return Session{}, false
	}
	var session Session
	if json.Unmarshal([]byte(data), &session) != nil || session.User.ID == "" {
		apiError(w, 401, "UNAUTHORIZED", "会话无效")
		return Session{}, false
	}
	if isAdministrator(session.User.Role) {
		current, hash, valid := s.privilegedIdentity(session.User.Email)
		if !valid || current.Role != session.User.Role || session.Policy != digest(current.Role+":"+hash) {
			apiError(w, 401, "UNAUTHORIZED", "管理员配置已更新，请重新登录")
			return Session{}, false
		}
		session.User = current
	} else {
		account, err := s.store.FindAccountByEmail(r.Context(), session.User.Email)
		if err != nil && !errors.Is(err, storage.ErrNotFound) {
			internalError(w, err)
			return Session{}, false
		}
		if err != nil || account.ID != session.User.ID || account.Provider != "email" {
			apiError(w, 401, "UNAUTHORIZED", "账号已变更，请重新登录")
			return Session{}, false
		}
		hash, version, err := s.store.PasswordState(r.Context(), account.ID)
		if err != nil && !errors.Is(err, storage.ErrNotFound) {
			internalError(w, err)
			return Session{}, false
		}
		if err != nil || session.CredentialStamp == "" || subtle.ConstantTimeCompare([]byte(session.CredentialStamp), []byte(digest(hash+":"+strconv.FormatInt(version, 10)))) != 1 {
			apiError(w, 401, "UNAUTHORIZED", "密码已更新，请重新登录")
			return Session{}, false
		}
		session.User.Name = account.Name
	}
	if adminOnly && !isAdministrator(session.User.Role) {
		apiError(w, 403, "FORBIDDEN", "仅管理员可发布版本")
		return Session{}, false
	}

	if r.Method != "GET" && r.Method != "HEAD" {
		if !s.sameOrigin(r) || subtle.ConstantTimeCompare([]byte(r.Header.Get("X-CSRF-Token")), []byte(session.CSRF)) != 1 {
			apiError(w, 403, "CSRF_REJECTED", "页面已失效，请刷新后重试")
			return Session{}, false
		}
	}
	return session, true
}

// me 返回当前会话身份。参数：请求cookie；返回值：身份和CSRF；注意事项：不向客户端返回管理员策略摘要。
func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	session, ok := s.authenticate(w, r, false)
	if ok {
		jsonResponse(w, 200, map[string]any{"user": session.User, "csrfToken": session.CSRF})
	}
}

// logout 撤销当前浏览器会话。参数：CSRF认证请求；返回值：退出结果；注意事项：不撤销客户端设备会话。
func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.authenticate(w, r, false); !ok {
		return
	}
	cookie, _ := r.Cookie("relay_admin_session")
	if _, err := s.hub.TakeTransient(r.Context(), "admin:session:"+digest(cookie.Value)); err != nil && !realtime.IsTransientMissing(err) {
		internalError(w, err)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: "relay_admin_session", Path: s.cfg.Prefix + "/admin/", HttpOnly: true, Secure: s.secure, SameSite: http.SameSiteStrictMode, MaxAge: -1})
	logx.Infof("后台会话已退出")
	jsonResponse(w, 200, map[string]string{"status": "ok"})
}

// scopeAccount 将身份转换为查询范围。参数：session 已验证；返回值：普通账号ID或管理员空范围；注意事项：不接受URL中的accountId覆盖。
func scopeAccount(session Session) string {
	if isAdministrator(session.User.Role) {
		return ""
	}
	return session.User.ID
}

// overview 返回运营概览。参数：认证请求可包含startDate/endDate；返回值：所属范围指标和逐日趋势；注意事项：日期筛选只影响趋势，累计及实时指标保持原口径。
func (s *Server) overview(w http.ResponseWriter, r *http.Request) {
	session, ok := s.authenticate(w, r, false)
	if !ok {
		return
	}
	start, end, err := overviewDateRange(r.URL.Query(), time.Now())
	if err != nil {
		apiError(w, 400, "INVALID_DATE_RANGE", err.Error())
		return
	}
	logx.Infof("------------- 查询后台趋势 start=" + start.Format("2006-01-02") + " end=" + end.Format("2006-01-02") + " account=" + session.User.ID + " --------------")
	value, err := s.store.ManagementOverview(r.Context(), scopeAccount(session), start, end)
	if err != nil {
		internalError(w, err)
		return
	}
	value["releaseUploadEnabled"] = s.StorageAvailable()
	value["range"] = map[string]any{"startDate": start.Format("2006-01-02"), "endDate": end.Format("2006-01-02"), "days": int(end.Sub(start)/(24*time.Hour)) + 1}
	jsonResponse(w, 200, value)
}

// pagination 读取并限制分页。参数：查询参数；返回值：页码及每页数；注意事项：最大100条，防止后台加载全库。
func pagination(r *http.Request) (int, int) {
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	size, _ := strconv.Atoi(r.URL.Query().Get("pageSize"))
	if page < 1 {
		page = 1
	}
	if page > 100000 {
		page = 100000
	}
	if size < 1 {
		size = 20
	}
	if size > 100 {
		size = 100
	}
	return page, size
}

// list 返回账号、设备或任务元数据。参数：q/status 和分页条件；返回值：受账号隔离的列表；注意事项：不返回聊天正文和认证信息。
func (s *Server) list(w http.ResponseWriter, r *http.Request) {
	session, ok := s.authenticate(w, r, false)
	if !ok {
		return
	}
	kind := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(q) > 128 {
		apiError(w, 400, "INVALID", "搜索内容不能超过128字节")
		return
	}
	page, size := pagination(r)
	items, total, err := s.store.ManagementList(r.Context(), scopeAccount(session), kind, q, r.URL.Query().Get("status"), page, size)
	if err != nil {
		internalError(w, err)
		return
	}
	if kind == "accounts" {
		for _, item := range items {
			email, _ := item["email"].(string)
			item["protected"] = s.protectedEmail(email)
		}
	}
	jsonResponse(w, 200, map[string]any{"items": items, "total": total, "page": page, "pageSize": size})
}

// digest 生成会话和限流键摘要。参数：value为原始值；返回值：十六进制SHA256；注意事项：明文cookie不能作为Redis key或日志。
func digest(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
