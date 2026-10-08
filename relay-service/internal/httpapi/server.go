// Package httpapi 提供账号、设备、聊天同步和执行任务的 HTTP / WebSocket 接口。
package httpapi

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"agents-team-relay/internal/adminweb"
	"agents-team-relay/internal/logx"
	"agents-team-relay/internal/management"
	"agents-team-relay/internal/realtime"
	"agents-team-relay/internal/service"
	"agents-team-relay/internal/storage"
)

// Server 绑定业务服务和在线状态。
type Server struct {
	service    *service.Service
	store      storage.Store
	hub        *realtime.Hub
	prefix     string
	oauth      OAuthConfig
	management *management.Server
}

// New 创建接口服务器。
//
// 参数：svc 为业务服务；store 用于就绪检查；hub 提供在线和广播；prefix 为对外路径前缀。
// 返回值：尚未监听端口的服务器。
// 注意事项：前缀形如 /agents-team，不包含末尾斜线。
func New(svc *service.Service, store storage.Store, hub *realtime.Hub, prefix string) *Server {
	return &Server{service: svc, store: store, hub: hub, prefix: strings.TrimRight(prefix, "/")}
}

// Handler 返回带跨域和访问日志的路由。
//
// 参数：无。
// 返回值：可交给 http.Server 的处理器。
// 注意事项：日志只记录路径，不记录查询串，避免设备令牌进入日志。
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.health)
	mux.HandleFunc("GET "+s.prefix+"/health", s.health)
	mux.HandleFunc("GET "+s.prefix+"/ready", s.ready)
	mux.HandleFunc("GET "+s.prefix+"/api/v1/config", s.publicConfig)
	mux.HandleFunc("POST "+s.prefix+"/api/v1/auth/google/start", s.googleStart)
	mux.HandleFunc("POST "+s.prefix+"/api/v1/auth/google/poll", s.googlePoll)
	mux.HandleFunc("GET "+s.prefix+"/api/v1/auth/google/callback", s.googleCallback)
	mux.HandleFunc("POST "+s.prefix+"/api/v1/auth/logout", s.logout)
	mux.HandleFunc("GET "+s.prefix+"/api/v1/auth/session", s.currentSession)
	mux.HandleFunc("POST "+s.prefix+"/api/v1/auth/google", s.loginGoogle)
	mux.HandleFunc("POST "+s.prefix+"/api/v1/auth/email", s.loginEmail)
	mux.HandleFunc("GET "+s.prefix+"/api/v1/devices", s.listDevices)
	mux.HandleFunc("POST "+s.prefix+"/api/v1/devices/invites", s.createInvite)
	mux.HandleFunc("POST "+s.prefix+"/api/v1/devices/{id}/primary", s.setPrimary)
	mux.HandleFunc("DELETE "+s.prefix+"/api/v1/devices/{id}", s.revokeDevice)
	mux.HandleFunc("GET "+s.prefix+"/api/v1/state", s.getState)
	mux.HandleFunc("GET "+s.prefix+"/api/v1/host-config/key", s.getHostConfigKey)
	mux.HandleFunc("PUT "+s.prefix+"/api/v1/host-config/key", s.putHostConfigKey)
	mux.HandleFunc("DELETE "+s.prefix+"/api/v1/host-config/key", s.deleteHostConfigKey)
	mux.HandleFunc("POST "+s.prefix+"/api/v1/host-config/commands", s.createHostCommand)
	mux.HandleFunc("GET "+s.prefix+"/api/v1/host-config/commands", s.claimHostCommand)
	mux.HandleFunc("GET "+s.prefix+"/api/v1/host-config/commands/{id}", s.getHostCommand)
	mux.HandleFunc("PUT "+s.prefix+"/api/v1/host-config/commands/{id}", s.completeHostCommand)
	mux.HandleFunc("PUT "+s.prefix+"/api/v1/state", s.putState)
	mux.HandleFunc("POST "+s.prefix+"/api/v1/agents", s.mutateAgentConfig)
	mux.HandleFunc("PATCH "+s.prefix+"/api/v1/agents/{id}", s.patchAgentConfig)
	mux.HandleFunc("DELETE "+s.prefix+"/api/v1/agents/{id}", s.mutateAgentConfig)
	mux.HandleFunc("POST "+s.prefix+"/api/v1/rooms", s.mutateRoomConfig)
	mux.HandleFunc("PATCH "+s.prefix+"/api/v1/rooms/{id}", s.mutateRoomConfig)
	mux.HandleFunc("DELETE "+s.prefix+"/api/v1/rooms/{id}", s.mutateRoomConfig)
	mux.HandleFunc("PATCH "+s.prefix+"/api/v1/settings", s.patchSharedSettings)
	mux.HandleFunc("POST "+s.prefix+"/api/v1/dispatches", s.createDispatch)
	mux.HandleFunc("GET "+s.prefix+"/api/v1/dispatches", s.listDispatches)
	mux.HandleFunc("GET "+s.prefix+"/api/v1/dispatches/{id}", s.getDispatch)
	mux.HandleFunc("POST "+s.prefix+"/api/v1/dispatches/{id}/result", s.completeDispatch)
	mux.HandleFunc("POST "+s.prefix+"/api/v1/dispatches/claim", s.claimDispatch)
	mux.HandleFunc("POST "+s.prefix+"/api/v1/realtime/ticket", s.socketTicket)
	mux.HandleFunc("GET "+s.prefix+"/ws", s.socket)
	mux.HandleFunc("GET "+s.prefix+"/ws/device", s.socket)
	if s.management != nil {
		s.management.Register(mux)
		mux.Handle(s.prefix+"/admin/", adminweb.Handler(s.prefix))
	}
	return withAccessLog(withCORS(mux))
}

// health 返回进程存活。
//
// 参数：标准 HTTP 参数。
// 返回值：无。
// 注意事项：不访问 MySQL 和 Redis，供负载均衡做存活探针。
func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "service": "agents-team-relay"})
}

// ready 检查 MySQL 和 Redis。
//
// 参数：标准 HTTP 参数。
// 返回值：无。
// 注意事项：任一依赖失败返回 503，部署脚本据此判断能否接流量。
func (s *Server) ready(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if err := s.store.Ping(ctx); err != nil {
		logx.Warnf("就绪检查失败 dependency=mysql")
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable", "dependency": "mysql"})
		return
	}
	if s.hub == nil || s.hub.Ping(ctx) != nil {
		logx.Warnf("就绪检查失败 dependency=redis")
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable", "dependency": "redis"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready", "mysql": "ok", "redis": "ok"})
}

// loginGoogle 用 Google 访问令牌登记设备。
//
// 参数：请求体包含 accessToken 和 device。
// 返回值：无。
// 注意事项：访问令牌不写日志，设备令牌只在响应里出现一次。
func (s *Server) loginGoogle(w http.ResponseWriter, r *http.Request) {
	if !s.googleConfigured() {
		writeError(w, 503, "GOOGLE_NOT_CONFIGURED", "中转站尚未配置 Google Web OAuth")
		return
	}
	writeError(w, http.StatusGone, "USE_BROWSER_GOOGLE_LOGIN", "请使用浏览器 Google 登录，不再接受客户端访问令牌登录")
}

// loginEmail 用邮箱登记设备。已有账号时必须带邀请码。
//
// 参数：请求体包含 email、name、inviteCode 和 device。
// 返回值：无。
// 注意事项：邀请码使用后立即失效。
func (s *Server) loginEmail(w http.ResponseWriter, r *http.Request) {
	if !s.allowLogin(w, r, "email") {
		return
	}
	var req struct {
		Email    string      `json:"email"`
		Name     string      `json:"name"`
		Password string      `json:"password"`
		Action   string      `json:"action"`
		Device   deviceInput `json:"device"`
	}
	if !decodeBody(w, r, 16*1024, &req) {
		return
	}
	session, err := s.service.LoginEmail(r.Context(), req.Email, req.Name, req.Password, req.Action, req.Device.toService())
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, sessionJSON(session))
}

// listDevices 返回当前账号的设备。
//
// 参数：需要设备令牌。
// 返回值：无。
// 注意事项：在线状态来自最近 60 秒的心跳，不是永久会话。
func (s *Server) listDevices(w http.ResponseWriter, r *http.Request) {
	_, account, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	devices, err := s.service.ListDevices(r.Context(), account.ID)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	ids := make([]string, 0, len(devices))
	for _, device := range devices {
		ids = append(ids, device.ID)
	}
	online := map[string]bool{}
	if s.hub != nil {
		online = s.hub.Online(r.Context(), ids)
	}
	views := make([]map[string]any, 0, len(devices))
	for _, device := range devices {
		views = append(views, deviceJSON(device, online[device.ID]))
	}
	writeJSON(w, http.StatusOK, map[string]any{"devices": views})
}

// createInvite 生成一次性邀请码。
//
// 参数：需要设备令牌。
// 返回值：无。
// 注意事项：响应中的明文邀请码不会再次查询到。
func (s *Server) createInvite(w http.ResponseWriter, r *http.Request) {
	device, _, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	code, expires, err := s.service.CreateInvite(r.Context(), device)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"code": code, "expiresAt": expires})
}

// setPrimary 把指定设备设为主设备。
//
// 参数：路径 id 为目标设备。
// 返回值：无。
// 注意事项：只有主设备会使用本机 Cursor、Codex 或 Claude 执行回复。
func (s *Server) setPrimary(w http.ResponseWriter, r *http.Request) {
	device, account, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	if !storage.CanExecute(device.Platform) {
		writeError(w, 403, "DESKTOP_REQUIRED", "请在电脑上切换执行主设备")
		return
	}
	target, err := s.store.GetDevice(r.Context(), account.ID, r.PathValue("id"))
	if errors.Is(err, storage.ErrNotFound) {
		writeError(w, 404, "NOT_FOUND", "设备不存在")
		return
	}
	if err != nil {
		writeServiceError(w, err)
		return
	}
	if s.hub == nil || !s.hub.Online(r.Context(), []string{target.ID})[target.ID] {
		logx.Warnf("拒绝切换离线主电脑 account=" + account.ID + " device=" + target.ID)
		writeError(w, 409, "DEVICE_OFFLINE", "离线不可设置")
		return
	}
	if err := s.service.SetPrimary(r.Context(), device, r.PathValue("id")); err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// revokeDevice 撤销一台设备。
//
// 参数：路径 id 为目标设备。
// 返回值：无。
// 注意事项：撤销后该设备令牌立即失效。
func (s *Server) revokeDevice(w http.ResponseWriter, r *http.Request) {
	device, _, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	if err := s.service.RevokeDevice(r.Context(), device, r.PathValue("id")); err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// getState 拉取账号聊天快照。
//
// 参数：需要设备令牌。
// 返回值：无。
// 注意事项：返回整份快照，客户端用 revision 做后续乐观锁。
func (s *Server) getState(w http.ResponseWriter, r *http.Request) {
	_, account, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	state, err := s.service.LoadState(r.Context(), account.ID)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"revision": state.Revision, "state": json.RawMessage(state.Body)})
}

// putState 保存整份聊天快照。
//
// 参数：请求体包含 baseRevision 和 state。
// 返回值：无。
// 注意事项：版本冲突时返回服务器当前快照，调用方需要合并后重试。
func (s *Server) putState(w http.ResponseWriter, r *http.Request) {
	device, _, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	var req struct {
		BaseRevision int64           `json:"baseRevision"`
		State        json.RawMessage `json:"state"`
	}
	if !decodeBody(w, r, int64(s.service.StateLimit()+1024), &req) {
		return
	}
	saved, err := s.service.SaveState(r.Context(), device, req.BaseRevision, req.State)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"revision": saved.Revision, "state": json.RawMessage(saved.Body)})
}

// patchAgentConfig 将同账号任意设备提交的修改应用到已有 Agent。
//
// 参数：路径 id 是 Agent 编号，请求体包含 baseRevision 与白名单 config 字段。
// 返回值：完整快照及新版本，版本冲突沿用整份快照接口的 409 响应。
// 注意事项：仅配置可修改；聊天历史、模型目录、执行状态及凭据不接受远程覆盖。
func (s *Server) patchAgentConfig(w http.ResponseWriter, r *http.Request) {
	device, _, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	var req struct {
		BaseRevision int64           `json:"baseRevision"`
		Config       json.RawMessage `json:"config"`
	}
	if !decodeBody(w, r, 66560, &req) {
		return
	}
	saved, err := s.service.UpdateAgentConfig(r.Context(), device, r.PathValue("id"), req.BaseRevision, req.Config)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"revision": saved.Revision, "state": json.RawMessage(saved.Body)})
}

// createDispatch 把一条用户消息下发给主设备执行。
//
// 参数：请求体为执行任务。
// 返回值：无。
// 注意事项：消息会先进入账号聊天记录，再等待主设备回写回复。
func (s *Server) createDispatch(w http.ResponseWriter, r *http.Request) {
	device, _, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	var req dispatchRequest
	if !decodeBody(w, r, 8*1024*1024, &req) {
		return
	}
	record, revision, err := s.service.CreateDispatch(r.Context(), device, req.toService())
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"dispatch": record, "revision": revision})
}

// listDispatches 让主设备领取未完成任务。
//
// 参数：需要主设备令牌。
// 返回值：无。
// 注意事项：非主设备调用会得到 403。
func (s *Server) listDispatches(w http.ResponseWriter, r *http.Request) {
	device, _, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	records, err := s.service.ListPending(r.Context(), device)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"dispatches": records})
}

// getDispatch 查询一条任务的状态。
//
// 参数：路径 id 为任务号。
// 返回值：无。
// 注意事项：只能查询自己账号的任务。
func (s *Server) getDispatch(w http.ResponseWriter, r *http.Request) {
	_, account, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	record, err := s.service.GetDispatch(r.Context(), account.ID, r.PathValue("id"))
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"dispatch": record})
}

// completeDispatch 由主设备回写执行结果。
//
// 参数：路径 id 为任务号；请求体为状态和回复。
// 返回值：无。
// 注意事项：done 会把回复追加到对应 Agent 的聊天记录。
func (s *Server) completeDispatch(w http.ResponseWriter, r *http.Request) {
	device, _, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	var req resultRequest
	if !decodeBody(w, r, 8*1024*1024, &req) {
		return
	}
	record, revision, err := s.service.CompleteDispatch(r.Context(), device, r.PathValue("id"), req.toService())
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"dispatch": record, "revision": revision})
}

// authenticate 校验设备令牌并刷新在线状态。
//
// 参数：w 用于写错误响应；r 为当前请求。
// 返回值：校验失败时 ok 为 false，响应已写出。
// 注意事项：令牌可放在 Authorization 或 access_token 查询参数，后者仅给 WebSocket 使用。
func (s *Server) authenticate(w http.ResponseWriter, r *http.Request) (storage.Device, storage.Account, bool) {
	device, account, err := s.service.Authenticate(r.Context(), bearerToken(r))
	if err != nil {
		writeServiceError(w, err)
		return storage.Device{}, storage.Account{}, false
	}
	if s.hub != nil {
		s.hub.MarkOnline(r.Context(), device.ID)
	}
	return device, account, true
}

// deviceInput 是登录请求里的设备描述。
type deviceInput struct {
	ClientDeviceID string `json:"clientDeviceId"`
	Name           string `json:"name"`
	Platform       string `json:"platform"`
}

// toService 转换成业务层设备输入。
//
// 参数：无。
// 返回值：业务层结构。
// 注意事项：不携带令牌。
func (d deviceInput) toService() service.DeviceInput {
	return service.DeviceInput{ClientDeviceID: d.ClientDeviceID, Name: d.Name, Platform: d.Platform}
}

// dispatchRequest 是创建执行任务的请求体。
type dispatchRequest struct {
	ClientRequestID string          `json:"clientRequestId"`
	Mode            string          `json:"mode"`
	RoomID          string          `json:"roomId"`
	AgentID         string          `json:"agentId"`
	UserMessage     json.RawMessage `json:"userMessage"`
	Attachments     json.RawMessage `json:"attachments"`
	Context         json.RawMessage `json:"context"`
	UserText        string          `json:"userText"`
	Responders      []messageInput  `json:"responders"`
}

// toService 转换成业务层任务输入。
//
// 参数：无。
// 返回值：业务层结构。
// 注意事项：消息正文保持原始 JSON。
func (d dispatchRequest) toService() service.DispatchInput {
	input := service.DispatchInput{ClientRequestID: d.ClientRequestID, Mode: d.Mode, RoomID: d.RoomID, UserText: d.UserText, AgentID: d.AgentID, UserMessage: d.UserMessage, Attachments: d.Attachments, Context: d.Context}
	for _, item := range d.Responders {
		input.Responders = append(input.Responders, item.toService())
	}
	return input
}

// resultRequest 是主设备回写结果的请求体。
type resultRequest struct {
	ClaimToken   string         `json:"claimToken"`
	Status       string         `json:"status"`
	ErrorMessage string         `json:"errorMessage"`
	Replies      []messageInput `json:"replies"`
}

// toService 转换成业务层结果。
//
// 参数：无。
// 返回值：业务层结构。
// 注意事项：回复消息保持原始 JSON。
func (r resultRequest) toService() service.ResultInput {
	input := service.ResultInput{Status: r.Status, ErrorMessage: r.ErrorMessage, ClaimToken: r.ClaimToken}
	for _, item := range r.Replies {
		input.Replies = append(input.Replies, item.toService())
	}
	return input
}

// messageInput 是某个 Agent 的一条消息。
type messageInput struct {
	AgentID string          `json:"agentId"`
	Message json.RawMessage `json:"message"`
}

// toService 转换成业务层消息。
//
// 参数：无。
// 返回值：业务层结构。
// 注意事项：不在接口层解释消息字段。
func (m messageInput) toService() service.MessageInput {
	return service.MessageInput{AgentID: m.AgentID, Message: m.Message}
}

// sessionJSON 组装登录响应。
//
// 参数：session 含一次性设备令牌。
// 返回值：可编码的对象。
// 注意事项：不要附加令牌摘要；员工身份只使用业务层的服务器授权结果。
func sessionJSON(session service.Session) map[string]any {
	return map[string]any{
		"account":     accountJSON(session.Account),
		"device":      deviceJSON(session.Device, true),
		"deviceToken": session.DeviceToken,
		"revision":    session.Revision,
	}
}

// accountJSON 组装经过服务器认证的账号视图。
//
// 参数：account 必须由业务层完成当前员工身份授权计算。
// 返回值：包含登录资料、员工工号与当前有效角色的对象。
// 注意事项：不会序列化存储字段或服务器私密授权策略。
func accountJSON(account storage.Account) map[string]any {
	return map[string]any{
		"id": account.ID, "email": account.Email, "name": account.Name,
		"picture": account.Picture, "provider": account.Provider,
		"employeeId": account.EmployeeID, "role": account.Role,
	}
}

// currentSession 查询当前设备的服务器有效身份。
//
// 参数：请求必须包含有效的 Bearer 设备令牌。
// 返回值：通过 HTTP 输出账号与设备视图；身份无效时返回 401。
// 注意事项：每次重新计算角色，因此部署撤销管理员映射后，旧会话不会保留权限。
func (s *Server) currentSession(w http.ResponseWriter, r *http.Request) {
	device, account, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"account": accountJSON(account), "device": deviceJSON(device, true)})
}

// deviceJSON 组装设备响应。
//
// 参数：device 为存储对象；online 表示最近心跳仍有效。
// 返回值：不含令牌摘要的对象。
// 注意事项：调用方不要把 storage.Device 直接编码。
func deviceJSON(device storage.Device, online bool) map[string]any {
	view := map[string]any{
		"id":             device.ID,
		"clientDeviceId": device.ClientDeviceID,
		"name":           device.Name,
		"platform":       device.Platform,
		"isPrimary":      device.IsPrimary,
		"online":         online,
		"createdAt":      device.CreatedAt,
	}
	if device.LastSeenAt != nil {
		view["lastSeenAt"] = device.LastSeenAt
	}
	return view
}

// bearerToken 从请求头或查询参数读取设备令牌。
//
// 参数：r 为当前请求。
// 返回值：明文令牌，没有时为空字符串。
// 注意事项：查询参数只用于无法设置请求头的 WebSocket。
func bearerToken(r *http.Request) string {
	header := r.Header.Get("Authorization")
	if len(header) > 7 && strings.EqualFold(header[:7], "bearer ") {
		return strings.TrimSpace(header[7:])
	}
	return ""
}

// decodeBody 解析 JSON 请求体。
//
// 参数：limit 为最大字节数；dest 为指针。
// 返回值：解析失败时已写响应并返回 false。
// 注意事项：拒绝未知字段，避免客户端误把密钥放进未定义位置后被静默丢弃。
func decodeBody(w http.ResponseWriter, r *http.Request, limit int64, dest any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dest); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID", "请求格式不正确")
		return false
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		writeError(w, http.StatusBadRequest, "INVALID", "请求只能包含一个 JSON 对象")
		return false
	}
	return true
}

// writeServiceError 把业务错误写成 JSON。
//
// 参数：err 为服务层或存储层错误。
// 返回值：无。
// 注意事项：未知错误统一返回 500，不把数据库原文暴露给客户端。
func writeServiceError(w http.ResponseWriter, err error) {
	var business *service.Error
	if errors.As(err, &business) {
		payload := map[string]any{"error": map[string]string{"code": business.Code, "message": business.Message}}
		if business.Revision > 0 || len(business.State) > 0 {
			payload["revision"] = business.Revision
			if len(business.State) > 0 {
				payload["state"] = json.RawMessage(business.State)
			}
		}
		writeJSON(w, business.Status, payload)
		return
	}
	logx.Errorf("接口处理失败 err=%v", err)
	writeError(w, http.StatusInternalServerError, "INTERNAL", "服务暂时不可用")
}

// writeError 写标准错误响应。
//
// 参数：status 为 HTTP 状态；code 和 message 为错误内容。
// 返回值：无。
// 注意事项：message 必须是可展示的中文说明。
func writeError(w http.ResponseWriter, status int, code string, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}

// writeJSON 写 JSON 响应。
//
// 参数：status 为 HTTP 状态；payload 为响应体。
// 返回值：无。
// 注意事项：编码失败时只能记录日志，此时状态码可能已经写出。
func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		logx.Warnf("写出响应失败 status=%d", status)
	}
}

// statusWriter 记录最终 HTTP 状态码，并保留 WebSocket 劫持能力。
type statusWriter struct {
	http.ResponseWriter
	status int
}

// WriteHeader 保存状态码后交给底层响应。
//
// 参数：status 为 HTTP 状态码。
// 返回值：无。
// 注意事项：只记录第一次状态码。
func (w *statusWriter) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
	w.ResponseWriter.WriteHeader(status)
}

// Write 在未显式写状态时按 200 记录。
//
// 参数：body 为响应字节。
// 返回值：写入字节数和错误。
// 注意事项：WebSocket 升级成功后不应再写普通响应体。
func (w *statusWriter) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(body)
}

// Hijack 把连接交给 WebSocket。
//
// 参数：无。
// 返回值：底层连接。底层不支持时返回错误。
// 注意事项：日志包装不能挡住升级。
func (w *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("连接不支持升级")
	}
	return hijacker.Hijack()
}

// withCORS 允许客户端携带令牌访问接口。
//
// 参数：next 为后续处理器。
// 返回值：包装后的处理器。
// 注意事项：身份靠 Bearer 令牌，不使用 Cookie。
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// withAccessLog 记录接口耗时和状态。
//
// 参数：next 为后续处理器。
// 返回值：包装后的处理器。
// 注意事项：发生 panic 时返回 500，不输出堆栈中的请求体。
func withAccessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		recorder := &statusWriter{ResponseWriter: w}
		defer func() {
			if recovered := recover(); recovered != nil {
				logx.Errorf("接口异常 method=%s path=%s", r.Method, r.URL.Path)
				if recorder.status == 0 {
					writeError(recorder, http.StatusInternalServerError, "INTERNAL", "服务暂时不可用")
				}
			}
			logx.Infof("http method=%s path=%s status=%d duration_ms=%d", r.Method, r.URL.Path, recorder.status, time.Since(started).Milliseconds())
		}()
		next.ServeHTTP(recorder, r)
	})
}

func (s *Server) claimDispatch(w http.ResponseWriter, r *http.Request) {
	device, _, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	record, err := s.service.ClaimDispatch(r.Context(), device)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"dispatch": record})
}

// logout 注销当前请求认证时对应的设备会话。
//
// 参数：标准HTTP参数；Authorization 提供设备令牌。
// 返回值：通过HTTP返回注销状态，非法会话返回401。
// 注意事项：服务层在事务中再次校验令牌版本，避免延迟退出请求撤销重新登录的新会话。
func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	device, _, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	if err := s.service.Logout(r.Context(), device); err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, 200, map[string]string{"status": "ok"})
}

// WithManagement 将独立管理后台挂到现有服务。参数：admin 为已初始化管理服务；返回值：当前服务器；注意事项：只在启动阶段调用，不改变客户端设备认证流程。
func (s *Server) WithManagement(admin *management.Server) *Server { s.management = admin; return s }
