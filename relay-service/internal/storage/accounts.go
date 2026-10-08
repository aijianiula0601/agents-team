package storage

import (
	"context"
	"errors"
)

var (
	// ErrCredentialsChanged 表示身份校验与设备签发之间凭据已经变化，调用方必须重新登录。
	ErrCredentialsChanged = errors.New("account credentials changed")
	// ErrEmailImmutable 表示第三方身份邮箱不可通过本地后台修改。
	ErrEmailImmutable = errors.New("external identity email is immutable")
	// ErrPasswordProvider 表示当前登录提供方不支持本地密码。
	ErrPasswordProvider = errors.New("account does not use password authentication")
	// ErrConfirmationMismatch 表示删除时确认的邮箱与事务内真实邮箱不一致。
	ErrConfirmationMismatch = errors.New("account confirmation does not match")
)

// AccountPatch 是超级管理员可修改的账号资料。参数：nil字段保持原值；返回值：供存储层执行原子变更；注意事项：不包含role、provider和任何员工身份字段。
type AccountPatch struct {
	Name  *string
	Email *string
}

// AccountManager 定义经过上层超级管理员授权的账号变更。参数：每次变更以账号ID定位；返回值：资料或错误；注意事项：存储层在账号锁内完成凭据、设备、邀请和租约的一致性变更。
type AccountManager interface {
	GetManagedAccount(context.Context, string) (Account, error)
	UpdateManagedAccount(context.Context, string, AccountPatch) (Account, bool, error)
	ResetManagedPassword(context.Context, string, string) error
	DeleteManagedAccount(context.Context, string, string) error
}
