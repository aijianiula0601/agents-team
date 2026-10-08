// Package storage 保存账号、设备、聊天记录和执行任务。
package storage

import (
	"context"
	"errors"
	"time"
)

const emptyState = `{"agents":[],"rooms":[]}`

var (
	// ErrNotFound 表示账号、设备、邀请码或任务不存在。
	ErrNotFound         = errors.New("not found")
	ErrAccountExists    = errors.New("account already exists")
	ErrProviderConflict = errors.New("identity provider conflict")
	// ErrInviteUsed 表示邀请码已经使用。
	ErrInviteUsed = errors.New("invite used")
	// ErrInviteExpired 表示邀请码已过期。
	ErrInviteExpired = errors.New("invite expired")
)

// Account 是按登录邮箱区分的 Chorus 账号。
//
// 参数：持久化字段保存登录资料；EmployeeID 与 Role 由服务器在认证后计算，不入数据库。
// 返回值：存储层返回账号，业务层补充当前有效身份。
// 注意事项：客户端不能设置员工身份；重新部署撤销映射后，现有会话也会失去该角色。
type Account struct {
	ID         string
	Email      string
	Name       string
	Picture    string
	Provider   string
	EmployeeID string
	Role       string
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

// Device 是登录到某个账号的一台客户端。
type Device struct {
	ID             string
	AccountID      string
	ClientDeviceID string
	Name           string
	Platform       string
	IsPrimary      bool
	TokenHash      string
	LastSeenAt     *time.Time
	Revoked        bool
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// State 是某个账号当前的聊天快照。
type State struct {
	Revision  int64
	Body      []byte
	UpdatedBy string
	UpdatedAt time.Time
}

// Dispatch 是发给主设备执行的一条聊天任务。
type Dispatch struct {
	ID              string
	AccountID       string
	SourceDeviceID  string
	ClientRequestID string
	Mode            string
	RoomID          string
	UserText        string
	Payload         []byte
	Status          string
	Result          []byte
	ErrorMessage    string
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

// Invite 是已有账号邀请新设备时使用的一次性验证码。
type Invite struct {
	CodeHash        string
	AccountID       string
	CreatedByDevice string
	ExpiresAt       time.Time
	UsedAt          *time.Time
	CreatedAt       time.Time
}

// Claim 是执行任务的有限期独占租约，明文领取令牌不入库。
type Claim struct {
	DispatchID string
	DeviceID   string
	TokenHash  string
	ExpiresAt  time.Time
}

// Tx 是持有账号行锁期间的聊天与任务操作。
type Tx interface {
	Device(ctx context.Context, deviceID string) (Device, error)
	Pending(ctx context.Context) ([]Dispatch, error)
	// ConfigInUse 检查指定 Agent 私聊或群是否仍有未结束的任务。
	//
	// 参数：agentID 可为空；roomIDs 为需要保护的群编号。
	// 返回值：存在 pending 或 running 任务时为 true。
	// 注意事项：必须检查全部队列，不能受领取任务列表的 100 条分页限制影响。
	ConfigInUse(ctx context.Context, agentID string, roomIDs []string) (bool, error)
	Claim(ctx context.Context, dispatchID string) (Claim, error)
	SaveClaim(ctx context.Context, claim Claim) error
	// State 读取当前快照。
	//
	// 参数：ctx 控制取消。
	// 返回值：版本和正文；尚无记录时版本为 0。
	// 注意事项：返回的正文可被调用方修改，不能回写存储层内部缓冲。
	State(ctx context.Context) (State, error)
	// SaveState 在当前版本上加一后保存整份快照。
	//
	// 参数：deviceID 为写入设备；body 为新的 JSON。
	// 返回值：保存后的快照。
	// 注意事项：调用方需要先比对期望版本，本方法不再做乐观锁判断。
	SaveState(ctx context.Context, deviceID string, body []byte) (State, error)
	// FindDispatchByClientRequest 按客户端幂等键查找任务。
	//
	// 参数：clientRequestID 为客户端生成的请求号。
	// 返回值：不存在时返回 nil, nil。
	// 注意事项：只查找当前账号。
	FindDispatchByClientRequest(ctx context.Context, clientRequestID string) (*Dispatch, error)
	// InsertDispatch 写入新任务。
	//
	// 参数：item 必须已经填好账号和主键。
	// 返回值：唯一键冲突或其他数据库错误。
	// 注意事项：与 SaveState 处于同一个事务。
	InsertDispatch(ctx context.Context, item Dispatch) error
	// FindDispatch 按任务 ID 查找。
	//
	// 参数：id 为任务主键。
	// 返回值：不存在时返回 nil, nil。
	// 注意事项：不能读到其他账号的任务。
	FindDispatch(ctx context.Context, id string) (*Dispatch, error)
	// SaveDispatch 更新任务状态和结果。
	//
	// 参数：item 为完整任务。
	// 返回值：任务不存在时返回 ErrNotFound。
	// 注意事项：不改变所属账号。
	SaveDispatch(ctx context.Context, item Dispatch) error
}

// Store 是账号域的持久化接口。
type Store interface {
	RegisterEmail(ctx context.Context, account Account, passwordHash string) (Account, error)
	PasswordHash(ctx context.Context, accountID string) (string, error)
	PasswordState(ctx context.Context, accountID string) (string, int64, error)
	Ping(ctx context.Context) error
	UpsertAccount(ctx context.Context, account Account) (Account, error)
	FindAccountByEmail(ctx context.Context, email string) (Account, error)
	UpsertDevice(ctx context.Context, device Device) (Device, error)
	UpsertAuthenticatedDevice(ctx context.Context, device Device, expectedEmail, expectedPasswordHash string, expectedVersion int64) (Device, error)
	ListDevices(ctx context.Context, accountID string) ([]Device, error)
	GetDevice(ctx context.Context, accountID string, deviceID string) (Device, error)
	DeviceByTokenHash(ctx context.Context, tokenHash string) (Device, Account, error)
	TouchDevice(ctx context.Context, deviceID string, seenAt time.Time) error
	SetPrimary(ctx context.Context, accountID string, deviceID string) error
	SetPrimaryForSession(ctx context.Context, requester Device, deviceID string) error
	// SetPrimaryForSessionWithHook 在账号锁内验证会话后，先使旧主电脑临时配置通道失效再切换角色。
	//
	// 参数：beforeChange 只在真正换主时调用，nil 表示无需额外失效操作。
	// 返回值：会话、目标、回调或持久化错误；回调失败不改变主设备。
	// 注意事项：回调不能重新访问 Store，以免重入账号锁；外部缓存清理成功而提交失败时须允许重新发布。
	SetPrimaryForSessionWithHook(ctx context.Context, requester Device, deviceID string, beforeChange func() error) error
	RevokeDevice(ctx context.Context, accountID string, deviceID string) error
	RevokeDeviceForSession(ctx context.Context, requester Device, deviceID string) error
	// RevokeSession 仅撤销当前设备仍使用的认证令牌版本。
	//
	// 参数：device 包含服务器认证时读取的账号、设备ID与令牌摘要。
	// 返回值：确实撤销时返回 true；会话已退出或令牌已轮换时返回 false。
	// 注意事项：比较摘要与撤销必须原子执行，不能让旧退出请求撤销重新登录的新会话。
	RevokeSession(ctx context.Context, device Device) (bool, error)
	InsertInvite(ctx context.Context, invite Invite) error
	ConsumeInvite(ctx context.Context, codeHash string, now time.Time) (string, error)
	WithAccount(ctx context.Context, accountID string, fn func(Tx) error) error
	LoadState(ctx context.Context, accountID string) (State, error)
	ListPending(ctx context.Context, accountID string) ([]Dispatch, error)
	FindDispatch(ctx context.Context, accountID string, dispatchID string) (Dispatch, error)
}

// KeepOrAssignPrimary 决定一台设备登录后是否成为主设备。
//
// 参数：alreadyPrimary 表示这台设备当前就是未撤销的主设备；anotherActivePrimary 表示账号下另有主设备。
// 返回值：应标记为主设备时返回 true。
// 注意事项：已是主设备的登录不能把主设备身份清掉。
func KeepOrAssignPrimary(alreadyPrimary bool, anotherActivePrimary bool) bool {
	if alreadyPrimary {
		return true
	}
	return !anotherActivePrimary
}

// CanExecute 限制只有电脑平台可以成为执行设备。
func CanExecute(platform string) bool {
	return platform == "mac" || platform == "windows" || platform == "linux"
}
