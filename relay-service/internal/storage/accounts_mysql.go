package storage

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/go-sql-driver/mysql"
)

const managedAccountColumns = "id,email,name,picture,provider,created_at,updated_at"

// GetManagedAccount 按主键查询账号资料。参数：id为经过授权的目标账号；返回值：账号或ErrNotFound；注意事项：不读取密码，不由邮箱变更影响目标定位。
func (s *MySQL) GetManagedAccount(ctx context.Context, id string) (Account, error) {
	account, err := scanAccount(s.db.QueryRowContext(ctx, "SELECT "+managedAccountColumns+" FROM accounts WHERE id=?", id))
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return account, err
}

// lockManagedAccount 在事务内获取账号行锁。参数：tx为当前事务，id为目标；返回值：当前账号资料；注意事项：与设备签发及调度共用账号锁，避免重置后的旧凭据重新签发设备。
func lockManagedAccount(ctx context.Context, tx *sql.Tx, id string) (Account, error) {
	account, err := scanAccount(tx.QueryRowContext(ctx, "SELECT "+managedAccountColumns+" FROM accounts WHERE id=? FOR UPDATE", id))
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return account, err
}

// revokeManagedSessions 撤销账号全部设备、邀请和执行租约。参数：tx必须已持有账号锁；返回值：数据库错误；注意事项：保留聊天快照与任务记录，新设备登录后可重新领取任务。
func revokeManagedSessions(ctx context.Context, tx *sql.Tx, id string) error {
	now := time.Now().UTC()
	for _, query := range []string{`DELETE c FROM dispatch_claims c JOIN dispatches d ON d.id=c.dispatch_id WHERE d.account_id=?`, `DELETE FROM invites WHERE account_id=?`} {
		if _, err := tx.ExecContext(ctx, query, id); err != nil {
			return err
		}
	}
	_, err := tx.ExecContext(ctx, `UPDATE devices SET revoked_at=?,is_primary=0,updated_at=? WHERE account_id=? AND revoked_at IS NULL`, now, now, id)
	return err
}

// UpdateManagedAccount 在账号锁内更新允许的资料。参数：patch为姓名和邮箱的可选新值；返回值：账号与是否撤销会话；注意事项：第三方邮箱不可改，邮箱唯一冲突整体回滚，改姓名不会让正常设备退出。
func (s *MySQL) UpdateManagedAccount(ctx context.Context, id string, patch AccountPatch) (Account, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Account{}, false, err
	}
	defer tx.Rollback()
	account, err := lockManagedAccount(ctx, tx, id)
	if err != nil {
		return Account{}, false, err
	}
	changedEmail := patch.Email != nil && *patch.Email != account.Email
	if changedEmail && account.Provider != "email" {
		return Account{}, false, ErrEmailImmutable
	}
	if patch.Name != nil {
		account.Name = *patch.Name
	}
	if patch.Email != nil {
		account.Email = *patch.Email
	}
	account.UpdatedAt = time.Now().UTC()
	_, err = tx.ExecContext(ctx, `UPDATE accounts SET name=?,email=?,updated_at=? WHERE id=?`, account.Name, account.Email, account.UpdatedAt, id)
	var duplicate *mysql.MySQLError
	if errors.As(err, &duplicate) && duplicate.Number == 1062 {
		return Account{}, false, ErrAccountExists
	}
	if err != nil {
		return Account{}, false, err
	}
	if changedEmail {
		if _, err = tx.ExecContext(ctx, "UPDATE account_credentials SET auth_version=auth_version+1 WHERE account_id=?", id); err != nil {
			return Account{}, false, err
		}
		if err = revokeManagedSessions(ctx, tx, id); err != nil {
			return Account{}, false, err
		}
	}
	if err = tx.Commit(); err != nil {
		return Account{}, false, err
	}
	return account, changedEmail, nil
}

// ResetManagedPassword 原子替换密码并撤销旧会话。参数：passwordHash为调用方已生成的bcrypt摘要；返回值：变更错误；注意事项：不改变Google登录提供方，不存储或记录明文密码。
func (s *MySQL) ResetManagedPassword(ctx context.Context, id, passwordHash string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	account, err := lockManagedAccount(ctx, tx, id)
	if err != nil {
		return err
	}
	if account.Provider != "email" {
		return ErrPasswordProvider
	}
	now := time.Now().UTC()
	if _, err = tx.ExecContext(ctx, `INSERT INTO account_credentials(account_id,password_hash,created_at,auth_version) VALUES(?,?,?,1) ON DUPLICATE KEY UPDATE password_hash=VALUES(password_hash),auth_version=auth_version+1`, id, passwordHash, now); err != nil {
		return err
	}
	if err = revokeManagedSessions(ctx, tx, id); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE accounts SET updated_at=? WHERE id=?`, now, id); err != nil {
		return err
	}
	return tx.Commit()
}

// DeleteManagedAccount 原子删除账号及全部关联私有数据。参数：confirmEmail为用户显式确认的当前邮箱；返回值：不存在、确认不符或数据库错误；注意事项：按外键依赖顺序删除，任何失败均回滚，不影响其他账号和全局发布包。
func (s *MySQL) DeleteManagedAccount(ctx context.Context, id, confirmEmail string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	account, err := lockManagedAccount(ctx, tx, id)
	if err != nil {
		return err
	}
	if account.Email != confirmEmail {
		return ErrConfirmationMismatch
	}
	queries := []string{`DELETE c FROM dispatch_claims c JOIN dispatches d ON d.id=c.dispatch_id WHERE d.account_id=?`, `DELETE FROM dispatches WHERE account_id=?`, `DELETE FROM invites WHERE account_id=?`, `DELETE FROM chat_states WHERE account_id=?`, `DELETE FROM devices WHERE account_id=?`, `DELETE FROM account_credentials WHERE account_id=?`, `DELETE FROM accounts WHERE id=?`}
	for _, query := range queries {
		if _, err = tx.ExecContext(ctx, query, id); err != nil {
			return err
		}
	}
	return tx.Commit()
}
