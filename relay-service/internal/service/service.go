// Package service 实现账号、主设备和聊天下发规则。
package service

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"agents-team-relay/internal/auth"
	"agents-team-relay/internal/identity"
	"agents-team-relay/internal/logx"
	"agents-team-relay/internal/realtime"
	"agents-team-relay/internal/storage"

	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

var clientDevicePattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{4,128}$`)
var looseIDPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

var platforms = map[string]struct{}{
	"mac": {}, "android": {}, "web": {}, "windows": {}, "linux": {},
}

// Verifier 校验 Google 访问令牌。
type Verifier interface {
	Verify(ctx context.Context, accessToken string) (identity.Profile, error)
}

// Error 是可直接返回给客户端的业务错误。
type Error struct {
	Status   int
	Code     string
	Message  string
	Revision int64
	State    json.RawMessage
}

// Error 返回给日志和错误链的说明。
//
// 参数：无。
// 返回值：面向调用方的中文说明。
// 注意事项：不要把令牌放进 Message。
func (e *Error) Error() string { return e.Message }

// DeviceInput 是客户端登记自己时提交的信息。
type DeviceInput struct {
	ClientDeviceID string `json:"clientDeviceId"`
	Name           string `json:"name"`
	Platform       string `json:"platform"`
}

// Session 是一次登录签发的设备会话。
type Session struct {
	Account     storage.Account
	Device      storage.Device
	DeviceToken string
	Revision    int64
}

// DispatchInput 是非主设备发起、由主设备执行的一轮聊天。
type DispatchInput struct {
	ClientRequestID string
	Mode            string
	RoomID          string
	UserText        string
	Responders      []MessageInput  `json:"responders"`
	AgentID         string          `json:"agentId,omitempty"`
	UserMessage     json.RawMessage `json:"userMessage,omitempty"`
	Attachments     json.RawMessage `json:"attachments,omitempty"`
	Context         json.RawMessage `json:"context,omitempty"`
}

// MessageInput 是要写入某个 Agent 对话的一条消息。
type MessageInput struct {
	AgentID string          `json:"agentId"`
	Message json.RawMessage `json:"message,omitempty"`
}

// ResultInput 是主设备执行完成后的回写。
type ResultInput struct {
	ClaimToken   string
	Status       string
	ErrorMessage string
	Replies      []MessageInput
}

// DispatchRecord 是接口和广播使用的任务视图。
type DispatchRecord struct {
	ID              string          `json:"id"`
	AccountID       string          `json:"accountId"`
	SourceDeviceID  string          `json:"sourceDeviceId"`
	ClientRequestID string          `json:"clientRequestId"`
	Mode            string          `json:"mode"`
	RoomID          string          `json:"roomId"`
	UserText        string          `json:"userText"`
	Payload         json.RawMessage `json:"payload"`
	Status          string          `json:"status"`
	Result          json.RawMessage `json:"result,omitempty"`
	ErrorMessage    string          `json:"errorMessage,omitempty"`
	CreatedAt       time.Time       `json:"createdAt"`
	UpdatedAt       time.Time       `json:"updatedAt"`
	AgentID         string          `json:"agentId,omitempty"`
	UserMessage     json.RawMessage `json:"userMessage,omitempty"`
	Attachments     json.RawMessage `json:"attachments,omitempty"`
	Context         json.RawMessage `json:"context,omitempty"`
	Responders      []MessageInput  `json:"responders"`
	ClaimToken      string          `json:"claimToken,omitempty"`
	LeaseExpiresAt  *time.Time      `json:"leaseExpiresAt,omitempty"`
}

// Service 组合存储、身份校验和实时广播。
//
// 参数：store、verifier、publisher 提供依赖；accessPolicy 是启动时注入的员工角色策略。
// 返回值：由 New 构造可并发调用的服务。
// 注意事项：启动后不得修改身份策略；聊天操作仍始终按当前账号隔离。
type Service struct {
	store        storage.Store
	verifier     Verifier
	publisher    realtime.Publisher
	tokenKey     []byte
	stateLimit   int
	accessPolicy identity.AccessPolicy
}

// New 创建业务服务。
//
// 参数：store 为持久化；verifier 校验 Google；publisher 可为 nil；tokenKey 为 HMAC 密钥；stateLimit 为快照字节上限。
// 返回值：可并发调用的服务。
// 注意事项：publisher 为空时仍会保存数据，只是不推送。
func New(store storage.Store, verifier Verifier, publisher realtime.Publisher, tokenKey []byte, stateLimit int) *Service {
	if stateLimit <= 0 {
		stateLimit = 1_500_000
	}
	return &Service{store: store, verifier: verifier, publisher: publisher, tokenKey: tokenKey, stateLimit: stateLimit}
}

// LoginGoogle 用 Google 访问令牌登录或登记设备。
//
// 参数：accessToken 为客户端 OAuth 得到的令牌；device 描述本机。
// 返回值：账号、设备和新的设备令牌。
// 注意事项：同一 Google 邮箱的多台设备共享聊天记录。第一台设备成为主设备。
func (s *Service) LoginGoogle(ctx context.Context, accessToken string, device DeviceInput) (Session, error) {
	profile, err := s.verifier.Verify(ctx, accessToken)
	if errors.Is(err, identity.ErrUnauthorized) {
		return Session{}, fail(401, "UNAUTHORIZED", "Google 登录无效")
	}
	if err != nil {
		logx.Errorf("Google 身份校验失败 err=%v", err)
		return Session{}, fail(503, "AUTH_UNAVAILABLE", "暂时无法校验 Google 登录")
	}
	email := strings.ToLower(strings.TrimSpace(profile.Email))
	if !profile.Verified || !validEmail(email) {
		return Session{}, fail(401, "UNAUTHORIZED", "Google 登录无效")
	}
	account, err := s.store.UpsertAccount(ctx, storage.Account{
		ID:       uuid.NewString(),
		Email:    email,
		Name:     fallbackName(profile.Name, email),
		Picture:  trimRunes(profile.Picture, 512),
		Provider: "google",
	})
	if errors.Is(err, storage.ErrProviderConflict) {
		return Session{}, fail(409, "PROVIDER_CONFLICT", "此邮箱已使用其他登录方式，请使用原方式登录")
	}
	if err != nil {
		return Session{}, err
	}
	return s.issueDevice(ctx, account, device, "", -1)
}

// LoginEmail 用密码注册或登录邮箱账号；旧版仅凭邮箱的请求不再授予身份。
func (s *Service) LoginEmail(ctx context.Context, email, name, password, action string, device DeviceInput) (Session, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	if !validEmail(email) {
		return Session{}, fail(400, "INVALID", "邮箱格式不正确")
	}
	if len(password) < 8 || len(password) > 72 {
		return Session{}, fail(400, "INVALID_PASSWORD", "密码需为 8 到 72 字节")
	}
	if _, err := normalizeDevice(device); err != nil {
		return Session{}, err
	}
	if action == "register" {
		hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
		if err != nil {
			return Session{}, err
		}
		account, err := s.store.RegisterEmail(ctx, storage.Account{ID: uuid.NewString(), Email: email, Name: fallbackName(name, email), Provider: "email"}, string(hash))
		if errors.Is(err, storage.ErrAccountExists) {
			return Session{}, fail(409, "ACCOUNT_EXISTS", "此邮箱已有账号，请使用密码或 Google 登录")
		}
		if err != nil {
			return Session{}, err
		}
		return s.issueDevice(ctx, account, device, string(hash), 0)
	}
	if action != "" && action != "login" {
		return Session{}, fail(400, "INVALID", "操作只能是 register 或 login")
	}
	account, err := s.store.FindAccountByEmail(ctx, email)
	if errors.Is(err, storage.ErrNotFound) {
		bcrypt.CompareHashAndPassword([]byte(dummyPasswordHash), []byte(password))
		return Session{}, fail(401, "UNAUTHORIZED", "邮箱或密码不正确")
	}
	if err != nil {
		return Session{}, err
	}
	if account.Provider != "email" {
		return Session{}, fail(401, "UNAUTHORIZED", "邮箱或密码不正确")
	}
	hash, credentialVersion, err := s.store.PasswordState(ctx, account.ID)
	if errors.Is(err, storage.ErrNotFound) {
		return Session{}, fail(401, "PASSWORD_NOT_SET", "此账号尚未设置密码，请使用 Google 登录或重新注册新的账号")
	}
	if err != nil {
		return Session{}, err
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
		return Session{}, fail(401, "UNAUTHORIZED", "邮箱或密码不正确")
	}
	return s.issueDevice(ctx, account, device, hash, credentialVersion)
}

// 固定合法摘要使不存在账号的错误路径仍执行 bcrypt，降低邮箱探测的时序差异。
const dummyPasswordHash = "$2a$10$7EqJtq98hPqEX7fNZaFWoO5jEWtF2hV0HGbQ9q1GyCKshizT8oL8K"

// Authenticate 校验设备令牌。
//
// 参数：rawToken 为客户端保存的明文令牌。
// 返回值：设备和所属账号。无效时返回 401。
// 注意事项：成功后刷新最近出现时间，失败不暴露账号是否存在。
func (s *Service) Authenticate(ctx context.Context, rawToken string) (storage.Device, storage.Account, error) {
	if strings.TrimSpace(rawToken) == "" {
		return storage.Device{}, storage.Account{}, fail(401, "UNAUTHORIZED", "缺少设备令牌")
	}
	device, account, err := s.store.DeviceByTokenHash(ctx, auth.Hash(s.tokenKey, rawToken))
	if errors.Is(err, storage.ErrNotFound) {
		return storage.Device{}, storage.Account{}, fail(401, "UNAUTHORIZED", "设备令牌无效")
	}
	if err != nil {
		return storage.Device{}, storage.Account{}, err
	}
	if touchErr := s.store.TouchDevice(ctx, device.ID, time.Now().UTC()); touchErr != nil {
		logx.Warnf("更新设备出现时间失败 device=%s", device.ID)
	}
	return device, s.accountIdentity(account), nil
}

// CreateInvite 生成 10 分钟内有效的一次性邀请码。
//
// 参数：device 为已登录设备。
// 返回值：明文邀请码和过期时间。
// 注意事项：明文只返回这一次。
func (s *Service) CreateInvite(ctx context.Context, device storage.Device) (string, time.Time, error) {
	code, hash, err := auth.NewInviteCode(s.tokenKey)
	if err != nil {
		return "", time.Time{}, err
	}
	now := time.Now().UTC()
	expires := now.Add(10 * time.Minute)
	err = s.store.InsertInvite(ctx, storage.Invite{
		CodeHash:        hash,
		AccountID:       device.AccountID,
		CreatedByDevice: device.ID,
		ExpiresAt:       expires,
		CreatedAt:       now,
	})
	if err != nil {
		return "", time.Time{}, err
	}
	logx.Infof("生成设备邀请码 account=%s device=%s", device.AccountID, device.ID)
	return code, expires, nil
}

// ListDevices 返回账号下未撤销的设备。
//
// 参数：accountID 为当前账号。
// 返回值：设备列表。
// 注意事项：在线状态由接口层另外查询。
func (s *Service) ListDevices(ctx context.Context, accountID string) ([]storage.Device, error) {
	return s.store.ListDevices(ctx, accountID)
}

// SetPrimary 指定唯一主设备。
//
// 参数：requester 为当前请求认证的设备快照；deviceID 为目标设备。
// 返回值：目标不存在时返回 404。
// 注意事项：任意已登录设备都可以切换主设备。只有主设备会执行 Cursor、Codex 等本机任务。
func (s *Service) SetPrimary(ctx context.Context, requester storage.Device, deviceID string) error {
	accountID := requester.AccountID
	target, err := s.store.GetDevice(ctx, accountID, deviceID)
	if errors.Is(err, storage.ErrNotFound) {
		return fail(404, "NOT_FOUND", "设备不存在")
	}
	if err != nil {
		return err
	}
	if !storage.CanExecute(target.Platform) {
		return fail(403, "DESKTOP_REQUIRED", "手机和浏览器不能成为执行主设备")
	}
	if err := s.store.SetPrimaryForSessionWithHook(ctx, requester, deviceID, func() error { return s.invalidateHostConfig(ctx, accountID) }); errors.Is(err, storage.ErrCredentialsChanged) {
		return fail(401, "UNAUTHORIZED", "设备令牌无效")
	} else if errors.Is(err, storage.ErrNotFound) {
		return fail(404, "NOT_FOUND", "设备不存在")
	} else if err != nil {
		return err
	}
	logx.Infof("------------- 切换主设备 account=" + accountID + " device=" + deviceID + " --------------")
	s.publish(ctx, realtime.Event{AccountID: accountID, Type: "devices.updated"})
	return nil
}

// RevokeDevice 让一台设备退出账号。
//
// 参数：requester 为当前请求认证的设备快照；deviceID 为目标设备。
// 返回值：设备不存在时返回 404。
// 注意事项：撤销主设备后不自动提升其他设备，须显式选择在线电脑，避免离线设备接管任务。
func (s *Service) RevokeDevice(ctx context.Context, requester storage.Device, deviceID string) error {
	accountID := requester.AccountID
	if err := s.store.RevokeDeviceForSession(ctx, requester, deviceID); errors.Is(err, storage.ErrCredentialsChanged) {
		return fail(401, "UNAUTHORIZED", "设备令牌无效")
	} else if errors.Is(err, storage.ErrNotFound) {
		return fail(404, "NOT_FOUND", "设备不存在")
	} else if err != nil {
		return err
	}
	logx.Infof("撤销设备 account=%s device=%s", accountID, deviceID)
	s.publish(ctx, realtime.Event{AccountID: accountID, Type: "devices.updated"})
	return nil
}

// Logout 仅注销请求认证时对应的设备会话。
//
// 参数：ctx 控制取消；device 必须是 Authenticate 返回的服务器认证结果。
// 返回值：存储故障时返回错误；旧退出请求或已退出会话按幂等成功处理。
// 注意事项：同一设备重新登录会轮换令牌，旧请求不得撤销新会话或广播设备变更。
func (s *Service) Logout(ctx context.Context, device storage.Device) error {
	if device.TokenHash == "" {
		return fail(401, "UNAUTHORIZED", "设备令牌无效")
	}
	revoked, err := s.store.RevokeSession(ctx, device)
	if err != nil {
		return err
	}
	if !revoked {
		logx.Infof("旧设备会话退出已忽略 account=" + device.AccountID + " device=" + device.ID)
		return nil
	}
	logx.Infof("设备会话已退出 account=" + device.AccountID + " device=" + device.ID)
	s.publish(ctx, realtime.Event{AccountID: device.AccountID, Type: "devices.updated"})
	return nil
}

// LoadState 读取账号聊天快照。
//
// 参数：accountID 为当前账号。
// 返回值：版本和 JSON 正文。
// 注意事项：正文是客户端 persist 的 agents 与 rooms，不包含模型密钥。
func (s *Service) LoadState(ctx context.Context, accountID string) (storage.State, error) {
	return s.store.LoadState(ctx, accountID)
}

// SaveState 用乐观锁保存整份聊天快照。
//
// 参数：device 为写入设备；baseRevision 为客户端看到的版本；body 为新快照。
// 返回值：新版本。版本不一致时返回 409，并带上服务器当前快照。
// 注意事项：settings.apiKeys 会被删除，不能通过中转站同步密钥。
func (s *Service) SaveState(ctx context.Context, device storage.Device, baseRevision int64, body json.RawMessage) (storage.State, error) {
	clean, err := sanitizeState(body, s.stateLimit)
	if err != nil {
		return storage.State{}, err
	}
	var saved storage.State
	var conflict *Error
	err = s.store.WithAccount(ctx, device.AccountID, func(tx storage.Tx) error {
		if err := requirePrimary(ctx, tx, device); err != nil {
			return err
		}
		current, err := tx.State(ctx)
		if err != nil {
			return err
		}
		if current.Revision != baseRevision || configRevision(clean) != configRevision(current.Body) || configRevision(current.Body) > 0 && !sharedConfigMatches(current.Body, clean) {
			conflict = stateConflict(current)
			return conflict
		}
		saved, err = tx.SaveState(ctx, device.ID, clean)
		return err
	})
	if conflict != nil {
		return storage.State{}, conflict
	}
	if err != nil {
		return storage.State{}, err
	}
	logx.Infof("保存聊天记录 account=%s device=%s revision=%d", device.AccountID, device.ID, saved.Revision)
	s.publish(ctx, realtime.Event{AccountID: device.AccountID, Type: "state.updated", Revision: saved.Revision})
	return saved, nil
}

// CreateDispatch 记录用户消息，并生成给主设备执行的任务。
//
// 参数：device 为发起设备；input 包含幂等键、文本和每个 Agent 的用户消息。
// 返回值：任务和写入后的聊天版本。
// 注意事项：重复的 clientRequestId 直接返回原任务，不会把消息再写一遍。
func (s *Service) CreateDispatch(ctx context.Context, device storage.Device, input DispatchInput) (DispatchRecord, int64, error) {
	if err := validateDispatch(input); err != nil {
		return DispatchRecord{}, 0, err
	}
	// 入队前统一用户消息，聊天快照与电脑领取的任务必须使用相同身份和请求编号。
	if len(input.UserMessage) > 0 {
		message, err := decodeObject(input.UserMessage)
		if err != nil {
			return DispatchRecord{}, 0, err
		}
		if stringValue(message["id"]) != input.ClientRequestID {
			return DispatchRecord{}, 0, fail(400, "INVALID", "用户消息 id 必须等于请求编号")
		}
		input.UserMessage, err = canonicalUserMessage(input.UserMessage, input.ClientRequestID)
		if err != nil {
			return DispatchRecord{}, 0, err
		}
	}
	input.Responders = append([]MessageInput(nil), input.Responders...)
	for index, responder := range input.Responders {
		if len(responder.Message) == 0 {
			continue
		}
		message, err := canonicalUserMessage(responder.Message, input.ClientRequestID)
		if err != nil {
			return DispatchRecord{}, 0, err
		}
		input.Responders[index].Message = message
		if len(input.UserMessage) == 0 {
			input.UserMessage = message
		}
	}

	payload, err := json.Marshal(input)
	if err != nil {
		return DispatchRecord{}, 0, err
	}
	now := time.Now().UTC()
	item := storage.Dispatch{
		ID:              uuid.NewString(),
		AccountID:       device.AccountID,
		SourceDeviceID:  device.ID,
		ClientRequestID: input.ClientRequestID,
		Mode:            input.Mode,
		RoomID:          input.RoomID,
		UserText:        input.UserText,
		Payload:         payload,
		Status:          "pending",
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	var saved storage.State
	var replay bool
	err = s.store.WithAccount(ctx, device.AccountID, func(tx storage.Tx) error {
		currentDevice, err := tx.Device(ctx, device.ID)
		if errors.Is(err, storage.ErrNotFound) {
			return fail(401, "UNAUTHORIZED", "设备令牌无效")
		}
		if err != nil {
			return err
		}
		if device.TokenHash == "" || currentDevice.TokenHash != device.TokenHash {
			return fail(401, "UNAUTHORIZED", "设备令牌无效")
		}
		existing, err := tx.FindDispatchByClientRequest(ctx, input.ClientRequestID)
		if err != nil {
			return err
		}
		if existing != nil {
			item = *existing
			replay = true
			return nil
		}
		current, err := tx.State(ctx)
		if err != nil {
			return err
		}
		next, err := appendDispatchMessages(current.Body, input.RoomID, input.AgentID, input.UserMessage, input.Responders, true, s.stateLimit)
		if err != nil {
			return err
		}
		saved, err = tx.SaveState(ctx, device.ID, next)
		if err != nil {
			return err
		}
		return tx.InsertDispatch(ctx, item)
	})
	if err != nil {
		return DispatchRecord{}, 0, err
	}
	if replay {
		state, loadErr := s.store.LoadState(ctx, device.AccountID)
		if loadErr != nil {
			return DispatchRecord{}, 0, loadErr
		}
		return toRecord(item), state.Revision, nil
	}
	logx.Infof("创建执行任务 account=%s dispatch=%s source=%s mode=%s", device.AccountID, item.ID, device.ID, item.Mode)
	record := toRecord(item)
	raw, _ := json.Marshal(record)
	s.publish(ctx, realtime.Event{AccountID: device.AccountID, Type: "state.updated", Revision: saved.Revision})
	s.publish(ctx, realtime.Event{AccountID: device.AccountID, Type: "dispatch.created", Revision: saved.Revision, Dispatch: raw})
	return record, saved.Revision, nil
}

// ListPending 返回主设备尚未完成的任务。
//
// 参数：device 必须是主设备。
// 返回值：pending 和 running 任务。非主设备返回 403。
// 注意事项：非主设备只同步结果，不能领取执行。
func (s *Service) ListPending(ctx context.Context, device storage.Device) ([]DispatchRecord, error) {
	current, err := s.currentDevice(ctx, device)
	if err != nil {
		return nil, err
	}
	_ = current
	items, err := s.store.ListPending(ctx, device.AccountID)
	if err != nil {
		return nil, err
	}
	records := make([]DispatchRecord, 0, len(items))
	for _, item := range items {
		records = append(records, toRecord(item))
	}
	return records, nil
}

// GetDispatch 读取本账号的一条任务。
//
// 参数：accountID 为当前账号；dispatchID 为任务号。
// 返回值：任务。其他账号或不存在时返回 404。
// 注意事项：发起设备可以用它查看主设备是否已经执行。
func (s *Service) GetDispatch(ctx context.Context, accountID string, dispatchID string) (DispatchRecord, error) {
	item, err := s.store.FindDispatch(ctx, accountID, dispatchID)
	if errors.Is(err, storage.ErrNotFound) {
		return DispatchRecord{}, fail(404, "NOT_FOUND", "任务不存在")
	}
	if err != nil {
		return DispatchRecord{}, err
	}
	return toRecord(item), nil
}

// CompleteDispatch 由主设备回写执行结果。
//
// 参数：device 必须是主设备；dispatchID 为任务号；input 为 running、done 或 failed。
// 返回值：更新后的任务和聊天版本。done 会把回复追加到对应 Agent。
// 注意事项：已经结束的任务再次提交不会重复写入消息。
func (s *Service) CompleteDispatch(ctx context.Context, device storage.Device, dispatchID string, input ResultInput) (DispatchRecord, int64, error) {
	current, err := s.currentDevice(ctx, device)
	if err != nil {
		return DispatchRecord{}, 0, err
	}
	if !current.IsPrimary || !storage.CanExecute(current.Platform) {
		return DispatchRecord{}, 0, fail(403, "NOT_PRIMARY", "只有电脑主设备可以回写执行结果")
	}
	status := input.Status
	if status != "running" && status != "done" && status != "failed" {
		return DispatchRecord{}, 0, fail(400, "INVALID", "任务状态只能是 running、done 或 failed")
	}
	if status == "failed" && strings.TrimSpace(input.ErrorMessage) == "" {
		return DispatchRecord{}, 0, fail(400, "INVALID", "失败时需要提供错误说明")
	}
	if utf8.RuneCountInString(input.ErrorMessage) > 1024 {
		return DispatchRecord{}, 0, fail(400, "INVALID", "错误说明过长")
	}
	var item storage.Dispatch
	var saved storage.State
	var terminal bool
	err = s.store.WithAccount(ctx, device.AccountID, func(tx storage.Tx) error {
		if err := requirePrimary(ctx, tx, device); err != nil {
			return err
		}
		found, err := tx.FindDispatch(ctx, dispatchID)
		if err != nil {
			return err
		}
		if found == nil {
			return fail(404, "NOT_FOUND", "任务不存在")
		}
		item = *found
		claim, claimErr := tx.Claim(ctx, dispatchID)
		if claimErr != nil && !errors.Is(claimErr, storage.ErrNotFound) {
			return claimErr
		}
		if claimErr != nil || input.ClaimToken == "" || claim.DeviceID != device.ID || subtle.ConstantTimeCompare([]byte(claim.TokenHash), []byte(auth.Hash(s.tokenKey, input.ClaimToken))) != 1 {
			return fail(409, "CLAIM_REQUIRED", "任务必须先领取并携带领取令牌")
		}
		if item.Status == "done" || item.Status == "failed" {
			terminal = true
			return nil
		}
		current, err := tx.State(ctx)
		if err != nil {
			return err
		}
		saved = current
		now := time.Now().UTC()
		if !claim.ExpiresAt.After(now) {
			return fail(409, "CLAIM_EXPIRED", "任务领取已过期，请重新领取")
		}
		switch status {
		case "running":
			item.Status = "running"
			claim.ExpiresAt = now.Add(90 * time.Second)
			if err := tx.SaveClaim(ctx, claim); err != nil {
				return err
			}
		case "failed":
			item.Status = "failed"
			item.ErrorMessage = strings.TrimSpace(input.ErrorMessage)
		case "done":
			if len(input.Replies) > 0 {
				metadata := toRecord(item)
				next, err := appendDispatchMessages(current.Body, item.RoomID, metadata.AgentID, nil, input.Replies, false, s.stateLimit)
				if err != nil {
					return err
				}
				saved, err = tx.SaveState(ctx, device.ID, next)
				if err != nil {
					return err
				}
			}
			result, err := json.Marshal(input.Replies)
			if err != nil {
				return err
			}
			item.Status = "done"
			item.Result = result
		}
		item.UpdatedAt = now
		return tx.SaveDispatch(ctx, item)
	})
	if err != nil {
		return DispatchRecord{}, 0, err
	}
	if !terminal {
		logx.Infof("回写执行结果 account=%s dispatch=%s status=%s device=%s", device.AccountID, item.ID, item.Status, device.ID)
		record := toRecord(item)
		raw, _ := json.Marshal(record)
		if item.Status == "done" {
			s.publish(ctx, realtime.Event{AccountID: device.AccountID, Type: "state.updated", Revision: saved.Revision})
		}
		s.publish(ctx, realtime.Event{AccountID: device.AccountID, Type: "dispatch.updated", Revision: saved.Revision, Dispatch: raw})
	}
	if saved.Revision == 0 {
		state, loadErr := s.store.LoadState(ctx, device.AccountID)
		if loadErr == nil {
			saved = state
		}
	}
	return toRecord(item), saved.Revision, nil
}

// currentDevice 重新读取设备，确认它仍属于该账号且未撤销。
//
// 参数：device 为令牌解析出的设备。
// 返回值：数据库中的当前设备。已撤销时返回 401。
// 注意事项：主设备和令牌版本以这次读取为准，缓存设备不能绕过重新登录后的令牌轮换。
func (s *Service) currentDevice(ctx context.Context, device storage.Device) (storage.Device, error) {
	current, err := s.store.GetDevice(ctx, device.AccountID, device.ID)
	if errors.Is(err, storage.ErrNotFound) {
		return storage.Device{}, fail(401, "UNAUTHORIZED", "设备令牌无效")
	}
	if err != nil {
		return storage.Device{}, err
	}
	if current.TokenHash != device.TokenHash {
		return storage.Device{}, fail(401, "UNAUTHORIZED", "设备令牌无效")
	}
	return current, nil
}

// issueDevice 签发设备令牌并登记设备。
//
// 参数：account 为已存在账号；input 为客户端描述；passwordHash为邮箱认证成功时的摘要，Google登录为空。
// 返回值：包含明文令牌的会话。
// 注意事项：明文令牌只出现在返回值中。
func (s *Service) issueDevice(ctx context.Context, account storage.Account, input DeviceInput, passwordHash string, credentialVersion int64) (Session, error) {
	normalized, err := normalizeDevice(input)
	if err != nil {
		return Session{}, err
	}
	raw, hash, err := auth.NewDeviceToken(s.tokenKey)
	if err != nil {
		return Session{}, err
	}
	device, err := s.store.UpsertAuthenticatedDevice(ctx, storage.Device{
		ID:             uuid.NewString(),
		AccountID:      account.ID,
		ClientDeviceID: normalized.ClientDeviceID,
		Name:           normalized.Name,
		Platform:       normalized.Platform,
		TokenHash:      hash,
	}, account.Email, passwordHash, credentialVersion)
	if errors.Is(err, storage.ErrCredentialsChanged) || errors.Is(err, storage.ErrNotFound) {
		return Session{}, fail(401, "CREDENTIALS_CHANGED", "账号凭据已更新，请重新登录")
	}
	if err != nil {
		return Session{}, err
	}
	state, err := s.store.LoadState(ctx, account.ID)
	if err != nil {
		return Session{}, err
	}
	logx.Infof("设备登录 account=%s device=%s platform=%s primary=%t", account.ID, device.ID, device.Platform, device.IsPrimary)
	s.publish(ctx, realtime.Event{AccountID: account.ID, Type: "devices.updated"})
	return Session{Account: s.accountIdentity(account), Device: device, DeviceToken: raw, Revision: state.Revision}, nil
}

// publish 广播事件并忽略空发布器。
//
// 参数：event 为已完成持久化后的通知。
// 返回值：无。
// 注意事项：广播失败不回滚已经保存的聊天记录，设备可以主动拉取。
func (s *Service) publish(ctx context.Context, event realtime.Event) {
	if s.publisher == nil {
		return
	}
	if err := s.publisher.Publish(ctx, event); err != nil {
		logx.Warnf("事件广播失败 account=%s type=%s", event.AccountID, event.Type)
	}
}

// normalizeDevice 校验并截断设备字段。
//
// 参数：input 为原始输入。
// 返回值：可入库的设备描述或 400 错误。
// 注意事项：平台只允许客户端已有的取值。
func normalizeDevice(input DeviceInput) (DeviceInput, error) {
	input.Platform = strings.ToLower(strings.TrimSpace(input.Platform))
	if _, ok := platforms[input.Platform]; !ok {
		return DeviceInput{}, fail(400, "INVALID", "设备平台不正确")
	}
	input.ClientDeviceID = strings.TrimSpace(input.ClientDeviceID)
	if !clientDevicePattern.MatchString(input.ClientDeviceID) {
		return DeviceInput{}, fail(400, "INVALID", "设备编号格式不正确")
	}
	input.Name = trimRunes(input.Name, 128)
	if input.Name == "" {
		input.Name = "未命名设备"
	}
	return input, nil
}

// validateDispatch 校验一轮下发任务。
//
// 参数：input 为客户端请求。
// 返回值：不合法时返回 400。
// 注意事项：真正的 Agent 是否存在要等写入快照时再判断。
func validateDispatch(input DispatchInput) error {
	if !clientDevicePattern.MatchString(input.ClientRequestID) {
		return fail(400, "INVALID", "请求编号格式不正确")
	}
	if input.Mode != "discuss" && input.Mode != "execute" {
		return fail(400, "INVALID", "模式只能是 discuss 或 execute")
	}
	if strings.TrimSpace(input.UserText) == "" || utf8.RuneCountInString(input.UserText) > 1_000_000 {
		return fail(400, "INVALID", "含附件的消息内容不能为空且不能超过 1000000 字")
	}
	if input.AgentID != "" && !looseIDPattern.MatchString(input.AgentID) {
		return fail(400, "INVALID", "Agent 编号格式不正确")
	}
	if input.RoomID != "" && input.AgentID != "" {
		return fail(400, "INVALID", "群聊和私聊目标不能同时设置")
	}
	if input.RoomID != "" && !looseIDPattern.MatchString(input.RoomID) {
		return fail(400, "INVALID", "群编号格式不正确")
	}
	if len(input.Responders) == 0 || len(input.Responders) > 200 {
		return fail(400, "INVALID", "需要 1 到 200 个回复 Agent")
	}
	return nil
}

// validEmail 做最低限度的邮箱格式检查。
//
// 参数：email 为已去空格并小写的字符串。
// 返回值：看起来像邮箱时返回 true。
// 注意事项：这不是完整 RFC 校验，只拦截明显错误输入。
func validEmail(email string) bool {
	if len(email) < 6 || len(email) > 320 || strings.ContainsAny(email, " \t") {
		return false
	}
	name, domain, ok := strings.Cut(email, "@")
	return ok && name != "" && strings.Contains(domain, ".")
}

// fallbackName 在显示名为空时使用邮箱。
//
// 参数：name 为资料名；email 为邮箱。
// 返回值：截断后的显示名。
// 注意事项：最长 128 个 Unicode 字符。
func fallbackName(name string, email string) string {
	name = trimRunes(name, 128)
	if name == "" {
		return trimRunes(email, 128)
	}
	return name
}

// trimRunes 按字符数截断。
//
// 参数：value 为原文；max 为最大字符数。
// 返回值：去掉首尾空白后的字符串。
// 注意事项：按 rune 截断，避免把中文切成半个字符。
func trimRunes(value string, max int) string {
	value = strings.TrimSpace(value)
	if utf8.RuneCountInString(value) <= max {
		return value
	}
	return string([]rune(value)[:max])
}

// fail 构造业务错误。
//
// 参数：status 为 HTTP 状态；code 为稳定错误码；message 为说明。
// 返回值：*Error。
// 注意事项：调用方用 errors.As 识别。
func fail(status int, code string, message string) *Error {
	return &Error{Status: status, Code: code, Message: message}
}

// toRecord 把存储任务转换成可序列化视图。
//
// 参数：item 为存储层任务。
// 返回值：不包含令牌的任务。
// 注意事项：空 JSON 字段保持 nil，以便 omitempty 生效。
func toRecord(item storage.Dispatch) DispatchRecord {
	record := DispatchRecord{
		ID:              item.ID,
		AccountID:       item.AccountID,
		SourceDeviceID:  item.SourceDeviceID,
		ClientRequestID: item.ClientRequestID,
		Mode:            item.Mode,
		RoomID:          item.RoomID,
		UserText:        item.UserText,
		Status:          item.Status,
		ErrorMessage:    item.ErrorMessage,
		CreatedAt:       item.CreatedAt,
		UpdatedAt:       item.UpdatedAt,
	}
	if len(item.Payload) > 0 {
		if item.Payload[0] == '[' {
			record.Payload = append(json.RawMessage(nil), item.Payload...)
			_ = json.Unmarshal(item.Payload, &record.Responders)
		} else {
			var metadata DispatchInput
			if json.Unmarshal(item.Payload, &metadata) == nil {
				record.Responders = metadata.Responders
				record.AgentID = metadata.AgentID
				record.UserMessage = metadata.UserMessage
				record.Attachments = metadata.Attachments
				record.Context = metadata.Context
				record.Payload, _ = json.Marshal(metadata.Responders)
			}
		}
	}
	if len(item.Result) > 0 {
		record.Result = append(json.RawMessage(nil), item.Result...)
	}
	// 历史队列只修正发送者，保留消息 ID，避免破坏快照去重与回复关联。
	if len(record.UserMessage) > 0 {
		if canonical, err := historicalUserMessage(record.UserMessage, item.ClientRequestID); err == nil {
			record.UserMessage = canonical
		}
	}
	for index, responder := range record.Responders {
		if len(responder.Message) == 0 {
			continue
		}
		if canonical, err := historicalUserMessage(responder.Message, item.ClientRequestID); err == nil {
			record.Responders[index].Message = canonical
			if len(record.UserMessage) == 0 {
				record.UserMessage = canonical
			}
		}
	}
	if record.Responders != nil {
		record.Payload, _ = json.Marshal(record.Responders)
	}
	return record
}

// decodeObject 把 JSON 对象解成保留数字精度的 map。
//
// 参数：raw 为原始 JSON。
// 返回值：对象；不是对象时返回错误。
// 注意事项：使用 json.Number，避免消息编号被改成浮点。
func decodeObject(raw json.RawMessage) (map[string]any, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil, fail(400, "INVALID", "消息必须是 JSON 对象")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, fail(400, "INVALID", "消息 JSON 无法解析")
	}
	object, ok := value.(map[string]any)
	if !ok || object == nil {
		return nil, fail(400, "INVALID", "消息必须是 JSON 对象")
	}
	return object, nil
}

// ClaimDispatch 在账号锁内领取下一项任务，多个服务节点不能同时领取。
func (s *Service) ClaimDispatch(ctx context.Context, device storage.Device) (*DispatchRecord, error) {
	raw, hash, err := auth.NewDeviceToken(s.tokenKey)
	if err != nil {
		return nil, err
	}
	var record *DispatchRecord
	err = s.store.WithAccount(ctx, device.AccountID, func(tx storage.Tx) error {
		if err := requirePrimary(ctx, tx, device); err != nil {
			return err
		}
		items, err := tx.Pending(ctx)
		if err != nil {
			return err
		}
		now := time.Now().UTC()
		for _, item := range items {
			claim, err := tx.Claim(ctx, item.ID)
			if err != nil && !errors.Is(err, storage.ErrNotFound) {
				return err
			}
			if err == nil && claim.ExpiresAt.After(now) {
				continue
			}
			claim = storage.Claim{DispatchID: item.ID, DeviceID: device.ID, TokenHash: hash, ExpiresAt: now.Add(90 * time.Second)}
			if err := tx.SaveClaim(ctx, claim); err != nil {
				return err
			}
			item.Status = "running"
			item.UpdatedAt = now
			if err := tx.SaveDispatch(ctx, item); err != nil {
				return err
			}
			view := toRecord(item)
			view.ClaimToken = raw
			view.LeaseExpiresAt = &claim.ExpiresAt
			record = &view
			break
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if record != nil {
		s.publish(ctx, realtime.Event{AccountID: device.AccountID, Type: "dispatch.updated"})
	}
	return record, nil
}

// requirePrimary 在持有账号锁时复核主电脑身份及当前令牌版本。
//
// 参数：ctx 控制取消；tx 为账号事务；device 为此前通过认证的设备会话。
// 返回值：会话失效返回 401，非主电脑返回 403。
// 注意事项：删除后重新登录会复用设备编号，仍须比较令牌版本以拒绝晚到的旧请求。
func requirePrimary(ctx context.Context, tx storage.Tx, device storage.Device) error {
	d, err := tx.Device(ctx, device.ID)
	if errors.Is(err, storage.ErrNotFound) {
		return fail(401, "UNAUTHORIZED", "设备令牌无效")
	}
	if err != nil {
		return err
	}
	if device.TokenHash == "" || d.TokenHash != device.TokenHash {
		return fail(401, "UNAUTHORIZED", "设备令牌无效")
	}
	if !d.IsPrimary || !storage.CanExecute(d.Platform) {
		return fail(403, "NOT_PRIMARY", "只有电脑主设备可以执行和同步配置")
	}
	return nil
}

// ValidateDevice 在开始浏览器 OAuth 之前校验客户端设备描述。
func ValidateDevice(input DeviceInput) error { _, err := normalizeDevice(input); return err }

func (s *Service) StateLimit() int                     { return s.stateLimit }
func (s *Service) Seal(body []byte) (string, error)    { return auth.Seal(s.tokenKey, body) }
func (s *Service) Unseal(value string) ([]byte, error) { return auth.Open(s.tokenKey, value) }

// canonicalUserMessage 在新任务持久化前统一消息 ID 和用户身份，不能由手机冒用 Agent。
func canonicalUserMessage(raw json.RawMessage, requestID string) (json.RawMessage, error) {
	message, err := decodeObject(raw)
	if err != nil {
		return nil, err
	}
	message["id"] = requestID
	message["from"] = "you"
	return json.Marshal(message)
}

// historicalUserMessage 下发旧任务时保留已有消息 ID，与旧快照和 reply.requestId 保持一致。
func historicalUserMessage(raw json.RawMessage, requestID string) (json.RawMessage, error) {
	message, err := decodeObject(raw)
	if err != nil {
		return nil, err
	}
	if id, ok := message["id"].(string); !ok || strings.TrimSpace(id) == "" {
		message["id"] = requestID
	}
	message["from"] = "you"
	return json.Marshal(message)
}
