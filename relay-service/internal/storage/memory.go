package storage

import (
	"context"
	"slices"
	"sync"
	"time"
)

// Memory 是测试和单进程使用的内存存储。
type Memory struct {
	mu           sync.Mutex
	accounts     map[string]Account
	emails       map[string]string
	devices      map[string]Device
	tokens       map[string]string
	states       map[string]State
	dispatches   map[string]Dispatch
	invites      map[string]Invite
	passwords    map[string]string
	authVersions map[string]int64
	claims       map[string]Claim
}

// NewMemory 创建空的内存存储。
//
// 参数：无。
// 返回值：可并发使用的存储。
// 注意事项：进程退出后数据消失，不能用于测试环境部署。
func NewMemory() *Memory {
	return &Memory{
		accounts:     map[string]Account{},
		emails:       map[string]string{},
		devices:      map[string]Device{},
		tokens:       map[string]string{},
		states:       map[string]State{},
		dispatches:   map[string]Dispatch{},
		invites:      map[string]Invite{},
		passwords:    map[string]string{},
		authVersions: map[string]int64{},
		claims:       map[string]Claim{},
	}
}

// Ping 确认内存存储可用。
//
// 参数：ctx 未使用。
// 返回值：始终为 nil。
// 注意事项：不代表 MySQL 或 Redis 可用。
func (m *Memory) Ping(context.Context) error { return nil }

// UpsertAccount 按邮箱创建或更新账号，并保证存在聊天快照行。
//
// 参数：account 至少包含 ID、Email、Provider。
// 返回值：实际保存的账号，重复邮箱会沿用已有 ID。
// 注意事项：邮箱需要调用方事先规范化。
func (m *Memory) UpsertAccount(_ context.Context, account Account) (Account, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now().UTC()
	if id, ok := m.emails[account.Email]; ok {
		current := m.accounts[id]
		if current.Provider != account.Provider {
			return Account{}, ErrProviderConflict
		}
		if account.Name != "" {
			current.Name = account.Name
		}
		if account.Picture != "" {
			current.Picture = account.Picture
		}
		current.UpdatedAt = now
		m.accounts[id] = current
		m.ensureStateLocked(id, now)
		return current, nil
	}
	account.CreatedAt = now
	account.UpdatedAt = now
	m.accounts[account.ID] = account
	m.emails[account.Email] = account.ID
	m.ensureStateLocked(account.ID, now)
	return account, nil
}

// FindAccountByEmail 按邮箱查找账号。
//
// 参数：email 为规范化邮箱。
// 返回值：不存在时返回 ErrNotFound。
// 注意事项：不会创建账号。
func (m *Memory) FindAccountByEmail(_ context.Context, email string) (Account, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	id, ok := m.emails[email]
	if !ok {
		return Account{}, ErrNotFound
	}
	return m.accounts[id], nil
}

// UpsertDevice 登记或重新登录一台设备，并在没有其他主设备时把它设为主设备。
//
// 参数：device 需要账号、客户端设备号和令牌摘要。
// 返回值：保存后的设备。账号不存在时返回 ErrNotFound。
// 注意事项：重复登录会替换令牌摘要，旧令牌立即失效。
func (m *Memory) UpsertDevice(ctx context.Context, device Device) (Device, error) {
	return m.UpsertAuthenticatedDevice(ctx, device, "", "", -1)
}

// UpsertAuthenticatedDevice 在同一把锁内核对认证快照并保存设备。参数：expectedEmail和expectedPasswordHash为认证时的值；返回值：设备或凭据已变化错误；注意事项：测试语义与MySQL账号事务锁一致。
func (m *Memory) UpsertAuthenticatedDevice(_ context.Context, device Device, expectedEmail, expectedPasswordHash string, expectedVersion int64) (Device, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.accounts[device.AccountID]; !ok {
		return Device{}, ErrNotFound
	}
	if (expectedEmail != "" && m.accounts[device.AccountID].Email != expectedEmail) || (expectedPasswordHash != "" && (m.passwords[device.AccountID] != expectedPasswordHash || (expectedVersion >= 0 && m.authVersions[device.AccountID] != expectedVersion))) {
		return Device{}, ErrCredentialsChanged
	}
	now := time.Now().UTC()
	var current *Device
	for _, item := range m.devices {
		if item.AccountID == device.AccountID && item.ClientDeviceID == device.ClientDeviceID {
			copied := item
			current = &copied
			break
		}
	}
	anotherPrimary := false
	for _, item := range m.devices {
		if item.AccountID != device.AccountID || item.Revoked || !item.IsPrimary || !CanExecute(item.Platform) {
			continue
		}
		if current != nil && item.ID == current.ID {
			continue
		}
		anotherPrimary = true
	}
	alreadyPrimary := current != nil && current.IsPrimary && !current.Revoked
	device.IsPrimary = CanExecute(device.Platform) && KeepOrAssignPrimary(alreadyPrimary, anotherPrimary)
	device.Revoked = false
	device.UpdatedAt = now
	if current == nil {
		device.CreatedAt = now
	} else {
		device.ID = current.ID
		device.CreatedAt = current.CreatedAt
		delete(m.tokens, current.TokenHash)
	}
	m.devices[device.ID] = device
	m.tokens[device.TokenHash] = device.ID
	return device, nil
}

// ListDevices 返回账号下尚未撤销的设备。
//
// 参数：accountID 为账号主键。
// 返回值：按创建时间升序排列的设备。
// 注意事项：不返回令牌摘要给更外层之前，调用方仍不应把它写入接口响应。
func (m *Memory) ListDevices(_ context.Context, accountID string) ([]Device, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.listActiveLocked(accountID), nil
}

// GetDevice 读取一台未撤销设备。
//
// 参数：accountID 与 deviceID 必须匹配。
// 返回值：已撤销或不存在时返回 ErrNotFound。
// 注意事项：用于在执行前重新确认主设备身份，避免使用登录时的旧快照。
func (m *Memory) GetDevice(_ context.Context, accountID string, deviceID string) (Device, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	device, ok := m.devices[deviceID]
	if !ok || device.AccountID != accountID || device.Revoked {
		return Device{}, ErrNotFound
	}
	return device, nil
}

// DeviceByTokenHash 用令牌摘要定位设备和账号。
//
// 参数：tokenHash 为 HMAC 摘要。
// 返回值：已撤销或不存在时返回 ErrNotFound。
// 注意事项：摘要碰撞在 256 位 HMAC 下可以忽略。
func (m *Memory) DeviceByTokenHash(_ context.Context, tokenHash string) (Device, Account, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	id, ok := m.tokens[tokenHash]
	if !ok {
		return Device{}, Account{}, ErrNotFound
	}
	device := m.devices[id]
	if device.Revoked {
		return Device{}, Account{}, ErrNotFound
	}
	account, ok := m.accounts[device.AccountID]
	if !ok {
		return Device{}, Account{}, ErrNotFound
	}
	return device, account, nil
}

// TouchDevice 更新设备最近出现时间。
//
// 参数：deviceID 为设备主键；seenAt 为本次出现时间。
// 返回值：设备不存在时返回 ErrNotFound。
// 注意事项：失败不应阻断聊天读取。
func (m *Memory) TouchDevice(_ context.Context, deviceID string, seenAt time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	device, ok := m.devices[deviceID]
	if !ok {
		return ErrNotFound
	}
	seen := seenAt.UTC()
	device.LastSeenAt = &seen
	device.UpdatedAt = seen
	m.devices[deviceID] = device
	return nil
}

// SetPrimary 把指定未撤销设备设为唯一主设备。
//
// 参数：accountID 与 deviceID 必须属于同一账号。
// 返回值：设备不存在或已撤销时返回 ErrNotFound。
// 注意事项：同一账号最终只会剩下一台主设备。
func (m *Memory) SetPrimary(ctx context.Context, accountID string, deviceID string) error {
	return m.setPrimary(ctx, accountID, deviceID, nil, nil)
}

// SetPrimaryForSession 在内存账号锁内复核请求者后切换主电脑。参数：requester为认证快照，deviceID为目标；返回值：操作错误；注意事项：禁止旧令牌请求修改重新登录的会话。
func (m *Memory) SetPrimaryForSession(ctx context.Context, requester Device, deviceID string) error {
	return m.setPrimary(ctx, requester.AccountID, deviceID, &requester, nil)
}

// setPrimary 执行内存主设备变更。参数：requester为空仅供可信内部调用；返回值：变更错误；注意事项：认证与写入共用同一把互斥锁。
func (m *Memory) setPrimary(_ context.Context, accountID string, deviceID string, requester *Device, beforeChange func() error) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.validateRequesterLocked(requester); err != nil {
		return err
	}
	target, ok := m.devices[deviceID]
	if !ok || target.AccountID != accountID || target.Revoked || !CanExecute(target.Platform) {
		return ErrNotFound
	}
	if target.IsPrimary {
		return nil
	}
	// ------------ 旧配置通道失效与主角色变更共用账号锁 ---------------
	if beforeChange != nil {
		if err := beforeChange(); err != nil {
			return err
		}
	}
	for id, item := range m.devices {
		if item.AccountID != accountID || item.Revoked {
			continue
		}
		item.IsPrimary = id == deviceID
		m.devices[id] = item
	}
	return nil
}

// RevokeDevice 撤销设备，同时清除该设备的主设备身份。
//
// 参数：accountID 与 deviceID 必须匹配。
// 返回值：设备不存在时返回 ErrNotFound。
// 注意事项：撤销后旧令牌不能再使用。
func (m *Memory) RevokeDevice(_ context.Context, accountID string, deviceID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, err := m.revokeDeviceLocked(accountID, deviceID, "")
	return err
}

// RevokeSession 在内存锁内仅撤销认证时对应的设备令牌版本。
//
// 参数：device 为服务器认证结果，包含不可由客户端填写的 TokenHash。
// 返回值：实际撤销返回 true；过期退出请求和重复退出返回 false。
// 注意事项：缺少摘要视为非法输入；不能退化为不带条件的设备撤销。
func (m *Memory) RevokeSession(_ context.Context, device Device) (bool, error) {
	if device.TokenHash == "" {
		return false, ErrNotFound
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.revokeDeviceLocked(device.AccountID, device.ID, device.TokenHash)
}

// revokeDeviceLocked 撤销设备并清除其执行主设备身份。
//
// 参数：accountID 与 deviceID 限定目标；expectedHash 为空时执行设备管理撤销，非空时限定会话版本。
// 返回值：是否实际撤销以及存储错误。
// 注意事项：调用方必须持有内存锁；不自动提升其他设备，避免离线电脑成为主设备。
func (m *Memory) revokeDeviceLocked(accountID, deviceID, expectedHash string) (bool, error) {
	target, ok := m.devices[deviceID]
	if !ok || target.AccountID != accountID || target.Revoked {
		if expectedHash != "" {
			return false, nil
		}
		return false, ErrNotFound
	}
	// ------------ 校验退出请求仍对应当前会话 ---------------
	if expectedHash != "" && target.TokenHash != expectedHash {
		return false, nil
	}
	target.Revoked = true
	target.IsPrimary = false
	now := time.Now().UTC()
	target.UpdatedAt = now
	m.devices[deviceID] = target
	delete(m.tokens, target.TokenHash)
	return true, nil
}

// InsertInvite 保存邀请码摘要。
//
// 参数：invite 使用摘要作为主键。
// 返回值：写入错误。内存实现只在摘要重复时覆盖前检查并返回错误。
// 注意事项：明文邀请码不能进入本结构。
func (m *Memory) InsertInvite(_ context.Context, invite Invite) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.invites[invite.CodeHash]; ok {
		return errorsNewDuplicate()
	}
	m.invites[invite.CodeHash] = invite
	return nil
}

// ConsumeInvite 核销未过期的邀请码。
//
// 参数：codeHash 为邀请码摘要；now 为当前时间。
// 返回值：对应账号 ID。已用、过期或不存在时返回相应错误。
// 注意事项：成功后同一摘要不能再次核销。
func (m *Memory) ConsumeInvite(_ context.Context, codeHash string, now time.Time) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	invite, ok := m.invites[codeHash]
	if !ok {
		return "", ErrNotFound
	}
	if invite.UsedAt != nil {
		return "", ErrInviteUsed
	}
	if !invite.ExpiresAt.After(now) {
		return "", ErrInviteExpired
	}
	used := now.UTC()
	invite.UsedAt = &used
	m.invites[codeHash] = invite
	return invite.AccountID, nil
}

// WithAccount 在账号临界区内执行聊天快照和任务修改。
//
// 参数：fn 返回错误时丢弃本次临界区内的快照和任务变更。
// 返回值：fn 或存储错误。
// 注意事项：fn 内不要再调用会获取同一把锁的 Store 方法。
func (m *Memory) WithAccount(_ context.Context, accountID string, fn func(Tx) error) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.accounts[accountID]; !ok {
		return ErrNotFound
	}
	backup := m.snapshotLocked(accountID)
	err := fn(&memTx{memory: m, accountID: accountID})
	if err != nil {
		m.restoreLocked(accountID, backup)
		return err
	}
	return nil
}

// LoadState 读取账号聊天快照。
//
// 参数：accountID 为账号主键。
// 返回值：没有快照时返回版本 0 的空聊天结构。
// 注意事项：返回副本，调用方修改不会影响存储。
func (m *Memory) LoadState(_ context.Context, accountID string) (State, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	state, ok := m.states[accountID]
	if !ok {
		return State{Revision: 0, Body: []byte(emptyState)}, nil
	}
	state.Body = append([]byte(nil), state.Body...)
	return state, nil
}

// ListPending 返回尚未完成的执行任务。
//
// 参数：accountID 为账号主键。
// 返回值：pending 和 running 状态的任务，按创建时间升序。
// 注意事项：完成和失败的任务不在此列表。
func (m *Memory) ListPending(_ context.Context, accountID string) ([]Dispatch, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	items := make([]Dispatch, 0)
	for _, item := range m.dispatches {
		if item.AccountID == accountID && (item.Status == "pending" || item.Status == "running") {
			items = append(items, cloneDispatch(item))
		}
	}
	slices.SortFunc(items, func(a Dispatch, b Dispatch) int {
		if a.CreatedAt.Before(b.CreatedAt) {
			return -1
		}
		if a.CreatedAt.After(b.CreatedAt) {
			return 1
		}
		return 0
	})
	return items, nil
}

// FindDispatch 按账号和任务号读取任务。
//
// 参数：accountID 限定租户；dispatchID 为任务主键。
// 返回值：不存在时返回 ErrNotFound。
// 注意事项：返回副本。
func (m *Memory) FindDispatch(_ context.Context, accountID string, dispatchID string) (Dispatch, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	item, ok := m.dispatches[dispatchID]
	if !ok || item.AccountID != accountID {
		return Dispatch{}, ErrNotFound
	}
	return cloneDispatch(item), nil
}

// memTx 在 Memory 已持锁时修改同一个账号的数据。
type memTx struct {
	memory    *Memory
	accountID string
}

// State 读取临界区内的当前快照。
//
// 参数：ctx 未使用。
// 返回值：快照副本。
// 注意事项：必须运行在 WithAccount 内。
func (t *memTx) State(context.Context) (State, error) {
	state, ok := t.memory.states[t.accountID]
	if !ok {
		return State{Revision: 0, Body: []byte(emptyState)}, nil
	}
	state.Body = append([]byte(nil), state.Body...)
	return state, nil
}

// SaveState 保存新快照并把版本加一。
//
// 参数：deviceID 记录写入来源；body 为完整 JSON。
// 返回值：新版本。
// 注意事项：调用方负责冲突检测。
func (t *memTx) SaveState(_ context.Context, deviceID string, body []byte) (State, error) {
	current := t.memory.states[t.accountID]
	now := time.Now().UTC()
	next := State{Revision: current.Revision + 1, Body: append([]byte(nil), body...), UpdatedBy: deviceID, UpdatedAt: now}
	t.memory.states[t.accountID] = next
	return next, nil
}

// FindDispatchByClientRequest 在临界区内按幂等键查找。
//
// 参数：clientRequestID 为客户端请求号。
// 返回值：不存在时返回 nil, nil。
// 注意事项：只匹配当前账号。
func (t *memTx) FindDispatchByClientRequest(_ context.Context, clientRequestID string) (*Dispatch, error) {
	for _, item := range t.memory.dispatches {
		if item.AccountID == t.accountID && item.ClientRequestID == clientRequestID {
			copied := cloneDispatch(item)
			return &copied, nil
		}
	}
	return nil, nil
}

// InsertDispatch 写入任务。
//
// 参数：item 为完整任务。
// 返回值：同一账号的幂等键重复时返回错误。
// 注意事项：回滚由 WithAccount 负责。
func (t *memTx) InsertDispatch(_ context.Context, item Dispatch) error {
	for _, current := range t.memory.dispatches {
		if current.AccountID == item.AccountID && current.ClientRequestID == item.ClientRequestID {
			return errorsNewDuplicate()
		}
	}
	t.memory.dispatches[item.ID] = cloneDispatch(item)
	return nil
}

// FindDispatch 在临界区内按主键查找任务。
//
// 参数：id 为任务主键。
// 返回值：不存在时返回 nil, nil。
// 注意事项：账号不匹配视为不存在。
func (t *memTx) FindDispatch(_ context.Context, id string) (*Dispatch, error) {
	item, ok := t.memory.dispatches[id]
	if !ok || item.AccountID != t.accountID {
		return nil, nil
	}
	copied := cloneDispatch(item)
	return &copied, nil
}

// SaveDispatch 覆盖任务状态。
//
// 参数：item 必须属于当前账号。
// 返回值：不存在时返回 ErrNotFound。
// 注意事项：不新增任务。
func (t *memTx) SaveDispatch(_ context.Context, item Dispatch) error {
	current, ok := t.memory.dispatches[item.ID]
	if !ok || current.AccountID != t.accountID {
		return ErrNotFound
	}
	t.memory.dispatches[item.ID] = cloneDispatch(item)
	return nil
}

// ensureStateLocked 补上一份空聊天快照。
//
// 参数：accountID 为账号；now 为创建时间。
// 返回值：无。
// 注意事项：调用方必须已持有 m.mu。
func (m *Memory) ensureStateLocked(accountID string, now time.Time) {
	if _, ok := m.states[accountID]; ok {
		return
	}
	m.states[accountID] = State{Revision: 0, Body: []byte(emptyState), UpdatedAt: now}
}

// listActiveLocked 列出未撤销设备。
//
// 参数：accountID 为账号。
// 返回值：按创建时间升序的副本。
// 注意事项：调用方必须已持有 m.mu。
func (m *Memory) listActiveLocked(accountID string) []Device {
	items := make([]Device, 0)
	for _, item := range m.devices {
		if item.AccountID == accountID && !item.Revoked {
			items = append(items, item)
		}
	}
	slices.SortFunc(items, func(a Device, b Device) int {
		if a.CreatedAt.Before(b.CreatedAt) {
			return -1
		}
		if a.CreatedAt.After(b.CreatedAt) {
			return 1
		}
		if a.ID < b.ID {
			return -1
		}
		if a.ID > b.ID {
			return 1
		}
		return 0
	})
	return items
}

type memoryBackup struct {
	state      State
	hasState   bool
	dispatches map[string]Dispatch
	claims     map[string]Claim
}

// snapshotLocked 复制一个账号的快照和任务，供失败回滚。
//
// 参数：accountID 为账号。
// 返回值：独立副本。
// 注意事项：调用方必须已持有 m.mu。
func (m *Memory) snapshotLocked(accountID string) memoryBackup {
	backup := memoryBackup{dispatches: map[string]Dispatch{}, claims: map[string]Claim{}}
	if state, ok := m.states[accountID]; ok {
		backup.state = state
		backup.state.Body = append([]byte(nil), state.Body...)
		backup.hasState = true
	}
	for id, item := range m.dispatches {
		if item.AccountID == accountID {
			backup.dispatches[id] = cloneDispatch(item)
			if claim, ok := m.claims[id]; ok {
				backup.claims[id] = claim
			}
		}
	}
	return backup
}

// restoreLocked 用快照覆盖账号的聊天和任务。
//
// 参数：accountID 为账号；backup 为进入临界区前的副本。
// 返回值：无。
// 注意事项：调用方必须已持有 m.mu。
func (m *Memory) restoreLocked(accountID string, backup memoryBackup) {
	if backup.hasState {
		m.states[accountID] = backup.state
	} else {
		delete(m.states, accountID)
	}
	for id, item := range m.dispatches {
		if item.AccountID == accountID {
			delete(m.dispatches, id)
			delete(m.claims, id)
		}
	}
	for id, item := range backup.dispatches {
		m.dispatches[id] = item
		if claim, ok := backup.claims[id]; ok {
			m.claims[id] = claim
		}
	}
}

// cloneDispatch 复制任务及其 JSON 缓冲。
//
// 参数：item 为原任务。
// 返回值：独立副本。
// 注意事项：结果和载荷都需要复制，避免调用方改到存储。
func cloneDispatch(item Dispatch) Dispatch {
	item.Payload = append([]byte(nil), item.Payload...)
	item.Result = append([]byte(nil), item.Result...)
	return item
}

// errorsNewDuplicate 返回幂等键冲突错误。
//
// 参数：无。
// 返回值：固定错误。
// 注意事项：服务层应先查询再插入，这个错误只作为防护。
func errorsNewDuplicate() error {
	return errorsDuplicate
}

var errorsDuplicate = errorsType("duplicate")

type errorsType string

func (e errorsType) Error() string { return string(e) }

// RegisterEmail 原子创建有密码的新账号，已有邮箱不能被注册请求接管。
func (m *Memory) RegisterEmail(_ context.Context, account Account, passwordHash string) (Account, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.emails[account.Email]; ok {
		return Account{}, ErrAccountExists
	}
	now := time.Now().UTC()
	account.CreatedAt = now
	account.UpdatedAt = now
	m.accounts[account.ID] = account
	m.emails[account.Email] = account.ID
	m.passwords[account.ID] = passwordHash
	m.ensureStateLocked(account.ID, now)
	return account, nil
}
func (m *Memory) PasswordHash(_ context.Context, accountID string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	value, ok := m.passwords[accountID]
	if !ok {
		return "", ErrNotFound
	}
	return value, nil
}
func (t *memTx) Device(_ context.Context, deviceID string) (Device, error) {
	d, ok := t.memory.devices[deviceID]
	if !ok || d.AccountID != t.accountID || d.Revoked {
		return Device{}, ErrNotFound
	}
	return d, nil
}
func (t *memTx) Pending(context.Context) ([]Dispatch, error) {
	items := []Dispatch{}
	for _, d := range t.memory.dispatches {
		if d.AccountID == t.accountID && (d.Status == "pending" || d.Status == "running") {
			items = append(items, cloneDispatch(d))
		}
	}
	slices.SortFunc(items, func(a, b Dispatch) int {
		if a.CreatedAt.Before(b.CreatedAt) {
			return -1
		}
		if a.CreatedAt.After(b.CreatedAt) {
			return 1
		}
		return 0
	})
	return items, nil
}
func (t *memTx) Claim(_ context.Context, dispatchID string) (Claim, error) {
	c, ok := t.memory.claims[dispatchID]
	if !ok {
		return Claim{}, ErrNotFound
	}
	return c, nil
}
func (t *memTx) SaveClaim(_ context.Context, c Claim) error {
	t.memory.claims[c.DispatchID] = c
	return nil
}
