package storage

import (
	"context"
	"time"
)

// GetManagedAccount 查询测试内存中的账号。参数：id为目标主键；返回值：资料或不存在错误；注意事项：使用互斥锁，返回值为副本。
func (m *Memory) GetManagedAccount(_ context.Context, id string) (Account, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	account, ok := m.accounts[id]
	if !ok {
		return Account{}, ErrNotFound
	}
	return account, nil
}

// revokeManagedSessionsLocked 撤销测试账号的设备、邀请和租约。参数：id为账号；返回值：无；注意事项：调用方必须已持有m.mu，不删除聊天和任务历史。
func (m *Memory) revokeManagedSessionsLocked(id string) {
	now := time.Now().UTC()
	for key, device := range m.devices {
		if device.AccountID == id {
			device.Revoked = true
			device.IsPrimary = false
			device.UpdatedAt = now
			m.devices[key] = device
			delete(m.tokens, device.TokenHash)
		}
	}
	for key, invite := range m.invites {
		if invite.AccountID == id {
			delete(m.invites, key)
		}
	}
	for key, claim := range m.claims {
		if item, ok := m.dispatches[claim.DispatchID]; ok && item.AccountID == id {
			delete(m.claims, key)
		}
	}
}

// UpdateManagedAccount 修改内存账号允许字段。参数：patch为可选姓名/邮箱；返回值：修改后账号及是否撤销会话；注意事项：与MySQL保持相同唯一性、提供方和撤销语义。
func (m *Memory) UpdateManagedAccount(_ context.Context, id string, patch AccountPatch) (Account, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	account, ok := m.accounts[id]
	if !ok {
		return Account{}, false, ErrNotFound
	}
	changed := patch.Email != nil && *patch.Email != account.Email
	if changed {
		if account.Provider != "email" {
			return Account{}, false, ErrEmailImmutable
		}
		if other, ok := m.emails[*patch.Email]; ok && other != id {
			return Account{}, false, ErrAccountExists
		}
		delete(m.emails, account.Email)
		account.Email = *patch.Email
		m.emails[account.Email] = id
		m.authVersions[id]++
		m.revokeManagedSessionsLocked(id)
	}
	if patch.Name != nil {
		account.Name = *patch.Name
	}
	account.UpdatedAt = time.Now().UTC()
	m.accounts[id] = account
	return account, changed, nil
}

// ResetManagedPassword 替换测试密码摘要并撤销全部旧会话。参数：id与bcrypt摘要；返回值：变更错误；注意事项：Google账号不能增加密码登录方式。
func (m *Memory) ResetManagedPassword(_ context.Context, id, passwordHash string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	account, ok := m.accounts[id]
	if !ok {
		return ErrNotFound
	}
	if account.Provider != "email" {
		return ErrPasswordProvider
	}
	m.passwords[id] = passwordHash
	m.authVersions[id]++
	account.UpdatedAt = time.Now().UTC()
	m.accounts[id] = account
	m.revokeManagedSessionsLocked(id)
	return nil
}

// DeleteManagedAccount 清理测试账号及关联记录。参数：id和显式确认邮箱；返回值：操作错误；注意事项：单锁内完成，其他账号及其令牌保持不变。
func (m *Memory) DeleteManagedAccount(_ context.Context, id, confirmEmail string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	account, ok := m.accounts[id]
	if !ok {
		return ErrNotFound
	}
	if account.Email != confirmEmail {
		return ErrConfirmationMismatch
	}
	m.revokeManagedSessionsLocked(id)
	for key, device := range m.devices {
		if device.AccountID == id {
			delete(m.devices, key)
		}
	}
	for key, item := range m.dispatches {
		if item.AccountID == id {
			delete(m.dispatches, key)
		}
	}
	delete(m.states, id)
	delete(m.passwords, id)
	delete(m.authVersions, id)
	delete(m.emails, account.Email)
	delete(m.accounts, id)
	return nil
}
