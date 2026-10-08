package storage

import (
	"context"
	"database/sql"
	"errors"
)

// validateRequester 在持有账号行锁的事务中核对当前请求者。参数：requester为HTTP认证时的快照；返回值：旧会话返回ErrCredentialsChanged；注意事项：nil仅用于已有可信内部存储操作，不允许HTTP传空。
func validateRequester(ctx context.Context, tx *sql.Tx, requester *Device) error {
	if requester == nil {
		return nil
	}
	if requester.TokenHash == "" {
		return ErrCredentialsChanged
	}
	var hash string
	err := tx.QueryRowContext(ctx, `SELECT token_hash FROM devices WHERE id=? AND account_id=? AND revoked_at IS NULL`, requester.ID, requester.AccountID).Scan(&hash)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrCredentialsChanged
	}
	if err != nil {
		return err
	}
	if hash != requester.TokenHash {
		return ErrCredentialsChanged
	}
	return nil
}

// RevokeDeviceForSession 由有效请求者撤销同账号目标设备。参数：requester为认证快照，deviceID为目标；返回值：操作错误；注意事项：认证和撤销在同一账号事务内，旧请求不能撤销重新登录后的设备。
func (s *MySQL) RevokeDeviceForSession(ctx context.Context, requester Device, deviceID string) error {
	_, err := s.revokeDevice(ctx, requester.AccountID, deviceID, "", &requester)
	return err
}

// validateRequesterLocked 在内存锁内检查认证快照。参数：requester为此前通过认证的设备；返回值：无效或已轮换时返回ErrCredentialsChanged；注意事项：调用方必须已持有m.mu。
func (m *Memory) validateRequesterLocked(requester *Device) error {
	if requester == nil {
		return nil
	}
	current, ok := m.devices[requester.ID]
	if !ok || current.AccountID != requester.AccountID || current.Revoked || requester.TokenHash == "" || current.TokenHash != requester.TokenHash {
		return ErrCredentialsChanged
	}
	return nil
}

// RevokeDeviceForSession 原子核对内存请求者并撤销目标。参数：requester为认证快照，deviceID为目标；返回值：变更错误；注意事项：同设备重新登录复用ID时仍比较当前令牌。
func (m *Memory) RevokeDeviceForSession(_ context.Context, requester Device, deviceID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.validateRequesterLocked(&requester); err != nil {
		return err
	}
	_, err := m.revokeDeviceLocked(requester.AccountID, deviceID, "")
	return err
}
