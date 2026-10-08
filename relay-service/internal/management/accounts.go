package management

import (
	"errors"
	"net/http"
	"net/mail"
	"strings"

	"agents-team-relay/internal/logx"
	"agents-team-relay/internal/realtime"
	"agents-team-relay/internal/storage"
	"golang.org/x/crypto/bcrypt"
)

// isAdministrator 判断是否拥有全局概览与发版权限。参数：role来自已验证服务器会话；返回值：管理员或超级管理员为true；注意事项：账号变更必须另外要求superadmin。
func isAdministrator(role string) bool { return role == "admin" || role == "superadmin" }

// privilegedIdentity 根据受信配置产生后台特权身份。参数：email为待认证邮箱；返回值：身份、独立密码摘要及是否配置；注意事项：显示名称不参与授权，注册姓名、客户端role不能赋权。
func (s *Server) privilegedIdentity(email string) (User, string, bool) {
	if s.cfg.SuperadminEmail != "" && strings.EqualFold(s.cfg.SuperadminEmail, email) {
		return User{ID: "superadmin:" + digest(email)[:24], Email: email, Name: "超级管理员", Role: "superadmin"}, s.cfg.SuperadminPasswordHash, true
	}
	for _, configured := range s.cfg.AdminEmails {
		if strings.EqualFold(strings.TrimSpace(configured), email) {
			return User{ID: "admin:" + digest(email)[:24], Email: email, Name: "管理员", Role: "admin"}, s.cfg.AdminPasswordHash, true
		}
	}
	return User{}, "", false
}

// protectedEmail 标识不能经页面修改的预置身份。参数：email为数据库或规范化邮箱；返回值：命中受保护配置时为true；注意事项：包括独立后台管理员与已验证Google超级管理员映射。
func (s *Server) protectedEmail(email string) bool {
	return s.adminEmail(email) || (s.cfg.ProtectedGoogleEmail != "" && strings.EqualFold(email, s.cfg.ProtectedGoogleEmail))
}

// superadmin 验证账号管理的最高权限。参数：标准HTTP请求；返回值：认证会话与授权结果；注意事项：先进行会话和CSRF校验，普通管理员也返回明确403。
func (s *Server) superadmin(w http.ResponseWriter, r *http.Request) (Session, bool) {
	session, ok := s.authenticate(w, r, false)
	if !ok {
		return Session{}, false
	}
	if session.User.Role != "superadmin" {
		logx.Warnf("拒绝非超级管理员账号变更 actor=" + session.User.ID)
		apiError(w, 403, "SUPERADMIN_REQUIRED", "仅超级管理员可管理账号")
		return Session{}, false
	}
	return session, true
}

// mutableAccount 读取目标并保护预置特权身份。参数：路径id为目标账号；返回值：账号与是否可修改；注意事项：权限必须由调用方先完成，不暴露任意账号给普通用户。
func (s *Server) mutableAccount(w http.ResponseWriter, r *http.Request) (storage.Account, bool) {
	account, err := s.store.GetManagedAccount(r.Context(), r.PathValue("id"))
	if err != nil {
		accountError(w, err)
		return storage.Account{}, false
	}
	if s.protectedEmail(account.Email) {
		apiError(w, 409, "ACCOUNT_PROTECTED", "预置管理员身份只能通过服务器安全配置维护")
		return storage.Account{}, false
	}
	return account, true
}

// accountError 将账号事务错误映射为公开错误。参数：err为存储错误；返回值：无；注意事项：不在HTTP响应暴露数据库或密码摘要。
func accountError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, storage.ErrNotFound):
		apiError(w, 404, "NOT_FOUND", "账号不存在")
	case errors.Is(err, storage.ErrAccountExists):
		apiError(w, 409, "EMAIL_EXISTS", "邮箱已被其他账号使用")
	case errors.Is(err, storage.ErrEmailImmutable):
		apiError(w, 409, "GOOGLE_EMAIL_IMMUTABLE", "Google账号邮箱由身份提供方管理，不能在后台修改")
	case errors.Is(err, storage.ErrPasswordProvider):
		apiError(w, 409, "PASSWORD_NOT_SUPPORTED", "Google账号请在身份提供方管理密码")
	case errors.Is(err, storage.ErrConfirmationMismatch):
		apiError(w, 409, "CONFIRMATION_MISMATCH", "确认邮箱不匹配，请重新核对账号")
	default:
		internalError(w, err)
	}
}

// updateAccount 修改用户姓名或邮箱。参数：可选name/email字段，至少提供一个；返回值：账号和是否撤销会话；注意事项：禁止更改登录提供方、角色和员工身份，邮箱变更撤销全部会话。
func (s *Server) updateAccount(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.superadmin(w, r)
	if !ok {
		return
	}
	account, ok := s.mutableAccount(w, r)
	if !ok {
		return
	}
	var input struct {
		Name  *string `json:"name"`
		Email *string `json:"email"`
	}
	if !decode(w, r, &input) {
		return
	}
	if input.Name == nil && input.Email == nil {
		apiError(w, 400, "INVALID", "至少提供姓名或邮箱")
		return
	}
	if input.Name != nil {
		value := strings.TrimSpace(*input.Name)
		if value == "" || len([]rune(value)) > 128 {
			apiError(w, 400, "INVALID", "姓名需为1到128个字符")
			return
		}
		input.Name = &value
	}
	if input.Email != nil {
		value := strings.ToLower(strings.TrimSpace(*input.Email))
		address, err := mail.ParseAddress(value)
		if err != nil || address.Address != value || len(value) > 254 {
			apiError(w, 400, "INVALID", "邮箱格式不正确")
			return
		}
		if s.protectedEmail(value) {
			apiError(w, 409, "ACCOUNT_PROTECTED", "不能将普通账号改为预置管理员邮箱")
			return
		}
		input.Email = &value
	}
	updated, revoked, err := s.store.UpdateManagedAccount(r.Context(), account.ID, storage.AccountPatch{Name: input.Name, Email: input.Email})
	if err != nil {
		accountError(w, err)
		return
	}
	if revoked {
		s.notifyRevoked(r, account.ID)
	}
	logx.Infof("超级管理员修改账号 actor=" + actor.User.ID + " account=" + account.ID)
	jsonResponse(w, 200, map[string]any{"account": map[string]any{"id": updated.ID, "email": updated.Email, "name": updated.Name, "provider": updated.Provider, "createdAt": updated.CreatedAt}, "sessionsRevoked": revoked})
}

// resetPassword 重置邮箱账号口令并撤销所有旧会话。参数：password为8至72 UTF8字节的新口令；返回值：完成状态；注意事项：只存bcrypt，不记录或回显密码，客户端必须重新登录。
func (s *Server) resetPassword(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.superadmin(w, r)
	if !ok {
		return
	}
	account, ok := s.mutableAccount(w, r)
	if !ok {
		return
	}
	var input struct {
		Password string `json:"password"`
	}
	if !decode(w, r, &input) {
		return
	}
	if len(input.Password) < 8 || len(input.Password) > 72 {
		apiError(w, 400, "INVALID_PASSWORD", "密码需为8到72字节")
		return
	}
	if account.Provider != "email" {
		accountError(w, storage.ErrPasswordProvider)
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(input.Password), bcrypt.DefaultCost)
	if err != nil {
		internalError(w, err)
		return
	}
	if err = s.store.ResetManagedPassword(r.Context(), account.ID, string(hash)); err != nil {
		accountError(w, err)
		return
	}
	s.notifyRevoked(r, account.ID)
	logx.Infof("超级管理员重置账号密码并撤销会话 actor=" + actor.User.ID + " account=" + account.ID)
	jsonResponse(w, 200, map[string]any{"status": "ok", "sessionsRevoked": true})
}

// deleteAccount 在显式确认邮箱后删除完整账号数据。参数：confirmEmail必须与事务内账号邮箱一致；返回值：删除状态和目标ID；注意事项：该操作不可恢复，不会影响其他用户及公共安装包。
func (s *Server) deleteAccount(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.superadmin(w, r)
	if !ok {
		return
	}
	account, ok := s.mutableAccount(w, r)
	if !ok {
		return
	}
	var input struct {
		ConfirmEmail string `json:"confirmEmail"`
	}
	if !decode(w, r, &input) {
		return
	}
	confirm := strings.ToLower(strings.TrimSpace(input.ConfirmEmail))
	if confirm == "" {
		apiError(w, 400, "CONFIRMATION_REQUIRED", "删除账号前必须输入完整邮箱确认")
		return
	}
	if err := s.store.DeleteManagedAccount(r.Context(), account.ID, confirm); err != nil {
		accountError(w, err)
		return
	}
	s.notifyRevoked(r, account.ID)
	logx.Infof("超级管理员删除账号及关联私有数据 actor=" + actor.User.ID + " account=" + account.ID)
	jsonResponse(w, 200, map[string]any{"status": "ok", "deletedAccountId": account.ID})
}

// notifyRevoked 唤醒所有节点的旧设备连接进行数据库会话重验。参数：accountID为已提交变更账号；返回值：无；注意事项：Redis广播失败不能撤销已提交事务，WebSocket后续收发和15秒心跳仍会检查数据库。
func (s *Server) notifyRevoked(r *http.Request, accountID string) {
	if err := s.hub.Publish(r.Context(), realtime.Event{AccountID: accountID, Type: "sessions.revoked"}); err != nil {
		logx.Warnf("账号会话撤销广播延迟 account=" + accountID)
	}
}
